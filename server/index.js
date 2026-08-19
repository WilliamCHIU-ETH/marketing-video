#!/usr/bin/env node
/**
 * 出片前台（server）
 * ─────────────────────────────────────────────────────────────
 * 跑在本機 Mac 上，以瀏覽器操作出片工作。
 *
 *   啟動：node server/index.js          （或 npm run dev:server）
 *   本機連：http://localhost:4000
 *   區網模式：目前沒有完整認證；完成存取控制前不要啟用。
 *
 * 設計重點（2026-08-13 討論定案）：
 *   1. HTTP／檔案流程只用 Node 內建模組；另用 dotenv 載入 repo root `.env`，啟動前需 `npm ci`。
 *   2. 嚴格排隊 —— 整條流程共用同一個 public/，所以一次只跑一支。
 *      使用者的實際用量是「日報13:30／大盤14:00／三大法人16:00，各一兩支」，
 *      撞車機率極低，而 render 實測只要 1~2 分鐘（出片兩支約 2~3 分鐘），
 *      所以不做資料夾隔離 —— 那要動四個 composition 的資料流，不划算。
 *   3. 兩段式，但審核關卡可關 —— 前半段算出配圖計畫後停下來給人看，
 *      確認後才 render。建立工作時勾「直接出片」就變回一段式。
 *      使用者原話：「我甚至不想做兩段式，最終想要一段式」。
 *   4. 審核不卡別人 —— 前半段跑完就把工作區快照起來、放開，
 *      下一支可以立刻開始。不會有人去吃午餐就全公司停擺。
 *   5. 修正紀錄 —— 存「AI 原本的計畫」vs「人改成什麼」。
 *      這是判斷「什麼時候可以安心關掉審核」的依據，不然永遠不敢關。
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createProjectStore, extensionForMediaType, inspectMediaFile } = require('./project-store');
const { capturePaidSpeakerAfterFailure } = require('./project-assets');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) {}

function envFlag(name) {
  return /^(1|true|yes)$/i.test(process.env[name] || '');
}

function resolvedPathIncludingMissing(target) {
  let cursor = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const real = fs.realpathSync(cursor);
  return path.resolve(real, ...missing);
}

function isWithin(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
}

const WEB_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4000);
const TEST_MODE = envFlag('TEST_MODE');
const DISABLE_WORKER = TEST_MODE || envFlag('DISABLE_WORKER');
const DATA_DIR = resolveFromRoot(process.env.DATA_DIR || 'runtime-data');

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error(`PORT 不合法：${process.env.PORT}`);
}
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && !envFlag('ALLOW_INSECURE_LAN')) {
  throw new Error('非 localhost 監聽必須明確設定 ALLOW_INSECURE_LAN=1；目前 API 尚未完成 LAN 認證');
}

if (TEST_MODE && !process.env.DATA_DIR) {
  throw new Error('TEST_MODE=1 必須明確指定 DATA_DIR，避免碰到正式 jobs');
}
if (TEST_MODE && isWithin(fs.realpathSync(ROOT), resolvedPathIncludingMissing(DATA_DIR))) {
  throw new Error('TEST_MODE 的 DATA_DIR 必須位於 repo 外，且不可透過 symlink 指回 repo');
}

const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const PROJECT_STORE = createProjectStore({
  dataDir: DATA_DIR,
  nowISO: () => new Date().toISOString(),
  idFactory: newId,
});

// ── 保留策略 ──────────────────────────────
// 一支工作的成品：焦點股約 45MB、大盤約 138MB（兩支）、三大法人約 67MB。
// 照實際用量（三個版型各一兩支）一天 250~500MB、一個月 5~11GB —— 不清會把硬碟塞爆。
// 影片發出去之後本機那份就沒用了，所以過期就刪，只留 job.json 與執行記錄
//（很小，修正紀錄那頁要用）。要更久／更短就改這兩個數字。
const KEEP_RECENT = Number(process.env.KEEP_RECENT || 20); // 最近幾支一定留著
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 7);      // 或幾天內的都留

// ── 成品庫 ────────────────────────────────
// jobs/ 是工作區，會被自動清掉；成品庫是「發完之後還想找得到」的地方，不會自動清。
// 檔名取成看得懂的（0817-焦點股日報-這波反彈.mp4），不是 output-focusstock.mp4。
// ⚠️ 注意 backups/ 不是這個 —— 那裡面存的是「輸入素材」（heygen.mp4／script.txt），
//    是為了還原被重複加速的影片，裡面沒有成品（2026-08-17 使用者誤會過）。
// 想放到 Google Drive 同步資料夾就設環境變數：ARCHIVE_DIR=/Users/xxx/Google\ Drive/出片成品
const ARCHIVE_DIR = process.env.ARCHIVE_DIR
  ? resolveFromRoot(process.env.ARCHIVE_DIR)
  : path.join(DATA_DIR, 'archive');

// ── 版型設定 ──────────────────────────────
// plan  = 配圖計畫檔。審核關卡就是讓人改這個檔。
// title = 標題設定，四個版型不共用（2026-08-17 使用者定案）：
//   lines = 前台給幾個輸入框（＝影片上顯示幾行）
//   per   = 每行字數上限，前台用 maxlength 直接擋住不給打
//   wrap  = 版型能不能自動換行。投廣模板的標題在旋轉過的上方 bar 上，
//           沒有換行空間，所以是 false；其餘三個超過還有得救。
//   ⚠️ 這些是使用者拍板的數字，不是從字級回推的。改字級不用動這裡，
//      但如果使用者說「字太小 / 擠出去了」，回來一起看。
const TEMPLATES = {
  focusstock: {
    // 2026-08-17 使用者定案：可以超過六個字、可以換行，但字級一律不變。
    // FocusstockComposition 的「超長就縮小」邏輯已經拿掉，改成自然折行：
    // 145px 字級 ÷ 1000px 可用寬 ≈ 一行 7 字，14 字剛好折成兩行、版面還有空間。
    title: { lines: 1, per: 14, wrap: true, where: '開場第一秒（超過 7 字會折行，字級不變）' },
    label: '焦點股日報',
    // 2026-08-13 使用者定案：只出客製版。要投廣套框版才勾選項（run.js 的 --with-ad）。
    hint: '',
    outputs: ['out/output-focusstock.mp4', 'out/output-focusstock-ad.mp4'],
    outputLabels: { 'output-focusstock.mp4': '', 'output-focusstock-ad.mp4': '投廣版' },
    plan: 'src/Focusstock/focusstock-shots.generated.json',
    planKind: 'shots',
    // 2026-08-13 使用者：投廣套框版的選項先不要顯示。
    // 程式碼整條都留著（job.withAd → run.js --with-ad → render:focusstock-ad），
    // 只是這裡不宣告 with-ad，前台就不會畫那個勾選框。要恢復把 'with-ad' 加回來即可。
    flags: [],
  },
  dapan: {
    title: { lines: 2, per: 9, wrap: true, where: '直式：開場第一秒　／　橫式：右側面板全程顯示' },
    label: '大盤小報',
    hint: '',
    outputs: ['out/output-dapan.mp4', 'out/output-dapan-landscape.mp4'],
    outputLabels: { 'output-dapan.mp4': '直式', 'output-dapan-landscape.mp4': '橫式' },
    plan: 'src/DapanXiaobao/dapan-shots.generated.json',
    planKind: 'shots',
    flags: [],
  },
  institution: {
    title: { lines: 2, per: 11, wrap: true, where: '開場第一秒' },
    label: '三大法人',
    hint: '',
    outputs: ['out/output-institution.mp4'],
    plan: 'src/Institution/institution-focus.generated.json',
    planKind: 'focus', // v1 只顯示不給改
    flags: [],
  },
  default: {
    title: { lines: 2, per: 12, wrap: false, where: '上方 bar 全程顯示' },
    label: '投廣模板',
    // 起漲K線 / 籌碼K線：差在 frame・logo・outro・bgm・deeplinks，都在 assets/<品牌>/。
    // 清單是掃資料夾來的 —— 之後多一個品牌就多一個資料夾，不用改程式。
    brands: true,
    hint: '',
    outputs: ['out/output.mp4'],
    plan: 'src/marketing-shots.generated.json',
    planKind: 'shots',
    flags: [],
  },
};

/** 投廣模板可選的品牌 = assets/ 底下有 frame.png 的資料夾 */
function listBrands() {
  const dir = path.join(ROOT, 'assets');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'frame.png')))
    .map((e) => e.name);
}

