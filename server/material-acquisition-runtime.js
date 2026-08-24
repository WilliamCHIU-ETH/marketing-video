'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createChipKCaptureCliAdapter } = require('./chipk-capture-cli-adapter');
const {
  MaterialAcquisitionError,
  acquireOptionalMaterial,
  buildCaptureRequest,
} = require('./material-acquisition');

const PREPARED_VIDEO_INPUT = 'prepared-phone-material.mp4';
const PREPARED_INTENT_INPUT = 'prepared-phone-material.intent.json';
const PREPARED_PLAN = path.posix.join(
  'src', 'Focusstock', 'prepared-phone-material.generated.json');
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PREPARED_FPS = 30;
const FOCUSSTOCK_MAIN_OFFSET_FRAMES = PREPARED_FPS;

function fail(message, code, details) {
  throw new MaterialAcquisitionError(message, code, details);
}

function ensureOwnedDirectory(parent, name) {
  const root = fs.realpathSync(parent);
  const target = path.join(root, name);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target)
    fail('Acquisition runtime directory is unsafe', 'acquisition_directory_invalid');
  return target;
}

function nextShotName(inputDirectory) {
  const used = new Set();
  for (const name of fs.readdirSync(inputDirectory)) {
    const match = /^shot(\d{1,3})\.(?:png|jpe?g)$/i.exec(name);
    if (match) used.add(Number(match[1]));
  }
  let index = 1;
  while (used.has(index) && index <= 999) index += 1;
  if (index > 999) fail('No safe shot filename is available', 'materialization_failed');
  return `shot${index}.png`;
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

function inspectPreparedVideo(file) {
  let value;
  try {
    value = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration',
      '-of', 'json', path.resolve(file),
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 }));
  } catch (_) {
    fail('Prepared phone video is not decodable', 'placement_compile_failed');
  }
  const streams = Array.isArray(value.streams) ? value.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const video = videos[0];
  const durationSeconds = Number(video?.duration || value.format?.duration);
  if (videos.length !== 1 || audio.length !== 0 || video?.codec_name !== 'h264'
      || !Number.isInteger(Number(video.width)) || Number(video.width) < 1
      || !Number.isInteger(Number(video.height)) || Number(video.height) < 1
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0)
    fail('Prepared phone video media is incompatible', 'placement_compile_failed');
  return {
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds,
  };
}

function validatePreparedPhonePlacementMath(plan, videoFile) {
  const source = plan && plan.source;
  const placement = plan && plan.placement;
  const media = source && source.media;
  const actual = inspectPreparedVideo(videoFile);
  const expectedDurationInFrames = Math.ceil(actual.durationSeconds * PREPARED_FPS);
  const expectedStartFrame = Math.round(Number(placement?.startSec) * PREPARED_FPS);
  const expectedEndFrame = expectedStartFrame + expectedDurationInFrames;
  const expectedStartSec = Number((expectedStartFrame / PREPARED_FPS).toFixed(6));
  const expectedEndSec = Number((expectedEndFrame / PREPARED_FPS).toFixed(6));
  if (!media || media.codec !== actual.codec || media.width !== actual.width
      || media.height !== actual.height || !Number.isFinite(media.durationSeconds)
      || Math.abs(media.durationSeconds - actual.durationSeconds) > 0.000001
      || placement?.fps !== PREPARED_FPS
      || placement.startFrame !== expectedStartFrame
      || placement.endFrame !== expectedEndFrame
      || placement.durationInFrames !== expectedDurationInFrames
      || placement.endFrame - placement.startFrame !== placement.durationInFrames
      || placement.startSec !== expectedStartSec || placement.endSec !== expectedEndSec) {
    fail('Prepared phone duration or frame placement is inconsistent with actual media',
      'placement_compile_failed');
  }
  return true;
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function safeEvidenceFile(acquisitionRoot, requestId, evidence) {
  const name = `${requestId}.provider-evidence.json`;
  const file = path.join(acquisitionRoot, name);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  return path.posix.join('acquisition', name);
}

function baseSummary(intent, request, result, nowISO) {
  return {
    requestId: request.requestId,
    policy: intent.policy,
    operation: intent.operation,
    mode: intent.mode,
    route: intent.route,
    status: result.status,
    reason: result.reason || null,
    evidenceLevel: result.evidenceLevel,
    provider: result.provider || null,
    contractVersion: result.contractVersion || null,
    providerVersion: result.providerVersion || null,
    completedAt: nowISO(),
    ...(intent.presentation ? { presentation: intent.presentation } : {}),
    ...(intent.placement ? { requestedPlacement: intent.placement } : {}),
  };
}

function relativeEvidencePath(jobDirectory, file) {
  const root = fs.realpathSync(jobDirectory);
  const target = fs.realpathSync(file);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) fail('Artifact evidence path escaped Run', 'materialization_failed');
  return relative.split(path.sep).join('/');
}

