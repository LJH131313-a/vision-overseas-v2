#!/usr/bin/env node
/**
 * 远见·企业出海助手 —— 数据合并构建脚本
 *
 * 读取三份原始团队交付物（只读，不修改）：
 *   1. ../PolicyRadar-team-handoff-GitHubPages   （新闻雷达：news.json / feeds.json）
 *   2. ../千问/千问                                （产品知识包 / 法规数据包 / 正式合规项目）
 *   3. ../小家电出海工作台前置研究(1).html           （企业研究：小熊电器、石头科技）
 *
 * 输出（本目录仓库内）：
 *   data/vo-data.js   —— 页面通过 <script> 加载的 window.VO_DATA（无 fetch，file:// 也可用）
 *   data/vo-data.json —— 同一数据的机器可读副本，便于审计
 *   data/news.js      —— 新闻快照包装（window.VO_NEWS），由采集器定期重建
 *
 * 安全处理：所有来源记录中的本地绝对路径、哈希等机器信息一律剥离，不进入网页。
 * 运行：node build/build-data.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// 原始交付物根目录（默认为上级目录，可用第一个参数覆盖）
const INPUT_ROOT = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, '..');

const P = {
  radar: join(INPUT_ROOT, 'PolicyRadar-team-handoff-GitHubPages'),
  qianwen: join(INPUT_ROOT, '千问', '千问', 'small-appliance-compliance'),
  newsJson: join(INPUT_ROOT, 'PolicyRadar-team-handoff-GitHubPages', 'news.json'),
  feedsJson: join(INPUT_ROOT, 'PolicyRadar-team-handoff-GitHubPages', 'feeds.json'),
};
const J = (p) => JSON.parse(readFileSync(p, 'utf-8'));

const log = (...a) => console.log('[build]', ...a);
const warn = (...a) => console.warn('[build][warn]', ...a);

/* ---------- 读取原始数据 ---------- */
if (!existsSync(P.qianwen)) {
  console.error(`未找到原始交付目录：${P.qianwen}\n用法：node build/build-data.mjs <原始交付物根目录>`);
  process.exit(1);
}
const ds = J(join(P.qianwen, 'data/dataset.json'));
const pk = J(join(P.qianwen, 'data/product_knowledge_v2.json'));
const ext = J(join(P.qianwen, 'data/extensions_20261104.json'));
const wb = J(join(P.qianwen, 'data/task4/regulatory_web_bundle.json'));
const pkb = J(join(P.qianwen, 'data/task4/product_knowledge_bundle.json'));
const taxProfiles = J(join(P.qianwen, 'data/tax_calculation_profiles.json')).profiles;
const covProfiles = J(join(P.qianwen, 'data/coverage_profiles.json'));
const newsOriginal = J(P.newsJson);
const feeds = J(P.feedsJson);

const AS_OF = '2026-11-05';            // 本次整合构建日期
const SNAP = wb.as_of || '2026-11-04'; // 原始数据快照日期
log('原始快照日期', SNAP, '| 法规', wb.regulations.length, '| 来源', wb.sources.length, '| 规则', wb.rules.length);

/* ---------- 1. 法域 ---------- */
const jurisdictions = wb.jurisdictions.map((j) => ({
  code: j.jurisdiction_code, name: j.name_zh, level: j.level,
  parent: j.parent_code || '', inherits: j.inherits_from || [], note: j.application_note,
}));
// 覆盖优先排序：有规则的法域排前面
const ruleJ = new Set();
wb.rules.forEach((r) => ruleJ.add(r.jurisdiction));
pk.rules.forEach((r) => ruleJ.add(r.market));
ds.tables['法规条件与义务规则'].forEach((r) => ruleJ.add(r.market));
(ext.tables['法规条件与义务规则'] || []).forEach((r) => ruleJ.add(r.market));
jurisdictions.sort((a, b) => (ruleJ.has(b.code) ? 1 : 0) - (ruleJ.has(a.code) ? 1 : 0) || a.code.localeCompare(b.code));

/* ---------- 2. 产品小类 / 字段 / 动态规则 ---------- */
const subcategories = pkb.subcategories.map((s) => ({
  id: s.subcategory_id, group: s.group_id, name: s.name_zh, nameEn: s.name_en,
  profile: s.profile_id, core: s.core_functions, variable: s.variable_configurations,
  keyParams: s.key_parameters, hsFeatures: s.hs_relevant_features,
  screenFeatures: s.compliance_screen_features, evidence: s.evidence_level,
  sourceIds: (s.source_ids || '').split('|').filter(Boolean),
  legacy: s.legacy_product_type || '', leaf: s.leaf_status,
}));
const groups = pkb.groups.map((g) => ({ id: g.group_id, category: g.category_id, name: g.name_zh, nameEn: g.name_en }));
const categories = pkb.categories.map((c) => ({ id: c.category_id, name: c.name_zh, nameEn: c.name_en }));
const fields = pkb.field_dictionary.map((f) => ({
  id: f.field_id, key: f.key, name: f.name_zh, nameEn: f.name_en, type: f.type, unit: f.unit || '',
  options: f.options || '', unknownAllowed: f.unknown_allowed !== false,
  ruleKey: f.existing_rule_key || '', link: f.link_status || '',
}));
const dynamicMap = pkb.dynamic_field_map
  .filter((m) => m.publication_status === 'publishable')
  .map((m) => ({
    id: m.mapping_id, sub: m.subcategory_id, field: m.field_id, order: m.display_order,
    judgments: (m.affected_judgments || '').split('|').filter(Boolean),
    businessUse: m.business_use || '', sourceIds: (m.source_ids || '').split('|').filter(Boolean),
  }));
