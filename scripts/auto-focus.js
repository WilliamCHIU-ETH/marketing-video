#!/usr/bin/env node
/**
 * 三大法人「自動聚焦」：不用在 script.txt 標注，程式自己看懂旁白該框圖上哪一格。
 *
 * 原理（2026-08-12 用真實腳本＋真實圖驗證過，3 句數據句全中、4 句非數據句正確不觸發）：
 *   1. 旁白裡的數字 → 正規化。口語跟圖上寫法常不一樣：
 *        「441億」  vs 圖上 +440.81   → 容差比對（差 1.5% 內視為同一個）
 *        「8萬9千多」vs 圖上 89,201   → 中文數字轉換
 *   2. 拿正規化後的數字去比對 OCR 抓到的圖上數字（institution-regions.generated.json）。
 *   3. 命中的數字在圖上的 y 座標，落在哪個區塊帶(sec1~4)，就聚焦哪一區、框那一格。
 *   4. 沒有數字的句子（開場/轉折/結論）→ 不觸發，維持講者畫面。
 *
 * 誤判防呆：只認「三位數以上或帶小數點」的數字。否則「近5日」「3個關注重點」這種
 * 順口的小數字會誤中圖上的區塊編號 1/2/3/4。
 *
 * 手動優先：script.txt 若有 (focus:...) 標記，那幾句以標記為準，自動只補其餘句子。
 *
 * 用法：
 *   node scripts/auto-focus.js            # 預覽：印出「哪句 → 聚焦哪區 → 框哪一格」，不寫檔
 *   node scripts/auto-focus.js --write    # 確認無誤後，寫進 institution-focus.generated.json
 */

const fs = require('fs');
const path = require('path');
const { getBodyAfterVoice, cleanBodyWithIndex } = require('./script-utils');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const REGIONS_PATH = path.join(ROOT, 'src', 'Institution', 'institution-regions.generated.json');
const FOCUS_PATH = path.join(ROOT, 'src', 'Institution', 'institution-focus.generated.json');

const WRITE = process.argv.includes('--write');

// 一個聚焦最長停留多久。超過就把後面還給講者。
// 2026-08-18 使用者回報：「投信大賣」的聚焦從 0:09.7 撐到 0:21（11 秒）太久，
// 因為那個長句後面好幾個子句都沒數字、卻一路沿用同一個聚焦。5 秒是安全上限。
const MAX_HOLD_SEC = 5;

// 字幕時間軸（run.js 會先 transcribe 才跑 auto-focus，所以這時 subtitles.json 已存在）。
// 拿來把「停留太久」的聚焦依秒數截斷。讀不到就跳過截斷（不影響出片）。
let CHAR_TIMES = [];
try {
  CHAR_TIMES = require(path.join(ROOT, 'src', 'subtitles.json'))._scriptCharTimes || [];
} catch (_) {}
function secAt(i, which) {
  const t = CHAR_TIMES[i];
  return t ? (which === 'end' ? t.end : t.start) : null;
}

// 只認這種「有意義的數據數字」：三位數以上，或帶小數點（過濾掉 近5日 / 3個重點）
const MIN_INT = 100;
// 容差兩級：精確講出來的數字用嚴格值；帶「約/近/多/破/超過」等模糊詞的用寬鬆值。
// 一律用寬鬆值會誤中隔壁格（實測「7百多億」會撞到 687.71 而不是 731.67）。
const TOLERANCE = 0.015;
const LOOSE_TOLERANCE = 0.06;

function fail(m) {
  console.error('❌ ' + m);
  process.exit(1);
}
if (!fs.existsSync(SCRIPT_PATH)) fail('找不到 public/script.txt');
if (!fs.existsSync(REGIONS_PATH))
  fail('找不到 institution-regions.generated.json，請先跑：npm run analyze:institution');

const regions = JSON.parse(fs.readFileSync(REGIONS_PATH, 'utf-8'));

// 底部「重點」摘要框頂端。框內數字是各表格的四捨五入重複版，比對時要退到最後。
const SUMMARY_TOP = regions.summaryTop || null;