function stagePreparedPhoneMaterial({
  intent,
  request,
  result,
  summary,
  jobDirectory,
}) {
  const prepared = result.material.find((item) => item.role === 'prepared-video');
  if (!prepared || prepared.kind !== 'video' || prepared.mimeType !== 'video/mp4'
      || !prepared.media || !Number.isFinite(prepared.media.durationSeconds)
      || prepared.media.durationSeconds <= 0)
    fail('Validated prepared video artifact is missing', 'materialization_failed');
  const inputDirectory = ensureOwnedDirectory(jobDirectory, 'input');
  const videoFile = path.join(inputDirectory, PREPARED_VIDEO_INPUT);
  fs.copyFileSync(prepared.absolutePath, videoFile, fs.constants.COPYFILE_EXCL);
  if (hashFile(videoFile) !== prepared.sha256)
    fail('Prepared video changed while staging', 'materialization_failed');
  const intentFile = path.join(inputDirectory, PREPARED_INTENT_INPUT);
  writePrivateJson(intentFile, {
    schemaVersion: 1,
    mode: 'ready-to-place',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    provider: { id: result.provider, toolVersion: result.providerVersion },
    target: request.target,
    presentation: intent.presentation,
    placement: intent.placement,
    source: {
      fileName: PREPARED_VIDEO_INPUT,
      artifactRole: prepared.role,
      sha256: prepared.sha256,
      size: prepared.size,
      mimeType: prepared.mimeType,
      media: prepared.media,
    },
  });
  summary.artifacts = result.material.map((artifact) => ({
    role: artifact.role,
    sha256: artifact.sha256,
    mimeType: artifact.mimeType,
    size: artifact.size,
    media: artifact.media || null,
    evidenceFile: relativeEvidencePath(jobDirectory, artifact.absolutePath),
  }));
  summary.preparedArtifact = {
    role: prepared.role,
    inputName: PREPARED_VIDEO_INPUT,
    intentInputName: PREPARED_INTENT_INPUT,
    sha256: prepared.sha256,
    mimeType: prepared.mimeType,
    size: prepared.size,
    media: prepared.media,
  };
  summary.placementStatus = 'pending_compile';
  summary.automaticTimelineUse = false;
}

function readPreparedPlan(workspaceRoot) {
  const file = path.join(workspaceRoot, ...PREPARED_PLAN.split('/'));
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail('Prepared phone placement plan is missing or invalid', 'placement_compile_failed'); }
  return { file, plan };
}

