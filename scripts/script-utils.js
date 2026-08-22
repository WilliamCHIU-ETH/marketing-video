/**
 * script.txt 共用清洗工具
 *
 * 對 parse-script.js（算 overlay 的 char-index anchor）與 correct-subtitles.js
 * （字幕 forced alignment 對齊）共用同一套清洗邏輯，避免兩邊定義漂走。
 *
 * 兩邊都在 bodyAfterVoice（內文段套完發音替換的字串）上工作；
 * cleanBodyWithIndex 會把每個 cleaned char 對應的 bodyAfterVoice 原始 index 帶回，
 * 讓 parse-script 能用 (imageN) 標記的 body 位置反查 cleaned 位置。
 */

// 2026-08-10 使用者要求：只在「全形」標點（＋換行）斷句；半形不斷句，且數字裡的半形要保留顯示。
//   - BREAK_RE（斷句＋不顯示）：只留全形 ，。、！？：； 與換行 \n。
//   - 數字用的半形 , . %（44,396 / 1.95%）：兩者都不列入下面任何一組 → 會被「保留成一般字元」，
//     既會顯示在字幕上（字幕文字是從對齊到的腳本字元重建的），又因為不在 BREAK_RE 而不會斷行。
//   - OTHER_PUNCT_RE（略過、不顯示、不斷句）：引號/括號/半形 ! ? : ; 與 ／/ 等，維持濾掉。
// 註：半形 , . % 現在會進入 cleaned chars。Whisper 端（correct-subtitles 的 PUNCT_RE）仍會濾掉它們，
//     對齊時它們成為 scriptExtra、由相鄰 word 收納 → 顯示得出、又不破壞 forced alignment。
const BREAK_RE = /[，。、！？：；\n]/;
const OTHER_PUNCT_RE = /[「」『』"'""''【】〔〕（）()\[\]!?:;／/]/;

function parseVoiceRules(scriptRaw) {
  const rules = [];
  const parts = scriptRaw.split('===');
  if (parts.length < 2) return rules;
  for (const line of parts[0].split('\n')) {
    const m = line.match(/^([^#→\n][^→]*)→(.+)$/);
    if (m) rules.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return rules;
}

function applyVoiceRulesForward(text, rules) {
  let out = text;
  for (const rule of rules) {
    out = out.split(rule.from).join(rule.to);
  }
  return out;
}

/**
 * 從 script.txt 取出內文段並套發音替換。
 * 回傳：bodyAfterVoice 字串（保留標記、註解、空白、標點 — 給 parse-script 在上面找 (imageN) 區塊）
 */
function getBodyAfterVoice(scriptRaw) {
  const parts = scriptRaw.split('===');
  const bodyRaw = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? scriptRaw);
  const rules = parseVoiceRules(scriptRaw);
  return applyVoiceRulesForward(bodyRaw, rules);
}

/**
 * 取出 body 前一段作為影片標題。
 * 同時支援歷史三段式（=== title === body）與前台四段式
 *（voice === reserved === title === body）；不可固定拿 parts[1]，否則前台格式會讀到空段。
 */
function getTitleText(scriptRaw) {
  const parts = scriptRaw.split('===');
  return parts.length >= 3
    ? (parts[parts.length - 2] || '').trim()
    : (parts[0] || '').trim();
}

/**
 * 把 bodyAfterVoice 清洗成 cleaned chars，並記錄每個 char 在 bodyAfterVoice 中的原位 origIdx。
 *
 * 清洗動作：
 *  - 移除 (imageN[:opts])、(imageN)、(logo)、(shot:名稱[:opts])、(text:...)、(/text) 標記本身（保留標記內的內容文字）
 *  - 移除 # 註解行、[...] 區塊行
 *  - 把 BREAK_RE（標點 + 換行）標記為「該位置斷句」並跳過
 *  - 跳過 OTHER_PUNCT_RE 與空白
 *
 * 回傳 chars: [{ char, breakAfter, origIdx }]
 */
function cleanBodyWithIndex(bodyAfterVoice) {
  const masked = new Array(bodyAfterVoice.length).fill(false);

  function maskRange(start, len) {
    for (let i = start; i < start + len; i++) masked[i] = true;
  }

  // 標記本身（保留內容）；大小寫不分，(Logo)/(IMAGE1)/(Shot:...) 都認
  for (const m of bodyAfterVoice.matchAll(/\(image\d+(?::[^)]+)?\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(logo\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(shot:[^)]*\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  // 三大法人聚焦標記 (focus:區塊[:高亮字])…(focus:區塊)：標記本身不顯示、不進 TTS/字幕
  for (const m of bodyAfterVoice.matchAll(/\(focus:[^)]*\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(text:[^)]*\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(\/text\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  // 註解 / 區塊行（整行）
  for (const m of bodyAfterVoice.matchAll(/^#.*$/gm)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/^\[.*?\]\s*$/gm)) {
    maskRange(m.index, m[0].length);
  }
  // 雙人模式行首角色標記 [A]/[B]（含前後空白），不影響後面的對話文字
  // 上面那條 ^\[.*?\]\s*$ 只匹配「整行只有 [區塊]」，匹配不到 [A] 文字...
  for (const m of bodyAfterVoice.matchAll(/^[ \t]*\[([AaBb])\][ \t]*/gm)) {
    maskRange(m.index, m[0].length);
  }

  const chars = [];
  for (let i = 0; i < bodyAfterVoice.length; i++) {
    if (masked[i]) continue;
    const ch = bodyAfterVoice[i];
    if (BREAK_RE.test(ch)) {
      // 只剩全形標點與換行會走到這裡（半形 , . ! ? : ; 已移到 OTHER_PUNCT_RE、只略過不斷句），
      // 所以不再需要「小數點兩側是數字就不斷」的特例。
      if (chars.length > 0) chars[chars.length - 1].breakAfter = true;
      continue;
    }
    if (OTHER_PUNCT_RE.test(ch)) continue;
    if (/\s/.test(ch)) continue;
    chars.push({ char: ch, breakAfter: false, origIdx: i });
  }
  return chars;
}

module.exports = {
  BREAK_RE,
  OTHER_PUNCT_RE,
  parseVoiceRules,
  applyVoiceRulesForward,
  getBodyAfterVoice,
  getTitleText,
  cleanBodyWithIndex,
};
