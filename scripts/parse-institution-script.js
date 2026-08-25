#!/usr/bin/env node
/**
 * 三大法人專用腳本解析：解析 public/script.txt 內的 (shot:名稱)...(shot:名稱) 標記，
 * 產生 src/Institution/institution-shots.generated.json，並把當天日期（MMDD）寫進
 * src/video-meta.json 的 headerDate、標題寫進 titleText。
 *
 * 跟 parse-dapan-script.js 是同一個模子、各自獨立（輸出各自的 *-shots.generated.json）。
 * 共用 src/video-meta.json 的 headerDate/titleText 欄位（一次只跑一個 template，互不衝突）。
 *
 * 用法：npm run parse-script:institution
 */

const fs = require('fs');
const path = require('path');
const {
  getBodyAfterVoice,
  cleanBodyWithIndex,
} = require('./script-utils');

// 這支腳本寫進全域路徑（src/*.generated.json、public/），兩個 session 同時跑會靜默互蓋。
// 跟 run.js 共用同一把鎖（app/.run.lock）。
require('./workspace-lock').acquire('parse-institution-script');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const OUTPUT_DIR = path.join(ROOT, 'src', 'Institution');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'institution-shots.generated.json');
const FOCUS_OUTPUT_PATH = path.join(OUTPUT_DIR, 'institution-focus.generated.json');
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
console.log(`\n✅ 三大法人解析完成：${shots.length} 個截圖標記`);
console.log(`   寫入 → ${path.relative(ROOT, OUTPUT_PATH)}\n`);
shots.forEach((s) => {
  console.log(`  ${s.src}  char idx：[${s.startCharIdx}, ${s.endCharIdx}]  原句：${s._phrase}`);
});

// ─── 聚焦標記 (focus:區塊[:高亮字])…(focus:區塊) ───
// 講到某段數據時，把三大法人資訊圖捲到該區塊、壓暗其餘、在高亮字那格畫黃框。
//   區塊：sec1/sec2/sec3/sec4（對應圖上①②③④，座標由 analyze-institution-image.js OCR 產出）
//   高亮字（選填）：圖上要框住的字串，例如 89,201 / +440.81 / +1.59%（timeline 端從 OCR 逐字框找位置）
const focusPattern = /\(focus:([^():]+)(?::([^)]*))?\)([\s\S]*?)\(focus:\1\)/gi;
const focuses = [];
for (const m of bodyAfterVoice.matchAll(focusPattern)) {
  const section = m[1].trim();
  const cellText = (m[2] || '').trim();
  const contentBodyStart = m.index + m[0].indexOf(m[3]);
  const contentBodyEnd = contentBodyStart + m[3].length;
  const range = bodyRangeToCleanedRange(contentBodyStart, contentBodyEnd);
  if (!range) {
    console.warn(`⚠️  focus「${section}」的內容在清洗後沒有任何字元，已跳過`);
    continue;
  }
  focuses.push({
    section,
    cellText,
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    _phrase: range.phrase,
  });
}
fs.writeFileSync(FOCUS_OUTPUT_PATH, JSON.stringify(focuses, null, 2));
console.log(`\n✅ 聚焦標記：${focuses.length} 個`);
console.log(`   寫入 → ${path.relative(ROOT, FOCUS_OUTPUT_PATH)}`);
focuses.forEach((f) => {
  console.log(
    `  ${f.section}${f.cellText ? '（框:' + f.cellText + '）' : ''}  char idx：[${f.startCharIdx}, ${f.endCharIdx}]  原句：${f._phrase}`
  );
});

// ─── 當天日期（MMDD，Asia/Taipei）寫進 video-meta.json.headerDate ───
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

// ─── 標題寫進 video-meta.json.titleText（給開場卡 TitleCard 用）───
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