// public/ 裡屬於「套版素材」的檔案，清場時不要動（run.js 會自己重新複製，
// 但留著可以少複製一次；字型更是絕對不能刪）。跟 analyze-app-images.js 同一條規則。
const TEMPLATE_ASSET = /^(dapan|focusstock|institution)-|^(frame|logo)\.png$|^NotoSans|^outro\.mp4$|^\./i;

// 快照要保存哪些檔案：public/ 整包 ＋ src/ 底下的產出物。
// 這些是「上一段跑完的成果」，後半段 render 完全靠它們。
function snapshotTargets() {
  const list = ['public'];
  const src = path.join(ROOT, 'src');
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (/\.generated\.json$/.test(e.name) || /^subtitles(\.original)?\.json$/.test(e.name))
        list.push('src/' + r);
    }
  };
  if (fs.existsSync(src)) walk(src, '');
  return list;
}

// ── 小工具 ────────────────────────────────
const nowISO = () => new Date().toISOString();
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

function copyRecursive(from, to) {
  if (!fs.existsSync(from)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    ensureDir(to);
    for (const n of fs.readdirSync(from)) copyRecursive(path.join(from, n), path.join(to, n));
  } else {
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else n += fs.statSync(f).size;
    }
  };
  try { walk(p); } catch (_) {}
  return n;
}

/** 本機在區網上的 IP，開機訊息要印給同事看 */
function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// 啟動時間 vs 程式碼修改時間。
// 改完檔案忘了重開伺服器 → 網頁看起來「沒有變」，因為版型設定是這個程序回答的。
// 這個坑第一次就踩到了（2026-08-13），所以讓網頁自己判斷、自己提醒。
const STARTED_AT = Date.now();
function codeChangedAt() {
  let t = 0;
  for (const f of [__filename, path.join(WEB_DIR, 'index.html'), path.join(ROOT, 'run.js')]) {
    try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch (_) {}
  }
  return t;
}

// ── 工作儲存 ──────────────────────────────
// 用檔案存，伺服器重開不會掉。不用資料庫 —— 一天十幾筆而已。
ensureDir(JOBS_DIR);

function jobDir(id) { return path.join(JOBS_DIR, id); }
function jobFile(id) { return path.join(jobDir(id), 'job.json'); }

function loadJobs() {
  const out = [];
  for (const id of fs.readdirSync(JOBS_DIR)) {
    try {
      const j = JSON.parse(fs.readFileSync(jobFile(id), 'utf-8'));
      // 伺服器上次是在跑到一半被關掉的。
      // run.js 是 detached 的，所以它很可能還活著 —— 那就不是「中斷」，
      // 是「在背景繼續跑」。標成失敗會讓人以為 HeyGen 點數白花了（其實沒有）。
      if (j.status === 'preparing' || j.status === 'rendering') {
        if (isRunJs(j.pid)) {
          j.status = 'detached';
          j.error = null;
        } else {
          j.status = 'failed';
          j.error = '伺服器重新啟動，這支工作中斷了。請重新建立。';
        }
      }
      out.push(j);
    } catch (_) {}
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

let JOBS = loadJobs();
JOBS.forEach(saveJob);

function saveJob(j) {
  ensureDir(jobDir(j.id));
  fs.writeFileSync(jobFile(j.id), JSON.stringify(j, null, 2));
  if (j.projectId && j.revisionId) {
    PROJECT_STORE.updateRevision(j.projectId, j.revisionId, {
      jobId: j.id,
      runId: j.id,
      status: j.status,
      owner: j.owner,
      title: j.title,
      assetRefs: j.assetRefs || [],
      files: j.files || [],
      outputs: j.outputs || [],
      archived: j.archived || [],
      finishedAt: j.finishedAt || null,
    });
  }
}

function getJob(id) { return JOBS.find((j) => j.id === id); }

/**
 * 更新「重開前就在跑、現在在背景」的那些工作。
 * 伺服器沒有接回它們（那是方案 B），只負責把狀態顯示對，
 * 並告訴使用者怎麼零成本接回（講者影片還在 public/heygen.mp4）。
 */
function refreshDetached() {
  for (const j of JOBS) {
    if (j.status !== 'detached') continue;
    if (isRunJs(j.pid)) continue;
    j.status = 'detached-done';
    j.pid = null;
    appendLog(j, '\n🔚 這支在背景跑完了（伺服器當時已重開，沒有接回流程）。\n'
      + '   講者影片留在 public/heygen.mp4 —— 重新建立工作並勾「用現成的講者影片」，\n'
      + '   就能零成本接著出片，不用再花 HeyGen 點數。\n');
    saveJob(j);
  }
}

function appendLog(job, line) {
  const f = path.join(jobDir(job.id), 'log.txt');
  ensureDir(path.dirname(f));
  fs.appendFileSync(f, line.endsWith('\n') ? line : line + '\n');
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    '-' + Math.random().toString(36).slice(2, 6)
  );
}

// ── 工作區（public/ 與 src/ 產出物）──────────
const LOCK = TEST_MODE ? path.join(DATA_DIR, '.run.lock') : path.join(ROOT, '.run.lock');

/** 把 public/ 裡上一支工作留下的東西清掉（套版素材與字型保留） */
function clearWorkspaceInputs() {
  const pub = path.join(ROOT, 'public');
  if (!fs.existsSync(pub)) return;
  for (const n of fs.readdirSync(pub)) {
    if (TEMPLATE_ASSET.test(n)) continue;
    if (/\.(png|jpg|jpeg|mp4|mov|m4v|webm|txt|wav|mp3|m4a|aac)$/i.test(n)) rmrf(path.join(pub, n));
  }
  // 標注檔要指名清掉。不能用 *.json 一律清 —— deeplinks.json 是投廣品牌素材。
  rmrf(path.join(pub, 'annotations.json'));
}

function snapshotWorkspace(job) {
  const dst = path.join(jobDir(job.id), 'state');
  rmrf(dst);
  for (const rel of snapshotTargets()) copyRecursive(path.join(ROOT, rel), path.join(dst, rel));
}

function restoreWorkspace(job) {
  const src = path.join(jobDir(job.id), 'state');
  if (!fs.existsSync(src)) throw new Error('找不到這支工作的快照，可能已被清理。請重新建立。');
  clearWorkspaceInputs();
  for (const rel of snapshotTargets()) {
    const from = path.join(src, rel);
    if (fs.existsSync(from)) copyRecursive(from, path.join(ROOT, rel));
  }
}

/**
 * 把本次 Run 產生、之後可能會重用的素材收回 Project library。
 * 固定品牌素材由 assets/ 管理，不重複收入 Project；腳本與中間 JSON 也不算素材。
 */
function captureProjectAssets(job) {
  if (!job.projectId) return;
  const publicDir = path.join(ROOT, 'public');
  if (!fs.existsSync(publicDir)) return;
  for (const name of fs.readdirSync(publicDir)) {
    if (TEMPLATE_ASSET.test(name)) continue;
    let kind = null;
    if (/^heygen\.mp4$/i.test(name)) kind = 'speaker-video';
    else if (/\.(png|jpe?g)$/i.test(name)) kind = 'image';
    else if (/^broll\d+\.(mp4|mov|m4v|webm)$/i.test(name)) kind = 'video';
    if (!kind) continue;
    const file = path.join(publicDir, name);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) continue;
    const asset = PROJECT_STORE.ingestAsset(job.projectId, file, { originalName: name, kind });
    if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
  }
  saveJob(job);
}

