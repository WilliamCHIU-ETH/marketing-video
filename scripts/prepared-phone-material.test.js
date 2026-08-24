'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { createProjectStore, isGenericReusableAsset } = require('../server/project-store');
const {
  acquireOptionalMaterial,
  buildCaptureRequest,
  normalizeMaterialAcquisitionIntent,
  resolvePreparedVideoPlacement,
  validateCaptureResult,
} = require('../server/material-acquisition');
const {
  PREPARED_INTENT_INPUT,
  PREPARED_PLAN,
  PREPARED_VIDEO_INPUT,
  buildPreparedPhoneTimelinePlacement,
  compactPreparedPhoneAcquisition,
  commitPreparedPhoneMaterialSelection,
  finalizePreparedPhoneMaterial,
  prepareJobMaterialAcquisition,
  rollbackPreparedPhoneMaterialSelection,
  validatePreparedPhoneProjectAsset,
} = require('../server/material-acquisition-runtime');
const {
  PreparedPhonePlanError,
  compilePreparedPhonePlan,
  disabledPlan,
  inspectPreparedVideo,
  run: runPreparedPlanner,
} = require('./prepared-phone-material-plan');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');
const MP4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAs1tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNpZD0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAEGWIhAAV//73ye/ApurcNY==',
  'base64');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

const CAPABILITIES = {
  schemaVersion: 1,
  providerId: 'chipk-simulator-capture',
  toolVersion: '0.3.0',
  productionReady: true,
  operations: ['screenshot', 'record'],
  contractCapabilities: [
    {
      contractVersion: 1, operations: ['screenshot', 'record'],
      requestSchema: 'contracts/capture-request.schema.json',
      resultSchema: 'contracts/capture-result.schema.json',
    },
    {
      contractVersion: 2, operations: ['prepared-video'],
      requestSchema: 'contracts/capture-request-v2.schema.json',
      resultSchema: 'contracts/capture-result-v2.schema.json',
      presentationProfiles: [{
        id: 'chipk.stock-main-force-portrait.v1', version: 1,
        status: 'ready_to_place', sourceKind: 'screenshot',
        routeIds: ['chipk.stock.main-force'], stockIds: ['3441'],
        artifactRole: 'prepared-video',
      }],
    },
  ],
};

function preparedIntent(placement = { layoutId: 'focusstock-phone-portrait.v1', startSec: 2 }) {
  return normalizeMaterialAcquisitionIntent({
    policy: 'require-capture',
    operation: 'prepared-video',
    mode: 'test',
    route: 'chipk.stock.main-force',
    stock: { id: '3441', name: '聯一光' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
    placement,
  });
}

function writeBundle(request) {
  const preparedFile = path.join(request.outputDirectory, 'prepared.mp4');
  if (!fs.existsSync(preparedFile)) {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=16x16:r=30:d=1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', preparedFile,
    ], { stdio: 'ignore', timeout: 15000 });
  }
  const preparedBytes = fs.readFileSync(preparedFile);
  const media = inspectPreparedVideo(preparedFile);
  const files = {
    'prepared-video': { name: 'prepared.mp4', bytes: preparedBytes, kind: 'video', mimeType: 'video/mp4', media },
    screenshot: { name: 'screenshot.png', bytes: PNG, kind: 'image', mimeType: 'image/png', media: { width: 1, height: 1 } },
    'capture-manifest': { name: 'capture-manifest.json', bytes: Buffer.from('{"capture":true}'), kind: 'json', mimeType: 'application/json' },
    'presentation-plan': { name: 'presentation-plan.json', bytes: Buffer.from('{"profile":"ready"}'), kind: 'json', mimeType: 'application/json' },
    'preparation-manifest': { name: 'preparation-manifest.json', bytes: Buffer.from('{"prepared":true}'), kind: 'json', mimeType: 'application/json' },
  };
  for (const value of Object.values(files)) {
    const file = path.join(request.outputDirectory, value.name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, value.bytes);
  }
  return {
    contractVersion: 2,
    requestId: request.requestId,
    provider: { id: 'chipk-simulator-capture', toolVersion: '0.3.0' },
    status: 'completed',
    artifacts: Object.entries(files).map(([role, value]) => ({
      role,
      kind: value.kind,
      relativePath: value.name,
      sha256: hash(value.bytes),
      mimeType: value.mimeType,
      ...(value.media ? { media: value.media } : {}),
    })),
    evidence: {
      routeSelection: 'catalog_exact_match',
      navigation: 'expected_texts_verified',
      material: 'ready_to_place',
      catalogVersion: 'synthetic-ready-to-place-v2',
      presentationProfile: {
        id: 'chipk.stock-main-force-portrait.v1', version: 1, status: 'ready_to_place',
      },
      publication: 'atomic_directory_rename',
    },
    error: null,
  };
}

