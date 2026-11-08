#!/usr/bin/env node
/**
 * 远见·企业出海助手 —— 无 Python 环境下的新闻包装重建工具（维护辅助）
 * 用途：把 data/news.json 重新包装为 data/news.js（页面 <script> 加载用）。
 * 正式采集请使用 tools/collect_news.py（本地 Python 或 GitHub Actions 定时任务）。
 * 运行：node tools/rebuild_news_js.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEWS_JSON = join(ROOT, 'data/news.json');
const NEWS_JS = join(ROOT, 'data/news.js');

const payload = JSON.parse(readFileSync(NEWS_JSON, 'utf-8'));
if (!payload.items || !Array.isArray(payload.items)) {
  console.error('data/news.json 缺少 items 数组。');
  process.exit(1);
}
const js = '/*! 新闻快照（由 tools/rebuild_news_js.mjs 从 data/news.json 重建） */\nwindow.VO_NEWS = ' + JSON.stringify(payload) + ';\n';
writeFileSync(NEWS_JS, js, 'utf-8');
console.log(`[done] news.js 已重建：${payload.items.length} 条；快照时间 ${payload.meta?.exportedAt || '未知'}`);
