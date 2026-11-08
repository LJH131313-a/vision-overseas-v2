/**
 * 远见·企业出海助手 —— 浏览器冒烟测试（jsdom，无外部网络）
 * 运行：node tests/dom-smoke.mjs
 * 验证：向导主线（侧栏 6 步）在真实 DOM 中可执行；按需追问、实时计算、
 *       HS/税费、新闻筛选、千问 API（mock fetch）、报告与快照失效逻辑均真实可用。
 */
import { createRequire } from 'node:module';
const { JSDOM } = await import('jsdom').catch(() => createRequire(new URL('../../千问办公最终作品/tests/dom-smoke.mjs', import.meta.url))('jsdom'));
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = (await import('node:module')).createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const html = readFileSync(join(ROOT, 'index.html'), 'utf-8');
const dom = new JSDOM(html, {
  url: 'https://vision-overseas.test/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;
window.scrollTo = function () {};
if (!window.URL.createObjectURL) window.URL.createObjectURL = function () { return 'blob:mock'; };
if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = function () {};

for (const s of ['data/vo-data.js', 'data/news.js', 'js/engine.js', 'js/app.js']) {
  window.eval(readFileSync(join(ROOT, s), 'utf-8'));
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; failures.push(name); console.log('  ✗', name, detail ? '→ ' + String(detail).slice(0, 220) : ''); }
}
function goto(tab) {
  const b = [...document.querySelectorAll('#sideNav .nav-item')].find((x) => x.getAttribute('data-tab') === tab);
  b.click();
}
const $v = (id) => document.getElementById(id).value;
const txt = (id) => document.getElementById(id).textContent;

console.log('== 1. 骨架与数据 ==');
check('VO_DATA 86 条规则', window.VO_DATA.rules.length === 86);
check('VO_NEWS 已加载', window.VO_NEWS.items.length > 0);
check('侧栏仍保留 6 个业务步骤', [...document.querySelectorAll('#sideNav .nav-item')].filter(b=>['product','compliance','tax','news','qianwen','report'].includes(b.dataset.tab)).length === 6);
check('默认显示新增首页', document.getElementById('view-home').classList.contains('on'));
goto('product');
check('hero 状态卡渲染', document.querySelectorAll('#heroStatus .hstat').length >= 2);
check('案例卡片带入按钮 8 个', [...document.querySelectorAll('#companyList button')].filter((b) => b.textContent.includes('带入本项目')).length === 8);
check('目的地分组显示（三档）', document.querySelectorAll('#pMarket optgroup').length === 3, document.querySelectorAll('#pMarket optgroup').length);

console.log('== 2. 案例带入 → 第 1 步 ==');
const bring = [...document.querySelectorAll('#companyList button')].filter((b) => b.textContent.includes('带入本项目'));
bring[0].click();
await new Promise((r) => setTimeout(r, 50));
check('带入小类=电饭煲 K-COOK-003', window.__VO_TEST__.current().scenario.subcategoryId === 'K-COOK-003');
check('带入市场=MY', window.__VO_TEST__.current().scenario.market === 'MY');
check('带入电压 220', window.__VO_TEST__.current().scenario.facts.voltage_ac === 220);
check('带入功率 0.6kW', window.__VO_TEST__.current().scenario.facts.power_kw === 0.6);
check('案例面板自动收起', document.getElementById('companyQuick').open === false);
check('品类卡片显示支持度', txt('subNote').includes('已选'));

console.log('== 3. 不同品类不同问题（按需） ==');
const before = document.querySelectorAll('#keyFacts .qa').length + document.querySelectorAll('#moreFacts .qa').length;
goto('product');
const chips = [...document.querySelectorAll('#groupChips button')];
const cleanChip = chips.find((c) => c.textContent.includes('真空吸尘'));
cleanChip.click();
await new Promise((r) => setTimeout(r, 30));
const robotCard = [...document.querySelectorAll('#subList .sub-item')].find((c) => c.textContent.includes('扫地'));
robotCard.click();
await new Promise((r) => setTimeout(r, 30));
check('切换品类生效', window.__VO_TEST__.current().scenario.subcategoryId === 'C-VAC-005');
const after = document.querySelectorAll('#keyFacts .qa').length + document.querySelectorAll('#moreFacts .qa').length;
check('不同品类问题集合不同', after !== before, before + ' → ' + after);
// 更多参数区存在且被标注为不影响当前判断
check('选填参数区标注不改变当前结论', document.querySelector('#moreFacts .subhint') !== null);

console.log('== 4. 德国目的地 + 合规初筛 ==');
const mSel = document.getElementById('pMarket');
mSel.value = 'DE';
mSel.dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 60));
goto('compliance');
const comp = txt('complianceResult');
check('覆盖等级横幅', comp.includes('服务覆盖等级'));
check('待补事实置顶（有未答关键事实）', document.querySelectorAll('#complianceResult .group-state').length >= 2);
check('可能适用分组', comp.includes('可能适用'));
check('不适用+待核验合并分组', comp.includes('单条规则不适用') && comp.includes('待规则核验'));
check('行动与材料分组', comp.includes('办理行动与材料'));
const info = txt('complianceRunInfo');
check('实时计算信息条', info.includes('实时计算') || info.includes('可能适用'), info.slice(0, 80));
// 回答一个待补事实 → 自动重算
const firstTri = [...document.querySelectorAll('#complianceResult .group-state .qa .tri button')][0];
if (firstTri) firstTri.click();
await new Promise((r) => setTimeout(r, 40));
check('回答后重算（仍正常渲染）', txt('complianceResult').includes('可能适用'));

