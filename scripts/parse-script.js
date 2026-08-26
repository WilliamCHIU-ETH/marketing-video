#!/usr/bin/env node
/**
 * 解析 script.txt 內的 (imageN)...(imageN) / (logo)...(logo) /
 * (shot:名稱)...(shot:名稱) / (text:...)...(/text)
 * 標記，自動產生 src/overlays.generated.json 與 src/textcards.generated.json。
 *
 * 用法：npm run parse-script
 *
 * 定位機制：
 *   - 每個 overlay / textcard 輸出 startCharIdx / endCharIdx
 *     （在 correct-subtitles 用的 cleaned script body 中的 char index）
 *   - timeline.ts 用 subtitles.json._scriptCharTimes 查時間
 *   - 不再用字串前 3 字搜尋 → 不會撞名 / 不會跨 segment 找不到
 *   - 仍保留 startAnchor / endAnchor 字串欄位（純 debug 用，方便人類讀 JSON）
 */

const fs = require('fs');
const path = require('path');
const {
  getBodyAfterVoice,
  getTitleText,
  cleanBodyWithIndex,
} = require('./script-utils');
const { imagePattern } = require('./segment-utils');

// 這支腳本寫進全域路徑（src/*.generated.json、public/），兩個 session 同時跑會靜默互蓋。
// 跟 run.js 共用同一把鎖（app/.run.lock）。
require('./workspace-lock').acquire('parse-script');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const OUTPUT_PATH = path.join(ROOT, 'src', 'overlays.generated.json');
const TEXT_CARD_PATH = path.join(ROOT, 'src', 'textcards.generated.json');
const VIDEO_META_PATH = path.join(ROOT, 'src', 'video-meta.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

if (!fs.existsSync(SCRIPT_PATH)) {
  console.error('❌ 找不到 ' + SCRIPT_PATH);
  process.exit(1);
}

const scriptRaw = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const bodyAfterVoice = getBodyAfterVoice(scriptRaw);
const cleanedChars = cleanBodyWithIndex(bodyAfterVoice);
// origIdx → cleanedIdx 反查表
const origToCleanedIdx = new Map();
cleanedChars.forEach((c, i) => origToCleanedIdx.set(c.origIdx, i));

const ANCHOR_LEN = 3;
const VALID_POSITIONS = new Set(['top', 'center', 'bottom']);
const VALID_SIZES = new Set(['small', 'medium', 'full']);
const VALID_FLAGS = new Set(['pip', 'nopip', 'noblur']);
const VALID_ANIMS = new Set(['pop', 'shake', 'zoom', 'typewriter', 'slide', 'fade', 'flash', 'highlight']);

function findImageSrc(n) {
  for (const ext of ['.png', '.jpg', '.jpeg', '']) {
    const candidate = 'image' + n + ext;
    if (fs.existsSync(path.join(PUBLIC_DIR, candidate))) return candidate;
  }
  return 'image' + n + '.png';
}

function findLogoSrc() {
  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const candidate = 'logo' + ext;
    if (fs.existsSync(path.join(PUBLIC_DIR, candidate))) return candidate;
  }
  return 'logo.png';
}

// 具名功能截圖：標記名直接當檔名（名字＝APP 功能位置），檔案放 public/
function findShotSrc(name) {
  for (const ext of ['.png', '.jpg', '.jpeg', '']) {
    const candidate = name + ext;
    if (fs.existsSync(path.join(PUBLIC_DIR, candidate))) return candidate;
  }
  return name + '.png';
}

function parseOpts(optsRaw) {
  const result = { position: undefined, size: undefined, flags: new Set(), offsetPx: undefined, widthPx: undefined, heightPx: undefined };
  if (!optsRaw) return result;
  for (const tok of optsRaw.split(',')) {
    const t = tok.trim();
    if (!t) continue;
    const posEq = t.match(/^(top|bottom)=(\d+)$/);
    if (posEq) { result.position = posEq[1]; result.offsetPx = Number(posEq[2]); continue; }
    const wEq = t.match(/^w=(\d+)$/);
    if (wEq) { result.widthPx = Number(wEq[1]); continue; }
    const hEq = t.match(/^h=(\d+)$/);
    if (hEq) { result.heightPx = Number(hEq[1]); continue; }
    if (VALID_POSITIONS.has(t)) result.position = t;
    else if (VALID_SIZES.has(t)) result.size = t;
    else if (VALID_FLAGS.has(t)) result.flags.add(t);
    else console.warn('⚠️  未知選項「' + t + '」（已忽略）');
  }
  return result;
}

