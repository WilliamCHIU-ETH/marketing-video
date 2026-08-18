#!/usr/bin/env node
/**
 * 大盤小報專用腳本解析：解析 public/script.txt 內的 (shot:名稱)...(shot:名稱) 標記，
 * 產生 src/DapanXiaobao/dapan-shots.generated.json，並把當天日期（MMDD）寫進
 * src/video-meta.json 的 headerDate 欄位。
 *
 * 跟現有 scripts/parse-script.js 是平行的兩支腳本，互不共用輸出檔（天條 #4 精神延伸）：
 *   - parse-script.js        → src/overlays.generated.json / src/textcards.generated.json（現有模板用）
 *   - parse-dapan-script.js  → src/DapanXiaobao/dapan-shots.generated.json（大盤小報專用）
 * 兩者都會讀寫 src/video-meta.json，但只碰自己的欄位（titleText vs headerDate），互不覆蓋。
 *
 * v1 範圍（2026-08-06，「先不考慮全自動化」）：只解析 (shot:名稱)，不含 OCR 黃框標註、
 * 不含 (imageN)/(logo)/(text:)。這些之後要加再擴充。
 *
 * 用法：npm run parse-script:dapan
 */

const fs = require('fs');
const path = require('path');
const {
  getBodyAfterVoice,
  cleanBodyWithIndex,
} = require('./script-utils');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const OUTPUT_DIR = path.join(ROOT, 'src', 'DapanXiaobao');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'dapan-shots.generated.json');
const VIDEO_META_PATH = path.join(ROOT, 'src', 'video-meta.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

if (!fs.existsSync(SCRIPT_PATH)) {
  console.error('❌ 找不到 ' + SCRIPT_PATH);
  process.exit(1);
}
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const scriptRaw = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const bodyAfterVoice = getBodyAfterVoice(scriptRaw);
const cleanedChars = cleanBodyWithIndex(bodyAfterVoice);
const origToCleanedIdx = new Map();
cleanedChars.forEach((c, i) => origToCleanedIdx.set(c.origIdx, i));

const ANCHOR_LEN = 3;

function findShotSrc(name) {
  for (const ext of ['.png', '.jpg', '.jpeg', '']) {
    const candidate = name + ext;
    if (fs.existsSync(path.join(PUBLIC_DIR, candidate))) return candidate;
  }
  return name + '.png';
}

function bodyRangeToCleanedRange(bodyStart, bodyEnd) {
  let startCharIdx = -1;
  let endCharIdx = -1;
  for (let bi = bodyStart; bi < bodyEnd; bi++) {
    const ci = origToCleanedIdx.get(bi);
    if (ci === undefined) continue;
    if (startCharIdx < 0) startCharIdx = ci;
    endCharIdx = ci;
  }
  if (startCharIdx < 0) return null;
  const phrase = cleanedChars.slice(startCharIdx, endCharIdx + 1).map((c) => c.char).join('');
  return { startCharIdx, endCharIdx, phrase };
}

// 大小寫不分；opts 這次先保留欄位但 v1 不解析 hl=（OCR 黃框標註留待之後）
const shotPattern = /\(shot:([^():]+)(?::([^)]*))?\)([\s\S]*?)\(shot:\1\)/gi;

const shots = [];
for (const m of bodyAfterVoice.matchAll(shotPattern)) {
  const name = m[1];
  const contentBodyStart = m.index + m[0].indexOf(m[3]);
  const contentBodyEnd = contentBodyStart + m[3].length;
  const range = bodyRangeToCleanedRange(contentBodyStart, contentBodyEnd);
  if (!range) {
    console.warn(`⚠️  shot「${name}」的內容在清洗後沒有任何字元，已跳過`);
    continue;
  }
  shots.push({
    src: findShotSrc(name),
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    startAnchor: range.phrase.slice(0, ANCHOR_LEN),
    endAnchor: range.phrase.slice(-ANCHOR_LEN),
    _phrase: range.phrase,
  });
}

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(shots, null, 2));
console.log(`\n✅ 大盤小報解析完成：${shots.length} 個截圖標記`);
console.log(`   寫入 → ${path.relative(ROOT, OUTPUT_PATH)}\n`);
shots.forEach((s) => {
  console.log(`  ${s.src}  char idx：[${s.startCharIdx}, ${s.endCharIdx}]  原句：${s._phrase}`);
});

// ─── 當天日期（MMDD，Asia/Taipei）寫進 video-meta.json.headerDate ───
// 只動 headerDate 這個欄位，不動 titleText 等其他既有欄位（跟 parse-script.js 共用同一份 json）
const now = new Date(
  new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })
);
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const headerDate = `${mm}${dd}`;

let meta = {};
if (fs.existsSync(VIDEO_META_PATH)) {
  meta = JSON.parse(fs.readFileSync(VIDEO_META_PATH, 'utf-8'));
}
meta.headerDate = headerDate;

// ─── 標題寫進 video-meta.json.titleText（2026-08-07 新增，給開場卡 TitleCard 用）───
// 用 parts[parts.length - 2]（「body 前一段」）而不是既有 parse-script.js 那種 parts[1]，
// 因為大盤小報使用者的 script.txt 目前多打了一個空的 === 區塊（4 段、不是標準 3 段），
// parts[1] 會抓到空段。parts[length-2] 對「標準 3 段」與「多一段空白」兩種情況都能抓對標題，
// 比較不容易因為使用者手滑多打一個 === 就整個抓錯。
const scriptParts = scriptRaw.split('===');
const titleText = scriptParts.length >= 3 ? scriptParts[scriptParts.length - 2].trim() : '';
if (titleText) {
  meta.titleText = titleText;
  console.log(`✅ 標題已寫入 video-meta.json.titleText：${titleText.replace(/\n/g, ' / ')}`);
} else {
  console.log('ℹ️  script.txt 沒有標題段（=== 少於 2 個），video-meta.json.titleText 不變');
}

fs.writeFileSync(VIDEO_META_PATH, JSON.stringify(meta, null, 2));
console.log(`✅ 日期已寫入 video-meta.json.headerDate：${headerDate}`);
