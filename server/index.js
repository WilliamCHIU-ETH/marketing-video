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
const {
  createProjectStore,
  extensionForMediaType,
  inspectMediaFile,
  isGenericReusableAsset,
} = require('./project-store');
const { capturePaidSpeakerAfterFailure } = require('./project-assets');
const {
  normalizeMaterialAcquisitionIntent,
  resolvePreparedVideoPlacement,
} = require('./material-acquisition');
const {
  PREPARED_PLAN,
  buildPreparedPhoneTimelinePlacement,
  compactPreparedPhoneAcquisition,
  commitPreparedPhoneMaterialSelection,
  finalizePreparedPhoneMaterial,
  prepareJobMaterialAcquisition,
  rollbackPreparedPhoneMaterialSelection,
  validatePreparedPhonePlacementMath,
  validatePreparedPhoneProjectAsset,
} = require('./material-acquisition-runtime');
const {
  buildRenderInputManifest,
  verifyDeclaredFileFingerprints,
} = require('./render-input-manifest');
const { verifyRecordedCompositionEvidence } = require('./broll-composition-evidence');
const { attachRecordedBrollPrompts } = require('./broll-prompt-provenance');

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
const DATA_DIR = resolveFromRoot(process.env.DATA_DIR || 'runtime-data');
// Provider-free smoke may opt into the real queue/doRender path with a DATA_DIR-local fixture.
// Production can never select this entry, and TEST_MODE remains worker-disabled by default.
const TEST_PIPELINE_ENTRY = TEST_MODE && envFlag('ENABLE_TEST_WORKER')
  && process.env.TEST_PIPELINE_ENTRY ? path.resolve(process.env.TEST_PIPELINE_ENTRY) : null;
const DISABLE_WORKER = envFlag('DISABLE_WORKER') || (TEST_MODE && !TEST_PIPELINE_ENTRY);
const LOCK = TEST_MODE ? path.join(DATA_DIR, '.run.lock') : path.join(ROOT, '.run.lock');
const WORKSPACE_OWNER_FILE = TEST_MODE
  ? path.join(DATA_DIR, '.run.owner.json')
  : path.join(ROOT, '.run.owner.json');
// Detached recovery must never inspect the real repo workspace in TEST_MODE. Tests get a fixed,
// DATA_DIR-scoped stand-in; production continues to use the one shared public/ workspace.
const WORKSPACE_PUBLIC_DIR = TEST_MODE
  ? path.join(DATA_DIR, 'workspace', 'public')
  : path.join(ROOT, 'public');
const WORKSPACE_OUTPUT_DIR = TEST_MODE
  ? path.join(DATA_DIR, 'workspace', 'out')
  : path.join(ROOT, 'out');

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
if (TEST_PIPELINE_ENTRY) {
  let entryStat;
  try { entryStat = fs.lstatSync(TEST_PIPELINE_ENTRY); } catch (_) {}
  const dataRoot = resolvedPathIncludingMissing(DATA_DIR);
  const entry = resolvedPathIncludingMissing(TEST_PIPELINE_ENTRY);
  if (!entryStat || !entryStat.isFile() || entryStat.isSymbolicLink()
      || !isWithin(dataRoot, entry) || entry === dataRoot)
    throw new Error('TEST_PIPELINE_ENTRY 必須是 DATA_DIR 內的一般檔案');
}

const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const PROJECT_STORE = createProjectStore({
  dataDir: DATA_DIR,
  nowISO: () => new Date().toISOString(),
  idFactory: newId,
});

// ── 保留策略 ──────────────────────────────
// Project Run 的正式成品與共用素材已經另存到 projects/。只要能驗證每份 output 都在
// Project outputs，Run 的大型 payload 就立即清掉，只留 job.json 與執行記錄供現有 UI 使用。
// 下面的數字只控制 legacy、失敗或取消的 terminal Run；成功 Project Run 若驗證失敗
// 會 fail closed 保留全部 payload，不能靠 retention 繞過 durable gate。
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

const WORKFLOW_MODES = new Set(['manual-assets', 'auto-broll']);
const CONTROL_POLICIES = new Set(['auto', 'pause-before-render']);
const GRAPHIC_BROLL_PLAN = 'src/graphic-broll.generated.json';

function preparedPhoneMode(job) {
  return job.materialAcquisition?.operation === 'prepared-video' ? 'ready-to-place' : 'disabled';
}

function compositionIdFor(job) {
  if (job.template === 'default') return 'MarketingVideo';
  if (job.template === 'dapan') return 'DapanXiaobao';
  if (job.template === 'institution') return 'Institution';
  if (job.template === 'focusstock') return 'Focusstock';
  throw new Error(`版型沒有 composition：${job.template}`);
}

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
      else if (/\.generated\.json$/.test(e.name)
          || /^subtitles(\.original)?\.json$/.test(e.name)
          || /^video-meta\.json$/.test(e.name))
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

function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

function atomicWriteFile(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode, flag: 'wx' });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

function atomicCopyVerified(source, target, { size, sha256 }) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== size
      || fileSha256(source) !== sha256)
    throw new Error(`來源檔與 completion evidence 不一致：${path.basename(source)}`);
  const matchesExpected = (file) => {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === size
        && fileSha256(file) === sha256;
    } catch (_) {
      return false;
    }
  };
  if (fs.existsSync(target)) {
    if (!matchesExpected(target)) throw new Error(`保留檔衝突：${path.basename(target)}`);
    return target;
  }
  ensureDir(path.dirname(target));
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!matchesExpected(temp)) throw new Error(`保留檔驗證失敗：${path.basename(target)}`);
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      if (error.code !== 'EEXIST' || !matchesExpected(target)) throw error;
    }
    return target;
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
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

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function safeRunId(id) {
  const value = String(id || '');
  if (!RUN_ID.test(value)) throw new Error('Run ID 不合法');
  return value;
}
function jobDir(id) { return path.join(JOBS_DIR, safeRunId(id)); }
function jobFile(id) { return path.join(jobDir(id), 'job.json'); }

function ownedJobDir(id) {
  try {
    const dir = jobDir(id);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return isWithin(fs.realpathSync(JOBS_DIR), fs.realpathSync(dir)) ? dir : null;
  } catch (_) {
    return null;
  }
}

function ownedJobPayloadDir(id, subdir) {
  const dir = ownedJobDir(id);
  if (!dir || !/^(input|state|thumbs|out|pipeline|acquisition)$/.test(subdir)) return null;
  const target = path.join(dir, subdir);
  if (!fs.existsSync(target)) return target;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return isWithin(fs.realpathSync(dir), fs.realpathSync(target)) ? target : null;
  } catch (_) {
    return null;
  }
}

function revisionNeedsJobSync(job) {
  if (!job.projectId || !job.revisionId) return false;
  if (!['review', 'done', 'failed', 'cancelled', 'detached-done'].includes(job.status)) return false;
  let revision;
  try { revision = PROJECT_STORE.getRevision(job.projectId, job.revisionId); }
  catch (_) { return false; }
  if (!revision) return false;
  // Ownership disagreement is corruption/contested state, not a half-written transition. Never
  // "repair" it from job.json or cleanup could be tricked into trusting the wrong Run.
  if ((revision.jobId && revision.jobId !== job.id)
      || (revision.runId && revision.runId !== job.id)) return false;
  const expected = {
    jobId: job.id,
    runId: job.id,
    status: job.status,
    owner: job.owner,
    title: job.title,
    assetRefs: job.assetRefs || [],
    files: job.files || [],
    outputs: job.outputs || [],
    archived: job.archived || [],
    submittedAt: job.submittedAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    ...(job.workflowMode ? {
      workflowMode: job.workflowMode,
      controlPolicy: job.controlPolicy || null,
      stage: job.stage || null,
      failedStage: job.failedStage || null,
      cancelRequestedAt: job.cancelRequestedAt || null,
      cancelledAt: job.cancelledAt || null,
      graphicBroll: job.graphicBroll || null,
      timelinePlacements: job.timelinePlacements || [],
      renderInputManifest: job.renderInputManifest || null,
      renderInputManifestSha256: job.renderInputManifestSha256 || null,
      renderEvidence: job.renderEvidence || null,
    } : {}),
    ...(job.materialAcquisition ? { materialAcquisition: job.materialAcquisition } : {}),
    ...(job.materialAcquisitionResult
      ? { materialAcquisitionResult: job.materialAcquisitionResult } : {}),
  };
  const revisionMismatch = Object.entries(expected).some(([key, value]) =>
    JSON.stringify(revision[key] === undefined ? null : revision[key])
      !== JSON.stringify(value === undefined ? null : value));
  let project;
  try { project = PROJECT_STORE.get(job.projectId); } catch (_) { return false; }
  const summary = project && project.revisions.find((item) => item.id === job.revisionId);
  const summaryMismatch = !summary || summary.jobId !== job.id || summary.status !== job.status
    || JSON.stringify(summary.outputs || []) !== JSON.stringify(job.outputs || []);
  return revisionMismatch || summaryMismatch;
}

function loadJobs() {
  const out = [];
  const recovered = [];
  for (const entry of fs.readdirSync(JOBS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const id = entry.name;
    try {
      const j = JSON.parse(fs.readFileSync(jobFile(id), 'utf-8'));
      if (j.id !== id) continue;
      let recoveryChanged = false;
      // 伺服器上次是在跑到一半被關掉的。
      // run.js 是 detached 的，所以它很可能還活著 —— 那就不是「中斷」，
      // 是「在背景繼續跑」。標成失敗會讓人以為 HeyGen 點數白花了（其實沒有）。
      if (j.status === 'preparing' || j.status === 'rendering') {
        const detachedFromStatus = j.status;
        const recordedIntent = hasRecordedWorkspaceIntent(j, detachedFromStatus);
        const lockOwner = readLockOwner();
        const matchingLock = lockBelongsToJob(lockOwner, j);
        const workspaceOwner = readWorkspaceOwner();
        const matchingWorkspaceOwner = workspaceOwnerBelongsToJob(workspaceOwner, j);
        if (!isPidValue(j.pid) && (matchingLock || matchingWorkspaceOwner))
          j.pid = (matchingLock ? lockOwner : workspaceOwner).pid;
        if (recordedIntent || matchingLock || matchingWorkspaceOwner || isRunJs(j.pid)) {
          j.status = 'detached';
          j.error = null;
          j.detachedFromStatus = detachedFromStatus;
          // The spawn record only proves intent. Actual ownership requires evidence written by
          // run.js after it acquired the shared lock.
          if (matchingLock || matchingWorkspaceOwner) markDetachedOwnership(j);
        } else {
          j.status = 'failed';
          j.error = '伺服器重新啟動，這支工作中斷了。請重新建立。';
        }
        recoveryChanged = true;
      }
      out.push(j);
      // saveJob writes the atomic job record before the Project metadata. A crash in that narrow
      // window can leave Job done/review while Revision still says rendering. Replaying only an
      // actual mismatch repairs that half-transition without refreshing timestamps on normal boot.
      if (recoveryChanged || revisionNeedsJobSync(j)) recovered.push(j);
    } catch (_) {}
  }
  return {
    jobs: out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    recovered,
  };
}

const startupJobs = loadJobs();
let JOBS = startupJobs.jobs;
// 一般 restart 不刷新 Project；只有 detached recovery 改變狀態，或偵測到 job-first
// 半完成 transition 時，才同步回 Revision／Project summary。
startupJobs.recovered.forEach(saveJob);

function saveJob(j) {
  writeJobRecord(j);
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
      submittedAt: j.submittedAt || null,
      startedAt: j.startedAt || null,
      finishedAt: j.finishedAt || null,
      ...(j.workflowMode ? {
        workflowMode: j.workflowMode,
        controlPolicy: j.controlPolicy || null,
        stage: j.stage || null,
        failedStage: j.failedStage || null,
        cancelRequestedAt: j.cancelRequestedAt || null,
        cancelledAt: j.cancelledAt || null,
        graphicBroll: j.graphicBroll || null,
        timelinePlacements: j.timelinePlacements || [],
        renderInputManifest: j.renderInputManifest || null,
        renderInputManifestSha256: j.renderInputManifestSha256 || null,
        renderEvidence: j.renderEvidence || null,
      } : {}),
      ...(j.materialAcquisition ? { materialAcquisition: j.materialAcquisition } : {}),
      ...(j.materialAcquisitionResult
        ? { materialAcquisitionResult: j.materialAcquisitionResult } : {}),
    });
  }
}