/** 圖上的數字 token（含座標） */
const imgNums = (regions.words || [])
  .filter((w) => /[0-9]/.test(w.t) && w.c >= 40)
  .map((w) => ({
    text: w.t,
    value: parseFloat(String(w.t).replace(/[^0-9.]/g, '').replace(/^\./, '')),
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    // 在底部摘要框裡＝重複的四捨五入值，優先用表格的原值
    //（2026-08-18：外資大買408億 該框表格 +407.88，不是摘要框 407.9）
    inSummary: SUMMARY_TOP != null && w.y >= SUMMARY_TOP,
  }))
  .filter((o) => !isNaN(o.value) && o.value > 0);

/** 中文口語數字 → 數值（8萬9千多 → 89000；1千1百多 → 1100；5百多 → 500） */
function chineseToNumber(s) {
  let m = s.match(/(\d+)萬(\d+)千/);
  if (m) return +m[1] * 10000 + +m[2] * 1000;
  m = s.match(/(\d+)千(\d+)百/);
  if (m) return +m[1] * 1000 + +m[2] * 100;
  m = s.match(/(\d+)萬/);
  if (m) return +m[1] * 10000;
  m = s.match(/(\d+)千/);
  if (m) return +m[1] * 1000;
  m = s.match(/(\d+)百/);
  if (m) return +m[1] * 100;
  m = s.match(/(\d+(?:\.\d+)?)成/); // 3成 → 30%
  if (m) return +m[1] * 10;
  return null;
}

/**
 * 抽出句子裡「值得比對」的數字，並判斷這個數字被講得多精確、往哪個方向估。
 *
 * 為什麼要方向：口語的模糊詞是有方向性的。
 *   「7百多億」代表比 700 大 → 只該往上找（731.67），不該撞到比 700 小的 687.71。
 *   「近9萬口」「將近300」代表比目標小一點 → 只該往下找。
 * 沒有方向性判斷的話，放寬容差就會靜默選錯格（實測「7百多億」會誤中 687.71）。
 *
 * 回傳 [{ value, tol, dir }]：tol=容許誤差，dir=+1只往上/-1只往下/0雙向
 */
function numbersInSentence(raw) {
  const s = raw.replace(/\(focus:[^)]*\)/gi, '');
  const out = [];

  // 精確寫出來的數字（1.59% / 441）→ 容差小
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) {
    const v = parseFloat(m[0]);
    const afterRaw = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
    // 帶 % 的數字即使很小也要放行：「漲逾2%」的 2 本來會被「三位數以上」的門檻擋掉
    //（2026-08-12 使用者案例：櫃買漲逾2% 對不到圖上的 +2.64%）
    if (!(v >= MIN_INT || m[0].includes('.') || /^%/.test(afterRaw))) continue;
    const after = afterRaw;
    const before = s.slice(Math.max(0, m.index - 3), m.index);
    // 單位：旁白寫「2%」就只跟圖上帶 % 的數字比，避免 2 去撞到 2,245 口這種
    const isPct = /^%/.test(after);
    // 開放式語氣：「漲逾2%」「超過9%」「破千億」= 比 N 大的最小值，不是最接近 N 的值。
    // 人看到「漲逾2%」會自然對到 2.64%，但「最接近」比對差 24% 直接放棄（2026-08-12 使用者案例）。
    const openEnded = /逾|超過|破|以上|多/.test(before + after);
    let tol = TOLERANCE;
    let dir = 0;
    if (/多/.test(after)) {
      tol = LOOSE_TOLERANCE;
      dir = 1; // 「441多」比 441 大
    } else if (/約|近|將近|大約|差不多/.test(before)) {
      tol = LOOSE_TOLERANCE;
      dir = /近|將近/.test(before) ? -1 : 0; // 「近300」比 300 小；「約300」兩邊都可能
    } else if (/超過|破|逾/.test(before)) {
      tol = LOOSE_TOLERANCE;
      dir = 1;
    }
    out.push({ value: v, tol, dir, isPct, openEnded });
  }

  // 中文口語數字（8萬9千多 / 5百多 / 3成）→ 一律放寬，並看模糊詞定方向
  const cn = chineseToNumber(s);
  if (cn) {
    let dir = 0;
    if (/多/.test(s)) dir = 1;
    else if (/近|將近/.test(s)) dir = -1;
    else if (/超過|破|逾/.test(s)) dir = 1;
    out.push({ value: cn, tol: LOOSE_TOLERANCE, dir });
  }
  return out;
}

