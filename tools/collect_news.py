#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
远见·企业出海助手 —— 新闻采集与快照合并程序（仅用 Python 标准库）

用法：
    python tools/collect_news.py                 # 采集并合并
    python tools/collect_news.py --offline       # 不联网，仅重建 news.js 与状态包装

行为约定：
1. 读取 news/feeds.json 官方 RSS/Atom 来源（不要添加无权访问的来源，也不绕过访问限制）。
2. 逐源抓取、按关键词相关性与主题分类（沿用 PolicyRadar 交接包的分类规则）。
3. 与 data/news.json 既有快照合并去重（按 id = 标题+链接 指纹），按发布时间倒序，
   保留窗口：最多 NEWS_MAX_ITEMS 条且不超过 NEWS_MAX_AGE_DAYS 天，避免无限增长。
4. 部分来源失败：保留成功来源与历史新闻，状态中记录失败原因。
   全部来源失败：完整保留最后一次成功快照，状态标记 all_failed。
5. 输出 data/news.json（机器可读）与 data/news.js（window.VO_NEWS，供静态页面 <script> 加载）。

定时执行由 .github/workflows/update-news.yml 完成（北京时间约 09:17 / 17:17，可手动运行）。
"""
import json
import re
import sys
import hashlib
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEEDS = ROOT / 'news' / 'feeds.json'
NEWS_JSON = ROOT / 'data' / 'news.json'
NEWS_JS = ROOT / 'data' / 'news.js'
UA = 'VisionOverseasBot/1.0 (static site news snapshot; contact repo owner)'
NEWS_MAX_ITEMS = 1200
NEWS_MAX_AGE_DAYS = 730
PER_FEED_LIMIT = 60

CATEGORIES = ['产品准入与安全', '能效与生态设计', '环保与材料限制', '标签与消费者信息',
              '贸易与海关', '召回与执法', '政策利好与市场机会', '平台与销售规则', '市场风向与行业热点']
KEYWORDS = {
    '产品准入与安全': ['安全', '认证', '合格评定', '标准', '测试', 'market access', 'certification', 'safety', 'approval'],
    '能效与生态设计': ['能效', '能源效率', '待机', '生态设计', '节能', 'energy efficiency', 'ecodesign', 'standby'],
    '环保与材料限制': ['环保', '有害物质', '电池', '包装', '回收', '化学品', 'waste', 'recycling', 'substance', 'battery'],
    '标签与消费者信息': ['标签', '说明书', '警示', '原产地', '消费者信息', 'label', 'labelling', 'warning'],
    '贸易与海关': ['关税', '海关', '进口', '反倾销', '原产地规则', '清关', 'tariff', 'customs', 'import'],
    '召回与执法': ['召回', '抽检', '罚款', '禁售', '执法', 'recall', 'enforcement', 'fine'],
    '政策利好与市场机会': ['补贴', '消费刺激', '投资', '绿色产品', '资助', 'subsidy', 'incentive', 'investment'],
    '平台与销售规则': ['电商', '平台', '广告', '产品责任', '线上销售', 'e-commerce', 'online marketplace', 'consumer protection'],
    '市场风向与行业热点': ['consumer demand', 'retail sales', 'home improvement', 'market trend', 'industry outlook',
                     'appliance market', 'appliance sales', 'smart home', 'home electronics', 'green consumption',
                     'energy saving', 'air quality', 'consumer electronics', '家电市场', '消费趋势', '消费需求',
                     '零售销售', '产业趋势', '行业动态', '智能家居', '绿色消费', '空气质量'],
}
RELEVANT_TERMS = ['appliance', 'home appliance', 'household electrical', 'kitchen appliance', 'vacuum',
                  'air purifier', 'hair dryer', 'washing machine', 'energy efficiency', 'ecodesign',
                  'product safety', 'certification', 'technical standard', 'product standard', 'product recall',
                  'tariff', 'customs', 'import duty', 'import regulation', 'export control', 'origin rule',
                  'packaging', 'labelling', 'labeling', 'battery', 'hazardous substance', 'chemical restriction',
                  'recycling', 'e-commerce regulation', 'consumer product', 'supply chain', 'consumer demand',
                  'retail sales', 'home improvement', 'smart home', 'home electronics', 'consumer electronics',
                  'appliance sales', 'green consumption', 'energy saving', 'air quality', 'trade measure',
                  'market access', 'appliance market', '家电', '小家电', '消费需求', '零售销售', '消费趋势']

IMPACT_HINTS = {
    '产品准入与安全': '核对涉及产品是否落入当地强制认证/测试范围，检查证书持有人、测试标准及生效日期；出货前确认型号和技术文件。',
    '能效与生态设计': '对照该市场适用的能效门槛、测试方法、待机功耗与标签要求，确认在售型号是否需要改版或补测。',
    '环保与材料限制': '核对材料、化学物质、电池与包装的适用范围；检查供应商声明、回收注册及费用，并确认过渡期。',
    '标签与消费者信息': '检查当地语言、警示、原产地、说明书和电商商品页要求，列出需要改版的包装与线上资料。',
    '贸易与海关': '复核 HS 编码、关税/贸易救济、原产地规则、进口许可和清关文件，更新到岸成本及供应链方案。',
    '召回与执法': '核对通报涉及的型号、批次和销售渠道，检查本企业是否有同类风险，并准备停售、追溯与整改流程。',
    '平台与销售规则': '检查目标平台的上架资料、责任主体、广告声明、退换货与售后要求，更新商品页和运营流程。',
    '政策利好与市场机会': '确认政策面向的行业、地区、企业资格、支持方式和申请期限，再评估小家电项目能否申报或合作。',
    '市场风向与行业热点': '把报道当作需求线索：核对目标市场的销量、搜索、渠道数据与价格带，比较竞品后再调整选品、库存或营销，不凭单条新闻直接扩产。',
}


def categorize(text: str):
    low = text.lower()
    for cat, words in KEYWORDS.items():
        if any(w.lower() in low for w in words):
            return cat
    return None


def is_relevant(text: str) -> bool:
    t = text.lower()
    return any(x in t for x in RELEVANT_TERMS)


def impact_hint(category: str, market: str) -> str:
    return f'{market}关注建议：' + IMPACT_HINTS.get(category, '打开原文核对适用市场、产品范围和时间节点，再评估对选品、成本或渠道的影响。')


def stable_id(title: str, url: str) -> str:
    return hashlib.sha256(((title or '') + '|' + (url or '')).encode('utf-8')).hexdigest()[:16]


def parse_date(raw: str) -> str:
    """尽量解析 RFC822/ISO 日期，输出 ISO 字符串；失败返回空。"""
    raw = (raw or '').strip()
    if not raw:
        return ''
    try:
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    for fmt in ('%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%d'):
        try:
            return datetime.strptime(re.sub(r'\s+', ' ', raw), fmt).astimezone(timezone.utc).isoformat()
        except Exception:
            continue
    return ''


def fetch_feed(feed: dict):
    req = urllib.request.Request(feed['url'], headers={'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'})
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    items = root.findall('.//item') or root.findall('.//{http://www.w3.org/2005/Atom}entry')
    out = []
    for e in items[:PER_FEED_LIMIT * 3]:
        title = gettext(e, ['title', '{http://www.w3.org/2005/Atom}title'])
        desc = gettext(e, ['description', 'summary', '{http://www.w3.org/2005/Atom}summary'])
        link = gettext(e, ['link'])
        if not link:
            le = e.find('{http://www.w3.org/2005/Atom}link')
            link = le.attrib.get('href', '') if le is not None else ''
        pub = gettext(e, ['pubDate', 'published', 'updated', '{http://www.w3.org/2005/Atom}published', '{http://www.w3.org/2005/Atom}updated'])
        text = (title or '') + ' ' + (desc or '')
        if not title or not link or not is_relevant(text):
            continue
        cat = categorize(text) or '市场风向与行业热点'
        out.append({
            'id': stable_id(title, link),
            'market': feed.get('market', ''),
            'category': cat,
            'level': '中',
            'date': parse_date(pub) or datetime.now(timezone.utc).isoformat(),
            'source': feed.get('name', ''),
            'title': title,
            'summary': (desc or '')[:800],
            'impact': impact_hint(cat, feed.get('market', '')),
            'products': feed.get('products', ''),
            'url': link,
            'verified': '待核验',
        })
        if len(out) >= PER_FEED_LIMIT:
            break
    return out


def gettext(el, names):
    for n in names:
        v = el.findtext(n)
        if v:
            return v.strip()
    return ''


def load_existing():
    if NEWS_JSON.exists():
        try:
            return json.loads(NEWS_JSON.read_text(encoding='utf-8'))
        except Exception as ex:
            print(f'[warn] 既有 news.json 解析失败，按空快照处理：{ex}', file=sys.stderr)
    return {'meta': {}, 'items': []}


def main():
    offline = '--offline' in sys.argv
    feeds = json.loads(FEEDS.read_text(encoding='utf-8')) if FEEDS.exists() else []
    existing = load_existing()
    old_items = existing.get('items', [])
    old_meta = existing.get('meta', {})
    now_iso = datetime.now(timezone.utc).isoformat()

    sources_status = []
    new_items = []
    ok_count = 0
    if offline:
        sources_status = [{'market': f.get('market', ''), 'name': f.get('name', ''), 'status': 'offline_rebuild'} for f in feeds]
        print('[offline] 仅重建包装文件，不联网采集。')
    else:
        for feed in feeds:
            try:
                rows = fetch_feed(feed)
                new_items.extend(rows)
                ok_count += 1
                sources_status.append({'market': feed.get('market', ''), 'name': feed.get('name', ''),
                                       'status': 'ok', 'count': len(rows), 'fetched_at': now_iso})
                print(f"[ok] {feed.get('name', '?')}: {len(rows)} 条")
            except urllib.error.HTTPError as ex:
                # 遵守来源站点状态（403/429 等访问限制不重试、不绕过）
                sources_status.append({'market': feed.get('market', ''), 'name': feed.get('name', ''),
                                       'status': 'error', 'error': f'HTTP {ex.code}', 'fetched_at': now_iso})
                print(f"[error] {feed.get('name', '?')}: HTTP {ex.code}", file=sys.stderr)
            except Exception as ex:
                sources_status.append({'market': feed.get('market', ''), 'name': feed.get('name', ''),
                                       'status': 'error', 'error': str(ex)[:200], 'fetched_at': now_iso})
                print(f"[error] {feed.get('name', '?')}: {ex}", file=sys.stderr)

    # 合并去重（新数据优先），统一日期格式与 id，限制窗口
    merged = {}
    for it in new_items + old_items:
        key = it.get('id') or stable_id(it.get('title', ''), it.get('url', ''))
        if key not in merged:
            it = dict(it)
            it['id'] = key
            # 旧快照可能保留 RFC822 原文日期；统一转为 ISO 以便排序与窗口过滤
            if it.get('date') and 'T' not in it['date']:
                parsed = parse_date(it['date'])
                if parsed:
                    it['date'] = parsed
            merged[key] = it
    cutoff = (datetime.now(timezone.utc) - timedelta(days=NEWS_MAX_AGE_DAYS)).isoformat()

    def sort_key(it):
        return it.get('date') or ''

    items = sorted(merged.values(), key=sort_key, reverse=True)
    items = [it for it in items if (it.get('date') or '') >= cutoff][:NEWS_MAX_ITEMS]

    all_failed = (not offline) and ok_count == 0 and len(feeds) > 0
    meta = {
        'exportedAt': old_meta.get('exportedAt', '') if all_failed else now_iso,
        'lastAttemptAt': now_iso,
        'sources': sources_status if sources_status else old_meta.get('sources', []),
        'allFailed': all_failed,
        'snapshotNote': ('本次采集全部来源失败，已保留最后成功快照内容与状态。' if all_failed
                         else ('离线重建：未联网采集。' if offline else '定时采集快照；来源为政府官方 RSS/Atom 公告。')),
        'feedsConfigured': len(feeds),
        'maxItems': NEWS_MAX_ITEMS,
        'maxAgeDays': NEWS_MAX_AGE_DAYS,
    }
    payload = {'meta': meta, 'items': old_items if all_failed else items}

    NEWS_JSON.parent.mkdir(parents=True, exist_ok=True)
    NEWS_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')
    js = '/*! 新闻快照（由 tools/collect_news.py 生成；GitHub Actions 定时更新） */\nwindow.VO_NEWS = ' + json.dumps(payload, ensure_ascii=False) + ';\n'
    NEWS_JS.write_text(js, encoding='utf-8')
    print(f"[done] 保留 {len(items)} 条（本次新增来源成功 {ok_count}/{len(feeds)}）；all_failed={all_failed}")
    # 全部失败不作为流程错误退出：快照与状态仍需提交，供页面如实展示
    return 0


if __name__ == '__main__':
    sys.exit(main())