/**
 * 把成品另存到成品庫，檔名取成人看得懂的：
 *   成品/2026-08/0817-大盤小報-台股反彈-橫式.mp4
 * jobs/ 會被自動清掉，這裡不會 —— 這才是「以後還找得到」的那一份。
 */
function archivePath(job, outName) {
  if (job.projectId && job.revisionId) {
    return PROJECT_STORE.outputPath(job.projectId, job.revisionId, outName);
  }
  const cfg = TEMPLATES[job.template];
  const d = new Date(job.finishedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const day = `${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  // 檔名不能有 / : 等字元；標題可能兩行，接起來就好
  const title = (job.title || '').replace(/\n/g, '').replace(/[\/\\:*?"<>|]/g, '').slice(0, 20);
  const dir = path.join(ARCHIVE_DIR, month);
  ensureDir(dir);
  const label = (cfg.outputLabels || {})[outName] || '';
  const base = [day, cfg.label, title, label].filter(Boolean).join('-');
  let dest = path.join(dir, base + '.mp4');
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, `${base}(${n++}).mp4`); // 同天同標題不覆蓋
  return dest;
}

// ── 執行 run.js ───────────────────────────
/** pid 還活著，而且真的是我們的 run.js（防 pid 被回收後誤判） */
function isRunJs(pid) {
  if (!pid) return false;
  if (!isPidAlive(pid)) return false;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
    return /run\.js/.test(out);
  } catch (_) { return false; }
}

function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (_) { return false; }
}

function readLockOwner() {
  if (!fs.existsSync(LOCK)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    return Number.isInteger(Number(parsed.pid)) && Number(parsed.pid) > 0
      ? { pid: Number(parsed.pid), startedAt: parsed.startedAt || null }
      : null;
  } catch (_) {
    return null;
  }
}

/**
 * 跑 run.js。
 *
 * ⚠️ 兩個關鍵決定（2026-08-17 與使用者討論後定案的「方案 C」）：
 *
 *  1. 輸出「直接寫進 log 檔」，不經過父程序的管道。
 *     以前是 child.stdout → appendLog；伺服器一被關掉，管道就斷了，
 *     run.js 還在跑但 log 完全沒東西，而且它可能因為 EPIPE 直接死掉。
 *
 *  2. detached：讓它有自己的程序群組。
 *     在終端機按 Ctrl+C 時，訊號是送給「整個前景程序群組」的 —— 不 detached
 *     就會連 run.js 一起殺掉，HeyGen 生成到一半的點數就白花了。
 *
 * 合起來的效果：伺服器可以隨時關、隨時重開，正在跑的那支會自己跑完，
 * 講者影片會留在 public/heygen.mp4，重新建立工作勾「用現成的講者影片」就零成本接回。
 */
function runPipeline(job, args) {
  return new Promise((resolve, reject) => {
    appendLog(job, `\n$ node run.js ${args.join(' ')}\n`);
    const logPath = path.join(jobDir(job.id), 'log.txt');
    ensureDir(path.dirname(logPath));
    const fd = fs.openSync(logPath, 'a');
    let child;
    try {
      child = spawn(process.execPath, ['run.js', ...args], {
        cwd: ROOT,
        env: { ...process.env, FORCE_COLOR: '0' },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      fs.closeSync(fd); // 父程序不需要留著這個 fd，子程序自己有一份
    }
    job.pid = child.pid;
    job.pidArgs = args.join(' ');
    saveJob(job);
    child.unref(); // 不要讓子程序撐住父程序的 event loop
    child.on('error', reject);
    child.on('close', (code) => {
      job.pid = null;
      code === 0 ? resolve() : reject(new Error(`run.js 結束碼 ${code}，詳見執行記錄`));
    });
  });
}

// ── 配圖計畫：讀取／縮圖／寫回 ──────────────
function charTimes() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'subtitles.json'), 'utf-8'))._scriptCharTimes || [];
  } catch (_) { return []; }
}

/**
 * 取子句清單。切法與字元對位一律交給 auto-shot.js 算（--sentences），
 * 伺服器不自己實作第二套 —— 兩套遲早會漂走。
 */
function scriptUnits(scriptPath) {
  if (!fs.existsSync(scriptPath)) return { units: [], chars: [] };
  try {
    const out = execFileSync(process.execPath, ['scripts/auto-shot.js', '--sentences', `--script=${scriptPath}`],
      { cwd: ROOT, encoding: 'utf-8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out);
    return { units: j.units || [], chars: j.chars || [] };
  } catch (_) { return { units: [], chars: [] }; }
}
function unitsOf(scriptPath) { return scriptUnits(scriptPath).units; }

function readPlanFrom(baseDir, tpl) {
  const cfg = TEMPLATES[tpl];
  if (!cfg || !cfg.plan) return null;
  const f = path.join(baseDir, cfg.plan);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) { return null; }
}

function shotsOf(plan) {
  if (!plan) return [];
  return Array.isArray(plan) ? plan : plan.shots || [];
}

/**
 * 把配圖計畫整理成前台看得懂的樣子：秒數、框住什麼、縮圖。
 * 縮圖是「截圖上畫好黃框」的小圖 —— 同事不用想像，一眼就知道會框到哪。
 */
function buildPlanView(job) {
  const state = path.join(jobDir(job.id), 'state');
  const ct = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(state, 'src/subtitles.json'), 'utf-8'))._scriptCharTimes || [];
    } catch (_) { return charTimes(); }
  })();
  const plan = readPlanFrom(state, job.template);
  const shots = shotsOf(plan);
  const thumbDir = path.join(jobDir(job.id), 'thumbs');
  ensureDir(thumbDir);

  const rows = shots.map((s, i) => {
    const st = ct[s.startCharIdx] ? ct[s.startCharIdx].start : null;
    const en = ct[s.endCharIdx] ? ct[s.endCharIdx].end : null;
    const thumb = `plan-${i}.png`;
    try { makeThumb(path.join(state, 'public', s.src), s.cell, path.join(thumbDir, thumb)); }
    catch (_) {}
    return {
      i,
      src: s.src,
      phrase: s._phrase || '',
      start: st, end: en,
      dur: st != null && en != null ? +(en - st).toFixed(1) : null,
      cellText: s.cellText || (s.wholePage ? '整張' : ''),
      pan: !!s.pan,
      wholePage: !!s.wholePage,
      // 框的座標與原圖尺寸 —— 前台直接用比例畫出來，也讓人可以拖著改
      //（2026-08-17 使用者：「我認為你可以看我手動來學習」）
      cell: s.cell || null,
      region: s.region || null,
      // 前台在腳本上拖選，存的就是字元索引（比叫人填秒數直觀得多）
      startCharIdx: s.startCharIdx,
      endCharIdx: s.endCharIdx,
      imageWidth: s.imageWidth || null,
      imageHeight: s.imageHeight || null,
      thumb: fs.existsSync(path.join(thumbDir, thumb)) ? thumb : null,
    };
  });

  // 可以換的圖：這支工作上傳的所有截圖
  const images = [];
  const pub = path.join(state, 'public');
  if (fs.existsSync(pub)) {
    for (const n of fs.readdirSync(pub)) {
      if (TEMPLATE_ASSET.test(n)) continue;
      if (/\.(png|jpe?g)$/i.test(n)) images.push(n);
    }
  }
  const totalSec = ct.length ? ct[ct.length - 1].end : null;
  return {
    kind: TEMPLATES[job.template].planKind,
    rows, images, totalSec,
    ...scriptUnits(path.join(state, 'public', 'script.txt')),
    unused: images.filter((n) => !rows.some((r) => r.src === n)),
  };
}

/** 用 ffmpeg 在截圖上畫黃框、縮成小圖 */
function makeThumb(imgPath, cell, outPath) {
  if (!fs.existsSync(imgPath)) return;
  if (fs.existsSync(outPath)) return;
  const vf = [];
  if (cell && cell.w > 0 && cell.h > 0) {
    vf.push(`drawbox=x=${Math.round(cell.x)}:y=${Math.round(cell.y)}:w=${Math.round(cell.w)}:h=${Math.round(cell.h)}:color=yellow@0.95:t=10`);
  }
  vf.push('scale=300:-1');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', imgPath, '-vf', vf.join(','), outPath], {
    stdio: 'ignore', timeout: 20000,
  });
}

/**
 * 把使用者改過的計畫寫回快照裡的計畫檔。
 * 只支援 v1 開放的三種修改：換圖 / 切換滑動 / 刪掉這段。
 * 換圖時原本的框座標就沒意義了 —— 改成框新那張圖的標題（跟 auto-shot 的退路一致）。
 */
function applyPlanEdits(job, edits) {
  const state = path.join(jobDir(job.id), 'state');
  const cfg = TEMPLATES[job.template];
  const f = path.join(state, cfg.plan);
  const plan = readPlanFrom(state, job.template);
  if (!plan) throw new Error('找不到配圖計畫檔');
  const shots = shotsOf(plan);

  let images = [];
  try {
    images = JSON.parse(fs.readFileSync(path.join(state, 'src/app-images.generated.json'), 'utf-8')).images || [];
  } catch (_) {}

  // 秒數 → 字元索引（人工調時間用）。取「結束時間還沒超過目標」的最後一個字。
  let CT = [];
  try {
    CT = JSON.parse(fs.readFileSync(path.join(state, 'src/subtitles.json'), 'utf-8'))._scriptCharTimes || [];
  } catch (_) {}
  const idxAtStart = (t) => {
    let best = 0;
    for (let i = 0; i < CT.length; i++) if (CT[i] && CT[i].start <= t) best = i;
    return best;
  };
  const idxAtEnd = (t) => {
    let best = 0;
    for (let i = 0; i < CT.length; i++) if (CT[i] && CT[i].end <= t) best = i;
    return best;
  };

  const UNITS = unitsOf(path.join(state, 'public', 'script.txt'));

  const keep = [];
  edits.forEach((e) => {
    // e._added = 前台「＋ 加一段」新增的段，原本計畫裡沒有 → 從空白開始
    //（2026-08-18 使用者：上傳 6 張只自動用了 2 張，其餘要能自己補上）。
    const s = e._added ? {} : shots[e.i];
    if (!s || e.deleted) return;
    // 新增的段一定要有出現範圍，否則是半成品，跳過
    if (e._added && !(typeof e.startCharIdx === 'number' || typeof e.from === 'number')) return;
    if (e._added) { s.src = ''; s._auto = false; s._added = true; }
    if (e.src && e.src !== s.src) {
      const img = images.find((m) => m.file === e.src);
      s.src = e.src;
      s.imageWidth = img ? img.width : undefined;
      s.imageHeight = img ? img.height : undefined;
      s.page = img ? img.page : undefined;
      if (img && img.topicBox) {
        const b = img.topicBox;
        const padX = Math.round((img.width || 1206) * 0.03);
        const padY = Math.round(b.h * 0.35);
        s.cell = { x: b.x - padX, y: b.y - padY, w: b.w + padX * 2, h: b.h + padY * 2 };
        s.cellText = (img.topic || '標題') + '（人工指定）';
      } else {
        delete s.cell; delete s.cellText;
      }
      s.isColumn = false;
    }
    if (typeof e.pan === 'boolean') s.pan = e.pan;
    // 人工拖出來的框：完全照使用者給的，不再套任何自動推算。
    // ⚠️ region（顯示區域）與 cell（黃框）是兩件事，各自可有可無
    //（2026-08-17 使用者指出的設計錯誤）。
    const R = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
    if (e.cell !== undefined || e.region !== undefined) {
      const hasCell = e.cell && e.cell.w > 0 && e.cell.h > 0;
      const hasRegion = e.region && e.region.w > 0 && e.region.h > 0;
      if (hasCell) { s.cell = R(e.cell); s.cellText = '人工黃框'; s.isColumn = false; }
      else { delete s.cell; delete s.cellText; }
      if (hasRegion) s.region = R(e.region); else delete s.region;
      s.wholePage = !hasCell && !hasRegion;   // 兩種都沒有 → 整張顯示
      s._manualCell = hasCell || hasRegion;
    }
    // 出現範圍：優先用「子句範圍」（前台拉的），秒數只是退路。
    // 子句 → 字元索引的對位是 auto-shot 算好附在 units 裡的，這裡只取頭尾。
    if (typeof e.startCharIdx === 'number' && typeof e.endCharIdx === 'number') {
      s.startCharIdx = Math.min(e.startCharIdx, e.endCharIdx);
      s.endCharIdx = Math.max(e.startCharIdx, e.endCharIdx);
      s._manualTime = true;
    } else if (typeof e.from === 'number' && typeof e.to === 'number') {
      const lo = Math.min(e.from, e.to), hi = Math.max(e.from, e.to);
      const u0 = UNITS.find((u) => u.i === lo), u1 = UNITS.find((u) => u.i === hi);
      if (u0 && u1 && u0.startCharIdx != null && u1.endCharIdx != null) {
        s.startCharIdx = u0.startCharIdx;
        s.endCharIdx = Math.max(u0.startCharIdx, u1.endCharIdx);
        s._manualTime = true;
      }
    } else if (CT.length && typeof e.start === 'number' && typeof e.end === 'number' && e.end > e.start) {
      s.startCharIdx = idxAtStart(e.start);
      s.endCharIdx = Math.max(s.startCharIdx, idxAtEnd(e.end));
      s._manualTime = true;
    }
    keep.push(s);
  });

  // 依出現時間排序 —— 新增的段可能插在中間，順序不對會讓「連續同圖合併」判斷錯
  keep.sort((a, b) => (a.startCharIdx ?? 0) - (b.startCharIdx ?? 0));

  const next = Array.isArray(plan) ? keep : { ...plan, shots: keep };
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
  return keep.length;
}

/**
 * 修正紀錄：AI 原本怎麼排、人改成什麼。
 * 這是判斷「什麼時候可以安心關掉審核關卡」的依據 ——
 * 某一類修正連續兩週沒出現，那部分就可以不用看了。
 */
function recordCorrections(job, before, edits) {
  const diffs = [];
  const beforeRows = (before && before.rows) || []; // 缺 planView 也不要讓 approve 整個掛掉
  edits.forEach((e) => {
    // 人工新增的段：AI 沒用到的圖被人補上 —— 代表自動配圖漏了，很值得記
    if (e._added) {
      if (e.startCharIdx != null) diffs.push({ type: '新增一段', phrase: '', from: e.src, to: e.src });
      return;
    }
    const b = beforeRows[e.i];
    if (!b) return;
    if (e.deleted) diffs.push({ type: '刪掉這段', phrase: b.phrase, from: b.src });
    else {
      if (e.src && e.src !== b.src) diffs.push({ type: '換圖', phrase: b.phrase, from: b.src, to: e.src });
      if (typeof e.pan === 'boolean' && e.pan !== b.pan)
        diffs.push({ type: e.pan ? '改成滑動' : '改成定格', phrase: b.phrase, from: b.src });
      // 這兩類是最有價值的學習訊號：AI 框在哪 vs 人框在哪、AI 給幾秒 vs 人要幾秒
      if (e.cell && b.cell && JSON.stringify(e.cell) !== JSON.stringify(b.cell))
        diffs.push({
          type: '改框', phrase: b.phrase, from: b.src,
          autoCell: b.cell, manualCell: e.cell,
          autoCellText: b.cellText,
          size: b.imageWidth && b.imageHeight ? { w: b.imageWidth, h: b.imageHeight } : null,
        });
      if (typeof e.start === 'number' && (Math.abs(e.start - (b.start ?? 0)) > 0.15 || Math.abs(e.end - (b.end ?? 0)) > 0.15))
        diffs.push({
          type: '改時間', phrase: b.phrase, from: b.src,
          auto: `${(b.start ?? 0).toFixed(1)}~${(b.end ?? 0).toFixed(1)}s`,
          manual: `${e.start.toFixed(1)}~${e.end.toFixed(1)}s`,
        });
    }
  });
  job.corrections = diffs;
  job.autoPlan = before.rows.map((r) => ({ i: r.i, src: r.src, pan: r.pan, cellText: r.cellText, phrase: r.phrase }));
  saveJob(job);
  return diffs;
}

/**
 * 把表單欄位組成 script.txt。
 *
 * 格式是既有解析器（script-utils.js / parse-*-script.js）認得的四段式：
 *   第 1 段      = 發音替換規則（一行一條 原文→唸法）
 *   第 2 段      = 保留不用（沿用既有腳本的習慣寫法）
 *   倒數第 2 段  = 開場卡標題（兩行）→ parse 會寫進 video-meta.json.titleText
 *   最後 1 段    = 內文
 *
 * 前台只讓同事填「標題」跟「內文」——`===` 只有 Leighly 看得懂，
 * 給同事看只會造成困擾（2026-08-13 使用者要求）。
 */
function buildScript({ voice, title, body }) {
  return [
    (voice || '').trim(),
    '===',
    '===',
    (title || '').trim(),
    '===',
    (body || '').trim(),
    '',
  ].join('\n');
}

// ── 佇列 ──────────────────────────────────
let busy = false;

function pickNext() {
  // 已確認要 render 的優先（人已經等過一輪了），其次才是新工作
  return (
    JOBS.filter((j) => j.status === 'approved').sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1))[0] ||
    JOBS.filter((j) => j.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
  );
}

function queuePosition(job) {
  if (job.status !== 'queued' && job.status !== 'approved') return 0;
  const list = JOBS.filter((j) => j.status === 'queued' || j.status === 'approved');
  const order = list.sort((a, b) => {
    const w = (j) => (j.status === 'approved' ? 0 : 1);
    if (w(a) !== w(b)) return w(a) - w(b);
    return (a.approvedAt || a.createdAt) < (b.approvedAt || b.createdAt) ? -1 : 1;
  });
  return order.findIndex((j) => j.id === job.id) + (busy ? 1 : 0);
}

let lockWaitLogged = null;
function tick() {
  if (DISABLE_WORKER) return;
  if (busy) return;
  const job = pickNext();
  if (!job) return;
  // .run.lock 存在但伺服器沒在跑東西 → 鎖是「外面」造成的：
  // Leighly 自己在終端機跑 run.js，或上次沒清乾淨留下的。
  // 這時候要排隊等，不能把工作標成失敗 —— 同事只會看到一個看不懂的錯誤
  //（2026-08-17 使用者問「工作區被鎖住時還可以建立工作嗎」時發現）。
  if (fs.existsSync(LOCK)) {
    if (lockWaitLogged !== job.id) {
      lockWaitLogged = job.id;
      appendLog(job, '\n⏳ 工作區正被其他流程使用（.run.lock），排隊等它結束…\n');
    }
    setTimeout(tick, 5000);
    return;
  }
  lockWaitLogged = null;
  busy = true;
  const work = job.status === 'approved' ? doRender(job) : doPrepare(job);
  work
    .catch((e) => {
      job.status = 'failed';
      job.error = e.message;
      appendLog(job, '\n❌ ' + e.message + '\n');
      saveJob(job);
    })
    .finally(() => {
      busy = false;
      try { pruneOldJobs(); } catch (_) {}
      setTimeout(tick, 200);
    });
}

async function doPrepare(job) {
  job.status = 'preparing';
  job.startedAt = nowISO();
  saveJob(job);

  clearWorkspaceInputs();
  copyRecursive(path.join(jobDir(job.id), 'input'), path.join(ROOT, 'public'));

  const args = [`--template=${job.template}`, '--stop-before-render'];
  if (job.brand) args.push(`--brand=${job.brand}`);
  if (job.skipGenerate) args.push('--skip-generate');
  if (job.noSpeed) args.push('--no-speed');
  if (job.withAd) args.push('--with-ad');
  try {
    await runPipeline(job, args);
    captureProjectAssets(job);
    snapshotWorkspace(job);
    job.planView = buildPlanView(job);
  } catch (error) {
    capturePaidSpeakerAfterFailure({
      job,
      speakerFile: path.join(ROOT, 'public', 'heygen.mp4'),
      projectStore: PROJECT_STORE,
      saveJob,
      appendLog,
    });
    throw error;
  }
  job.preparedAt = nowISO();

  if (job.autoApprove) {
    // 一段式：不停下來，直接接著 render
    job.status = 'approved';
    job.approvedAt = nowISO();
    job.approvedBy = '（自動出片）';
    appendLog(job, '\n⏩ 已勾選「直接出片」，跳過人工確認\n');
  } else {
    job.status = 'review';
  }
  saveJob(job);
}

async function doRender(job) {
  job.status = 'rendering';
  saveJob(job);

  restoreWorkspace(job);
  if (job.pendingEdits && job.pendingEdits.length) {
    applyPlanEdits(job, job.pendingEdits);
    appendLog(job, `\n✏️  已套用 ${job.corrections ? job.corrections.length : 0} 項人工修正\n`);
  }

  const args = [`--template=${job.template}`, '--render-only'];
  if (job.withAd) args.push('--with-ad');
  const renderFrom = Date.now() - 3000; // 容忍一點時鐘誤差
  await runPipeline(job, args);

  // 收成品
  // ⚠️ 只收「這次真的重新產生」的檔。out/ 底下的檔名是固定的，上一支的成品會一直留著；
  //    不比對時間就會把舊檔當成這次的成果交出去
  //   （2026-08-17 實際踩到：只出客製版，卻附上四天前的投廣版）。
  // 成品只存「一份」，放在成品庫。網頁直接從那裡播、從那裡下載。
  // 不再在 jobs/<id>/out 留第二份 —— 同一支大盤存兩份就是 276MB，純浪費
  //（2026-08-17 使用者點出來的）。成品庫失敗才退回 jobs/ 當保險。
  job.finishedAt = nowISO();
  job.outputs = [];
  const fallbackDir = path.join(jobDir(job.id), 'out');
  for (const rel of TEMPLATES[job.template].outputs) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).mtimeMs < renderFrom) {
      appendLog(job, `⏭  略過 ${rel}：這次沒有重新產生，是上一支留下的舊檔\n`);
      continue;
    }
    const name = path.basename(rel);
    const size = fs.statSync(from).size;
    try {
      const dest = archivePath(job, name);
      fs.copyFileSync(from, dest);
      job.outputs.push({ name, size, archive: path.relative(ROOT, dest) });
    } catch (e) {
      ensureDir(fallbackDir);
      fs.copyFileSync(from, path.join(fallbackDir, name));
      job.outputs.push({ name, size });
      appendLog(job, `⚠️ 存進成品庫失敗，先留在工作區：${e.message}\n`);
    }
  }
  if (!job.outputs.length) throw new Error('render 跑完了，但找不到輸出檔案。請看執行記錄。');

  job.status = 'done';
  job.archived = job.outputs.map((o) => o.archive).filter(Boolean);
  if (job.archived.length) appendLog(job, '\n📁 成品庫：\n   ' + job.archived.join('\n   ') + '\n');
  // 成品已經另存，快照留著只是佔空間（一支約 20MB）→ 清掉
  rmrf(path.join(jobDir(job.id), 'state'));
  saveJob(job);
}

// ── HTTP ──────────────────────────────────
/**
 * 這個請求是不是「管理者」（＝ Leighly 本人）。
 *
 * 沒有帳號系統，也不需要 —— 用「從哪連進來」判斷就夠：
 *   本機 localhost = 坐在這台 Mac 前面的人 = Leighly
 *   區網 IP        = 同事
 * ?admin=1 預設無效；只有顯式啟用 ALLOW_INSECURE_ADMIN_QUERY 才會接受。
 * 目前這仍不是完整認證機制，所以 server 預設只允許 localhost 監聽。
 */
function isAdmin(req, url) {
  if (envFlag('ALLOW_INSECURE_ADMIN_QUERY') && url.searchParams.get('admin') === '1') return true;
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function send(res, code, body, headers) {
  const h = { 'Cache-Control': 'no-store', ...(headers || {}) };
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('內容太大')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function receiveFile(req, dest, limit, validate) {
  return new Promise((resolve, reject) => {
    const temp = `${dest}.upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx');
    } catch (error) {
      reject(error);
      return;
    }
    const ws = fs.createWriteStream(temp, { fd, autoClose: true });
    let size = 0;
    let settled = false;
    let failed = false;
    const cleanup = () => { try { fs.unlinkSync(temp); } catch (_) {} };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      failed = true;
      req.unpipe(ws);
      req.resume();
      ws.destroy();
      if (ws.closed) cleanup();
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`上傳檔案超過 ${Math.round(limit / 1048576)} MB 上限`);
        error.statusCode = 413;
        fail(error);
      }
    });
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('close', () => { if (failed) cleanup(); });
    ws.on('finish', () => {
      if (settled) return;
      try {
        const validation = validate ? validate(temp) : null;
        fs.renameSync(temp, dest);
        settled = true;
        resolve({ size, validation });
      } catch (error) {
        fail(error);
      }
    });
    req.pipe(ws);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.json': 'application/json',
};