const judgments = pkb.judgment_items.map((j) => ({ id: j.judgment_id, name: j.name_zh, type: j.type, purpose: j.purpose }));
// 法规输入字段（任务三 21 项：经营主体、日期、法规事实）
const ruleFields = wb.rule_input_fields.map((f) => ({
  key: f.field_key, name: f.name_zh, type: f.type, businessUse: f.business_use || '',
  showWhen: f.show_when || '', unknownAllowed: f.unknown_allowed !== false,
}));
log('小类', subcategories.length, '| 字段', fields.length, '| 可发布动态映射', dynamicMap.length);

/* ---------- 3. 规则合并（web_bundle 56 + PKV2 20 + dataset 36 + extensions 4，按 rule_id 去重） ---------- */
function normRule(r, origin) {
  const cond = r.condition && typeof r.condition === 'object' ? r.condition : null;
  const excl = r.exclusions && typeof r.exclusions === 'object' ? r.exclusions : null;
  const hr = r.human_review;
  return {
    id: r.rule_id,
    jurisdiction: r.jurisdiction || r.market,
    regulationId: r.regulation_id || '',
    topic: r.topic_id || '',
    name: r.name || '',
    condition: cond,
    exclusions: excl,
    obligation: r.obligation || r.applicable_result || '',
    notApplicable: r.not_applicable_result || '',
    actions: r.action_ids || r.actions || [],
    materials: r.material_ids || r.materials || [],
    sourceIds: r.source_ids || [],
    locator: r.locator || '',
    requirementType: r.requirement_type || '',
    status: r.rule_status || 'active',
    effectiveFrom: r.effective_from || null,
    effectiveTo: r.effective_to || null,
    dateNote: r.date_note || '',
    exceptions: typeof r.exceptions === 'string' ? r.exceptions : '',
    humanReview: hr === true || (typeof hr === 'string' && hr && hr !== 'false') ? true : false,
    humanReviewNote: typeof hr === 'string' ? hr : '',
    priority: r.priority || '',
    unknownBehavior: r.unknown_behavior || 'indeterminate_and_request_missing_facts',
    origin: r.origin || origin,
  };
}
const rulesMap = new Map();
// 任务三规则：按原始运行时约定，动态生成行动（ACT-规则ID）与材料（MAT-规则ID-序号）
const generatedActions = [], generatedMaterials = [];
wb.rules.forEach((r) => {
  const rule = normRule(r, 'task3_verified_rule');
  if (r.origin === 'task3_verified_rule' && Array.isArray(r.actions) && r.actions.length && typeof r.actions[0] === 'string' && !/^ACT-/.test(r.actions[0])) {
    const actionId = 'ACT-' + r.rule_id;
    const matIds = (r.materials || []).map((name, i) => 'MAT-' + r.rule_id + '-' + (i + 1));
    generatedActions.push({
      id: actionId, ruleId: r.rule_id, name: r.name, text: (r.actions || []).join('；'),
      materialIds: matIds, responsibility: '制造商、进口商及合规负责人按角色确认', due: '投放市场或适用期限前',
      sourceIds: rule.sourceIds, locator: rule.locator || '', nature: '法律义务（条款级规则）',
    });
    (r.materials || []).forEach((name, i) => {
      generatedMaterials.push({ id: matIds[i], name, prep: '未提供', confirmer: '', review: '未复核' });
    });
    rule.actions = [actionId];
    rule.materials = matIds;
  }
  rulesMap.set(r.rule_id, rule);
});
pk.rules.forEach((r) => { if (!rulesMap.has(r.rule_id)) rulesMap.set(r.rule_id, normRule(r, 'formal_project')); });
ds.tables['法规条件与义务规则'].forEach((r) => { if (!rulesMap.has(r.rule_id)) rulesMap.set(r.rule_id, normRule(r, 'formal_project')); });
(ext.tables['法规条件与义务规则'] || []).forEach((r) => { if (!rulesMap.has(r.rule_id)) rulesMap.set(r.rule_id, normRule(r, 'formal_extension')); });
const rules = [...rulesMap.values()];
const badRules = rules.filter((r) => !r.condition);
if (badRules.length) warn('无条件体的规则（保留为人工审查）：', badRules.map((r) => r.id).join(','));
log('合并后规则', rules.length, '条（task3 56 / 正式 20+36 / 扩展 4，去重）');