function writeOnce(file, bytes) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return file;
}

function fixture(t, placement) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-phone-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'provider-output');
  fs.mkdirSync(outputDirectory);
  const intent = preparedIntent(placement);
  const request = buildCaptureRequest(intent, { requestId: 'prepared-request-1', outputDirectory });
  const result = writeBundle(request);
  const provider = {
    capabilities: async () => CAPABILITIES,
    acquire: async () => result,
  };
  return { root, outputDirectory, intent, request, result, provider };
}

test('v2 request is explicit ready-to-place and never accepts prefer/raw fallback semantics', async (t) => {
  const fx = fixture(t);
  assert.equal(fx.request.contractVersion, 2);
  assert.equal(fx.request.operation, 'prepared-video');
  assert.deepEqual(fx.request.presentation, { profileId: 'chipk.stock-main-force-portrait.v1' });
  assert.throws(() => normalizeMaterialAcquisitionIntent({
    policy: 'prefer-capture', operation: 'prepared-video', mode: 'test',
    route: 'chipk.stock.main-force', stock: { id: '3441', name: '聯一光' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
    placement: { layoutId: 'focusstock-phone-portrait.v1', startSec: 2 },
  }), (error) => error.code === 'invalid_material_intent');
  let acquireCalls = 0;
  await assert.rejects(() => acquireOptionalMaterial({
    policy: 'require-capture', request: fx.request,
    provider: {
      capabilities: async () => ({ ...CAPABILITIES, contractCapabilities: [] }),
      acquire: async () => { acquireCalls += 1; return fx.result; },
    },
  }), (error) => error.code === 'provider_operation_unsupported');
  await assert.rejects(() => acquireOptionalMaterial({
    policy: 'require-capture', request: fx.request,
    provider: {
      capabilities: async () => ({
        ...CAPABILITIES,
        contractCapabilities: CAPABILITIES.contractCapabilities.map((entry) =>
          entry.contractVersion === 2
            ? {
                ...entry,
                presentationProfiles: entry.presentationProfiles.map((profile) => ({
                  ...profile, stockIds: ['9999'],
                })),
              }
            : entry),
      }),
      acquire: async () => { acquireCalls += 1; return fx.result; },
    },
  }), (error) => error.code === 'provider_operation_unsupported');
  await assert.rejects(() => acquireOptionalMaterial({
    policy: 'require-capture', request: fx.request,
    provider: {
      capabilities: async () => ({
        ...CAPABILITIES,
        contractCapabilities: CAPABILITIES.contractCapabilities.map((entry) =>
          entry.contractVersion === 2
            ? { ...entry, presentationProfiles: [
                ...entry.presentationProfiles, ...entry.presentationProfiles,
              ] }
            : entry),
      }),
      acquire: async () => { acquireCalls += 1; return fx.result; },
    },
  }), (error) => error.code === 'provider_operation_unsupported');
  assert.equal(acquireCalls, 0);
});

test('phrase anchor resolves once against the same cleaned script used by subtitles', () => {
  const intent = preparedIntent({
    layoutId: 'focusstock-phone-portrait.v1', anchor: { phrase: '聯一光的主力動向' },
  });
  const resolved = resolvePreparedVideoPlacement(intent,
    '\n===\n===\n標題\n===\n今天看聯一光的主力動向，接著說明籌碼。\n');
  assert.equal(resolved.placement.anchor.phrase, '聯一光的主力動向');
  assert.equal(resolved.placement.anchor.startCharIdx, 3);
  assert.throws(() => resolvePreparedVideoPlacement(intent,
    '\n===\n===\n標題\n===\n聯一光的主力動向，聯一光的主力動向。\n'),
  (error) => error.code === 'invalid_material_intent' && /ambiguous/.test(error.message));
  assert.throws(() => resolvePreparedVideoPlacement(intent,
    '\n===\n===\n標題\n===\n這段沒有指定文字。\n'),
  (error) => error.code === 'invalid_material_intent' && /not found/.test(error.message));
});

test('v2 validates the exact five-role bundle and rejects raw-video substitution', (t) => {
  const fx = fixture(t);
  const validated = validateCaptureResult(fx.result, fx.request);
  assert.deepEqual(validated.artifacts.map((item) => item.role).sort(), [
    'capture-manifest', 'preparation-manifest', 'prepared-video',
    'presentation-plan', 'screenshot',
  ]);
  const drifted = {
    ...fx.result,
    artifacts: fx.result.artifacts.map((item) => item.role === 'prepared-video'
      ? { ...item, role: 'raw-video' } : item),
  };
  assert.throws(() => validateCaptureResult(drifted, fx.request),
    (error) => error.code === 'provider_artifact_invalid');
  assert.throws(() => validateCaptureResult({
    ...fx.result, evidence: { ...fx.result.evidence, synthetic: true },
  }, fx.request), (error) => error.code === 'provider_evidence_invalid');
});

function runtimeContext(t) {
  const fx = fixture(t);
  const dataDir = path.join(fx.root, 'data');
  const projectStore = createProjectStore({
    dataDir,
    nowISO: () => '2026-08-24T00:00:00.000Z',
    idFactory: () => 'prepared-project',
  });
  const project = projectStore.create({
    name: 'Prepared phone', template: 'focusstock', owner: 'test',
  });
  const jobDirectory = path.join(dataDir, 'jobs', 'job-ready');
  fs.mkdirSync(path.join(jobDirectory, 'input'), { recursive: true });
  const job = {
    id: 'job-ready', projectId: project.id, template: 'focusstock', assetRefs: [],
    materialAcquisition: fx.intent,
  };
  const saves = [];
  const options = {
    job, jobDirectory, projectStore,
    requestIdFactory: () => 'prepared-request-runtime',
    nowISO: () => '2026-08-24T00:00:01.000Z',
    saveJob: (value) => saves.push(JSON.parse(JSON.stringify(value))),
    provider: {
      capabilities: async () => CAPABILITIES,
      acquire: async (request) => writeBundle(request),
    },
  };
  return { ...fx, dataDir, projectStore, project, jobDirectory, job, saves, options };
}

function compileRuntimePlan(ctx) {
  const workspaceRoot = path.join(ctx.root, 'workspace');
  const publicDirectory = path.join(workspaceRoot, 'public');
  const srcDirectory = path.join(workspaceRoot, 'src');
  fs.mkdirSync(path.join(srcDirectory, 'Focusstock'), { recursive: true });
  fs.mkdirSync(publicDirectory, { recursive: true });
  fs.copyFileSync(path.join(ctx.jobDirectory, 'input', PREPARED_VIDEO_INPUT),
    path.join(publicDirectory, PREPARED_VIDEO_INPUT));
  fs.copyFileSync(path.join(ctx.jobDirectory, 'input', PREPARED_INTENT_INPUT),
    path.join(publicDirectory, PREPARED_INTENT_INPUT));
  fs.writeFileSync(path.join(srcDirectory, 'subtitles.json'), '{"_scriptCharTimes":[]}');
  fs.writeFileSync(path.join(srcDirectory, 'video-meta.json'), '{"heygenDurationSec":10}');
  fs.writeFileSync(path.join(srcDirectory, 'Focusstock', 'focusstock-shots.generated.json'), '[]\n');
  runPreparedPlanner([
    '--mode=ready-to-place',
    `--intent=${path.join(publicDirectory, PREPARED_INTENT_INPUT)}`,
    `--video=${path.join(publicDirectory, PREPARED_VIDEO_INPUT)}`,
    `--subtitles=${path.join(srcDirectory, 'subtitles.json')}`,
    `--video-meta=${path.join(srcDirectory, 'video-meta.json')}`,
    `--out=${path.join(workspaceRoot, ...PREPARED_PLAN.split('/'))}`,
  ]);
  return { workspaceRoot, publicDirectory };
}

test('Project Asset and Revision selection happen only after placement compiles', async (t) => {
  const ctx = runtimeContext(t);
  const summary = await prepareJobMaterialAcquisition(ctx.options);
  assert.equal(summary.status, 'acquired');
  assert.equal(summary.placementStatus, 'pending_compile');
  assert.equal(summary.automaticTimelineUse, false);
  assert.equal(ctx.projectStore.get(ctx.project.id).assets.length, 0);
  assert.deepEqual(ctx.job.assetRefs, []);
  assert.equal(hash(fs.readFileSync(path.join(ctx.jobDirectory, 'input', PREPARED_VIDEO_INPUT))),
    summary.preparedArtifact.sha256);
  assert.equal(summary.artifacts.length, 5);
  assert.equal(summary.artifacts.every((item) => item.evidenceFile.startsWith('acquisition/')), true);

  const compiled = compileRuntimePlan(ctx);
  const persistedBeforeFinalize = ctx.saves.length;
  const selected = finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
    saveJob: ctx.options.saveJob,
  });
  assert.equal(selected.plan.placement.startSec, 2);
  assert.equal(ctx.job.materialAcquisitionResult.placementStatus, 'compiled_pending_evidence');
  assert.equal(ctx.job.materialAcquisitionResult.automaticTimelineUse, false);
  assert.equal(ctx.job.materialAcquisitionResult.preparedArtifact.assetRef, undefined);
  assert.deepEqual(ctx.job.assetRefs, []);
  assert.equal(ctx.saves.length, persistedBeforeFinalize);
  const asset = ctx.projectStore.get(ctx.project.id).assets[0];
  assert.equal(asset.kind, 'video');
  assert.equal(asset.role, 'prepared-phone-video');
  assert.equal(asset.origin, 'chipk-simulator-capture');
  assert.equal(isGenericReusableAsset(asset), false);
  assert.equal(hash(fs.readFileSync(ctx.projectStore.assetPath(ctx.project.id, asset.id))),
    summary.preparedArtifact.sha256);
  const pendingPlacement = buildPreparedPhoneTimelinePlacement(ctx.job, selected.plan, asset.id);
  assert.equal(pendingPlacement.assetRef, asset.id);
  assert.deepEqual(ctx.job.assetRefs, []);
  const timelinePlacement = commitPreparedPhoneMaterialSelection({
    job: ctx.job, asset, plan: selected.plan, projectStore: ctx.projectStore,
  });
  assert.equal(ctx.job.materialAcquisitionResult.placementStatus, 'compiled');
  assert.equal(ctx.job.materialAcquisitionResult.automaticTimelineUse, true);
  assert.equal(ctx.job.materialAcquisitionResult.preparedArtifact.assetRef, asset.id);
  assert.deepEqual(ctx.job.assetRefs, [asset.id]);
  assert.equal(timelinePlacement.assetRef, asset.id);
  assert.equal(timelinePlacement.planSha256, summary.compiledPlanSha256);
  assert.equal(timelinePlacement.visualOwner, 'prepared-phone-video');
  assert.equal(timelinePlacement.conflictPolicy, 'suppress-entire-overlapping-placement');
  assert.equal(timelinePlacement.fps, 30);
  assert.equal(timelinePlacement.timelineBasis, 'focusstock-main-v1');
  assert.equal(timelinePlacement.startFrame, selected.plan.placement.startFrame);
  assert.equal(timelinePlacement.endFrame, selected.plan.placement.endFrame);
  assert.equal(timelinePlacement.durationInFrames,
    Math.ceil(selected.plan.source.media.durationSeconds * 30));
  assert.equal(timelinePlacement.compositionTimeline, 'Focusstock');
  assert.equal(timelinePlacement.compositionOffsetFrames, 30);
  assert.equal(timelinePlacement.compositionStartFrame, timelinePlacement.startFrame + 30);
  assert.equal(timelinePlacement.compositionEndFrame, timelinePlacement.endFrame + 30);
  assert.equal(timelinePlacement.compositionStartSec, timelinePlacement.startSec + 1);
  assert.equal(timelinePlacement.compositionEndSec, timelinePlacement.endSec + 1);
  ctx.job.timelinePlacements = [timelinePlacement];
  assert.equal(validatePreparedPhoneProjectAsset({
    job: ctx.job, projectStore: ctx.projectStore,
  }).asset.id, asset.id);
  fs.appendFileSync(ctx.projectStore.assetPath(ctx.project.id, asset.id), Buffer.from('drift'));
  assert.throws(() => validatePreparedPhoneProjectAsset({
    job: ctx.job, projectStore: ctx.projectStore,
  }), (error) => error.code === 'placement_compile_failed');

  rollbackPreparedPhoneMaterialSelection(ctx.job);
  assert.equal(ctx.job.materialAcquisitionResult.placementStatus, 'compiled_pending_evidence');
  assert.equal(ctx.job.materialAcquisitionResult.automaticTimelineUse, false);
  assert.equal(ctx.job.materialAcquisitionResult.preparedArtifact.assetRef, undefined);
  assert.deepEqual(ctx.job.assetRefs, []);
});