const UPLOAD_LIMITS = Object.freeze({ image: 25 * 1024 * 1024, video: 500 * 1024 * 1024 });
const MAX_REUSED_ASSETS = 50;

function uploadSpec(name) {
  if (/^heygen\.mp4$/i.test(name)) return { kind: 'speaker-video', mediaKind: 'video', limit: UPLOAD_LIMITS.video };
  if (/^shot\d{1,3}\.(png|jpe?g)$/i.test(name)) return { kind: 'image', mediaKind: 'image', limit: UPLOAD_LIMITS.image };
  if (/^broll\d{1,3}\.(mp4|mov|m4v|webm)$/i.test(name)) return { kind: 'video', mediaKind: 'video', limit: UPLOAD_LIMITS.video };
  return null;
}

function allowedExtensions(mediaType) {
  if (mediaType === 'image/png') return ['.png'];
  if (mediaType === 'image/jpeg') return ['.jpg', '.jpeg'];
  if (mediaType === 'video/mp4') return ['.mp4', '.m4v'];
  if (mediaType === 'video/quicktime') return ['.mov'];
  if (mediaType === 'video/webm') return ['.webm'];
  return [];
}

function validateUpload(file, name, spec) {
  const media = inspectMediaFile(file);
  const fail = (message) => {
    const error = new Error(message);
    error.statusCode = 415;
    throw error;
  };
  if (!media) fail('無法辨識檔案內容；支援 PNG、JPEG、MP4、MOV、M4V 與 WebM');
  if (media.kind !== spec.mediaKind) fail('檔案內容與素材類型不一致');
  if (spec.kind === 'speaker-video' && media.mediaType !== 'video/mp4')
    fail('講者影片必須是 MP4；一般 MOV、M4V 或 WebM 請放在 B-Roll 素材欄位');
  const ext = path.extname(name).toLowerCase();
  if (!allowedExtensions(media.mediaType).includes(ext)) fail('檔案內容與副檔名不一致');
  return media;
}