/* ---------- 4. 行动与材料 ---------- */
const actionsMap = new Map(), materialsMap = new Map();
ds.tables['合规行动清单'].forEach((a) => actionsMap.set(a.action_id, {
  id: a.action_id, ruleId: a.rule_id || '', name: a['名称'], text: a['需执行动作'],
  materialIds: a['材料ID'] || [], responsibility: a['责任建议'] || '', due: a['完成节点'] || '',
  sourceIds: a['来源ID'] || [], locator: a['条款定位'] || '', nature: a['性质'] || '',
}));
pk.actions.forEach((a) => { if (!actionsMap.has(a.action_id)) actionsMap.set(a.action_id, {
  id: a.action_id, ruleId: '', name: a['名称'], text: a['需执行动作'], materialIds: a['材料ID'] || [],
  responsibility: a['责任建议'] || '', due: a['完成节点'] || '', sourceIds: a['来源ID'] || [], locator: a['条款定位'] || '', nature: a['性质'] || '',
}); });
(ext.tables['合规行动清单'] || []).forEach((a) => { if (!actionsMap.has(a.action_id)) actionsMap.set(a.action_id, {
  id: a.action_id, ruleId: a.rule_id || '', name: a['名称'], text: a['需执行动作'], materialIds: a['材料ID'] || [],
  responsibility: a['责任建议'] || '', due: a['完成节点'] || '', sourceIds: a['来源ID'] || [], locator: a['条款定位'] || '', nature: a['性质'] || '',
}); });
ds.tables['材料清单'].forEach((m) => materialsMap.set(m.material_id, {
  id: m.material_id, name: m['名称'], prep: m['企业准备状态'] || '', confirmer: m['确认者'] || '', review: m['专业复核状态'] || '',
}));
pk.materials.forEach((m) => { if (!materialsMap.has(m.material_id)) materialsMap.set(m.material_id, {
  id: m.material_id, name: m['名称'], prep: m['企业准备状态'] || '', confirmer: m['确认者'] || '', review: m['专业复核状态'] || '',
}); });
(ext.tables['材料清单'] || []).forEach((m) => { if (!materialsMap.has(m.material_id)) materialsMap.set(m.material_id, {
  id: m.material_id, name: m['名称'], prep: m['企业准备状态'] || '', confirmer: m['确认者'] || '', review: m['专业复核状态'] || '',
}); });
generatedMaterials.forEach((m) => { if (!materialsMap.has(m.id)) materialsMap.set(m.id, m); });
generatedActions.forEach((a) => { if (!actionsMap.has(a.id)) actionsMap.set(a.id, a); });
const actions = [...actionsMap.values()], materials = [...materialsMap.values()];
log('行动', actions.length, '| 材料', materials.length);

/* ---------- 5. HS 候选（PKV2 54 + 任务三核验 7 + 扩展 4） ---------- */
const hsMap = new Map();
pk.hsCandidates.forEach((h) => hsMap.set(h.candidate_id, {
  id: h.candidate_id, market: h.market, legacyProduct: h.product_id || '', code: h.code,
  desc: h.description || '', support: h.support || '', questions: h.distinguishing_questions || '',
  sourceIds: h.source_ids || [], locator: h.locator || '', gri: h.gri || '',
  review: h.review_status || '', asOf: h.effective_as_of || '', tariffVersion: h.tariff_version || '',
  notFinal: true, origin: 'formal_project',
}));
ds.tables['HS候选与归类依据'].forEach((h) => {
  const id = h.candidate_id;
  const item = {
    id, market: h.market, legacyProduct: h.product_id || h['产品ID'] || '', code: h.code,
    desc: h.description || h['商品描述'] || '', support: h.support || h['归类依据'] || '',
    questions: h.distinguishing_questions || h['区分问题'] || '', sourceIds: h.source_ids || [],
    locator: h.locator || h['条款定位'] || '', gri: h.gri || '', review: h.review_status || h['复核状态'] || '',
    asOf: h.effective_as_of || '', tariffVersion: h.tariff_version || '', notFinal: true, origin: 'task3_verified',
  };
  hsMap.set(id, item);
});
(ext.tables['HS候选与归类依据'] || []).forEach((h) => {
  const id = h.candidate_id;
  if (!hsMap.has(id)) hsMap.set(id, {
    id, market: h.market, legacyProduct: h.product_id || '', code: h.code,
    desc: h.description || '', support: h.support || '', questions: h.distinguishing_questions || '',
    sourceIds: h.source_ids || [], locator: h.locator || '', gri: h.gri || '',
    review: h.review_status || '', asOf: h.effective_as_of || '', tariffVersion: h.tariff_version || '',
    notFinal: true, origin: 'formal_extension',
  });
});
const hsCandidates = [...hsMap.values()];
log('HS 候选', hsCandidates.length, '条（含扩展 4：电吹风/电熨斗 SG/AU）');

/* ---------- 6. 税费画像与覆盖等级 ---------- */
const coverage = { ...covProfiles.levelDefinitions };
const covList = new Map();
(pk.coverageProfiles || []).forEach((c) => covList.set(c.market + '|' + c.product_type, { market: c.market, legacy: c.product_type, level: c.level, label: c.label, productId: c.product_id }));
(covProfiles.profiles || []).forEach((c) => covList.set(c.market + '|' + c.product_type, { market: c.market, legacy: c.product_type, level: c.level, label: c.label, productId: c.product_id }));
// 扩展画像（电吹风/电熨斗 SG/AU），product_id 桥接旧 ID 以便 HS 候选命中
[['SG','hair_dryer','L2','CPSR产品特定初筛','P-HDR-01'],['SG','iron','L2','CPSR产品特定初筛','P-IRN-01'],['AU','hair_dryer','L2','EESS产品特定初筛','P-HDR-01'],['AU','iron','L2','EESS产品特定初筛','P-IRN-01']]
  .forEach(([m, t, l, lb, pid]) => { if (!covList.has(m + '|' + t)) covList.set(m + '|' + t, { market: m, legacy: t, level: l, label: lb, productId: pid }); });
log('覆盖画像', covList.size, '| 税费画像', taxProfiles.length);

