'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEYGEN_CREATE_ENDPOINTS = Object.freeze({
  'v2-audio': 'https://api.heygen.com/v2/videos',
  'v2-text': 'https://api.heygen.com/v2/videos',
  'v3-text': 'https://api.heygen.com/v3/videos',
});
const PAID_OPERATION_KEYS = new Set([
  'minimax-tts',
  'heygen-audio-upload',
  'heygen-video-create',
]);
const DRY_RUN_METADATA_KEYS = new Set([
  'mode',
  'aspectRatio',
  'resolution',
  'expressiveness',
  'engine',
  'scriptCharacters',
  'avatarIdPresent',
  'voiceIdPresent',
  'audioAssetIdSource',
  'motionPromptPresent',
  'voiceSpeed',
  'voiceLocalePresent',
  'brandGlossaryPresent',
]);
const HEYGEN_TRACE_ENV_KEYS = Object.freeze([
  'WORKSPACE_RUN_TOKEN',
  'DATA_DIR',
  'HEYGEN_PROJECT_ID',
  'HEYGEN_RUN_ID',
  'HEYGEN_REVISION',
  'HEYGEN_EXPERIMENT_ID',
  'HEYGEN_EXPERIMENT_RUN_ID',
  'HEYGEN_VIDEO_TITLE',
]);
const PROVIDER_SECRET_KEYS = Object.freeze([
  'HEYGEN_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_GROUP_ID',
]);

function snapshotHeyGenTraceEnvironment(env = {}) {
  const snapshot = {};
  for (const key of HEYGEN_TRACE_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) snapshot[key] = env[key];
  }
  return Object.freeze(snapshot);
}

function loadProviderSecrets(options = {}) {
  const env = options.env || process.env;
  const dotenv = options.dotenv || require('dotenv');
  const fileEnvironment = Object.create(null);
  dotenv.config({ processEnv: fileEnvironment, quiet: true });
  const secrets = {};
  for (const key of PROVIDER_SECRET_KEYS) {
    secrets[key] = Object.prototype.hasOwnProperty.call(env, key)
      ? env[key]
      : fileEnvironment[key];
  }
  return Object.freeze(secrets);
}

function readArg(argv, name) {
  const prefix = `--${name}=`;
  const value = argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function paidOperationKey(value) {
  const normalized = cleanTitle(value);
  if (!PAID_OPERATION_KEYS.has(normalized)) {
    throw new Error(`paid operation key 不支援：${value}`);
  }
  return normalized;
}

function safeId(value, label) {
  const normalized = String(value || '').trim();
  if (!SAFE_ID.test(normalized)) throw new Error(`${label} 格式錯誤：${value}`);
  return normalized;
}

function normalizeExperimentId(value) {
  const normalized = cleanTitle(value)
    .toUpperCase()
    .replace(/_/g, '-')
    .replace(/^EXPERIENCE-?/, 'EXP-');
  const match = normalized.match(/^EXP-?(\d{1,4})$/);
  if (!match) {
    throw new Error(`HeyGen experiment id 格式錯誤：${value}（應為 EXP-001 或 experience-001）`);
  }
  return `EXP-${match[1].padStart(3, '0')}`;
}

function normalizeRevision(value) {
  const normalized = cleanTitle(value).toUpperCase();
  const match = normalized.match(/^V(\d+)$/);
  if (!match) throw new Error(`HeyGen revision 格式錯誤：${value}（應為 V1、V2…）`);
  return `V${Number(match[1])}`;
}

function revisionLabel(context) {
  if (Number.isInteger(Number(context.revisionNumber)) && Number(context.revisionNumber) > 0) {
    return `V${Number(context.revisionNumber)}`;
  }
  return normalizeRevision(context.revisionId || context.revision);
}

function segmentSuffix(segment) {
  if (!segment) return '';
  const index = Number(segment.index);
  const total = Number(segment.total);
  if (!Number.isInteger(index) || index < 0) throw new Error('HeyGen segment index 必須是 0-based 整數');
  if (!Number.isInteger(total) || total < 1 || index >= total) {
    throw new Error('HeyGen segment total/index 不一致');
  }
  const role = segment.role == null ? '' : String(segment.role).toUpperCase();
  if (role && !/^[A-Z0-9]{1,4}$/.test(role)) throw new Error('HeyGen segment role 格式錯誤');
  return `-S${String(index + 1).padStart(2, '0')}${role}`;
}

function resolveHeyGenVideoTitle(fallback, options = {}) {
  const argv = options.argv || [];
  const env = options.env || {};
  const context = options.context || null;
  const explicit = cleanTitle(readArg(argv, 'heygen-title') || env.HEYGEN_VIDEO_TITLE);
  const experiment = context?.kind === 'experiment'
    ? context.experimentId
    : (!context ? readArg(argv, 'experiment') || env.HEYGEN_EXPERIMENT_ID : null);
  let base;

  if (experiment && explicit) {
    throw new Error('EXP context 的 HeyGen title 固定為 測試用EXP-NNN-VN，不支援自訂 heygen-title prefix');
  }

  if (context?.kind === 'experiment') {
    base = `測試用${context.experimentId}-${context.revision}`;
  } else if (explicit) {
    if (context?.kind === 'project') {
      base = `${explicit}-${context.projectId}-${revisionLabel(context)}-${context.runId}`;
    } else {
      base = explicit;
    }
  } else if (context?.kind === 'project') {
    base = `MV-${context.projectId}-${revisionLabel(context)}-${context.runId}`;
  } else {
    if (experiment) {
      base = `測試用${normalizeExperimentId(experiment)}-${normalizeRevision(
        readArg(argv, 'revision') || env.HEYGEN_REVISION || 'V1',
      )}`;
    } else {
      base = cleanTitle(fallback);
    }
  }

  if (!base) throw new Error('HeyGen video title 不可為空');
  return `${base}${segmentSuffix(options.segment)}`;
}

function normalizeSegment(segment) {
  if (!segment) return null;
  segmentSuffix(segment);
  return {
    index: Number(segment.index),
    total: Number(segment.total),
    role: segment.role == null ? '' : String(segment.role).toUpperCase(),
  };
}

function canonicalTrace(context) {
  if (context?.kind === 'project') {
    return {
      kind: 'project',
      projectId: safeId(context.projectId, 'Project ID'),
      revision: revisionLabel(context),
      runId: safeId(context.runId, 'Run ID'),
    };
  }
  if (context?.kind === 'experiment') {
    return {
      kind: 'experiment',
      experimentId: normalizeExperimentId(context.experimentId),
      revision: normalizeRevision(context.revision),
    };
  }
  throw new Error('HeyGen paid request 缺少 Project/Run 或 EXP/Revision identity');
}

function ledgerFileName(context) {
  if (context?.kind === 'experiment') return `${context.runId}.json`;
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(canonicalTrace(context)))
    .digest('hex');
  return `project-${digest}.json`;
}

