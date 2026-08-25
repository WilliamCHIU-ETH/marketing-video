/**
 * 台股晨報 header 片段（HyperFrames 線用）。
 *
 * 所有座標都從同目錄的 layout.json 讀，這裡不重打任何數字 ——
 * 重打就是製造第二個來源，而這支模組存在的理由就是消掉第二個來源。
 *
 * 用法（在專案的 scripts/build-main.mjs 裡）：
 *
 *   import { renderHeader } from '../template/header.mjs';
 *   const hdr = renderHeader({ date: '08/21', label: '台股晨報' });
 *   // hdr.css  → 塞進 <style>
 *   // hdr.html → 塞進 #root，放在 avatar 之後、broll 之前
 *
 * 疊圖用 <img>，不是 <video> —— HyperFrames 是純 HTML，壓圖不需要任何額外能力。
 * z 序靠 DOM 順序：avatar → header → broll → caption。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadLayout(dir = here) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8'));
}

const esc = (v) => String(v)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * @param {{date: string, label: string, layout?: object, assetPath?: string}} opts
 *   date      左格文字，MMDD 無斜線，例如 '0821'（見 layout.json 的 dateFormat）
 *   label     右格文字，例如 '台股晨報'
 *   layout    省略時讀同目錄 layout.json
 *   assetPath overlay 圖在 HTML 裡的相對路徑，預設 'assets/'
 * @returns {{css: string, html: string}}
 */
export function renderHeader({ date, label, layout = loadLayout(), assetPath = 'assets/' } = {}) {
  if (!date || !label) throw new Error('renderHeader 需要 date 與 label');
  const d = layout.header.date;
  const l = layout.header.label;
  const overlay = assetPath + layout.assets.headerOverlay;

  const css = `
.tpl-header-overlay{position:absolute;left:0;top:0;width:${layout.canvas.width}px;height:${layout.canvas.height}px;object-fit:contain;pointer-events:none}
.tpl-header-date{position:absolute;left:${d.left}px;top:${d.top}px;width:${d.width}px;font-size:${d.fontSize}px;color:${d.color};font-weight:700;line-height:1;text-align:center;white-space:nowrap}
.tpl-header-label{position:absolute;left:${l.left}px;top:${l.top}px;width:${l.width}px;height:${l.height}px;font-size:${l.fontSize}px;color:${l.color};font-weight:700;line-height:${l.height}px;text-align:center;white-space:nowrap}`.trim();

  const html = `    <img class="tpl-header-overlay" src="${overlay}" alt="" />
    <div class="tpl-header-date">${esc(date)}</div>
    <div class="tpl-header-label">${esc(label)}</div>`;

  return { css, html };
}
