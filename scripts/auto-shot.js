#!/usr/bin/env node
/**
 * 自動決定「哪一段旁白該配哪一張截圖」——不用在 script.txt 標 (shot:)。
 *
 * 資料來源：src/app-images.generated.json（由 analyze-app-images.js 產出，含每張圖的
 * 頁面類型、股名、股票代號、逐字框）。配對方式，由強到弱：
 *   ① 股名：旁白這段提到「健鼎」→ 配 stockName=健鼎 的那張
 *   ② 股票代號：旁白出現 3044
 *   ③ 頁面關鍵字：講到「精選 / 排行 / 自選股」→ 配 focus-list 那張；「營收」→ revenue…
 *   ④ 圖上數字：旁白的數字出現在該圖的 OCR 逐字框裡（例：98.22 只出現在健鼎營收頁）
 * 一張圖只用在最早提到它的那一段；同一段命中多張時取分數最高。
 *
 * 手寫 (shot:名稱)…(shot:名稱) 優先：腳本裡已經有標記就完全照你的，不自動覆蓋。
 *
 * 用法：
 *   node scripts/auto-shot.js           # 預覽
 *   node scripts/auto-shot.js --write   # 寫入 <Template>-shots.generated.json
 *   （--out 指定輸出檔，預設 src/Focusstock/focusstock-shots.generated.json）
 */
const fs = require('fs');
const path = require('path');
const { getBodyAfterVoice, cleanBodyWithIndex } = require('./script-utils');

// 圖片只在「這一句真的講到對應內容」時出現（2026-08-12 使用者定案：
// 不用時間硬切，而是靠語意相關性）。判斷方式：這個子句要嘛自己配到圖，
// 要嘛在同一主題段落內、且能在圖上找到對應的數字或欄位。找不到就回講者。

// ── 呈現規則（2026-08-12 依使用者手動標記歸納）──
//   「(image4做滑動因為從講到南電開始的資訊在圖片下方)」→ 目標在下半部就滑動
//   「(image2做滑動因為圖維持蠻久沒動很無聊)」        → 停太久就滑動
//   「image1其實沒有亂圈！算是表現最好了」            → 明確數字接連命中時的快速換框是好的，
//                                                     不要合併、也不要改成滑動
const MIN_BOX_SEC = 2.5;          // 併入後方滑動段的門檻（只用在「短暫的鋪陳段」）
const MIN_SHOT_SEC = 1.4;         // 一般情況：一張圖至少停這麼久，否則閃一下就換
const MIN_ENUM_SEC = 0.8;         // 同一句裡的列舉例外：「南亞科、華邦電、友達群創」整句只有 3.3 秒，
                                  // 要塞四檔就是每張 0.83 秒。用 1.4 秒去卡會直接丟掉兩張圖，
                                  // 但使用者更不能接受「圖沒出現」。所以同句列舉放寬到 0.8 秒。
                                  // （這是取捨，不是最佳解 —— 覺得太快就在審核頁把時間改長。）
const PAN_IF_LONGER_SEC = 8;      // 一段超過這麼久還定格 → 改滑動
const MAX_SHOT_SEC = 10;          // 一張圖最長就停這麼久，超過直接截斷回講者
                                  //（使用者兩次回報「停留太久」）
const PAN_IF_TARGET_BELOW = 0.5;  // 「概括型目標」（欄位/清單）中心低於此比例 → 改滑動

const ROOT = path.resolve(__dirname, '..');
// --script=路徑：讓前台指定要讀哪一份腳本（標注頁在 HeyGen 還在跑的時候就要用，
// 那時候 public/script.txt 可能是別人的工作）。沒給就照舊讀 public/script.txt。
const scriptArg = process.argv.find((a) => a.startsWith('--script='));
const SCRIPT_PATH = scriptArg
  ? path.resolve(scriptArg.slice('--script='.length))
  : path.join(ROOT, 'public', 'script.txt');
// --sentences：只吐「句子清單」就結束，不需要字幕時間軸也不需要圖片分析。
// 給前台的標注頁用 —— 句子怎麼切一定要由這支決定，前台自己切一套就會對不上。
const SENTENCES_ONLY = process.argv.includes('--sentences');
const IMAGES_PATH = path.join(ROOT, 'src', 'app-images.generated.json');
const LOCATORS_PATH = path.join(ROOT, 'scripts', 'app-locators.json');
const WRITE = process.argv.includes('--write');
const outArg = process.argv.indexOf('--out');
const OUT_PATH = outArg >= 0
  ? path.resolve(process.argv[outArg + 1])
  : path.join(ROOT, 'src', 'Focusstock', 'focusstock-shots.generated.json');

// 頁面類型 → 旁白裡可能出現的字眼。
// ⚠️ 單一來源：直接由規則庫 scripts/app-locators.json 的 regions 推導，
// 不再另外維護一份。（2026-08-12 踩到：兩份清單沒同步，改了規則庫卻沒生效。）
function buildPageKeywords(regions) {
  const out = {};
  for (const [page, list] of Object.entries(regions || {})) {
    const set = new Set();
    for (const rg of list) (rg.keywords || []).forEach((k) => set.add(k));
    out[page] = [...set];
  }
  return out;
}

function fail(m) { console.error('❌ ' + m); process.exit(1); }
if (!fs.existsSync(SCRIPT_PATH)) fail('找不到 public/script.txt');
if (!SENTENCES_ONLY && !fs.existsSync(IMAGES_PATH))
  fail('找不到 src/app-images.generated.json，請先跑：npm run analyze:app-images');

const imgs = fs.existsSync(IMAGES_PATH)
  ? (JSON.parse(fs.readFileSync(IMAGES_PATH, 'utf-8')).images || [])
  : [];

// 各頁面的「重點區域」定義（scripts/app-locators.json 的 regions）
let REGIONS = {};
try { REGIONS = JSON.parse(fs.readFileSync(LOCATORS_PATH, 'utf-8')).regions || {}; } catch (_) {}
const PAGE_KEYWORDS = buildPageKeywords(REGIONS);

