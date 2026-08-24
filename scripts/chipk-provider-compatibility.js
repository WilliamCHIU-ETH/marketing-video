#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('../server/project-store');
const {
  CaptureCliAdapterError,
  PROVIDER_LOCK,
  createChipKCaptureCliAdapter,
  probeChipKCaptureCli,
  validateProviderCapabilities,
} = require('../server/chipk-capture-cli-adapter');
const { normalizeMaterialAcquisitionIntent } = require('../server/material-acquisition');
const {
  PREPARED_INTENT_INPUT,
  PREPARED_PLAN,
  PREPARED_VIDEO_INPUT,
  buildPreparedPhoneTimelinePlacement,
  commitPreparedPhoneMaterialSelection,
  finalizePreparedPhoneMaterial,
  prepareJobMaterialAcquisition,
} = require('../server/material-acquisition-runtime');
const { buildRenderInputManifest } = require('../server/render-input-manifest');
const { run: runPreparedPhonePlanner } = require('./prepared-phone-material-plan');

const APP_ROOT = path.resolve(__dirname, '..');

const PREPARED_ROLES = [
  'prepared-video', 'screenshot', 'capture-manifest',
  'presentation-plan', 'preparation-manifest',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function providerBinFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--provider-bin' || !args[1]) {
    throw new Error('Usage: npm run test:chipk-provider-compat -- --provider-bin <absolute-conformance-cli>');
  }
  const command = args[1];
  if (!path.isAbsolute(command)) throw new Error('--provider-bin must be an absolute path');
  const stat = fs.lstatSync(command);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error('--provider-bin must be an executable regular file');
  }
  if (path.basename(command) !== 'conformance-cli.js'
      || path.basename(path.dirname(command)) !== 'test') {
    throw new Error('--provider-bin must point to the provider-owned test/conformance-cli.js');
  }
  return command;
}

function assertVersionMismatch(capabilities) {
  const mismatchedLock = { ...PROVIDER_LOCK, toolVersion: `${PROVIDER_LOCK.toolVersion}-mismatch` };
  assert.throws(
    () => validateProviderCapabilities(capabilities, mismatchedLock),
    (error) => error instanceof CaptureCliAdapterError
      && error.code === 'provider_version_incompatible',
  );
}

async function runConnectedScreenshot(providerBin, root) {
  let id = 0;
  const dataDir = path.join(root, 'data');
  const projectStore = createProjectStore({
    dataDir,
    nowISO: () => '2026-08-21T00:00:00.000Z',
    idFactory: () => `compat-${++id}`,
  });
  const project = projectStore.create({
    name: 'ChipK provider compatibility', template: 'default', owner: 'compatibility-test',
  });
  const jobDirectory = path.join(dataDir, 'jobs', 'compat-job');
  fs.mkdirSync(path.join(jobDirectory, 'input'), { recursive: true });
  const job = {
    id: 'compat-job',
    projectId: project.id,
    assetRefs: [],
    materialAcquisition: normalizeMaterialAcquisitionIntent({
      policy: 'require-capture',
      operation: 'screenshot',
      mode: 'test',
      route: 'chipk.stock.health-check',
      stock: { id: '2330', name: '台積電' },
    }),
  };
  const summary = await prepareJobMaterialAcquisition({
    job,
    jobDirectory,
    projectStore,
    requestIdFactory: () => 'compat-request-1',
    nowISO: () => '2026-08-21T00:00:01.000Z',
    saveJob: () => {},
    provider: createChipKCaptureCliAdapter({ command: providerBin }),
  });
  const savedProject = projectStore.get(project.id);
  assert.equal(summary.status, 'acquired');
  assert.equal(summary.contractVersion, PROVIDER_LOCK.contractVersion);
  assert.equal(summary.providerVersion, PROVIDER_LOCK.toolVersion);
  assert.equal(savedProject.assets.some((asset) => asset.id === summary.artifact.assetRef), true);
  assert.equal(job.assetRefs.includes(summary.artifact.assetRef), true);
  assert.equal(fs.existsSync(path.join(jobDirectory, 'input', summary.artifact.inputName)), true);
}