function endpointForApi(api) {
  const endpoint = HEYGEN_CREATE_ENDPOINTS[api];
  if (!endpoint) throw new Error(`HeyGen ledger api 不支援：${api}`);
  return endpoint;
}

function reservationKey(context, api, segment = null) {
  endpointForApi(api);
  const logicalIdentity = {
    trace: canonicalTrace(context),
    api,
    segment: normalizeSegment(segment),
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(logicalIdentity)).digest('hex')}`;
}

function safeDryRunMetadata(metadata) {
  const safe = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (!DRY_RUN_METADATA_KEYS.has(key)) {
      throw new Error(`HeyGen dry-run metadata 欄位不允許：${key}`);
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`HeyGen dry-run metadata 必須是 primitive：${key}`);
    }
    safe[key] = value;
  }
  return safe;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readSmallJson(filePath, label, fsImpl = fs) {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error(`${label} 不是安全的小型 JSON 檔：${filePath}`);
  }
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_) {
    throw new Error(`${label} JSON 無法解析：${filePath}`);
  }
}

function existingContainedFile(rootReal, filePath, label, fsImpl = fs) {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 不是安全的一般檔案`);
  const real = fsImpl.realpathSync(filePath);
  if (!isWithin(rootReal, real)) throw new Error(`${label} 超出 runtime root`);
  return real;
}

function requirePlainDirectory(directory, label, fsImpl = fs) {
  const stat = fsImpl.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} 不是安全的一般目錄`);
  }
  return fsImpl.realpathSync(directory);
}

function filesystemIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

function capturePlainDirectoryIdentity(directory, label, fsImpl = fs) {
  const absolute = path.resolve(directory);
  const stat = fsImpl.lstatSync(absolute, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} 不是安全的一般目錄`);
  }
  return {
    path: absolute,
    real: fsImpl.realpathSync(absolute),
    ...filesystemIdentity(stat),
  };
}

function sameFilesystemIdentity(left, right) {
  return left.path === right.path
    && left.real === right.real
    && left.device === right.device
    && left.inode === right.inode;
}

function sameFilesystemNode(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function assertStablePlainDirectory(identity, label, fsImpl = fs) {
  const current = capturePlainDirectoryIdentity(identity.path, label, fsImpl);
  if (!sameFilesystemIdentity(identity, current)) {
    throw new Error(`${label} filesystem identity 已改變`);
  }
  return current;
}

function capturePlainFileIdentity(filePath, rootIdentity, label, fsImpl = fs) {
  assertStablePlainDirectory(rootIdentity, 'provider ledger root', fsImpl);
  const absolute = path.resolve(filePath);
  if (path.dirname(absolute) !== rootIdentity.real || !isWithin(rootIdentity.real, absolute)) {
    throw new Error(`${label} 超出 provider ledger root`);
  }
  const stat = fsImpl.lstatSync(absolute, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} 不是安全的一般檔案`);
  }
  const real = fsImpl.realpathSync(absolute);
  if (path.dirname(real) !== rootIdentity.real || !isWithin(rootIdentity.real, real)) {
    throw new Error(`${label} 超出 provider ledger root`);
  }
  return {
    path: absolute,
    real,
    ...filesystemIdentity(stat),
  };
}

function assertStablePlainFile(identity, rootIdentity, label, fsImpl = fs) {
  const current = capturePlainFileIdentity(identity.path, rootIdentity, label, fsImpl);
  if (!sameFilesystemIdentity(identity, current)) {
    throw new Error(`${label} filesystem identity 已改變`);
  }
  return current;
}

function ensurePlainDirectory(directory, label, fsImpl = fs) {
  if (!fsImpl.existsSync(directory)) fsImpl.mkdirSync(directory, { recursive: true });
  return requirePlainDirectory(directory, label, fsImpl);
}

function validateDirectoryCreationPath({
  targetPath,
  boundaryPath = null,
  boundaryReal = null,
  label,
  fsImpl = fs,
}) {
  const absolute = path.resolve(targetPath);
  const filesystemRoot = path.parse(absolute).root;
  const boundary = boundaryPath ? path.resolve(boundaryPath) : filesystemRoot;

  if (!isWithin(boundary, absolute)) throw new Error(`${label} 超出已驗證的目錄邊界`);
  const currentBoundaryReal = requirePlainDirectory(boundary, `${label} 上層`, fsImpl);
  if (boundaryReal && currentBoundaryReal !== boundaryReal) {
    throw new Error(`${label} 上層真實路徑已改變`);
  }

  const relative = path.relative(boundary, absolute);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = boundary;
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      // macOS exposes /var, /tmp, and /etc as root-owned filesystem aliases. Only aliases directly
      // under the filesystem root are trusted; every user-controlled lower component fails closed.
      if (path.dirname(current) === filesystemRoot) {
        requirePlainDirectory(fsImpl.realpathSync(current), `${label} 系統上層`, fsImpl);
        continue;
      }
      throw new Error(`${label} 不是安全的一般目錄（路徑包含 symlink）`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} 不是安全的一般目錄（路徑元件不是目錄）`);
    }
  }

  return { targetPath: absolute, boundaryPath: boundary, boundaryReal: currentBoundaryReal };
}