// 字幕時間軸
let CHAR_TIMES = [];
try {
  CHAR_TIMES = require(path.join(ROOT, 'src', 'subtitles.json'))._scriptCharTimes || [];
} catch (_) {}
function secAt(i, which) {
  const t = CHAR_TIMES[i];
  return t ? (which === 'end' ? t.end : t.start) : null;
}
function durationOf(a, b) {
  const s0 = secAt(a, 'start');
  const e0 = secAt(b, 'end');
  return s0 != null && e0 != null ? e0 - s0 : null;
}
if (imgs.length === 0) fail('app-images.generated.json 裡沒有圖片');

const raw = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const body = getBodyAfterVoice(raw);
const cleaned = cleanBodyWithIndex(body);
const map = new Map();
cleaned.forEach((c, i) => map.set(c.origIdx, i));
function toCleaned(a, b) {
  let s = -1, e = -1;
  for (let i = a; i < b; i++) {
    const ci = map.get(i);
    if (ci === undefined) continue;
    if (s < 0) s = ci;
    e = ci;
  }
  return s < 0 ? null : { startCharIdx: s, endCharIdx: e };
}

// ── 手寫標記優先（兩種都認）──
// 使用者要保留原本的手動方式，所以自動配圖絕不覆蓋人工標記的段落：
//   (shot:名稱)…(shot:名稱)    大盤小報／焦點股用的全螢幕截圖標記
//   (imageN[:位置,大小])…(imageN)  投廣模板用的子母畫面 overlay 標記
// 兩者標到的區間都視為「已由人決定」，自動只補其餘沒標的段落。
const manual = [];
for (const m of body.matchAll(/\(shot:([^():]+)(?::([^)]*))?\)([\s\S]*?)\(shot:\1\)/gi)) {
  const cs = m.index + m[0].indexOf(m[3]);
  const r = toCleaned(cs, cs + m[3].length);
  if (r) manual.push({ src: m[1] + '.png', ...r, _manual: true });
}
for (const m of body.matchAll(/\((image\d+)(?::[^)]*)?\)([\s\S]*?)\(\1(?::[^)]*)?\)/gi)) {
  const cs = m.index + m[0].indexOf(m[2]);
  const r = toCleaned(cs, cs + m[2].length);
  if (r) manual.push({ src: m[1] + '.png', ...r, _manual: true, _overlay: true });
}


/**
 * 找出「這段旁白講到、而且圖上真的有」的目標，回傳它在圖上的框。
 * 優先順序：① 數字（98.22 / 22.7）② 關鍵詞（融資、融券…找表頭）
 * 數字取最長的那個，避免框到不相干的小數字。
 */
/** 從旁白讀「連N日／連三個月」的 N。阿拉伯數字與中文數字都認，上限 12 列避免框過大。 */
function countFromText(text) {
  const CN = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const unit = '(?:日|天|個月|月|週|周|季)';
  let m = text.match(new RegExp('連(?:續)?\\s*(\\d+)\\s*' + unit));
  if (m) return Math.min(parseInt(m[1], 10), 12);
  m = text.match(new RegExp('連(?:續)?\\s*([一二兩三四五六七八九十]+)\\s*' + unit));
  if (m) {
    const t = m[1];
    let n;
    if (t === '十') n = 10;
    else if (t.length === 2 && t[0] === '十') n = 10 + (CN[t[1]] || 0);
    else if (t.length === 2 && t[1] === '十') n = (CN[t[0]] || 0) * 10;
    else n = CN[t] || 0;
    if (n > 0) return Math.min(n, 12);
  }
  return 0;
}

