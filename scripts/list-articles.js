#!/usr/bin/env node

// ─────────────────────────────────────────
//  cmnews 標籤頁「最新 N 篇」列表工具
//
//  用法：
//    node scripts/list-articles.js <品牌> [N]
//    npm run list -- <品牌> [N]
//
//  範例：
//    node scripts/list-articles.js 起漲K線        # 預設列最新 5 篇
//    node scripts/list-articles.js 籌碼K線 3     # 列最新 3 篇
//
//  為什麼有這個工具：
//    cmnews 標籤頁第一頁是 SSR、HTML 約 160KB，整頁丟給 web_fetch 會爆
//    token、之後得開 subagent 切片才能讀，跑超慢（雷區，見 CLAUDE.md）。
//    其實只要直接抓 HTML、正則抽 /article/<slug> 就好，本機 < 0.5 秒。
//    此腳本就是把這條「正確做法」固化下來。
// ─────────────────────────────────────────

const TAG_URLS = {
  起漲K線: "https://cmnews.com.tw/tag/%E8%B5%B7%E6%BC%B2K%E7%B7%9AAPP",
  籌碼K線: "https://cmnews.com.tw/tag/%E7%B1%8C%E7%A2%BCK%E7%B7%9AAPP",
};

const ARTICLE_BASE = "https://cmnews.com.tw/article/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const brand = process.argv[2];
const n = Number(process.argv[3] || 5);

if (!brand || !TAG_URLS[brand]) {
  console.error("❌ 請指定品牌。用法：node scripts/list-articles.js <品牌> [N]");
  console.error(`   目前支援的品牌：${Object.keys(TAG_URLS).join(" / ")}`);
  process.exit(1);
}
if (!Number.isInteger(n) || n < 1 || n > 30) {
  console.error(`❌ N 必須是 1–30 之間的整數（拿到：${process.argv[3]}）`);
  process.exit(1);
}

const url = TAG_URLS[brand];

(async () => {
  const t0 = Date.now();
  let html;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`❌ 抓 ${url} 失敗：${err.message}`);
    process.exit(2);
  }

  // 抽 /article/cmoney-<uuid> 及其錨點內的標題文字。
  // 標題經常被 <span>/<br> 切散，所以用 [\s\S]*? 跨行 + 後續清標籤。
  const re = /\/article\/(cmoney-[a-f0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set();
  const items = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const inner = m[2]
      .replace(/<[^>]+>/g, "|")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const parts = inner.split("|").map((s) => s.trim()).filter(Boolean);
    // 第一段常是「前往…文章頁」這種 aria-label 包住的整句標題；
    // 去掉前綴「前往」與後綴「文章頁」就拿到乾淨標題。
    let title = parts[0] || "";
    title = title.replace(/^前往/, "").replace(/文章頁$/, "").trim();
    if (!title) continue;

    items.push({ slug, title });
    if (items.length >= n) break;
  }

  const ms = Date.now() - t0;

  if (items.length === 0) {
    console.error(`⚠️  沒抽到任何文章。可能原因：cmnews 改版、tag 頁無內容、或網路問題。`);
    console.error(`    HTML 長度：${html.length}`);
    process.exit(3);
  }

  console.log(`📰 ${brand}APP 標籤頁 · 最新 ${items.length} 篇  (耗時 ${ms}ms)`);
  console.log("");
  for (const [i, it] of items.entries()) {
    console.log(`[${i + 1}] ${it.title}`);
    console.log(`    ${ARTICLE_BASE}${it.slug}`);
  }
  console.log("");
  console.log("接下來：把全文網址丟給 Claude，請他依寫稿契約改寫成 public/script.txt");
})();