function findManagedProjectContext({ projectDir, env, fsImpl = fs }) {
  const token = String(env.WORKSPACE_RUN_TOKEN || '');
  if (!UUID_V4.test(token)) throw new Error('WORKSPACE_RUN_TOKEN 不合法，拒絕建立付費 request');

  const dataDir = path.resolve(projectDir, env.DATA_DIR || 'runtime-data');
  if (!fsImpl.existsSync(dataDir)) {
    throw new Error('找不到 managed Project/Run runtime data，拒絕建立付費 request');
  }
  const dataRootIdentity = capturePlainDirectoryIdentity(dataDir, 'DATA_DIR', fsImpl);
  const dataReal = dataRootIdentity.real;
  const jobsDir = path.join(dataReal, 'jobs');
  const projectsDir = path.join(dataReal, 'projects');
  if (!fsImpl.existsSync(jobsDir) || !fsImpl.existsSync(projectsDir)) {
    throw new Error('找不到 managed Project/Run runtime data，拒絕建立付費 request');
  }
  for (const [label, directory] of [['jobs', jobsDir], ['projects', projectsDir]]) {
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} runtime directory 不是安全的一般目錄`);
    }
  }
  const jobsReal = fsImpl.realpathSync(jobsDir);
  const projectsReal = fsImpl.realpathSync(projectsDir);
  if (!isWithin(dataReal, jobsReal) || !isWithin(dataReal, projectsReal)) {
    throw new Error('jobs/projects runtime directory 超出 DATA_DIR');
  }
  const matches = [];

  for (const entry of fsImpl.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const candidateDir = path.join(jobsDir, entry.name);
    const dirStat = fsImpl.lstatSync(candidateDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
    const candidateReal = fsImpl.realpathSync(candidateDir);
    if (!isWithin(jobsReal, candidateReal)) continue;
    const jobFile = path.join(candidateDir, 'job.json');
    if (!fsImpl.existsSync(jobFile)) continue;
    const job = readSmallJson(existingContainedFile(jobsReal, jobFile, 'job.json', fsImpl), 'job.json', fsImpl);
    if (job.workspaceRunToken === token) matches.push({ job, jobDir: candidateReal });
  }

  if (matches.length !== 1) {
    throw new Error(`WORKSPACE_RUN_TOKEN 必須唯一對應一個 Run，目前找到 ${matches.length} 個`);
  }

  const { job, jobDir } = matches[0];
  const runId = safeId(job.id, 'Run ID');
  if (path.basename(jobDir) !== runId || (job.runId != null && job.runId !== runId)) {
    throw new Error('Run directory、job.id 與 runId 不一致');
  }
  const projectId = safeId(job.projectId, 'Project ID');
  const revisionId = safeId(job.revisionId, 'Revision ID');
  const projectDirPath = path.join(projectsDir, projectId);
  const projectFile = path.join(projectDirPath, 'project.json');
  const revisionFile = path.join(projectDirPath, 'revisions', `${revisionId}.json`);
  if (!fsImpl.existsSync(projectFile) || !fsImpl.existsSync(revisionFile)) {
    throw new Error('Project 或 Revision 記錄不存在，拒絕建立付費 request');
  }
  const projectDirStat = fsImpl.lstatSync(projectDirPath);
  const revisionsDirStat = fsImpl.lstatSync(path.join(projectDirPath, 'revisions'));
  if (!projectDirStat.isDirectory() || projectDirStat.isSymbolicLink()
      || !revisionsDirStat.isDirectory() || revisionsDirStat.isSymbolicLink()) {
    throw new Error('Project/Revision directory 不是安全的一般目錄');
  }
  const project = readSmallJson(
    existingContainedFile(projectsReal, projectFile, 'project.json', fsImpl),
    'project.json',
    fsImpl,
  );
  const revision = readSmallJson(
    existingContainedFile(projectsReal, revisionFile, 'revision.json', fsImpl),
    'revision.json',
    fsImpl,
  );
  if (project.id !== projectId || revision.id !== revisionId || revision.projectId !== projectId) {
    throw new Error('Project/Revision identity 不一致');
  }
  if (revision.jobId !== runId || revision.runId !== runId) {
    throw new Error('Revision 與 Run identity 不一致');
  }
  const revisionNumber = Number(revision.number);
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1
      || revisionId !== `v${String(revisionNumber).padStart(3, '0')}`) {
    throw new Error('Revision ID 與 revision number 不一致');
  }
  if (job.revisionNumber != null && Number(job.revisionNumber) !== Number(revision.number)) {
    throw new Error('job/revision number 不一致');
  }
  if (job.status !== 'preparing' || job.workspaceRunStatus !== 'preparing') {
    throw new Error('WORKSPACE_RUN_TOKEN 只能用於正在 preparing 的 Run');
  }
  if (revision.status !== 'preparing') {
    throw new Error('WORKSPACE_RUN_TOKEN 對應的 Revision 不是 preparing');
  }

  const context = {
    kind: 'project',
    source: 'workspace-run-token',
    projectId,
    revisionId,
    revisionNumber,
    runId,
  };
  const containmentRoot = path.join(dataReal, 'provider-ledgers');
  return {
    context,
    dataRootIdentity,
    ledgerPath: path.join(containmentRoot, ledgerFileName(context)),
    containmentRoot,
  };
}

function explicitProjectOrExperimentIdentity({ argv, env }) {
  const explicitRun = readArg(argv, 'run-id') || env.HEYGEN_RUN_ID;
  const explicitProject = readArg(argv, 'project-id') || env.HEYGEN_PROJECT_ID;
  const explicitRevision = readArg(argv, 'revision') || env.HEYGEN_REVISION;
  const experiment = readArg(argv, 'experiment') || env.HEYGEN_EXPERIMENT_ID;
  let context;

  if (experiment) {
    if (explicitProject || explicitRun) {
      throw new Error('HeyGen paid request identity 不可混用 Project/Run 與 EXP');
    }
    if (!explicitRevision) throw new Error('experiment trace 必須提供 revision');
    if (readArg(argv, 'experiment-run-id') || env.HEYGEN_EXPERIMENT_RUN_ID) {
      throw new Error('experiment-run-id 會繞過 EXP/Revision 去重，請以新 Revision 建立新 request');
    }
    const experimentId = normalizeExperimentId(experiment);
    const revision = normalizeRevision(explicitRevision);
    const runId = safeId(
      `experiment-${experimentId.toLowerCase()}-${revision.toLowerCase()}`,
      'Experiment Run ID',
    );
    context = {
      kind: 'experiment',
      source: 'explicit-experiment',
      experimentId,
      revision,
      runId,
    };
  } else if (explicitProject || explicitRevision || explicitRun) {
    if (!explicitProject || !explicitRevision || !explicitRun) {
      throw new Error('manual Project trace 必須同時提供 project-id、revision 與 run-id');
    }
    context = {
      kind: 'project',
      source: 'explicit-cli',
      projectId: safeId(explicitProject, 'Project ID'),
      revisionId: normalizeRevision(explicitRevision),
      runId: safeId(explicitRun, 'Run ID'),
    };
  } else {
    throw new Error(
      'HeyGen paid request 必須提供 project-id/revision/run-id 或 experiment/revision identity',
    );
  }

  return context;
}

function validateOptionalLedgerLocation(location, fsImpl = fs) {
  let containmentRoot = path.resolve(location.containmentRoot);
  let ledgerPath = path.resolve(location.ledgerPath);
  if (!isWithin(containmentRoot, ledgerPath) || path.dirname(ledgerPath) !== containmentRoot) {
    throw new Error('provider ledger 超出允許目錄');
  }

  if (fsImpl.existsSync(containmentRoot)) {
    containmentRoot = requirePlainDirectory(containmentRoot, 'provider ledger root', fsImpl);
    ledgerPath = path.join(containmentRoot, path.basename(ledgerPath));
    if (!isWithin(containmentRoot, ledgerPath) || path.dirname(ledgerPath) !== containmentRoot) {
      throw new Error('provider ledger 超出允許目錄');
    }
    if (fsImpl.existsSync(ledgerPath)) {
      const stat = fsImpl.lstatSync(ledgerPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('provider ledger 不是安全的一般檔案');
      }
      const real = fsImpl.realpathSync(ledgerPath);
      if (!isWithin(containmentRoot, real)) throw new Error('provider ledger 超出允許目錄');
      ledgerPath = real;
    }
  }

  return {
    ...location,
    ledgerPath,
    containmentRoot,
  };
}

function explicitProjectOrExperimentContext({ projectDir, argv, env, fsImpl = fs }) {
  const context = explicitProjectOrExperimentIdentity({ argv, env });
  const dataDir = path.resolve(projectDir, env.DATA_DIR || 'runtime-data');
  const dataPlan = validateDirectoryCreationPath({
    targetPath: dataDir,
    label: 'DATA_DIR',
    fsImpl,
  });
  let dataRoot = dataDir;
  let dataRootIdentity = null;
  let containmentRoot = path.join(dataDir, 'provider-ledgers');

  // Preview resolution is deliberately read-only. Existing roots are validated, but missing
  // DATA_DIR/provider-ledgers are represented as planned paths and are never materialized here.
  if (fsImpl.existsSync(dataDir)) {
    dataRootIdentity = capturePlainDirectoryIdentity(dataDir, 'DATA_DIR', fsImpl);
    dataRoot = dataRootIdentity.real;
    containmentRoot = path.join(dataRoot, 'provider-ledgers');
    if (fsImpl.existsSync(containmentRoot)) {
      containmentRoot = requirePlainDirectory(containmentRoot, 'provider-ledgers', fsImpl);
      if (!isWithin(dataRoot, containmentRoot) || containmentRoot === dataRoot) {
        throw new Error('provider-ledgers 超出 DATA_DIR');
      }
    }
  }

  return validateOptionalLedgerLocation({
    context,
    configuredDataDir: dataDir,
    dataDirBoundary: dataPlan.boundaryPath,
    dataDirBoundaryReal: dataPlan.boundaryReal,
    dataRootIdentity,
    dataDir: dataRoot,
    ledgerPath: path.join(containmentRoot, ledgerFileName(context)),
    containmentRoot,
  }, fsImpl);
}

function resolveHeyGenRequestContext(options) {
  const projectDir = path.resolve(options.projectDir);
  const argv = options.argv || [];
  const env = options.env || {};
  const fsImpl = options.fsImpl || fs;
  const resolved = env.WORKSPACE_RUN_TOKEN
    ? findManagedProjectContext({ projectDir, env, fsImpl })
    : explicitProjectOrExperimentContext({ projectDir, argv, env, fsImpl });
  return validateOptionalLedgerLocation(resolved, fsImpl);
}

function requestPlanner(resolved, argv, env) {
  return {
    context: resolved.context,
    ledgerPath: resolved.ledgerPath,
    titleFor(fallback, segment = null) {
      return resolveHeyGenVideoTitle(fallback, { argv, env, context: resolved.context, segment });
    },
    preview({ api, title, segment = null, payloadMetadata = {} }) {
      const safeTitle = cleanTitle(title);
      if (!safeTitle || safeTitle !== title) throw new Error('HeyGen payload title 未通過 dry-run 正規化');
      const normalizedSegment = normalizeSegment(segment);
      return {
        dryRun: true,
        operation: 'video.create',
        api,
        endpoint: endpointForApi(api),
        logicalKey: reservationKey(resolved.context, api, normalizedSegment),
        trace: canonicalTrace(resolved.context),
        title: safeTitle,
        ...(normalizedSegment ? { segment: normalizedSegment } : {}),
        payloadMetadata: safeDryRunMetadata(payloadMetadata),
      };
    },
  };
}

function createHeyGenRequestPreview(options) {
  const argv = options.argv || [];
  const env = options.env || {};
  const resolved = resolveHeyGenRequestContext(options);
  return requestPlanner(resolved, argv, env);
}

function sameTrace(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function createHeyGenRequestTracer(options) {
  const argv = options.argv || [];
  const env = options.env || {};
  const fsImpl = options.fsImpl || fs;
  const now = options.now || (() => new Date());
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const pid = options.pid || process.pid;
  const managed = resolveHeyGenRequestContext(options);
  const trace = canonicalTrace(managed.context);
  let dataRootIdentity = managed.dataRootIdentity || null;
  if (managed.configuredDataDir) {
    const dataPlan = validateDirectoryCreationPath({
      targetPath: managed.configuredDataDir,
      boundaryPath: managed.dataDirBoundary,
      boundaryReal: managed.dataDirBoundaryReal,
      label: 'DATA_DIR',
      fsImpl,
    });
    const configuredDataDir = dataPlan.targetPath;
    if (dataRootIdentity) {
      assertStablePlainDirectory(dataRootIdentity, 'DATA_DIR', fsImpl);
    } else {
      fsImpl.mkdirSync(configuredDataDir, { recursive: true });
    }
    validateDirectoryCreationPath({
      targetPath: configuredDataDir,
      boundaryPath: dataPlan.boundaryPath,
      boundaryReal: dataPlan.boundaryReal,
      label: 'DATA_DIR',
      fsImpl,
    });
    if (dataRootIdentity) {
      assertStablePlainDirectory(dataRootIdentity, 'DATA_DIR', fsImpl);
    } else {
      dataRootIdentity = capturePlainDirectoryIdentity(configuredDataDir, 'DATA_DIR', fsImpl);
    }
  } else if (dataRootIdentity) {
    assertStablePlainDirectory(dataRootIdentity, 'DATA_DIR', fsImpl);
  } else {
    dataRootIdentity = capturePlainDirectoryIdentity(
      path.dirname(path.resolve(managed.containmentRoot)),
      'DATA_DIR',
      fsImpl,
    );
  }

  let containmentRoot = path.join(dataRootIdentity.real, 'provider-ledgers');
  if (!fsImpl.existsSync(containmentRoot)) {
    assertStablePlainDirectory(dataRootIdentity, 'DATA_DIR', fsImpl);
    try {
      fsImpl.mkdirSync(containmentRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    assertStablePlainDirectory(dataRootIdentity, 'DATA_DIR', fsImpl);
  }
  const rootIdentity = capturePlainDirectoryIdentity(
    containmentRoot,
    'provider ledger root',
    fsImpl,
  );
  if (!isWithin(dataRootIdentity.real, rootIdentity.real)
      || path.dirname(rootIdentity.real) !== dataRootIdentity.real) {
    throw new Error('provider ledger root 超出 DATA_DIR');
  }
  containmentRoot = rootIdentity.real;
  const rootReal = rootIdentity.real;
  const ledgerPath = path.join(rootReal, path.basename(managed.ledgerPath));

  if (!isWithin(rootReal, ledgerPath) || path.dirname(ledgerPath) !== rootReal) {
    throw new Error('provider ledger 超出允許目錄');
  }

  function assertLedgerDirectoriesStable() {
    const currentData = assertStablePlainDirectory(dataRootIdentity, 'DATA_DIR', fsImpl);
    const currentRoot = assertStablePlainDirectory(rootIdentity, 'provider ledger root', fsImpl);
    if (currentData.real !== dataRootIdentity.real
        || currentRoot.real !== rootReal
        || path.dirname(currentRoot.real) !== currentData.real
        || !isWithin(currentData.real, currentRoot.real)) {
      throw new Error('provider ledger directory containment 已改變');
    }
  }

  function newLedger() {
    const createdAt = now().toISOString();
    return {
      schemaVersion: 2,
      provider: 'heygen',
      trace,
      createdAt,
      updatedAt: createdAt,
      requests: [],
      operationClaims: [],
    };
  }

  const eventRootPath = path.join(rootReal, `.${path.basename(ledgerPath)}.events`);
  let ledgerFileIdentity = null;
  let ledgerFileDigest = null;
  let eventRootIdentity = null;
  const eventFilePins = new Map();
  let ledger;
  let writeCounter = 0;

  function fsyncFile(filePath) {
    const fd = fsImpl.openSync(filePath, fs.constants.O_RDONLY);
    try {
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  function fsyncDirectory(directory) {
    const fd = fsImpl.openSync(directory, fs.constants.O_RDONLY);
    try {
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  function assertLedgerArtifactsStable() {
    assertLedgerDirectoriesStable();
    if (ledgerFileIdentity) {
      assertStablePlainFile(ledgerFileIdentity, rootIdentity, 'provider ledger', fsImpl);
    }
    if (eventRootIdentity) {
      const current = assertStablePlainDirectory(
        eventRootIdentity,
        'provider ledger event root',
        fsImpl,
      );
      if (path.dirname(current.real) !== rootReal || !isWithin(rootReal, current.real)) {
        throw new Error('provider ledger event root 超出允許目錄');
      }
    }
  }

  function assertDestinationRootStable(destinationRootIdentity, label) {
    assertLedgerArtifactsStable();
    const current = assertStablePlainDirectory(destinationRootIdentity, label, fsImpl);
    if (destinationRootIdentity !== rootIdentity
        && (path.dirname(current.real) !== rootReal || !isWithin(rootReal, current.real))) {
      throw new Error(`${label} 超出 provider ledger root`);
    }
    return current;
  }

  function publishImmutableJson({
    destination,
    destinationRootIdentity,
    value,
    label,
  }) {
    const root = assertDestinationRootStable(destinationRootIdentity, `${label} root`).real;
    const absoluteDestination = path.resolve(destination);
    if (path.dirname(absoluteDestination) !== root || !isWithin(root, absoluteDestination)) {
      throw new Error(`${label} 超出 immutable root`);
    }
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const temp = path.join(
      root,
      `.${path.basename(absoluteDestination)}.${pid}.${writeCounter += 1}.tmp`,
    );
    fsImpl.writeFileSync(temp, bytes, {
      flag: 'wx',
      mode: 0o400,
    });
    let tempIdentity = null;
    let destinationIdentity = null;
    let linked = false;
    try {
      fsyncFile(temp);
      tempIdentity = capturePlainFileIdentity(temp, destinationRootIdentity, `${label} temp`, fsImpl);
      assertDestinationRootStable(destinationRootIdentity, `${label} root`);
      assertStablePlainFile(tempIdentity, destinationRootIdentity, `${label} temp`, fsImpl);
      try {
        fsImpl.linkSync(temp, absoluteDestination);
        linked = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        assertDestinationRootStable(destinationRootIdentity, `${label} root`);
        assertStablePlainFile(tempIdentity, destinationRootIdentity, `${label} temp`, fsImpl);
        fsImpl.unlinkSync(temp);
        fsyncDirectory(root);
        return { published: false, identity: null };
      }

      assertDestinationRootStable(destinationRootIdentity, `${label} root`);
      assertStablePlainFile(tempIdentity, destinationRootIdentity, `${label} temp`, fsImpl);
      destinationIdentity = capturePlainFileIdentity(
        absoluteDestination,
        destinationRootIdentity,
        label,
        fsImpl,
      );
      if (!sameFilesystemNode(tempIdentity, destinationIdentity)) {
        throw new Error(`${label} publish inode 與已驗證 temp 不一致`);
      }
      if (!fsImpl.readFileSync(absoluteDestination).equals(bytes)) {
        throw new Error(`${label} publish bytes 與已驗證 temp 不一致`);
      }
      fsyncDirectory(root);
      fsImpl.unlinkSync(temp);
      fsyncDirectory(root);
      assertDestinationRootStable(destinationRootIdentity, `${label} root`);
      assertStablePlainFile(destinationIdentity, destinationRootIdentity, label, fsImpl);
      return { published: true, identity: destinationIdentity };
    } catch (error) {
      if (!linked && tempIdentity) {
        try {
          assertDestinationRootStable(destinationRootIdentity, `${label} root`);
          assertStablePlainFile(tempIdentity, destinationRootIdentity, `${label} temp`, fsImpl);
          fsImpl.unlinkSync(temp);
          fsyncDirectory(root);
        } catch (_) {}
      }
      throw error;
    }
  }

  function readLedgerHeader() {
    assertLedgerArtifactsStable();
    const bytes = fsImpl.readFileSync(ledgerFileIdentity.real);
    assertLedgerArtifactsStable();
    if (bytes.length > 1024 * 1024) throw new Error('provider ledger 超過 1 MiB 上限');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (ledgerFileDigest && ledgerFileDigest !== digest) {
      throw new Error('provider ledger immutable header bytes 已改變');
    }
    ledgerFileDigest = digest;
    let current;
    try {
      current = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
      throw new Error(`provider ledger JSON 無法解析：${ledgerFileIdentity.real}`);
    }
    if (current.schemaVersion !== 2 || current.provider !== 'heygen'
        || !sameTrace(current.trace, trace) || !Array.isArray(current.requests)
        || (current.operationClaims != null && !Array.isArray(current.operationClaims))
        || current.requests.some((request) => !cleanTitle(request.logicalKey))) {
      throw new Error('既有 provider ledger contract 不相容');
    }
    return current;
  }

  function ensureLedgerArtifacts() {
    assertLedgerDirectoriesStable();
    if (ledgerFileIdentity) {
      assertStablePlainFile(ledgerFileIdentity, rootIdentity, 'provider ledger', fsImpl);
    } else if (fsImpl.existsSync(ledgerPath)) {
      ledgerFileIdentity = capturePlainFileIdentity(
        ledgerPath,
        rootIdentity,
        'provider ledger',
        fsImpl,
      );
    } else {
      const published = publishImmutableJson({
        destination: ledgerPath,
        destinationRootIdentity: rootIdentity,
        value: newLedger(),
        label: 'provider ledger',
      });
      ledgerFileIdentity = published.published
        ? published.identity
        : capturePlainFileIdentity(ledgerPath, rootIdentity, 'provider ledger', fsImpl);
    }
    readLedgerHeader();

    if (eventRootIdentity) {
      assertStablePlainDirectory(eventRootIdentity, 'provider ledger event root', fsImpl);
    } else {
      if (!fsImpl.existsSync(eventRootPath)) {
        assertLedgerArtifactsStable();
        try {
          fsImpl.mkdirSync(eventRootPath, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        assertLedgerArtifactsStable();
        fsyncDirectory(rootReal);
      }
      eventRootIdentity = capturePlainDirectoryIdentity(
        eventRootPath,
        'provider ledger event root',
        fsImpl,
      );
      if (path.dirname(eventRootIdentity.real) !== rootReal
          || !isWithin(rootReal, eventRootIdentity.real)) {
        throw new Error('provider ledger event root 超出允許目錄');
      }
    }
    assertLedgerArtifactsStable();
  }

  function eventPriority(eventType) {
    return {
      prepared: 1,
      'operation-claimed': 2,
      submitted: 3,
      completed: 4,
      failed: 4,
    }[eventType] || 99;
  }

  function applyLedgerEvent(snapshot, event) {
    if (event.schemaVersion !== 1 || event.provider !== 'heygen'
        || !sameTrace(event.trace, trace) || !cleanTitle(event.eventAt)
        || !['prepared', 'operation-claimed', 'submitted', 'completed', 'failed']
          .includes(event.eventType)) {
      throw new Error('provider ledger immutable event contract 不相容');
    }
    const requests = snapshot.requests;
    if (event.eventType === 'prepared') {
      const request = event.request;
      if (!request || request.status !== 'prepared' || !cleanTitle(request.requestId)
          || !cleanTitle(request.logicalKey) || !cleanTitle(request.title)) {
        throw new Error('provider ledger prepared event contract 不相容');
      }
      endpointForApi(request.api);
      if (requests.some((item) => item.requestId === request.requestId
          || item.logicalKey === request.logicalKey)) {
        throw new Error('provider ledger immutable event 與既有 reservation 衝突');
      }
      requests.push(JSON.parse(JSON.stringify(request)));
    } else if (event.eventType === 'operation-claimed') {
      const request = requests.find((item) => item.requestId === event.requestId);
      const operationKey = paidOperationKey(event.operationKey);
      if (!request || request.status !== 'prepared'
          || event.logicalKey !== request.logicalKey || !cleanTitle(event.claimId)) {
        throw new Error('provider ledger immutable operation claim 不相容');
      }
      if (snapshot.operationClaims.some((claim) => claim.requestId === event.requestId
          && claim.operationKey === operationKey)) {
        throw new Error('provider ledger paid operation claim 重複');
      }
      if (snapshot.operationClaims.some((claim) => claim.claimId === event.claimId)) {
        throw new Error('provider ledger paid operation claim ID 重複');
      }
      snapshot.operationClaims.push({
        claimId: event.claimId,
        requestId: event.requestId,
        logicalKey: event.logicalKey,
        operationKey,
        claimedAt: event.eventAt,
      });
    } else {
      const request = requests.find((item) => item.requestId === event.requestId);
      if (!request) throw new Error('provider ledger immutable transition 找不到 request');
      if (event.eventType === 'submitted') {
        if (request.status !== 'prepared' || !cleanTitle(event.providerVideoId)) {
          throw new Error('provider ledger immutable submitted transition 不相容');
        }
        request.status = 'submitted';
        request.providerVideoId = event.providerVideoId;
        request.submittedAt = event.eventAt;
      } else if (event.eventType === 'completed') {
        if (request.status !== 'submitted') {
          throw new Error('provider ledger immutable completed transition 不相容');
        }
        request.status = 'completed';
        request.completedAt = event.eventAt;
        request.durationSec = numericOrNull(event.durationSec);
        request.credits = numericOrNull(event.credits);
        request.creditsEvidence = event.creditsEvidence;
      } else {
        if (!['prepared', 'submitted'].includes(request.status)
            || !event.failure || !cleanTitle(event.failure.phase) || !cleanTitle(event.failure.code)) {
          throw new Error('provider ledger immutable failed transition 不相容');
        }
        request.status = 'failed';
        request.failedAt = event.eventAt;
        request.failure = event.failure;
      }
    }
    if (event.eventAt > snapshot.updatedAt) snapshot.updatedAt = event.eventAt;
  }

  function readLedgerSnapshot() {
    ensureLedgerArtifacts();
    const snapshot = JSON.parse(JSON.stringify(readLedgerHeader()));
    if (!Array.isArray(snapshot.operationClaims)) snapshot.operationClaims = [];
    const requestIds = new Set();
    const logicalKeys = new Set();
    for (const request of snapshot.requests) {
      if (!cleanTitle(request.requestId) || !cleanTitle(request.logicalKey)
          || requestIds.has(request.requestId) || logicalKeys.has(request.logicalKey)) {
        throw new Error('既有 provider ledger reservation identity 不相容');
      }
      requestIds.add(request.requestId);
      logicalKeys.add(request.logicalKey);
    }
    const baseClaims = new Set();
    const claimIds = new Set();
    for (const claim of snapshot.operationClaims) {
      const operationKey = paidOperationKey(claim.operationKey);
      const request = snapshot.requests.find((item) => item.requestId === claim.requestId);
      const key = `${claim.requestId}:${operationKey}`;
      if (!request || claim.logicalKey !== request.logicalKey || !cleanTitle(claim.claimId)
          || baseClaims.has(key) || claimIds.has(claim.claimId)) {
        throw new Error('既有 provider ledger operation claim 不相容');
      }
      baseClaims.add(key);
      claimIds.add(claim.claimId);
    }
    const events = [];
    const seenEventPaths = new Set();
    for (const entry of fsImpl.readdirSync(eventRootIdentity.real, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        throw new Error('provider ledger event root 含有不安全項目');
      }
      const eventPath = path.join(eventRootIdentity.real, entry.name);
      const identity = capturePlainFileIdentity(
        eventPath,
        eventRootIdentity,
        'provider ledger event',
        fsImpl,
      );
      const bytes = fsImpl.readFileSync(identity.real);
      assertLedgerArtifactsStable();
      assertStablePlainFile(identity, eventRootIdentity, 'provider ledger event', fsImpl);
      if (bytes.length > 1024 * 1024) throw new Error('provider ledger event 超過 1 MiB 上限');
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const previousPin = eventFilePins.get(identity.path);
      if (previousPin && (!sameFilesystemIdentity(previousPin.identity, identity)
          || previousPin.digest !== digest)) {
        throw new Error('provider ledger immutable event bytes 或 inode 已改變');
      }
      eventFilePins.set(identity.path, { identity, digest });
      seenEventPaths.add(identity.path);
      let event;
      try {
        event = JSON.parse(bytes.toString('utf8'));
      } catch (_) {
        throw new Error(`provider ledger event JSON 無法解析：${identity.real}`);
      }
      events.push({ event, name: entry.name });
    }
    for (const pinnedPath of eventFilePins.keys()) {
      if (!seenEventPaths.has(pinnedPath)) {
        throw new Error('provider ledger immutable event 已被移除');
      }
    }
    events.sort((left, right) => {
      const priority = eventPriority(left.event.eventType) - eventPriority(right.event.eventType);
      return priority || left.name.localeCompare(right.name);
    });
    for (const { event } of events) applyLedgerEvent(snapshot, event);
    assertLedgerArtifactsStable();
    return snapshot;
  }

  function immutableEventName(event) {
    const identity = event.eventType === 'prepared'
      ? event.request.logicalKey
      : event.eventType === 'operation-claimed'
        ? `${event.requestId}:${event.operationKey}`
        : event.requestId;
    const digest = crypto.createHash('sha256').update(`${event.eventType}:${identity}`).digest('hex');
    return `${event.eventType}-${digest}.json`;
  }

  function appendLedgerEvent(event) {
    assertLedgerArtifactsStable();
    const destination = path.join(eventRootIdentity.real, immutableEventName(event));
    const published = publishImmutableJson({
      destination,
      destinationRootIdentity: eventRootIdentity,
      value: event,
      label: 'provider ledger event',
    });
    if (!published.published) {
      ledger = readLedgerSnapshot();
      throw new Error('provider ledger immutable event 已存在，拒絕覆寫或重送');
    }
    ledger = readLedgerSnapshot();
  }

  const lockPath = path.join(rootReal, `.${path.basename(ledgerPath)}.lock`);
  function withLedgerLock(action) {
    assertLedgerDirectoriesStable();
    try {
      fsImpl.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('provider ledger 正由另一個程序使用，拒絕建立付費 request');
      }
      throw error;
    }

    let lockIdentity = null;
    let result;
    let actionError = null;
    try {
      assertLedgerDirectoriesStable();
      lockIdentity = capturePlainDirectoryIdentity(lockPath, 'provider ledger lock', fsImpl);
      if (path.dirname(lockIdentity.real) !== rootReal || !isWithin(rootReal, lockIdentity.real)) {
        throw new Error('provider ledger lock 超出允許目錄');
      }
      assertLedgerDirectoriesStable();
      ensureLedgerArtifacts();
      ledger = readLedgerSnapshot();
      result = action();
      ledger = readLedgerSnapshot();
      assertLedgerArtifactsStable();
    } catch (error) {
      actionError = error;
    }

    let cleanupError = null;
    if (lockIdentity) {
      try {
        assertLedgerArtifactsStable();
        assertStablePlainDirectory(lockIdentity, 'provider ledger lock', fsImpl);
        fsImpl.rmdirSync(lockPath);
        assertLedgerArtifactsStable();
      } catch (error) {
        cleanupError = error;
      }
    }

    if (actionError) throw actionError;
    if (cleanupError) throw cleanupError;
    return result;
  }

  withLedgerLock(() => {});

  function requestById(requestId) {
    const request = ledger.requests.find((item) => item.requestId === requestId);
    if (!request) throw new Error(`找不到 HeyGen ledger request：${requestId}`);
    return request;
  }

  function requireExactPreparedRequest(requestId, { api, title, segment = null }) {
    const request = requestById(requestId);
    const safeTitle = cleanTitle(title);
    const normalizedSegment = normalizeSegment(segment);
    const logicalKey = reservationKey(managed.context, api, normalizedSegment);
    if (request.status !== 'prepared'
        || request.api !== api
        || request.logicalKey !== logicalKey
        || request.title !== safeTitle
        || safeTitle !== title
        || !sameTrace(request.segment || null, normalizedSegment)) {
      throw new Error('HeyGen 已保留 request 與 create payload 不一致');
    }
    return request;
  }

  const planner = requestPlanner({ ...managed, ledgerPath }, argv, env);
  return {
    ...planner,
    prepare({ api, title, segment = null }) {
      return withLedgerLock(() => {
        endpointForApi(api);
        const safeTitle = cleanTitle(title);
        if (!safeTitle || safeTitle !== title) throw new Error('HeyGen payload title 未通過 dry-run 正規化');
        const normalizedSegment = normalizeSegment(segment);
        const logicalKey = reservationKey(managed.context, api, normalizedSegment);
        const previous = ledger.requests.find((item) => item.logicalKey === logicalKey);
        if (previous) {
          throw new Error(
            `HeyGen logical request 已有 ledger 紀錄（${previous.status}），拒絕自動重送：${logicalKey}`,
          );
        }
        const requestId = randomUUID();
        if (!requestId || ledger.requests.some((item) => item.requestId === requestId)) {
          throw new Error('HeyGen ledger request ID 重複或為空');
        }
        const preparedAt = now().toISOString();
        const request = {
          requestId,
          operation: 'video.create',
          api,
          logicalKey,
          title: safeTitle,
          ...(normalizedSegment ? { segment: normalizedSegment } : {}),
          status: 'prepared',
          preparedAt,
          providerVideoId: null,
          durationSec: null,
          credits: null,
          creditsEvidence: 'not_available_before_provider_response',
        };
        appendLedgerEvent({
          schemaVersion: 1,
          provider: 'heygen',
          trace,
          eventType: 'prepared',
          eventAt: preparedAt,
          request,
        });
        return requestId;
      });
    },
    verifyPrepared(requestId, { api, title, segment = null }) {
      return withLedgerLock(() => {
        requireExactPreparedRequest(requestId, { api, title, segment });
        return requestId;
      });
    },
    claimPreparedOperation(requestId, { api, title, segment = null, operationKey }) {
      return withLedgerLock(() => {
        const request = requireExactPreparedRequest(requestId, { api, title, segment });
        const normalizedOperationKey = paidOperationKey(operationKey);
        const previous = ledger.operationClaims.find((claim) => (
          claim.requestId === requestId && claim.operationKey === normalizedOperationKey
        ));
        if (previous) {
          throw new Error(
            `paid operation 已被 claim，拒絕重送：${normalizedOperationKey} (${previous.claimId})`,
          );
        }
        const claimId = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
          logicalKey: request.logicalKey,
          operationKey: normalizedOperationKey,
        })).digest('hex')}`;
        appendLedgerEvent({
          schemaVersion: 1,
          provider: 'heygen',
          trace,
          eventType: 'operation-claimed',
          eventAt: now().toISOString(),
          claimId,
          requestId,
          logicalKey: request.logicalKey,
          operationKey: normalizedOperationKey,
        });
        const durable = ledger.operationClaims.find((claim) => (
          claim.claimId === claimId
          && claim.requestId === requestId
          && claim.logicalKey === request.logicalKey
          && claim.operationKey === normalizedOperationKey
        ));
        if (!durable) throw new Error('paid operation claim 未能 durable reload');
        return claimId;
      });
    },
    submitted(requestId, providerVideoId) {
      withLedgerLock(() => {
        const request = requestById(requestId);
        if (request.status !== 'prepared') throw new Error('HeyGen ledger transition 必須是 prepared → submitted');
        const safeProviderVideoId = cleanTitle(providerVideoId);
        if (!safeProviderVideoId) throw new Error('HeyGen provider video ID 不可為空');
        appendLedgerEvent({
          schemaVersion: 1,
          provider: 'heygen',
          trace,
          eventType: 'submitted',
          eventAt: now().toISOString(),
          requestId,
          providerVideoId: safeProviderVideoId,
        });
      });
    },
    completed(requestId, evidence = {}) {
      withLedgerLock(() => {
        const request = requestById(requestId);
        if (request.status !== 'submitted') throw new Error('HeyGen ledger transition 必須是 submitted → completed');
        const credits = numericOrNull(evidence.credits);
        appendLedgerEvent({
          schemaVersion: 1,
          provider: 'heygen',
          trace,
          eventType: 'completed',
          eventAt: now().toISOString(),
          requestId,
          durationSec: numericOrNull(evidence.durationSec),
          credits,
          creditsEvidence: credits == null
            ? 'not_available_in_provider_status'
            : 'provider_status_response',
        });
      });
    },
    failed(requestId, evidence = {}) {
      withLedgerLock(() => {
        const request = requestById(requestId);
        if (!['prepared', 'submitted'].includes(request.status)) {
          throw new Error('HeyGen ledger 只能將 prepared/submitted request 標為 failed');
        }
        appendLedgerEvent({
          schemaVersion: 1,
          provider: 'heygen',
          trace,
          eventType: 'failed',
          eventAt: now().toISOString(),
          requestId,
          failure: {
            phase: cleanTitle(evidence.phase) || 'unknown',
            code: cleanTitle(evidence.code) || 'provider_request_failed',
          },
        });
      });
    },
    snapshot() {
      return withLedgerLock(() => JSON.parse(JSON.stringify(ledger)));
    },
  };
}

