'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspectMediaFile } = require('./project-store');
const { resolveUniquePhraseAnchor } = require('../scripts/script-timeline-resolver');
const PROVIDER_LOCK = Object.freeze(require('../config/chipk-capture-provider.lock.json'));

const PROVIDER_ID = PROVIDER_LOCK.providerId;
const LEGACY_CONTRACT_VERSION = PROVIDER_LOCK.contractVersion;
const READY_TO_PLACE_CONTRACT_VERSION = PROVIDER_LOCK.readyToPlaceContractVersion;
const READY_TO_PLACE_PROFILE_ID = PROVIDER_LOCK.readyToPlaceProfileId;
const POLICIES = new Set(['prefer-capture', 'require-capture', 'disable-capture']);
const OPERATIONS = new Set(['screenshot', 'record', 'prepared-video']);
const MODES = new Set(['live', 'test']);
const READY_TO_PLACE_ROUTE = 'chipk.stock.main-force';
const READY_TO_PLACE_STOCK = Object.freeze({ id: '3441', name: '聯一光' });
const READY_TO_PLACE_LAYOUT = 'focusstock-phone-portrait.v1';
const RESULT_STATUSES = new Set(['completed', 'rejected', 'failed', 'human_action_required']);
const ARTIFACT_SPEC = Object.freeze({
  screenshot: { kind: 'image', mimeType: 'image/png' },
  'capture-manifest': { kind: 'json', mimeType: 'application/json' },
  'raw-video': { kind: 'video', mimeType: 'video/mp4' },
  actions: { kind: 'json', mimeType: 'application/json' },
  'recording-manifest': { kind: 'json', mimeType: 'application/json' },
  'prepared-video': { kind: 'video', mimeType: 'video/mp4' },
  'presentation-plan': { kind: 'json', mimeType: 'application/json' },
  'preparation-manifest': { kind: 'json', mimeType: 'application/json' },
});
const REQUIRED_ROLES = Object.freeze({
  screenshot: ['screenshot', 'capture-manifest'],
  record: ['raw-video', 'actions', 'recording-manifest'],
  'prepared-video': [
    'prepared-video', 'screenshot', 'capture-manifest',
    'presentation-plan', 'preparation-manifest',
  ],
});
const RESULT_KEYS = new Set([
  'contractVersion', 'requestId', 'provider', 'status', 'artifacts', 'evidence', 'error',
]);
const PROVIDER_KEYS = new Set(['id', 'toolVersion']);
const ERROR_KEYS = new Set(['code', 'message', 'retryable']);
const ARTIFACT_KEYS = new Set(['role', 'kind', 'relativePath', 'sha256', 'mimeType', 'media']);
const READY_EVIDENCE_KEYS = new Set([
  'routeSelection', 'navigation', 'material', 'catalogVersion',
  'presentationProfile', 'publication',
]);
const READY_PROFILE_EVIDENCE_KEYS = new Set(['id', 'version', 'status']);

class MaterialAcquisitionError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'MaterialAcquisitionError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details) {
  throw new MaterialAcquisitionError(message, code, details);
}

function normalizePolicy(policy = 'prefer-capture') {
  if (!POLICIES.has(policy))
    fail(`Unsupported material acquisition policy: ${policy}`, 'invalid_material_policy');
  return policy;
}

