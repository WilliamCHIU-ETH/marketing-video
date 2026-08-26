#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const PROJECT_STORE_FILE = path.join(APP_DIR, 'server', 'project-store.js');
const JOB_STORE_FILE = path.join(APP_DIR, 'server', 'job-store.js');
const MORNING_TEMPLATE_BUILD = path.join(
  APP_DIR,
  'config',
  'templates',
  '台股晨報',
  'build-main.mjs',
);
const HF = ['--yes', 'hyperframes@0.8.3'];
const STATE_FILE = 'broll-slot-state.json';
const {
  resolveExistingWithin,
  resolveOutputWithin,
} = require('./path-safety');

export function normalizeRevisionId(value) {
  const match = String(value || '').trim().match(/^v(\d{1,6})$/i);
  if (!match) throw new Error(`Revision ID 不合法：${value}`);
  return `v${String(Number(match[1])).padStart(3, '0')}`;
}

export function normalizeSlot(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 99)
    throw new Error(`slot 必須是 01–99：${value}`);
  return String(number).padStart(2, '0');
}

export function selectBaseRevision(project, requestedId = null) {
  if (!project || !Array.isArray(project.revisions)) throw new Error('Project revisions 不合法');
  const id = requestedId
    ? normalizeRevisionId(requestedId)
    : `v${String(Number(project.latestRevision || 0)).padStart(3, '0')}`;
  const summary = project.revisions.find((item) => item.id === id);
  if (!summary) throw new Error(`找不到 base Revision ${id}`);
  if (summary.status !== 'done') throw new Error(`base Revision ${id} 不是 done`);
  if (!requestedId && Number(summary.number) !== Number(project.latestRevision))
    throw new Error('latestRevision 與最新 summary 不一致');
  return summary;
}

export function visualSegmentsFromLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.segments) || !ledger.segments.length)
    throw new Error('segment ledger 沒有 segments');
  const ids = new Set();
  const visual = [];
  for (const segment of ledger.segments) {
    const mode = segment.visual?.mode ?? 'broll';
    if (!['broll', 'none'].includes(mode))
      throw new Error(`segment ${segment.id} visual.mode 只能是 broll 或 none`);
    if (mode === 'none') continue;
    const slotId = normalizeSlot(segment.id);
    if (ids.has(slotId)) throw new Error(`visual segment id 重複：${slotId}`);
    ids.add(slotId);
    const startSec = Number(segment.startSec);
    const endSec = Number(segment.endSec);
    const durationSec = Number((endSec - startSec).toFixed(4));
    if (![startSec, endSec].every(Number.isFinite) || !(durationSec > 0))
      throw new Error(`visual segment ${slotId} 時間不合法`);
    visual.push({ ...segment, id: slotId, startSec, endSec, durationSec });
  }
  if (!visual.length) throw new Error('segment ledger 沒有 visual segment');
  return visual;
}

export function compareSlotHashes(baseSlots, nextSlots, changedSlot, currentPromptSha256) {
  const slot = normalizeSlot(changedSlot);
  if (!Array.isArray(baseSlots) || !Array.isArray(nextSlots) || baseSlots.length === 0
      || baseSlots.length !== nextSlots.length)
    throw new Error('B-roll provenance 格數不一致');
  const base = new Map(baseSlots.map((item) => [item.slotId, item]));
  const next = new Map(nextSlots.map((item) => [item.slotId, item]));
  if (base.size !== baseSlots.length || next.size !== nextSlots.length)
    throw new Error('B-roll provenance slotId 重複');
  const rows = [];
  for (const [slotId, before] of base) {
    const after = next.get(slotId);
    if (!after) throw new Error(`新 provenance 缺 slot ${slotId}`);
    const same = before.outputSha256 === after.outputSha256;
    if (slotId === slot) {
      if (same) throw new Error(`指定格 ${slot} outputSha256 沒有改變`);
      if (after.promptSha256 !== currentPromptSha256)
        throw new Error(`指定格 ${slot} promptSha256 與當前 prompt.txt 不符`);
    } else if (!same) {
      throw new Error(`非指定格 ${slotId} outputSha256 改變`);
    }
    rows.push({ slotId, result: same ? 'same' : 'diff' });
  }
  return rows.sort((a, b) => a.slotId.localeCompare(b.slotId));
}

export function validateManifestIdentity({ project, revision, output, fileEvidence }) {
  if (!project || !revision || !output || !fileEvidence) throw new Error('manifest identity 輸入不完整');
  const summary = project.revisions?.find((item) => item.id === revision.id);
  if (!summary) throw new Error(`Project summary 缺 ${revision.id}`);
  for (const key of ['id', 'number', 'jobId', 'status']) {
    if (summary[key] !== revision[key]) throw new Error(`summary/revision ${key} 不一致`);
  }
  if (revision.jobId !== revision.runId) throw new Error('revision jobId/runId 不一致');
  if (JSON.stringify(summary.outputs || []) !== JSON.stringify(revision.outputs || []))
    throw new Error('summary/revision outputs 不一致');
  const recorded = revision.outputs?.[0];
  if (!recorded || JSON.stringify(recorded) !== JSON.stringify(output))
    throw new Error('revision outputs[0] 與預期 manifest 不一致');
  for (const key of ['name', 'mediaType', 'size', 'sha256', 'archive']) {
    if (!Object.hasOwn(recorded, key)) throw new Error(`outputs[0] 缺 ${key}`);
  }
  if (recorded.size !== fileEvidence.size || recorded.sha256 !== fileEvidence.sha256)
    throw new Error('outputs[0] size/sha256 與檔案不符');
  return true;
}

export function traceRevisionLineage(revisions, startRevisionId) {
  if (!Array.isArray(revisions)) throw new Error('Revision lineage 輸入不合法');
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  if (byId.size !== revisions.length) throw new Error('Revision lineage ID 重複');
  const chain = [];
  const seen = new Set();
  let currentId = normalizeRevisionId(startRevisionId);
  while (currentId) {
    if (seen.has(currentId)) throw new Error(`Revision lineage cycle：${currentId}`);
    seen.add(currentId);
    const revision = byId.get(currentId);
    if (!revision) throw new Error(`Revision lineage 缺 ${currentId}`);
    chain.push(currentId);
    currentId = revision.parentRevisionId ? normalizeRevisionId(revision.parentRevisionId) : null;
  }
  return chain;
}

export function resolveLineageSource({
  revisionChain,
  slotId,
  fileName,
  sourcesByRevision,
  fallbackSlotsByRevision = {},
}) {
  const slot = normalizeSlot(slotId);
  if (!Array.isArray(revisionChain) || revisionChain.length === 0)
    throw new Error('Revision lineage chain 不可為空');
  for (const revisionId of revisionChain) {
    const fallbackSlots = fallbackSlotsByRevision[revisionId] || [];
    if (fallbackSlots.includes(slot)) continue;
    const candidate = (sourcesByRevision[revisionId] || []).find((item) => item.fileName === fileName);
    if (candidate) return { revisionId, sourcePath: candidate.sourcePath };
  }
  return null;
}

export function validatePromptSnapshotIdentity(rows, expectedCount = rows?.length) {
  if (!Array.isArray(rows) || !Number.isInteger(expectedCount) || expectedCount < 1
      || rows.length !== expectedCount)
    throw new Error(`prompt snapshot 必須正好 ${expectedCount} 格`);
  const ids = new Set();
  for (const row of rows) {
    const slotId = normalizeSlot(row.slotId);
    if (ids.has(slotId)) throw new Error(`prompt snapshot slotId 重複：${slotId}`);
    ids.add(slotId);
    if (!Buffer.isBuffer(row.workingBytes) || !Buffer.isBuffer(row.snapshotBytes))
      throw new Error(`prompt snapshot ${slotId} 缺 byte evidence`);
    if (!row.workingBytes.equals(row.snapshotBytes))
      throw new Error(`prompt snapshot ${slotId} 與工作副本 byte 不一致`);
  }
  return true;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['prepare', 'finish'].includes(command)) throw new Error('子命令必須是 prepare 或 finish');
  const options = { command, mode: 'anchor', preview: false, note: '' };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--preview') { options.preview = true; continue; }
    if (!token.startsWith('--')) throw new Error(`不認得參數：${token}`);
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = inline ?? rest[++index];
    if (value == null || String(value).startsWith('--')) throw new Error(`--${rawKey} 缺值`);
    options[key] = value;
  }
  if (!options.project || !path.isAbsolute(options.project)) throw new Error('--project 必須是絕對路徑');
  if (!options.slot) throw new Error('缺 --slot');
  options.slot = normalizeSlot(options.slot);
  if (options.from) options.from = normalizeRevisionId(options.from);
  if (!['anchor', 'regen'].includes(options.mode)) throw new Error('--mode 只能是 anchor 或 regen');
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

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
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function envFlagValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function resolvedPathIncludingMissing(input) {
  let cursor = path.resolve(input);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(fs.realpathSync(cursor), ...missing);
}