/**
 * 在圖上找符合的數字。回傳 { best, ambiguous }。
 * ambiguous=true 代表有兩個以上候選都很接近 → 不靜默猜，交給人決定。
 */
function matchOnImage(spec) {
  const { value: v, tol, dir, isPct, openEnded } = spec;
  // 單位一致：旁白帶 % 就只跟圖上帶 % 的數字比對
  const pool = isPct ? imgNums.filter((o) => /%/.test(o.text)) : imgNums;

  // 開放式（漲逾2% / 超過9%）→ 取「大於 N 的最小值」，上限 2 倍避免亂抓
  if (openEnded) {
    const above = pool
      .filter((o) => o.value > v && o.value <= v * 2.2)
      .sort((a, b) => a.value - b.value);
    if (above.length) return { ...above[0], diff: 0, ambiguous: false, alts: [] };
  }

  const cands = [];
  for (const o of pool) {
    if (dir > 0 && o.value < v) continue;
    if (dir < 0 && o.value > v) continue;
    const d = Math.abs(o.value - v) / Math.max(o.value, v);
    if (d <= tol) cands.push({ ...o, diff: d });
  }
  if (cands.length === 0) return null;
  // 表格值優先於底部摘要框的重複值：先比 inSummary（表格在前），再比接近度。
  cands.sort((a, b) => (a.inSummary - b.inSummary) || (a.diff - b.diff));
  // 同一格（同數字）重複出現不算歧義；不同數值才算
  const distinct = [...new Set(cands.map((c) => c.value))];
  const ambiguous =
    distinct.length > 1 && cands[0].diff > TOLERANCE && distinct[1] / distinct[0] < 1 + tol * 2;
  return { ...cands[0], ambiguous, alts: distinct.slice(1, 3) };
}

/** 圖上 y 座標 → 屬於哪個區塊 */
function sectionOf(y) {
  for (const [name, band] of Object.entries(regions.sections || {})) {
    if (y >= band.top && y <= band.bottom) return name;
  }
  return null;
}

// ── 讀腳本、切句、對回 cleaned char index（跟字幕時間軸同一套座標）──
const raw = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const body = getBodyAfterVoice(raw);
const cleaned = cleanBodyWithIndex(body);
const origToCleaned = new Map();
cleaned.forEach((c, i) => origToCleaned.set(c.origIdx, i));

function bodyRangeToCleanedRange(start, end) {
  let s = -1;
  let e = -1;
  for (let i = start; i < end; i++) {
    const ci = origToCleaned.get(i);
    if (ci === undefined) continue;
    if (s < 0) s = ci;
    e = ci;
  }
  if (s < 0) return null;
  return { startCharIdx: s, endCharIdx: e };
}

/** 依句號/驚嘆號/換行切句，並記錄每句在 body 裡的位置 */
function splitSentences(text) {
  // 切到「子句」層級（逗號也切），因為一個句子常講到兩個數字：
  //   「今天加權指數上漲了1.59%，櫃買指數也上漲了1.93%」
  // 只用句號切的話只會框到 1.59%，講到櫃買時框沒有跟著走（使用者 2026-08-12 回報）。
  // sentenceId 用來標記同一個句子內的子句，供後面「無數字子句沿用前一個聚焦」用，避免畫面閃。
  const out = [];
  let start = 0;
  let sentenceId = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[。！\n，、；]/.test(ch)) {
      const seg = text.slice(start, i + 1);
      if (seg.trim().length > 1) out.push({ text: seg, start, end: i + 1, sentenceId });
      start = i + 1;
      if (/[。！\n]/.test(ch)) sentenceId++;
    }
  }
  const tail = text.slice(start);
  if (tail.trim().length > 1) out.push({ text: tail, start, end: text.length, sentenceId });
  return out;
}