function objectWithOnly(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`, 'invalid_material_intent');
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) fail(`${label} contains unsupported field: ${unknown}`, 'invalid_material_intent');
  return value;
}

function boundedText(value, label, pattern, maxLength) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)
      || (pattern && !pattern.test(text)))
    fail(`${label} is invalid`, 'invalid_material_intent');
  return text;
}

function boundedNumber(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    fail(`${label} is invalid`, 'invalid_material_intent');
  return number;
}

function normalizePresentation(value) {
  const source = objectWithOnly(value, ['profileId'], 'presentation');
  const profileId = boundedText(
    source.profileId, 'presentation.profileId', /^[a-zA-Z0-9._-]+$/, 160);
  if (profileId !== READY_TO_PLACE_PROFILE_ID)
    fail('presentation.profileId is unsupported', 'invalid_material_intent');
  return { profileId };
}

function normalizePlacement(value) {
  const source = objectWithOnly(value, ['layoutId', 'startSec', 'anchor'], 'placement');
  const layoutId = boundedText(
    source.layoutId, 'placement.layoutId', /^[a-zA-Z0-9._-]+$/, 160);
  if (layoutId !== READY_TO_PLACE_LAYOUT)
    fail('placement.layoutId is unsupported', 'invalid_material_intent');
  const hasStart = source.startSec != null;
  const hasAnchor = source.anchor != null;
  if (hasStart === hasAnchor)
    fail('placement requires exactly one startSec or anchor', 'invalid_material_intent');
  if (hasStart) {
    return {
      layoutId,
      startSec: boundedNumber(source.startSec, 'placement.startSec', { min: 0, max: 3600 }),
    };
  }
  const anchor = objectWithOnly(source.anchor, ['startCharIdx', 'phrase'], 'placement.anchor');
  const hasIndex = anchor.startCharIdx != null;
  const hasPhrase = anchor.phrase != null;
  if (hasIndex === hasPhrase)
    fail('placement.anchor requires exactly one startCharIdx or phrase', 'invalid_material_intent');
  if (hasIndex) {
    const startCharIdx = boundedNumber(
      anchor.startCharIdx, 'placement.anchor.startCharIdx', { min: 0, max: 1_000_000 });
    if (!Number.isInteger(startCharIdx))
      fail('placement.anchor.startCharIdx is invalid', 'invalid_material_intent');
    return { layoutId, anchor: { startCharIdx } };
  }
  return {
    layoutId,
    anchor: { phrase: boundedText(anchor.phrase, 'placement.anchor.phrase', null, 240) },
  };
}

function resolvePreparedVideoPlacement(intent, scriptRaw) {
  const phrase = intent?.operation === 'prepared-video' && intent.placement?.anchor?.phrase;
  if (!phrase) return intent;
  let resolved;
  try { resolved = resolveUniquePhraseAnchor({ scriptRaw, phrase }); }
  catch (error) { fail(error.message, 'invalid_material_intent'); }
  return {
    ...intent,
    placement: {
      layoutId: intent.placement.layoutId,
      anchor: { phrase, startCharIdx: resolved.startCharIdx },
    },
  };
}

function normalizeMaterialAcquisitionIntent(value) {
  const intent = objectWithOnly(value,
    ['policy', 'operation', 'mode', 'route', 'stock', 'recipe', 'presentation', 'placement'],
    'materialAcquisition');
  const policy = normalizePolicy(intent.policy);
  const operation = boundedText(intent.operation, 'operation', /^[a-z-]+$/, 20);
  if (!OPERATIONS.has(operation)) fail('operation is unsupported', 'invalid_material_intent');
  const mode = boundedText(intent.mode, 'mode', /^[a-z]+$/, 12);
  if (!MODES.has(mode)) fail('mode is unsupported', 'invalid_material_intent');
  const route = boundedText(intent.route, 'route', /^chipk\.[a-zA-Z0-9._-]+$/, 160);
  let stock = null;
  if (intent.stock != null) {
    const source = objectWithOnly(intent.stock, ['id', 'name'], 'stock');
    stock = {};
    if (source.id != null)
      stock.id = boundedText(source.id, 'stock.id', /^[a-zA-Z0-9._-]+$/, 32);
    if (source.name != null)
      stock.name = boundedText(source.name, 'stock.name', null, 80);
    if (!stock.id && !stock.name) fail('stock is empty', 'invalid_material_intent');
  }
  const recipe = intent.recipe == null ? null
    : boundedText(intent.recipe, 'recipe', /^[a-zA-Z0-9._-]+$/, 160);
  if (operation === 'record' && !recipe)
    fail('record operation requires recipe', 'invalid_material_intent');
  if (operation !== 'record' && recipe)
    fail(`${operation} operation does not accept recipe`, 'invalid_material_intent');
  if (operation === 'prepared-video') {
    if (policy !== 'require-capture')
      fail('prepared-video requires require-capture policy', 'invalid_material_intent');
    if (route !== READY_TO_PLACE_ROUTE || stock?.id !== READY_TO_PLACE_STOCK.id
        || stock?.name !== READY_TO_PLACE_STOCK.name)
      fail('prepared-video target is outside the supported vertical slice',
        'invalid_material_intent');
    return {
      policy, operation, mode, route, stock, recipe: null,
      presentation: normalizePresentation(intent.presentation),
      placement: normalizePlacement(intent.placement),
    };
  }
  if (intent.presentation != null || intent.placement != null)
    fail(`${operation} operation does not accept presentation or placement`,
      'invalid_material_intent');
  return { policy, operation, mode, route, stock, recipe };
}

function buildCaptureRequest(intent, { requestId, outputDirectory }) {
  const target = { routeId: intent.route };
  if (intent.stock?.id) target.stockId = intent.stock.id;
  if (intent.stock?.name) target.stockName = intent.stock.name;
  if (intent.recipe) target.recipeId = intent.recipe;
  const request = {
    contractVersion: intent.operation === 'prepared-video'
      ? READY_TO_PLACE_CONTRACT_VERSION : LEGACY_CONTRACT_VERSION,
    requestId,
    operation: intent.operation,
    mode: intent.mode,
    target,
    outputDirectory: path.resolve(outputDirectory),
  };
  if (intent.operation === 'prepared-video') request.presentation = { ...intent.presentation };
  return request;
}

function errorCode(error, fallback) {
  return typeof error?.code === 'string' && error.code ? error.code : fallback;
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
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function resolveArtifact(outputDirectory, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')
      || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..'))
    fail('Provider artifact path is unsafe', 'provider_artifact_path_invalid');
  const root = path.resolve(outputDirectory);
  const target = path.resolve(root, ...relativePath.split('/'));
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    fail('Provider artifact escaped its output directory', 'provider_artifact_path_invalid');
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (_) {}
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('Provider output directory is invalid', 'provider_output_invalid');
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (_) {
      fail('Provider artifact is missing', 'provider_artifact_missing');
    }
    if (stat.isSymbolicLink())
      fail('Provider artifact uses a symlink', 'provider_artifact_path_invalid');
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size < 1)
    fail('Provider artifact is empty or not a file', 'provider_artifact_invalid');
  const rootReal = fs.realpathSync(root);
  const targetReal = fs.realpathSync(target);
  const realRel = path.relative(rootReal, targetReal);
  if (!realRel || realRel === '..' || realRel.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRel))
    fail('Provider artifact escaped its output directory', 'provider_artifact_path_invalid');
  return { absolutePath: target, size: stat.size };
}

function inspectPngDimensions(file) {
  const bytes = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null;
  } finally { fs.closeSync(fd); }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR')
    return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function inspectVideoSpec(file) {
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,duration:format=duration',
      '-of', 'json', path.resolve(file),
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 });
    const parsed = JSON.parse(output);
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
    return stream && {
      codec: stream.codec_name,
      width: Number(stream.width),
      height: Number(stream.height),
      durationSeconds: Number(stream.duration || parsed.format?.duration),
    };
  } catch (_) { return null; }
}

function validateReadyToPlaceEvidence(evidence, request, profileCapability) {
  const profile = evidence && evidence.presentationProfile;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).length !== READY_EVIDENCE_KEYS.size
      || Object.keys(evidence).some((key) => !READY_EVIDENCE_KEYS.has(key))
      || evidence.routeSelection !== 'catalog_exact_match'
      || evidence.navigation !== 'expected_texts_verified'
      || evidence.material !== 'ready_to_place'
      || typeof evidence.catalogVersion !== 'string' || !evidence.catalogVersion.trim()
      || /[\u0000-\u001f\u007f]/.test(evidence.catalogVersion)
      || !profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).length !== READY_PROFILE_EVIDENCE_KEYS.size
      || Object.keys(profile).some((key) => !READY_PROFILE_EVIDENCE_KEYS.has(key))
      || profile.id !== request.presentation?.profileId
      || profile.id !== profileCapability?.id
      || profile.version !== profileCapability?.version
      || profile.status !== profileCapability?.status
      || profile.status !== 'ready_to_place'
      || evidence.publication !== 'atomic_directory_rename') {
    fail('Provider ready-to-place evidence is incomplete or open',
      'provider_evidence_invalid');
  }
}

function artifactJson(artifact) {
  try { return JSON.parse(fs.readFileSync(artifact.absolutePath, 'utf8')); }
  catch (_) { fail('Provider JSON artifact is invalid', 'provider_mime_mismatch'); }
}

function validatePreparedBundle(result, request, artifacts, profileCapability) {
  const roles = Object.fromEntries(artifacts.map((artifact) => [artifact.role, artifact]));
  const screenshot = roles.screenshot;
  const video = roles['prepared-video'];
  const captureArtifact = roles['capture-manifest'];
  const planArtifact = roles['presentation-plan'];
  const preparationArtifact = roles['preparation-manifest'];
  const capture = artifactJson(captureArtifact);
  const plan = artifactJson(planArtifact);
  const preparation = artifactJson(preparationArtifact);
  const evidence = result.evidence;
  const expectedTexts = capture?.verification?.expectedTexts;
  const matchedTexts = capture?.verification?.matchedTexts;
  const contentExpected = capture?.verification?.contentTexts?.expected;
  const contentObserved = capture?.verification?.contentTexts?.observed;
  const contentMissing = capture?.verification?.contentTexts?.missing;
  const screenshotName = path.posix.basename(screenshot.relativePath);
  const captureName = path.posix.basename(captureArtifact.relativePath);
  const videoName = path.posix.basename(video.relativePath);
  const planName = path.posix.basename(planArtifact.relativePath);
  const profile = evidence.presentationProfile;

  if (capture?.schemaVersion !== 1
      || capture?.route?.id !== request.target.routeId
      || String(capture?.parameters?.stockid) !== request.target.stockId
      || (request.target.stockName !== undefined
        && capture?.parameters?.stockname !== request.target.stockName)
      || capture?.screenshot?.file !== screenshotName
      || capture?.screenshot?.sha256 !== screenshot.sha256
      || !Array.isArray(expectedTexts) || expectedTexts.length < 1
      || !Array.isArray(matchedTexts)
      || expectedTexts.some((text) => !matchedTexts.includes(text))
      || !Array.isArray(contentExpected) || contentExpected.length < 1
      || !Array.isArray(contentObserved)
      || contentExpected.some((text) => !contentObserved.includes(text))
      || !Array.isArray(contentMissing) || contentMissing.length !== 0
      || capture?.catalogVersion !== evidence.catalogVersion
      || plan?.schemaVersion !== 1 || plan?.contractVersion !== request.contractVersion
      || plan?.requestId !== request.requestId || plan?.operation !== request.operation
      || plan?.profile?.id !== profileCapability.id
      || plan?.profile?.id !== profile.id
      || plan?.profile?.version !== profileCapability.version
      || plan?.profile?.version !== profile.version
      || plan?.profile?.status !== profileCapability.status
      || plan?.profile?.status !== profile.status
      || !/^[a-f0-9]{64}$/.test(plan?.profile?.canonicalSha256 || '')
      || plan?.target?.routeId !== request.target.routeId
      || String(plan?.target?.stockId) !== request.target.stockId
      || (request.target.stockName !== undefined
        && plan?.target?.stockName !== request.target.stockName)
      || plan?.target?.mode !== request.mode
      || plan?.source?.kind !== 'screenshot'
      || plan?.source?.file !== screenshotName
      || plan?.source?.sha256 !== screenshot.sha256
      || plan?.source?.captureManifest?.file !== captureName
      || plan?.source?.captureManifest?.sha256 !== captureArtifact.sha256
      || plan?.source?.width !== screenshot.media.width
      || plan?.source?.height !== screenshot.media.height
      || plan?.output?.codec !== video.media.codec
      || plan?.output?.width !== video.media.width
      || plan?.output?.height !== video.media.height
      || plan?.output?.pixelFormat !== 'yuv420p'
      || plan?.output?.audio !== 'none'
      || plan?.timeline?.durationSeconds !== video.media.durationSeconds
      || !Number.isInteger(plan?.timeline?.fps) || plan.timeline.fps < 1
      || plan?.timeline?.frameCount !== plan.timeline.durationSeconds * plan.timeline.fps
      || !/^[a-f0-9]{64}$/.test(plan?.canonicalSha256 || '')
      || preparation?.schemaVersion !== 1
      || preparation?.contractVersion !== request.contractVersion
      || preparation?.requestId !== request.requestId
      || preparation?.status !== 'ready_to_place'
      || preparation?.profile?.id !== profileCapability.id
      || preparation?.profile?.id !== profile.id
      || preparation?.profile?.id !== plan.profile.id
      || preparation?.profile?.version !== profileCapability.version
      || preparation?.profile?.version !== profile.version
      || preparation?.profile?.version !== plan.profile.version
      || preparation?.profile?.status !== profileCapability.status
      || preparation?.profile?.status !== profile.status
      || preparation?.profile?.status !== plan.profile.status
      || preparation?.profile?.canonicalSha256 !== plan.profile.canonicalSha256
      || preparation?.source?.kind !== plan.source.kind
      || preparation?.source?.file !== screenshotName
      || preparation?.source?.sha256 !== screenshot.sha256
      || preparation?.source?.captureManifest?.file !== captureName
      || preparation?.source?.captureManifest?.sha256 !== captureArtifact.sha256
      || preparation?.source?.width !== plan.source.width
      || preparation?.source?.height !== plan.source.height
      || preparation?.target?.routeId !== request.target.routeId
      || String(preparation?.target?.stockId) !== request.target.stockId
      || (request.target.stockName !== undefined
        && preparation?.target?.stockName !== request.target.stockName)
      || preparation?.target?.mode !== request.mode
      || preparation?.presentationPlan?.file !== planName
      || preparation?.presentationPlan?.sha256 !== planArtifact.sha256
      || preparation?.presentationPlan?.canonicalSha256 !== plan.canonicalSha256
      || preparation?.output?.role !== 'prepared-video'
      || preparation?.output?.file !== videoName
      || preparation?.output?.sha256 !== video.sha256
      || preparation?.output?.codec !== video.media.codec
      || preparation?.output?.width !== video.media.width
      || preparation?.output?.height !== video.media.height
      || preparation?.output?.durationSeconds !== video.media.durationSeconds
      || preparation?.output?.fps !== plan.timeline.fps
      || preparation?.output?.pixelFormat !== plan.output.pixelFormat
      || preparation?.output?.audio !== plan.output.audio
      || preparation?.publication?.strategy !== 'staging_directory_atomic_rename'
      || preparation?.publication?.finalDirectory !== 'ready-to-place') {
    fail('Provider ready-to-place provenance is inconsistent',
      'provider_provenance_invalid');
  }
}

function validateMediaDescriptor(artifact, file) {
  const media = artifact.media;
  if (artifact.kind === 'json') {
    if (media !== undefined) fail('JSON artifact must not have media spec', 'provider_media_invalid');
    try { JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { fail('Provider JSON artifact is invalid', 'provider_mime_mismatch'); }
    return;
  }
  if (!media || typeof media !== 'object' || Array.isArray(media))
    fail('Provider media spec is missing', 'provider_media_invalid');
  const keys = artifact.kind === 'image'
    ? ['width', 'height'] : ['codec', 'width', 'height', 'durationSeconds'];
  if (Object.keys(media).some((key) => !keys.includes(key))
      || keys.some((key) => media[key] === undefined))
    fail('Provider media spec is incompatible', 'provider_media_invalid');
  if (!Number.isInteger(media.width) || media.width < 1
      || !Number.isInteger(media.height) || media.height < 1)
    fail('Provider media dimensions are invalid', 'provider_media_invalid');
  const inspected = inspectMediaFile(file);
  if (!inspected || inspected.kind !== artifact.kind || inspected.mediaType !== artifact.mimeType)
    fail('Provider artifact MIME does not match its content', 'provider_mime_mismatch');
  if (artifact.kind === 'image') {
    const actual = inspectPngDimensions(file);
    if (!actual || actual.width !== media.width || actual.height !== media.height)
      fail('Provider image dimensions do not match', 'provider_media_mismatch');
    return;
  }
  if (typeof media.codec !== 'string' || !/^[a-zA-Z0-9._-]{1,40}$/.test(media.codec)
      || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0)
    fail('Provider video media spec is invalid', 'provider_media_invalid');
  const actual = inspectVideoSpec(file);
  const tolerance = Math.max(0.5, media.durationSeconds * 0.02);
  if (!actual || actual.codec !== media.codec || actual.width !== media.width
      || actual.height !== media.height || !Number.isFinite(actual.durationSeconds)
      || Math.abs(actual.durationSeconds - media.durationSeconds) > tolerance)
    fail('Provider video media spec does not match', 'provider_media_mismatch');
}

function validateCaptureResult(result, request, profileCapability = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.contractVersion !== request.contractVersion || result.requestId !== request.requestId
      || !result.provider || result.provider.id !== PROVIDER_ID
      || typeof result.provider.toolVersion !== 'string' || !result.provider.toolVersion.trim()
      || !RESULT_STATUSES.has(result.status))
    fail('Provider result envelope is incompatible', 'provider_result_incompatible');
  if (result.provider.toolVersion !== PROVIDER_LOCK.toolVersion)
    fail('Provider result version does not match the consumer lock',
      'provider_version_incompatible');
  if (Object.keys(result).some((key) => !RESULT_KEYS.has(key))
      || typeof result.requestId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.requestId)
      || typeof result.provider !== 'object' || Array.isArray(result.provider)
      || Object.keys(result.provider).some((key) => !PROVIDER_KEYS.has(key))
      || typeof result.evidence !== 'object' || result.evidence === null
      || Array.isArray(result.evidence) || !Array.isArray(result.artifacts))
    fail('Provider result envelope is incompatible', 'provider_result_incompatible');
  const completed = result.status === 'completed';
  if (completed && result.error !== null)
    fail('Completed provider result must have null error', 'provider_result_incompatible');
  if (!completed && (!result.error || typeof result.error !== 'object'
      || Array.isArray(result.error)
      || Object.keys(result.error).some((key) => !ERROR_KEYS.has(key))
      || typeof result.error.code !== 'string' || !result.error.code.trim()
      || typeof result.error.message !== 'string' || !result.error.message.trim()
      || typeof result.error.retryable !== 'boolean'))
    fail('Incomplete provider result must have a typed error', 'provider_result_incompatible');
  if (result.status !== 'completed') {
    if (result.artifacts.length !== 0)
      fail('Incomplete provider result must not contain artifacts', 'provider_result_incompatible');
    return { result, artifacts: [] };
  }
  if (request.contractVersion === READY_TO_PLACE_CONTRACT_VERSION)
    validateReadyToPlaceEvidence(result.evidence, request, profileCapability);
  const required = REQUIRED_ROLES[request.operation];
  if (!required || result.artifacts.length !== required.length)
    fail('Provider returned the wrong artifact set', 'provider_artifact_set_invalid');
  const seen = new Set();
  const seenPaths = new Set();
  const artifacts = result.artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
      fail('Provider artifact descriptor is invalid', 'provider_artifact_invalid');
    const spec = ARTIFACT_SPEC[artifact.role];
    if (Object.keys(artifact).some((key) => !ARTIFACT_KEYS.has(key))
        || !spec || !required.includes(artifact.role) || seen.has(artifact.role)
        || seenPaths.has(artifact.relativePath)
        || artifact.kind !== spec.kind || artifact.mimeType !== spec.mimeType
        || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256))
      fail('Provider artifact descriptor is incompatible', 'provider_artifact_invalid');
    seen.add(artifact.role);
    seenPaths.add(artifact.relativePath);
    const resolved = resolveArtifact(request.outputDirectory, artifact.relativePath);
    if (hashFile(resolved.absolutePath) !== artifact.sha256)
      fail('Provider artifact hash does not match', 'provider_artifact_hash_mismatch');
    validateMediaDescriptor(artifact, resolved.absolutePath);
    return { ...artifact, absolutePath: resolved.absolutePath, size: resolved.size };
  });
  if (required.some((role) => !seen.has(role)))
    fail('Provider artifact set is incomplete', 'provider_artifact_set_invalid');
  if (request.contractVersion === READY_TO_PLACE_CONTRACT_VERSION)
    validatePreparedBundle(result, request, artifacts, profileCapability);
  return { result, artifacts };
}

function findContractCapability(capabilities, request) {
  if (request.contractVersion === LEGACY_CONTRACT_VERSION) {
    if (capabilities?.schemaVersion !== LEGACY_CONTRACT_VERSION
        || !Array.isArray(capabilities?.operations)
        || !capabilities.operations.includes(request.operation)) return null;
    return {
      entry: { contractVersion: LEGACY_CONTRACT_VERSION, operations: capabilities.operations },
      profile: null,
    };
  }
  if (request.contractVersion !== READY_TO_PLACE_CONTRACT_VERSION
      || !Array.isArray(capabilities?.contractCapabilities)) return null;
  const matches = capabilities.contractCapabilities.filter(
    (entry) => entry && entry.contractVersion === READY_TO_PLACE_CONTRACT_VERSION);
  if (matches.length !== 1) return null;
  const entry = matches[0];
  if (!Array.isArray(entry.operations) || entry.operations.length !== 1
      || entry.operations[0] !== request.operation
      || typeof entry.requestSchema !== 'string' || !entry.requestSchema
      || typeof entry.resultSchema !== 'string' || !entry.resultSchema
      || !Array.isArray(entry.presentationProfiles)) return null;
  const profiles = entry.presentationProfiles.filter(
    (item) => item && item.id === request.presentation?.profileId);
  const profile = profiles.length === 1 ? profiles[0] : null;
  if (!profile || profile.version !== 1 || profile.status !== 'ready_to_place'
      || profile.sourceKind !== 'screenshot' || profile.artifactRole !== 'prepared-video'
      || !Array.isArray(profile.routeIds)
      || !profile.routeIds.includes(request.target.routeId)
      || !Array.isArray(profile.stockIds) || profile.stockIds.length !== 1
      || profile.stockIds[0] !== request.target.stockId) return null;
  return { entry, profile };
}

async function fallbackResult(fallback, request, reason, provider = null) {
  const value = fallback
    ? await fallback({ request, reason, provider })
    : { source: 'neutral-fallback', evidenceLevel: 'illustrative_not_fresh_capture' };
  return {
    status: 'fallback', reason, provider,
    evidenceLevel: value?.evidenceLevel || 'illustrative_not_fresh_capture',
    material: value?.material || null,
    source: value?.source || 'neutral-fallback',
  };
}

function readyToPlaceLiveReadinessCode(
  request, capabilities, providerLock = PROVIDER_LOCK,
) {
  if (request?.contractVersion !== READY_TO_PLACE_CONTRACT_VERSION
      || request.mode !== 'live') return null;
  if (providerLock?.readyToPlaceLiveEnabled !== true)
    return 'provider_ready_to_place_live_disabled';
  if (capabilities?.runReadiness?.vipSession !== 'verified_before_mutation')
    return 'provider_live_readiness_unverified';
  return null;
}

async function acquireOptionalMaterial({
  policy = 'prefer-capture', request, provider = null, fallback = null,
}) {
  const selectedPolicy = normalizePolicy(policy);
  if (selectedPolicy === 'disable-capture') {
    return {
      status: 'skipped', reason: 'capture_disabled', provider: null,
      evidenceLevel: 'none', material: null,
    };
  }
  if (!provider) {
    if (selectedPolicy === 'require-capture')
      fail('Required material provider is not configured', 'provider_unconfigured');
    return fallbackResult(fallback, request, 'provider_unconfigured');
  }
  let capabilities;
  try { capabilities = await provider.capabilities(); }
  catch (error) {
    const code = errorCode(error, 'provider_unavailable');
    if (selectedPolicy === 'require-capture')
      fail('Required material provider is unavailable', code);
    return fallbackResult(fallback, request, code);
  }
  const providerId = capabilities?.providerId || null;
  let readinessCode = null;
  let contractCapability = null;
  if (capabilities?.schemaVersion !== LEGACY_CONTRACT_VERSION || providerId !== PROVIDER_ID
      || typeof capabilities?.toolVersion !== 'string' || !capabilities.toolVersion.trim())
    readinessCode = 'provider_contract_incompatible';
  else if (capabilities.toolVersion !== PROVIDER_LOCK.toolVersion)
    readinessCode = 'provider_version_incompatible';
  else if (capabilities?.productionReady !== true)
    readinessCode = 'provider_not_production_ready';
  else if (!(contractCapability = findContractCapability(capabilities, request)))
    readinessCode = 'provider_operation_unsupported';
  else
    readinessCode = readyToPlaceLiveReadinessCode(request, capabilities);
  if (readinessCode) {
    if (selectedPolicy === 'require-capture')
      fail('Required material provider is not ready', readinessCode, { providerId });
    return fallbackResult(fallback, request, readinessCode, providerId);
  }
  try {
    const rawResult = await provider.acquire(request);
    const validated = validateCaptureResult(rawResult, request, contractCapability.profile);
    if (rawResult.status !== 'completed')
      fail('Material provider did not complete the request',
        rawResult.error?.code || `provider_${rawResult.status}`, { status: rawResult.status });
    return {
      status: 'acquired', reason: null, provider: providerId,
      providerVersion: rawResult.provider.toolVersion,
      contractVersion: rawResult.contractVersion,
      evidenceLevel: 'fresh_capture', material: validated.artifacts,
      acquisitionEvidence: rawResult.evidence,
    };
  } catch (error) {
    const code = errorCode(error, 'provider_request_failed');
    if (selectedPolicy === 'require-capture') {
      if (error instanceof MaterialAcquisitionError) throw error;
      fail('Required material acquisition failed', code);
    }
    return fallbackResult(fallback, request, code, providerId);
  }
}

module.exports = {
  LEGACY_CONTRACT_VERSION,
  MaterialAcquisitionError,
  READY_TO_PLACE_CONTRACT_VERSION,
  READY_TO_PLACE_LAYOUT,
  READY_TO_PLACE_PROFILE_ID,
  acquireOptionalMaterial,
  buildCaptureRequest,
  normalizeMaterialAcquisitionIntent,
  normalizePolicy,
  readyToPlaceLiveReadinessCode,
  resolvePreparedVideoPlacement,
  validateCaptureResult,
};
