const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=require('node:module').createRequire(path.resolve(root,'../千问办公最终作品/tests/dom-smoke.mjs'))('jsdom'));}
const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://review.test/vision-overseas-v2/',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;w.scrollTo=()=>{};w.confirm=()=>true;
for(const file of ['data/vo-data.js','data/news.js','data/research-v2.js','js/engine.js','js/app.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
let checks=0;const check=(v)=>{assert.ok(v);checks++;};
check(w.document.getElementById('view-home').classList.contains('on'));check(w.V2_PRODUCTS.length===16);
const nav=(name)=>w.document.querySelector('#sideNav [data-tab="'+name+'"]').click();nav('research');check(w.document.querySelectorAll('#v2-products article').length===16);
w.document.getElementById('v2-category').value='5';w.document.getElementById('v2-category').dispatchEvent(new w.Event('change'));check(w.document.querySelectorAll('#v2-products article').length===3);
w.document.querySelector('#v2-products button').click();check(w.__VO_TEST__.current().scenario.subcategoryId==='C-VAC-005');check(w.__VO_TEST__.current().researchEvidence.name.includes('S8'));check(Object.keys(w.__VO_TEST__.current().scenario.facts).length===0);
nav('documents');check(w.document.querySelectorAll('#v2-documents a[href$=".pdf"]').length===4);
for(const d of JSON.parse(fs.readFileSync(path.join(root,'policy-documents/SG/index.json'),'utf8'))){check(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,d.path))).digest('hex')===d.sha256);}
nav('news');const frame=w.document.querySelector('iframe');check(!!frame);const news=w.VO_NEWS.items[0];w.dispatchEvent(new w.MessageEvent('message',{origin:w.location.origin,source:frame.contentWindow,data:{type:'radar-select',url:news.url}}));check(w.__VO_TEST__.current().newsSelected.length===1);
const html=fs.readFileSync(path.join(root,'modules/radar.html'),'utf8');const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];for(const s of scripts)new Function(s[1]);check(!html.includes('./api/refresh'));check(html.includes('../data/news.json'));check(html.includes('data-add='));
w.close();console.log('V2 integration: '+checks+' checks passed');
