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
  let base;

  if (explicit) {
    if (context?.kind === 'project') {
      base = `${explicit}-${context.projectId}-${revisionLabel(context)}-${context.runId}`;
    } else if (context?.kind === 'experiment') {
      base = `${explicit}-${context.experimentId}-${context.revision}`;
    } else {
      base = explicit;
    }
  } else if (context?.kind === 'experiment') {
    base = `測試用${context.experimentId}-${context.revision}`;
  } else if (context?.kind === 'project') {
    base = `MV-${context.projectId}-${revisionLabel(context)}-${context.runId}`;
  } else {
    const experiment = readArg(argv, 'experiment') || env.HEYGEN_EXPERIMENT_ID;
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

function ensurePlainDirectory(directory, label, fsImpl = fs) {
  if (!fsImpl.existsSync(directory)) fsImpl.mkdirSync(directory, { recursive: true });
  return requirePlainDirectory(directory, label, fsImpl);
}

function findManagedProjectContext({ projectDir, env, fsImpl = fs }) {
  const token = String(env.WORKSPACE_RUN_TOKEN || '');
  if (!UUID_V4.test(token)) throw new Error('WORKSPACE_RUN_TOKEN 不合法，拒絕建立付費 request');

  const dataDir = path.resolve(projectDir, env.DATA_DIR || 'runtime-data');
  if (!fsImpl.existsSync(dataDir)) {
    throw new Error('找不到 managed Project/Run runtime data，拒絕建立付費 request');
  }
  const dataReal = requirePlainDirectory(dataDir, 'DATA_DIR', fsImpl);
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

  return {
    context: {
      kind: 'project',
      source: 'workspace-run-token',
      projectId,
      revisionId,
      revisionNumber,
      runId,
    },
    ledgerPath: path.join(jobDir, 'provider-ledger.json'),
    containmentRoot: jobDir,
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
  let dataRoot = dataDir;
  let containmentRoot = path.join(dataDir, 'provider-ledgers');

  // Preview resolution is deliberately read-only. Existing roots are validated, but missing
  // DATA_DIR/provider-ledgers are represented as planned paths and are never materialized here.
  if (fsImpl.existsSync(dataDir)) {
    dataRoot = requirePlainDirectory(dataDir, 'DATA_DIR', fsImpl);
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
    dataDir: dataRoot,
    ledgerPath: path.join(containmentRoot, `${context.runId}.json`),
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
  const containmentRoot = path.resolve(managed.containmentRoot);
  fsImpl.mkdirSync(containmentRoot, { recursive: true });
  const rootReal = requirePlainDirectory(containmentRoot, 'provider ledger root', fsImpl);
  const ledgerPath = path.join(rootReal, path.basename(managed.ledgerPath));

  if (!isWithin(rootReal, ledgerPath) || path.dirname(ledgerPath) !== rootReal) {
    throw new Error('provider ledger 超出允許目錄');
  }

  function readLedgerFromDisk() {
    const stat = fsImpl.lstatSync(ledgerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('provider ledger 不是安全的一般檔案');
    const real = fsImpl.realpathSync(ledgerPath);
    if (!isWithin(rootReal, real)) throw new Error('provider ledger 超出允許目錄');
    const current = readSmallJson(real, 'provider ledger', fsImpl);
    if (current.schemaVersion !== 2 || current.provider !== 'heygen'
        || !sameTrace(current.trace, managed.context) || !Array.isArray(current.requests)
        || current.requests.some((request) => !cleanTitle(request.logicalKey))) {
      throw new Error('既有 provider ledger contract 不相容');
    }
    return current;
  }

  function newLedger() {
    const createdAt = now().toISOString();
    return {
      schemaVersion: 2,
      provider: 'heygen',
      trace: managed.context,
      createdAt,
      updatedAt: createdAt,
      requests: [],
    };
  }

  let ledger;
  let writeCounter = 0;
  function persist() {
    ledger.updatedAt = now().toISOString();
    const temp = path.join(
      path.dirname(ledgerPath),
      `.${path.basename(ledgerPath)}.${pid}.${writeCounter += 1}.tmp`,
    );
    fsImpl.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      fsImpl.renameSync(temp, ledgerPath);
    } catch (error) {
      try { fsImpl.unlinkSync(temp); } catch (_) {}
      throw error;
    }
  }

  const lockPath = path.join(rootReal, `.${path.basename(ledgerPath)}.lock`);
  function withLedgerLock(action) {
    try {
      fsImpl.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('provider ledger 正由另一個程序使用，拒絕建立付費 request');
      }
      throw error;
    }

    try {
      ledger = fsImpl.existsSync(ledgerPath) ? readLedgerFromDisk() : newLedger();
      return action();
    } finally {
      fsImpl.rmdirSync(lockPath);
    }
  }

  withLedgerLock(() => {
    if (!fsImpl.existsSync(ledgerPath)) persist();
  });

  function requestById(requestId) {
    const request = ledger.requests.find((item) => item.requestId === requestId);
    if (!request) throw new Error(`找不到 HeyGen ledger request：${requestId}`);
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
        ledger.requests.push({
          requestId,
          operation: 'video.create',
          api,
          logicalKey,
          title: safeTitle,
          ...(normalizedSegment ? { segment: normalizedSegment } : {}),
          status: 'prepared',
          preparedAt: now().toISOString(),
          providerVideoId: null,
          durationSec: null,
          credits: null,
          creditsEvidence: 'not_available_before_provider_response',
        });
        persist();
        return requestId;
      });
    },
    verifyPrepared(requestId, { api, title, segment = null }) {
      return withLedgerLock(() => {
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
        return requestId;
      });
    },
    submitted(requestId, providerVideoId) {
      withLedgerLock(() => {
        const request = requestById(requestId);
        if (request.status !== 'prepared') throw new Error('HeyGen ledger transition 必須是 prepared → submitted');
        const safeProviderVideoId = cleanTitle(providerVideoId);
        if (!safeProviderVideoId) throw new Error('HeyGen provider video ID 不可為空');
        request.status = 'submitted';
        request.providerVideoId = safeProviderVideoId;
        request.submittedAt = now().toISOString();
        persist();
      });
    },
    completed(requestId, evidence = {}) {
      withLedgerLock(() => {
        const request = requestById(requestId);
        if (request.status !== 'submitted') throw new Error('HeyGen ledger transition 必須是 submitted → completed');
        request.status = 'completed';
        request.completedAt = now().toISOString();
        request.durationSec = numericOrNull(evidence.durationSec);
        request.credits = numericOrNull(evidence.credits);
        request.creditsEvidence = request.credits == null
          ? 'not_available_in_provider_status'
          : 'provider_status_response';
        persist();
      });
    },
    failed(requestId, evidence = {}) {
      withLedgerLock(() => {
        const request = requestById(requestId);
        if (!['prepared', 'submitted'].includes(request.status)) {
          throw new Error('HeyGen ledger 只能將 prepared/submitted request 標為 failed');
        }
        request.status = 'failed';
        request.failedAt = now().toISOString();
        request.failure = {
          phase: cleanTitle(evidence.phase) || 'unknown',
          code: cleanTitle(evidence.code) || 'provider_request_failed',
        };
        persist();
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
  if (onPrepared) onPrepared({ ledgerRequestId, title: payload.title });
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
  normalizeExperimentId,
  normalizeRevision,
  resolveHeyGenVideoTitle,
  reservationKey,
  resolveHeyGenRequestContext,
  submitTracedHeyGenCreate,
};
