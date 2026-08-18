#!/usr/bin/env node
/**
 * 用 public/script.txt 為真相之源，重組 src/subtitles.json 的字幕文字。
 * 採 forced alignment：Whisper 只供 word-level 時間戳，字幕文字 100% 來自 script.txt
 * （套發音替換後）。
 *
 * 用法：npm run correct-subtitles
 *
 * 流程：
 *   1. script.txt 取內文段 + 套發音替換 + 逐字清洗 → scriptChars（含 origIdx）
 *   2. Whisper 的所有 word.word 串成 whisperText（去標點）
 *   3. Needleman-Wunsch 全域對齊兩條字串
 *   4. 對齊結果 → 建立 scriptChar → whisperWord 映射表
 *      - match / sub：scriptChar 屬於對到的 whisper word
 *      - scriptExtra：附給時間上最近的 whisper word
 *      - whisperExtra：丟棄（Whisper 多打 / 幻覺）
 *   5. 對每個 whisper word，重組 .word = 對到它的所有 scriptChars 串接（缺空字串）
 *   6. 套用 subtitles-replacements.json（fallback，跨 word 安全）
 *   7. 反向發音替換（把「四點三九」還原回「4.39」；跨 word 安全）
 *   8. 額外輸出 _scriptBreaks（強制換幕點）與 _scriptCharTimes（每個 cleaned script char 的時間戳，給 anchor 用）
 *   9. 第一次跑會備份原始字幕到 subtitles.original.json
 */

const fs = require('fs');
const path = require('path');
const {
  parseVoiceRules,
  getBodyAfterVoice,
  cleanBodyWithIndex,
} = require('./script-utils');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const SUBS_PATH = path.join(ROOT, 'src', 'subtitles.json');
const BACKUP_PATH = path.join(ROOT, 'src', 'subtitles.original.json');
const REPLACEMENTS_PATH = path.join(__dirname, 'subtitles-replacements.json');