console.log('== 5. HS 与税费 ==');
goto('tax');
let taxText = txt('taxBody');
check('德国无 HS 候选 → 明确缺口', taxText.includes('尚无经来源关联的目的国 HS 候选'));
check('德国显示变量计算式模板', taxText.includes('变量计算式') && taxText.includes('(20,500 + 20,000 × d) × v'), taxText.slice(0,150));
check('德国模板含 TARIC/EBTI 依据', taxText.includes('TARIC') && taxText.includes('EBTI'));
check('税则知识库出现', taxText.includes('税则知识库'));
check('贸易术语承担矩阵出现', taxText.includes('贸易术语与费用承担矩阵') && taxText.includes('合同费用承担 ≠ 法定税率'));
window.__VO_TEST__.mutate(function (p) {
  p.scenario.market = 'SG';
  p.scenario.subcategoryId = 'K-BEV-001';
  p.scenario.facts = Object.assign({}, p.scenario.facts, { household: true, end_use: 'consumer', voltage_ac: 230, capacity_l: 1.7, heats_liquid: true, boils_water: true, portable: true });
  p.scenario.factsUnknown = {};
  p.tax.currency = 'SGD';
});
goto('tax');
taxText = txt('taxBody');
check('SG 出现 HS 候选 85167910', taxText.includes('85167910'));
const radios = [...document.querySelectorAll('#taxBody input[type=radio]')];
radios[0].click();
await new Promise((r) => setTimeout(r, 30));
check('HS 选中写入项目', window.__VO_TEST__.current().hsChoice.length > 0);
const nums = [...document.querySelectorAll('#taxBody input[type=number]')];
nums[0].value = '20000'; nums[0].dispatchEvent(new window.Event('change'));
nums[1].value = '1500'; nums[1].dispatchEvent(new window.Event('change'));
nums[2].value = '100'; nums[2].dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 60));
taxText = txt('taxBody');
check('实时计算：税基 21,600.00', taxText.includes('21,600.00'), taxText.slice(0, 120));
check('进口 GST 9% 出现', taxText.includes('进口 GST'));
check('贸易救济未核查 → 完整总额不可用', taxText.includes('不可用') && taxText.includes('贸易救济'));
check('指示性操作费标注', taxText.includes('指示性'));
check('SG 知识库含 GST 公式行', taxText.includes('GST=(B+D)*0.09'), '');
check('SG 知识库含贸易救济未核提示', taxText.includes('TX-REMEDY') && taxText.includes('未查到当0'));
// 电吹风 SG：扩展包 HS 候选（851631）应出现
window.__VO_TEST__.mutate(function (p) { p.scenario.subcategoryId = 'P-HAIR-001'; p.scenario.facts = { household: true, end_use: 'consumer' }; p.scenario.factsUnknown = {}; p.hsChoice = ''; });
goto('tax');
const dryText = txt('taxBody');
check('电吹风 SG 出现扩展包 HS 候选 851631', dryText.includes('851631'), dryText.slice(0, 120));
// 马来西亚：SST 变量式
window.__VO_TEST__.mutate(function (p) { p.scenario.market = 'MY'; });
goto('tax');
const myText = txt('taxBody');
check('马来西亚显示 SST 变量计算式', myText.includes('关税 = 20,000 × d') && myText.includes('进口销售税'), myText.slice(0, 120));
check('马来西亚模板含销售税法依据', myText.includes('Sales Tax Act'));
// 恢复 SG 水壶场景供后续断言
window.__VO_TEST__.mutate(function (p) { p.scenario.market = 'SG'; p.scenario.subcategoryId = 'K-BEV-001'; });
goto('qianwen');

console.log('== 6. 新闻雷达 ==');
goto('news');
check('来源边界说明', txt('newsBody').includes('不是实时监控'));
check('快照状态可折叠', document.querySelectorAll('#newsBody details.box').length >= 1);
check('新闻列表渲染', document.querySelectorAll('#newsBody .news-item').length > 0);
const cb = document.querySelector('#newsBody .news-item input[type=checkbox]');
cb.click();
check('勾选进入项目', window.__VO_TEST__.current().newsSelected.length === 1);
const kw = document.querySelector('#newsBody input[type=search]');
kw.value = '不存在的关键词xyz';
kw.dispatchEvent(new window.Event('change'));
check('关键词筛选空结果提示', txt('newsBody').includes('没有符合筛选条件'));