/* ---------- 6b. 税种与公式知识库（19 条）+ 贸易术语承担矩阵（3 条）+ 表单选项集 ---------- */
const taxRules = ds.tables['税率税种与公式'].map((r) => ({
  id: r.tax_rule_id, market: r.market, type: r.type, rate: (r.rate === null || r.rate === undefined ? null : r.rate),
  rateUnit: r.rate_unit || '', base: r.base || '', formula: r.formula || '', conditions: r.conditions || '',
  sourceIds: r.source_ids || [], locator: r.locator || '', effectiveFrom: r.effective_from || null, effectiveTo: r.effective_to || null,
  verifiedAsOf: r.verified_as_of || '', dateStatus: r.date_status || '', classification: r.classification || '',
  status: r.status || '', missingBehavior: r.missing_behavior || '', rounding: r.rounding || '',
}));
const incotermMatrix = ds.tables['贸易术语与费用承担'].map((r) => ({
  term: r.term, mode: r.mode, seller: r.seller, buyer: r.buyer, dutyRateEffect: r.duty_rate_effect, valuation: r.valuation, sourceIds: [r.source_id].filter(Boolean),
}));
const refOpts = J(join(P.qianwen, 'data/reference_options.json'));
const formOptions = {
  currencies: refOpts.currencies, origins: refOpts.origins, transportModes: refOpts.transportModes,
  incoterms: refOpts.incoterms, importRoutes: refOpts.importRoutes, channels: refOpts.channels,
  importerRoles: refOpts.importerRoles,
};
log('税种公式', taxRules.length, '| 贸易术语矩阵', incotermMatrix.length, '| 表单选项 币种', formOptions.currencies.length, '贸易术语', formOptions.incoterms.length);

/* ---------- 6c. 变量计算式模板（前置研究：马来西亚 SST / 德国·欧盟进口增值税） ---------- */
/* 这些是研究示例：税率未核实前保留变量 d/s/v，绝不代入默认数值。 */
const taxTemplates = [
  {
    market: 'MY', label: '马来西亚半岛：关税 + 进口销售税（SST）变量计算式',
    scenario: '测算示例（非企业订单）：100 台，审定完税价格合计 MYR 20,000。',
    lines: [
      '设适用从价关税税率为 d、销售税税率为 s、应纳消费税额为 E',
      '关税 = 20,000 × d',
      '进口销售税 = (20,000 + 20,000 × d + E) × s',
      '每台成本评估另分摊检测、标签、境内配送及渠道费用；已含在完税价格中的运保费不得重复计入',
    ],
    mustConfirm: ['税目候选经马来西亚税则与商品描述复核', '销售税/消费税适用性与豁免经确认', '税率与豁免经官方来源核实后才可代入数值'],
    sources: [
      { label: '马来西亚海关 HS Explorer', url: 'https://ezhs.customs.gov.my/public-home' },
      { label: '马来西亚销售税法第 9、10 条（Sales Tax Act 2018 PDF）', url: 'https://www.mysst.customs.gov.my/assets/document/SST%20Act/Sales%20Tax%20Act%202018_b.pdf' },
    ],
    note: '本页只保留变量式，不输出数值结果：未知税率不得按零处理。',
  },
  {
    market: 'DE', label: '德国（欧盟）：关税 + 进口增值税变量计算式',
    scenario: '测算示例（非企业订单）：50 套，审定完税价格合计 EUR 20,000，到德国第一目的地应计附带费用 EUR 500（未含在完税价格中）。',
    lines: [
      '设关税率 d、适用进口增值税率 v',
      '关税 = 20,000 × d',
      '进口增值税 = (20,500 + 20,000 × d) × v',
      '可抵扣税额须经进口主体资格与单证确认，不直接计入永久成本',
    ],
    mustConfirm: ['完整 CN 编码与附加措施经 TARIC 核查（成套商品归类存在争议时申请 EBTI）', '进口 VAT 率与递延安排按德国现行规定确认', '附带费用是否计入完税价格经确认'],
    sources: [
      { label: '欧盟 TARIC 咨询', url: 'https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp?Lang=en' },
      { label: '欧盟税则预裁定 EBTI', url: 'https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/european-binding-tariff-information-ebti_en' },
      { label: '欧委会德国进口增值税说明', url: 'https://trade.ec.europa.eu/access-to-markets/de/content/mehrwertsteuer-0' },
    ],
    note: '本页只保留变量式，不输出数值结果。',
  },
];

/* ---------- 7. 法规索引（79 条，含 MY/DE 等导航级） ---------- */
const topics = ds.tables['监管主题'].map((t) => ({ id: t.topic_id, name: t['名称'] }));
const regulations = ds.tables['法规索引_保留ID_更新'].map((r) => ({
  id: r['法规ID'], name: r['名称'], number: r['编号'] || '', jurisdiction: r['法域'],
  kind: r['文件性质'] || '', topics: (r['监管主题'] || '').split(';').filter(Boolean),
  authority: r['制定或解释机构'] || '', purpose: r['监管目的及核心义务'] || '',
  productFamily: r['适用产品族'] || '', techConditions: r['产品技术及适用条件'] || '',
  businessModes: r['经营模式'] || '', procedures: r['合规程序与准备文件'] || '',
  locator: r['相关条款或定位'] || '', effectiveDate: r['生效日期'] || '', applicableDate: r['适用日期'] || '',
  legalStatus: r['修订及法律状态'] || '', sourceIds: (r['来源ID'] || '').split(';').filter(Boolean),
  officialUrl: r['官方来源'] || '', fetchStatus: r['获取状态'] || '', verification: r['核验状态'] || '',
  checkedAt: r['核查日期'] || '', versionNote: r['适用性与版本提示'] || '', evidenceLevel: r['证据层级'] || '',
  maturity: r['本轮核验结论'] || '', ruleIds: r['可执行规则ID'] || [],
}));