function findCell(text, img) {
  const words = (img.words || []).filter((w) => w.c >= 40);
  // ① 數字：用「數值」比對而不是字串，因為 App 常把 22.74% 顯示成 22.7、56.55 顯示成 56.5。
  //    容差 1.5%（等同四捨五入到小數第一位的誤差範圍）。
  const wordVals = words
    .map((w) => ({ w, v: parseFloat(String(w.t).replace(/,/g, '').replace(/[^0-9.]/g, '')) }))
    .filter((o) => !isNaN(o.v) && o.v > 0);
  // 千分位逗號要一起吃進來，否則「45,518」會被拆成 45 和 518（2026-08-12 實際踩到）。
  // 小數也要放行：漲幅 0.88% 這種小於 10 的數字同樣是重點。
  const nums = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0].replace(/,/g, '')))
    .filter((v) => v > 0 && (v >= 10 || String(v).includes('.')))
    .sort((a, b) => b - a);
  for (const n of nums) {
    const hits = wordVals
      .map((o) => ({ ...o, d: Math.abs(o.v - n) / Math.max(o.v, n) }))
      .filter((o) => o.d <= 0.015)
      .sort((a, b) => a.d - b.d || b.w.c - a.w.c);
    if (hits.length) {
      const w = hits[0].w;
      return { cell: { x: w.x, y: w.y, w: w.w, h: w.h }, cellText: w.t };
    }
  }
  // ② 頁面重點區域：講到「融資」這種沒有明確數字的說法時，把該頁面對應的欄位捲上來。
  //    區域定義在 scripts/app-locators.json 的 regions，用 OCR 找得到的欄位標題當錨點
  //    （不寫死座標）。這是讓「未來不用再客製」的關鍵：領域知識寫在規則庫裡一次就好。
  const H = img.height || 2622;
  const IW = img.width || 1206;
  for (const rg of REGIONS[img.page] || []) {
    if (!rg.keywords.some((k) => text.includes(k))) continue;
    // box 型別：OCR 讀不出欄位標題時改用相對比例（0~1）框住區域。
    // 例：大盤頁三個指數磚，OCR 只認得出「指數」兩字、分不出加權/櫃買/台指。
    if (rg.box) {
      const [x0, y0, x1, y1] = rg.box;
      return {
        cell: {
          x: Math.round(x0 * IW),
          y: Math.round(y0 * H),
          w: Math.round((x1 - x0) * IW),
          h: Math.round((y1 - y0) * H),
        },
        cellText: rg.name,
        region: rg.name,
        isColumn: false,
      };
    }
    // OCR 常把「融資餘額」拆成「融資」「餘額」兩框，所以錨點也接受前兩個字。
    // 先找圖片下半部（走勢圖底下的資料表），找不到再放寬到整張。
    const short = rg.anchor.slice(0, 2);
    let hits = words.filter((w) => w.t.includes(rg.anchor) && w.y > H * 0.35);
    if (!hits.length) hits = words.filter((w) => w.t.includes(short) && w.y > H * 0.35);
    if (!hits.length) hits = words.filter((w) => w.t.includes(rg.anchor));
    if (!hits.length) hits = words.filter((w) => w.t.includes(short));
    if (!hits.length) continue;
    // near：同一列右側附近要出現的字，用來分辨同名欄位
    //（OCR 把「融資餘額」「融資增減」都只認出「融資」，靠右邊的「餘」/「增」才分得開）
    if (rg.near) {
      const withNear = hits.filter((h) =>
        words.some(
          (w) =>
            w.t.includes(rg.near) &&
            Math.abs(w.y - h.y) < h.h * 1.2 &&
            w.x > h.x &&
            w.x - h.x < IW * 0.18
        )
      );
      if (withNear.length) hits = withNear;
      else continue; // 這個頁面沒有這一欄，換下一條規則
    }
    const a = hits.sort((a2, b2) => a2.y - b2.y)[0];

    // ── 混合模式（2026-08-12 使用者定案）──
    // 沒有明確數字時，框的不是「欄位標題那幾個字」（沒意義），而是「整欄」：
    // 從標題往下抓同一 x 範圍內的前幾列資料，用它們的外框當高亮區。
    // 列高由資料本身決定，所以不同頁面／不同機型都適用，不必寫死。
    // 列數：優先用旁白講的數量（「連9日增加」「連三個月成長」→ 框 9 列 / 3 列），
    // 沒講就用規則預設。這樣「連續九日都是紅的」才會整片被框起來（2026-08-12 使用者回報）。
    // 阿拉伯數字與中文數字都認（腳本常寫「連兩日」「連三個月」）。
    const rows = countFromText(text) || rg.rows || 3;
    const cx = a.x + a.w / 2;
    const halfW = Math.max(a.w / 2 + IW * 0.02, IW * 0.085);
    const below = words
      .filter((w) => w.y > a.y + a.h * 0.5 && Math.abs(w.x + w.w / 2 - cx) < halfW)
      .sort((p1, p2) => p1.y - p2.y);
    // 依 y 分列，取前 rows 列
    const picked = [];
    let lastY = -1;
    for (const w of below) {
      if (lastY < 0 || w.y - lastY > a.h * 0.6) {
        picked.push(w);
        lastY = w.y;
        if (picked.length >= rows) break;
      }
    }
    const all = [a, ...picked];
    const x0 = Math.min(...all.map((w) => w.x));
    const x1 = Math.max(...all.map((w) => w.x + w.w));
    const y0 = a.y;
    const y1 = Math.max(...all.map((w) => w.y + w.h));
    return {
      cell: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      cellText: rg.name,
      region: rg.name,
      isColumn: true,
      wholePage: !!rg.wholePage,
    };
  }

  // ③ 找不到更具體的目標 → 框「頁面標題」（族群名／股名），讓觀眾至少知道在看什麼。
  //    使用者定案：「找不到更具體的目標就顯示標題吧，像是 PCB族群頁 / 材料族群頁」。
  if (img.topicBox) {
    const b = img.topicBox;
    const padX = Math.round(IW * 0.03);
    const padY = Math.round(b.h * 0.35);
    return {
      cell: { x: b.x - padX, y: b.y - padY, w: b.w + padX * 2, h: b.h + padY * 2 },
      cellText: (img.topic || '標題') + (img.isStockPage ? '（框股名）' : '（頁面標題→滑動）'),
      region: 'title',
      isColumn: false,
      // pan：從標題開始、慢慢往下滑過內容。找不到具體目標時，
      // 與其定格在標題，不如把整頁帶過去讓觀眾看到全貌（2026-08-12 使用者提議）。
      // ⚠️ 只有清單／族群／未知頁才滑動。個股頁的「標題」＝最上面的股名那一列，
      //   列舉句（「南亞科、」「友達」）常常只有 1~2 秒，滑動根本來不及、只會晃一下
      //   （2026-08-13）。個股頁就乾脆定格框住股名。
      pan: !img.isStockPage,
    };
  }

  // ④ 再退一步：該頁面的第一個區域。
  //    否則會變成整張顯示 —— 橫式尤其不能這樣（使用者：「橫式怎麼還是會出現整張圖」）。
  //    有 wholePage 的頁面（清單頁 CTA）例外，那本來就該整張看。
  const primary = (REGIONS[img.page] || [])[0];
  if (primary && !primary.wholePage && primary.box) {
    const [x0, y0, x1, y1] = primary.box;
    return {
      cell: {
        x: Math.round(x0 * IW), y: Math.round(y0 * H),
        w: Math.round((x1 - x0) * IW), h: Math.round((y1 - y0) * H),
      },
      cellText: primary.name, region: primary.name, isColumn: false,
    };
  }
  if (primary && !primary.wholePage && primary.anchor) {
    const short = primary.anchor.slice(0, 2);
    let hits = words.filter((w) => w.t.includes(primary.anchor));
    if (!hits.length) hits = words.filter((w) => w.t.includes(short));
    if (hits.length) {
      const a = hits.sort((x, y) => x.y - y.y)[0];
      const rows = primary.rows || 3;
      const cx = a.x + a.w / 2;
      const halfW = Math.max(a.w / 2 + IW * 0.02, IW * 0.085);
      const below = words
        .filter((w) => w.y > a.y + a.h * 0.5 && Math.abs(w.x + w.w / 2 - cx) < halfW)
        .sort((p1, p2) => p1.y - p2.y);
      const picked = [];
      let lastY = -1;
      for (const w of below) {
        if (lastY < 0 || w.y - lastY > a.h * 0.6) {
          picked.push(w);
          lastY = w.y;
          if (picked.length >= rows) break;
        }
      }
      const all = [a, ...picked];
      return {
        cell: {
          x: Math.min(...all.map((w) => w.x)),
          y: a.y,
          w: Math.max(...all.map((w) => w.x + w.w)) - Math.min(...all.map((w) => w.x)),
          h: Math.max(...all.map((w) => w.y + w.h)) - a.y,
        },
        cellText: primary.name,
        region: primary.name,
        isColumn: true,
      };
    }
  }
  return null;
}