function validateCompiledPreparedPlan({
  job,
  jobDirectory,
  workspaceRoot,
  publicDirectory = path.join(workspaceRoot, 'public'),
}) {
  const summary = job.materialAcquisitionResult;
  if (job.materialAcquisition?.operation !== 'prepared-video'
      || !summary || summary.status !== 'acquired'
      || summary.placementStatus !== 'pending_compile'
      || !summary.preparedArtifact || !SHA256_HEX.test(summary.preparedArtifact.sha256 || ''))
    fail('Prepared phone material is not awaiting placement', 'placement_compile_failed');
  const { file: planFile, plan } = readPreparedPlan(workspaceRoot);
  const focusstockShotsFile = path.join(
    workspaceRoot, 'src', 'Focusstock', 'focusstock-shots.generated.json');
  let focusstockShots;
  try { focusstockShots = JSON.parse(fs.readFileSync(focusstockShotsFile, 'utf8')); }
  catch (_) {
    fail('Prepared phone placement requires an explicit empty Focusstock shot plan',
      'placement_compile_failed');
  }
  if (!Array.isArray(focusstockShots) || focusstockShots.length !== 0)
    fail('Prepared phone placement conflicts with generic Focusstock shots',
      'placement_compile_failed');
  const placement = plan && plan.placement;
  const source = plan && plan.source;
  const ownership = plan && plan.visualOwnership;
  if (plan.schemaVersion !== 1 || plan.mode !== 'ready-to-place'
      || plan.template !== 'focusstock' || plan.timelineBasis !== 'focusstock-main-v1'
      || plan.contractVersion !== 2 || plan.requestId !== summary.requestId
      || plan.presentation?.profileId !== job.materialAcquisition.presentation.profileId
      || !ownership || ownership.owner !== 'prepared-phone-video'
      || ownership.conflictPolicy !== 'suppress-entire-overlapping-placement'
      || !Array.isArray(ownership.suppressedChannels)
      || ownership.suppressedChannels.length !== 2
      || ownership.suppressedChannels[0] !== 'focusstock-shots'
      || ownership.suppressedChannels[1] !== 'focusstock-broll'
      || !source || source.fileName !== PREPARED_VIDEO_INPUT
      || source.artifactRole !== 'prepared-video'
      || source.sha256 !== summary.preparedArtifact.sha256
      || source.size !== summary.preparedArtifact.size
      || !placement || placement.layoutId !== job.materialAcquisition.placement.layoutId
      || !Number.isFinite(placement.startSec) || placement.startSec < 0
      || !Number.isFinite(placement.endSec) || placement.endSec <= placement.startSec
      || !Number.isInteger(placement.durationInFrames) || placement.durationInFrames < 1
      || placement.playbackRate !== 1 || placement.muted !== true
      || placement.objectFit !== 'contain' || placement.crop !== 'none'
      || placement.trim !== 'none' || placement.loop !== false)
    fail('Prepared phone placement plan is incompatible', 'placement_compile_failed');
  const publicFile = path.join(publicDirectory, PREPARED_VIDEO_INPUT);
  const inputFile = path.join(jobDirectory, 'input', PREPARED_VIDEO_INPUT);
  for (const file of [publicFile, inputFile]) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (_) {}
    if (!stat || !stat.isFile() || stat.isSymbolicLink()
        || stat.size !== source.size || hashFile(file) !== source.sha256)
      fail('Prepared phone video bytes drifted before selection', 'placement_compile_failed');
  }
  validatePreparedPhonePlacementMath(plan, publicFile);
  if (hashFile(planFile) !== summary.compiledPlanSha256 && summary.compiledPlanSha256)
    fail('Prepared phone placement plan drifted', 'placement_compile_failed');
  return { plan, planFile, publicFile };
}

function finalizePreparedPhoneMaterial({
  job,
  jobDirectory,
  workspaceRoot,
  publicDirectory,
  projectStore,
}) {
  if (job.materialAcquisition?.operation !== 'prepared-video') return null;
  const validated = validateCompiledPreparedPlan({
    job, jobDirectory, workspaceRoot, publicDirectory,
  });
  const summary = job.materialAcquisitionResult;
  const asset = projectStore.ingestAsset(job.projectId, validated.publicFile, {
    originalName: `${job.materialAcquisition.route}.ready-to-place.mp4`,
    kind: 'video',
    role: 'prepared-phone-video',
    origin: 'chipk-simulator-capture',
  });
  const assetFile = projectStore.assetPath(job.projectId, asset.id);
  let assetStat;
  try { assetStat = assetFile && fs.lstatSync(assetFile); } catch (_) {}
  if (asset.sha256 !== summary.preparedArtifact.sha256
      || asset.size !== summary.preparedArtifact.size
      || !assetStat?.isFile() || assetStat.isSymbolicLink()
      || assetStat.size !== asset.size || hashFile(assetFile) !== asset.sha256)
    fail('Selected Project Asset does not match prepared bytes', 'placement_compile_failed');
  summary.compiledPlanFile = PREPARED_PLAN;
  summary.compiledPlanSha256 = hashFile(validated.planFile);
  summary.placement = validated.plan.placement;
  summary.placementStatus = 'compiled_pending_evidence';
  summary.automaticTimelineUse = false;
  delete summary.preparedArtifact.assetRef;
  return { asset, plan: validated.plan };
}