export function resolveRunnerDataDir(env = process.env) {
  const testMode = envFlagValue(env.TEST_MODE);
  if (testMode && !env.DATA_DIR)
    throw new Error('TEST_MODE=1 必須明確指定 DATA_DIR，避免碰到正式 jobs');
  const configured = env.DATA_DIR || 'runtime-data';
  const dataDir = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(APP_DIR, configured);
  const appReal = fs.realpathSync(APP_DIR);
  const dataReal = resolvedPathIncludingMissing(dataDir);
  if (testMode && (dataReal === appReal || isInside(appReal, dataReal)))
    throw new Error('TEST_MODE 的 DATA_DIR 必須位於 repo 外，且不可透過 symlink 指回 repo');
  return dataDir;
}

function assertRegularFile(file, label = file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`缺檔：${label}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 不是安全的一般檔案`);
  return stat;
}

function assertDirectory(dir, label = dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { throw new Error(`缺目錄：${label}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 不是安全的一般目錄`);
  return stat;
}

export function validateProjectDir(input, { dataDir = resolveRunnerDataDir() } = {}) {
  const requested = path.resolve(input);
  const projectsDir = path.join(path.resolve(dataDir), 'projects');
  assertDirectory(projectsDir, 'DATA_DIR/projects');
  assertDirectory(requested, 'Project 目錄');
  const projectsReal = fs.realpathSync(projectsDir);
  const projectReal = fs.realpathSync(requested);
  if (!isInside(projectsReal, projectReal)) throw new Error('Project 不在 DATA_DIR/projects 內');
  const projectFile = path.join(projectReal, 'project.json');
  assertRegularFile(projectFile, 'project.json');
  const project = readJson(projectFile);
  if (project.id !== path.basename(projectReal)) throw new Error('Project ID 與目錄名不一致');
  return { dataDir: path.resolve(dataDir), projectsDir: projectsReal, projectDir: projectReal, project };
}

export function createRunnerStores({ dataDir, nowISO, idFactory }) {
  const { createProjectStore } = require(PROJECT_STORE_FILE);
  const { createJobStore } = require(JOB_STORE_FILE);
  return {
    store: createProjectStore({ dataDir, nowISO, idFactory }),
    jobStore: createJobStore({ dataDir, nowISO }),
  };
}

function safeProjectPath(projectDir, relative, label) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} 必須是 Project 相對路徑`);
  const resolved = path.resolve(projectDir, relative);
  if (!isInside(projectDir, resolved)) throw new Error(`${label} 超出 Project`);
  return resolved;
}

function copyFile(source, target, expectedSha = null) {
  assertRegularFile(source);
  if (expectedSha && hashFile(source) !== expectedSha) throw new Error(`來源 SHA-256 不符：${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (expectedSha && hashFile(target) !== expectedSha) throw new Error(`複製 SHA-256 不符：${target}`);
}

export function stageLedgerAudioSources({ projectDir, workdir, ledger }) {
  if (!ledger || !Array.isArray(ledger.segments)) throw new Error('segment ledger 沒有 segments');
  const uniqueSources = new Map();
  for (const segment of ledger.segments) {
    if (!segment.audio) continue;
    const src = String(segment.audio.src || '');
    if (!src || src.includes('\\') || path.isAbsolute(src))
      throw new Error(`segment ${segment.id} audio.src 必須是 Project 相對 POSIX 路徑`);
    const source = resolveExistingWithin(projectDir, src, `segment ${segment.id} audio.src`, 'file');
    const canonicalSrc = path.relative(projectDir, source).split(path.sep).join('/');
    if (!isInside(projectDir, source) || canonicalSrc.startsWith('../'))
      throw new Error(`segment ${segment.id} audio.src 超出 Project`);
    if (!uniqueSources.has(canonicalSrc)) uniqueSources.set(canonicalSrc, source);
  }

  const rows = [];
  for (const [src, source] of uniqueSources) {
    const sourceStat = assertRegularFile(source, `ledger audio source ${src}`);
    const sha256 = hashFile(source);
    const target = resolveOutputWithin(workdir, src, `staged ledger audio ${src}`);
    if (target === source) throw new Error(`ledger audio source 不可與 staged target 相同：${src}`);
    copyFile(source, target, sha256);
    const targetStat = assertRegularFile(target, `staged ledger audio ${src}`);
    const stagedSha256 = hashFile(target);
    if (targetStat.size !== sourceStat.size || stagedSha256 !== sha256)
      throw new Error(`staged ledger audio identity 不符：${src}`);
    rows.push({ src, size: sourceStat.size, sha256 });
  }
  return rows.sort((a, b) => a.src.localeCompare(b.src));
}

function validateStagedLedgerAudioSources(workdir, rows) {
  if (!Array.isArray(rows)) throw new Error('prepared state 缺 ledger audio source evidence');
  for (const row of rows) {
    const file = resolveExistingWithin(workdir, row.src, `staged ledger audio ${row.src}`, 'file');
    const stat = assertRegularFile(file, `staged ledger audio ${row.src}`);
    if (stat.size !== row.size || hashFile(file) !== row.sha256)
      throw new Error(`staged ledger audio 在 prepare 後改變：${row.src}`);
  }
  return true;
}