/**
 * 一張圖所有可能的股名寫法：主要股名 ＋ analyze 給的候選（含去掉左邊雜字的版本）。
 * 長的排前面 —— 「南亞科」比「亞科」精確，先試長的。
 */
function namesOf(img) {
  const list = [img.stockName, ...(img.stockNameAlts || [])].filter(Boolean);
  return [...new Set(list)].sort((a, b) => b.length - a.length);
}

/**
 * 股名比對，回傳實際命中的那個寫法（沒中回 null）。
 *
 * 兩種 OCR 錯誤要分開處理：
 *  ① 左邊多吃一個字（友達 → 性友達）：analyze 已經把「去掉左邊 N 字」的版本一起存進
 *     stockNameAlts，這裡逐一比對 —— 腳本裡出現哪個，哪個就是真的。
 *     不在 analyze 階段猜，是因為「南亞科 → 亞科」砍了會更錯，只有腳本分得出來。
 *  ② 中間讀錯一個字（華邦電 → 華邦埋／華邦雷）：候選裡沒有正確寫法，只能模糊比對。
 *     3 個字以上才容許差 1 字；2 個字不放寬（群創/群益、台光/台泥 只差一字，會配到別檔）。
 * （2026-08-13 華邦電、2026-08-17 友達，各踩過一次，兩次都是整張圖沒被用到）
 */
function nameMatch(text, img) {
  const names = typeof img === 'string' ? [img] : namesOf(img);
  for (const n of names) if (text.includes(n)) return n;      // ① 精確（含去雜字版本）
  const main = names.find((n) => n.length >= 3);              // ② 模糊，只對最長的那個
  if (!main) return null;
  for (let i = 0; i + main.length <= text.length; i++) {
    const seg = text.slice(i, i + main.length);
    if (!/^[一-鿿]+$/.test(seg)) continue;
    let diff = 0;
    for (let k = 0; k < main.length; k++) if (seg[k] !== main[k]) diff++;
    if (diff === 1) return seg;
  }
  return null;
}

function scoreImage(text, img) {
  let sc = 0; const why = [];
  const nameHit = img.stockName ? nameMatch(text, img) : null;
  if (nameHit) { sc += 10; why.push('股名' + nameHit); }
  // 族群頁靠「主題」分辨（材料／散熱／PCB…），權重比照股名，
  // 否則三張長得一樣的族群頁會全部配到同一張。
  // 排行頁的主題是 OCR 讀左側反白格得來的，可能夾雜雜字（「噴發向上」→「噴發還向上」），
  // 所以整串比對之外，也接受 topicTerms 裡任一個詞命中。
  const topicHit =
    (img.topic && text.includes(img.topic)) ||
    (img.topicTerms || []).find((t) => text.includes(t));
  if (topicHit) { sc += 10; why.push('主題' + (typeof topicHit === 'string' ? topicHit : img.topic)); }
  if (img.stockCode && text.includes(img.stockCode)) { sc += 6; why.push('代號' + img.stockCode); }
  const kws = PAGE_KEYWORDS[img.page] || [];
  const hitKw = kws.filter((k) => text.includes(k));
  if (hitKw.length) { sc += 3 * hitKw.length; why.push('關鍵字' + hitKw.join('/')); }
  // 同樣支援千分位；比對時兩邊都去掉逗號，圖上可能寫 45518.07、旁白寫 45,518
  const nums = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => m[0].replace(/,/g, ''))
    .filter((n) => n.replace('.', '').length >= 3);
  const numHit = nums.filter((n) =>
    (img.words || []).some((w) => w.t.replace(/,/g, '').includes(n))
  );
  if (numHit.length) { sc += 2 * numHit.length; why.push('數字' + numHit.join('/')); }
  return { sc, why };
}

// ── 切「子句」──（逗號也切）
// 一段話常連講三個數字：「營收98.22億元，月增22.74%、年增56.55%」。
// 只切到段落層級的話，黃框會卡在第一個數字不動（2026-08-12 使用者回報）。
const clauses = [];
{
  // blk = 主題段落（以「空行」分隔）。同一主題可能跨好幾行，例如金居那段：
  //   金居則是籌碼訊號值得關注。/ 融資連9日增加…。/ HVLP4高頻銅箔…。
  // 圖要在整個主題段落內持續顯示，到空行才收掉（使用者要求「講完那段就消失」）。
  let st = 0, sid = 0, blk = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    // 段落只拿來當參考，不當判準 —— 真正的界線是「句子」，見下方主迴圈。
    //（2026-08-17 我一度改成「換行就換段」來救圖黏太久，被使用者指出方向錯了：
    //   「不能看段行啊！是要看句子判讀」。段落結構會因為貼上方式不同而消失，
    //   句子不會。已撤回。）
    if (ch === '\n' && /^[ \t]*\n/.test(body.slice(i + 1))) blk++;
    if (/[。！\n，、；]/.test(ch)) {
      const t = body.slice(st, i + 1);
      if (t.trim().length > 1) clauses.push({ text: t, start: st, end: i + 1, sid, blk, u: clauses.length });
      st = i + 1;
      if (/[。！\n]/.test(ch)) sid++;
    }
  }
  if (body.slice(st).trim().length > 1)
    clauses.push({ text: body.slice(st), start: st, end: body.length, sid, blk, u: clauses.length });
}

// ── 句子清單（--sentences）──
// 由上面的 clauses 依 sid 聚合而成，所以「前台看到的句子」跟「配圖用的句子」
// 一定是同一套切法。標注頁存的是 sentence 編號，下面就靠這個編號還原字元範圍。
const SENTENCES = [];
for (const c of clauses) {
  const cur = SENTENCES[c.sid];
  if (!cur) SENTENCES[c.sid] = { i: c.sid, text: c.text, start: c.start, end: c.end };
  else { cur.text += c.text; cur.end = c.end; }
}
const sentenceList = SENTENCES
  .filter(Boolean)
  .map((x) => ({ i: x.i, text: x.text.replace(/\s+/g, '').replace(/\(shot:[^)]*\)/gi, ''), start: x.start, end: x.end }))
  .filter((x) => x.text.length > 1);