function buildPreparedPhoneTimelinePlacement(job, plan, explicitAssetRef = null) {
  const summary = job.materialAcquisitionResult;
  const source = plan && plan.source;
  const placement = plan && plan.placement;
  const assetRef = explicitAssetRef || summary?.preparedArtifact?.assetRef;
  if (job.materialAcquisition?.operation !== 'prepared-video'
      || !summary || !['compiled_pending_evidence', 'compiled'].includes(summary.placementStatus)
      || !assetRef
      || !SHA256_HEX.test(summary.compiledPlanSha256 || '')
      || plan?.mode !== 'ready-to-place'
      || plan.presentation?.profileId !== job.materialAcquisition.presentation?.profileId
      || !source || source.sha256 !== summary.preparedArtifact.sha256
      || !placement || placement.layoutId !== job.materialAcquisition.placement?.layoutId) {
    fail('Prepared phone timeline evidence is incomplete', 'placement_compile_failed');
  }
  return {
    kind: 'prepared-phone-video',
    assetRef,
    profileId: plan.presentation.profileId,
    layoutId: placement.layoutId,
    visualOwner: plan.visualOwnership.owner,
    conflictPolicy: plan.visualOwnership.conflictPolicy,
    timelineBasis: plan.timelineBasis,
    fps: placement.fps,
    startFrame: placement.startFrame,
    endFrame: placement.endFrame,
    durationInFrames: placement.durationInFrames,
    startSec: placement.startSec,
    endSec: placement.endSec,
    compositionTimeline: 'Focusstock',
    compositionOffsetFrames: FOCUSSTOCK_MAIN_OFFSET_FRAMES,
    compositionStartFrame: placement.startFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES,
    compositionEndFrame: placement.endFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES,
    compositionStartSec: Number(
      ((placement.startFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES) / PREPARED_FPS).toFixed(6)),
    compositionEndSec: Number(
      ((placement.endFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES) / PREPARED_FPS).toFixed(6)),
    sourceSha256: source.sha256,
    planSha256: summary.compiledPlanSha256,
  };
}

function commitPreparedPhoneMaterialSelection({ job, asset, plan, projectStore }) {
  const summary = job.materialAcquisitionResult;
  const storedAsset = projectStore?.get(job.projectId)?.assets?.find((item) => item.id === asset?.id);
  const storedFile = storedAsset && projectStore.assetPath(job.projectId, storedAsset.id);
  let storedStat;
  try { storedStat = storedFile && fs.lstatSync(storedFile); } catch (_) {}
  if (!asset || asset.role !== 'prepared-phone-video'
      || asset.origin !== 'chipk-simulator-capture'
      || asset.sha256 !== summary?.preparedArtifact?.sha256
      || storedAsset?.sha256 !== asset.sha256 || storedAsset?.size !== asset.size
      || !storedStat?.isFile() || storedStat.isSymbolicLink()
      || storedStat.size !== asset.size || hashFile(storedFile) !== asset.sha256
      || summary.placementStatus !== 'compiled_pending_evidence'
      || summary.automaticTimelineUse !== false
      || summary.preparedArtifact.assetRef) {
    fail('Prepared phone selection is not ready to commit', 'placement_compile_failed');
  }
  const timelinePlacement = buildPreparedPhoneTimelinePlacement(job, plan, asset.id);
  if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
  summary.preparedArtifact.assetRef = asset.id;
  summary.placementStatus = 'compiled';
  summary.automaticTimelineUse = true;
  return timelinePlacement;
}

function rollbackPreparedPhoneMaterialSelection(job) {
  const summary = job.materialAcquisitionResult;
  const assetRef = summary?.preparedArtifact?.assetRef;
  if (assetRef) job.assetRefs = job.assetRefs.filter((id) => id !== assetRef);
  if (summary?.preparedArtifact) delete summary.preparedArtifact.assetRef;
  if (summary?.placementStatus === 'compiled') summary.placementStatus = 'compiled_pending_evidence';
  if (summary) summary.automaticTimelineUse = false;
}

