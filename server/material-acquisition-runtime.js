'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createChipKCaptureCliAdapter } = require('./chipk-capture-cli-adapter');
const {
  MaterialAcquisitionError,
  acquireOptionalMaterial,
  buildCaptureRequest,
} = require('./material-acquisition');

function fail(message, code) {
  throw new MaterialAcquisitionError(message, code);
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
  };
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
    } else if (intent.operation === 'prepared-video') {
      const artifact = result.material.find((item) => item.role === 'prepared-video');
      if (!artifact) fail('Validated prepared-video artifact is missing', 'materialization_failed');
      const asset = projectStore.ingestAsset(job.projectId, artifact.absolutePath, {
        originalName: `${intent.route}-${intent.presentation.profileId}.mp4`,
        kind: 'video',
      });
      if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
      summary.artifact = {
        assetRef: asset.id,
        role: artifact.role,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        size: artifact.size,
        media: artifact.media,
      };
      summary.artifacts = result.material.map((item) => ({
        role: item.role,
        sha256: item.sha256,
        mimeType: item.mimeType,
        size: item.size,
        media: item.media || null,
      }));
      summary.presentation = { ...intent.presentation };
      summary.automaticTimelineUse = false;
    } else {
      summary.artifacts = result.material.map((artifact) => ({
        role: artifact.role,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        size: artifact.size,
        media: artifact.media || null,
      }));
      summary.automaticTimelineUse = false;
    }
  } catch (error) {
    summary.status = intent.policy === 'require-capture' ? 'failed' : 'fallback';
    summary.reason = 'materialization_failed';
    summary.evidenceLevel = intent.policy === 'require-capture'
      ? 'none' : 'illustrative_not_fresh_capture';
    job.materialAcquisitionResult = summary;
    saveJob(job);
    if (intent.policy === 'require-capture')
      fail('Required capture could not be materialized', 'materialization_failed');
    appendLog(job, '\n⚠️ Fresh Capture 驗證成功，但未能安全保存或加入 Project；沿用既有素材。\n');
    return summary;
  }
  job.materialAcquisitionResult = summary;
  saveJob(job);
  appendLog(job, intent.operation === 'screenshot'
    ? `\n📷 Fresh Capture 已驗證並加入 ${summary.artifact.inputName}。\n`
    : intent.operation === 'prepared-video'
      ? '\n🎬 Ready-to-place 影片已驗證並加入 Project；尚未配置 timeline 或證明 render 使用。\n'
      : '\n🎬 Raw recording 已驗證；本輪不自動剪入 timeline。\n');
  return summary;
}

module.exports = { nextShotName, prepareJobMaterialAcquisition };