function compilePreparedPlan({ root, jobDirectory }) {
  const workspaceRoot = path.join(root, 'workspace-v2');
  const publicDirectory = path.join(workspaceRoot, 'public');
  const sourceDirectory = path.join(workspaceRoot, 'src');
  fs.mkdirSync(path.join(sourceDirectory, 'Focusstock'), { recursive: true });
  fs.mkdirSync(publicDirectory, { recursive: true });
  fs.copyFileSync(path.join(jobDirectory, 'input', PREPARED_VIDEO_INPUT),
    path.join(publicDirectory, PREPARED_VIDEO_INPUT));
  fs.copyFileSync(path.join(jobDirectory, 'input', PREPARED_INTENT_INPUT),
    path.join(publicDirectory, PREPARED_INTENT_INPUT));
  fs.writeFileSync(path.join(sourceDirectory, 'subtitles.json'), '{"_scriptCharTimes":[]}\n');
  fs.writeFileSync(path.join(sourceDirectory, 'video-meta.json'), '{"heygenDurationSec":30}\n');
  fs.writeFileSync(path.join(
    sourceDirectory, 'Focusstock', 'focusstock-shots.generated.json'), '[]\n');
  fs.writeFileSync(path.join(publicDirectory, 'script.txt'), 'Synthetic compatibility script.\n');
  fs.copyFileSync(path.join(jobDirectory, 'input', PREPARED_VIDEO_INPUT),
    path.join(publicDirectory, 'heygen.mp4'));
  fs.writeFileSync(path.join(sourceDirectory, 'graphic-broll.generated.json'), `${JSON.stringify({
    schemaVersion: 1,
    mode: 'disabled',
    style: 'morning-report-v1',
    sourceScriptSha256: crypto.createHash('sha256')
      .update('Synthetic compatibility script.\n').digest('hex'),
    cards: [],
  }, null, 2)}\n`);
  runPreparedPhonePlanner([
    '--mode=ready-to-place',
    `--intent=${path.join(publicDirectory, PREPARED_INTENT_INPUT)}`,
    `--video=${path.join(publicDirectory, PREPARED_VIDEO_INPUT)}`,
    `--script=${path.join(publicDirectory, 'script.txt')}`,
    `--subtitles=${path.join(sourceDirectory, 'subtitles.json')}`,
    `--video-meta=${path.join(sourceDirectory, 'video-meta.json')}`,
    `--out=${path.join(workspaceRoot, ...PREPARED_PLAN.split('/'))}`,
  ]);
  return { workspaceRoot, publicDirectory };
}