/* ---------- 8. 来源索引合并（剥离本地路径等机器信息） ---------- */
const sourceMap = new Map();
const clean = (u) => (u || '').trim();
wb.sources.forEach((s) => sourceMap.set(s.source_id, {
  id: s.source_id, jurisdiction: s.jurisdiction || s.market || '', title: s.title,
  url: clean(s.current_url) || clean(s.original_url), probe: s.url_probe_status || '',
  verification: s.verification_status || '', note: (s.verification_note || '').slice(0, 160), checkedAt: s.checked_at || '',
}));
ds.tables['来源状态全索引'].forEach((s) => {
  const cur = sourceMap.get(s.source_id) || {};
  sourceMap.set(s.source_id, {
    id: s.source_id, jurisdiction: s.market || cur.jurisdiction || '', title: s.title || cur.title,
    url: clean(cur.url) || clean(s.url), probe: cur.probe || s.acquisition_status || '',
    verification: cur.verification || s.verification || '', note: cur.note || '', checkedAt: cur.checkedAt || '',
    pdfKind: s.pdf_kind || '', filePresent: !!s.source_file_present,
  });
});
// 产品研究来源（SRC-PROD-*，用于企业档案与产品参数溯源）
pkb.source_index.forEach((s) => {
  if (!sourceMap.has(s.source_id)) sourceMap.set(s.source_id, {
    id: s.source_id, jurisdiction: 'PRODUCT', title: s.title || '', url: clean(s.url),
    probe: s.retrieval_status || '', verification: s.content_verified || '', note: (s.notes || '').slice(0, 160),
    checkedAt: s.checked_at || '', org: s.organization || '', sourceType: s.source_type || '',
  });
});
const sources = [...sourceMap.values()].map((s) => {
  // 双保险：剥离任何疑似绝对路径的字段
  const { pdfPath, localPath, path, ...rest } = s;
  return rest;
});
log('来源记录（合并）', sources.length);

/* ---------- 9. 覆盖矩阵、审计与缺口摘要 ---------- */
const coverageMatrix = wb.coverage_matrix.map((c) => ({ j: c.jurisdiction, topic: c.topic_id, status: c.coverage_status, ruleReady: !!c.rule_ready }));
// 产品小类 → 任务三规则候选路由（675 条；仅作路由，不生成义务）
const productRuleLinks = wb.product_rule_links.map((l) => ({ sub: l.subcategory_id, ruleId: l.rule_id, jurisdiction: l.jurisdiction || '', reason: l.link_reason || '' }));
const hsTaxAudit = wb.hs_tax_audit.map((a) => ({ id: a.issue_id, severity: a.severity, scope: a.scope, finding: a.finding, impact: a.impact, resolution: a.resolution }));
const gapsByType = {};
wb.gaps.forEach((g) => { gapsByType[g.type || g.gap_type || 'other'] = (gapsByType[g.type || g.gap_type || 'other'] || 0) + 1; });
const gapsSummary = { total: wb.gaps.length, byType: gapsByType, note: '440 条为“法域×主题”矩阵空白、成员国实施缺口与来源访问问题的合计，不代表 440 部已知法规缺失。' };

