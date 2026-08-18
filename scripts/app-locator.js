/**
 * App 截圖「錨點定位」引擎（尺寸無關）。
 *
 * 為什麼這樣做：手機尺寸/解析度百百種，絕對像素座標記不得。但 App 版面只是等比例縮放，
 * 畫面上的文字標籤都在。所以我們用 OCR 找「錨點文字」（例如「統計天數」），再用一條
 * 「相對規則」從錨點往外展開成要框的區域——規則全部用畫面比例(frac)寫，不寫死像素。
 * 換任何一支手機，OCR 會在新圖上重新找到錨點、給新座標，框自動跟著對。
 *
 * OCR：系統 tesseract CLI（離線、跨平台）。Mac 一次性安裝：brew install tesseract tesseract-lang
 *
 * 對外：locate(imagePath, recipe, opts) → { ok, box:{x,y,w,h}, anchor, reason }
 *   recipe = { anchor:{...}, expand:{ type, ...fracs } }（見 app-locators.json）
 *   opts.anchorText：動態錨點（例如某個當天才知道的數字「+31,513.3」）時傳入
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function ensureTesseract() {
  try {
    execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
  } catch (e) {
    throw new Error(
      '找不到 tesseract。Mac 請先安裝一次：brew install tesseract tesseract-lang'
    );
  }
}

/** 跑 OCR，回傳「以行為單位」的方塊：[{text,x,y,w,h}]（同一行的字會併起來） */
function ocrLines(imagePath, lang = 'chi_tra') {
  ensureTesseract();
  const base = path.join(os.tmpdir(), 'loc_' + process.pid + '_' + Date.now());
  try {
    execFileSync('tesseract', [imagePath, base, '-l', lang, 'tsv'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const tsv = fs.readFileSync(base + '.tsv', 'utf-8');
    const groups = new Map();
    for (const line of tsv.split('\n').slice(1)) {
      const c = line.split('\t');
      if (c.length < 12) continue;
      const conf = parseFloat(c[10]);
      const t = (c[11] || '').replace(/\s+/g, '');
      if (!t || isNaN(conf) || conf < 30) continue;
      const key = c[2] + '-' + c[3] + '-' + c[4]; // block-par-line
      const box = {
        x: parseInt(c[6], 10),
        y: parseInt(c[7], 10),
        w: parseInt(c[8], 10),
        h: parseInt(c[9], 10),
        t,
      };
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(box);
    }
    const lines = [];
    for (const ws of groups.values()) {
      ws.sort((a, b) => a.x - b.x);
      const x0 = Math.min(...ws.map((w) => w.x));
      const y0 = Math.min(...ws.map((w) => w.y));
      const x1 = Math.max(...ws.map((w) => w.x + w.w));
      const y1 = Math.max(...ws.map((w) => w.y + w.h));
      lines.push({
        text: ws.map((w) => w.t).join(''),
        words: ws,
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
      });
    }
    return lines;
  } finally {
    try {
      fs.unlinkSync(base + '.tsv');
    } catch (_) {}
  }
}

/** 從行清單裡挑出符合錨點條件的那一行 */
function findAnchor(lines, anchorSpec, imgH, opts) {
  const all = (opts && opts.anchorText ? [opts.anchorText] : anchorSpec.all) || [];
  const yBand = anchorSpec.yBand || [0, 1];
  let cands = lines.filter((l) => all.every((s) => l.text.includes(s)));
  cands = cands.filter((l) => {
    const cy = (l.y + l.h / 2) / imgH;
    return cy >= yBand[0] && cy <= yBand[1];
  });
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.y - b.y);
  const pick = anchorSpec.pick || 'first';
  return pick === 'last' ? cands[cands.length - 1] : cands[0];
}

/** 若錨點是一整行、但只想對齊行內某個字（例如三磚中的「加權指數」），回傳那個 word 的框 */
function wordInLine(line, sub) {
  if (!sub) return line;
  const hit = line.words.find((w) => w.t.includes(sub));
  return hit || line;
}

/** 依 expand 規則，把錨點框展開成目標框（全部用畫面比例） */
function expandBox(anchor, expand, W, H) {
  const px = (f) => Math.round(f * W);
  const py = (f) => Math.round(f * H);
  const t = expand.type;
  if (t === 'rowFull') {
    const mx = px(expand.marginX ?? 0.012);
    const pad = py(expand.padY ?? 0.008);
    return { x: mx, y: anchor.y - pad, w: W - mx * 2, h: anchor.h + pad * 2 };
  }
  if (t === 'rowRight') {
    const pad = py(expand.padY ?? 0.008);
    const mr = px(expand.marginR ?? 0.012);
    const x0 = Math.max(0, anchor.x - px(expand.padX ?? 0.006));
    return { x: x0, y: anchor.y - pad, w: W - mr - x0, h: anchor.h + pad * 2 };
  }
  if (t === 'card') {
    const mx = px(expand.marginX ?? 0.02);
    const hF = py(expand.heightFrac ?? 0.11);
    // below：卡片在錨點下方（錨上方穩定分頁名往下框）
    // above：卡片在錨點上方（錨下方穩定的子分頁列往上框；AI 摘要卡標題每天不同，用這招最穩）
    if (expand.above) {
      const bottom = anchor.y - py(expand.gap ?? 0.006);
      return { x: mx, y: bottom - hF, w: W - mx * 2, h: hF };
    }
    const top = expand.below
      ? anchor.y + anchor.h + py(expand.gap ?? 0.006)
      : anchor.y - py(expand.padTop ?? 0.02);
    return { x: mx, y: top, w: W - mx * 2, h: hF };
  }
  if (t === 'tile') {
    // 以錨點為基準的一塊磚（例：加權指數磚＝左邊約 1/3）
    // fromLeftMargin=true：磚從畫面左邊界起算（三磚並排時，左磚不會被錨點文字位置帶偏）
    const wFrac = expand.widthFrac ?? 0.31;
    const x0 = expand.fromLeftMargin
      ? px(expand.marginX ?? 0.012)
      : Math.max(0, anchor.x - px(expand.leftPad ?? 0.02));
    const top = anchor.y - py(expand.upFrac ?? 0.01);
    return { x: x0, y: top, w: px(wFrac), h: py(expand.heightFrac ?? 0.1) };
  }
  if (t === 'box') {
    const p = px(expand.pad ?? 0.02);
    return { x: anchor.x - p, y: anchor.y - p, w: anchor.w + p * 2, h: anchor.h + p * 2 };
  }
  if (t === 'region') {
    // 純比例區域（給沒有文字可錨的圖，例如 K 線近期 K 棒）
    return {
      x: px(expand.x0),
      y: py(expand.y0),
      w: px(expand.x1 - expand.x0),
      h: py(expand.y1 - expand.y0),
    };
  }
  throw new Error('未知的 expand.type：' + t);
}

function clampBox(b, W, H) {
  const x = Math.max(0, Math.min(b.x, W - 4));
  const y = Math.max(0, Math.min(b.y, H - 4));
  return {
    x,
    y,
    w: Math.max(4, Math.min(b.w, W - x)),
    h: Math.max(4, Math.min(b.h, H - y)),
  };
}

/**
 * 主函式：在 imagePath 上，依 recipe 定位目標，回傳框（圖片像素座標）。
 * region 型（純比例、不需錨點）不跑 OCR。
 */
function locate(imagePath, recipe, opts = {}) {
  const dim = pngSize(imagePath);
  const W = dim.width;
  const H = dim.height;

  if (recipe.expand.type === 'region') {
    const box = clampBox(expandBox(null, recipe.expand, W, H), W, H);
    return { ok: true, box, anchor: null, reason: 'proportional-region', imageWidth: W, imageHeight: H };
  }

  const lines = ocrLines(imagePath, recipe.lang || 'chi_tra');
  const line = findAnchor(lines, recipe.anchor, H, opts);
  if (!line) {
    return {
      ok: false,
      box: null,
      anchor: null,
      reason: '找不到錨點：' + JSON.stringify(opts.anchorText || recipe.anchor.all),
      imageWidth: W,
      imageHeight: H,
    };
  }
  const anchorBox = recipe.anchor.word ? wordInLine(line, recipe.anchor.word) : line;
  const box = clampBox(expandBox(anchorBox, recipe.expand, W, H), W, H);
  return {
    ok: true,
    box,
    anchor: { text: line.text, x: anchorBox.x, y: anchorBox.y, w: anchorBox.w, h: anchorBox.h },
    reason: 'anchored',
    imageWidth: W,
    imageHeight: H,
  };
}

/** 讀 PNG 尺寸（IHDR）；非 PNG 退回用 OCR 範圍估 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // 非 PNG：用 sips/identify 取尺寸（Mac 有 sips）
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
      encoding: 'utf-8',
    });
    const w = /pixelWidth: (\d+)/.exec(out);
    const h = /pixelHeight: (\d+)/.exec(out);
    if (w && h) return { width: +w[1], height: +h[1] };
  } catch (_) {}
  throw new Error('無法取得圖片尺寸：' + file);
}

module.exports = { locate, ocrLines, pngSize };