// ── 手動標記（優先，不覆蓋）──
// 直接從 script.txt 現況解析 (focus:...)，不讀舊的 json：
// 舊 json 可能殘留上一支影片的紀錄，若拿它當「手動」會把這次的自動判定全部擋掉。
const manualOnly = [];
const focusPattern = /\(focus:([^():]+)(?::([^)]*))?\)([\s\S]*?)\(focus:\1\)/gi;
for (const m of body.matchAll(focusPattern)) {
  const contentStart = m.index + m[0].indexOf(m[3]);
  const r = bodyRangeToCleanedRange(contentStart, contentStart + m[3].length);
  if (!r) continue;
  manualOnly.push({
    section: m[1].trim(),
    cellText: (m[2] || '').trim(),
    startCharIdx: r.startCharIdx,
    endCharIdx: r.endCharIdx,
    _phrase: m[3].replace(/\s+/g, '').slice(0, 28),
  });
}
const manualRanges = manualOnly.map((m) => [m.startCharIdx, m.endCharIdx]);
function overlapsManual(r) {
  return manualRanges.some(([a, b]) => r.startCharIdx <= b && r.endCharIdx >= a);
}

// ── 主流程 ──
// 逐「子句」判定。同一句裡若講到兩個數字，框會跟著旁白依序移動；
// 沒有數字的子句若緊接在有聚焦的子句後面（同一句內），沿用前一個聚焦、不切回講者，避免畫面閃。
const clauses = splitSentences(body);
const auto = [];
const preview = [];
let lastFocus = null; // { section, cellText, sentenceId }

for (const s of clauses) {
  const range = bodyRangeToCleanedRange(s.start, s.end);
  if (!range) continue;
  const display = s.text.replace(/\(focus:[^)]*\)/gi, '').replace(/\s+/g, '').slice(0, 26);
  if (!display) continue;

  if (overlapsManual(range)) {
    preview.push({ display, verdict: '（手動標記，維持不動）', skip: true });
    lastFocus = null;
    continue;
  }

  const hits = numbersInSentence(s.text).map(matchOnImage).filter(Boolean);
  const uniq = [...new Map(hits.map((h) => [h.text, h])).values()];

  if (uniq.length === 0) {
    // 無數字：同一句內延續前一個聚焦（框停著），跨句才切回講者
    if (lastFocus && lastFocus.sentenceId === s.sentenceId) {
      const prev = auto[auto.length - 1];
      if (prev) prev.endCharIdx = range.endCharIdx;
      preview.push({ display, verdict: `（延續上一個聚焦 ${lastFocus.cellText}）`, cont: true });
    } else {
      preview.push({ display, verdict: '講者（無數據）' });
      lastFocus = null;
    }
    continue;
  }

  const best = uniq[0];
  const section = sectionOf(best.y + best.h / 2);
  if (!section) {
    preview.push({ display, verdict: `找到 ${best.text} 但不在任何區塊帶內，略過` });
    continue;
  }

  // 跟前一個聚焦完全相同（同區同格）→ 直接延長，不新增一段
  const prev = auto[auto.length - 1];
  if (prev && prev.section === section && prev.cellText === best.text) {
    prev.endCharIdx = range.endCharIdx;
    preview.push({ display, verdict: `（延續 ${best.text}）`, cont: true });
    lastFocus = { section, cellText: best.text, sentenceId: s.sentenceId };
    continue;
  }

  auto.push({
    section,
    cellText: best.text,
    startCharIdx: range.startCharIdx,
    endCharIdx: range.endCharIdx,
    _phrase: display,
    _auto: true,
    _ambiguous: !!best.ambiguous,
  });
  lastFocus = { section, cellText: best.text, sentenceId: s.sentenceId };

  const others = uniq.slice(1).map((u) => u.text);
  const warn = best.ambiguous
    ? `　⚠️ 不確定：也可能是 ${best.alts.join('/')}，建議手動標記確認`
    : '';
  preview.push({
    display,
    ambiguous: !!best.ambiguous,
    verdict:
      `聚焦 ${section} ・ 框「${best.text}」` +
      (others.length ? `（同句另有 ${others.join('/')}）` : '') +
      warn,
  });
}