// 子句清單：比句子細，讓前台可以「從這裡拉到那裡」選一個範圍
//（2026-08-17 使用者：給我選擇的句子太不靈活了，要像訂房網站選日期一樣拉範圍）
// ⚠️ 用拆分前的子句索引 c.u。--sentences 模式沒有圖片資料、不會做列舉拆分，
// 用陣列位置當索引兩邊就會對不上。
const unitList = clauses.map((c) => {
  // 一併算出「清洗後的字元索引」——伺服器只要照 from/to 取頭尾就好，
  // 不必自己重做一套字元對位（那會是第二份實作、遲早漂走）。
  const r = toCleaned(c.start, c.end);
  return {
    i: c.u,
    sid: c.sid,
    text: c.text.replace(/\(shot:[^)]*\)/gi, '').replace(/\s+/g, ''),
    start: c.start,
    end: c.end,
    startCharIdx: r ? r.startCharIdx : null,
    endCharIdx: r ? r.endCharIdx : null,
  };
}).filter((u) => u.text.length > 0);

if (SENTENCES_ONLY) {
  // chars = 逐字清單（清洗後的字元索引）。
  // 前台讓人用滑鼠「拖選文字」來指定範圍，存的就是這裡的 i ——
  // 中間不再經過「子句」這層轉換，也才能處理「一句話要配兩張圖」
  //（例：友達群創雙漲停。是一個子句，卻要分給兩張截圖）。
  // b=1 表示這個字後面是標點或換行，前台用來排版斷行。
  const chars = cleaned.map((c, i) => ({ i, c: c.char, b: c.breakAfter ? 1 : 0 }));
  console.log(JSON.stringify({
    sentences: sentenceList.map(({ i, text }) => ({ i, text })),
    units: unitList.map(({ i, sid, text, startCharIdx, endCharIdx }) =>
      ({ i, sid, text, startCharIdx, endCharIdx })),
    chars,
  }, null, 2));
  process.exit(0);
}

// ── 手動標注（前台標注頁產生的 public/annotations.json）──
// 跟腳本裡手寫的 (shot:) 標記走同一條路：被標到的句子，自動判定完全不碰。
// 差別是標注頁還帶了「框在哪」與「要不要滑動」，手寫標記做不到這兩件事。
{
  const AP = path.join(ROOT, 'public', 'annotations.json');
  if (fs.existsSync(AP)) {
    let ann = [];
    try { ann = JSON.parse(fs.readFileSync(AP, 'utf-8')).shots || []; } catch (_) {}
    for (const a of ann) {
      if (!a.src) continue;
      // 範圍：新格式用 from/to 指子句範圍；舊格式 sentence 指整句（往後相容）
      // 新格式：直接給清洗後的字元索引（前台拖選文字得到的），最精準
      if (typeof a.startCharIdx === 'number' && typeof a.endCharIdx === 'number') {
        const img0 = imgs.find((m) => m.file === a.src) || {};
        const hasCell0 = a.cell && a.cell.w > 0;
        const hasRegion0 = a.region && a.region.w > 0;
        manual.push({
          src: a.src,
          startCharIdx: Math.min(a.startCharIdx, a.endCharIdx),
          endCharIdx: Math.max(a.startCharIdx, a.endCharIdx),
          phrase: cleaned.slice(Math.min(a.startCharIdx, a.endCharIdx),
            Math.max(a.startCharIdx, a.endCharIdx) + 1).map((c) => c.char).join(''),
          _manual: true, _annotated: true,
          page: img0.page, imageWidth: img0.width, imageHeight: img0.height,
          ...(hasCell0 ? { cell: a.cell, cellText: '人工黃框', isColumn: false } : {}),
          ...(hasRegion0 ? { region: a.region } : {}),
          ...(!hasCell0 && !hasRegion0 ? { wholePage: true } : {}),
          pan: !!a.pan,
          ...(a.pan && img0.topicBox ? { titleY: img0.topicBox.y } : {}),
        });
        continue;
      }
      // 舊格式：子句範圍 / 整句
      let bodyStart, bodyEnd;
      if (typeof a.from === 'number' && typeof a.to === 'number') {
        const u0 = unitList.find((u) => u.i === Math.min(a.from, a.to));
        const u1 = unitList.find((u) => u.i === Math.max(a.from, a.to));
        if (!u0 || !u1) continue;
        bodyStart = u0.start; bodyEnd = u1.end;
      } else {
        const sent = sentenceList.find((x) => x.i === a.sentence);
        if (!sent) continue;
        bodyStart = sent.start; bodyEnd = sent.end;
      }
      const r = toCleaned(bodyStart, bodyEnd);
      if (!r) continue;
      const img = imgs.find((m) => m.file === a.src) || {};
      const hasCell = a.cell && a.cell.w > 0;
      const hasRegion = a.region && a.region.w > 0;
      manual.push({
        src: a.src,
        ...r,
        _manual: true,
        _annotated: true,
        page: img.page,
        imageWidth: img.width,
        imageHeight: img.height,
        // ⚠️ cell（黃框）與 region（顯示區域）是兩件事，可以各自存在或都不存在。
        // 都沒給 → wholePage，整張顯示。
        ...(hasCell ? { cell: a.cell, cellText: '人工黃框', isColumn: false } : {}),
        ...(hasRegion ? { region: a.region } : {}),
        ...(!hasCell && !hasRegion ? { wholePage: true } : {}),
        pan: !!a.pan,
        ...(a.pan && img.topicBox ? { titleY: img.topicBox.y } : {}),
      });
    }
    if (ann.length) console.log(`✋ 讀到 ${manual.filter((m) => m._annotated).length} 筆人工標注（自動判定不會碰這些句子）`);
  }
}