/* ---------- 10. 企业研究档案（来自《小家电出海工作台前置研究(1).html》，核验日 2026-11-04） ---------- */
const companies = [
  {
    id: 'bear',
    name: '小熊电器',
    fullName: '小熊电器股份有限公司（002959.SZ）',
    tagline: '创意小家电；2025 年东南亚为最大海外市场，越南线下合作门店超 1,500 家',
    scopeNote: '以下档案依据公开官网、交易所披露年报/半年报与主管机关指南整理，属于研究资料，不构成企业内部数据。',
    markets: [
      { code: 'MY', name: '马来西亚半岛', status: '研究路线（尚未发生出口）', note: 'ST 安全审批（CoA）＋能效（CoE/MEPS）＋进口批次检验的研究对象。' },
      { code: 'VN', name: '越南', status: '既有渠道市场（未在本轮研究中）', note: '公开披露称 2025 年越南线下合作门店超 1,500 家；本轮未做越南政策研究。' },
    ],
    researchRoute: {
      title: '研究路线：DFB-P20H1 电饭煲 × 马来西亚半岛',
      disclaimer: '这是基于真实型号重建的市场进入研究路线，不是已经实现的出口事实；国内在售型号不能自动当作出口型号。',
      steps: ['确定出口样机（核功率与容量口径）', '申请进口批准（安全与能效分别核）', '进口与批次检验（清关后按路径取标）', '零售与售后（按批次追溯）'],
      sources: [
        { label: 'ST 能效指南第 8 部分（2025-05-05 版 PDF）', url: 'https://st.gov.my/sites/default/files/2026-02/20250505-GUIDELINES-ON-ENERGY-USING-PRODUCT.pdf' },
        { label: 'ST 电器审批指南（2024 版 PDF）', url: 'https://st.gov.my/sites/default/files/2026-02/Guidelines-for-the-Approval-of-Electrical-Equipment-%282024-Edition%29.pdf' },
        { label: 'ST 进口及批次检验流程（CoA）', url: 'https://www.st.gov.my/how-do-i-apply-certificate-approval-coa' },
        { label: 'ST 申报平台迁移公告（2026-09-28 起）', url: 'https://www.st.gov.my/stakeholders/energy-efficiency/energy-efficiency-and-conservation-act-eeca-2024/energy-using-product' },
      ],
    },
    products: [
      {
        model: 'DFB-P20H1', category: '厨房小家电／电饭煲', subcategoryId: 'K-COOK-003',
        facts: '600 W；220 V／50 Hz；3 L 额定容量；微电脑控制（中国官网版）',
        pending: '最大煮饭容量、加热方式、出口插头需另核；3 L 为额定容量而非最大煮饭容量。',
        bringFacts: { household: true, endUse: 'consumer', voltageAc: 220, frequencyHz: 50, powerW: 600, capacityL: 3, mainFunction: 'cook_rice' },
        sources: [{ label: '小熊官网产品页', url: 'https://www.bears.com.cn/products/kitcheninfo.html?id=199' }],
      },
      {
        model: 'DFB-B12F1', category: '厨房小家电／电饭煲', subcategoryId: 'K-COOK-003',
        facts: '300 W；220 V／50 Hz；1.2 L；净重 1.24 kg；不粘内胆（中国官网版）',
        pending: '300 W 款低于马来西亚能效指南功率下限（400 W），安全审批仍需单独核；与 600 W 款分开匹配能效边界。',
        bringFacts: { household: true, endUse: 'consumer', voltageAc: 220, frequencyHz: 50, powerW: 300, capacityL: 1.2, mainFunction: 'cook_rice' },
        sources: [{ label: '小熊官网产品页', url: 'https://www.bears.com.cn/products/kitcheninfo.html?id=175' }],
      },
      {
        model: 'QZG-E16C5', category: '厨房小家电／空气炸锅', subcategoryId: 'K-COOK-002',
        facts: '1,550 W；220 V／50 Hz；5.0 L；发热管 304 不锈钢；定时 0–60 分钟（中国官网版）',
        pending: '容量采用参数区数值；炸篮及涂层材质须独立核实。',
        bringFacts: { household: true, endUse: 'consumer', voltageAc: 220, frequencyHz: 50, powerW: 1550, capacityL: 5, mainFunction: 'hot_air_cooking' },
        sources: [{ label: '小熊官网产品页', url: 'https://www.bears.com.cn/products/kitcheninfo.html?id=191' }],
      },
      {
        model: 'LLJ-B03C1', category: '厨房小家电／便携榨汁杯', subcategoryId: 'K-PREP-JUICE-002',
        facts: '300 mL；370 g；750 mAh × 2（内置锂电）；Tritan 杯身；304 刀片；标称充电 2 小时（中国官网版）',
        pending: '官网电压栏写“7.4W-50W”，单位异常；电压、功率、Wh 均暂缺，不代入计算。',
        bringFacts: { household: true, endUse: 'consumer', batteryPresent: true, wirelessPresent: false, foodContact: true, mainFunction: 'juice_blending' },
        sources: [{ label: '小熊官网产品页', url: 'https://www.bears.com.cn/products/kitcheninfo.html?id=48' }],
      },
    ],
    finance: [
      { period: '2025 全年', item: '厨房小家电收入／成本', value: '收入 RMB 3,380,048,983.32 ／ 成本 2,154,362,986.73', src: '2025 年报第 19 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-09/1225085711.PDF#page=19' },
      { period: '2025 全年', item: '国外销售收入／成本', value: '收入 RMB 951,278,116.98 ／ 成本 647,459,689.08', src: '2025 年报第 19 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-09/1225085711.PDF#page=19' },
      { period: '2026 上半年', item: '厨房小家电收入／成本', value: '收入 RMB 1,514,944,902.29 ／ 成本 974,227,513.38（未单列饭煲/炸锅/榨汁杯）', src: '2026 半年报第 112 页', url: 'https://disc.static.szse.cn/disc/disk03/finalpage/2026-08-14/308aa9d4-f557-48a8-936b-46a6c62bb553.PDF#page=112' },
      { period: '2026 上半年', item: '国外销售收入／成本', value: '收入 RMB 419,173,249.42 ／ 成本 295,818,569.63', src: '2026 半年报第 112 页', url: 'https://disc.static.szse.cn/disc/disk03/finalpage/2026-08-14/308aa9d4-f557-48a8-936b-46a6c62bb553.PDF#page=112' },
      { period: '2025-12-31', item: '其他应收款——出口退税款', value: 'RMB 4,541,586.75（期末余额，未按品类拆分）', src: '2025 年报第 130 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-09/1225085711.PDF#page=130' },
      { period: '2026-06-30', item: '其他应收款——出口退税款', value: 'RMB 2,517,590.49（期末余额，未按品类拆分）', src: '2026 半年报第 88 页', url: 'https://disc.static.szse.cn/disc/disk03/finalpage/2026-08-14/308aa9d4-f557-48a8-936b-46a6c62bb553.PDF#page=88' },
      { period: '2025 / 2026H1', item: '税金及附加', value: 'RMB 39,431,061.62 ／ 22,392,704.49（合并口径，含城建税等）', src: '2025 年报第 156 页；2026 半年报', url: 'https://static.cninfo.com.cn/finalpage/2026-04-09/1225085711.PDF#page=156' },
      { period: '2025 / 2026H1', item: '销售费用——运输费', value: 'RMB 20,721,665.56 ／ 10,242,637.92（未区分内外销）', src: '2025 年报第 157 页；2026 半年报第 113 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-09/1225085711.PDF#page=157' },
    ],
    financeNote: '公开财报未按型号披露实缴出口关税或目的国进口税额；品类收入占比不用于推算某型号已缴税额。产品级税费需逐票报关资料补足。',
  },
  {
    id: 'roborock',
    name: '石头科技',
    fullName: '北京石头世纪科技股份有限公司（688169.SH）',
    tagline: '智能清洁机器人；2026 上半年境外收入约 RMB 60.73 亿，约占六成',
    scopeNote: '以下档案依据公开官网、官方说明书、交易所披露年报/半年报整理，属于研究资料，不构成企业内部数据。',
    markets: [
      { code: 'DE', name: '德国', status: '研究路线（德国官网在售渠道供货场景）', note: '德国官网提供 S8 MaxV Ultra 德文资料与销售页面，以此重建欧盟准入与履约流程。' },
    ],
    researchRoute: {
      title: '研究路线：S8 MaxV Ultra 扫拖机器人 × 德国',
      disclaimer: '这是基于德国在售渠道公开资料重建的履约研究场景，不是企业内部订单或批次放行记录。',
      steps: ['渠道与报价（主机、基站、服务）', '地区配置（电源、无线与软件）', '清关与上架（成套归类、德文信息）', '售后与更新（配件、批次、固件）'],
      sources: [
        { label: 'EU 无线电设备指令 2014/53（Art.3、10、12）', url: 'https://eur-lex.europa.eu/eli/dir/2014/53/oj/eng' },
        { label: '欧盟 TARIC 数据库', url: 'https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp?Lang=en' },
        { label: '欧盟税则预裁定 EBTI', url: 'https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/european-binding-tariff-information-ebti_en' },
        { label: 'GPSR（Reg. (EU) 2023/988）第 19 条', url: 'https://eur-lex.europa.eu/eli/reg/2023/988/oj/eng' },
        { label: '德国包装登记（LUCID／Verpackungsregister）', url: 'https://www.verpackungsregister.org/en/registration/find-out-about-registrations' },
        { label: '欧委会《网络韧性法》适用日期与报告要求（2026-09-11）', url: 'https://commission.europa.eu/news-and-media/news/safer-and-more-secure-digital-products-2026-09-11_en' },
      ],
    },
    products: [
      {
        model: 'S8 MaxV Ultra（主机 S82USV）', category: '清洁家电／扫拖机器人', subcategoryId: 'C-VAC-005',
        facts: '主机输入 20 V DC／1.5 A；电池 14.4 V／5,200 mAh（典型，按 74.88 Wh 计算值记录）；充电约 4 小时；德国商品页列 10,000 Pa 与 2.4 GHz WLAN；含摄像头/视频功能',
        pending: '74.88 Wh 为计算值，运输用值须与电池文件（UN 38.3）核对；视频数据是否离开设备、接收方及保存期限待数据流资料确认。',
        bringFacts: { household: true, endUse: 'consumer', wirelessPresent: true, internetConnected: true, batteryPresent: true, mainFunction: 'vacuum_and_mop' },
        sources: [
          { label: '官方说明书（220–240 V 版，第 12 页）', url: 'https://support.roborock.com/hc/de/article_attachments/46140573658905#page=12' },
          { label: '石头德国商品页', url: 'https://de.roborock.com/products/roborock-s8-maxv-ultra-saugroboter-mit-8-in-1-rockdock-ultra' },
        ],
      },
      {
        model: '基站 EWFD13HRR / EWFD13LRR', category: '扫拖机器人配套基站', subcategoryId: 'C-VAC-005',
        facts: 'EWFD13HRR：220–240 V／50–60 Hz；集尘输入 3 A、热水洗拖布 6 A、充电烘干 0.75 A、输出 20 V DC／1.5 A。EWFD13LRR：120 V／60 Hz（不覆盖德国 230 V／50 Hz）。',
        pending: '同一主机型号对应不同地区基站；整机瓦数以额定铭牌为准，输入电流按工作模式分别存储。',
        bringFacts: {},
        sources: [
          { label: '220–240 V 版说明书', url: 'https://support.roborock.com/hc/de/article_attachments/46140573658905' },
          { label: '120 V 版说明书', url: 'https://support.roborock.com/hc/en-us/article_attachments/48696021303321' },
        ],
      },
      {
        model: 'Flexi Pro', category: '清洁家电／洗地机', subcategoryId: 'C-VAC-006',
        facts: '标称吸力 17,000 Pa；下压力 17 N；热水自清洁；刷辊自动烘干；App 提醒（德国商品页版）',
        pending: '网页宣传参数可核；主机和底座额定功率、电池 Wh 另取铭牌。',
        bringFacts: { household: true, endUse: 'consumer', mainFunction: 'wet_dry_vacuum' },
        sources: [{ label: '石头德国官网', url: 'https://de.roborock.com/products/roborock-flexi-pro-nass-und-trockenstaubsauger' }],
      },
      {
        model: 'Flexi Lite', category: '清洁家电／洗地机', subcategoryId: 'C-VAC-006',
        facts: '标称吸力 17,000 Pa；刷辊自动烘干 1 小时；污物传感器（德国商品页版）',
        pending: '与 Flexi Pro 吸力相同，热洗、联网及供电参数分别核。',
        bringFacts: { household: true, endUse: 'consumer', mainFunction: 'wet_dry_vacuum' },
        sources: [{ label: '石头德国官网', url: 'https://de.roborock.com/products/roborock-flexi-lite-nass-und-trockenstaubsauger' }],
      },
    ],
    finance: [
      { period: '2026 上半年', item: '境外营业收入', value: 'RMB 6,072,566,883（约 60.73 亿，占总收入约六成）', src: '2026 半年报第 187 页', url: 'https://static.cninfo.com.cn/finalpage/2026-08-25/1225497305.PDF#page=187' },
      { period: '2025 全年', item: '境外收入／成本', value: '收入 RMB 10,441,601,948 ／ 成本 5,414,144,526', src: '2025 年报第 54 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-23/1225147552.PDF#page=54' },
      { period: '2025 全年', item: '智能扫地机及配件收入／成本', value: '收入 RMB 15,172,943,325 ／ 成本 8,604,837,762（含多型号及配件）', src: '2025 年报第 54 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-23/1225147552.PDF#page=54' },
      { period: '2026 上半年', item: '智能清洁产品及配件收入／成本', value: '收入 RMB 10,076,850,279 ／ 成本 5,718,112,803', src: '2026 半年报第 187 页', url: 'https://static.cninfo.com.cn/finalpage/2026-08-25/1225497305.PDF#page=187' },
      { period: '截至 2026-06-30', item: '子公司累计收到关税退还款项', value: 'USD 39,869,246.04（报告折合 RMB 274,825,889.42）', src: '2026 半年报第 13 页', url: 'https://static.cninfo.com.cn/finalpage/2026-08-25/1225497305.PDF#page=13' },
      { period: '2026 上半年', item: '上述退款中已计入当期损益部分', value: 'USD 27,883,965.29（折 RMB 192,209,191.86）', src: '2026 半年报第 13 页', url: 'https://static.cninfo.com.cn/finalpage/2026-08-25/1225497305.PDF#page=13' },
      { period: '2026 上半年', item: '现金流附注：收到的关税退税及利息', value: 'RMB 272,259,578（与第 13 页折算值相差 RMB 2,566,311.42，勾稽说明待向公司核实）', src: '2026 半年报第 193 页', url: 'https://static.cninfo.com.cn/finalpage/2026-08-25/1225497305.PDF#page=193' },
      { period: '2025 全年', item: '税金及附加', value: 'RMB 75,949,231（合并口径，含城建税、房产税等）', src: '2025 年报第 230 页', url: 'https://static.cninfo.com.cn/finalpage/2026-04-23/1225147552.PDF#page=230' },
    ],
    financeNote: '石头 2025 年报将境外毛利率下降归因于关税、运费及售后投入增加，但未量化到具体产品；未查得按型号列示的实缴出口关税或目的国进口税额。',
  },
];