// ── 前看合併：同一句裡，聚焦前面那幾個「沒數字的子句」也一起併進來 ──
// 否則會出現「最大買家是外資，」切講者 0.8 秒 → 立刻又切回圖 的閃爍。
// 作法：某個聚焦段的起點，往前吃掉同一句、且尚未被其他聚焦佔用的講者子句。
{
  const clauseList = splitSentences(body).map((c) => ({
    ...c,
    range: bodyRangeToCleanedRange(c.start, c.end),
  }));
  for (const f of auto) {
    const idx = clauseList.findIndex((c) => c.range && c.range.startCharIdx === f.startCharIdx);
    if (idx <= 0) continue;
    const sid = clauseList[idx].sentenceId;
    let i = idx - 1;
    while (i >= 0) {
      const c = clauseList[i];
      if (!c.range || c.sentenceId !== sid) break;
      // 已被其他聚焦段涵蓋就停
      const taken = auto.some(
        (o) => o !== f && c.range.startCharIdx >= o.startCharIdx && c.range.startCharIdx <= o.endCharIdx
      );
      if (taken) break;
      if (overlapsManual(c.range)) break;
      f.startCharIdx = c.range.startCharIdx;
      i--;
    }
  }
  auto.sort((a, b) => a.startCharIdx - b.startCharIdx);
}

// ── 停留上限：一個聚焦超過 MAX_HOLD_SEC 就截斷，後面還給講者 ──
// （2026-08-18 使用者：「投信大賣」停 11 秒太久，出現到 ~2 秒後就該結束）
if (CHAR_TIMES.length) {
  for (const f of auto) {
    const s0 = secAt(f.startCharIdx, 'start');
    if (s0 == null) continue;
    const limit = s0 + MAX_HOLD_SEC;
    if ((secAt(f.endCharIdx, 'end') ?? 0) <= limit) continue;
    let cut = f.startCharIdx;
    for (let i = f.startCharIdx; i <= f.endCharIdx; i++) {
      const e = secAt(i, 'end');
      if (e != null && e <= limit) cut = i;
    }
    if (cut > f.startCharIdx) {
      f.endCharIdx = cut;
      f._cappedAt = MAX_HOLD_SEC;
    }
  }
}

// ── 印預覽 ──
console.log('\n📋 自動聚焦預覽（哪一句 → 聚焦哪一區 → 框哪一格）\n');
for (const p of preview) {
  const mark = p.ambiguous ? '⚠️ ' : p.verdict.startsWith('聚焦') ? '🎯' : p.skip ? '✋' : '🎤';
  console.log(`  ${mark} ${p.display}…`);
  console.log(`       ${p.verdict}`);
}
console.log(
  `\n  自動判定 ${auto.length} 句要聚焦、${preview.length - auto.length} 句維持講者/手動。`
);

if (!WRITE) {
  console.log('\n👉 這只是預覽，沒有寫檔。確認無誤後執行：node scripts/auto-focus.js --write');
  console.log('👉 想覆寫某一句，就在 script.txt 那句包上 (focus:區塊:要框的字)…(focus:區塊)，自動會讓位。\n');
} else {
  const merged = [...manualOnly, ...auto].sort((a, b) => a.startCharIdx - b.startCharIdx);
  fs.writeFileSync(FOCUS_PATH, JSON.stringify(merged, null, 2));
  console.log(
    `\n✅ 已寫入 ${path.relative(ROOT, FOCUS_PATH)}（手動 ${manualOnly.length} 句 ＋ 自動 ${auto.length} 句）\n`
  );
}