function requireTitle(title) {
  const value = cleanTitle(title);
  if (!value || value !== title) throw new Error('HeyGen create payload title 不合法');
  return value;
}

function buildAudioDrivenPayload({ audioAssetId, avatarId, title, motionPrompt }) {
  return {
    avatar_id: avatarId,
    audio_asset_id: audioAssetId,
    motion_prompt: motionPrompt,
    expressiveness: 'medium',
    aspect_ratio: '9:16',
    resolution: '1080p',
    title: requireTitle(title),
  };
}

function buildTextDrivenV2Payload({ scriptText, avatarId, voiceId, title, motionPrompt, expressiveness }) {
  return {
    avatar_id: avatarId,
    script: scriptText,
    voice_id: voiceId,
    motion_prompt: motionPrompt,
    expressiveness,
    aspect_ratio: '9:16',
    resolution: '1080p',
    title: requireTitle(title),
  };
}

function buildTextDrivenV3Payload({
  scriptText,
  avatarId,
  voiceId,
  title,
  motionPrompt,
  expressiveness,
  voiceSpeed = null,
  voiceLocale = null,
  brandGlossaryId = null,
}) {
  const payload = {
    type: 'avatar',
    avatar_id: avatarId,
    script: scriptText,
    voice_id: voiceId,
    motion_prompt: motionPrompt,
    expressiveness,
    aspect_ratio: '9:16',
    resolution: '1080p',
    engine: { type: 'avatar_iv' },
    title: requireTitle(title),
  };
  const voiceSettings = {};
  if (voiceSpeed !== null) voiceSettings.speed = voiceSpeed;
  if (voiceLocale) voiceSettings.locale = voiceLocale;
  if (Object.keys(voiceSettings).length) payload.voice_settings = voiceSettings;
  if (brandGlossaryId) payload.brand_glossary_id = brandGlossaryId;
  return payload;
}