function validatePreparedPhoneProjectAsset({ job, projectStore }) {
  if (job.materialAcquisition?.operation !== 'prepared-video') return null;
  const summary = job.materialAcquisitionResult;
  const assetRef = summary?.preparedArtifact?.assetRef;
  const placements = (job.timelinePlacements || []).filter((item) =>
    item?.kind === 'prepared-phone-video');
  if (summary?.placementStatus !== 'compiled' || summary.automaticTimelineUse !== true
      || !assetRef || !job.assetRefs?.includes(assetRef) || placements.length !== 1
      || placements[0].assetRef !== assetRef
      || placements[0].sourceSha256 !== summary.preparedArtifact.sha256
      || placements[0].planSha256 !== summary.compiledPlanSha256) {
    fail('Prepared phone Project Asset selection is incomplete', 'placement_compile_failed');
  }
  const project = projectStore.get(job.projectId);
  const asset = project?.assets?.find((item) => item.id === assetRef);
  const assetFile = asset && projectStore.assetPath(job.projectId, assetRef);
  let stat;
  try { stat = assetFile && fs.lstatSync(assetFile); } catch (_) {}
  if (!asset || asset.role !== 'prepared-phone-video'
      || asset.origin !== 'chipk-simulator-capture'
      || asset.sha256 !== summary.preparedArtifact.sha256
      || asset.size !== summary.preparedArtifact.size
      || !stat?.isFile() || stat.isSymbolicLink() || stat.size !== asset.size
      || hashFile(assetFile) !== asset.sha256) {
    fail('Prepared phone Project Asset bytes are no longer durable', 'placement_compile_failed');
  }
  return { asset, assetFile, placement: placements[0] };
}