console.log('== 7. 千问辅助（API mock） ==');
goto('qianwen');
check('主卡为在线分析', txt('qianwenBody').includes('在线分析：一键调用千问 API'));
check('手动闭环保留为折叠', txt('qianwenBody').includes('手动闭环'));
window.__VO_TEST__.setApiSettings({ apiKey: '' });
goto('qianwen');
[...document.querySelectorAll('#qianwenBody .btn')].find((b) => b.textContent.includes('调用千问 API')).click();
await new Promise((r) => setTimeout(r, 60));
check('未配置密钥有提示', txt('toastWrap').includes('配置 API Key'));
let req = null;
window.fetch = function (url, opts) {
  req = { url, opts };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ model: 'qwen-mock', choices: [{ message: { content: '【模拟】已知事实……立即办理：……' } }] }) });
};
window.__VO_TEST__.setApiSettings({ apiKey: 'sk-test', region: 'cn', model: 'qwen-plus', customModel: '', apiBase: '' });
req = null;
goto('qianwen');
[...document.querySelectorAll('#qianwenBody .btn')].find((b) => b.textContent.includes('调用千问 API')).click();
await new Promise((r) => setTimeout(r, 150));
check('请求端点正确', req && req.url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', req && req.url);
check('请求头带密钥', req && req.opts.headers.Authorization === 'Bearer sk-test');
const resp0 = window.__VO_TEST__.current().qianwen.responses[0];
check('API 回复自动保存', resp0 && resp0.via === 'api' && resp0.model === 'qwen-mock');
check('回复标记 API 调用', txt('qianwenBody').includes('千问回复（API 调用 · qwen-mock）'));
// 任务生成 + 手动粘贴
const genBtn = [...document.querySelectorAll('#qianwenBody summary')].find((s) => s.textContent.includes('手动闭环'));
genBtn.parentElement.open = true;
[...genBtn.parentElement.querySelectorAll('button')].find((b) => b.textContent.includes('生成分析任务')).click();
await new Promise((r) => setTimeout(r, 250));
const taskTa = genBtn.parentElement.querySelector('textarea');
check('任务含输出结构', taskTa.value.includes('立即办理') && taskTa.value.includes('补证后判断'));
check('任务含所选新闻', taskTa.value.includes('所选政策新闻线索'));
check('任务含税费阻断原因', taskTa.value.includes('贸易救济'));
const paste = [...genBtn.parentElement.querySelectorAll('textarea')][1];
paste.value = '【人工导入测试回复】';
[...genBtn.parentElement.querySelectorAll('button')].find((b) => b.textContent.includes('保存粘贴的回复')).click();
await new Promise((r) => setTimeout(r, 60));
check('人工导入回复已保存并标记', window.__VO_TEST__.current().qianwen.responses[0].via === 'manual' && txt('qianwenBody').includes('千问回复（人工导入）'));
// 401 失败
window.fetch = function () { return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ message: 'Invalid API-key' }) }); };
goto('qianwen');
[...document.querySelectorAll('#qianwenBody .btn')].find((b) => b.textContent.includes('调用千问 API')).click();
await new Promise((r) => setTimeout(r, 120));
check('401 具体提示', txt('toastWrap').includes('API Key 无效或未授权'));
check('失败不新增回复', window.__VO_TEST__.current().qianwen.responses.length === 2);
delete window.fetch;

console.log('== 8. 综合报告与失效标记 ==');
goto('report');
const rep = txt('reportBody');
check('报告含企业与项目', rep.includes('1. 企业与项目'));
check('报告含合规结论', rep.includes('3. 法规与合规初筛结论'));
check('报告含税费', rep.includes('5. HS 候选与税费'));
check('报告含新闻', rep.includes('6. 所选政策新闻'));
check('报告含千问回复', rep.includes('7. 千问辅助建议') && rep.includes('API 调用'));
check('报告含追溯与免责', rep.includes('8. 结论追溯与免责'));
const snapBtn = [...document.querySelectorAll('#btnSaveSnapshot')][0];
snapBtn.click();
await new Promise((r) => setTimeout(r, 60));
check('快照已保存', window.__VO_TEST__.current().reportSnapshots.length === 1);
window.__VO_TEST__.mutate(function (p) { p.scenario.placingOnMarketDate = '2027-01-01'; });
goto('report');
check('输入变化后快照标为历史', txt('reportBody').includes('快照为历史结果') || txt('reportBody').includes('需要重新分析'));

console.log('== 9. 侧栏状态点与数据说明 ==');
check('步骤状态点存在', document.querySelectorAll('#sideNav .dot').length === 6);
check('部分步骤已标记完成', document.querySelectorAll('#sideNav .dot.done').length >= 2, document.querySelectorAll('#sideNav .dot.done').length);
document.getElementById('lnkAbout').click();
check('数据说明可达', document.getElementById('view-about').classList.contains('on') && txt('aboutBody').includes('数据规模与覆盖等级'));
document.getElementById('btnBackAbout').click();
check('可返回流程', document.getElementById('view-report').classList.contains('on'));

console.log(`\n===== DOM 冒烟测试：${pass + fail} 项断言，通过 ${pass}，失败 ${fail} =====`);
if (failures.length) { console.log('失败：', failures.join('；')); process.exit(1); }
console.log('全部通过 ✔');