// Recovery bookkeeping is internal job metadata. Persist it without making the Project look newly
// edited; only saveJob() is allowed to synchronize an actual status/asset change to the Revision.
function writeJobRecord(j) {
  ensureDir(jobDir(j.id));
  atomicWriteFile(jobFile(j.id), JSON.stringify(j, null, 2));
}

function getJob(id) { return JOBS.find((j) => j.id === id); }

const DETACHED_CAPTURE_RETRY_BASE_MS = 2000;
const DETACHED_CAPTURE_RETRY_MAX_MS = 30000;

function hasRecordedWorkspaceIntent(job, runStatus = job.detachedFromStatus) {
  return isWorkspaceRunToken(job.workspaceRunToken) && job.workspaceRunStatus === runStatus;
}

function isPidValue(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0;
}

function isWorkspaceRunToken(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readWorkspaceOwner() {
  if (!fs.existsSync(WORKSPACE_OWNER_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE_OWNER_FILE, 'utf8'));
    return isPidValue(parsed.pid)
      ? {
          pid: Number(parsed.pid),
          startedAt: parsed.startedAt || null,
          token: isWorkspaceRunToken(parsed.token) ? parsed.token : null,
        }
      : null;
  } catch (_) {
    return null;
  }
}

function workspaceOwnerBelongsToJob(owner, job) {
  return !!owner && isWorkspaceRunToken(job.workspaceRunToken)
    && owner.token === job.workspaceRunToken
    && (!isPidValue(job.workspaceRunPid) || Number(job.workspaceRunPid) === owner.pid);
}

function lockBelongsToJob(owner, job) {
  const pid = Number(job.pid);
  if (!owner) return false;
  if (isWorkspaceRunToken(job.workspaceRunToken)) {
    return owner.token === job.workspaceRunToken
      && (!isPidValue(job.workspaceRunPid) || Number(job.workspaceRunPid) === owner.pid);
  }
  if (!isPidValue(pid) || Number(owner.pid) !== pid) return false;
  const lockStartedAt = Date.parse(owner.startedAt || '');
  const jobStartedAt = Date.parse(job.workspaceRunStartedAt || job.startedAt || '');
  // Current run.js always records startedAt. Requiring a close launch window avoids accepting a
  // recycled PID from an unrelated later run as proof of workspace ownership.
  return Number.isFinite(lockStartedAt) && Number.isFinite(jobStartedAt)
    && lockStartedAt >= jobStartedAt - 10000
    && lockStartedAt <= jobStartedAt + 120000;
}

function markDetachedOwnership(job) {
  const pid = Number(job.pid);
  if (!isPidValue(pid)) return false;
  if (job.detachedOwnerPid === pid) return false;
  job.detachedOwnerPid = pid;
  return true;
}

function markDetachedContested(job, reason) {
  if (job.detachedWorkspaceContested === reason) return;
  job.detachedWorkspaceContested = reason;
  writeJobRecord(job);
  appendLog(job, `\n⚠️ 背景工作結束後，工作區 ownership 無法確認（${reason}）；`
    + '為避免把別支影片歸錯專案，已暫停後續佇列。\n');
}

function completeDetached(job, message) {
  const previousStatus = job.status;
  const previousPid = job.pid;
  const previousError = job.error;
  const previousRetryAt = job.detachedCaptureRetryAt;
  const previousAttempts = job.detachedCaptureAttempts;
  job.status = 'detached-done';
  job.pid = null;
  job.error = null;
  delete job.detachedCaptureRetryAt;
  delete job.detachedCaptureAttempts;
  try {
    saveJob(job);
  } catch (error) {
    // Keep the in-memory gate closed when durable status synchronization failed.
    job.status = previousStatus;
    job.pid = previousPid;
    job.error = previousError;
    if (previousRetryAt === undefined) delete job.detachedCaptureRetryAt;
    else job.detachedCaptureRetryAt = previousRetryAt;
    if (previousAttempts === undefined) delete job.detachedCaptureAttempts;
    else job.detachedCaptureAttempts = previousAttempts;
    // saveJob writes job.json before synchronizing the Project. Roll the on-disk gate back too, so
    // a crash/restart cannot observe detached-done and clear the workspace after a partial save.
    try { writeJobRecord(job); } catch (_) {}
    throw error;
  }
  try { appendLog(job, message); } catch (_) {}
}

function deferDetachedCapture(job, message) {
  const attempts = Number(job.detachedCaptureAttempts || 0) + 1;
  const delay = Math.min(
    DETACHED_CAPTURE_RETRY_MAX_MS,
    DETACHED_CAPTURE_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 4)),
  );
  job.detachedCaptureAttempts = attempts;
  job.detachedCaptureRetryAt = new Date(Date.now() + delay).toISOString();
  job.error = message;
  writeJobRecord(job);
  // Avoid turning a persistent disk/Project failure into an unbounded log file.
  if (attempts === 1 || (attempts & (attempts - 1)) === 0)
    appendLog(job, `\n⚠️ ${message}；保留工作區並在稍後重試（第 ${attempts} 次）。\n`);
}

function deferNormalRenderRecovery(job, error) {
  const pid = Number(job.workspaceRunPid);
  job.status = 'detached';
  job.pid = isPidValue(pid) ? pid : null;
  job.detachedFromStatus = 'rendering';
  if (isPidValue(pid)) job.detachedOwnerPid = pid;
  deferDetachedCapture(job, error.message);
}

function expectedPipelineOutputs(job) {
  const derived = (job.workspaceRunStatus === 'rendering' || job.detachedFromStatus === 'rendering')
    ? expectedRenderOutputs(job) : [];
  if (!Array.isArray(job.workspaceRunExpectedOutputs)
      || job.workspaceRunExpectedOutputs.length !== derived.length
      || job.workspaceRunExpectedOutputs.some((item, index) => item !== derived[index])) return null;
  return derived;
}

function evidenceFallbackName(job, outputName) {
  if (!isWorkspaceRunToken(job.workspaceRunToken)
      || typeof outputName !== 'string' || !outputName
      || path.basename(outputName) !== outputName) return null;
  return `${job.workspaceRunToken}-${outputName}`;
}

function evidenceOutputSource(job, item) {
  if (!item || !item.after || item.after.state !== 'file'
      || !Number.isSafeInteger(item.after.size) || item.after.size <= 0
      || !SHA256_HEX.test(item.after.sha256 || '')) return null;
  const fallbackDir = ownedJobPayloadDir(job.id, 'out');
  const versionedFallback = evidenceFallbackName(job, item.name);
  const candidates = [
    path.join(WORKSPACE_OUTPUT_DIR, item.name),
    fallbackDir && versionedFallback && path.join(fallbackDir, versionedFallback),
    // Backward compatibility for Runs preserved before fallbacks became attempt-scoped.
    fallbackDir && path.join(fallbackDir, item.name),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size === item.after.size
          && fileSha256(file) === item.after.sha256) return file;
    } catch (_) {}
  }
  return null;
}

function readPipelineEvidence(job) {
  let result;
  try {
    if (job.workspaceRunEvidenceVersion !== 1)
      return { state: 'missing', message: '這筆 Run 沒有 durable completion evidence' };
    const file = pipelineEvidenceFiles(job).result;
    if (!fs.existsSync(file)) return { state: 'missing', message: '找不到 completion evidence' };
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      return { state: 'contested', message: 'completion evidence 不是一般檔案' };
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { state: 'contested', message: `completion evidence 無法讀取：${error.message}` };
  }

  const expected = expectedPipelineOutputs(job);
  if (!expected)
    return { state: 'contested', message: 'Run 預期 output manifest 與 template／選項不符' };
  const identityMatches = result && result.schemaVersion === 1
    && result.jobId === job.id
    && result.projectId === (job.projectId || null)
    && result.revisionId === (job.revisionId || null)
    && result.workspaceRunToken === job.workspaceRunToken
    && result.runStatus === job.workspaceRunStatus
    && (!job.renderInputManifestSha256
      || result.renderInputManifestSha256 === job.renderInputManifestSha256)
    && result.owner && result.owner.token === job.workspaceRunToken
    && isPidValue(result.owner.pid)
    && (!isPidValue(job.workspaceRunPid) || Number(result.owner.pid) === Number(job.workspaceRunPid));
  if (!identityMatches)
    return { state: 'contested', message: 'completion evidence identity／owner 不屬於這個 Run' };
  if (!Number.isInteger(result.exitCode) || typeof result.finishedAt !== 'string'
      || !Number.isFinite(Date.parse(result.finishedAt)) || !Array.isArray(result.outputs))
    return { state: 'contested', message: 'completion evidence schema 不完整' };
  if (result.outputs.length !== expected.length
      || result.outputs.some((item, index) => !item || typeof item !== 'object'
        || item.relativePath !== expected[index]
        || item.name !== path.basename(expected[index])
        || !item.after || typeof item.after !== 'object'
        || typeof item.changedFromBefore !== 'boolean'))
    return { state: 'contested', message: 'completion evidence output manifest 與預期不符' };

  const outputs = result.outputs.map((item) => ({ ...item, source: evidenceOutputSource(job, item) }));
  let outputFailure = null;
  if (expected.length) {
    for (const item of outputs) {
      if (item.after.state !== 'file') {
        outputFailure = `${item.name} ${item.after.state === 'missing' ? '缺失' : '未完整產生'}`;
        break;
      }
      if (!item.changedFromBefore) {
        outputFailure = `${item.name} 與 render 前完全相同，不能證明是本輪輸出`;
        break;
      }
      if (!item.source) {
        outputFailure = `${item.name} 已不存在或內容與 evidence 不符`;
        break;
      }
      try {
        const media = inspectMediaFile(item.source);
        if (!media || media.kind !== 'video') outputFailure = `${item.name} 不是完整可播放影片`;
      } catch (error) {
        outputFailure = `${item.name} 無法驗證：${error.message}`;
      }
      if (outputFailure) break;
    }
  }
  if (result.exitCode !== 0 || outputFailure) {
    const reason = result.exitCode !== 0 ? `run.js 結束碼 ${result.exitCode}` : outputFailure;
    return { state: 'failed', message: reason, result, outputs };
  }
  return { state: 'success', message: 'ok', result, outputs };
}

function preserveEvidenceOutputs(job, evidence) {
  const fallbackDir = ownedJobPayloadDir(job.id, 'out');
  if (!fallbackDir) throw new Error('Run fallback output 目錄 ownership 無法確認');
  const preserved = [];
  for (const item of evidence.outputs || []) {
    if (!item.source || !item.after || item.after.state !== 'file') continue;
    const fallbackName = evidenceFallbackName(job, item.name);
    if (!fallbackName) throw new Error(`Run fallback output 名稱不合法：${item.name || '(empty)'}`);
    const target = path.join(fallbackDir, fallbackName);
    atomicCopyVerified(item.source, target, {
      size: item.after.size,
      sha256: item.after.sha256,
    });
    preserved.push({ name: fallbackName, size: item.after.size, sha256: item.after.sha256 });
  }
  return preserved;
}

function retryableRenderPatch(job, evidence, preserved) {
  if (job.workflowMode === 'auto-broll') {
    return {
      status: 'failed',
      stage: 'rendering',
      failedStage: 'rendering',
      pid: null,
      error: `render 失敗：${evidence.message}；已保留可驗證 output，可從 render 階段重試`,
      finishedAt: null,
      outputs: preserved,
      archived: [],
    };
  }
  return {
    status: 'review',
    stage: 'awaiting-audit',
    failedStage: null,
    pid: null,
    error: `render 失敗：${evidence.message}；已保留可驗證 output，可人工確認後重新出片`,
    finishedAt: null,
    outputs: preserved,
    archived: [],
  };
}