/* ---------- 11. 组装输出 ---------- */
const voData = {
  meta: {
    app: '远见·企业出海助手',
    version: '2.0.0',
    generatedAt: new Date().toISOString(),
    dataAsOf: SNAP,
    builtAt: AS_OF,
    scope: '面向中国小家电出海的条件初筛、HS/税费阶段测算、政策新闻筛选与建议任务生成；不替代主管机关、认证机构、律师、税务顾问或海关决定。',
    dataSources: [
      '任务二：小家电产品小类资料 Sourcing 数据库（57 小类／80 字段／773 动态映射，快照 ' + SNAP + '）',
      '任务三：法规 Sourcing 与核验数据包（79 法规／245 来源／56 条件规则，快照 ' + SNAP + '）',
      '正式合规项目 dataset（规则、行动、材料、HS 候选、19 条税种与公式、贸易术语承担矩阵、参考选项集、税费画像，快照 2026-11-03/04）',
      '《小家电出海工作台前置研究》企业档案（小熊电器、石头科技，核验日 2026-11-04）',
      'PolicyRadar 新闻雷达快照与 RSS/Atom 来源配置',
    ],
    levels: coverage,
  },
  jurisdictions, categories, groups, subcategories, fields, ruleFields, dynamicMap, judgments,
  topics, regulations, sources, rules, actions, materials, productRuleLinks,
  hsCandidates, taxProfiles, coverageProfiles: [...covList.values()],
  taxRules, incotermMatrix, formOptions, taxTemplates,
  coverageMatrix, hsTaxAudit, gapsSummary,
  companies,
};