// ── 列舉句再拆一次 ──
// 「友達群創雙漲停。」一個子句點名兩檔股票，但一個子句只能配一張圖 →
// 後面那檔（群創）的截圖永遠用不到（2026-08-13 使用者：「都沒放截圖」）。
// 依股名在句中出現的位置把子句再切開，一檔一段，各配各的截圖。
{
  // 用「每張圖實際命中的那個寫法」，不是只用主要股名 ——
  // 主要股名可能是 OCR 多吃一個字的版本（性友達），在腳本裡根本找不到。
  const out = [];
  for (const c of clauses) {
    const hits = [];
    for (const img of imgs) {
      if (!img.stockName) continue;
      let n = null;
      for (const cand of namesOf(img)) if (c.text.includes(cand)) { n = cand; break; }
      if (!n) continue;
      const i = c.text.indexOf(n);
      if (i >= 0 && !hits.some((h) => i < h.i + h.n.length && i + n.length > h.i)) hits.push({ n, i });
    }
    hits.sort((a, b) => a.i - b.i);
    if (hits.length < 2) { out.push(c); continue; }
    let st = 0;
    for (let k = 1; k <= hits.length; k++) {
      const end = k < hits.length ? hits[k].i : c.text.length;
      const t = c.text.slice(st, end);
      if (t.trim().length) out.push({ text: t, start: c.start + st, end: c.start + end, sid: c.sid, blk: c.blk, u: c.u });
      st = end;
    }
  }
  clauses.length = 0;
  clauses.push(...out);
}

// ── 逐子句決定「用哪張圖、框哪一格」──
// 規則：
//   1. 子句本身配到圖 → 用它
//   2. 沒配到，但跟上一個有圖的子句同一句 → 沿用同一張圖（只換框的位置）
//   3. 換句了還是沒配到 → 切回講者（圖消失）—— 使用者要求「講完那句就消失」
const auto = [];
const preview = [];
const usedImg = new Set();
let cur = null; // { img, sid }

for (const c of clauses) {
  const r = toCleaned(c.start, c.end);
  const disp = c.text.replace(/\(shot:[^)]*\)/gi, '').replace(/\s+/g, '').slice(0, 24);
  if (!r || !disp) continue;
  if (manual.some((m) => r.startCharIdx <= m.endCharIdx && r.endCharIdx >= m.startCharIdx)) {
    preview.push(`  ✋ ${disp}…\n       （手動標記，維持不動）`);
    cur = null;
    continue;
  }

  let best = null;
  for (const img of imgs) {
    const { sc: base, why } = scoreImage(c.text, img);
    // 「還沒用到的圖」加分：使用者放進 public/ 的每張截圖都應該要出現。
    // 只在「這句已經點名這檔股票／這個主題」（base ≥ 10）時才加，
    // 否則無關的句子也會被硬配一張圖。
    const sc = base + (base >= 10 && !usedImg.has(img.file) ? 3 : 0);
    // 個股頁：門檻 13 = 股名(10) + 頁面關鍵字/數字佐證。
    //   只提到股名的列舉句（「健鼎跳空漲停」「金居盤中亮燈」）不切圖，避免畫面一直跳。
    // 清單頁/大盤頁：沒有股名可比，只能靠關鍵字，門檻放低到 3。
    // ⚠️ 用「頁面型態」判斷，不要用「有沒有讀到股名」：個股頁的股名 OCR 失敗時
    //    會被誤當清單頁、門檻掉到 3，隨便一個「漲停」就切圖（2026-08-13）。
    const need = img.isStockPage || img.stockName ? 13 : 3;
    if (sc >= need && (!best || sc > best.sc)) best = { img, sc, why };
  }
  if (best) {
    cur = { img: best.img, blk: c.blk, lastCell: null, lastSid: c.sid };
    usedImg.add(best.img.file);
  } else if (cur && cur.lastSid !== c.sid) {
    // ⚠️ 這一行是整個「圖什麼時候消失」的關鍵，改之前先想清楚。
    // 這個子句自己沒配到圖（沒點名股票、沒命中頁面關鍵字）→ 只有「還在同一句」才讓圖留著；
    // 換句了就收掉，回講者。
    //
    // 以前這裡是比 blk（主題段落），而且下面還要 !found 才收 ——
    // 結果 findCell 只要在圖上隨便命中一個數字或欄位，就繞過句子判斷一路掛著
    //（2026-08-17：群創那張從 12.18 秒黏到 26 秒，中間講的是完全不相干的族群）。
    // 「圖上找得到某個東西」≠「這句話在講這張圖」，那正是亂圈的來源。
    cur = null;
  }

  if (!cur) {
    preview.push(`  🎤 ${disp}…\n       講者`);
    continue;
  }

  // 這一句在圖上找得到對應（數字或欄位）嗎？
  const found = findCell(c.text, cur.img);
  // 同一主題段落內找不到新的目標時：圖與框都維持不變，只延長時間。
  // （例：「融券單日大減」在這張融資頁上沒有對應欄位，硬找會跳到錯的欄；
  //   維持前一個畫面比亂框或突然切走都好。2026-08-12 使用者回報內容錯誤。）
  // 找不到新目標時要不要讓圖繼續留著？以「句號」為界：
  //   同一句內（例：「融資連9日增加、融券單日大減，空方持續退場。」）→ 留著，框不變。
  //   換到下一句還是找不到（例：「HVLP4高頻銅箔是…」）→ 收掉，切回講者。
  // 用句子而不是整個主題段落，否則同一段裡後面不相干的句子會一直掛著圖
  //（2026-08-12 使用者回報：講到 HVLP4 時圖片應該要消失了）。
  if (!found && !best && cur.lastCell) {
    const prev0 = auto[auto.length - 1];
    if (prev0 && prev0.src === cur.img.file) {
      prev0.endCharIdx = r.endCharIdx;
      prev0._uTo = c.u;
      preview.push(`  ↳  ${disp}…\n       （同一句，${cur.img.file} 繼續、框不變）`);
      continue;
    }
  }
  if (!found && !best) {
    // 同一句但這個子句在圖上什麼都對不上 → 回講者（使用者定案：真的講到才出現圖）
    // 只有「純連接語氣」的短句才讓圖繼續留著，避免一句一切太碎。
    // 一旦這句沒講到圖上的東西就收回講者，並清掉 cur ——
    // 否則短句會被當成「連接語氣」讓圖回來，造成圖→講者→圖的閃爍。
    cur = null;
    preview.push(`  🎤 ${disp}…\n       講者（這句沒講到圖上的內容）`);
    continue;
  }
  const f = found || cur.lastCell;
  if (found) {
    cur.lastCell = found;
    cur.lastSid = c.sid;
  }
  const prev = auto[auto.length - 1];
  // 比較時把 undefined / null 正規化，否則「兩段都沒有框」會被誤判成不同 →
  // 同一張圖被切成好幾段、每段各淡入一次，看起來就像閃爍。
  const cellKey = (v) => JSON.stringify((v && v.cell ? v.cell : v) || null);
  const sameAsPrev =
    prev && prev.src === cur.img.file && cellKey(prev.cell) === cellKey(f);
  if (sameAsPrev) {
    prev.endCharIdx = r.endCharIdx;
    prev._uTo = c.u;
    preview.push(`  ↳  ${disp}…\n       （${cur.img.file} 繼續，框不變）`);
    continue;
  }

  auto.push({
    src: cur.img.file,
    ...r,
    _phrase: disp,
    _sid: c.sid,      // 屬於哪一句 —— 時間重分配不可以跨句借時間
    _uFrom: c.u,      // 來自哪幾個子句 —— 前台的「拉範圍」用這個對位
    _uTo: c.u,
    _auto: true,
    page: cur.img.page,
    imageWidth: cur.img.width,
    imageHeight: cur.img.height,
    ...(f ? { cell: f.cell, cellText: f.cellText, isColumn: !!f.isColumn, wholePage: !!f.wholePage, pan: !!f.pan } : {}),
  });
  preview.push(
    `  ${f ? '🔍' : '🖼 '} ${disp}…\n       → ${cur.img.file}` +
      (f ? `　框住「${f.cellText}」` : '　（整張顯示）') +
      (best ? `　依據：${best.why.join('、')}` : '　（沿用同一句的圖）')
  );
}
const used = usedImg;