// ─── 1. 讀檔 ───────────────────────────────────────────
if (!fs.existsSync(SCRIPT_PATH)) {
  console.error(`❌ 找不到 ${SCRIPT_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(SUBS_PATH)) {
  console.error(`❌ 找不到 ${SUBS_PATH}（請先跑 npm run transcribe）`);
  process.exit(1);
}

const scriptRaw = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const subs = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf-8'));

// ─── 2. 清洗腳本 ───────────────────────────────────────
const bodyAfterVoice = getBodyAfterVoice(scriptRaw);
const scriptChars = cleanBodyWithIndex(bodyAfterVoice);
const cleanScriptText = scriptChars.map((c) => c.char).join('');

// ─── 3. 取出 Whisper char 序列（去標點以求對齊乾淨）
const PUNCT_RE = /[，。、！？「」『』"'""''【】〔〕（）()\[\]：；,.!?:;%／/]/;

const whisperChars = [];
for (const seg of subs.segments) {
  if (!seg.words) continue;
  for (const w of seg.words) {
    const wordText = w.word.replace(/\s/g, '');
    for (const ch of wordText) {
      if (PUNCT_RE.test(ch)) continue;
      whisperChars.push({ char: ch, wordRef: w });
    }
  }
}
const whisperText = whisperChars.map((c) => c.char).join('');

// ─── 4. Needleman-Wunsch 全域對齊 ─────────────────────
function align(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
    }
  }
  const pairs = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      pairs.push({ ai: i - 1, bi: j - 1, type: 'match' });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pairs.push({ ai: i - 1, bi: j - 1, type: 'sub' });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      pairs.push({ ai: i - 1, bi: -1, type: 'whisperExtra' });
      i--;
    } else {
      pairs.push({ ai: -1, bi: j - 1, type: 'scriptExtra' });
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

const pairs = align(whisperText, cleanScriptText);

// ─── 5. 建 scriptChar(bi) → whisperWord 映射 ─────────────
// match/sub：直接用對到的 whisperChars[ai].wordRef
// scriptExtra：暫缺，下面用相鄰 scriptChar 的 wordRef 補
const scriptCharToWord = new Array(scriptChars.length).fill(null);
for (const p of pairs) {
  if (p.bi < 0) continue;
  if (p.ai >= 0) scriptCharToWord[p.bi] = whisperChars[p.ai].wordRef;
}
// scriptExtra 用最近的鄰居（向前優先，否則向後）
for (let i = 0; i < scriptChars.length; i++) {
  if (scriptCharToWord[i]) continue;
  for (let j = i - 1; j >= 0; j--) {
    if (scriptCharToWord[j]) { scriptCharToWord[i] = scriptCharToWord[j]; break; }
  }
  if (!scriptCharToWord[i]) {
    for (let j = i + 1; j < scriptChars.length; j++) {
      if (scriptCharToWord[j]) { scriptCharToWord[i] = scriptCharToWord[j]; break; }
    }
  }
}

// ─── 6. 為每個 whisper word 收集對到它的 script chars，重組 .word
const wordToScriptChars = new Map();
for (let i = 0; i < scriptChars.length; i++) {
  const w = scriptCharToWord[i];
  if (!w) continue;
  if (!wordToScriptChars.has(w)) wordToScriptChars.set(w, []);
  wordToScriptChars.get(w).push(scriptChars[i].char);
}

const reports = [];
for (const seg of subs.segments) {
  if (!seg.words) continue;
  for (const w of seg.words) {
    const leading = (w.word.match(/^\s+/) || [''])[0];
    const original = w.word.replace(/\s/g, '');
    const corrected = (wordToScriptChars.get(w) || []).join('');
    if (corrected !== original) {
      reports.push({ time: w.start.toFixed(2) + 's', from: original, to: corrected });
    }
    w.word = leading + corrected;
  }
  seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
}

// ─── 7. _scriptBreaks（強制換幕點）─────────────────────
const breakSet = new Set();
for (let i = 0; i < scriptChars.length; i++) {
  if (!scriptChars[i].breakAfter) continue;
  const w = scriptCharToWord[i];
  if (!w) continue;
  breakSet.add(Number(w.end.toFixed(3)));
}
subs._scriptBreaks = [...breakSet].sort((a, b) => a - b);

// ─── 8. _scriptCharTimes（每個 cleaned script char 的時間戳，給 anchor 用）
subs._scriptCharTimes = scriptChars.map((_, i) => {
  const w = scriptCharToWord[i];
  return w ? { start: w.start, end: w.end } : { start: 0, end: 0 };
});

// ─── 9. 跨 word 替換工具（subtitles-replacements 與反向發音替換共用）
// 跨多個 word 命中時，會：
//   ① 保留 firstWord 中匹配前的字（before-match）
//   ② 保留 lastWord 中匹配後的字（after-match）
//   ③ 把替換字串依字數平均分配到涉及的多個 word（保留 timing — 避免整段字幕擠到第一個 word 的小時段）
function applyCrossWordReplace(words, from, to) {
  if (!from) return;
  let combined = '';
  const charMap = [];
  for (let wi = 0; wi < words.length; wi++) {
    const t = words[wi].word.replace(/^\s+/, '');
    for (let ci = 0; ci < t.length; ci++) {
      combined += t[ci];
      charMap.push({ wordIdx: wi, charIdx: ci });
    }
  }
  let searchFrom = 0;
  while (true) {
    const idx = combined.indexOf(from, searchFrom);
    if (idx < 0) break;
    const end = idx + from.length;
    const firstWordIdx = charMap[idx].wordIdx;
    const lastWordIdx = charMap[end - 1].wordIdx;
    if (firstWordIdx === lastWordIdx) {
      words[firstWordIdx].word = words[firstWordIdx].word.split(from).join(to);
    } else {
      const firstWordCharIdx = charMap[idx].charIdx;
      const lastWordCharIdx = charMap[end - 1].charIdx;
      const firstWordOriginal = words[firstWordIdx].word.replace(/^\s+/, '');
      const lastWordOriginal = words[lastWordIdx].word.replace(/^\s+/, '');
      const firstWordLeading = (words[firstWordIdx].word.match(/^\s+/) || [''])[0];
      const lastWordLeading = (words[lastWordIdx].word.match(/^\s+/) || [''])[0];
      const beforeMatch = firstWordOriginal.slice(0, firstWordCharIdx);
      const afterMatch = lastWordOriginal.slice(lastWordCharIdx + 1);

      // 如果 beforeMatch 不是空（firstWord 開頭有非匹配字），讓 beforeMatch 獨佔 firstWord：
      // 這樣斷句點落在 firstWord 之後的話，beforeMatch 跟替換字串就會被分到不同 phrase。
      // 反之亦然：afterMatch 不空 → lastWord 結尾的 afterMatch 留著、replacement 不擠進去。
      // 替換字串只分配到「真正承載 match 的 word」(recipientStart..recipientEnd)。
      const recipientStart = beforeMatch ? firstWordIdx + 1 : firstWordIdx;
      const recipientEnd = afterMatch ? lastWordIdx - 1 : lastWordIdx;

      if (beforeMatch) words[firstWordIdx].word = firstWordLeading + beforeMatch;
      if (afterMatch) words[lastWordIdx].word = lastWordLeading + afterMatch;

      const recipientCount = recipientEnd - recipientStart + 1;
      if (recipientCount >= 1) {
        const toLen = to.length;
        for (let i = 0; i < recipientCount; i++) {
          const wi = recipientStart + i;
          const sliceStart = Math.floor((i * toLen) / recipientCount);
          const sliceEnd = Math.floor(((i + 1) * toLen) / recipientCount);
          const piece = to.slice(sliceStart, sliceEnd);
          // recipient 範圍內如果剛好是 firstWord 或 lastWord，要保留它原本要保留的部分
          let pre = '';
          let post = '';
          let leading;
          if (wi === firstWordIdx) {
            leading = firstWordLeading;
            pre = beforeMatch;
          } else if (wi === lastWordIdx) {
            leading = lastWordLeading;
            post = afterMatch;
          } else {
            leading = (words[wi].word.match(/^\s+/) || [''])[0];
          }
          words[wi].word = leading + pre + piece + post;
        }
      } else {
        // recipient 範圍空（before 跟 after 把所有 word 都佔了）— 沒地方放 replacement
        // 為了不丟字，把整段 replacement 塞回 lastWord 開頭（壓在 afterMatch 之前）
        words[lastWordIdx].word = lastWordLeading + to + afterMatch;
      }
    }
    combined = combined.slice(0, idx) + to + combined.slice(end);
    const newChars = to.split('').map(() => ({ wordIdx: firstWordIdx, charIdx: 0 }));
    charMap.splice(idx, from.length, ...newChars);
    searchFrom = idx + to.length;
  }
}

// ─── 10. 反向發音替換（先跑，當權威來源 — 例：「百分之四點三九 → 4.39%」）
// 順序重要：反向發音替換代表 script.txt 作者的意圖，要比 subtitles-replacements（fallback）優先觸發。
// 若 fallback 先跑，會把「四點三九」攔截成「4.39」，讓反向規則的「百分之四點三九 → 4.39%」失效。
const voiceRules = parseVoiceRules(scriptRaw);
for (const seg of subs.segments) {
  if (!seg.words) continue;
  for (const rule of voiceRules) {
    applyCrossWordReplace(seg.words, rule.to, rule.from);
  }
  seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
}

// ─── 11. 套 subtitles-replacements（fallback；反向規則沒處理到的才會用）
if (fs.existsSync(REPLACEMENTS_PATH)) {
  const replacements = JSON.parse(fs.readFileSync(REPLACEMENTS_PATH, 'utf-8'));
  for (const seg of subs.segments) {
    if (!seg.words) continue;
    for (const rule of replacements) {
      applyCrossWordReplace(seg.words, rule.from, rule.to);
    }
    seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
  }
  console.log(`🔄 套用 ${replacements.length} 條自訂替換規則（fallback）`);
}

// ─── 12. 備份 + 寫回 ───────────────────────────────────
if (!fs.existsSync(BACKUP_PATH)) {
  fs.writeFileSync(BACKUP_PATH, fs.readFileSync(SUBS_PATH, 'utf-8'));
  console.log(`📦 備份原始字幕 → ${path.relative(ROOT, BACKUP_PATH)}`);
}
fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2));

// ─── 13. 報告 ──────────────────────────────────────────
console.log(`\n✅ Forced alignment 完成！共重組 ${reports.length} 個 whisper word：\n`);
for (const r of reports.slice(0, 40)) {
  console.log(`  ${r.time}  ${r.from || '(空)'}  →  ${r.to || '(空)'}`);
}
if (reports.length > 40) console.log(`  ... 還有 ${reports.length - 40} 筆`);
console.log(`\n📌 ${subs._scriptBreaks.length} 個強制換幕點 / ${subs._scriptCharTimes.length} 個 script char 時間戳`);
console.log(`   字幕已寫回 → ${path.relative(ROOT, SUBS_PATH)}\n`);
console.log(`   想還原？刪掉 subtitles.json 改名 subtitles.original.json → subtitles.json\n`);