const outJs = '/*! 远见·企业出海助手 数据包（由 build/build-data.mjs 生成，请勿手工编辑） */\nwindow.VO_DATA = ' + JSON.stringify(voData) + ';\n';
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data/vo-data.js'), outJs, 'utf-8');
writeFileSync(join(ROOT, 'data/vo-data.json'), JSON.stringify(voData, null, 1), 'utf-8');
log('已写出 data/vo-data.js（' + Math.round(outJs.length / 1024) + ' KB）与 data/vo-data.json');

/* ---------- 12. 新闻快照包装 ---------- */
const newsMeta = {
  exportedAt: newsOriginal.exported_at || new Date().toISOString(),
  snapshotNote: '初始快照来自 PolicyRadar 交接包 news.json；此后由 GitHub Actions 定时采集重建。',
  sources: feeds.map((f) => ({ market: f.market, name: f.name, status: 'configured' })),
  allFailed: false,
};
const newsJs = '/*! 新闻快照（由 tools/collect_news.py 定时重建） */\nwindow.VO_NEWS = ' + JSON.stringify({ meta: newsMeta, items: newsOriginal.items }) + ';\n';
writeFileSync(join(ROOT, 'data/news.js'), newsJs, 'utf-8');
writeFileSync(join(ROOT, 'data/news.json'), JSON.stringify({ meta: newsMeta, items: newsOriginal.items }, null, 1), 'utf-8');
log('已写出 data/news.js（' + Math.round(newsJs.length / 1024) + ' KB），新闻', newsOriginal.items.length, '条');
log('构建完成 ✔');