// ── 依呈現規則做後處理（2026-08-12 依使用者手動標記歸納）──
// 使用者的原話：
//   「(image4做滑動因為從講到南電開始的資訊在圖片下方)」→ 目標在下半部就滑動
//   「(image2做滑動因為圖維持蠻久沒動很無聊)」        → 停太久就滑動
//   「image1其實沒有亂圈！算是表現最好了」            → 數字接連命中時的快速換框是好的，不要合併
{
  const secOf = (i, w) => (CHAR_TIMES[i] ? (w === 'end' ? CHAR_TIMES[i].end : CHAR_TIMES[i].start) : null);
  const dur = (a, b) => {
    const s0 = secOf(a, 'start'), e0 = secOf(b, 'end');
    return s0 != null && e0 != null ? e0 - s0 : null;
  };

  // ⚠️ 順序很重要：硬性上限要先跑。
  // 本來 MAX_SHOT_SEC 截斷排在重分配後面，結果重分配拿到一個還沒被截斷的 13.9 秒段
  // 去當「可借用的時間」，四張圖各拿 4 秒（2026-08-17）。先截斷就不會有這種東西。
  const truncate = () => {
    for (const a of auto) {
      const s0 = secOf(a.startCharIdx, 'start');
      if (s0 == null) continue;
      const limit = s0 + MAX_SHOT_SEC;
      if ((secOf(a.endCharIdx, 'end') ?? 0) <= limit) continue;
      let cut = a.startCharIdx;
      for (let i = a.startCharIdx; i <= a.endCharIdx; i++) {
        const e = secOf(i, 'end');
        if (e != null && e <= limit) cut = i;
      }
      if (cut > a.startCharIdx) a.endCharIdx = cut;
    }
  };
  truncate();

  // ── 列舉句的時間重新分配 ──
  // 「南亞科、華邦電漲逾9%、友達群創雙漲停。」四檔擠在 3.5 秒內講完，
  // 照句子切就是每張 0.9 秒 —— 比轉場還短，等於閃一下。
  // 作法：把這一連串太短的段當成一個「區塊」，連同後面「還在講同一件事」的那一段
  //（沿用同一張圖的延伸句）一起，總時長平均分給區塊裡的每張圖。
  // 這樣 9.5s~15.5s 的 6 秒就變成 4 張 × 1.5 秒，看得清楚又不拖。
  {
    const endIdxAtOrBefore = (from, t) => {
      let cut = from;
      for (let k = from; k < CHAR_TIMES.length; k++) {
        const e = secOf(k, 'end');
        if (e == null) continue;
        if (e > t) break;
        cut = k;
      }
      return cut;
    };
    for (let i = 0; i < auto.length; i++) {
      if ((dur(auto[i].startCharIdx, auto[i].endCharIdx) ?? 9) >= MIN_SHOT_SEC) continue;
      let j = i;
      while (j + 1 < auto.length && (dur(auto[j + 1].startCharIdx, auto[j + 1].endCharIdx) ?? 9) < MIN_SHOT_SEC) j++;
      // 借用後面那一段的時間，但只在「同一張圖的延伸句」時才借（不搶別的內容），
      // 而且 ⚠️ 只借到「每段剛好 MIN_SHOT_SEC」為止。
      // 借光整段會出大事：2026-08-17 後面那段被延伸到 13.9 秒，整段借過來平均分給四張圖，
      // 變成「南亞科」三個字配一張圖停 4 秒，中間講別的股票時圖還掛著。
      const n = j - i + 1;
      const s0 = secOf(auto[i].startCharIdx, 'start');
      if (s0 == null || n < 2) { i = j; continue; }
      // 借時間只能在「同一句」裡借。跨句去借，就會出現「這句在講別的股票，
      // 上一句的圖還掛在畫面上」（2026-08-17 使用者：要看句子判讀，不是固定幾秒）。
      const cand = j + 1 < auto.length ? auto[j + 1] : null;
      const next = cand && cand.src === auto[j].src && cand._sid === auto[j]._sid ? cand : null;
      const own = secOf(auto[j].endCharIdx, 'end');
      const e1 = next
        ? Math.min(s0 + n * MIN_SHOT_SEC, secOf(next.endCharIdx, 'end') ?? own)
        : own;
      const borrow = next && e1 > own ? next : null;   // 真的有借到才要調整後面那段
      if (e1 == null) { i = j; continue; }
      // 同一句裡的列舉用比較寬的下限；跨句的才用一般下限
      const sameSentence = auto.slice(i, j + 1).every((a) => a._sid === auto[i]._sid);
      const floor = sameSentence ? MIN_ENUM_SEC : MIN_SHOT_SEC * 0.85;
      const each = (e1 - s0) / n;
      if (each >= floor) {
        for (let k = i; k <= j; k++) {
          auto[k].startCharIdx = k === i ? auto[i].startCharIdx : auto[k - 1].endCharIdx + 1;
          auto[k].endCharIdx =
            k === j && !borrow
              ? auto[j].endCharIdx
              : endIdxAtOrBefore(auto[k].startCharIdx, s0 + each * (k - i + 1));
        }
        if (borrow) borrow.startCharIdx = auto[j].endCharIdx + 1;
        if (borrow && (dur(borrow.startCharIdx, borrow.endCharIdx) ?? 0) <= 0.2) borrow._tooShort = true;
      }
      i = j;
    }
    // 重分配後還是太短 → 整段拿掉，寧可少一張也不要閃。
    // 但同一句裡的列舉用比較寬的下限（見 MIN_ENUM_SEC）。
    for (let i = auto.length - 1; i >= 0; i--) {
      const d = dur(auto[i].startCharIdx, auto[i].endCharIdx) ?? 9;
      const near = [auto[i - 1], auto[i + 1]].filter(Boolean);
      const inEnum = near.some((a) => a._sid === auto[i]._sid);
      const floor = inEnum ? MIN_ENUM_SEC * 0.95 : MIN_SHOT_SEC * 0.7;
      if (auto[i]._tooShort || d < floor) auto.splice(i, 1);
    }
  }

  // 判準（直接對應使用者的手動標記）：
  //   image4/image3/image2 都是「族群清單頁」→ 內容是一長串個股、重點多半在下方 → 滑動
  //   image1 是「大盤指數頁」→ 三個指數磚就在畫面中段、數字明確 → 定格，這是使用者說「表現最好」的
  //   另外不論頁面型別，一段超過 PAN_IF_LONGER_SEC 還定格就太悶 → 改滑動
  const LIST_PAGES = ['industry-list', 'focus-list', 'focus-rank'];
  for (const a of auto) {
    if (a.wholePage || a.pan) continue;
    const d = dur(a.startCharIdx, a.endCharIdx);
    const isList = LIST_PAGES.includes(a.page);
    const long = d != null && d > PAN_IF_LONGER_SEC;
    if (isList || long) { a.pan = true; a._panReason = isList ? '清單頁' : '停留過久'; }
  }


  // 滑動要滑到哪：把這段旁白提到、而且圖上找得到的「個股名」抓出來，取位置最低的那個。
  // 使用者：「像是講到南電時，就要滑動到下方了」——所以終點不是盲滑，而是滑到被提到的內容。
  {
    const imgByFile = Object.fromEntries(imgs.map((i) => [i.file, i]));
    for (const a of auto) {
      if (!a.pan) continue;
      const img = imgByFile[a.src];
      if (!img) continue;
      const phrase = body.slice(
        (cleaned[a.startCharIdx] || {}).origIdx ?? 0,
        ((cleaned[a.endCharIdx] || {}).origIdx ?? 0) + 1
      );
      // 圖上 2~4 個中文字、且出現在旁白裡的詞（多半就是個股名）
      // 排除欄位標題（股票／股價／走勢／產業／龍頭…），那些不是內容
      const HEADERS = ['股票', '股價', '走勢', '產業', '龍頭', '漲跌', '成交', '即時', '日期'];
      const mentioned = (img.words || []).filter(
        (w) =>
          w.c >= 55 &&
          /^[\u4e00-\u9fff]{2,4}$/.test(w.t) &&
          !HEADERS.includes(w.t) &&
          phrase.includes(w.t)
      );
      if (mentioned.length) {
        const lowest = mentioned.sort((x, y) => y.y - x.y)[0];
        a.panToY = lowest.y + lowest.h / 2;
        a._panTo = lowest.t;
      }
    }
  }

  // 滑動起點需要知道「截圖標題」在圖上的位置，才能讓它落在畫面上適當高度
  //（2026-08-12 使用者：標題貼齊畫面頂端會被節目 header 蓋住）
  {
    const byFile = Object.fromEntries(imgs.map((i) => [i.file, i]));
    for (const a of auto) {
      if (!a.pan) continue;
      const img = byFile[a.src];
      if (img && img.topicBox) a.titleY = img.topicBox.y;
    }
  }

  // 硬性上限：重分配可能又把某段拉長，再截一次
  truncate();

  // 相鄰、同一張圖、且都要滑動 → 併成一段連續滑動
  //（使用者把「今天最強的主線是PCB。南電攻上漲停…」整塊標成一次滑動）
  for (let i = auto.length - 1; i > 0; i--) {
    const cur2 = auto[i], prev2 = auto[i - 1];
    if (prev2.src === cur2.src && prev2.pan && cur2.pan) {
      prev2.endCharIdx = cur2.endCharIdx;
      auto.splice(i, 1);
    }
  }

  // 合併後長度可能又超標 → 再截斷一次
  for (const a of auto) {
    const s0 = secOf(a.startCharIdx, 'start');
    if (s0 == null) continue;
    const limit = s0 + MAX_SHOT_SEC;
    if ((secOf(a.endCharIdx, 'end') ?? 0) <= limit) continue;
    let cut = a.startCharIdx;
    for (let i = a.startCharIdx; i <= a.endCharIdx; i++) {
      const e = secOf(i, 'end');
      if (e != null && e <= limit) cut = i;
    }
    if (cut > a.startCharIdx) a.endCharIdx = cut;
  }
}

console.log('\n📋 自動配圖預覽（哪一段旁白 → 哪一張截圖）\n');
preview.forEach((l) => console.log(l));
const unused = imgs.filter((i) => !used.has(i.file));
if (unused.length) console.log(`\n  ⚠️ 沒被用到的圖：${unused.map((u) => u.file + '(' + (u.stockName || u.pageLabel) + ')').join('、')}`);
console.log(`\n  手動 ${manual.length} 段 ＋ 自動 ${auto.length} 段`);

if (WRITE) {
  const merged = [...manual, ...auto].sort((a, b) => a.startCharIdx - b.startCharIdx);
  fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));
  console.log(`\n✅ 已寫入 ${path.relative(ROOT, OUT_PATH)}\n`);
} else {
  console.log('\n👉 預覽而已，沒寫檔。確認後：node scripts/auto-shot.js --write\n');
}