function compactPreparedPhoneAcquisition({
  job,
  jobDirectory,
  projectStore,
  saveJob,
  nowISO,
}) {
  const summary = job.materialAcquisitionResult;
  if (job.materialAcquisition?.operation !== 'prepared-video') return null;
  if (summary?.acquisitionRetention?.status === 'sidecars_only') {
    const staleTrash = path.join(jobDirectory, 'acquisition', '.compacted-binary');
    try { fs.rmSync(staleTrash, { recursive: true, force: true }); } catch (_) {}
    return { compacted: true, bytesFreed: 0, alreadyCompacted: true };
  }
  const assetRef = summary?.preparedArtifact?.assetRef;
  const preparedPlacements = (job.timelinePlacements || []).filter((item) =>
    item?.kind === 'prepared-phone-video');
  if (job.status !== 'done' || summary?.placementStatus !== 'compiled'
      || summary.automaticTimelineUse !== true || !assetRef
      || !job.assetRefs?.includes(assetRef) || preparedPlacements.length !== 1
      || preparedPlacements[0].assetRef !== assetRef
      || preparedPlacements[0].sourceSha256 !== summary.preparedArtifact.sha256
      || !SHA256_HEX.test(job.renderInputManifestSha256 || '')
      || job.renderEvidence?.schemaVersion !== 1
      || job.renderEvidence.renderInputManifestSha256 !== job.renderInputManifestSha256) {
    fail('Prepared phone acquisition is not eligible for compaction',
      'acquisition_compaction_failed');
  }
  try { validatePreparedPhoneProjectAsset({ job, projectStore }); }
  catch (_) {
    fail('Prepared Project Asset is not durable for acquisition compaction',
      'acquisition_compaction_failed');
  }
  const expectedRoles = new Set([
    'prepared-video', 'screenshot', 'capture-manifest',
    'presentation-plan', 'preparation-manifest',
  ]);
  if (!Array.isArray(summary.artifacts) || summary.artifacts.length !== expectedRoles.size
      || new Set(summary.artifacts.map(({ role }) => role)).size !== expectedRoles.size
      || summary.artifacts.some(({ role }) => !expectedRoles.has(role))) {
    fail('Prepared acquisition artifact ledger is incomplete', 'acquisition_compaction_failed');
  }
  const jobRoot = fs.realpathSync(jobDirectory);
  const acquisitionRoot = fs.realpathSync(path.join(jobDirectory, 'acquisition'));
  if (path.relative(jobRoot, acquisitionRoot).startsWith('..'))
    fail('Prepared acquisition directory escaped its Run', 'acquisition_compaction_failed');
  const resolveEvidence = (relativePath) => {
    if (typeof relativePath !== 'string' || !relativePath.startsWith('acquisition/')
        || relativePath.includes('\\') || path.posix.normalize(relativePath) !== relativePath)
      fail('Prepared acquisition evidence path is unsafe', 'acquisition_compaction_failed');
    const absolute = path.resolve(jobRoot, ...relativePath.split('/'));
    const relative = path.relative(jobRoot, absolute);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch (_) {}
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || !stat?.isFile() || stat.isSymbolicLink())
      fail('Prepared acquisition evidence file is unavailable', 'acquisition_compaction_failed');
    return { absolute, stat };
  };
  const evidenceLedger = summary.artifacts.map((artifact) => {
    const evidence = resolveEvidence(artifact.evidenceFile);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1
        || evidence.stat.size !== artifact.size
        || !SHA256_HEX.test(artifact.sha256 || '')
        || hashFile(evidence.absolute) !== artifact.sha256) {
      fail('Prepared acquisition evidence bytes drifted', 'acquisition_compaction_failed');
    }
    return { artifact, ...evidence };
  });
  const providerEvidence = resolveEvidence(summary.evidenceFile);
  try { JSON.parse(fs.readFileSync(providerEvidence.absolute, 'utf8')); }
  catch (_) { fail('Provider evidence sidecar is invalid', 'acquisition_compaction_failed'); }

  const binary = evidenceLedger.filter(({ artifact }) =>
    artifact.role === 'prepared-video' || artifact.role === 'screenshot');
  const trash = path.join(acquisitionRoot, '.compacted-binary');
  if (fs.existsSync(trash))
    fail('Prepared acquisition compaction staging already exists', 'acquisition_compaction_failed');
  fs.mkdirSync(trash, { mode: 0o700 });
  const previousArtifacts = JSON.parse(JSON.stringify(summary.artifacts));
  const moved = [];
  let bytesFreed = 0;
  try {
    for (const entry of binary) {
      const staged = path.join(trash, path.basename(entry.absolute));
      fs.renameSync(entry.absolute, staged);
      moved.push({ from: entry.absolute, staged });
      bytesFreed += entry.stat.size;
      delete entry.artifact.evidenceFile;
      entry.artifact.retention = 'compacted_after_verified_render';
    }
    summary.acquisitionRetention = {
      schemaVersion: 1,
      status: 'sidecars_only',
      policy: 'binary_compacted_after_verified_render_v1',
      compactedAt: nowISO(),
      removedRoles: ['prepared-video', 'screenshot'],
      retainedRoles: ['capture-manifest', 'presentation-plan', 'preparation-manifest'],
      bytesFreed,
    };
    saveJob(job);
  } catch (error) {
    summary.artifacts = previousArtifacts;
    delete summary.acquisitionRetention;
    for (const item of moved.reverse()) {
      try { fs.renameSync(item.staged, item.from); } catch (_) {}
    }
    try { fs.rmSync(trash, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch (_) {}
  return { compacted: true, bytesFreed, alreadyCompacted: false };
}

async function prepareJobMaterialAcquisition({
  job,
  jobDirectory,
  projectStore,
  requestIdFactory,
  nowISO,
  saveJob,
  appendLog = () => {},
  provider = createChipKCaptureCliAdapter(),
}) {
  const intent = job.materialAcquisition;
  if (!intent) return null;
  const requestId = requestIdFactory();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId))
    fail('Server generated an invalid acquisition request ID', 'invalid_request');
  if (intent.policy === 'disable-capture') {
    const summary = {
      requestId,
      policy: intent.policy,
      operation: intent.operation,
      mode: intent.mode,
      route: intent.route,
      status: 'skipped',
      reason: 'capture_disabled',
      evidenceLevel: 'none',
      provider: null,
      contractVersion: null,
      providerVersion: null,
      completedAt: nowISO(),
    };
    job.materialAcquisitionResult = summary;
    saveJob(job);
    return summary;
  }
  const acquisitionRoot = ensureOwnedDirectory(jobDirectory, 'acquisition');
  const outputDirectory = path.join(acquisitionRoot, requestId);
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const request = buildCaptureRequest(intent, { requestId, outputDirectory });
  let result;
  try {
    result = await acquireOptionalMaterial({
      policy: intent.policy,
      request,
      provider,
      fallback: async () => ({
        source: 'existing-project-assets',
        evidenceLevel: 'illustrative_not_fresh_capture',
      }),
    });
  } catch (error) {
    job.materialAcquisitionResult = {
      requestId,
      policy: intent.policy,
      operation: intent.operation,
      mode: intent.mode,
      route: intent.route,
      status: 'failed',
      reason: error.code || 'provider_request_failed',
      evidenceLevel: 'none',
      provider: null,
      contractVersion: null,
      providerVersion: null,
      completedAt: nowISO(),
    };
    saveJob(job);
    throw error;
  }

  const summary = baseSummary(intent, request, result, nowISO);
  if (result.status !== 'acquired') {
    job.materialAcquisitionResult = summary;
    saveJob(job);
    if (result.status === 'fallback')
      appendLog(job, `\n⚠️ Capture provider 未提供 fresh material（${result.reason}）；`
        + '沿用既有素材並標記 illustrative limitation。\n');
    return summary;
  }

  try {
    summary.evidenceFile = safeEvidenceFile(
      acquisitionRoot, requestId, result.acquisitionEvidence || {});
    if (intent.operation === 'screenshot') {
      const artifact = result.material.find((item) => item.role === 'screenshot');
      if (!artifact) fail('Validated screenshot artifact is missing', 'materialization_failed');
      const asset = projectStore.ingestAsset(job.projectId, artifact.absolutePath, {
        originalName: `${intent.route}.png`,
        kind: 'image',
      });
      const inputDirectory = ensureOwnedDirectory(jobDirectory, 'input');
      const inputName = nextShotName(inputDirectory);
      projectStore.materializeAsset(job.projectId, asset.id, path.join(inputDirectory, inputName));
      if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
      summary.artifact = {
        assetRef: asset.id,
        role: artifact.role,
        inputName,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        size: artifact.size,
        media: artifact.media,
      };
    } else if (intent.operation === 'record') {
      summary.artifacts = result.material.map((artifact) => ({
        role: artifact.role,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        size: artifact.size,
        media: artifact.media || null,
      }));
      summary.automaticTimelineUse = false;
    } else {
      stagePreparedPhoneMaterial({ intent, request, result, summary, jobDirectory });
    }
  } catch (error) {
    summary.status = intent.policy === 'require-capture' ? 'failed' : 'fallback';
    summary.reason = 'materialization_failed';
    summary.evidenceLevel = intent.policy === 'require-capture'
      ? 'none' : 'illustrative_not_fresh_capture';
    job.materialAcquisitionResult = summary;
    saveJob(job);
    if (intent.policy === 'require-capture' && error instanceof MaterialAcquisitionError)
      throw error;
    if (intent.policy === 'require-capture')
      fail('Required capture could not be materialized', 'materialization_failed');
    appendLog(job, '\n⚠️ Fresh Capture 驗證成功，但未能安全保存或加入 Project；沿用既有素材。\n');
    return summary;
  }
  job.materialAcquisitionResult = summary;
  saveJob(job);
  appendLog(job, intent.operation === 'screenshot'
    ? `\n📷 Fresh Capture 已驗證並加入 ${summary.artifact.inputName}。\n`
    : intent.operation === 'record'
      ? '\n🎬 Raw recording 已驗證；本輪不自動剪入 timeline。\n'
      : '\n📱 Ready-to-place 手機素材已驗證；等待 timeline placement 編譯。\n');
  return summary;
}

module.exports = {
  buildPreparedPhoneTimelinePlacement,
  compactPreparedPhoneAcquisition,
  commitPreparedPhoneMaterialSelection,
  PREPARED_INTENT_INPUT,
  PREPARED_PLAN,
  PREPARED_VIDEO_INPUT,
  finalizePreparedPhoneMaterial,
  nextShotName,
  prepareJobMaterialAcquisition,
  rollbackPreparedPhoneMaterialSelection,
  validateCompiledPreparedPlan,
  validatePreparedPhonePlacementMath,
  validatePreparedPhoneProjectAsset,
};