test('generic Focusstock shots conflict with ready-to-place instead of rendering both', async (t) => {
  const ctx = runtimeContext(t);
  await prepareJobMaterialAcquisition(ctx.options);
  const compiled = compileRuntimePlan(ctx);
  fs.writeFileSync(path.join(
    compiled.workspaceRoot, 'src', 'Focusstock', 'focusstock-shots.generated.json'),
  '[{"src":"shot1.png","startCharIdx":0,"endCharIdx":1}]\n');
  assert.throws(() => finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
  }), (error) => error.code === 'placement_compile_failed' && /conflicts/.test(error.message));
  assert.equal(ctx.projectStore.get(ctx.project.id).assets.length, 0);
});

test('one-frame placement cannot claim trim none for a longer prepared clip', async (t) => {
  const ctx = runtimeContext(t);
  await prepareJobMaterialAcquisition(ctx.options);
  const compiled = compileRuntimePlan(ctx);
  const planFile = path.join(compiled.workspaceRoot, ...PREPARED_PLAN.split('/'));
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.placement.durationInFrames = 1;
  plan.placement.endFrame = plan.placement.startFrame + 1;
  plan.placement.endSec = Number((plan.placement.endFrame / 30).toFixed(6));
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  assert.throws(() => finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
    saveJob: ctx.options.saveJob,
  }), (error) => error.code === 'placement_compile_failed');
  assert.equal(ctx.projectStore.get(ctx.project.id).assets.length, 0);
  assert.deepEqual(ctx.job.assetRefs, []);
});