function commitLegacyOutput(job, item) {
  const cfg = TEMPLATES[job.template];
  if (!cfg) throw new Error('Legacy output template 不合法');
  const date = new Date(job.createdAt || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  const month = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const day = `${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const title = String(job.title || '').replace(/\n/g, '').replace(/[\/\\:*?"<>|]/g, '').slice(0, 20);
  const label = (cfg.outputLabels || {})[item.name] || '';
  const base = [day, cfg.label, title, label].filter(Boolean).join('-');
  let target = path.join(ARCHIVE_DIR, month, `${base}.mp4`);
  // Preserve the historical human-readable name when it is available. A same-content retry reuses
  // it; only a genuine same-name collision falls back to a deterministic Run-qualified path.
  if (fs.existsSync(target)) {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.after.size
          || fileSha256(target) !== item.after.sha256)
        target = path.join(ARCHIVE_DIR, month, `${base}-${safeRunId(job.id)}.mp4`);
    } catch (_) {
      target = path.join(ARCHIVE_DIR, month, `${base}-${safeRunId(job.id)}.mp4`);
    }
  }
  atomicCopyVerified(item.source, target, {
    size: item.after.size,
    sha256: item.after.sha256,
  });
  return target;
}

function finalizeRenderOutputs(job, evidence) {
  if (!evidence || evidence.state !== 'success' || !evidence.outputs.length)
    throw new Error('沒有通過驗證的 render completion evidence');
  const records = [];
  try {
    for (const item of evidence.outputs) {
      const target = job.projectId && job.revisionId
        ? PROJECT_STORE.commitOutput({
            projectId: job.projectId,
            revisionId: job.revisionId,
            runId: job.id,
            sourceFile: item.source,
            name: item.name,
            size: item.after.size,
            sha256: item.after.sha256,
          })
        : commitLegacyOutput(job, item);
      records.push({
        name: item.name,
        size: item.after.size,
        sha256: item.after.sha256,
        archive: path.relative(ROOT, target),
        ...(job.renderInputManifestSha256
          ? { renderInputManifestSha256: job.renderInputManifestSha256 } : {}),
      });
    }
  } catch (error) {
    // Preserve every verified output before returning control. Both normal execution and restart
    // recovery keep the queue closed and retry the deterministic Project commit.
    let fallbackError = null;
    try { preserveEvidenceOutputs(job, evidence); }
    catch (preserveError) { fallbackError = preserveError; }
    const wrapped = new Error(`Project output 封存失敗：${error.message}`
      + (fallbackError ? `；fallback 保存也失敗：${fallbackError.message}` : ''));
    wrapped.code = 'OUTPUT_ARCHIVE_RETRY';
    wrapped.pipelineEvidence = evidence;
    throw wrapped;
  }
  return {
    finishedAt: evidence.result.finishedAt,
    outputs: records,
    archived: records.map((record) => record.archive),
  };
}

function transitionJobSafely(job, patch) {
  const previous = JSON.parse(JSON.stringify(job));
  Object.assign(job, patch);
  delete job.detachedCaptureRetryAt;
  delete job.detachedCaptureAttempts;
  try {
    saveJob(job);
  } catch (error) {
    for (const key of Object.keys(job)) delete job[key];
    Object.assign(job, previous);
    try { writeJobRecord(job); } catch (_) {}
    throw error;
  }
}

function reconcileDetachedRender(job, pid) {
  const retryAt = Date.parse(job.detachedCaptureRetryAt || '');
  if (Number.isFinite(retryAt) && retryAt > Date.now()) return false;
  if (Number(job.detachedOwnerPid) !== pid) {
    deferDetachedCapture(job, 'render output ownership 尚未驗證');
    return false;
  }

  const evidence = readPipelineEvidence(job);
  if (evidence.state === 'missing' || evidence.state === 'contested') {
    markDetachedContested(job, evidence.message);
    return false;
  }
  if (evidence.state === 'failed') {
    let preserved;
    try {
      preserved = preserveEvidenceOutputs(job, evidence);
      if (job.cancelRequestedAt) {
        settleCancelledJob(job, { outputs: preserved });
        appendLogBestEffort(job, `\n⏹ 背景 render 已停止；保留 ${preserved.length} 份可驗證 partial output。\n`);
        return true;
      }
      transitionJobSafely(job, retryableRenderPatch(job, evidence, preserved));
    } catch (error) {
      deferDetachedCapture(job, `背景 render 失敗且 fallback 尚未保存：${error.message}`);
      return false;
    }
    appendLogBestEffort(job, `\n⚠️ 背景 render 失敗：${evidence.message}；`
      + `已保留 ${preserved.length} 份可檢查 output，`
      + (job.workflowMode === 'auto-broll'
        ? '可從 render 階段重試，不會重生圖卡。\n'
        : '回到待確認狀態，可人工重新出片。\n'));
    return true;
  }

  let finalized;
  try {
    finalized = finalizeRenderOutputs(job, evidence);
    transitionJobSafely(job, {
      status: 'done',
      pid: null,
      error: null,
      finishedAt: finalized.finishedAt,
      outputs: finalized.outputs,
      archived: finalized.archived,
      stage: 'done',
      failedStage: null,
      renderEvidence: {
        schemaVersion: 1,
        renderInputManifestSha256: job.renderInputManifestSha256 || null,
        verifiedAt: finalized.finishedAt,
        outputs: finalized.outputs.map((output) => ({
          name: output.name,
          size: output.size,
          sha256: output.sha256,
        })),
      },
    });
  } catch (error) {
    let message = error.message;
    try { preserveEvidenceOutputs(job, evidence); }
    catch (fallbackError) { message += `；fallback 保存也失敗：${fallbackError.message}`; }
    deferDetachedCapture(job, message);
    return false;
  }
  appendLogBestEffort(job, '\n🛟 背景 render output 已驗證並保存到原 Project／Revision。\n');
  return true;
}

/**
 * Reconcile one job whose detached run outlived the server.
 *
 * Ordering is deliberately strict: child exit -> lock release -> ownership proof -> validate ->
 * durable Project capture -> status transition. Returning false means tick must not let another
 * job clear the shared workspace.
 */
function reconcileDetached(job) {
  let pid = Number(job.pid);
  let lockExists = fs.existsSync(LOCK);
  let lockOwner = lockExists ? readLockOwner() : null;
  const workspaceOwner = readWorkspaceOwner();
  // The lock may disappear between existsSync/readFileSync as run.js exits.
  if (lockExists && !lockOwner && !fs.existsSync(LOCK)) lockExists = false;

  const matchingLock = lockExists && lockBelongsToJob(lockOwner, job);
  const matchingWorkspaceOwner = workspaceOwnerBelongsToJob(workspaceOwner, job);
  let ownershipChanged = false;
  if (!isPidValue(pid) && (matchingLock || matchingWorkspaceOwner)) {
    pid = (matchingLock ? lockOwner : workspaceOwner).pid;
    job.pid = pid;
    job.workspaceRunPid = pid;
    ownershipChanged = true;
  }
  if ((matchingLock || matchingWorkspaceOwner) && markDetachedOwnership(job))
    ownershipChanged = true;
  if (ownershipChanged) writeJobRecord(job);

  const running = isRunJs(pid);

  if (running) {
    if (lockExists && lockOwner && !matchingLock) {
      markDetachedContested(job, `lock owner pid ${lockOwner.pid} != detached pid ${pid}`);
    }
    if (job.cancelRequestedAt && !job.cancelSignalSentAt && matchingLock) {
      try {
        writeCancellationRequest(job);
        const result = signalOwnedRun(job);
        if (result.signalled) {
          job.cancelSignalSentAt = nowISO();
          writeJobRecord(job);
        }
      } catch (error) {
        appendLogBestEffort(job, `\n⚠️ 停止訊號尚未送出：${error.message}\n`);
      }
    }
    return false;
  }

  // Even a dead child is not settled until its exit handler has released the shared lock. If a
  // different/unknown lock appears, remember that the workspace may have been overwritten.
  if (lockExists) {
    if (!lockOwner) markDetachedContested(job, 'unknown lock owner');
    else if (Number(lockOwner.pid) !== pid)
      markDetachedContested(job, `lock owner pid ${lockOwner.pid} != detached pid ${pid}`);
    return false;
  }

  // Once another/unknown owner has been observed, the shared workspace can no longer be safely
  // attributed even after its lock disappears. Keep the queue closed for every run type.
  if (job.detachedWorkspaceContested) return false;

  // The spawn record says which run was intended; this persistent marker is written by run.js only
  // after it actually acquires the shared workspace. A missing/different marker is not ownership.
  if (isWorkspaceRunToken(job.workspaceRunToken)) {
    if (!workspaceOwnerBelongsToJob(workspaceOwner, job)) {
      const intentAt = Date.parse(job.workspaceRunStartedAt || '');
      const intentGraceActive = Number.isFinite(intentAt) && Date.now() < intentAt + 30000;
      const hasOwnershipProof = isPidValue(job.detachedOwnerPid)
        || matchingLock;
      // .run.owner.json deliberately survives a completed run. During the narrow spawn-before-pid
      // crash window, a foreign marker is therefore normally just the previous run's stale marker;
      // give the new child time to acquire the lock and replace it before declaring a conflict.
      if (!hasOwnershipProof && intentGraceActive) return false;
      if (workspaceOwner) {
        markDetachedContested(job, 'workspace owner token changed');
        return false;
      }
    } else {
      if (Number(job.pid) !== workspaceOwner.pid) {
        markDetachedContested(job, 'workspace owner pid changed');
        return false;
      }
      if (markDetachedOwnership(job)) writeJobRecord(job);
    }
  }

  const fromStatus = job.detachedFromStatus || (job.preparedAt ? 'rendering' : 'preparing');
  if (fromStatus === 'rendering') return reconcileDetachedRender(job, pid);
  if (job.cancelRequestedAt) {
    try { captureProjectAssets(job); } catch (_) {}
    try { snapshotWorkspace(job); } catch (_) {}
    try { captureAutomationEvidence(job); } catch (_) {}
    settleCancelledJob(job);
    appendLogBestEffort(job, '\n⏹ 背景準備流程已停止；已保留可歸屬的完成成果。\n');
    return true;
  }
  // render-only and skip-generate runs cannot have bought a new speaker output. Finalize them
  // without inspecting a possibly unrelated staging copy left in the shared workspace.
  if (fromStatus !== 'preparing' || job.skipGenerate) {
    completeDetached(job, '\n🔚 背景工作已結束；本輪沒有新的付費 Avatar 需要保存。\n');
    return true;
  }

  const retryAt = Date.parse(job.detachedCaptureRetryAt || '');
  if (Number.isFinite(retryAt) && retryAt > Date.now()) return false;

  const speakerFile = path.join(WORKSPACE_PUBLIC_DIR, 'heygen.mp4');
  let speakerState = 'missing';
  try {
    if (fs.existsSync(speakerFile)) {
      const stat = fs.statSync(speakerFile);
      if (stat.isFile() && stat.size > 0) {
        const media = inspectMediaFile(speakerFile);
        speakerState = media && media.kind === 'video' ? 'valid' : 'invalid';
      } else speakerState = 'empty';
    }
  } catch (error) {
    deferDetachedCapture(job, `無法檢查背景工作的講者影片：${error.message}`);
    return false;
  }

  if (speakerState !== 'valid') {
    completeDetached(job,
      '\n🔚 背景工作已結束，沒有可保存的有效 heygen.mp4；未新增 Project 素材。\n');
    return true;
  }

  // A valid shared-workspace file is destructive to clear. Without ownership proof, preserving it
  // and stopping the queue is safer than either losing a paid output or assigning it to the wrong Project.
  if (Number(job.detachedOwnerPid) !== pid) {
    deferDetachedCapture(job, '有效的背景 Avatar ownership 尚未驗證');
    return false;
  }

  const captured = capturePaidSpeakerAfterFailure({
    job,
    speakerFile,
    projectStore: PROJECT_STORE,
    saveJob,
    // Detached recovery reports its own accurate lifecycle message below.
    appendLog: () => {},
  });
  if (!captured) {
    deferDetachedCapture(job, '有效的背景 Avatar 尚未能保存到原 Project／Revision');
    return false;
  }
  completeDetached(job,
    '\n🛟 背景工作已結束；已先把付費產生的 heygen.mp4 保存到原 Project／Revision。\n');
  return true;
}

/** Update detached jobs and report whether it is safe for tick() to reuse the workspace. */
function refreshDetached() {
  const detached = JOBS.filter((job) => job.status === 'detached');
  if (!detached.length) return true;
  if (detached.length > 1) {
    for (const job of detached) markDetachedContested(job, 'multiple detached jobs');
    return false;
  }
  return reconcileDetached(detached[0]);
}

function appendLog(job, line) {
  const f = path.join(jobDir(job.id), 'log.txt');
  ensureDir(path.dirname(f));
  fs.appendFileSync(f, line.endsWith('\n') ? line : line + '\n');
}

function appendLogBestEffort(job, line) {
  try { appendLog(job, line); return true; } catch (_) { return false; }
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
/** 把 public/ 裡上一支工作留下的東西清掉（套版素材與字型保留） */
function clearWorkspaceInputs() {
  const pub = WORKSPACE_PUBLIC_DIR;
  if (!fs.existsSync(pub)) return;
  for (const n of fs.readdirSync(pub)) {
    if (TEMPLATE_ASSET.test(n)) continue;
    if (/\.(png|jpg|jpeg|mp4|mov|m4v|webm|txt|wav|mp3|m4a|aac)$/i.test(n)) rmrf(path.join(pub, n));
  }
  // 標注檔要指名清掉。不能用 *.json 一律清 —— deeplinks.json 是投廣品牌素材。
  rmrf(path.join(pub, 'annotations.json'));
  rmrf(path.join(pub, 'prepared-phone-material.intent.json'));
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

function readGraphicBrollPlan(baseDir) {
  const file = path.join(baseDir, GRAPHIC_BROLL_PLAN);
  if (!fs.existsSync(file)) throw new Error('找不到 graphic B-Roll plan');
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`graphic B-Roll plan 無法解析：${error.message}`); }
  return { file, plan };
}

function validateGraphicBrollPlanForJob(job, baseDir) {
  const { file, plan } = readGraphicBrollPlan(baseDir);
  const expectedMode = job.workflowMode === 'auto-broll' ? 'card-v1' : 'disabled';
  if (!plan || plan.schemaVersion !== 1 || plan.mode !== expectedMode
      || plan.style !== 'morning-report-v1' || !SHA256_HEX.test(plan.sourceScriptSha256 || '')
      || !Array.isArray(plan.cards))
    throw new Error(`graphic B-Roll plan contract 不符（預期 ${expectedMode}）`);
  const scriptFile = path.join(baseDir, 'public', 'script.txt');
  if (!fs.existsSync(scriptFile) || fileSha256(scriptFile) !== plan.sourceScriptSha256)
    throw new Error('graphic B-Roll plan 的 script hash 與本版講稿不一致');
  if (expectedMode === 'disabled' && plan.cards.length)
    throw new Error('manual flow 的 graphic B-Roll plan 必須為空');
  if (expectedMode === 'card-v1' && !plan.cards.length)
    throw new Error('auto-broll 至少必須有一張 graphic card');
  const ids = new Set();
  for (const card of plan.cards) {
    const placement = card && card.resolvedPlacement;
    if (!card || typeof card.id !== 'string' || !card.id || ids.has(card.id)
        || typeof card.headline !== 'string' || typeof card.body !== 'string'
        || !Number.isInteger(card.startCharIdx) || !Number.isInteger(card.endCharIdx)
        || card.startCharIdx < 0 || card.endCharIdx < card.startCharIdx
        || !placement || !Number.isFinite(placement.startSec)
        || !Number.isFinite(placement.endSec) || placement.startSec < 0
        || placement.endSec <= placement.startSec)
      throw new Error('graphic B-Roll card／placement contract 不完整');
    ids.add(card.id);
  }
  return { plan, planSha256: fileSha256(file) };
}

function validatePreparedPhonePlanForJob(job, baseDir) {
  const file = path.join(baseDir, ...PREPARED_PLAN.split('/'));
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`prepared phone plan 無法解析：${error.message}`); }
  const expectedMode = preparedPhoneMode(job);
  if (!plan || plan.schemaVersion !== 1 || plan.mode !== expectedMode
      || plan.template !== 'focusstock' || plan.timelineBasis !== 'focusstock-main-v1')
    throw new Error(`prepared phone plan contract 不符（預期 ${expectedMode}）`);
  if (expectedMode === 'disabled') {
    if (plan.source !== null || plan.presentation !== null || plan.placement !== null
        || plan.visualOwnership !== null)
      throw new Error('disabled prepared phone plan 必須是空計畫');
    return { plan, planSha256: fileSha256(file) };
  }
  let focusstockShots;
  try {
    focusstockShots = JSON.parse(fs.readFileSync(path.join(
      baseDir, 'src', 'Focusstock', 'focusstock-shots.generated.json'), 'utf8'));
  } catch (_) {
    throw new Error('ready-to-place 缺少 Focusstock shot suppression evidence');
  }
  if (!Array.isArray(focusstockShots) || focusstockShots.length !== 0)
    throw new Error('ready-to-place 不可與一般 Focusstock 截圖／B-Roll 同時出現');
  const result = job.materialAcquisitionResult;
  const source = plan.source;
  const placement = plan.placement;
  const ownership = plan.visualOwnership;
  const pendingEvidence = result?.placementStatus === 'compiled_pending_evidence'
    && result.automaticTimelineUse === false && !result.preparedArtifact?.assetRef;
  const committed = result?.placementStatus === 'compiled'
    && result.automaticTimelineUse === true && !!result.preparedArtifact?.assetRef;
  if (job.template !== 'focusstock' || !result || (!pendingEvidence && !committed)
      || result.compiledPlanFile !== PREPARED_PLAN
      || result.compiledPlanSha256 !== fileSha256(file)
      || plan.contractVersion !== 2 || plan.requestId !== result.requestId
      || plan.presentation?.profileId !== job.materialAcquisition.presentation?.profileId
      || !ownership || ownership.owner !== 'prepared-phone-video'
      || ownership.conflictPolicy !== 'suppress-entire-overlapping-placement'
      || JSON.stringify(ownership.suppressedChannels)
        !== JSON.stringify(['focusstock-shots', 'focusstock-broll'])
      || !source || source.fileName !== 'prepared-phone-material.mp4'
      || source.artifactRole !== 'prepared-video'
      || source.sha256 !== result.preparedArtifact.sha256
      || source.size !== result.preparedArtifact.size
      || !placement || placement.layoutId !== job.materialAcquisition.placement?.layoutId
      || !Number.isFinite(placement.startSec) || placement.startSec < 0
      || !Number.isFinite(placement.endSec) || placement.endSec <= placement.startSec
      || !Number.isInteger(placement.durationInFrames) || placement.durationInFrames < 1
      || placement.playbackRate !== 1 || placement.muted !== true
      || placement.objectFit !== 'contain' || placement.crop !== 'none'
      || placement.trim !== 'none' || placement.loop !== false)
    throw new Error('ready-to-place prepared phone plan 與 Run evidence 不一致');
  const video = path.join(baseDir, 'public', source.fileName);
  if (!fs.existsSync(video) || fileSha256(video) !== source.sha256)
    throw new Error('prepared phone plan 指向的 MP4 bytes 已改變');
  validatePreparedPhonePlacementMath(plan, video);
  return { plan, planSha256: fileSha256(file) };
}

function buildJobRenderInput(job, artifactRoot) {
  return buildRenderInputManifest({
    artifactRoot,
    // Renderer code is executable repository identity, not a Run artifact. Never source it from
    // state/ or restore it into ROOT: a retry must fail closed if the checked-out renderer drifted.
    rendererRoot: ROOT,
    template: job.template,
    compositionId: compositionIdFor(job),
    brand: job.brand || null,
    withAd: !!job.withAd,
    workflowMode: job.workflowMode || 'manual-assets',
    graphicBrollMode: job.workflowMode === 'auto-broll' ? 'card-v1' : 'disabled',
    preparedPhoneMode: preparedPhoneMode(job),
  });
}

function captureAutomationEvidence(job, preparedCandidate = null) {
  const state = path.join(jobDir(job.id), 'state');
  const { plan, planSha256 } = validateGraphicBrollPlanForJob(job, state);
  const graphicBroll = {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    style: plan.style,
    sourceScriptSha256: plan.sourceScriptSha256,
    planSha256,
    cards: plan.cards,
  };
  const timelinePlacements = plan.cards.map((card) => ({
    cardId: card.id,
    startCharIdx: card.startCharIdx,
    endCharIdx: card.endCharIdx,
    startSec: card.resolvedPlacement.startSec,
    endSec: card.resolvedPlacement.endSec,
  }));
  const prepared = validatePreparedPhonePlanForJob(job, state);
  if (prepared.plan.mode === 'ready-to-place') {
    const assetRef = preparedCandidate?.asset?.id
      || job.materialAcquisitionResult?.preparedArtifact?.assetRef;
    if (!assetRef) throw new Error('prepared phone Project Asset 尚未通過候選 ingest');
    timelinePlacements.push(
      buildPreparedPhoneTimelinePlacement(job, prepared.plan, assetRef));
  }
  let renderInputManifest = null;
  let renderInputManifestSha256 = null;
  if (job.workflowMode === 'auto-broll' || preparedPhoneMode(job) === 'ready-to-place') {
    const renderInput = buildJobRenderInput(job, state);
    renderInputManifest = renderInput.manifest;
    renderInputManifestSha256 = renderInput.sha256;
  }
  const previous = {
    assetRefs: [...(job.assetRefs || [])],
    materialAcquisitionResult: JSON.parse(JSON.stringify(job.materialAcquisitionResult || null)),
    graphicBroll: job.graphicBroll,
    timelinePlacements: job.timelinePlacements,
    renderInputManifest: job.renderInputManifest,
    renderInputManifestSha256: job.renderInputManifestSha256,
  };
  try {
    job.graphicBroll = graphicBroll;
    job.timelinePlacements = timelinePlacements;
    job.renderInputManifest = renderInputManifest;
    job.renderInputManifestSha256 = renderInputManifestSha256;
    if (preparedCandidate?.asset) {
      const committedPlacement = commitPreparedPhoneMaterialSelection({
        job, asset: preparedCandidate.asset, plan: prepared.plan, projectStore: PROJECT_STORE,
      });
      job.timelinePlacements[job.timelinePlacements.length - 1] = committedPlacement;
    }
    saveJob(job);
  } catch (error) {
    rollbackPreparedPhoneMaterialSelection(job);
    job.assetRefs = previous.assetRefs;
    job.materialAcquisitionResult = previous.materialAcquisitionResult;
    job.graphicBroll = previous.graphicBroll;
    job.timelinePlacements = previous.timelinePlacements;
    job.renderInputManifest = previous.renderInputManifest;
    job.renderInputManifestSha256 = previous.renderInputManifestSha256;
    try { saveJob(job); } catch (_) {}
    throw error;
  }
}

function verifyRestoredRenderInput(job) {
  if (job.workflowMode !== 'auto-broll' && preparedPhoneMode(job) !== 'ready-to-place') return null;
  if (preparedPhoneMode(job) === 'ready-to-place')
    validatePreparedPhoneProjectAsset({ job, projectStore: PROJECT_STORE });
  if (!SHA256_HEX.test(job.renderInputManifestSha256 || '') || !job.renderInputManifest)
    throw new Error('這個 Run 缺少可追溯的 render input manifest');
  const state = path.join(jobDir(job.id), 'state');
  const { planSha256: statePlanSha256 } = validateGraphicBrollPlanForJob(job, state);
  const { planSha256: restoredPlanSha256 } = validateGraphicBrollPlanForJob(job, ROOT);
  if (statePlanSha256 !== job.graphicBroll?.planSha256
      || restoredPlanSha256 !== statePlanSha256)
    throw new Error('render retry 的 graphic B-Roll plan 已改變，拒絕重新生成或靜默替換');
  const { planSha256: statePreparedSha256 } = validatePreparedPhonePlanForJob(job, state);
  const { planSha256: restoredPreparedSha256 } = validatePreparedPhonePlanForJob(job, ROOT);
  if (statePreparedSha256 !== restoredPreparedSha256)
    throw new Error('render retry 的 prepared phone plan 已改變');
  // Rebuild the same two-root identity as prepare: immutable Run artifacts + the actual checkout.
  // This catches both state tampering and renderer/package-lock drift without ever snapshotting code.
  const current = buildJobRenderInput(job, state);
  if (current.sha256 !== job.renderInputManifestSha256
      || JSON.stringify(current.manifest) !== JSON.stringify(job.renderInputManifest))
    throw new Error('目前 render inputs 與準備階段 manifest 不一致');
  // The renderer consumes ROOT after restore. Verify the immutable state's declared artifact set
  // byte-for-byte, while intentionally ignoring unrelated template assets restore keeps in public/.
  verifyDeclaredFileFingerprints({
    baseDir: ROOT,
    expectedFiles: current.manifest.artifactInputs,
    label: 'restore 後的 render artifact inputs',
  });
  return current;
}

/**
 * 把本次 Run 產生、之後可能會重用的素材收回 Project library。
 * 固定品牌素材由 assets/ 管理，不重複收入 Project；腳本與中間 JSON 也不算素材。
 */
function captureProjectAssets(job) {
  if (!job.projectId) return;
  const publicDir = WORKSPACE_PUBLIC_DIR;
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

/** 防止 stale lock 的 PID 被 OS 回收後，誤把另一個同名 run.js process 當成本輪。 */
function processStartedNear(pid, expectedStartedAt, toleranceMs = 10000) {
  const expected = Date.parse(expectedStartedAt || '');
  if (!Number.isFinite(expected)) return false;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8' }).trim();
    const actual = Date.parse(out);
    return Number.isFinite(actual) && Math.abs(actual - expected) <= toleranceMs;
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
      ? {
          pid: Number(parsed.pid),
          startedAt: parsed.startedAt || null,
          token: isWorkspaceRunToken(parsed.token) ? parsed.token : null,
        }
      : null;
  } catch (_) {
    return null;
  }
}

function writeCancellationRequest(job) {
  if (!isWorkspaceRunToken(job.workspaceRunToken)) return false;
  const files = pipelineEvidenceFiles(job);
  atomicWriteFile(files.cancel, JSON.stringify({
    schemaVersion: 1,
    workspaceRunToken: job.workspaceRunToken,
    requestedAt: job.cancelRequestedAt,
  }, null, 2));
  return true;
}

function signalOwnedRun(job) {
  const active = activeRuns.get(job.id);
  let pid = null;
  if (active && active.token === job.workspaceRunToken
      && Number(active.pid) === Number(job.workspaceRunPid)
      && active.child.exitCode === null && active.child.signalCode === null) {
    pid = Number(active.pid);
  } else {
    // A persistent workspace owner marker can be stale after normal exit. Detached cancellation
    // therefore requires the live lock, the expected run.js command, and the original process
    // start time before signalling a group. A token-bearing stale lock alone is not kill authority.
    const lockOwner = readLockOwner();
    if (lockBelongsToJob(lockOwner, job)
        && isRunJs(lockOwner.pid)
        && processStartedNear(lockOwner.pid, lockOwner.startedAt)) pid = Number(lockOwner.pid);
  }
  if (!isPidValue(pid) || !isPidAlive(pid)) return { signalled: false, reason: 'owned process 尚未可確認' };
  try {
    process.kill(-pid, 'SIGTERM');
    return { signalled: true, pid };
  } catch (error) {
    if (error.code === 'ESRCH') return { signalled: false, reason: 'process 已結束' };
    throw error;
  }
}

function settleCancelledJob(job, { outputs } = {}) {
  transitionJobSafely(job, {
    status: 'cancelled',
    stage: 'cancelled',
    pid: null,
    error: null,
    failedStage: null,
    cancelledAt: job.cancelledAt || nowISO(),
    finishedAt: job.finishedAt || nowISO(),
    ...(outputs ? { outputs } : {}),
  });
}

function expectedRenderOutputs(job) {
  const configured = (TEMPLATES[job.template] && TEMPLATES[job.template].outputs) || [];
  if (job.template === 'focusstock' && !job.withAd)
    return configured.filter((rel) => path.basename(rel) === 'output-focusstock.mp4');
  return configured.slice();
}

function pipelineEvidenceFiles(job, token = job.workspaceRunToken, { create = false } = {}) {
  if (!isWorkspaceRunToken(token)) throw new Error('workspaceRunToken 不合法');
  let dir = ownedJobPayloadDir(job.id, 'pipeline');
  if (!dir) throw new Error('Run pipeline evidence 目錄 ownership 無法確認');
  if (create) {
    ensureDir(dir);
    dir = ownedJobPayloadDir(job.id, 'pipeline');
    if (!dir) throw new Error('Run pipeline evidence 目錄 ownership 無法確認');
  }
  return {
    dir,
    config: path.join(dir, `${token}.config.json`),
    preload: path.join(dir, `${token}.preload.cjs`),
    result: path.join(dir, `${token}.result.json`),
    stage: path.join(dir, `${token}.stage.json`),
    cancel: path.join(dir, `${token}.cancel.json`),
  };
}

// This preload executes inside the same Node process as run.js. Its synchronous exit hook is the
// durable boundary the parent server cannot provide after a restart: it records the real exit code,
// matching workspace owner, and before/after fingerprints for the exact expected outputs.
const PIPELINE_EVIDENCE_PRELOAD = String.raw`'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    do {
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function snapshot(file) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'invalid' };
    return {
      state: 'file',
      size: Number(stat.size),
      sha256: hashFile(file),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      ino: String(stat.ino),
    };
  } catch (error) {
    return { state: error && error.code === 'ENOENT' ? 'missing' : 'error', error: error.message };
  }
}
function changed(before, after) {
  if (!before || before.state !== 'file' || !after || after.state !== 'file')
    return Boolean(after && after.state === 'file');
  return ['size', 'sha256', 'mtimeNs', 'ctimeNs', 'ino'].some((key) => before[key] !== after[key]);
}
const configFile = process.env.WORKSPACE_EVIDENCE_CONFIG;
if (!configFile) throw new Error('WORKSPACE_EVIDENCE_CONFIG is required');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const before = config.outputs.map((output) => snapshot(output.file));
process.once('exit', (exitCode) => {
  try {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(config.ownerFile, 'utf8')); } catch (_) {}
    const outputs = config.outputs.map((output, index) => {
      const after = snapshot(output.file);
      return {
        relativePath: output.relativePath,
        name: path.basename(output.relativePath),
        before: before[index],
        after,
        changedFromBefore: changed(before[index], after),
      };
    });
    const result = {
      schemaVersion: 1,
      jobId: config.jobId,
      projectId: config.projectId,
      revisionId: config.revisionId,
      workspaceRunToken: config.workspaceRunToken,
      runStatus: config.runStatus,
      renderInputManifestSha256: config.renderInputManifestSha256 || null,
      startedAt: config.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: Number.isInteger(exitCode) ? exitCode : 1,
      owner: owner && {
        pid: Number(owner.pid),
        startedAt: owner.startedAt || null,
        token: owner.token || null,
      },
      outputs,
    };
    fs.mkdirSync(path.dirname(config.resultFile), { recursive: true });
    const temp = config.resultFile + '.' + process.pid + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(result, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, config.resultFile);
  } catch (error) {
    try { console.error('completion evidence write failed: ' + error.message); } catch (_) {}
  }
});
`;

function preparePipelineEvidence(job, token) {
  const files = pipelineEvidenceFiles(job, token, { create: true });
  const expectedOutputs = job.status === 'rendering' ? expectedRenderOutputs(job) : [];
  const config = {
    schemaVersion: 1,
    jobId: job.id,
    projectId: job.projectId || null,
    revisionId: job.revisionId || null,
    workspaceRunToken: token,
    runStatus: job.status,
    startedAt: job.workspaceRunStartedAt,
    ownerFile: WORKSPACE_OWNER_FILE,
    resultFile: files.result,
    renderInputManifestSha256: job.status === 'rendering'
      ? (job.renderInputManifestSha256 || null) : null,
    outputs: expectedOutputs.map((relativePath) => ({
      relativePath,
      file: path.join(WORKSPACE_OUTPUT_DIR, path.basename(relativePath)),
    })),
  };
  atomicWriteFile(files.preload, PIPELINE_EVIDENCE_PRELOAD);
  atomicWriteFile(files.config, JSON.stringify(config, null, 2));
  job.workspaceRunEvidenceVersion = 1;
  job.workspaceRunExpectedOutputs = expectedOutputs;
  return files;
}

function readPipelineStage(job) {
  if (!['preparing', 'rendering', 'detached'].includes(job.status)) return job.stage || null;
  if (!isWorkspaceRunToken(job.workspaceRunToken)) return job.stage || null;
  try {
    const file = pipelineEvidenceFiles(job).stage;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return job.stage || null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && value.schemaVersion === 1
      && value.workspaceRunToken === job.workspaceRunToken
      && typeof value.stage === 'string' ? value.stage : (job.stage || null);
  } catch (_) {
    return job.stage || null;
  }
}

function cancelledRunError(job, evidence) {
  const error = new Error('使用者已要求停止這個 Run');
  error.code = 'RUN_CANCELLED';
  error.pipelineEvidence = evidence || null;
  error.failedStage = job.workspaceRunStatus || job.status;
  return error;
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
 * 重開後會先把已產生的講者影片保存到原 Project，再讓下一支使用共用工作區。
 */
function runPipeline(job, args) {
  return new Promise((resolve, reject) => {
    if (job.cancelRequestedAt) return reject(cancelledRunError(job));
    const workspaceRunToken = crypto.randomUUID();
    job.workspaceRunToken = workspaceRunToken;
    job.workspaceRunPid = null;
    job.workspaceRunStatus = job.status;
    job.workspaceRunStartedAt = nowISO();
    const evidenceFiles = preparePipelineEvidence(job, workspaceRunToken);
    const pipelineEntry = TEST_PIPELINE_ENTRY || 'run.js';
    // Persist the job-specific token before spawn. It is only intent until run.js writes the same
    // token into the workspace-owner marker after acquiring .run.lock.
    writeJobRecord(job);
    appendLog(job, `\n$ node ${path.basename(pipelineEntry)} ${args.join(' ')}\n`);
    const logPath = path.join(jobDir(job.id), 'log.txt');
    ensureDir(path.dirname(logPath));
    const fd = fs.openSync(logPath, 'a');
    let child;
    try {
      child = spawn(process.execPath, ['--require', evidenceFiles.preload, pipelineEntry, ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          WORKSPACE_RUN_TOKEN: workspaceRunToken,
          WORKSPACE_EVIDENCE_CONFIG: evidenceFiles.config,
          WORKSPACE_STAGE_FILE: evidenceFiles.stage,
          WORKSPACE_CANCEL_FILE: evidenceFiles.cancel,
        },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      fs.closeSync(fd); // 父程序不需要留著這個 fd，子程序自己有一份
    }
    job.pid = child.pid;
    job.pidArgs = args.join(' ');
    job.workspaceRunPid = child.pid;
    activeRuns.set(job.id, { child, pid: child.pid, token: workspaceRunToken });
    writeJobRecord(job);
    child.unref(); // 不要讓子程序撐住父程序的 event loop
    child.on('error', (error) => {
      const active = activeRuns.get(job.id);
      if (active && active.token === workspaceRunToken) activeRuns.delete(job.id);
      reject(error);
    });
    child.on('close', (code) => {
      const active = activeRuns.get(job.id);
      if (active && active.token === workspaceRunToken) activeRuns.delete(job.id);
      job.pid = null;
      const evidence = readPipelineEvidence(job);
      job.stage = readPipelineStage(job) || job.stage;
      // 完整且可驗證的 render 已先完成時，completion wins；其他情況只有等 child close
      // 後才把停止請求結算成 cancelled，不能在收到 API request 時提前宣稱已停止。
      if (job.cancelRequestedAt
          && !(job.workspaceRunStatus === 'rendering' && evidence.state === 'success'))
        return reject(cancelledRunError(job, evidence));
      if (job.workspaceRunStatus === 'rendering') {
        // A trusted failed result can contain valuable partial output. Let doRender preserve it
        // before the queue advances. Missing/contested evidence cannot prove the workspace safe,
        // so turn it into a retryable fail-closed condition instead of a generic worker failure.
        if (evidence.state === 'failed') return resolve(evidence);
        if (code !== 0 || evidence.state !== 'success') {
          const error = new Error(code !== 0
            ? `run.js 結束碼 ${code}，但 completion evidence 無法安全收割`
            : `run.js completion evidence 無效：${evidence.message}`);
          error.code = 'OUTPUT_EVIDENCE_RETRY';
          error.pipelineEvidence = evidence;
          return reject(error);
        }
        return resolve(evidence);
      }
      if (code !== 0) return reject(new Error(`run.js 結束碼 ${code}，詳見執行記錄`));
      if (evidence.state !== 'success')
        return reject(new Error(`run.js completion evidence 無效：${evidence.message}`));
      return resolve(evidence);
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
const activeRuns = new Map();

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
  // Detached reconciliation owns the shared public/ workspace until it has either durably saved a
  // valid paid Avatar or proved that no valid output exists. Never pick/clear for the next job first.
  let detachedSettled = false;
  try {
    detachedSettled = refreshDetached();
  } catch (error) {
    console.error(`⚠️ 背景工作 recovery 失敗，保留工作區稍後重試：${error.message}`);
  }
  if (!detachedSettled) {
    setTimeout(tick, 2000);
    return;
  }
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
      if (e.code === 'RUN_CANCELLED') {
        const pid = Number(job.workspaceRunPid);
        const matchingLock = lockBelongsToJob(readLockOwner(), job);
        if (isPidValue(pid) && (isPidAlive(pid) || matchingLock)) {
          job.status = 'detached';
          job.detachedFromStatus = e.failedStage || job.workspaceRunStatus || job.status;
          job.pid = pid;
          writeJobRecord(job);
        } else {
          try { settleCancelledJob(job, { outputs: job.outputs || [] }); }
          catch (persistError) {
            job.status = 'failed';
            job.failedStage = e.failedStage || job.workspaceRunStatus || 'preparing';
            job.error = `停止後狀態保存失敗：${persistError.message}`;
            writeJobRecord(job);
          }
        }
        appendLogBestEffort(job, '\n⏹ Run 已停止；已完成的成果與工作快照會保留。\n');
        return;
      }
      if (['OUTPUT_EVIDENCE_RETRY', 'OUTPUT_FALLBACK_RETRY', 'OUTPUT_ARCHIVE_RETRY',
        'OUTPUT_METADATA_RETRY'].includes(e.code)) {
        // The worker has ended, but the shared workspace still contains output that is not safely
        // represented by durable Run/Project state. Reuse detached reconciliation as the one retry
        // gate and do not let finally() advance to another job.
        try { deferNormalRenderRecovery(job, e); }
        catch (persistError) {
          // status was changed in memory before persistence; refreshDetached therefore still keeps
          // this process's queue closed even when the disk itself is temporarily unavailable.
          job.error = `${e.message}；retry state 保存失敗：${persistError.message}`;
          console.error(`⚠️ ${job.error}`);
        }
        return;
      }
      const failedStage = job.status === 'rendering' ? 'rendering' : 'preparing';
      job.status = 'failed';
      job.stage = failedStage;
      job.failedStage = failedStage;
      job.error = e.message;
      try {
        // Machine state is the durable boundary. A diagnostic log must never prevent the Job and
        // Revision from agreeing on the failure state.
        saveJob(job);
      } catch (persistError) {
        if (job.workspaceRunStatus === 'rendering'
            && isWorkspaceRunToken(job.workspaceRunToken)) {
          const retry = new Error(`render failure state 尚未同步：${persistError.message}`);
          try { deferNormalRenderRecovery(job, retry); }
          catch (_) { job.error = retry.message; }
        } else {
          job.error = `${e.message}；failure state 保存失敗：${persistError.message}`;
        }
      }
      appendLogBestEffort(job, '\n❌ ' + job.error + '\n');
    })
    .finally(() => {
      busy = false;
      pruneOldJobsNonFatal('工作結束');
      setTimeout(tick, 200);
    });
}

async function doPrepare(job) {
  job.status = 'preparing';
  job.stage = 'preparing';
  job.startedAt = nowISO();
  saveJob(job);

  if (job.cancelRequestedAt) throw cancelledRunError(job);

  await prepareJobMaterialAcquisition({
    job,
    jobDirectory: jobDir(job.id),
    projectStore: PROJECT_STORE,
    requestIdFactory: () => `capture-${newId()}`,
    nowISO,
    saveJob,
    appendLog,
  });
  if (job.cancelRequestedAt) throw cancelledRunError(job);
  clearWorkspaceInputs();
  copyRecursive(path.join(jobDir(job.id), 'input'), WORKSPACE_PUBLIC_DIR);

  const args = [`--template=${job.template}`, '--stop-before-render'];
  args.push(`--graphic-broll=${job.workflowMode === 'auto-broll' ? 'card-v1' : 'disabled'}`);
  args.push(`--prepared-phone=${preparedPhoneMode(job)}`);
  if (job.brand) args.push(`--brand=${job.brand}`);
  if (job.skipGenerate) args.push('--skip-generate');
  if (job.noSpeed) args.push('--no-speed');
  if (job.withAd) args.push('--with-ad');
  let preparedCandidate = null;
  try {
    await runPipeline(job, args);
    preparedCandidate = finalizePreparedPhoneMaterial({
      job,
      jobDirectory: jobDir(job.id),
      workspaceRoot: ROOT,
      publicDirectory: WORKSPACE_PUBLIC_DIR,
      projectStore: PROJECT_STORE,
    });
    captureProjectAssets(job);
    snapshotWorkspace(job);
    captureAutomationEvidence(job, preparedCandidate);
    job.planView = buildPlanView(job);
  } catch (error) {
    capturePaidSpeakerAfterFailure({
      job,
      speakerFile: path.join(WORKSPACE_PUBLIC_DIR, 'heygen.mp4'),
      projectStore: PROJECT_STORE,
      saveJob,
      appendLog,
    });
    if (error.code === 'RUN_CANCELLED') {
      // The owned process has stopped. Preserve whatever completed before the signal; a partial
      // plan is never treated as valid evidence, but the snapshot remains auditable/recoverable.
      try { captureProjectAssets(job); } catch (_) {}
      try { snapshotWorkspace(job); } catch (_) {}
      try { captureAutomationEvidence(job, preparedCandidate); } catch (_) {}
    }
    throw error;
  }
  job.preparedAt = nowISO();

  if (job.autoApprove) {
    // 一段式：不停下來，直接接著 render
    job.status = 'approved';
    job.stage = 'ready-to-render';
    job.approvedAt = nowISO();
    job.approvedBy = '（自動出片）';
    appendLog(job, '\n⏩ 已勾選「直接出片」，跳過人工確認\n');
  } else {
    job.status = 'review';
    job.stage = 'awaiting-audit';
  }
  saveJob(job);
}

async function doRender(job) {
  job.status = 'rendering';
  job.stage = 'rendering';
  saveJob(job);

  restoreWorkspace(job);
  if (job.pendingEdits && job.pendingEdits.length) {
    applyPlanEdits(job, job.pendingEdits);
    appendLog(job, `\n✏️  已套用 ${job.corrections ? job.corrections.length : 0} 項人工修正\n`);
  }
  verifyRestoredRenderInput(job);
  if (job.cancelRequestedAt) throw cancelledRunError(job);

  const args = [`--template=${job.template}`, '--render-only'];
  args.push(`--graphic-broll=${job.workflowMode === 'auto-broll' ? 'card-v1' : 'disabled'}`);
  args.push(`--prepared-phone=${preparedPhoneMode(job)}`);
  if (job.withAd) args.push('--with-ad');
  let evidence;
  try {
    evidence = await runPipeline(job, args);
  } catch (error) {
    if (error.code === 'RUN_CANCELLED' && error.pipelineEvidence) {
      try {
        const preserved = preserveEvidenceOutputs(job, error.pipelineEvidence);
        if (preserved.length) job.outputs = preserved;
      } catch (preserveError) {
        appendLogBestEffort(job, `\n⚠️ 停止後的 partial output 無法安全保存：${preserveError.message}\n`);
      }
    }
    throw error;
  }
  if (evidence.state !== 'success') {
    let preserved;
    try {
      preserved = preserveEvidenceOutputs(job, evidence);
    } catch (fallbackError) {
      const error = new Error(`render 失敗且 fallback 尚未保存：${fallbackError.message}`);
      error.code = 'OUTPUT_FALLBACK_RETRY';
      error.pipelineEvidence = evidence;
      throw error;
    }
    try {
      transitionJobSafely(job, retryableRenderPatch(job, evidence, preserved));
    } catch (saveError) {
      const error = new Error(`render fallback 已保存，但 retry state 尚未同步：${saveError.message}`);
      error.code = 'OUTPUT_METADATA_RETRY';
      error.pipelineEvidence = evidence;
      throw error;
    }
    appendLogBestEffort(job, `\n⚠️ render 失敗：${evidence.message}；已保留 ${preserved.length} 份可檢查 output，`
      + (job.workflowMode === 'auto-broll'
        ? '可從 render 階段重試，不會重生圖卡。\n'
        : '回到待確認狀態，可人工重新出片。\n'));
    return;
  }
  const finalized = finalizeRenderOutputs(job, evidence);
  try {
    transitionJobSafely(job, {
      finishedAt: finalized.finishedAt,
      outputs: finalized.outputs,
      archived: finalized.archived,
      status: 'done',
      stage: 'done',
      pid: null,
      error: null,
      failedStage: null,
      renderEvidence: {
        schemaVersion: 1,
        renderInputManifestSha256: job.renderInputManifestSha256 || null,
        verifiedAt: finalized.finishedAt,
        outputs: finalized.outputs.map((output) => ({
          name: output.name,
          size: output.size,
          sha256: output.sha256,
        })),
      },
    });
  } catch (error) {
    // A Project metadata write can fail after the immutable output was already committed. Keep a
    // Run-local verified copy before the worker gate advances, so the next job cannot erase the only
    // recoverable reference.
    let fallbackError = null;
    try { preserveEvidenceOutputs(job, evidence); }
    catch (preserveError) { fallbackError = preserveError; }
    const retry = new Error(`Project output metadata 保存失敗：${error.message}`
      + (fallbackError ? `；fallback 保存也失敗：${fallbackError.message}` : ''));
    retry.code = 'OUTPUT_METADATA_RETRY';
    retry.pipelineEvidence = evidence;
    throw retry;
  }
  if (job.archived.length)
    appendLogBestEffort(job, '\n📁 成品庫：\n   ' + job.archived.join('\n   ') + '\n');
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
    let ws;
    try {
      ws = fs.createWriteStream(temp, { fd, autoClose: true });
    } catch (error) {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(temp); } catch (_) {}
      reject(error);
      return;
    }
    let size = 0;
    let settled = false;
    let failure = null;
    const cleanup = () => { try { fs.unlinkSync(temp); } catch (_) {} };
    const rejectAfterClose = () => {
      if (!failure || settled) return;
      // unlinkSync 回來後才 reject；HTTP catch 因此不會在暫存檔仍開啟／存在時先回應。
      cleanup();
      settled = true;
      reject(failure);
    };
    const fail = (error) => {
      if (settled || failure) return;
      failure = error;
      req.unpipe(ws);
      req.resume();
      if (ws.closed) rejectAfterClose();
      else ws.destroy();
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
    req.on('aborted', () => {
      const error = new Error('上傳連線中斷');
      error.statusCode = 400;
      fail(error);
    });
    ws.on('error', fail);
    ws.on('close', () => {
      if (!settled && !failure) {
        failure = new Error('上傳寫入意外中斷');
        failure.statusCode = 500;
      }
      rejectAfterClose();
    });
    ws.on('finish', () => {
      if (settled || failure) return;
      try {
        const validation = validate ? validate(temp) : null;
        fs.renameSync(temp, dest);
        settled = true;
        resolve({ size, validation });
      } catch (error) {
        fail(error);
      }
    });
    try { req.pipe(ws); } catch (error) { fail(error); }
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

function safeDownloadName(originalName, file, mediaType) {
  const actualExtension = extensionForMediaType(mediaType) || path.extname(file).toLowerCase();
  const normalized = String(originalName || '').replace(/\\/g, '/');
  let name = path.basename(normalized)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (!name) name = `download${actualExtension}`;
  if ((!path.extname(name) || path.extname(name) === '.') && actualExtension)
    name = `${name.replace(/\.$/, '')}${actualExtension}`;
  const extension = path.extname(name);
  const extensionChars = Array.from(extension);
  const stemChars = Array.from(extension ? name.slice(0, -extension.length) : name);
  const stemLimit = Math.max(1, 220 - extensionChars.length);
  return stemChars.slice(0, stemLimit).join('') + extensionChars.join('');
}

function projectAssetContentDisposition(originalName, file, mediaType) {
  const name = safeDownloadName(originalName, file, mediaType);
  const extension = path.extname(name).replace(/[^\x20-\x7e]/g, '');
  const ascii = name.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_').trim();
  const fallback = ascii && ascii !== extension ? ascii : `download${extension}`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sendFile(req, res, file, download, downloadName) {
  if (!fs.existsSync(file)) return send(res, 404, { error: '找不到檔案' });
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (download) {
    headers['Content-Disposition'] = downloadName
      ? projectAssetContentDisposition(downloadName.originalName, file, downloadName.mediaType)
      : `attachment; filename="${path.basename(file)}"`;
  }

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

function publicJob(j, options = {}) {
  const {
    pid, pendingEdits, autoPlan, createdAssetRefs,
    workspaceRunPid, workspaceRunStatus, workspaceRunStartedAt, workspaceRunToken,
    workspaceRunEvidenceVersion, workspaceRunExpectedOutputs,
    detachedFromStatus, detachedOwnerPid, detachedWorkspaceContested,
    detachedCaptureAttempts, detachedCaptureRetryAt, cancelSignalSentAt,
    migration, sourceJobDir: _sourceJobDir, sourceRoots: _sourceRoots,
    recordedCompositionEvidence: _recordedCompositionEvidence,
    manifest: _manifest, archived: _archived, outputs = [],
    ...rest
  } = j;
  const safe = {
    ...rest,
    ...(migration ? { migration: publicMigration(migration) } : {}),
    outputs: outputs.map(publicOutput),
    stage: readPipelineStage(j) || rest.stage || null,
    queuePosition: queuePosition(j),
  };
  if (options.includeBrollPrompts && j.projectId && safe.graphicBroll
      && Array.isArray(safe.graphicBroll.cards)) {
    try {
      safe.graphicBroll = attachRecordedBrollPrompts({
        projectDir: PROJECT_STORE.projectDir(j.projectId),
        graphicBroll: safe.graphicBroll,
      });
    } catch (_) {
      safe.graphicBroll = {
        ...safe.graphicBroll,
        cards: safe.graphicBroll.cards.map((card) => ({
          ...card,
          prompt: { status: 'missing' },
        })),
      };
    }
    try {
      const project = PROJECT_STORE.get(j.projectId);
      const revision = PROJECT_STORE.getRevision(j.projectId, j.revisionId);
      const evidence = verifyRecordedCompositionEvidence({ job: j, project, revision });
      if (evidence) safe.recordedCompositionEvidence = evidence;
    } catch (_) {}
  }
  return safe;
}

function publicProject(project) {
  const { assets = [], revisions = [], migration, ...rest } = project;
  return {
    ...rest,
    ...(migration ? { migration: publicMigration(migration) } : {}),
    assets: assets.map(publicAsset),
    revisions: revisions.map((revision) => {
      const { outputs = [], archived: _archived, ...summary } = revision;
      return { ...summary, outputs: outputs.map(publicOutput) };
    }),
  };
}

function publicAsset(asset) {
  const { path: _path, sourcePaths: _sourcePaths, ...safe } = asset;
  return safe;
}

function publicOutput(output) {
  if (!output || typeof output !== 'object') return {};
  const safe = {};
  for (const key of [
    'id', 'name', 'mediaType', 'size', 'sha256', 'role', 'assetRef', 'experimentId',
    'reusable', 'createdAt', 'updatedAt',
  ]) {
    if (['string', 'number', 'boolean'].includes(typeof output[key])) safe[key] = output[key];
  }
  return safe;
}

function publicMigration(migration) {
  if (!migration || typeof migration !== 'object') return null;
  const safe = {};
  for (const key of [
    'id', 'tool', 'version', 'legacyJobId', 'legacyStatus', 'migratedAt', 'legacyRunCount',
  ]) {
    if (['string', 'number', 'boolean'].includes(typeof migration[key])) safe[key] = migration[key];
  }
  return safe;
}

function publicRevision(revision) {
  if (!revision) return revision;
  const { outputs = [], archived: _archived, migration, ...rest } = revision;
  return {
    ...rest,
    ...(migration ? { migration: publicMigration(migration) } : {}),
    outputs: outputs.map(publicOutput),
  };
}

function publicRevisionSummary(projectId, summary) {
  let revision = null;
  try { revision = PROJECT_STORE.getRevision(projectId, summary.id); }
  catch (_) {}
  const source = revision || summary;
  const workflowMode = WORKFLOW_MODES.has(source.workflowMode)
    ? source.workflowMode
    : (source.options && WORKFLOW_MODES.has(source.options.workflowMode)
      ? source.options.workflowMode : null);
  const controlPolicy = CONTROL_POLICIES.has(source.controlPolicy)
    ? source.controlPolicy
    : (source.options && CONTROL_POLICIES.has(source.options.controlPolicy)
      ? source.options.controlPolicy : null);
  const outputs = (source.outputs || summary.outputs || []).map(publicOutput);
  return {
    id: summary.id,
    number: summary.number,
    jobId: summary.jobId || source.jobId || null,
    status: summary.status || source.status || null,
    title: source.title || null,
    createdAt: source.createdAt || summary.createdAt || null,
    updatedAt: source.updatedAt || summary.updatedAt || null,
    submittedAt: source.submittedAt || null,
    startedAt: source.startedAt || null,
    finishedAt: source.finishedAt || null,
    workflowMode,
    controlPolicy,
    source: {
      kind: source.migration ? 'imported' : 'run',
      parentRevisionId: source.parentRevisionId || null,
      experimentId: source.experimentId || null,
      migration: publicMigration(source.migration),
    },
    outputs,
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
      return send(res, 200, {
        project: publicProject(detail.project),
        revision: publicRevision(detail.revision),
        revisionSummaries: (detail.project.revisions || [])
          .map((summary) => publicRevisionSummary(detail.project.id, summary)),
      });
    }

    if (seg[0] === 'api' && seg[1] === 'projects' && seg[2] && seg[3] === 'assets'
        && seg[4] && req.method === 'GET') {
      const project = PROJECT_STORE.get(seg[2]);
      const asset = project && (project.assets || []).find((item) => item.id === seg[4]);
      const file = PROJECT_STORE.assetPath(seg[2], seg[4]);
      if (!asset || !file || !fs.existsSync(file)) return send(res, 404, { error: '找不到素材' });
      const download = url.searchParams.get('dl') === '1';
      return sendFile(req, res, file, download, download ? asset : null);
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      let materialAcquisition = null;
      if (body.materialAcquisition != null) {
        try { materialAcquisition = normalizeMaterialAcquisitionIntent(body.materialAcquisition); }
        catch (error) { return send(res, 400, { error: error.message }); }
      }
      const workflowMode = body.workflowMode == null ? 'manual-assets' : String(body.workflowMode);
      const controlPolicy = body.controlPolicy == null
        ? (body.autoApprove ? 'auto' : 'pause-before-render')
        : String(body.controlPolicy);
      if (!WORKFLOW_MODES.has(workflowMode))
        return send(res, 400, { error: 'workflowMode 不合法' });
      if (!CONTROL_POLICIES.has(controlPolicy))
        return send(res, 400, { error: 'controlPolicy 不合法' });
      if (!TEMPLATES[body.template]) return send(res, 400, { error: '版型不對' });
      if (materialAcquisition?.operation === 'prepared-video' && body.template !== 'focusstock')
        return send(res, 400, { error: 'ready-to-place 手機素材目前只支援焦點股日報' });
      if (materialAcquisition?.operation === 'prepared-video' && !!body.withAd)
        return send(res, 400, { error: 'ready-to-place 手機素材目前不支援 Focusstock 廣告版' });
      if (workflowMode === 'auto-broll' && body.template !== 'default')
        return send(res, 400, { error: '自動圖卡 V1 目前只支援投廣模板（MarketingVideo）' });
      if (workflowMode === 'auto-broll' && materialAcquisition)
        return send(res, 400, { error: '自動圖卡流程只接受講稿與 Avatar MP4，不接受額外素材擷取' });
      if (!body.body || !body.body.trim()) return send(res, 400, { error: '腳本是空的' });
      const placementScriptText = buildScript({
        voice: body.voice, title: body.title, body: body.body,
      });
      if (materialAcquisition?.operation === 'prepared-video') {
        try {
          materialAcquisition = resolvePreparedVideoPlacement(
            materialAcquisition, placementScriptText);
        } catch (error) {
          return send(res, 400, { error: error.message });
        }
      }
      const parentRevisionId = body.parentRevisionId == null || body.parentRevisionId === ''
        ? null : String(body.parentRevisionId);
      if (parentRevisionId && !body.projectId)
        return send(res, 400, { error: '建立新影片時不能指定來源版本' });
      const brand = body.brand ? String(body.brand) : null;
      if (brand && !listBrands().includes(brand))
        return send(res, 400, { error: '品牌不在允許清單中' });
      // 標題：行數一律以版型設定為準；每行字數只有「不能換行」的模板（投廣）才截斷。
      // 會換行的模板讓標題超過上限，交給 composition 自動換行（2026-08-17 使用者定案）。
      const tcfg = TEMPLATES[body.template].title || { lines: 2, per: 12, wrap: true };
      const title = String(body.title || '').split('\n')
        .map((l) => (tcfg.wrap ? l.trim() : l.trim().slice(0, tcfg.per))).filter(Boolean)
        .slice(0, tcfg.lines).join('\n');
      const scriptText = buildScript({ voice: body.voice, title, body: body.body });
      let reuseAssetIds = Array.isArray(body.reuseAssetIds)
        ? [...new Set(body.reuseAssetIds.map(String))] : [];
      const reuseSpeakerAssetId = body.reuseSpeakerAssetId == null || body.reuseSpeakerAssetId === ''
        ? null : String(body.reuseSpeakerAssetId);
      if (workflowMode === 'auto-broll' && reuseAssetIds.length)
        return send(res, 400, { error: '自動圖卡流程不能同時帶入人工圖片或 B-Roll' });
      if (materialAcquisition?.operation === 'prepared-video' && reuseAssetIds.length)
        return send(res, 400, { error: 'ready-to-place 手機素材會取代本版一般圖片／B-Roll' });
      if (reuseAssetIds.length > MAX_REUSED_ASSETS)
        return send(res, 400, { error: `下一版最多可沿用 ${MAX_REUSED_ASSETS} 個圖片與 B-Roll 素材` });
      if (!body.projectId && (reuseAssetIds.length || reuseSpeakerAssetId))
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
      // A prepared phone clip belongs to one compiled placement. Iteration must reacquire a new
      // ready-to-place clip/placement instead of silently carrying the prior Revision's clip as B-roll.
      reuseAssetIds = reuseAssetIds.filter((assetId) => {
        const asset = (project.assets || []).find((item) => item.id === assetId);
        return asset?.role !== 'prepared-phone-video';
      });
      let parentRevision = null;
      if (parentRevisionId) {
        try { parentRevision = PROJECT_STORE.getRevision(project.id, parentRevisionId); }
        catch (_) { return send(res, 400, { error: '來源版本 ID 不合法' }); }
        if (!parentRevision)
          return send(res, 409, { error: '來源版本不屬於這個影片專案' });
      }
      const invalidReuse = reuseAssetIds.find((assetId) => {
        const asset = (project.assets || []).find((item) => item.id === assetId);
        return !isGenericReusableAsset(asset);
      });
      if (invalidReuse) return send(res, 400, {
        error: `素材 ${invalidReuse} 不可作為圖片或 B-Roll 重用；prepared 手機素材只能由 Capture placement 選用`,
      });
      const speakerAsset = reuseSpeakerAssetId
        ? (project.assets || []).find((item) => item.id === reuseSpeakerAssetId) : null;
      if (reuseSpeakerAssetId && (!speakerAsset || speakerAsset.kind !== 'speaker-video'))
        return send(res, 400, { error: `素材 ${reuseSpeakerAssetId} 不可作為講者 Avatar 重用` });
      if (speakerAsset) {
        const speakerFile = PROJECT_STORE.assetPath(project.id, speakerAsset.id);
        const speakerMedia = speakerFile && inspectMediaFile(speakerFile);
        if (!speakerMedia || speakerMedia.mediaType !== 'video/mp4')
          return send(res, 422, { error: `講者 Avatar ${speakerAsset.id} 已損毀或不是 MP4，請重新加入` });
      }
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
            skipGenerate: workflowMode === 'auto-broll' || !!body.skipGenerate || !!speakerAsset,
            noSpeed: !!body.noSpeed,
            withAd: !!body.withAd,
            autoApprove: controlPolicy === 'auto',
            workflowMode,
            controlPolicy,
            graphicBrollMode: workflowMode === 'auto-broll' ? 'card-v1' : 'disabled',
          },
          parentRevisionId,
          ...(materialAcquisition ? { materialAcquisition } : {}),
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
          skipGenerate: workflowMode === 'auto-broll' || !!body.skipGenerate || !!speakerAsset,
          noSpeed: !!body.noSpeed,
          withAd: !!body.withAd,
          brand,
          autoApprove: controlPolicy === 'auto',
          workflowMode,
          controlPolicy,
          graphicBrollMode: workflowMode === 'auto-broll' ? 'card-v1' : 'disabled',
          stage: 'draft',
          assetRefs: [],
          createdAssetRefs: [],
          ...(materialAcquisition ? { materialAcquisition } : {}),
        };
        ensureDir(path.join(jobDir(job.id), 'input'));
        fs.writeFileSync(path.join(jobDir(job.id), 'input', 'script.txt'), scriptText);
        if (speakerAsset) {
          PROJECT_STORE.materializeAsset(project.id, speakerAsset.id,
            path.join(jobDir(job.id), 'input', 'heygen.mp4'));
          job.assetRefs.push(speakerAsset.id);
        }
        let shotIndex = 1;
        let brollIndex = 1;
        for (const assetId of reuseAssetIds) {
          const asset = (project.assets || []).find((item) => item.id === assetId);
          if (!isGenericReusableAsset(asset))
            throw new Error(`素材 ${assetId} 不可由一般素材流程 materialize`);
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
      if (job.workflowMode === 'auto-broll' && name !== 'heygen.mp4')
        return send(res, 409, { error: '自動圖卡流程只接受 Avatar MP4，不接受人工 B-Roll 素材' });
      if (job.materialAcquisition?.operation === 'prepared-video' && name !== 'heygen.mp4')
        return send(res, 409, { error: 'ready-to-place 手機素材不可再混入一般圖片／B-Roll' });
      const limit = spec.limit;
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) return send(res, 413, { error: `上傳檔案超過 ${Math.round(limit / 1048576)} MB 上限` });
      const dest = path.join(jobDir(job.id), 'input', name);
      ensureDir(path.dirname(dest));
      const received = await receiveFile(req, dest, limit, (temp) => validateUpload(temp, name, spec));
      let responseAsset = null;
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
        responseAsset = publicAsset(asset);
      }
      return send(res, 200, { ok: true, name, size: received.size, asset: responseAsset });
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
      job.stage = 'queued';
      job.submittedAt = nowISO();
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
      return send(res, 200, { job: publicJob(job, { includeBrollPrompts: true }) });
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
      job.stage = 'ready-to-render';
      job.approvedAt = nowISO();
      job.approvedBy = (body.by || '').trim() || job.owner;
      saveJob(job);
      tick();
      return send(res, 200, { job: publicJob(job) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'cancel' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status === 'done')
        return send(res, 409, { error: '已完成的 Run 不可改寫為取消' });
      if (job.status === 'cancelled')
        return send(res, 200, { job: publicJob(job) });
      if (['preparing', 'rendering', 'detached'].includes(job.status)) {
        if (!job.cancelRequestedAt) {
          job.cancelRequestedAt = nowISO();
          saveJob(job);
        }
        let stop = { signalled: false, reason: '流程會在下一個安全 checkpoint 停止' };
        try {
          writeCancellationRequest(job);
          stop = signalOwnedRun(job);
          if (stop.signalled && !job.cancelSignalSentAt) {
            job.cancelSignalSentAt = nowISO();
            writeJobRecord(job);
          }
        } catch (error) {
          stop = { signalled: false, reason: error.message };
          appendLogBestEffort(job, `\n⚠️ 停止請求已保存，但訊號尚未送出：${error.message}\n`);
        }
        return send(res, 202, { job: publicJob(job), stopping: true, ...stop });
      }
      settleCancelledJob(job);
      appendLogBestEffort(job, '\n⏹ Run 在下一個 stage 開始前取消；既有成果保留。\n');
      return send(res, 200, { job: publicJob(job) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'retry' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.workflowMode !== 'auto-broll')
        return send(res, 409, { error: 'failed-stage retry 目前只開放 automation-first Run' });
      if (job.status !== 'failed' || !['preparing', 'rendering'].includes(job.failedStage))
        return send(res, 409, { error: '這個 Run 沒有可重試的失敗 stage' });
      if (job.cancelRequestedAt)
        return send(res, 409, { error: '已要求停止的 Run 不可重試' });
      if (job.failedStage === 'rendering') {
        if (!fs.existsSync(path.join(jobDir(job.id), 'state'))
            || !SHA256_HEX.test(job.renderInputManifestSha256 || ''))
          return send(res, 409, { error: 'render 快照或 manifest 已遺失，不能安全只重跑 render' });
        job.status = 'approved';
        job.stage = 'ready-to-render';
        job.approvedAt = nowISO();
        job.approvedBy = '（失敗階段重試）';
      } else {
        job.status = 'queued';
        job.stage = 'queued';
      }
      job.error = null;
      job.failedStage = null;
      job.finishedAt = null;
      saveJob(job);
      appendLogBestEffort(job, `\n↻ 從 ${job.status === 'approved' ? 'render' : 'prepare'} 階段重試；`
        + '既有 Revision 與已完成成果保持不變。\n');
      tick();
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
 * 清掉 Run 的大型 payload（影片、上傳素材、快照），保留 job.json 與執行記錄。
 * 成功的 Project Run 在所有正式 output 都能從 Project 驗證後立即清理；其他 terminal
 * legacy、failed、cancelled Run 仍使用 KEEP_RECENT／KEEP_DAYS；成功 Project Run 未通過
 * durable gate 時保留全部 payload。回傳釋出的位元組數。
 */
function pruneOldJobs() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let freed = 0;
  const verifiedArchiveFile = (output) => {
    if (!output || typeof output !== 'object' || Array.isArray(output)
        || typeof output.archive !== 'string' || !output.archive) return false;
    const file = path.resolve(ROOT, output.archive);
    if (!isWithin(path.resolve(ARCHIVE_DIR), file) && !isWithin(PROJECT_STORE.projectsDir, file))
      return false;
    try {
      const stat = fs.lstatSync(file);
      return (stat.isFile() && stat.size > 0
        && (!Number.isFinite(output.size) || stat.size === output.size)) ? file : false;
    } catch (_) {
      return false;
    }
  };
  const canRemoveRunOutputDir = (dir, outputs, verifiedOutputs) => {
    if (!dir || !fs.existsSync(dir)) return false;
    const indexesByName = new Map();
    outputs.forEach((output, index) => {
      if (output && typeof output.name === 'string' && output.name
          && path.basename(output.name) === output.name)
        indexesByName.set(output.name, index);
    });
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).every((entry) => {
        if (!entry.isFile() || entry.isSymbolicLink() || !indexesByName.has(entry.name)) return false;
        const index = indexesByName.get(entry.name);
        const runFile = path.join(dir, entry.name);
        const durableFile = verifiedOutputs[index];
        return durableFile && fs.statSync(runFile).size === fs.statSync(durableFile).size
          && fileSha256(runFile) === fileSha256(durableFile);
      });
    } catch (_) {
      return false;
    }
  };
  const terminalStatuses = new Set(['done', 'failed', 'cancelled']);
  JOBS.forEach((j, idx) => {
    try {
      // Unknown／active／draft／detached 或 malformed manifest 一律 fail closed，任何 payload 都不碰。
      if (!j || typeof j !== 'object' || Array.isArray(j)
          || typeof j.id !== 'string' || !RUN_ID.test(j.id)
          || !terminalStatuses.has(j.status) || !ownedJobDir(j.id)
          || (j.outputs !== undefined && !Array.isArray(j.outputs))) return;
      const outputs = Array.isArray(j.outputs) ? j.outputs : [];
      if (outputs.some((output) => !output || typeof output !== 'object' || Array.isArray(output)
          || typeof output.name !== 'string' || !output.name
          || path.basename(output.name) !== output.name
          || (output.archive !== undefined
            && (typeof output.archive !== 'string' || !output.archive))
          || (output.size !== undefined
            && (!Number.isFinite(output.size) || output.size <= 0)))) return;
      const verifiedOutputs = outputs.map(verifiedArchiveFile);
      const hasDurableOutputs = outputs.length > 0 && verifiedOutputs.every(Boolean);
      // IDs 可能因 manifest 損壞而遺失；只要 output lexical path 仍指向 Project store，
      // 就不能降級當成 legacy 讓 retention 繞過 Project／Revision durable gate。
      const hasProjectOutputReference = outputs.some((output) => output.archive
        && isWithin(PROJECT_STORE.projectsDir, path.resolve(ROOT, output.archive)));
      const isProjectRun = Boolean(j.projectId || j.revisionId || hasProjectOutputReference);
      let isCompactableProjectRun = false;
      if (j.status === 'done' && j.projectId && j.revisionId && hasDurableOutputs) {
        const project = PROJECT_STORE.get(j.projectId);
        const revision = PROJECT_STORE.getRevision(j.projectId, j.revisionId);
        const revisionOutputs = revision && revision.outputs;
        const projectDir = PROJECT_STORE.projectDir(j.projectId);
        const projectOutputDir = PROJECT_STORE.outputDir(j.projectId);
        const projectStat = fs.lstatSync(projectDir);
        const outputDirStat = fs.lstatSync(projectOutputDir);
        const projectsRootReal = fs.realpathSync(PROJECT_STORE.projectsDir);
        const projectReal = fs.realpathSync(projectDir);
        const projectOutputReal = fs.realpathSync(projectOutputDir);
        isCompactableProjectRun = project && project.id === j.projectId
          && revision && revision.id === j.revisionId && revision.projectId === j.projectId
          && revision.jobId === j.id && revision.runId === j.id
          && revision.status === 'done' && Array.isArray(revisionOutputs)
          && revisionOutputs.length === outputs.length
          && projectStat.isDirectory() && !projectStat.isSymbolicLink()
          && outputDirStat.isDirectory() && !outputDirStat.isSymbolicLink()
          && isWithin(projectsRootReal, projectReal) && projectReal !== projectsRootReal
          && isWithin(projectReal, projectOutputReal) && projectOutputReal !== projectReal
          && new Set(outputs.map((output) => output && output.name)).size === outputs.length
          && outputs.every((output, index) => {
            const file = verifiedOutputs[index];
            if (typeof output.name !== 'string' || !output.name
                || path.basename(output.name) !== output.name
                || !Number.isFinite(output.size) || output.size <= 0 || !file
                || !isWithin(projectOutputReal, fs.realpathSync(file))) return false;
            // Immediate cleanup is intentionally stricter than legacy retention: a symlink or an
            // output recorded only on the Job cannot prove this Revision owns a durable file.
            if (!fs.lstatSync(file).isFile() || fs.statSync(file).size !== output.size) return false;
            return revisionOutputs.some((candidate) => candidate.name === output.name
              && candidate.archive && candidate.size === output.size
              && fs.realpathSync(path.resolve(ROOT, candidate.archive)) === fs.realpathSync(file));
          });
      }
      // Project Run 的成功狀態若未通過嚴格 Project／Revision gate，retention 也不可繞過。
      if (j.status === 'done' && isProjectRun && !isCompactableProjectRun) return;
      const t = Date.parse(j.finishedAt || j.createdAt) || 0;
      const retentionExpired = idx >= KEEP_RECENT && t <= cutoff;
      if (!isCompactableProjectRun && !retentionExpired) return;
      if (isCompactableProjectRun && j.materialAcquisition?.operation === 'prepared-video') {
        const compacted = compactPreparedPhoneAcquisition({
          job: j,
          jobDirectory: jobDir(j.id),
          projectStore: PROJECT_STORE,
          saveJob,
          nowISO,
        });
        if (!compacted?.compacted) return;
        freed += compacted.bytesFreed;
      }
      for (const sub of ['input', 'state', 'thumbs']) {
        const d = ownedJobPayloadDir(j.id, sub);
        if (!d) continue;
        freed += dirSize(d);
        rmrf(d);
      }
      // 只有每一份輸出都能在成品庫驗證時，才可刪除 Run out/。封存失敗或 archive
      // 遺失時，out/ 可能是唯一完成品，不能只因超過 retention 就清掉。
      if (hasDurableOutputs) {
        const d = ownedJobPayloadDir(j.id, 'out');
        if (canRemoveRunOutputDir(d, outputs, verifiedOutputs)) {
          freed += dirSize(d);
          rmrf(d);
        }
      }
      if (retentionExpired && !isCompactableProjectRun) {
        const d = ownedJobPayloadDir(j.id, 'acquisition');
        if (d) {
          freed += dirSize(d);
          rmrf(d);
        }
      }
    } catch (_) {
      // 單一損壞 Job 不得中止其他 cleanup，更不得讓 server 或成功 render 失敗。
    }
  });
  return freed;
}

function pruneOldJobsNonFatal(context) {
  try {
    return pruneOldJobs();
  } catch (error) {
    console.warn(`⚠️ ${context}的 Run cleanup 失敗，保留 payload 稍後重試：${error.message}`);
    return 0;
  }
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
      console.log('     重開後會先保存背景產生的 Avatar，再讓下一支使用工作區。');
    }
    console.log('\n  伺服器已關閉\n');
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  if (envFlag('AUTO_PRUNE_ON_START')) pruneOldJobsNonFatal('啟動時');
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
  console.log('  Project Run：成品驗證後立即清除大型 payload，只留最小紀錄');
  console.log(`  Legacy／失敗／取消 Run：留最近 ${KEEP_RECENT} 支或 ${KEEP_DAYS} 天內`);
  console.log(`  成品庫：    ${ARCHIVE_DIR}/  （不會自動清，這份要自己管）`);
  console.log('  按 Ctrl+C 結束');
  console.log('');
  tick();
});