function copyDirectoryFiles(source, target) {
  assertDirectory(source);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不複製 symlink：${from}`);
    if (entry.isDirectory()) copyDirectoryFiles(from, to);
    else if (entry.isFile()) copyFile(from, to);
    else throw new Error(`不支援的檔案類型：${from}`);
  }
}

function listRegularFiles(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  assertDirectory(dir);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(extension))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`lineage source 不是一般檔案：${file}`);
      return file;
    })
    .sort();
}

function detectLegacyLineage(projectDir, project, expectedVisualCount) {
  const lineageFile = path.join(projectDir, 'revision-artifacts', 'lineage.json');
  let lineage = {};
  if (fs.existsSync(lineageFile)) {
    assertRegularFile(lineageFile, 'revision-artifacts/lineage.json');
    lineage = readJson(lineageFile);
    if (!lineage || Array.isArray(lineage) || typeof lineage !== 'object')
      throw new Error('revision-artifacts/lineage.json 格式不合法');
  }
  let changed = false;
  for (const summary of project.revisions || []) {
    const artifactRoot = path.join(projectDir, 'revision-artifacts', summary.id);
    if (fs.existsSync(artifactRoot) || lineage[summary.id]) continue;
    const revisionFile = path.join(projectDir, 'revisions', `${summary.id}.json`);
    assertRegularFile(revisionFile, `${summary.id}.json`);
    const revision = readJson(revisionFile);
    if (revision.visualForm !== 'card') continue;
    const legacyRoot = `archive-card-v${Number(summary.number)}`;
    const compositions = `${legacyRoot}/compositions`;
    const renders = `${legacyRoot}/renders`;
    const compositionsDir = safeProjectPath(projectDir, compositions, `${summary.id} legacy compositions`);
    const rendersDir = safeProjectPath(projectDir, renders, `${summary.id} legacy renders`);
    if (listRegularFiles(compositionsDir, '.html').length !== expectedVisualCount
        || listRegularFiles(rendersDir, '.mp4').length !== expectedVisualCount) continue;
    lineage[summary.id] = { sourceRoot: legacyRoot, compositions, renders };
    changed = true;
  }
  if (changed || fs.existsSync(lineageFile)) writeJson(lineageFile, lineage);
  return {
    lineage,
    lineageFile: fs.existsSync(lineageFile) ? lineageFile : null,
    lineageSha256: fs.existsSync(lineageFile) ? hashFile(lineageFile) : null,
  };
}

function loadRevisionLineage(projectDir, project, baseRevision) {
  const revisions = [];
  const seen = new Set();
  let current = baseRevision;
  while (current) {
    if (seen.has(current.id)) throw new Error(`Revision lineage cycle：${current.id}`);
    seen.add(current.id);
    revisions.push(current);
    if (!current.parentRevisionId) break;
    const parentId = normalizeRevisionId(current.parentRevisionId);
    const summary = project.revisions?.find((item) => item.id === parentId);
    if (!summary) throw new Error(`Project summary 缺 lineage parent ${parentId}`);
    const file = path.join(projectDir, 'revisions', `${parentId}.json`);
    assertRegularFile(file, `${parentId}.json`);
    const parent = readJson(file);
    if (parent.id !== parentId || parent.number !== summary.number || parent.status !== 'done')
      throw new Error(`${parentId} lineage identity 不一致`);
    current = parent;
  }
  const chain = traceRevisionLineage(revisions, baseRevision.id);
  return { revisions, chain };
}

function collectSourceHtmlLineage(projectDir, project, base, artifacts, lineageState, expectedVisualCount) {
  const { chain } = loadRevisionLineage(projectDir, project, base.revision);
  const sourcesByRevision = {};
  const fallbackSlotsByRevision = {};
  for (const revisionId of chain) {
    const sources = [];
    const artifactRoot = path.join(projectDir, 'revision-artifacts', revisionId);
    const compositionsDir = path.join(artifactRoot, 'compositions');
    for (const file of listRegularFiles(compositionsDir, '.html')) {
      sources.push({
        fileName: path.basename(file),
        sourcePath: path.relative(projectDir, file).split(path.sep).join('/'),
      });
    }
    const legacy = lineageState.lineage[revisionId];
    if (legacy) {
      const sourceRoot = safeProjectPath(projectDir, legacy.sourceRoot, `${revisionId} lineage sourceRoot`);
      const legacyCompositions = safeProjectPath(
        projectDir,
        legacy.compositions,
        `${revisionId} lineage compositions`,
      );
      const legacyRenders = safeProjectPath(projectDir, legacy.renders, `${revisionId} lineage renders`);
      if (!isInside(sourceRoot, legacyCompositions) || !isInside(sourceRoot, legacyRenders))
        throw new Error(`${revisionId} lineage path 不在 sourceRoot`);
      if (listRegularFiles(legacyCompositions, '.html').length !== expectedVisualCount
          || listRegularFiles(legacyRenders, '.mp4').length !== expectedVisualCount)
        throw new Error(`${revisionId} lineage legacy source 不再是 ${expectedVisualCount} HTML／render`);
      for (const file of listRegularFiles(legacyCompositions, '.html')) {
        sources.push({
          fileName: path.basename(file),
          sourcePath: path.relative(projectDir, file).split(path.sep).join('/'),
        });
      }
    }
    sourcesByRevision[revisionId] = sources;

    const stateFile = path.join(artifactRoot, STATE_FILE);
    if (fs.existsSync(stateFile)) {
      assertRegularFile(stateFile, `${revisionId}/${STATE_FILE}`);
      const state = readJson(stateFile);
      if (state.anchorKind === 'render-wrapper-fallback' && state.slot)
        fallbackSlotsByRevision[revisionId] = [normalizeSlot(state.slot)];
    }
  }

  const rows = artifacts.resolved.map((item) => {
    const fileName = item.name.replace(/\.mp4$/i, '.html');
    const resolved = resolveLineageSource({
      revisionChain: chain,
      slotId: item.slotId,
      fileName,
      sourcesByRevision,
      fallbackSlotsByRevision,
    });
    if (!resolved) return { slotId: item.slotId, fileName, sourceRevisionId: null, sourcePath: null, sourceSha256: null };
    const sourceFile = safeProjectPath(projectDir, resolved.sourcePath, `slot ${item.slotId} lineage HTML`);
    assertRegularFile(sourceFile, `slot ${item.slotId} lineage HTML`);
    return {
      slotId: item.slotId,
      fileName,
      sourceRevisionId: resolved.revisionId,
      sourcePath: resolved.sourcePath,
      sourceSha256: hashFile(sourceFile),
    };
  });
  return { chain, rows, fallbackSlotsByRevision };
}

function collectWorkingPrompts(projectDir, provenance) {
  const rows = [...provenance.slots]
    .sort((a, b) => a.slotId.localeCompare(b.slotId))
    .map((slot) => {
      const promptPath = `slots/${normalizeSlot(slot.slotId)}/prompt.txt`;
      const file = safeProjectPath(projectDir, promptPath, `slot ${slot.slotId} working prompt`);
      const stat = assertRegularFile(file, `slot ${slot.slotId} working prompt`);
      const sha256 = hashFile(file);
      if (sha256 !== slot.promptSha256)
        throw new Error(`slot ${slot.slotId} 工作 prompt 不等於 base provenance；先修正 canonical working copy`);
      return { slotId: slot.slotId, promptPath, sha256, size: stat.size };
    });
  if (rows.length !== provenance.slots.length)
    throw new Error(`working prompt 必須正好 ${provenance.slots.length} 格`);
  return rows;
}

function command(commandName, args, { cwd = APP_DIR, logFile = null, allowFailure = false } = {}) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, output, 'utf8');
  }
  if (result.error) throw result.error;
  const wallTimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (!allowFailure && result.status !== 0)
    throw new Error(`${commandName} ${args.join(' ')} 失敗（exit ${result.status}）\n${output.slice(-4000)}`);
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output,
    wallTimeMs: Number(wallTimeMs.toFixed(3)),
  };
}

function parseJsonEnvelope(text, label) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`${label} 沒有 JSON payload`);
  try { return JSON.parse(text.slice(start)); }
  catch (error) { throw new Error(`${label} JSON 無法解析：${error.message}`); }
}

function ffprobe(file) {
  const result = command('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  const payload = JSON.parse(result.stdout);
  const video = payload.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error(`ffprobe 找不到 video stream：${file}`);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: Number(video.r_frame_rate?.split('/')[0]) / Number(video.r_frame_rate?.split('/')[1]),
    duration: Number(payload.format?.duration),
    size: Number(payload.format?.size),
  };
}

function loadBase(projectDir, project, requestedId) {
  const summary = selectBaseRevision(project, requestedId);
  const revisionFile = path.join(projectDir, 'revisions', `${summary.id}.json`);
  assertRegularFile(revisionFile, `${summary.id}.json`);
  const revision = readJson(revisionFile);
  if (revision.id !== summary.id || revision.number !== summary.number
      || revision.jobId !== summary.jobId || revision.status !== 'done')
    throw new Error(`${summary.id} summary/revision identity 不一致`);
  const provenancePath = revision.graphicBroll?.provenance?.prompts?.path;
  const provenanceFile = safeProjectPath(projectDir, provenancePath, 'base provenance path');
  assertRegularFile(provenanceFile, 'base broll provenance');
  const provenance = readJson(provenanceFile);
  if (provenance.schemaVersion !== 2 || !Array.isArray(provenance.slots)
      || provenance.slots.length < 1)
    throw new Error('base broll provenance 必須是 schemaVersion 2 且至少一格');
  if (revision.graphicBroll?.cards?.length !== provenance.slots.length)
    throw new Error('base Revision graphicBroll.cards 與 provenance 格數不一致');
  return { summary, revision, revisionFile, provenance, provenanceFile };
}

function resolveBaseArtifacts(projectDir, base, slot) {
  const cards = [...base.revision.graphicBroll.cards].sort((a, b) => a.ordinal - b.ordinal);
  const slots = [...base.provenance.slots].sort((a, b) => a.slotId.localeCompare(b.slotId));
  const resolved = cards.map((card) => {
    const slotId = String(card.ordinal).padStart(2, '0');
    const provenance = slots.find((item) => item.slotId === slotId);
    if (!provenance) throw new Error(`base provenance 缺 slot ${slotId}`);
    const source = safeProjectPath(projectDir, card.assetPath, `slot ${slotId} assetPath`);
    const stat = assertRegularFile(source, `slot ${slotId} render`);
    const sha256 = hashFile(source);
    if (sha256 !== card.assetSha256 || sha256 !== provenance.outputSha256 || stat.size !== card.assetSize)
      throw new Error(`slot ${slotId} base render identity 不一致`);
    return { slotId, card, provenance, source, sha256, size: stat.size, name: path.basename(source) };
  });
  const target = resolved.find((item) => item.slotId === slot);
  if (!target) throw new Error(`base Revision 沒有 slot ${slot}`);
  const artifactRoot = path.dirname(path.dirname(target.source));
  const expectedRoot = path.join(projectDir, 'revision-artifacts', base.summary.id);
  if (artifactRoot !== expectedRoot)
    throw new Error(`base ${base.summary.id} asset 不在 revision-artifacts/${base.summary.id}`);
  for (const item of resolved) {
    if (path.dirname(item.source) !== path.join(artifactRoot, 'renders'))
      throw new Error(`slot ${item.slotId} 不在同一個 base artifacts/renders`);
  }
  const mainFile = path.join(artifactRoot, 'index.html');
  const avatarFile = path.join(artifactRoot, 'public', 'input-video.mp4');
  const assetsDir = path.join(artifactRoot, 'assets');
  const hyperframesFile = path.join(artifactRoot, 'hyperframes.json');
  assertRegularFile(mainFile, 'base index.html');
  assertRegularFile(avatarFile, 'base avatar');
  assertDirectory(assetsDir, 'base assets');
  assertRegularFile(hyperframesFile, 'base hyperframes.json');
  return { resolved, target, artifactRoot, mainFile, avatarFile, assetsDir, hyperframesFile };
}

function makeRenderAnchorHtml({ slot, duration, width, height, anchorName }) {
  const id = `br${slot}`;
  return `<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8" />\n<style>\n*{box-sizing:border-box}\nhtml,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}\n#root{position:relative;width:${width}px;height:${height}px;overflow:hidden}\n#visual{position:absolute;inset:0;width:${width}px;height:${height}px}\n#anchor-video{position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:fill}\n</style>\n</head>\n<body>\n<div id="root" data-composition-id="${id}" data-start="0" data-duration="${duration.toFixed(2)}" data-width="${width}" data-height="${height}" data-fps="30">\n  <div id="visual">\n    <video id="anchor-video" class="clip" src="assets/${anchorName}" muted playsinline data-start="0" data-duration="${duration.toFixed(2)}" data-media-start="0" data-track-index="1"></video>\n  </div>\n  <script src="assets/gsap.min.js"></script>\n  <script>\n    (function(){\n      const tl=gsap.timeline({paused:true});\n      window.__timelines=window.__timelines||{};\n      window.__timelines['${id}']=tl;\n    })();\n  </script>\n</div>\n</body>\n</html>\n`;
}