test('verified completed Run compacts binary acquisition duplicates but preserves JSON sidecars', async (t) => {
  const ctx = runtimeContext(t);
  const summary = await prepareJobMaterialAcquisition(ctx.options);
  const compiled = compileRuntimePlan(ctx);
  const selected = finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
  });
  const placement = commitPreparedPhoneMaterialSelection({
    job: ctx.job, asset: selected.asset, plan: selected.plan, projectStore: ctx.projectStore,
  });
  ctx.job.timelinePlacements = [placement];
  ctx.job.status = 'done';
  ctx.job.renderInputManifestSha256 = 'a'.repeat(64);
  ctx.job.renderEvidence = {
    schemaVersion: 1,
    renderInputManifestSha256: ctx.job.renderInputManifestSha256,
  };
  const filesByRole = new Map(summary.artifacts.map((artifact) => [
    artifact.role, path.join(ctx.jobDirectory, artifact.evidenceFile),
  ]));
  const compacted = compactPreparedPhoneAcquisition({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    projectStore: ctx.projectStore,
    saveJob: ctx.options.saveJob,
    nowISO: () => '2026-08-24T00:00:02.000Z',
  });
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.bytesFreed > 0);
  assert.equal(fs.existsSync(filesByRole.get('prepared-video')), false);
  assert.equal(fs.existsSync(filesByRole.get('screenshot')), false);
  for (const role of ['capture-manifest', 'presentation-plan', 'preparation-manifest'])
    assert.equal(fs.existsSync(filesByRole.get(role)), true);
  assert.equal(fs.existsSync(path.join(ctx.jobDirectory, summary.evidenceFile)), true);
  assert.equal(summary.acquisitionRetention.status, 'sidecars_only');
  assert.deepEqual(summary.acquisitionRetention.removedRoles, ['prepared-video', 'screenshot']);
  assert.equal(summary.artifacts.find(({ role }) => role === 'prepared-video').evidenceFile, undefined);
  assert.equal(hash(fs.readFileSync(ctx.projectStore.assetPath(ctx.project.id, selected.asset.id))),
    summary.preparedArtifact.sha256);
});