async function runConnectedPreparedVideo(providerBin, root) {
  let id = 0;
  const dataDir = path.join(root, 'data-v2');
  const projectStore = createProjectStore({
    dataDir,
    nowISO: () => '2026-08-24T00:00:00.000Z',
    idFactory: () => `compat-v2-${++id}`,
  });
  const project = projectStore.create({
    name: 'ChipK ready-to-place compatibility',
    template: 'focusstock',
    owner: 'compatibility-test',
  });
  const revision = projectStore.addRevision(project.id, {
    jobId: 'compat-v2-job',
    runId: 'compat-v2-job',
    title: 'Synthetic ready-to-place conformance',
  });
  const jobDirectory = path.join(dataDir, 'jobs', 'compat-v2-job');
  fs.mkdirSync(path.join(jobDirectory, 'input'), { recursive: true });
  const job = {
    id: 'compat-v2-job',
    projectId: project.id,
    revisionId: revision.id,
    template: 'focusstock',
    status: 'preparing',
    assetRefs: [],
    timelinePlacements: [],
    materialAcquisition: normalizeMaterialAcquisitionIntent({
      policy: 'require-capture',
      operation: 'prepared-video',
      mode: 'test',
      route: 'chipk.stock.main-force',
      stock: { id: '3441', name: '聯一光' },
      presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
      placement: { layoutId: 'focusstock-phone-portrait.v1', startSec: 2 },
    }),
  };
  const saveJob = () => projectStore.updateRevision(project.id, revision.id, {
    status: job.status,
    assetRefs: [...job.assetRefs],
    materialAcquisition: job.materialAcquisition,
    materialAcquisitionResult: job.materialAcquisitionResult,
    timelinePlacements: [...job.timelinePlacements],
    renderInputManifest: job.renderInputManifest || null,
    renderInputManifestSha256: job.renderInputManifestSha256 || null,
  });
  const summary = await prepareJobMaterialAcquisition({
    job,
    jobDirectory,
    projectStore,
    requestIdFactory: () => 'compat-v2-request-1',
    nowISO: () => '2026-08-24T00:00:01.000Z',
    saveJob,
    provider: createChipKCaptureCliAdapter({ command: providerBin }),
  });

  assert.equal(summary.status, 'acquired');
  assert.equal(summary.reason, null);
  assert.equal(summary.evidenceLevel, 'fresh_capture');
  assert.equal(summary.contractVersion, PROVIDER_LOCK.readyToPlaceContractVersion);
  assert.equal(summary.providerVersion, PROVIDER_LOCK.toolVersion);
  assert.deepEqual(summary.artifacts.map(({ role }) => role), PREPARED_ROLES);
  assert.equal(summary.artifacts.some(({ role }) => role === 'raw-video'), false);
  assert.equal(summary.artifacts.every((artifact) => {
    const file = path.join(jobDirectory, artifact.evidenceFile);
    return fs.existsSync(file) && sha256(file) === artifact.sha256;
  }), true);
  const preparedEvidence = summary.artifacts.find(({ role }) => role === 'prepared-video');
  assert.equal(preparedEvidence.media.codec, 'h264');
  assert.equal(preparedEvidence.mimeType, 'video/mp4');
  assert.equal(summary.placementStatus, 'pending_compile');
  assert.equal(summary.automaticTimelineUse, false);
  assert.equal(projectStore.get(project.id).assets.length, 0);
  assert.deepEqual(job.assetRefs, []);
  const stagedVideo = path.join(jobDirectory, 'input', PREPARED_VIDEO_INPUT);
  assert.equal(sha256(stagedVideo), summary.preparedArtifact.sha256);

  const compiled = compilePreparedPlan({ root, jobDirectory });
  const selected = finalizePreparedPhoneMaterial({
    job,
    jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore,
    saveJob,
  });
  assert.equal(summary.placementStatus, 'compiled_pending_evidence');
  assert.equal(summary.automaticTimelineUse, false);
  assert.equal(summary.preparedArtifact.assetRef, undefined);
  assert.deepEqual(job.assetRefs, []);
  const pendingPlacement = buildPreparedPhoneTimelinePlacement(
    job, selected.plan, selected.asset.id);
  const stateRoot = path.join(root, 'state-v2');
  fs.cpSync(compiled.workspaceRoot, stateRoot, { recursive: true });
  const renderInput = buildRenderInputManifest({
    artifactRoot: stateRoot,
    rendererRoot: APP_ROOT,
    template: 'focusstock',
    compositionId: 'Focusstock',
    workflowMode: 'manual-assets',
    graphicBrollMode: 'disabled',
    preparedPhoneMode: 'ready-to-place',
  });
  assert.match(renderInput.sha256, /^[a-f0-9]{64}$/);
  const timelinePlacement = commitPreparedPhoneMaterialSelection({
    job, asset: selected.asset, plan: selected.plan, projectStore,
  });
  assert.deepEqual(timelinePlacement, pendingPlacement);
  job.timelinePlacements = [timelinePlacement];
  job.renderInputManifest = renderInput.manifest;
  job.renderInputManifestSha256 = renderInput.sha256;
  job.status = 'prepared';
  saveJob();

  assert.equal(summary.placementStatus, 'compiled');
  assert.equal(summary.automaticTimelineUse, true);
  assert.equal(selected.plan.placement.startSec, 2);
  assert.equal(selected.plan.placement.playbackRate, 1);
  assert.equal(selected.plan.placement.muted, true);
  assert.equal(selected.plan.placement.objectFit, 'contain');
  assert.equal(selected.plan.placement.crop, 'none');
  assert.equal(selected.plan.placement.trim, 'none');
  assert.equal(selected.plan.placement.loop, false);
  assert.equal(selected.asset.role, 'prepared-phone-video');
  assert.equal(selected.asset.origin, 'chipk-simulator-capture');
  assert.deepEqual(job.assetRefs, [selected.asset.id]);
  assert.equal(timelinePlacement.assetRef, selected.asset.id);
  assert.equal(timelinePlacement.planSha256, summary.compiledPlanSha256);
  const savedRevision = projectStore.getRevision(project.id, revision.id);
  assert.deepEqual(savedRevision.assetRefs, [selected.asset.id]);
  assert.equal(savedRevision.materialAcquisitionResult.placementStatus, 'compiled');
  assert.equal(savedRevision.materialAcquisitionResult.automaticTimelineUse, true);
  assert.deepEqual(savedRevision.timelinePlacements, [timelinePlacement]);
  assert.equal(savedRevision.renderInputManifestSha256, renderInput.sha256);
}

async function main() {
  const providerBin = providerBinFromArgs(process.argv.slice(2));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-provider-compat-'));
  try {
    const capabilities = await probeChipKCaptureCli({ command: providerBin });
    assertVersionMismatch(capabilities);
    await runConnectedScreenshot(providerBin, root);
    await runConnectedPreparedVideo(providerBin, root);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: {
        id: PROVIDER_LOCK.providerId,
        contractVersion: PROVIDER_LOCK.contractVersion,
        readyToPlaceContractVersion: PROVIDER_LOCK.readyToPlaceContractVersion,
        toolVersion: PROVIDER_LOCK.toolVersion,
      },
      checks: {
        realCliJsonBoundary: true,
        exactVersionMismatchRejected: true,
        screenshotResultValidated: true,
        projectAssetIngested: true,
        v2PreparedResultValidated: true,
        placementCompiled: true,
        preparedProjectAssetSelected: true,
        timelineReadyEvidencePersisted: true,
        rawFallbackAbsent: true,
      },
      runtime: 'synthetic-conformance',
      simulatorUsed: false,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'compatibility_check_failed',
      message: error?.message || 'Compatibility check failed',
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});
