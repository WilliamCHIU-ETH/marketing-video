#!/usr/bin/env node
/**
 * App 截圖定位 CLI（測試/驗證用）。
 *
 * 用法：
 *   node scripts/app-locate.js <圖片> <page.target> [選項]
 *   選項：
 *     --draw <輸出.png>     用 ffmpeg 畫出黃框，方便肉眼確認（需要 ffmpeg，你流程本來就有）
 *     --anchor "<字>"       動態錨點（例：某天的損益數字 "+31,513.3"）
 *     --lang <chi_tra>      OCR 語言（預設 chi_tra）
 *   列出全部規則：node scripts/app-locate.js --list
 *
 * 輸出：一段 JSON { ok, box:{x,y,w,h}, anchor, imageWidth, imageHeight }
 *   box 就是要框/聚焦/放大的區域（圖片像素座標）。Remotion 端拿這個框套效果。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { locate } = require('./app-locator');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'scripts', 'app-locators.json');
const lib = JSON.parse(fs.readFileSync(LIB_PATH, 'utf-8'));

const args = process.argv.slice(2);
if (args.includes('--list') || args.length === 0) {
  console.log('可用的 page.target：\n');
  for (const [page, pdef] of Object.entries(lib.pages)) {
    for (const [target, tdef] of Object.entries(pdef.targets)) {
      const note = tdef._說明 ? '  — ' + tdef._說明 : '';
      console.log(`  ${page}.${target}   (${pdef._中文})${note}`);
    }
  }
  process.exit(0);
}

const image = args[0];
const sel = args[1];
const drawIdx = args.indexOf('--draw');
const drawOut = drawIdx >= 0 ? args[drawIdx + 1] : null;
const anchorIdx = args.indexOf('--anchor');
const anchorText = anchorIdx >= 0 ? args[anchorIdx + 1] : null;
const langIdx = args.indexOf('--lang');
const lang = langIdx >= 0 ? args[langIdx + 1] : 'chi_tra';

if (!image || !sel || !sel.includes('.')) {
  console.error('用法：node scripts/app-locate.js <圖片> <page.target> [--draw out.png] [--anchor "字"]');
  process.exit(1);
}
if (!fs.existsSync(image)) {
  console.error('找不到圖片：' + image);
  process.exit(1);
}

const [page, target] = sel.split('.');
const recipe = lib.pages?.[page]?.targets?.[target];
if (!recipe) {
  console.error(`規則庫裡沒有 ${page}.${target}。用 --list 看有哪些。`);
  process.exit(1);
}
recipe.lang = lang;

const res = locate(image, recipe, { anchorText });
console.log(JSON.stringify(res, null, 2));

if (drawOut && res.ok) {
  const { x, y, w, h } = res.box;
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', image, '-vf', `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=yellow:thickness=6`, drawOut],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    console.log('\n已畫框 → ' + drawOut);
  } catch (e) {
    console.error('ffmpeg 畫框失敗（不影響定位結果）：' + e.message);
  }
}
