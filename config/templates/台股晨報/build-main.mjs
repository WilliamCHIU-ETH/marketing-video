#!/usr/bin/env node
/**
 * 台股晨報主片組裝器（HyperFrames 線）。
 *
 * 這支程式存在的理由：auditor-format（85 行）與鼎元（75 行）各自手寫了一份 build-main.mjs，
 * 其中 28 行完全相同，而不同的那些行有一半是「不該不同」的 —— title-board 的 padding
 * 從 20px 32px 飄成 18px 30px、line-height 從 1.2 飄成 1.18，沒有任何地方定義過那組值。
 * 有規格的不飄（broll 與 caption 三支片位元組相同），沒家的才飄。
 *
 * 所以：版位一律直接讀本 template 的 layout.json，每支片不同的東西一律讀 ledger 或
 * main.config.json。這支程式裡不得出現任何寫死的座標、顏色、字級或秒數。
 *
 * 用法（從 App 直接執行，不複製進 Project）：
 *
 *   node app/config/templates/台股晨報/build-main.mjs --project /abs/project
 *
 * 讀什麼：
 *
 *   <template>/layout.json    版位唯一來源（--template 可覆寫）
 *   <template>/header.mjs     header 片段產生器
 *   segment-ledger.json       durationSec / visualForm / segments[] / segments[].audio
 *   caption-ledger.json       字幕分段（陣列，或 {captions:[]}）
 *   script/script.v1.txt      標題兩行（=== 區塊）
 *   renders/                  逐格 B-roll 成品，檔名以 <段號>- 開頭
 *   main.config.json          （選用）這支片的開關，見下
 *
 * main.config.json 全部欄位都可省略，省略時的預設值刻意等於 2026-08-25 鼎元成片的行為，
 * 這樣「抽進版型層」這件事本身可以先被驗證沒有走鐘，再逐項打開新功能：
 *
 *   {
 *     "compositionId": "<package.json 的 name>-main",
 *     "topBar":  "title-board",   // "header" | "title-board" | "none"
 *     "intro":   false,           // 開場卡（layout.intro.durationSec 秒）
 *     "bgm":     false,           // 背景音樂（需要先產 bgm-mixed.m4a，見下）
 *     "brollAudio": null,         // null = 依 layout.broll.audio.enabled
 *     "title": { "date": null, "label": null, "line2": null }  // null = 從講稿標題解析
 *   }
 *
 * topBar 為什麼是互斥的三選一：header-overlay-v2.png 的藍色 banner 在 y 0–375 不透明，
 * 會把 y 74–222 的 title-board 完全蓋掉。兩個一起開只會得到互相遮蔽的畫面。
 *
 * BGM 為什麼要預先混好：BGM.mp3 只有 52.0 秒，晨報成片通常 60 秒以上，直接掛會斷；
 * 而 hyperframes 0.8.3 有 data-loop／data-volume 但沒有 fade 屬性。所以 loop、fade 與
 * volume 一律由 ffmpeg 先做進一條剛好長度的軌。缺檔時本程式會印出該跑的指令並 exit 1，
 * 不會默默出一支沒有配樂的片。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { mergeSegmentAudioClips } = require(path.resolve(here, '../../../scripts/segment-utils.js'));

const die = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };
const parseArgs = (argv) => {
  const options = { project: null, template: here };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) die(`不認得參數：${token}`);
    const [rawKey, inline] = token.slice(2).split('=', 2);
    if (!['project', 'template'].includes(rawKey)) die(`不認得參數：--${rawKey}`);
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith('--')) die(`--${rawKey} 缺值`);
    options[rawKey] = value;
  }
  if (!options.project || !path.isAbsolute(options.project)) die('--project 必須是絕對路徑');
  options.template = path.resolve(options.template);
  return options;
};
const options = parseArgs(process.argv.slice(2));
const root = fs.realpathSync(options.project);
const templateDir = fs.realpathSync(options.template);
const rootStat = fs.lstatSync(root);
const templateStat = fs.lstatSync(templateDir);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) die('--project 不是安全目錄');
if (!templateStat.isDirectory() || templateStat.isSymbolicLink()) die('--template 不是安全目錄');
const headerFile = path.join(templateDir, 'header.mjs');
if (!fs.existsSync(headerFile)) die('template 找不到 header.mjs');
const { renderHeader } = await import(pathToFileURL(headerFile).href);

const readJsonFile = (file, label) => {
  if (!fs.existsSync(file)) die(`找不到 ${label}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return die(`${label} 不是合法 JSON：${e.message}`); }
};
const readJson = (rel) => readJsonFile(path.join(root, rel), rel);
const esc = (v) => String(v)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const n4 = (v) => Number(Number(v).toFixed(4));

// ── 輸入 ───────────────────────────────────────────────────────────────────

const L = readJsonFile(path.join(templateDir, 'layout.json'), 'template/layout.json');
const ledger = readJson('segment-ledger.json');
const captionsRaw = readJson('caption-ledger.json');
const captions = Array.isArray(captionsRaw) ? captionsRaw : captionsRaw.captions;
if (!Array.isArray(captions) || !captions.length) die('caption-ledger.json 沒有字幕');

const segments = ledger.segments;
if (!Array.isArray(segments) || !segments.length) die('segment-ledger.json 沒有 segments');
if (typeof ledger.durationSec !== 'number') die('segment-ledger.json 缺 durationSec');

const cfgFile = path.join(root, 'main.config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};

const pkg = fs.existsSync(path.join(root, 'package.json'))
  ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) : {};
const compositionId = cfg.compositionId || `${pkg.name || 'main'}-main`;

const TOP_BARS = new Set(['header', 'title-board', 'none']);
const topBar = cfg.topBar ?? 'title-board';
if (!TOP_BARS.has(topBar)) die(`topBar 只能是 ${[...TOP_BARS].join(' / ')}，收到 ${topBar}`);

const useIntro = cfg.intro === true;
const useBgm = cfg.bgm === true;
const brollAudio = cfg.brollAudio ?? Boolean(L.broll.audio?.enabled);

// ── 標題：從講稿的 === 區塊解析 ────────────────────────────────────────────
// 切法與 app/scripts/script-utils.js 的 getTitleText 一致（支援三段式與前台四段式），
// 但不能 import 它 —— HyperFrames 專案必須自我完備才能兩個 session 同時 render。

function parseTitle() {
  const file = path.join(root, 'script', 'script.v1.txt');
  if (!fs.existsSync(file)) return { date: null, label: null, line2: null };
  const parts = fs.readFileSync(file, 'utf8').split('===');
  const block = parts.length >= 3 ? (parts[parts.length - 2] || '') : (parts[0] || '');
  const lines = block.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const [first = '', second = ''] = lines;
  const m = first.match(/^(\S+)\s+(.*)$/);
  return {
    date: m ? m[1].replace(/\D/g, '') : null,   // '08/21' → '0821'（layout.header.dateFormat = MMDD）
    label: m ? m[2] : (first || null),
    line1: first || null,
    line2: second || null,
  };
}

const parsed = parseTitle();
const title = {
  date: cfg.title?.date ?? parsed.date,
  label: cfg.title?.label ?? parsed.label,
  line1: cfg.title?.line1 ?? parsed.line1,
  line2: cfg.title?.line2 ?? parsed.line2,
};

if (topBar === 'header' && (!title.date || !title.label))
  die('topBar=header 需要 date 與 label；講稿標題第一行解析失敗，請在 main.config.json 的 title 指定');
if (topBar === 'title-board' && !title.line1)
  die('topBar=title-board 需要講稿標題；script/script.v1.txt 的 === 區塊解析失敗');

// ── B-roll 檔名：從 renders/ 解析，不再手寫 NAMES 表 ───────────────────────
// 兩支手寫版各自維護一張 { '01': '01-tw-market' } 的對照表，那是 12 行純粹的抄寫工作，
// 而且抄錯不會有人發現（放錯格的 B-roll 一樣 render 得出來）。改成用段號前綴去比對，
// 命中 0 個或 2 個以上一律 fail closed。

const rendersDir = path.join(root, 'renders');
if (!fs.existsSync(rendersDir)) die('找不到 renders/');
const renderFiles = fs.readdirSync(rendersDir).filter((f) => f.toLowerCase().endsWith('.mp4'));

function resolveRender(segment) {
  if (segment.render) {
    if (!renderFiles.includes(segment.render))
      die(`段 ${segment.id} 的 ledger 指定 renders/${segment.render}，但檔案不存在`);
    return segment.render;
  }
  const id = String(segment.id);
  const hits = renderFiles.filter((f) => f === `${id}.mp4` || f.startsWith(`${id}-`));
  if (hits.length === 1) return hits[0];
  if (!hits.length)
    die(`段 ${id} 在 renders/ 找不到對應檔案（預期 ${id}.mp4 或 ${id}-*.mp4）。`
      + `目前有：${renderFiles.join('、') || '（空）'}`);
  return die(`段 ${id} 在 renders/ 命中多個檔案：${hits.join('、')}。`
    + '請在 segment-ledger.json 的該段加上 "render" 欄位指定唯一檔名');
}

const shots = segments.map((s, i) => {
  const duration = typeof s.durationSec === 'number'
    ? s.durationSec : n4(s.endSec - s.startSec);
  if (!(duration > 0)) die(`段 ${s.id} 的長度不是正數`);
  return { id: s.id, index: i, start: s.startSec, duration, file: resolveRender(s) };
});

// ── 時間軸：開場卡會把所有東西往後推 ───────────────────────────────────────

const introSec = useIntro ? Number(L.intro.durationSec) : 0;
if (useIntro && !(introSec > 0)) die('layout.json 的 intro.durationSec 不是正數');
const bodyDur = ledger.durationSec;
const totalDur = n4(bodyDur + introSec);
const shift = (t) => n4(Number(t) + introSec);

function validateAudioSrc(src) {
  if (!src || path.isAbsolute(src)) die(`segment audio.src 必須是 project 相對路徑：${src}`);
  const file = path.resolve(root, src);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    die(`segment audio.src 超出 project：${src}`);
  let stat;
  try { stat = fs.lstatSync(file); } catch { die(`segment audio.src 不存在：${src}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) die(`segment audio.src 不是一般檔案：${src}`);
  return String(src).split(path.sep).join('/');
}

let legacyAvatarAudio = false;
let avatarClips;
if (segments.every((segment) => segment.audio)) {
  try {
    avatarClips = mergeSegmentAudioClips(segments, {
      durationSec: bodyDur,
      toleranceSec: 0.02,
      // Historical ledgers begin B-roll after the spoken greeting. When every segment points to
      // one continuous all-avatar source, retain that source's leading greeting in the one clip.
      extendSingleClipToDuration: true,
    });
  } catch (error) { die(error.message); }
  avatarClips = avatarClips.map((clip) => ({ ...clip, src: validateAudioSrc(clip.src) }));
} else {
  legacyAvatarAudio = true;
  console.log('WARN legacy-ledger-no-audio');
  avatarClips = [{
    src: validateAudioSrc('public/input-video.mp4'),
    timelineStart: 0,
    timelineEnd: bodyDur,
    mediaStart: 0,
    mediaEnd: bodyDur,
    segmentIds: segments.map((segment) => String(segment.id)),
  }];
}

// ── CSS ───────────────────────────────────────────────────────────────────

const form = ledger.visualForm === 'fullframe'
  ? { ...L.broll, ...L.broll.fullframe } : L.broll;
if (ledger.visualForm && !['card', 'fullframe'].includes(ledger.visualForm))
  die(`segment-ledger.json 的 visualForm 只能是 card 或 fullframe，收到 ${ledger.visualForm}`);

const T = L.tracks;
const cap = L.caption;
const inner = cap.inner;
const tb = L.titleBoard;
const hdr = topBar === 'header'
  ? renderHeader({ date: title.date, label: title.label, layout: L }) : null;

const avatarCssSelector = avatarClips.length === 1 ? '#avatar' : '.avatar-video';
const cssColor = (value) => String(value).toLowerCase() === '#ffffff' ? '#fff' : value;
const titleBoardCss = topBar === 'title-board' ? `
.title-board{position:absolute;left:${tb.left}px;top:${tb.top}px;width:${tb.width}px;height:${tb.height}px;padding:${title.line2 ? tb.twoLine.padding : tb.oneLine.padding};border-radius:${tb.borderRadius}px;background:${tb.background};color:${cssColor(tb.color)};border:${tb.borderWidth}px solid ${tb.borderColor};transform:rotate(${tb.rotateDeg}deg);display:flex;${title.line2 ? 'flex-direction:column;' : ''}align-items:center;justify-content:center;text-align:center;${title.line2 ? '' : `font-size:${tb.oneLine.fontSize}px;font-weight:700;`}line-height:${title.line2 ? tb.twoLine.lineHeight : tb.oneLine.lineHeight};box-shadow:${tb.boxShadow}}${title.line2 ? `
.title-board .tl1{font-size:${tb.twoLine.line1.fontSize}px;font-weight:${tb.twoLine.line1.fontWeight};color:${tb.twoLine.line1.color}}
.title-board .tl2{font-size:${tb.twoLine.line2.fontSize}px;font-weight:${tb.twoLine.line2.fontWeight}}` : ''}` : '';

// intro.label 沒有 CSS，因為片型那格的字已經烙印在 intro-frame.jpg 裡
// （layout.json 的 intro.label.$bakedIntoAsset）。再疊一次會重疊成無法辨識的一團。
const introCss = useIntro ? `
#intro-frame{position:absolute;left:0;top:0;width:${L.canvas.width}px;height:${L.canvas.height}px;object-fit:cover}
.intro-date{position:absolute;left:${L.intro.date.left}px;top:${L.intro.date.top}px;width:${L.intro.date.width}px;font-size:${L.intro.date.fontSize}px;color:${L.intro.date.color};font-weight:700;line-height:1;text-align:center}
.intro-title{position:absolute;left:0;top:${L.intro.title.top}px;width:${L.canvas.width}px;font-size:${L.intro.title.fontSize}px;color:${L.intro.title.color};font-weight:700;line-height:1.2;text-align:center}` : '';

const css = `
@font-face{font-family:'${L.fonts.family}';src:url('assets/${L.fonts.regular}') format('truetype');font-weight:400;font-display:block}
@font-face{font-family:'${L.fonts.family}';src:url('assets/${L.fonts.bold}') format('truetype');font-weight:700;font-display:block}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${L.colors.stageBg};font-family:'${L.fonts.family}',sans-serif}
#root{position:relative;width:${L.canvas.width}px;height:${L.canvas.height}px;overflow:hidden;background:${L.colors.stageBg}}
${avatarCssSelector}{position:absolute;inset:0;width:${L.canvas.width}px;height:${L.canvas.height}px;object-fit:${L.avatar.objectFit}}
.broll{position:absolute;left:${form.left}px;top:${form.top}px;width:${form.width}px;height:${form.height}px;object-fit:${form.objectFit}${form.borderRadius ? `;border-radius:${form.borderRadius}px` : ''}${form.boxShadow && form.boxShadow !== 'none' ? `;box-shadow:${form.boxShadow}` : ''}}${titleBoardCss}${hdr ? '\n' + hdr.css : ''}${introCss}
.caption{position:absolute;left:${cap.left}px;top:${cap.top}px;width:${cap.width}px;height:${cap.height}px;display:flex;align-items:flex-start;justify-content:center;padding-top:${cap.paddingTop}px;text-align:center}
.caption-inner{max-width:${inner.maxWidth}px;padding:${inner.padding};border-radius:${inner.borderRadius}px;background:${L.colors.captionBg};color:${cssColor(inner.color)};font-size:${inner.fontSize}px;font-weight:${inner.fontWeight};line-height:${inner.lineHeight};letter-spacing:${inner.letterSpacing};text-shadow:${inner.textShadow};box-shadow:${inner.boxShadow}}`.trim();

// ── HTML 片段 ─────────────────────────────────────────────────────────────

const avatarEls = avatarClips.flatMap((clip, index) => {
  const single = avatarClips.length === 1;
  const suffix = String(index + 1).padStart(2, '0');
  const videoId = single ? 'avatar' : `avatar-${suffix}`;
  const audioId = single ? 'avatar-audio' : `avatar-audio-${suffix}`;
  const videoClass = single ? 'clip' : 'clip avatar-video';
  const start = shift(clip.timelineStart);
  const duration = n4(clip.timelineEnd - clip.timelineStart);
  return [
    `    <video id="${videoId}" class="${videoClass}" src="${esc(clip.src)}" muted playsinline data-start="${start}" data-duration="${duration}" data-media-start="${clip.mediaStart}" data-track-index="${T.avatar}"></video>`,
    `    <audio id="${audioId}" class="clip" src="${esc(clip.src)}" data-start="${start}" data-duration="${duration}" data-media-start="${clip.mediaStart}" data-track-index="${T.avatarAudio}" data-volume="1"></audio>`,
  ];
}).join('\n');

const brollEls = shots.map((s) =>
  `      <video id="broll-${s.id}" class="clip broll" src="renders/${s.file}" muted playsinline data-start="${shift(s.start)}" data-duration="${s.duration}" data-media-start="0" data-track-index="${T.brollBase + s.index}"></video>`
).join('\n');

const brollAudioEls = brollAudio ? shots.map((s) =>
  `      <audio id="broll-audio-${s.id}" class="clip" src="renders/${s.file}" data-start="${shift(s.start)}" data-duration="${s.duration}" data-media-start="0" data-track-index="${T.brollAudioBase + s.index}" data-volume="${L.broll.audio.volume}"></audio>`
).join('\n') : '';

const capEls = captions.map((c) =>
  `      <div id="caption-${c.id}" class="clip caption" data-start="${shift(c.start)}" data-duration="${c.duration}" data-track-index="${T.caption}"><div class="caption-inner">${esc(c.text)}</div></div>`
).join('\n');

const F = cap.fade;
const capTweens = captions.map((c) => {
  const fi = Math.min(F.inSec, c.duration * F.maxRatio);
  const fo = Math.min(F.outSec, c.duration * F.maxRatio);
  const start = shift(c.start), end = shift(c.end);
  const out = n4(end - fo);
  return `        tl.fromTo('#caption-${c.id} .caption-inner',{opacity:0,y:${F.riseFromY}},{opacity:1,y:0,duration:${fi.toFixed(4)},ease:'${F.inEase}'},${start.toFixed(4)});
        tl.to('#caption-${c.id} .caption-inner',{opacity:0,duration:${fo.toFixed(4)},ease:'${F.outEase}'},${out.toFixed(4)});
        tl.set('#caption-${c.id} .caption-inner',{opacity:0},${end.toFixed(4)});`;
}).join('\n');

const titleBoardHtml = topBar === 'title-board'
  ? (title.line2
    ? `    <div class="title-board"><div class="tl1">${esc(title.line1)}</div><div class="tl2">${esc(title.line2)}</div></div>`
    : `    <div class="title-board">${esc(title.line1)}</div>`)
  : '';

// 每個 timeline 可見元素都要有 id，否則 hyperframes check 會出 studio_missing_editable_id
// warning，而這條產線的驗收標準是 0 error 0 warning。
const introHtml = useIntro ? `    <img id="intro-frame" class="clip" src="assets/${L.assets.introFrame}" alt="" data-start="0" data-duration="${introSec}" data-track-index="${T.intro}" />
    <div id="intro-date" class="clip intro-date" data-start="0" data-duration="${introSec}" data-track-index="${T.intro + 1}">${esc(title.date ?? '')}</div>${title.line2 ? `
    <div id="intro-title" class="clip intro-title" data-start="0" data-duration="${introSec}" data-track-index="${T.intro + 2}">${esc(title.line2)}</div>` : ''}` : '';

// ── BGM：缺混好的軌就印指令並停 ─────────────────────────────────────────────

let bgmHtml = '';
if (useBgm) {
  const B = L.bgm;
  const mixed = path.join(root, 'assets', B.mixedFile);
  const src = path.join(root, 'assets', L.assets.bgm);
  const fadeOutAt = n4(totalDur - B.fadeOutSec);
  // -vn 是必要的，不是保險：BGM.mp3 夾了一張 mjpeg 封面圖，m4a(ipod) 容器不收 ——
  // 少了 -vn 會失敗，而且會留下一個 0 byte 的壞檔（2026-08-25 實際踩到）。
  const cmd = `  ffmpeg -y -stream_loop -1 -i "${src}" -vn -t ${totalDur} \\\n`
    + `    -af "afade=in:st=0:d=${B.fadeInSec},afade=out:st=${fadeOutAt}:d=${B.fadeOutSec},volume=${B.volume}" \\\n`
    + `    "${mixed}"`;

  const bgmDie = (why) => die(`${why}\n\n請跑：\n\n${cmd}\n`);
  if (!fs.existsSync(mixed))
    bgmDie(`缺 assets/${B.mixedFile}。BGM 來源只有 52.0 秒、成片 ${totalDur}s，`
      + '而 hyperframes 0.8.3 沒有 fade 屬性，所以 loop／fade／volume 要先用 ffmpeg 做進軌裡。');

  // 只檢查「檔案存在」會放行上面那種 0 byte 壞檔，出來的片就是靜音而且沒人會發現。
  // 所以這裡驗長度：ffprobe 在就驗秒數，不在就至少驗不是空檔並明講降級。
  let probed = null;
  try {
    probed = Number(execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mixed],
      { encoding: 'utf8' }).trim());
  } catch { /* ffprobe 不可用或檔案無法解析，交給下面判斷 */ }

  if (probed === null || !Number.isFinite(probed)) {
    if (fs.statSync(mixed).size < 1024)
      bgmDie(`assets/${B.mixedFile} 只有 ${fs.statSync(mixed).size} bytes，不是一條可用的音軌。`);
    console.error(`⚠️ 無法用 ffprobe 讀 assets/${B.mixedFile} 的長度，只驗了檔案非空。`);
  } else if (Math.abs(probed - totalDur) > 0.5) {
    bgmDie(`assets/${B.mixedFile} 長度 ${probed.toFixed(3)}s 與成片 ${totalDur}s 差超過 0.5s，`
      + '配樂會提早斷或拖尾。片長變了就要重混。');
  }

  bgmHtml = `    <audio id="bgm" class="clip" src="assets/${B.mixedFile}" data-start="0" data-duration="${totalDur}" data-media-start="0" data-track-index="${T.bgm}"></audio>`;
}