function sendFile(req, res, file, download) {
  if (!fs.existsSync(file)) return send(res, 404, { error: '找不到檔案' });
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;

  // 影片要支援拖時間軸 → Range。無效或超界範圍必須明確回 416，
  // 否則瀏覽器會把錯誤長度當成可播放資料，預覽會卡住。
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start;
    let end;
    if (match && (match[1] || match[2])) {
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (suffixLength > 0) {
          start = Math.max(st.size - suffixLength, 0);
          end = st.size - 1;
        }
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
      }
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start >= st.size || end < start) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

function publicJob(j) {
  const { pid, pendingEdits, autoPlan, createdAssetRefs, ...rest } = j;
  return { ...rest, queuePosition: queuePosition(j) };
}

function publicProject(project) {
  return {
    ...project,
    assets: (project.assets || []).map(({ path: _path, ...asset }) => asset),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);

  try {
    // ── API ──
    if (p === '/api/health') {
      refreshDetached();
      return send(res, 200, {
        ok: true, busy,
        // locked 只代表「有鎖」；externalLock 才是需要提醒的狀況
        //（伺服器自己在跑的時候 run.js 也會建立 .run.lock，那是正常的）
        locked: fs.existsSync(LOCK),
        externalLock: !busy && fs.existsSync(LOCK),
        lockAgeMin: fs.existsSync(LOCK)
          ? Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 60000) : null,
        templates: TEMPLATES, brands: listBrands(),
        startedAt: STARTED_AT, codeChangedAt: codeChangedAt(),
        admin: isAdmin(req, url),
        mode: TEST_MODE ? 'test' : 'normal',
        workerEnabled: !DISABLE_WORKER,
        ...(isAdmin(req, url) ? { dataDir: DATA_DIR } : {}),
        diskMB: Math.round(dirSize(JOBS_DIR) / 1048576),
        keep: { recent: KEEP_RECENT, days: KEEP_DAYS },
      });
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      refreshDetached();
      return send(res, 200, { jobs: JOBS.slice(0, 50).map(publicJob), busy });
    }

    if (p === '/api/projects' && req.method === 'GET') {
      return send(res, 200, { projects: PROJECT_STORE.list().map(publicProject) });
    }

    if (seg[0] === 'api' && seg[1] === 'projects' && seg[2] && seg.length === 3 && req.method === 'GET') {
      const detail = PROJECT_STORE.detail(seg[2], url.searchParams.get('revision'));
      if (!detail) return send(res, 404, { error: '找不到影片專案' });
      return send(res, 200, { project: publicProject(detail.project), revision: detail.revision });
    }

    if (seg[0] === 'api' && seg[1] === 'projects' && seg[2] && seg[3] === 'assets'
        && seg[4] && req.method === 'GET') {
      const file = PROJECT_STORE.assetPath(seg[2], seg[4]);
      if (!file || !fs.existsSync(file)) return send(res, 404, { error: '找不到素材' });
      return sendFile(req, res, file, url.searchParams.get('dl') === '1');
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!TEMPLATES[body.template]) return send(res, 400, { error: '版型不對' });
      if (!body.body || !body.body.trim()) return send(res, 400, { error: '腳本是空的' });
      const brand = body.brand ? String(body.brand) : null;
      if (brand && !listBrands().includes(brand))
        return send(res, 400, { error: '品牌不在允許清單中' });
      // 標題：行數一律以版型設定為準；每行字數只有「不能換行」的模板（投廣）才截斷。
      // 會換行的模板讓標題超過上限，交給 composition 自動換行（2026-08-17 使用者定案）。
      const tcfg = TEMPLATES[body.template].title || { lines: 2, per: 12, wrap: true };
      const title = String(body.title || '').split('\n')
        .map((l) => (tcfg.wrap ? l.trim() : l.trim().slice(0, tcfg.per))).filter(Boolean)
        .slice(0, tcfg.lines).join('\n');
      const reuseAssetIds = Array.isArray(body.reuseAssetIds)
        ? [...new Set(body.reuseAssetIds.map(String))] : [];
      if (reuseAssetIds.length > MAX_REUSED_ASSETS)
        return send(res, 400, { error: `下一版最多可沿用 ${MAX_REUSED_ASSETS} 個圖片與 B-Roll 素材` });
      if (!body.projectId && reuseAssetIds.length)
        return send(res, 400, { error: '建立新影片時不能引用其他專案的素材' });
      const id = newId();
      let project;
      if (body.projectId) {
        project = PROJECT_STORE.get(body.projectId);
        if (!project) return send(res, 404, { error: '找不到要迭代的影片專案' });
        if (project.template !== body.template)
          return send(res, 409, { error: '同一影片專案的版型不可在版本間變更' });
        if ((project.brand || null) !== (brand || null))
          return send(res, 409, { error: '同一影片專案的品牌不可在版本間變更' });
      } else {
        project = PROJECT_STORE.create({
          name: title || TEMPLATES[body.template].label,
          template: body.template,
          brand,
          owner: (body.owner || '').trim() || '未署名',
        });
      }
      const invalidReuse = reuseAssetIds.find((assetId) => {
        const asset = (project.assets || []).find((item) => item.id === assetId);
        return !asset || !['image', 'video'].includes(asset.kind);
      });
      if (invalidReuse) return send(res, 400, { error: `素材 ${invalidReuse} 不可作為圖片或 B-Roll 重用` });
      let revision;
      let job;
      try {
        revision = PROJECT_STORE.addRevision(project.id, {
          jobId: id,
          runId: id,
          title,
          owner: (body.owner || '').trim() || '未署名',
          script: {
            title,
            body: String(body.body || ''),
            voice: String(body.voice || ''),
          },
          options: {
            skipGenerate: !!body.skipGenerate,
            noSpeed: !!body.noSpeed,
            withAd: !!body.withAd,
            autoApprove: !!body.autoApprove,
          },
        });
        job = {
          id,
          projectId: project.id,
          projectName: project.name,
          revisionId: revision.id,
          revisionNumber: revision.number,
          template: body.template,
          owner: (body.owner || '').trim() || '未署名',
          title,
          status: 'draft', // 上傳完檔案才轉 queued
          createdAt: nowISO(),
          skipGenerate: !!body.skipGenerate,
          noSpeed: !!body.noSpeed,
          withAd: !!body.withAd,
          brand,
          autoApprove: !!body.autoApprove,
          assetRefs: [],
          createdAssetRefs: [],
        };
        ensureDir(path.join(jobDir(job.id), 'input'));
        fs.writeFileSync(path.join(jobDir(job.id), 'input', 'script.txt'),
          buildScript({ voice: body.voice, title, body: body.body }));
        let shotIndex = 1;
        let brollIndex = 1;
        for (const assetId of reuseAssetIds) {
          const asset = (project.assets || []).find((item) => item.id === assetId);
          let ext = extensionForMediaType(asset.mediaType);
          if (!ext) {
            const originalExt = path.extname(asset.originalName || '').toLowerCase();
            ext = asset.kind === 'image'
              ? (/^\.jpe?g$/.test(originalExt) ? '.jpg' : '.png')
              : (/^\.(mp4|mov|m4v|webm)$/.test(originalExt) ? originalExt : '.mp4');
          }
          const name = asset.kind === 'image'
            ? `shot${shotIndex++}${ext}` : `broll${brollIndex++}${ext}`;
          PROJECT_STORE.materializeAsset(project.id, assetId,
            path.join(jobDir(job.id), 'input', name));
          job.assetRefs.push(assetId);
        }
      } catch (error) {
        rmrf(jobDir(id));
        if (revision) {
          try { PROJECT_STORE.abortRevision(project.id, revision.id); }
          catch (rollbackError) { error.message += `；版本回收也失敗：${rollbackError.message}`; }
        }
        throw error;
      }
      JOBS.unshift(job);
      saveJob(job);
      return send(res, 200, { job: publicJob(job) });
    }

    // 上傳單一檔案：整個 request body 就是檔案內容（不用 multipart，省一個相依套件）
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'upload' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'draft') return send(res, 409, { error: '只有草稿工作可以上傳素材' });
      const name = path.basename(url.searchParams.get('name') || '');
      if (!name) return send(res, 400, { error: '缺少檔名' });
      const spec = uploadSpec(name);
      if (!spec) return send(res, 400, { error: '不允許的上傳檔名' });
      const limit = spec.limit;
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) return send(res, 413, { error: `上傳檔案超過 ${Math.round(limit / 1048576)} MB 上限` });
      const dest = path.join(jobDir(job.id), 'input', name);
      ensureDir(path.dirname(dest));
      const received = await receiveFile(req, dest, limit, (temp) => validateUpload(temp, name, spec));
      let publicAsset = null;
      if (job.projectId) {
        job.createdAssetRefs ||= [];
        const requestedOriginalName = url.searchParams.get('originalName') || name;
        const existingAssetIds = new Set((PROJECT_STORE.get(job.projectId).assets || []).map((item) => item.id));
        const asset = PROJECT_STORE.ingestAsset(job.projectId, dest, {
          originalName: requestedOriginalName,
          kind: spec.kind,
        });
        if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
        if (!existingAssetIds.has(asset.id) && !job.createdAssetRefs.includes(asset.id))
          job.createdAssetRefs.push(asset.id);
        saveJob(job);
        const { path: _path, ...safeAsset } = asset;
        publicAsset = safeAsset;
      }
      return send(res, 200, { ok: true, name, size: received.size, asset: publicAsset });
    }

    // 前端在素材上傳失敗時回收剛建立的草稿，避免留下空 Project 或跳號 Revision。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'abort' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'draft') return send(res, 409, { error: '只有尚未送出的草稿可以回收' });
      const result = PROJECT_STORE.abortRevision(job.projectId, job.revisionId, {
        pruneAssetIds: job.createdAssetRefs || [],
      });
      if (!result) return send(res, 409, { error: '草稿版本已不存在，請重新整理' });
      const index = JOBS.indexOf(job);
      if (index >= 0) JOBS.splice(index, 1);
      rmrf(jobDir(job.id));
      return send(res, 200, { ok: true, ...result });
    }

    // 上傳完成 → 排進佇列
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'submit' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'draft') return send(res, 409, { error: '只有草稿工作可以送出' });
      const inputDir = path.join(jobDir(job.id), 'input');
      const inputs = fs.readdirSync(inputDir);
      const script = path.join(inputDir, 'script.txt');
      if (!fs.existsSync(script) || fs.statSync(script).size === 0)
        return send(res, 400, { error: '腳本檔不存在或為空' });
      const heygen = path.join(inputDir, 'heygen.mp4');
      if (job.skipGenerate && (!fs.existsSync(heygen) || fs.statSync(heygen).size === 0))
        return send(res, 400, { error: '選了「用現成講者影片」，但 heygen.mp4 不存在或為空' });
      job.status = 'queued';
      job.files = inputs;
      saveJob(job);
      tick();
      return send(res, 200, { job: publicJob(job) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[2] && seg.length === 3 && req.method === 'GET') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      // planView 是在「準備中」那一步算好存起來的，所以功能上線前跑的工作
      // 會缺新欄位（例如子句清單 units → 前台的拉範圍會顯示「腳本還在讀…」）。
      // 快照還在的話就地重算，使用者不用重跑一支（2026-08-17 實際踩到）。
      if (job.status === 'review' && !(job.planView && (job.planView.units || []).length)
          && fs.existsSync(path.join(jobDir(job.id), 'state'))) {
        try {
          job.planView = buildPlanView(job);
          saveJob(job);
        } catch (_) {}
      }
      return send(res, 200, { job: publicJob(job) });
    }

    // 句子清單：交給 auto-shot.js 算（--sentences），確保前台看到的句子
    // 跟配圖用的句子是同一套切法。前台的標注頁存的是這裡的 sentence 編號。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'sentences') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const sp = path.join(jobDir(job.id), 'input', 'script.txt');
      if (!fs.existsSync(sp)) return send(res, 404, { error: '找不到腳本' });
      try {
        const out = execFileSync(process.execPath, ['scripts/auto-shot.js', '--sentences', `--script=${sp}`],
          { cwd: ROOT, encoding: 'utf-8', timeout: 20000 });
        return send(res, 200, JSON.parse(out));
      } catch (e) {
        return send(res, 500, { error: '句子切分失敗：' + e.message });
      }
    }

    // 人工標注：哪張圖配在哪一句、框哪裡、要不要滑動
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'annotations') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const f = path.join(jobDir(job.id), 'input', 'annotations.json');
      if (req.method === 'GET') {
        const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : { shots: [] };
        return send(res, 200, data);
      }
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const data = { shots: Array.isArray(body.shots) ? body.shots : [] };
        ensureDir(path.dirname(f));
        fs.writeFileSync(f, JSON.stringify(data, null, 2));
        // ⚠️ 這支正在跑的話，input/ 早就被複製到 public/ 了。
        // auto-shot 是在 run.js 最後才執行，所以現在補寫一份到 public/ 還來得及 ——
        // 這就是「等 HeyGen 的時候順便標注」能生效的關鍵。
        if (job.status === 'preparing') {
          fs.writeFileSync(path.join(ROOT, 'public', 'annotations.json'), JSON.stringify(data, null, 2));
        }
        job.annotationCount = data.shots.length;
        saveJob(job);
        return send(res, 200, { ok: true, count: data.shots.length });
      }
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'log') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const f = path.join(jobDir(job.id), 'log.txt');
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
      return send(res, 200, { text });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'approve' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'review') return send(res, 400, { error: '這支工作現在不是待確認狀態' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const edits = Array.isArray(body.edits) ? body.edits : [];
      recordCorrections(job, job.planView, edits);
      job.pendingEdits = edits;
      job.status = 'approved';
      job.approvedAt = nowISO();
      job.approvedBy = (body.by || '').trim() || job.owner;
      saveJob(job);
      tick();
      return send(res, 200, { job: publicJob(job) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'cancel' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (['preparing', 'rendering'].includes(job.status))
        return send(res, 400, { error: '正在跑的工作不能取消，請等它結束' });
      job.status = 'cancelled';
      rmrf(path.join(jobDir(job.id), 'state'));
      saveJob(job);
      return send(res, 200, { job: publicJob(job) });
    }

    // 檔案：縮圖 / 截圖 / 成品
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'file') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const name = path.basename(decodeURIComponent(seg.slice(4).join('/')));
      // 成品在成品庫，不在 jobs/ 底下（只存一份）
      const arc = (job.outputs || []).find((o) => o.name === name && o.archive);
      if (arc) {
        const f = path.resolve(ROOT, arc.archive);
        if ((isWithin(path.resolve(ARCHIVE_DIR), f) || isWithin(PROJECT_STORE.projectsDir, f)) && fs.existsSync(f))
          return sendFile(req, res, f, url.searchParams.get('dl') === '1');
      }
      for (const d of ['out', 'thumbs', 'state/public', 'input']) {
        const f = path.join(jobDir(job.id), d, name);
        if (fs.existsSync(f)) return sendFile(req, res, f, url.searchParams.get('dl') === '1');
      }
      return send(res, 404, { error: '找不到檔案' });
    }

    // 修正紀錄總覽：哪一類最常被改 → 規則庫還缺什麼
    // 只給 Leighly 看（2026-08-17 要求）—— 這是內部檢討用的，同事看了只會困惑
    if (p === '/api/corrections') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '這頁只有管理者看得到' });
      const rows = [];
      for (const j of JOBS) for (const c of j.corrections || []) rows.push({ ...c, job: j.id, template: j.template, at: j.approvedAt });
      const byType = {};
      for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
      return send(res, 200, { total: rows.length, byType, rows: rows.slice(0, 100) });
    }

    // 手動清理（管理者用）：把保留期外的大檔全部刪掉
    if (p === '/api/prune' && req.method === 'POST') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以清理' });
      const freed = pruneOldJobs();
      return send(res, 200, { ok: true, freedMB: Math.round(freed / 1048576) });
    }

    if (p === '/api/unlock' && req.method === 'POST') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以解鎖' });
      if (!fs.existsSync(LOCK)) return send(res, 200, { ok: true, removed: false });
      if (busy) return send(res, 409, { error: 'server worker 正在執行，不能解鎖' });
      const liveDetached = JOBS.find((j) => j.status === 'detached' && isRunJs(j.pid));
      if (liveDetached) return send(res, 409, { error: `工作 ${liveDetached.id} 仍在背景執行，不能解鎖` });
      const owner = readLockOwner();
      if (!owner) return send(res, 409, { error: '舊格式或未知來源的 lock 無法證明已失效；請先人工檢查程序' });
      if (isPidAlive(owner.pid)) return send(res, 409, { error: `lock owner pid ${owner.pid} 仍存活，不能解鎖` });
      rmrf(LOCK);
      return send(res, 200, { ok: true, removed: true });
    }

    // ── 靜態檔 ──
    const file = path.join(WEB_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile())
      return sendFile(req, res, file);

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, e.statusCode || 500, { error: e.message });
  }
});