function prepare(options) {
  const dataDir = resolveRunnerDataDir();
  const { projectDir, project } = validateProjectDir(options.project, { dataDir });
  const base = loadBase(projectDir, project, options.from);
  if (Number(base.summary.number) !== Number(project.latestRevision))
    throw new Error('--from 目前只支援 latest done Revision，避免平行 append 造成版本歧義');
  const targetNumber = Number(base.summary.number) + 1;
  const targetRevisionId = `v${String(targetNumber).padStart(3, '0')}`;
  const workdir = path.join(projectDir, 'revision-artifacts', targetRevisionId);
  const provenanceDir = path.join(projectDir, `broll-${targetRevisionId}`);
  const revisionFile = path.join(projectDir, 'revisions', `${targetRevisionId}.json`);
  if (fs.existsSync(workdir) || fs.existsSync(provenanceDir) || fs.existsSync(revisionFile))
    throw new Error(`${targetRevisionId} 已有 artifact/provenance/revision，拒絕覆寫`);
  if (fs.existsSync(path.join(projectDir, 'outputs', `${targetRevisionId}-slot${options.slot}-final.mp4`)))
    throw new Error(`${targetRevisionId} output 已存在，拒絕覆寫`);

  const preferredSegmentLedger = path.join(projectDir, 'segment-ledger.v2.json');
  const segmentLedgerFile = fs.existsSync(preferredSegmentLedger)
    ? preferredSegmentLedger
    : path.join(projectDir, 'segment-ledger.json');
  assertRegularFile(segmentLedgerFile, 'segment ledger');
  const canonicalLedger = readJson(segmentLedgerFile);
  const visualSegments = visualSegmentsFromLedger(canonicalLedger);
  const visualSegmentCount = visualSegments.length;
  const targetSegment = visualSegments.find((segment) => segment.id === options.slot);
  if (!targetSegment) throw new Error(`segment ledger 沒有 visual slot ${options.slot}`);
  const baseSlotIds = [...base.provenance.slots].map((slot) => slot.slotId).sort();
  const ledgerSlotIds = visualSegments.map((segment) => segment.id).sort();
  if (JSON.stringify(baseSlotIds) !== JSON.stringify(ledgerSlotIds))
    throw new Error('segment ledger visual slots 與 base provenance 不一致');

  const artifacts = resolveBaseArtifacts(projectDir, base, options.slot);
  const lineageState = detectLegacyLineage(projectDir, project, visualSegmentCount);
  const sourceLineage = collectSourceHtmlLineage(
    projectDir,
    project,
    base,
    artifacts,
    lineageState,
    visualSegmentCount,
  );
  const workingPromptRows = collectWorkingPrompts(projectDir, base.provenance);
  const targetProbe = ffprobe(artifacts.target.source);
  const expectedDurationSec = targetSegment.durationSec;
  if (Math.abs(targetProbe.duration - expectedDurationSec) > 0.11)
    throw new Error(`slot ${options.slot} base render 時長與 staged-ledger placement 不一致`);

  for (const dir of ['compositions', 'renders', 'qa', 'slots', 'public', 'assets'])
    fs.mkdirSync(path.join(workdir, dir), { recursive: true });
  copyDirectoryFiles(artifacts.assetsDir, path.join(workdir, 'assets'));
  copyFile(artifacts.hyperframesFile, path.join(workdir, 'hyperframes.json'));
  copyFile(artifacts.avatarFile, path.join(workdir, 'public', 'input-video.mp4'));
  const ledgerAudioSources = stageLedgerAudioSources({
    projectDir,
    workdir,
    ledger: canonicalLedger,
  });

  const reuseRows = [];
  for (const item of artifacts.resolved) {
    if (item.slotId === options.slot) continue;
    const target = path.join(workdir, 'renders', item.name);
    copyFile(item.source, target, item.sha256);
    reuseRows.push({ slotId: item.slotId, outputSha256: item.sha256, sourcePath: item.card.assetPath });
    console.log(`slot ${item.slotId} sha256 ${item.sha256}`);
  }

  const promptRow = workingPromptRows.find((row) => row.slotId === options.slot);
  const promptPath = safeProjectPath(projectDir, promptRow.promptPath, 'target working prompt');
  const targetSource = sourceLineage.rows.find((row) => row.slotId === options.slot);
  let anchorHtml = null;
  let anchorKind = null;
  let anchorRender = null;
  let lineageResolvedFrom = targetSource?.sourcePath || null;
  if (options.mode === 'anchor') {
    anchorHtml = path.join(workdir, 'compositions', artifacts.target.name.replace(/\.mp4$/i, '.html'));
    if (targetSource?.sourcePath) {
      const sourceHtml = safeProjectPath(projectDir, targetSource.sourcePath, 'target lineage HTML');
      copyFile(sourceHtml, anchorHtml, targetSource.sourceSha256);
      anchorKind = 'source-html';
    } else {
      const anchorName = `anchor-slot${options.slot}.mp4`;
      anchorRender = path.join(workdir, 'assets', anchorName);
      copyFile(artifacts.target.source, anchorRender, artifacts.target.sha256);
      fs.writeFileSync(anchorHtml, makeRenderAnchorHtml({
        slot: options.slot,
        duration: expectedDurationSec,
        width: targetProbe.width,
        height: targetProbe.height,
        anchorName,
      }), 'utf8');
      anchorKind = 'render-wrapper-fallback';
      lineageResolvedFrom = null;
    }
  }

  const state = {
    schemaVersion: 2,
    status: 'prepared',
    preparedAt: new Date().toISOString(),
    projectId: project.id,
    projectDir,
    baseRevisionId: base.summary.id,
    baseRevisionNumber: base.summary.number,
    targetRevisionId,
    targetRevisionNumber: targetNumber,
    slot: options.slot,
    mode: options.mode,
    workdir,
    baseRevisionFile: path.relative(projectDir, base.revisionFile),
    baseProvenanceFile: path.relative(projectDir, base.provenanceFile),
    baseProvenanceSha256: hashFile(base.provenanceFile),
    baseMainFile: path.relative(projectDir, artifacts.mainFile),
    baseMainSha256: hashFile(artifacts.mainFile),
    segmentLedgerFile: path.relative(projectDir, segmentLedgerFile).split(path.sep).join('/'),
    segmentLedgerSha256: hashFile(segmentLedgerFile),
    ledgerAudioSources,
    visualSegmentCount,
    visualSegmentIds: visualSegments.map((segment) => segment.id),
    baseFinalOutput: base.revision.outputs?.[0] || null,
    visualForm: base.revision.visualForm || null,
    expectedDurationSec,
    targetRenderName: artifacts.target.name,
    targetBaseOutputSha256: artifacts.target.sha256,
    promptPath: promptRow.promptPath,
    promptSha256Before: hashFile(promptPath),
    workingPromptRows,
    revisionLineage: sourceLineage.chain,
    sourceHtmlRows: sourceLineage.rows,
    lineageFile: lineageState.lineageFile
      ? path.relative(projectDir, lineageState.lineageFile).split(path.sep).join('/')
      : null,
    lineageSha256: lineageState.lineageSha256,
    lineageResolvedFrom,
    anchorHtml: anchorHtml ? path.relative(projectDir, anchorHtml) : null,
    anchorKind,
    anchorRender: anchorRender ? path.relative(projectDir, anchorRender) : null,
    reuseRows,
  };
  writeJson(path.join(workdir, STATE_FILE), state);

  const nextCommand = `node ${__filename} finish --project ${JSON.stringify(projectDir)} --slot ${options.slot}`;
  const result = {
    workdir,
    slot: options.slot,
    anchorHtml,
    anchorKind,
    lineageResolvedFrom,
    promptPath: promptRow.promptPath,
    expectedDurationSec,
    ledgerAudioSources,
    nextCommand,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function materializeCompositionSnapshots(projectDir, workdir, state, artifacts, targetSlot) {
  if (!Array.isArray(state.sourceHtmlRows)
      || state.sourceHtmlRows.length !== state.visualSegmentCount)
    throw new Error(`prepared state 缺 ${state.visualSegmentCount} 格 source HTML lineage`);
  const compositionsDir = path.join(workdir, 'compositions');
  const fallbackSlots = [];
  for (const row of state.sourceHtmlRows) {
    const item = artifacts.resolved.find((candidate) => candidate.slotId === row.slotId);
    if (!item) throw new Error(`source HTML lineage 多出 slot ${row.slotId}`);
    const destination = path.join(compositionsDir, row.fileName);
    if (row.slotId === targetSlot) {
      assertRegularFile(destination, `slot ${row.slotId} agent HTML`);
      if (state.anchorKind === 'render-wrapper-fallback') fallbackSlots.push(row.slotId);
      continue;
    }
    if (row.sourcePath) {
      const source = safeProjectPath(projectDir, row.sourcePath, `slot ${row.slotId} lineage HTML`);
      if (hashFile(source) !== row.sourceSha256)
        throw new Error(`slot ${row.slotId} lineage HTML 在 prepare 後改變`);
      copyFile(source, destination, row.sourceSha256);
      continue;
    }
    const probe = ffprobe(item.source);
    const duration = Number((
      item.card.resolvedPlacement.endSec - item.card.resolvedPlacement.startSec
    ).toFixed(4));
    const anchorName = `anchor-slot${row.slotId}.mp4`;
    copyFile(item.source, path.join(workdir, 'assets', anchorName), item.sha256);
    fs.writeFileSync(destination, makeRenderAnchorHtml({
      slot: row.slotId,
      duration,
      width: probe.width,
      height: probe.height,
      anchorName,
    }), 'utf8');
    fallbackSlots.push(row.slotId);
  }
  const files = listRegularFiles(compositionsDir, '.html');
  if (files.length !== state.visualSegmentCount)
    throw new Error(`composition snapshot 不是 ${state.visualSegmentCount} 份：${files.length}`);
  const expectedNames = new Set(state.sourceHtmlRows.map((row) => row.fileName));
  for (const file of files) {
    if (!expectedNames.has(path.basename(file))) throw new Error(`composition snapshot 多出 ${file}`);
  }
  return { count: files.length, fallbackSlots: fallbackSlots.sort() };
}

function snapshotWorkingPrompts(projectDir, workdir, state, base, targetSlot) {
  if (!Array.isArray(state.workingPromptRows)
      || state.workingPromptRows.length !== state.visualSegmentCount)
    throw new Error(`prepared state 缺 ${state.visualSegmentCount} 格 working prompt identity`);
  const baseBySlot = new Map(base.provenance.slots.map((slot) => [slot.slotId, slot]));
  const evidence = state.workingPromptRows.map((before) => {
    const workingFile = safeProjectPath(projectDir, before.promptPath, `slot ${before.slotId} working prompt`);
    const workingBytes = fs.readFileSync(workingFile);
    const workingSha256 = hashFile(workingFile);
    const baseSlot = baseBySlot.get(before.slotId);
    if (!baseSlot) throw new Error(`base provenance 缺 prompt slot ${before.slotId}`);
    if (before.slotId !== targetSlot && workingSha256 !== before.sha256)
      throw new Error(`非指定格 ${before.slotId} working prompt 在 prepare 後改變`);
    if (before.slotId !== targetSlot && workingSha256 !== baseSlot.promptSha256)
      throw new Error(`非指定格 ${before.slotId} working prompt 不等於 base provenance`);
    if (before.slotId === targetSlot && workingSha256 === baseSlot.promptSha256)
      throw new Error(`指定格 ${targetSlot} working prompt 沒有改變`);
    const snapshotPath = `revision-artifacts/${state.targetRevisionId}/slots/${before.slotId}/prompt.txt`;
    const snapshotFile = safeProjectPath(projectDir, snapshotPath, `slot ${before.slotId} prompt snapshot`);
    copyFile(workingFile, snapshotFile);
    const snapshotBytes = fs.readFileSync(snapshotFile);
    return {
      slotId: before.slotId,
      workingPath: before.promptPath,
      snapshotPath,
      workingBytes,
      snapshotBytes,
      promptText: snapshotBytes.toString('utf8'),
      promptSha256: hashFile(snapshotFile),
    };
  });
  validatePromptSnapshotIdentity(evidence, state.visualSegmentCount);
  const snapshotFiles = evidence.map((row) => safeProjectPath(projectDir, row.snapshotPath, 'prompt snapshot'));
  if (new Set(snapshotFiles).size !== state.visualSegmentCount
      || snapshotFiles.some((file) => !fs.statSync(file).isFile()))
    throw new Error(`prompt snapshot 不是 ${state.visualSegmentCount} 份`);
  return evidence;
}

function revalidateWorkingPromptSnapshots(projectDir, evidence) {
  const rows = evidence.map((row) => ({
    slotId: row.slotId,
    workingBytes: fs.readFileSync(safeProjectPath(projectDir, row.workingPath, 'working prompt')),
    snapshotBytes: fs.readFileSync(safeProjectPath(projectDir, row.snapshotPath, 'prompt snapshot')),
  }));
  return validatePromptSnapshotIdentity(rows, evidence.length);
}

function copySlotFixture(workdir, htmlFile, slot) {
  const fixture = path.join(workdir, 'qa', `slot${slot}-project`);
  fs.mkdirSync(path.join(fixture, 'assets'), { recursive: true });
  copyFile(htmlFile, path.join(fixture, 'index.html'));
  copyFile(path.join(workdir, 'hyperframes.json'), path.join(fixture, 'hyperframes.json'));
  copyDirectoryFiles(path.join(workdir, 'assets'), path.join(fixture, 'assets'));
  return fixture;
}

function runHyperframesCheck(projectDir, outputFile) {
  const result = command('npx', [...HF, 'check', projectDir, '--json'], { allowFailure: true });
  const payload = parseJsonEnvelope(result.stdout, 'hyperframes check');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (result.stderr) fs.writeFileSync(`${outputFile}.err`, result.stderr, 'utf8');
  if (result.status !== 0 || !payload.ok) throw new Error(`HyperFrames check FAIL：${outputFile}`);
  return { ...payload, wallTimeMs: result.wallTimeMs };
}

function renderHyperframes(projectDir, outputFile, quality, logFile) {
  const result = command('npx', [...HF, 'render', projectDir, '-o', outputFile, '--quality', quality], { logFile });
  assertRegularFile(outputFile, 'HyperFrames render output');
  return result.wallTimeMs;
}

function inferMainConfig(baseHtml) {
  const compositionId = /data-composition-id=["']([^"']+)["']/.exec(baseHtml)?.[1];
  if (!compositionId) throw new Error('base index.html 缺 data-composition-id');
  const topBar = baseHtml.includes('class="tpl-header-overlay"')
    ? 'header'
    : (baseHtml.includes('class="title-board"') ? 'title-board' : 'none');
  return {
    compositionId,
    topBar,
    intro: baseHtml.includes('id="intro-frame"'),
    bgm: baseHtml.includes('id="bgm"'),
    brollAudio: baseHtml.includes('id="broll-audio-'),
  };
}

export function synchronizeCompositionDuration(html, durationSec) {
  const duration = Number(durationSec);
  if (!(duration > 0)) throw new Error('composition duration 不是正數');
  const rootTag = /<[^>]+\bid=["']root["'][^>]*>/i.exec(String(html));
  if (!rootTag || !/\bdata-duration=["'][^"']+["']/i.test(rootTag[0]))
    throw new Error('composition root 缺 data-duration');
  const updatedTag = rootTag[0].replace(
    /\bdata-duration=["'][^"']+["']/i,
    `data-duration="${Number(duration.toFixed(4))}"`,
  );
  return `${String(html).slice(0, rootTag.index)}${updatedTag}${String(html).slice(rootTag.index + rootTag[0].length)}`;
}

export function deriveCardsFromStagedLedger({ baseCards, nextItems, visualSegments, projectDir }) {
  if (!Array.isArray(baseCards) || !Array.isArray(nextItems) || !Array.isArray(visualSegments)
      || baseCards.length !== visualSegments.length || nextItems.length !== visualSegments.length)
    throw new Error('cards/items/staged visual segments 格數不一致');
  const byId = new Map(visualSegments.map((segment) => [normalizeSlot(segment.id), segment]));
  return baseCards.map((card) => {
    const slotId = normalizeSlot(card.ordinal);
    const segment = byId.get(slotId);
    const item = nextItems.find((candidate) => candidate.slotId === slotId);
    if (!segment || !item) throw new Error(`staged ledger/card 缺 slot ${slotId}`);
    return {
      ...card,
      ...(Array.isArray(segment.charRange) ? {
        startCharIdx: segment.charRange[0],
        endCharIdx: segment.charRange[1],
      } : {}),
      resolvedPlacement: { startSec: segment.startSec, endSec: segment.endSec },
      assetPath: path.relative(projectDir, item.source).split(path.sep).join('/'),
      assetSha256: item.sha256,
      assetSize: item.size,
    };
  });
}

export function createLedgerRenderInputManifest({
  canonicalPath,
  canonicalSha256,
  canonicalVisualForm,
  stagedPath,
  stagedSha256,
  stagedVisualForm,
  targetSegment,
}) {
  const manifest = {
    schemaVersion: 1,
    kind: 'broll-slot-ledger-v1',
    canonicalLedger: { path: canonicalPath, sha256: canonicalSha256 },
    stagingTransform: {
      visualForm: {
        from: canonicalVisualForm || null,
        to: stagedVisualForm || null,
        applied: canonicalVisualForm !== stagedVisualForm,
      },
    },
    stagedLedger: { path: stagedPath, sha256: stagedSha256 },
    targetVisual: {
      id: targetSegment.id,
      startSec: targetSegment.startSec,
      endSec: targetSegment.endSec,
      durationSec: targetSegment.durationSec,
    },
    hyperframes: { version: '0.8.3' },
  };
  return { manifest, sha256: hashJson(manifest) };
}

function stageMainBuildInputs({ projectDir, workdir, state, base }) {
  const segmentSource = safeProjectPath(projectDir, state.segmentLedgerFile, 'segmentLedgerFile');
  const canonicalSha256 = hashFile(segmentSource);
  if (canonicalSha256 !== state.segmentLedgerSha256)
    throw new Error('segment ledger 在 prepare 後改變');
  const ledger = readJson(segmentSource);
  if (!Array.isArray(ledger.segments) || !ledger.segments.length)
    throw new Error('segment ledger 沒有 segments');
  const canonicalVisualForm = ledger.visualForm || null;
  if (base.revision.visualForm) ledger.visualForm = base.revision.visualForm;
  const stagedFile = path.join(workdir, 'segment-ledger.json');
  writeJson(stagedFile, ledger);
  const stagedPath = path.relative(projectDir, stagedFile).split(path.sep).join('/');
  const stagedSha256 = hashFile(stagedFile);
  const visualSegments = visualSegmentsFromLedger(ledger);
  if (visualSegments.length !== state.visualSegmentCount)
    throw new Error('staged ledger visual segment 格數與 prepare 不一致');
  const targetSegment = visualSegments.find((segment) => segment.id === state.slot);
  if (!targetSegment) throw new Error(`staged ledger 缺 target slot ${state.slot}`);
  copyFile(
    path.join(projectDir, 'caption-ledger.json'),
    path.join(workdir, 'caption-ledger.json'),
  );
  copyFile(
    path.join(projectDir, 'script', 'script.v1.txt'),
    path.join(workdir, 'script', 'script.v1.txt'),
  );
  const baseMainFile = safeProjectPath(projectDir, state.baseMainFile, 'baseMainFile');
  const config = inferMainConfig(fs.readFileSync(baseMainFile, 'utf8'));
  writeJson(path.join(workdir, 'main.config.json'), config);
  const renderInput = createLedgerRenderInputManifest({
    canonicalPath: state.segmentLedgerFile,
    canonicalSha256,
    canonicalVisualForm,
    stagedPath,
    stagedSha256,
    stagedVisualForm: ledger.visualForm || null,
    targetSegment,
  });
  return {
    segmentLedger: {
      canonical: renderInput.manifest.canonicalLedger,
      staged: renderInput.manifest.stagedLedger,
    },
    stagingTransform: renderInput.manifest.stagingTransform,
    visualForm: ledger.visualForm || 'card',
    visualSegmentCount: visualSegments.length,
    config,
    visualSegments,
    targetSegment,
    renderInputManifest: renderInput.manifest,
    renderInputManifestSha256: renderInput.sha256,
  };
}

function captureQaFrames(renderFile, qaDir, slot, duration) {
  fs.mkdirSync(qaDir, { recursive: true });
  for (const [label, fraction] of [['early', 0.15], ['mid', 0.5], ['hold', 0.9]]) {
    const at = (duration * fraction).toFixed(3);
    command('ffmpeg', [
      '-y', '-v', 'error', '-ss', at, '-i', renderFile, '-frames:v', '1',
      path.join(qaDir, `${slot}-${label}.png`),
    ]);
  }
}

function formatJobId(slot, revisionId, date = new Date()) {
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 16).replace(':', '')}`;
  return `slot-${slot}-${revisionId}-${stamp}`;
}

function verifyFinalMedia(finalFile, baseFile) {
  const actual = ffprobe(finalFile);
  const base = ffprobe(baseFile);
  if (actual.width !== 1080 || actual.height !== 1920)
    throw new Error(`成片尺寸不是 1080x1920：${actual.width}x${actual.height}`);
  if (Math.abs(actual.duration - base.duration) >= 0.1)
    throw new Error(`成片時長與 base 差 ${Math.abs(actual.duration - base.duration).toFixed(6)}s`);
  return { actual, base, durationDiffSec: Math.abs(actual.duration - base.duration) };
}

function fileEvidence(file) {
  const stat = assertRegularFile(file);
  return { size: stat.size, sha256: hashFile(file) };
}

export function createRetrySafeFinalOutput(finalFile, { token = crypto.randomUUID() } = {}) {
  const target = path.resolve(finalFile);
  const parent = path.dirname(target);
  assertDirectory(parent, 'final output parent');
  if (fs.existsSync(target)) throw new Error(`output 已存在，拒絕覆寫：${target}`);
  const extension = path.extname(target) || '.mp4';
  const stem = path.basename(target, path.extname(target));
  const safeToken = String(token).replace(/[^a-zA-Z0-9_-]+/g, '-');
  const tempFile = path.join(parent, `.${stem}.${process.pid}.${safeToken}.tmp${extension}`);
  if (fs.existsSync(tempFile)) throw new Error(`temporary output 已存在：${tempFile}`);
  let published = false;

  const matches = (file, expected) => {
    try {
      const actual = fileEvidence(file);
      return actual.size === expected?.size && actual.sha256 === expected?.sha256;
    } catch { return false; }
  };

  return {
    finalFile: target,
    tempFile,
    publish(expected) {
      if (!matches(tempFile, expected)) throw new Error('temporary output 與驗證 evidence 不一致');
      if (fs.existsSync(target)) throw new Error(`output 已存在，拒絕覆寫：${target}`);
      fs.linkSync(tempFile, target);
      published = true;
      try {
        if (!matches(target, expected)) throw new Error('published output 與驗證 evidence 不一致');
        fs.unlinkSync(tempFile);
        return target;
      } catch (error) {
        if (matches(target, expected)) fs.unlinkSync(target);
        published = false;
        throw error;
      }
    },
    rollback(expected) {
      const result = { removedTemp: false, removedPublished: false, publishedConflict: false };
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
        result.removedTemp = true;
      }
      if (published && fs.existsSync(target)) {
        if (matches(target, expected)) {
          fs.unlinkSync(target);
          result.removedPublished = true;
          published = false;
        } else {
          result.publishedConflict = true;
        }
      }
      return result;
    },
  };
}

function rollbackDraft(store, projectId, revisionId) {
  const revision = store.getRevision(projectId, revisionId);
  if (!revision) return { aborted: false, reason: 'revision-not-found' };
  if (revision.status !== 'draft') {
    store.updateRevision(projectId, revisionId, { status: 'draft', outputs: [], archived: [] });
  }
  return { aborted: true, result: store.abortRevision(projectId, revisionId) };
}

function finish(options) {
  const finishStartedAt = process.hrtime.bigint();
  const dataDir = resolveRunnerDataDir();
  const { projectDir, project } = validateProjectDir(options.project, { dataDir });
  const targetNumber = Number(project.latestRevision) + 1;
  const targetRevisionId = `v${String(targetNumber).padStart(3, '0')}`;
  const workdir = path.join(projectDir, 'revision-artifacts', targetRevisionId);
  const stateFile = path.join(workdir, STATE_FILE);
  assertRegularFile(stateFile, `${targetRevisionId}/${STATE_FILE}`);
  const state = readJson(stateFile);
  if (state.schemaVersion !== 2 || state.status !== 'prepared' || state.projectId !== project.id
      || state.slot !== options.slot || state.targetRevisionId !== targetRevisionId
      || state.baseRevisionNumber !== project.latestRevision)
    throw new Error('prepared state 與目前 Project/slot/latestRevision 不一致');

  const base = loadBase(projectDir, project, state.baseRevisionId);
  if (hashFile(base.provenanceFile) !== state.baseProvenanceSha256)
    throw new Error('base provenance 在 prepare 後改變');
  if (state.lineageFile) {
    const lineageFile = safeProjectPath(projectDir, state.lineageFile, 'lineageFile');
    if (hashFile(lineageFile) !== state.lineageSha256)
      throw new Error('source lineage map 在 prepare 後改變');
  }
  const baseMainFile = safeProjectPath(projectDir, state.baseMainFile, 'baseMainFile');
  if (hashFile(baseMainFile) !== state.baseMainSha256) throw new Error('base index.html 在 prepare 後改變');
  validateStagedLedgerAudioSources(workdir, state.ledgerAudioSources);
  const mainBuild = stageMainBuildInputs({ projectDir, workdir, state, base });
  if (Math.abs(mainBuild.targetSegment.durationSec - state.expectedDurationSec) > 0.0001)
    throw new Error('staged ledger target duration 與 prepare 不一致');
  const artifacts = resolveBaseArtifacts(projectDir, base, options.slot);
  const compositionSnapshots = materializeCompositionSnapshots(
    projectDir,
    workdir,
    state,
    artifacts,
    options.slot,
  );
  const promptSnapshots = snapshotWorkingPrompts(projectDir, workdir, state, base, options.slot);
  const targetPrompt = promptSnapshots.find((row) => row.slotId === options.slot);
  if (!targetPrompt) throw new Error(`prompt snapshots 缺 slot ${options.slot}`);
  const promptSha256 = targetPrompt.promptSha256;
  const htmlFile = state.anchorHtml
    ? safeProjectPath(projectDir, state.anchorHtml, 'anchorHtml')
    : path.join(workdir, 'compositions', state.targetRenderName.replace(/\.mp4$/i, '.html'));
  assertRegularFile(htmlFile, '指定格新 HTML');
  const synchronizedHtml = synchronizeCompositionDuration(
    fs.readFileSync(htmlFile, 'utf8'),
    mainBuild.targetSegment.durationSec,
  );
  fs.writeFileSync(htmlFile, synchronizedHtml, 'utf8');

  const timings = { hyperframesVersion: '0.8.3', stages: {} };
  const recordTiming = (name, wallTimeMs) => {
    timings.stages[name] = { wallTimeMs };
    console.log(`TIMING ${name} wallTimeMs=${wallTimeMs} hyperframes=0.8.3`);
  };
  const quality = options.preview ? 'draft' : 'high';
  const fixture = copySlotFixture(workdir, htmlFile, options.slot);
  const slotCheckFile = path.join(workdir, 'qa', `check-slot${options.slot}.json`);
  const slotCheck = runHyperframesCheck(fixture, slotCheckFile);
  recordTiming('slot-check', slotCheck.wallTimeMs);
  const targetRender = path.join(workdir, 'renders', state.targetRenderName);
  const slotRenderWallTimeMs = renderHyperframes(
    fixture,
    targetRender,
    quality,
    path.join(workdir, 'qa', `render-slot${options.slot}.log`),
  );
  recordTiming('slot-render', slotRenderWallTimeMs);
  const slotProbe = ffprobe(targetRender);
  if (Math.abs(slotProbe.duration - mainBuild.targetSegment.durationSec) > 0.11)
    throw new Error(`指定格 render 時長 ${slotProbe.duration}s 不符合 ${mainBuild.targetSegment.durationSec}s`);
  captureQaFrames(targetRender, path.join(workdir, 'qa', 'frames'), options.slot, slotProbe.duration);

  const nextItems = artifacts.resolved.map((item) => {
    if (item.slotId === options.slot) return { ...item };
    const reused = path.join(workdir, 'renders', item.name);
    assertRegularFile(reused, `${targetRevisionId} reused slot ${item.slotId}`);
    if (hashFile(reused) !== item.sha256)
      throw new Error(`${targetRevisionId} reused slot ${item.slotId} SHA-256 不符`);
    return { ...item, source: reused };
  });
  const changed = nextItems.find((item) => item.slotId === options.slot);
  changed.source = targetRender;
  changed.sha256 = hashFile(targetRender);
  changed.size = fs.statSync(targetRender).size;
  const mainBuildCommand = command('node', [MORNING_TEMPLATE_BUILD, '--project', workdir], {
    cwd: APP_DIR,
    logFile: path.join(workdir, 'qa', 'build-main.log'),
  });
  recordTiming('template-build', mainBuildCommand.wallTimeMs);
  assertRegularFile(path.join(workdir, 'index.html'), 'template build-main output');

  const mainCheckFile = path.join(workdir, 'qa', 'check-main.json');
  const mainCheck = runHyperframesCheck(workdir, mainCheckFile);
  recordTiming('main-check', mainCheck.wallTimeMs);
  const slug = `slot${options.slot}`;
  const finalFile = path.join(projectDir, 'outputs', `${targetRevisionId}-${slug}-final.mp4`);
  const outputAttempt = createRetrySafeFinalOutput(finalFile);
  let outputEvidence = null;
  try {
    const mainRenderWallTimeMs = renderHyperframes(
      workdir,
      outputAttempt.tempFile,
      quality,
      path.join(workdir, 'qa', 'render-main.log'),
    );
    recordTiming('main-render', mainRenderWallTimeMs);
    timings.finishThroughRenderWallTimeMs = Number(
      (Number(process.hrtime.bigint() - finishStartedAt) / 1e6).toFixed(3),
    );
    writeJson(path.join(workdir, 'qa', 'timings.json'), timings);

  const baseOutput = base.revision.outputs?.[0];
  if (!baseOutput?.archive) throw new Error('base Revision 缺 outputs[0].archive');
  const baseFinalFile = path.resolve(APP_DIR, baseOutput.archive);
  const projectOutputsDir = path.join(projectDir, 'outputs');
  assertDirectory(projectOutputsDir, 'Project outputs');
  if (!isInside(projectOutputsDir, baseFinalFile))
    throw new Error('base output archive 超出目前 DATA_DIR 的 Project outputs');
  assertRegularFile(baseFinalFile, 'base final output');
  const media = verifyFinalMedia(outputAttempt.tempFile, baseFinalFile);

  revalidateWorkingPromptSnapshots(projectDir, promptSnapshots);
  const promptSnapshotBySlot = new Map(promptSnapshots.map((row) => [row.slotId, row]));
  const nextSlots = base.provenance.slots.map((slot) => {
    const item = nextItems.find((candidate) => candidate.slotId === slot.slotId);
    const prompt = promptSnapshotBySlot.get(slot.slotId);
    if (!item || !prompt) throw new Error(`${targetRevisionId} provenance evidence 缺 slot ${slot.slotId}`);
    return {
      slotId: slot.slotId,
      promptPath: prompt.snapshotPath,
      outputPath: path.relative(projectDir, item.source).split(path.sep).join('/'),
      promptText: prompt.promptText,
      promptSha256: prompt.promptSha256,
      outputSha256: item.sha256,
    };
  });
  const hashRows = compareSlotHashes(base.provenance.slots, nextSlots, options.slot, promptSha256);
  const provenanceFile = path.join(projectDir, `broll-${targetRevisionId}`, 'broll-provenance.json');
  writeJson(provenanceFile, {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    capturedBy: 'app/scripts/broll-slot.mjs finish',
    slots: nextSlots,
  });

  outputEvidence = fileEvidence(outputAttempt.tempFile);
  const output = {
    name: 'final.mp4',
    mediaType: 'video/mp4',
    size: outputEvidence.size,
    sha256: outputEvidence.sha256,
    archive: path.relative(APP_DIR, finalFile).split(path.sep).join('/'),
  };
  const cards = deriveCardsFromStagedLedger({
    baseCards: base.revision.graphicBroll.cards,
    nextItems,
    visualSegments: mainBuild.visualSegments,
    projectDir,
  });
  revalidateWorkingPromptSnapshots(projectDir, promptSnapshots);
  const fallbackNote = compositionSnapshots.fallbackSlots.length > 0
    ? `source HTML lineage 走完仍缺；slot ${compositionSnapshots.fallbackSlots.join(', ')} 使用 render-wrapper-fallback。`
    : '';

  const revisionTitle = `${base.revision.title || project.name}（slot ${options.slot} 單格迭代）`;
  const unchangedVisualCount = mainBuild.visualSegmentCount - 1;
  const revisionNote = [
    `broll-slot：以 ${base.summary.id} 為 base，只重生 slot ${options.slot}，其餘 ${unchangedVisualCount} 格逐 byte 沿用；未呼叫 HeyGen。`,
    fallbackNote,
    options.note ? String(options.note).trim() : '',
  ].filter(Boolean).join(' ');
  const nowISO = () => new Date().toISOString();
  const idFactory = () => 'broll-slot-idfactory-unused';
  const { store, jobStore } = createRunnerStores({ dataDir, nowISO, idFactory });
  const jobId = formatJobId(options.slot, targetRevisionId);
  let added = false;
  try {
    outputAttempt.publish(outputEvidence);
    const revision = store.addRevision(project.id, {
      jobId,
      runId: jobId,
      status: 'draft',
      owner: base.revision.owner,
      title: revisionTitle,
      options: {
        ...(base.revision.options || {}),
        skipGenerate: true,
        noSpeed: true,
      },
      parentRevisionId: base.summary.id,
      assetRefs: base.revision.assetRefs || [],
      files: [],
      visualForm: base.revision.visualForm || null,
      paidProviderCalls: 0,
      note: revisionNote,
      renderInputManifest: mainBuild.renderInputManifest,
      renderInputManifestSha256: mainBuild.renderInputManifestSha256,
      graphicBroll: {
        ...base.revision.graphicBroll,
        style: `${base.revision.graphicBroll.style || 'composition-v1'}-slot-${options.slot}`,
        cards,
        provenance: {
          ...(base.revision.graphicBroll.provenance || {}),
          level: `broll-slot-${targetRevisionId}`,
          plan: mainBuild.segmentLedger.staged,
          prompts: {
            path: path.relative(projectDir, provenanceFile).split(path.sep).join('/'),
            schemaVersion: 2,
            slotCount: mainBuild.visualSegmentCount,
          },
          renderEvidence: path.relative(projectDir, path.join(workdir, 'qa')).split(path.sep).join('/'),
        },
      },
      outputs: [],
      archived: [],
      submittedAt: null,
      startedAt: null,
      finishedAt: null,
    });
    added = true;
    if (revision.id !== targetRevisionId || revision.number !== targetNumber || revision.status !== 'draft')
      throw new Error('addRevision 沒有建立預期的 draft Revision');

    const finishedAt = nowISO();
    const updated = store.updateRevision(project.id, targetRevisionId, {
      jobId,
      runId: jobId,
      status: 'done',
      outputs: [output],
      archived: [output.archive],
      finishedAt,
      deliverable: {
        path: path.relative(projectDir, finalFile).split(path.sep).join('/'),
        sha256: output.sha256,
        sizeBytes: output.size,
        width: media.actual.width,
        height: media.actual.height,
        durationSec: media.actual.duration,
        visualForm: base.revision.visualForm || null,
      },
      qa: {
        slotCheck: path.relative(projectDir, slotCheckFile).split(path.sep).join('/'),
        mainCheck: path.relative(projectDir, mainCheckFile).split(path.sep).join('/'),
        slotFrames: path.relative(projectDir, path.join(workdir, 'qa', 'frames')).split(path.sep).join('/'),
        brollProvenance: `${mainBuild.visualSegmentCount}/${mainBuild.visualSegmentCount}; ${unchangedVisualCount} same as ${base.summary.id}; slot ${options.slot} different`,
      },
    });
    if (!updated) throw new Error('Revision done state 無法寫入');
    const job = {
      id: jobId,
      template: 'tw-morning-report',
      owner: updated.owner,
      title: updated.title,
      status: 'done',
      createdAt: revision.createdAt,
      startedAt: revision.createdAt,
      finishedAt,
      projectId: project.id,
      revisionId: targetRevisionId,
      revisionNumber: targetNumber,
      outputs: updated.outputs,
      files: updated.files || [],
      assetRefs: updated.assetRefs || [],
      workflowMode: 'agent-broll-slot',
      note: revisionNote,
      skipGenerate: true,
      noSpeed: true,
      withAd: !!updated.options?.withAd,
      autoApprove: !!updated.options?.autoApprove,
      controlPolicy: updated.options?.controlPolicy || 'pause-before-render',
      graphicBrollMode: updated.options?.graphicBrollMode || 'disabled',
      focusstockBrollMode: updated.options?.focusstockBrollMode || 'disabled',
      archived: updated.archived || [],
      graphicBroll: updated.graphicBroll || null,
      renderInputManifest: mainBuild.renderInputManifest,
      renderInputManifestSha256: mainBuild.renderInputManifestSha256,
    };
    jobStore.saveJob(job, { projectStore: store });
    revalidateWorkingPromptSnapshots(projectDir, promptSnapshots);
    const savedProject = store.get(project.id);
    const savedRevision = store.getRevision(project.id, targetRevisionId);
    const savedJob = jobStore.readJob(jobId);
    if (!savedJob || savedJob.projectId !== project.id || savedJob.revisionId !== targetRevisionId
        || savedJob.revisionNumber !== targetNumber || savedJob.id !== savedRevision.jobId
        || savedRevision.runId !== savedJob.id
        || JSON.stringify(savedJob.outputs) !== JSON.stringify(savedRevision.outputs)
        || savedJob.renderInputManifestSha256 !== mainBuild.renderInputManifestSha256
        || savedRevision.renderInputManifestSha256 !== mainBuild.renderInputManifestSha256
        || JSON.stringify(savedJob.renderInputManifest) !== JSON.stringify(mainBuild.renderInputManifest)
        || JSON.stringify(savedRevision.renderInputManifest) !== JSON.stringify(mainBuild.renderInputManifest))
      throw new Error('Project／Revision／Job identity 驗證失敗');
    validateManifestIdentity({
      project: savedProject,
      revision: savedRevision,
      output,
      fileEvidence: outputEvidence,
    });
    if (updated.id !== savedRevision.id) throw new Error('updateRevision 回傳與 disk Revision 不一致');

    const validation = {
      ok: true,
      baseRevisionId: base.summary.id,
      revisionId: targetRevisionId,
      revisionNumber: targetNumber,
      jobId,
      status: savedRevision.status,
      output,
      hashRows,
      promptSha256,
      slotOutputSha256: changed.sha256,
      media: {
        width: media.actual.width,
        height: media.actual.height,
        durationSec: media.actual.duration,
        baseDurationSec: media.base.duration,
        durationDiffSec: media.durationDiffSec,
      },
      checks: { slot: slotCheck.ok, main: mainCheck.ok },
      timings,
      mainBuild,
      sourceHtml: {
        count: compositionSnapshots.count,
        anchorKind: state.anchorKind,
        lineageResolvedFrom: state.lineageResolvedFrom,
        fallbackSlots: compositionSnapshots.fallbackSlots,
      },
      promptSnapshots: {
        count: promptSnapshots.length,
        workingCopyByteIdentical: true,
        targetWorkingPath: state.promptPath,
      },
      jobJson: path.relative(APP_DIR, jobStore.jobFile(jobId)).split(path.sep).join('/'),
      jobIdentity: true,
    };
    writeJson(path.join(workdir, 'qa', 'validation.json'), validation);
    writeJson(stateFile, { ...state, status: 'finished', finishedAt, jobId, output });
    console.log(JSON.stringify(validation, null, 2));
    return validation;
  } catch (error) {
    let rollback = null;
    if (added) {
      try { rollback = rollbackDraft(store, project.id, targetRevisionId); }
      catch (rollbackError) { rollback = { aborted: false, error: rollbackError.message }; }
    }
    console.error(JSON.stringify({ ok: false, error: error.message, rollback }, null, 2));
    throw error;
  }
  } catch (error) {
    let outputRollback;
    try { outputRollback = outputAttempt.rollback(outputEvidence); }
    catch (rollbackError) { outputRollback = { error: rollbackError.message }; }
    if (outputRollback.removedTemp || outputRollback.removedPublished
        || outputRollback.publishedConflict || outputRollback.error) {
      console.error(JSON.stringify({ ok: false, outputRollback }, null, 2));
    }
    throw error;
  }
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  return options.command === 'prepare' ? prepare(options) : finish(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try { run(); }
  catch (error) {
    console.error(`broll-slot: ${error.message}`);
    process.exitCode = 1;
  }
}
