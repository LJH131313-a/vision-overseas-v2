/**
 * 远见·企业出海助手 —— 静态资源与子路径测试（模拟 GitHub Pages 项目站点 /vision-overseas/）
 * 运行：node tests/static-assets.test.mjs
 * 验证：
 *  1. index.html 引用的相对资源在子路径下均能返回 200；
 *  2. 页面文件不包含电脑绝对路径、API 密钥等敏感内容；
 *  3. data/vo-data.js 与 data/news.js 可被解析（window 变量注入成功）。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PREFIX = '/vision-overseas-v2'; // GitHub Pages 项目站点子路径
const PORT = 8130;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith(PREFIX)) p = p.slice(PREFIX.length) || '/';
  if (p === '/') p = '/index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; failures.push(name); console.log('  ✗', name, detail ? '→ ' + String(detail).slice(0, 160) : ''); }
}
async function get(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${PREFIX}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

console.log('== 1. index.html 引用的相对资源（子路径 ' + PREFIX + '/）==');
const html = (await get('/index.html')).body;
const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1])
  .filter((u) => !u.startsWith('http') && !u.startsWith('//'));
check('index.html 可访问（子路径）', true);
for (const ref of refs) {
  const { status } = await get('/' + ref.replace(/^\.\//, ''));
  check(`资源 ${ref}`, status === 200, 'HTTP ' + status);
}

console.log('== 2. 敏感内容检查 ==');
const files = ['index.html', 'css/styles.css', 'js/app.js', 'js/engine.js', 'data/vo-data.js', 'data/news.js', 'tools/collect_news.py', '.github/workflows/update-news.yml'];
for (const f of files) {
  const content = readFileSync(join(ROOT, f), 'utf-8');
  const absPathHits = content.match(/[A-Za-z]:\\\\?Users\\\\?[^\s"']+/g) || content.match(/\/Users\/[^\s"']+/g) || [];
  const secretHits = content.match(/(api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/gi) || [];
  check(`${f} 无电脑绝对路径`, absPathHits.length === 0, absPathHits[0]);
  check(`${f} 无硬编码密钥`, secretHits.length === 0, secretHits[0]);
}

console.log('== 3. 数据脚本可解析 ==');
const voData = (await get('/data/vo-data.js')).body;
const newsJs = (await get('/data/news.js')).body;
const sandbox = { window: {} };
new Function('window', voData + '\n' + newsJs)(sandbox.window);
check('vo-data.js 注入 VO_DATA', !!sandbox.window.VO_DATA && sandbox.window.VO_DATA.rules.length === 86);
check('news.js 注入 VO_NEWS', !!sandbox.window.VO_NEWS && sandbox.window.VO_NEWS.items.length > 0);

server.close();
console.log(`\n===== 静态资源测试：${pass + fail} 项断言，通过 ${pass}，失败 ${fail} =====`);
if (failures.length) { console.log('失败：', failures.join('；')); process.exit(1); }
console.log('全部通过 ✔');