/**
 * 清掉舊工作的大檔（影片、上傳的素材、快照），保留 job.json 與執行記錄。
 * 回傳釋出的位元組數。啟動時與每支工作跑完後都會呼叫。
 */
function pruneOldJobs() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let freed = 0;
  JOBS.forEach((j, idx) => {
    // 快照只有「等人確認」時才有用，其餘狀態一律清掉（一支約 40~60MB）
    if (!['review', 'approved', 'preparing', 'detached'].includes(j.status)) {
      const d = path.join(jobDir(j.id), 'state');
      freed += dirSize(d);
      rmrf(d);
    }
    const t = Date.parse(j.finishedAt || j.createdAt) || 0;
    if (idx < KEEP_RECENT || t > cutoff) return;   // 還在保留期內
    if (['queued', 'preparing', 'review', 'approved', 'rendering', 'detached'].includes(j.status)) return;
    for (const sub of ['out', 'input', 'thumbs']) {
      const d = path.join(jobDir(j.id), sub);
      freed += dirSize(d);
      rmrf(d);
    }
    // 成品在成品庫、不歸這裡管，所以只有「退回工作區的保險副本」才會被清掉
    if (!j.pruned) { j.pruned = !(j.outputs || []).some((o) => o.archive); saveJob(j); }
  });
  return freed;
}