test('hash drift after compile fails closed before Project Asset ingest', async (t) => {
  const ctx = runtimeContext(t);
  await prepareJobMaterialAcquisition(ctx.options);
  const compiled = compileRuntimePlan(ctx);
  fs.appendFileSync(path.join(compiled.publicDirectory, PREPARED_VIDEO_INPUT), Buffer.from('drift'));
  assert.throws(() => finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
    saveJob: ctx.options.saveJob,
  }), (error) => error.code === 'placement_compile_failed');
  assert.equal(ctx.projectStore.get(ctx.project.id).assets.length, 0);
  assert.deepEqual(ctx.job.assetRefs, []);
});

test('planner resolves char anchor and rejects any placement that would trim the clip', (t) => {
  const fx = fixture(t, {
    layoutId: 'focusstock-phone-portrait.v1', anchor: { startCharIdx: 1 },
  });
  const inspectedMedia = inspectPreparedVideo(path.join(fx.outputDirectory, 'prepared.mp4'));
  const preparedBytes = fs.readFileSync(path.join(fx.outputDirectory, 'prepared.mp4'));
  const input = {
    schemaVersion: 1, mode: 'ready-to-place', template: 'focusstock',
    timelineBasis: 'focusstock-main-v1', contractVersion: 2, requestId: fx.request.requestId,
    provider: fx.result.provider, target: fx.request.target,
    presentation: fx.intent.presentation, placement: fx.intent.placement,
    source: {
      fileName: PREPARED_VIDEO_INPUT, artifactRole: 'prepared-video',
      sha256: hash(preparedBytes), size: preparedBytes.length,
      mimeType: 'video/mp4', media: inspectedMedia,
    },
  };
  const videoPath = path.join(fx.outputDirectory, 'prepared.mp4');
  const plan = compilePreparedPhonePlan({
    intent: input,
    videoPath,
    subtitles: { _scriptCharTimes: [{ start: 0, end: 0.2 }, { start: 3, end: 3.2 }] },
    videoMeta: { heygenDurationSec: 10 },
    inspectedMedia,
  });
  assert.equal(plan.placement.startSec, 3);
  assert.equal(plan.placement.durationInFrames,
    Math.ceil(inspectedMedia.durationSeconds * 30));
  assert.equal(plan.placement.endFrame - plan.placement.startFrame,
    plan.placement.durationInFrames);
  assert.equal(plan.placement.playbackRate, 1);
  assert.equal(plan.placement.trim, 'none');
  assert.deepEqual(plan.visualOwnership, {
    owner: 'prepared-phone-video',
    conflictPolicy: 'suppress-entire-overlapping-placement',
    suppressedChannels: ['focusstock-shots', 'focusstock-broll'],
  });
  assert.throws(() => compilePreparedPhonePlan({
    intent: { ...input, placement: { ...input.placement, anchor: undefined, startSec: 9.5 } },
    videoPath, subtitles: {}, videoMeta: { heygenDurationSec: 10 }, inspectedMedia,
  }), (error) => error instanceof PreparedPhonePlanError && error.code === 'placement_out_of_bounds');
  assert.equal(disabledPlan().mode, 'disabled');
  assert.equal(disabledPlan().visualOwnership, null);
});