async function runVerifiedPaidStep({
  tracer,
  ledgerRequestId,
  api,
  title,
  segment = null,
  operationKey,
  paidStep,
}) {
  if (!tracer || typeof tracer.claimPreparedOperation !== 'function') {
    throw new Error('HeyGen tracer 缺少 durable paid-operation claimer');
  }
  if (typeof paidStep !== 'function') throw new Error('paid step callback 不存在');
  tracer.claimPreparedOperation(ledgerRequestId, {
    api,
    title,
    segment,
    operationKey,
  });
  return paidStep();
}

async function submitTracedHeyGenCreate({
  fetchImpl,
  tracer,
  apiKey,
  endpoint,
  api,
  payload,
  segment = null,
  ledgerRequestId: reservedLedgerRequestId = null,
  onPrepared = null,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('HeyGen fetch transport 不存在');
  if (!tracer || typeof tracer.prepare !== 'function') throw new Error('HeyGen tracer 不存在');
  if (!cleanTitle(apiKey)) throw new Error('HeyGen API key 不存在');
  const expectedEndpoint = endpointForApi(api);
  if (endpoint !== expectedEndpoint) {
    throw new Error('HeyGen create endpoint/api contract 不一致');
  }
  requireTitle(payload?.title);
  const hasReservation = reservedLedgerRequestId !== null;
  if (hasReservation
      && (!cleanTitle(reservedLedgerRequestId) || typeof tracer.verifyPrepared !== 'function')) {
    throw new Error('HeyGen 預先保留 request ID 不合法');
  }
  const ledgerRequestId = hasReservation
    ? tracer.verifyPrepared(reservedLedgerRequestId, { api, title: payload.title, segment })
    : tracer.prepare({ api, title: payload.title, segment });
  if (typeof tracer.verifyPrepared !== 'function'
      || typeof tracer.claimPreparedOperation !== 'function') {
    throw new Error('HeyGen tracer 缺少 durable reservation/operation gate');
  }
  if (onPrepared) await onPrepared({ ledgerRequestId, title: payload.title });
  // The immutable claim both revalidates the exact reservation after local callbacks and grants
  // this canonical reservation exactly one winner for the paid create transport.
  tracer.claimPreparedOperation(ledgerRequestId, {
    api,
    title: payload.title,
    segment,
    operationKey: 'heygen-video-create',
  });
  let response;
  let data;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => null);
  } catch (error) {
    tracer.failed(ledgerRequestId, { phase: 'create', code: 'network_error' });
    throw error;
  }

  const videoId = cleanTitle(data?.data?.video_id || data?.video_id || data?.data?.id);
  if (!response.ok || !videoId) {
    tracer.failed(ledgerRequestId, {
      phase: 'create',
      code: !response.ok ? `http_${response.status}` : 'provider_video_id_missing',
    });
    const error = new Error(`HeyGen 建立影片失敗（${api}）`);
    error.providerResponse = data;
    throw error;
  }
  tracer.submitted(ledgerRequestId, videoId);
  return { videoId, ledgerRequestId };
}

module.exports = {
  buildAudioDrivenPayload,
  buildTextDrivenV2Payload,
  buildTextDrivenV3Payload,
  cleanTitle,
  createHeyGenRequestPreview,
  createHeyGenRequestTracer,
  endpointForApi,
  findManagedProjectContext,
  loadProviderSecrets,
  normalizeExperimentId,
  normalizeRevision,
  resolveHeyGenVideoTitle,
  reservationKey,
  resolveHeyGenRequestContext,
  runVerifiedPaidStep,
  snapshotHeyGenTraceEnvironment,
  submitTracedHeyGenCreate,
};