// 連 port 都還沒開就掛掉的情況，要講人話。
// 最常見的是「上一個伺服器忘了關」—— 丟一坨 stack trace 沒有任何幫助
//（2026-08-17 使用者實際遇到）。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ❌ Port ${PORT} 已經有人在用了 —— 多半是上一個伺服器還開著。`);
    console.error('');
    console.error('     先把舊的關掉，再重開：');
    console.error(`       lsof -ti:${PORT} | xargs kill`);
    console.error('       npm run dev:server');
    console.error('');
    console.error('     裝成背景服務的話改用：');
    console.error('       launchctl kickstart -k gui/$(id -u)/com.cmoney.marketing-video-studio');
    console.error('');
  } else {
    console.error('\n  ❌ 伺服器啟動失敗：' + e.message + '\n');
  }
  process.exit(1);
});

// 關掉伺服器時講清楚：正在跑的那支不會被殺掉，也不會浪費 HeyGen 點數。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (busy) {
      console.log('');
      console.log('  ⚠️  有工作正在跑 —— 它會繼續在背景完成，HeyGen 點數不會浪費。');
      console.log('     重開後那支會顯示「背景執行中」，跑完會告訴你怎麼接回。');
    }
    console.log('\n  伺服器已關閉\n');
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  if (!TEST_MODE && envFlag('AUTO_PRUNE_ON_START')) pruneOldJobs();
  const ip = lanIP();
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`SERVER_READY ${JSON.stringify({
    host: HOST,
    port: actualPort,
    mode: TEST_MODE ? 'test' : 'normal',
    workerEnabled: !DISABLE_WORKER,
  })}`);
  console.log('');
  console.log('  🎬  出片前台已啟動');
  console.log('  ─────────────────────────────────');
  console.log(`  你自己：   http://localhost:${actualPort}`);
  if (HOST === '0.0.0.0' || HOST === '::') console.log(`  區網連：   http://${ip}:${actualPort}`);
  else console.log(`  監聽範圍：${HOST}（僅本機）`);
  console.log('');
  console.log(`  資料根目錄：${DATA_DIR}`);
  console.log(`  工作資料夾：${JOBS_DIR}/  （${JOBS.length} 筆，${(dirSize(JOBS_DIR) / 1048576).toFixed(0)} MB）`);
  console.log(`  Worker：      ${DISABLE_WORKER ? '停用（安全模式）' : '啟用'}`);
  console.log(`  自動清理：  留最近 ${KEEP_RECENT} 支或 ${KEEP_DAYS} 天內；更舊的只留紀錄不留影片`);
  console.log(`  成品庫：    ${ARCHIVE_DIR}/  （不會自動清，這份要自己管）`);
  console.log('  按 Ctrl+C 結束');
  console.log('');
  tick();
});