// ── 組出 index.html ───────────────────────────────────────────────────────
// DOM 順序就是 z 序：avatar → broll → 頂欄 → 字幕 → 開場卡（蓋住全部）。
//
// 頂欄必須在 broll 之後，不能在之前 —— fullframe 形式的 B-roll 是 1080×1920 不透明全幅，
// 排在它前面的東西會被整片蓋掉。鼎元 v002 的手寫版就是把 title-board 放在 broll 之後，
// 所以成片第 25 秒看得到標題板。card 形式兩種順序都不影響（卡片在 y470–1210，撞不到頂欄），
// 所以統一放後面，兩種形式都安全。
// 開場卡放最後是因為它必須遮住第 0–1 秒的所有東西。

const visualLayerEls = ledger.visualForm === 'fullframe'
  ? [brollEls, hdr ? hdr.html : '', titleBoardHtml]
  : [hdr ? hdr.html : '', titleBoardHtml, brollEls];
const body = [
  avatarEls,
  ...visualLayerEls,
  capEls,
  brollAudioEls,
  bgmHtml,
  introHtml,
].filter(Boolean).join('\n');

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<style>
${css}
</style>
</head>
<body>
  <div id="root" data-composition-id="${compositionId}" data-start="0" data-duration="${totalDur}" data-fps="${L.canvas.fps}" data-width="${L.canvas.width}" data-height="${L.canvas.height}">
${body}
    <script src="assets/${L.gsap}"></script>
    <script>
      (function(){
        const tl = gsap.timeline({paused:true});
${capTweens}
        window.__timelines = window.__timelines || {};
        window.__timelines['${compositionId}'] = tl;
      })();
    </script>
  </div>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(JSON.stringify({
  output: 'index.html',
  compositionId,
  visualForm: ledger.visualForm || 'card',
  topBar,
  intro: useIntro ? introSec : false,
  bgm: useBgm,
  brollAudio,
  segments: shots.length,
  captions: captions.length,
  durationSec: totalDur,
  renders: shots.map((s) => `${s.id}→${s.file}`),
  avatarClips: avatarClips.map((clip) => ({
    src: clip.src,
    start: shift(clip.timelineStart),
    duration: n4(clip.timelineEnd - clip.timelineStart),
    mediaStart: clip.mediaStart,
    segments: clip.segmentIds,
  })),
  legacyAvatarAudio,
}));
