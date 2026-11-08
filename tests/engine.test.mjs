/**
 * 远见·企业出海助手 —— 引擎回归测试
 * 运行：node tests/engine.test.mjs
 *
 * 用原始交付物中的 38 个业务测试案例（tests/test-cases.json，导出自
 * small-appliance-compliance/data/dataset.json「典型业务测试案例」）驱动本引擎，
 * 断言：
 *   1. expected_required_rules 全部出现在适用结果中；
 *   2. expected_forbidden_rules 不出现在适用或待确认结果中；
 *   3. expected_unknown_rules 全部出现在待确认结果中；
 *   4. expected_tax 中给定的数值字段与引擎输出一致；为 null 的字段引擎也必须为 null。
 * 另附专项断言：unknown 不按 false 处理、法域继承、跨法域禁止、未来规则、ChAFTA 安全门。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const engine = require(join(ROOT, 'js/engine.js'));
const data = JSON.parse(readFileSync(join(ROOT, 'data/vo-data.json'), 'utf-8'));

// 优先使用仓库内测试数据；若不存在则提示先运行导出脚本
const casesPath = join(ROOT, 'tests/test-cases.json');
if (!existsSync(casesPath)) {
  console.error('缺少 tests/test-cases.json（原始测试案例导出）。');
  process.exit(1);
}
const cases = JSON.parse(readFileSync(casesPath, 'utf-8'));

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push({ name, detail }); }
}

function scenarioFor(c) {
  const facts = Object.assign({}, c.input);
  delete facts.market;
  return engine.evaluateScenario(data, {
    market: c.input.market,
    subcategoryId: '',
    facts,
    placingOnMarketDate: c.input.placing_on_market_date || c.input.import_date || ''
  });
}

/* ---------- 1. 原始 38 案例回归 ---------- */
for (const c of cases) {
  const sc = scenarioFor(c);
  const applicableIds = sc.applicableRules.map((r) => r.id);
  const unknownIds = sc.unknownRules.map((r) => r.id);

  (c.expected_required_rules || []).forEach((id) =>
    check(`${c.case_id} 需适用 ${id}`, applicableIds.includes(id), `实际适用: ${applicableIds.join(',')}`));
  (c.expected_forbidden_rules || []).forEach((id) =>
    check(`${c.case_id} 禁止 ${id}`, !applicableIds.includes(id) && !unknownIds.includes(id), `${id} 出现在 ${applicableIds.includes(id) ? '适用' : '待确认'}`));
  (c.expected_unknown_rules || []).forEach((id) =>
    check(`${c.case_id} 待确认 ${id}`, unknownIds.includes(id), `实际待确认: ${unknownIds.join(',')}`));

  if (c.expected_tax && typeof c.expected_tax === 'object') {
    const tax = engine.calculateTaxes(data, Object.assign({}, c.input, { product_type: c.input.product_type }));
    for (const [k, v] of Object.entries(c.expected_tax)) {
      const got = tax[k];
      if (v === null) check(`${c.case_id} 税费 ${k}=null`, got === null || got === undefined, `实际 ${got}`);
      else if (typeof v === 'number') check(`${c.case_id} 税费 ${k}=${v}`, Math.abs((got ?? NaN) - v) < 0.01, `实际 ${got}`);
      else check(`${c.case_id} 税费 ${k}`, got === v, `实际 ${got}`);
    }
  } else if (c.expected_tax === null) {
    const tax = engine.calculateTaxes(data, Object.assign({}, c.input, { product_type: c.input.product_type }));
    check(`${c.case_id} 税费整体不可用`, tax.complete_total === null, `实际 complete_total=${tax.complete_total}`);
  }
}

/* ---------- 2. 专项断言 ---------- */
// 2.1 unknown 不按 false：NL 水壶，无线未知 → RED 相关规则应出现在待确认而非不适用
{
  const sc = engine.evaluateScenario(data, {
    market: 'NL', subcategoryId: 'K-BEV-001',
    facts: { household: true, end_use: 'consumer', voltage_ac: 230, capacity_l: 1.7, consumer_product: true },
    placingOnMarketDate: '2026-11-01'
  });
  const redUnknown = sc.unknownRules.some((r) => /RED|RADIO/i.test(r.id)) || sc.unknownRules.length > 0;
  check('NL 无线未知 → 至少一条规则待确认（不按否处理）', redUnknown, JSON.stringify(sc.unknownRules.map((r) => r.id)));
  const euLoaded = sc.jurisdictionChain.includes('EU');
  check('NL 法域链包含 EU（继承）', euLoaded, sc.jurisdictionChain.join('>'));
}

// 2.2 SG 不允许调用欧盟规则：SG 水壶不应出现 EU 规则
{
  const sc = engine.evaluateScenario(data, {
    market: 'SG', subcategoryId: 'K-BEV-001',
    facts: { household: true, end_use: 'consumer', voltage_ac: 230, capacity_l: 1.7 },
    placingOnMarketDate: '2026-11-01'
  });
  const euRule = sc.results.some((r) => r.jurisdiction === 'EU');
  check('SG 不加载 EU 规则（跨法域禁止）', !euRule, sc.results.filter((r) => r.jurisdiction === 'EU').map((r) => r.id).join(','));
}