/**
 * 把 bodyAfterVoice 上的某個內容範圍 [bodyStart, bodyEnd) 反查成 cleanedIdx 範圍。
 * 回傳 { startCharIdx, endCharIdx, phrase } — startCharIdx/endCharIdx 是 cleanedChars 中第一/最後一個 char 的位置；
 * 找不到任何對應 cleaned char 時回 null。
 */
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

// ─── 收集所有 overlay/textcard 標記，依腳本實際位置排序 ───
// 大小寫不分(i flag),(Logo)/(IMAGE1)/(Shot:...) 都認
const logoPattern = /\(logo\)([\s\S]*?)\(logo\)/gi;
const shotPattern = /\(shot:([^():]+)(?::([a-z0-9,=]+))?\)([\s\S]*?)\(shot:\1\)/gi;
const textPattern = /\(text:([^:)]+)(?::([a-z]+))?(?::(skip))?\)([\s\S]*?)\(\/text\)/gi;

const overlayMatches = [];
for (const m of bodyAfterVoice.matchAll(imagePattern)) {
  overlayMatches.push({ kind: 'image', index: m.index, m });
}
for (const m of bodyAfterVoice.matchAll(logoPattern)) {
  overlayMatches.push({ kind: 'logo', index: m.index, m });
}
for (const m of bodyAfterVoice.matchAll(shotPattern)) {
  overlayMatches.push({ kind: 'shot', index: m.index, m });
}
overlayMatches.sort((a, b) => a.index - b.index);

function buildImageOverlay(m) {
  const n = m[1];
  const optsRaw = m[2];
  const contentBodyStart = m.index + m[0].indexOf(m[3]);
  const contentBodyEnd = contentBodyStart + m[3].length;
  const range = bodyRangeToCleanedRange(contentBodyStart, contentBodyEnd);
  if (!range) {
    console.warn(`⚠️  image${n} 的內容在清洗後沒有任何字元，已跳過`);
    return null;
  }
  const opts = parseOpts(optsRaw);
  const obj = {
    src: findImageSrc(n),
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    // 下面三個欄位純粹給人類讀 JSON 用，timeline.ts 不會用
    startAnchor: range.phrase.slice(0, ANCHOR_LEN),
    endAnchor: range.phrase.slice(-ANCHOR_LEN),
    _phrase: range.phrase,
    pip: !opts.flags.has('nopip'),  // 2026-05-28 加 nopip：講者不縮成右上角小圈圈
  };
  if (opts.position) obj.position = opts.position;
  if (opts.size) obj.size = opts.size;
  if (opts.offsetPx !== undefined) obj.offsetPx = opts.offsetPx;
  if (opts.widthPx !== undefined) obj.widthPx = opts.widthPx;
  if (opts.heightPx !== undefined) obj.heightPx = opts.heightPx;
  // noblur 顯式標 → noBlur:true；nopip 也自動帶 noBlur（語意一致：講者不縮就不該被打霧）
  if (opts.flags.has('noblur') || opts.flags.has('nopip')) obj.noBlur = true;
  return obj;
}

function buildLogoOverlay(m) {
  const contentBodyStart = m.index + m[0].indexOf(m[1]);
  const contentBodyEnd = contentBodyStart + m[1].length;
  const range = bodyRangeToCleanedRange(contentBodyStart, contentBodyEnd);
  if (!range) {
    console.warn('⚠️  logo 的內容在清洗後沒有任何字元，已跳過');
    return null;
  }
  return {
    src: findLogoSrc(),
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    startAnchor: range.phrase.slice(0, ANCHOR_LEN),
    endAnchor: range.phrase.slice(-ANCHOR_LEN),
    _phrase: range.phrase,
    noBlur: true,
    position: 'bottom',
    offsetPx: 445,
    widthPx: 500,
  };
}

