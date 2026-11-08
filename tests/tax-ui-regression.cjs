// 使用实际 app.js 的 taxInput，检查 UI 状态到税费引擎的完整数据衔接。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/vo-data.json')));
const engine = require(path.join(root, 'js/engine.js'));
const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const fn = source.slice(source.indexOf('  function taxInput()'), source.indexOf('  function renderTax()'));
const project = {
  scenario: { market: 'SG', subcategoryId: 'K-BEV-001', importDate: '2026-11-04' },
  hsChoice: 'HS-SG-K1',
  tax: { goodsValue: '10000', currency: 'SGD', incoterm: 'FOB', priceBasis: 'FOB', freight: '800', insurance: '100', origin: 'CN', specialValuation: 'no', remedyCheck: 'confirmed_clear', multipleSales: false, lsp: '', lastBuyerDeclarant: '', confirmedCustomsValue: '', customsValueConfirmed: '', quantity: '' }
};
const context = vm.createContext({ proj: () => project, subById: id => data.subcategories.find(x => x.id === id) });
vm.runInContext(fn, context);
const calculate = () => engine.calculateTaxes(data, context.taxInput());
let checks = 0;
function eq(a,b){assert.equal(a,b);checks++;}
let result = calculate();
eq(result.import_gst,981); eq(result.complete_total,981.9);
eq(result.import_gst,engine.calculateTaxes(data,{...context.taxInput(),hs_candidate:'85167910'}).import_gst);
project.scenario.importDate = '2026-11-08'; result = calculate();
eq(result.import_gst,981); eq(result.complete_total,981.9); eq(result.warnings.some(s => s.includes('核验日不等于政策失效日')),true);
project.scenario.importDate = '2027-01-01'; result=calculate(); eq(result.complete_total,null);
project.scenario.importDate = '2025-12-31'; result=calculate(); eq(result.complete_total,null);
project.scenario.importDate = '2026-11-04'; project.tax.multipleSales = 'true'; project.tax.lsp = '15000';
result = calculate(); eq(result.gst_base,null); eq(result.import_gst,null);
project.tax.lastBuyerDeclarant = 'true'; result=calculate(); eq(result.import_gst,1350); eq(result.complete_total,1350.9);
project.tax.multipleSales = false; project.tax.currency = 'USD';project.tax.fxRate=''; result=calculate();eq(result.import_gst,null);
project.tax.currency='SGD'; project.tax.specialValuation='unknown';result=calculate();eq(result.import_gst,null);
project.tax.specialValuation='no';project.hsChoice='HS-NOT-FOUND';result=calculate();eq(result.complete_total,null);
console.log(`税费 UI 数据衔接回归：${checks} 项断言全部通过`);