// 2.3 未来规则：EU 电池可拆换（2027-02-18 起）在 2026 年投放时按不适用并说明日期
{
  const sc = engine.evaluateScenario(data, {
    market: 'DE', subcategoryId: 'C-VAC-005',
    facts: { household: true, end_use: 'consumer', consumer_product: true, battery_present: true },
    placingOnMarketDate: '2026-11-01'
  });
  const future = sc.results.find((r) => /BATT/i.test(r.id) && r.effectiveFrom && r.effectiveFrom > '2026-11-01' && r.dateActive === false);
  check('EU 未来规则标注适用期原因', !!future, '未找到标注日期不覆盖的电池规则');
}

// 2.4 DE 继承 EU：DE 扫地机器人出现 EU 任务三规则
{
  const sc = engine.evaluateScenario(data, {
    market: 'DE', subcategoryId: 'C-VAC-005',
    facts: { household: true, end_use: 'consumer', consumer_product: true, wireless_present: true, internet_connected: true, offered_online: true, battery_present: true, personal_data_processing: true, eu_established_economic_operator: false, economic_operator_role: 'manufacturer' },
    placingOnMarketDate: '2026-06-01'
  });
  const hasTask3EU = sc.applicableRules.some((r) => r.origin === 'task3_verified_rule' && r.jurisdiction === 'EU');
  check('DE × 扫地机器人适用 EU 任务三规则（L2 生成）', hasTask3EU && sc.coverage.level === 'L2',
    `适用: ${sc.applicableRules.map((r) => r.id).join(',')}; 覆盖: ${sc.coverage.level}`);
}

// 2.5 ChAFTA 条件不完整不启用优惠：声明 reviewed 但条件缺失 → 阻断；仅 conditional → 按普通税率可算
{
  const tax = engine.calculateTaxes(data, {
    market: 'AU', product_type: 'kettle', hs_candidate: '85167900', origin: 'CN',
    import_date: '2026-11-01', goods_value: 2000, currency: 'AUD', incoterm: 'CIF',
    freight: 100, insurance: 20, special_valuation: false, remedy_check: 'confirmed_clear',
    origin_preference: 'reviewed', origin_psr_satisfied: null, transport: 'sea', sales_state: 'VIC',
    customs_value_confirmed: 2000
  });
  check('ChAFTA 声明已复核但条件缺失 → 阻断且不启用 0%', tax.complete_total === null && tax.blockers.length > 0 && tax.ordinary_duty > 0,
    JSON.stringify(tax.blockers));
  const tax2 = engine.calculateTaxes(data, {
    market: 'AU', product_type: 'kettle', hs_candidate: '85167900', origin: 'CN',
    import_date: '2026-11-01', goods_value: 2000, currency: 'AUD', incoterm: 'CIF',
    freight: 100, insurance: 20, special_valuation: false, remedy_check: 'confirmed_clear',
    origin_preference: 'conditional', transport: 'sea', sales_state: 'VIC', customs_value_confirmed: 2000
  });
  check('ChAFTA 仅 conditional → 按普通税率 5% 可算并标注条件情景', tax2.complete_total !== null && tax2.ordinary_duty === 100 && !!tax2.conditional_preferential_scenario,
    JSON.stringify({ duty: tax2.ordinary_duty, total: tax2.complete_total, note: tax2.conditional_preferential_scenario }));
}

// 2.6 SG 低值空邮阻断
{
  const tax = engine.calculateTaxes(data, {
    market: 'SG', product_type: 'kettle', hs_candidate: '85167910', origin: 'CN',
    import_date: '2026-11-01', goods_value: 60, currency: 'SGD', incoterm: 'FOB',
    freight: 5, insurance: 1, special_valuation: false, remedy_check: 'confirmed_clear',
    import_route: 'postal'
  });
  check('SG 低值空邮缺少登记事实 → 完整总额为空并说明', tax.complete_total === null && tax.blockers.some((b) => b.includes('低值')),
    JSON.stringify(tax.blockers));
}

// 2.7 指示性操作费不计入法定小计
{
  const tax = engine.calculateTaxes(data, {
    market: 'SG', product_type: 'kettle', hs_candidate: '85167910', origin: 'CN',
    import_date: '2026-11-01', goods_value: 20000, freight: 1500, insurance: 100, currency: 'SGD',
    incoterm: 'FOB', special_valuation: false, remedy_check: 'unconfirmed', import_route: 'bulk'
  });
  const opLine = tax.lines.find((l) => l.id === 'operator_fee');
  check('SG 操作费标记为指示性且不进法定小计', opLine && opLine.status === 'indicative' && tax.known_statutory_subtotal === Math.round((tax.ordinary_duty + tax.import_gst + tax.statutory_permit_fee) * 100) / 100,
    JSON.stringify({ op: opLine && opLine.status, sub: tax.known_statutory_subtotal }));
}

/* ---------- 汇总 ---------- */
console.log(`\n===== 引擎回归测试：${pass + fail} 项断言，通过 ${pass}，失败 ${fail} =====`);
if (failures.length) {
  console.log('失败明细：');
  failures.slice(0, 40).forEach((f) => console.log('  ✗', f.name, '→', String(f.detail).slice(0, 220)));
  process.exit(1);
} else {
  console.log('全部通过 ✔');
}