function buildShotOverlay(m) {
  const name = m[1];
  const optsRaw = m[2];
  const contentBodyStart = m.index + m[0].indexOf(m[3]);
  const contentBodyEnd = contentBodyStart + m[3].length;
  const range = bodyRangeToCleanedRange(contentBodyStart, contentBodyEnd);
  if (!range) {
    console.warn(`⚠️  shot「${name}」的內容在清洗後沒有任何字元，已跳過`);
    return null;
  }
  const opts = parseOpts(optsRaw);
  const obj = {
    src: findShotSrc(name),
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    startAnchor: range.phrase.slice(0, ANCHOR_LEN),
    endAnchor: range.phrase.slice(-ANCHOR_LEN),
    _phrase: range.phrase,
    pip: true,
  };
  if (opts.position) obj.position = opts.position;
  if (opts.size) obj.size = opts.size;
  if (opts.offsetPx !== undefined) obj.offsetPx = opts.offsetPx;
  if (opts.widthPx !== undefined) obj.widthPx = opts.widthPx;
  if (opts.heightPx !== undefined) obj.heightPx = opts.heightPx;
  if (opts.flags.has('noblur')) obj.noBlur = true;
  return obj;
}

const overlays = overlayMatches
  .map((o) => {
    if (o.kind === 'image') return buildImageOverlay(o.m);
    if (o.kind === 'logo') return buildLogoOverlay(o.m);
    return buildShotOverlay(o.m);
  })
  .filter(Boolean);

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(overlays, null, 2));

const imageCount = overlayMatches.filter((o) => o.kind === 'image').length;
const logoCount = overlayMatches.filter((o) => o.kind === 'logo').length;
const shotCount = overlayMatches.filter((o) => o.kind === 'shot').length;
console.log(`\n✅ 解析完成：${overlays.length} 個 overlay（圖片 ${imageCount} + logo ${logoCount} + 功能截圖 ${shotCount}）`);
console.log(`   寫入 → ${path.relative(ROOT, OUTPUT_PATH)}\n`);
overlays.forEach((o) => {
  console.log(`  ${o.src}`);
  console.log(`     char idx：[${o.startCharIdx}, ${o.endCharIdx}]  位置：${o.position ?? '(預設 center)'}  PIP：${o.pip ? '✅' : '–'}`);
  console.log(`     原句：${o._phrase}\n`);
});

// ─── TextCard 解析 ─────────────────────────────────────
const textCards = [];
for (const m of bodyAfterVoice.matchAll(textPattern)) {
  const text = m[1].trim();
  const anim = VALID_ANIMS.has(m[2]) ? m[2] : 'pop';
  const skip = m[3] === 'skip';
  const contentBodyStart = m.index + m[0].indexOf(m[4]);
  const contentBodyEnd = contentBodyStart + m[4].length;
  const range = bodyRangeToCleanedRange(contentBodyStart, contentBodyEnd);
  if (!range) continue;
  textCards.push({
    text,
    anim,
    skip,
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    startAnchor: range.phrase.slice(0, ANCHOR_LEN),
    endAnchor: range.phrase.slice(-ANCHOR_LEN),
    _phrase: range.phrase,
  });
}
fs.writeFileSync(TEXT_CARD_PATH, JSON.stringify(textCards, null, 2));
console.log(`✅ 文字特效卡：${textCards.length} 個 → ${path.relative(ROOT, TEXT_CARD_PATH)}`);

// ─── 標題寫入 video-meta.json ──────────────────────────
const titleText = getTitleText(scriptRaw);
if (fs.existsSync(VIDEO_META_PATH)) {
  const meta = JSON.parse(fs.readFileSync(VIDEO_META_PATH, 'utf-8'));
  meta.titleText = titleText;
  fs.writeFileSync(VIDEO_META_PATH, JSON.stringify(meta, null, 2));
  console.log(`✅ 標題已寫入 video-meta.json：${titleText}`);
}
