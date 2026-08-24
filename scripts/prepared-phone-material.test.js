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
  buildFocusstockVisualConflictEvidence,
  buildFocusstockVisualTimelinePlacements,
  buildPreparedPhoneTimelinePlacement,
  compactPreparedPhoneAcquisition,
  commitPreparedPhoneMaterialSelection,
  finalizePreparedPhoneMaterial,
  focusstockVisualFrameInterval,
  mergePreparedPhoneTimelineChannels,
  prepareJobMaterialAcquisition,
  rollbackPreparedPhoneMaterialSelection,
  selectPreparedPhoneGraphicBroll,
  validateFocusstockVisualTimelinePlacements,
  validatePreparedFocusstockAssetRefs,
  validatePreparedPhoneProjectAsset,
} = require('../server/material-acquisition-runtime');
const { halfOpenFrameIntervalsOverlap } = require(
  '../src/Focusstock/focusstock-half-open');
const {
  PreparedPhonePlanError,
  compilePreparedPhonePlan,
  disabledPlan,
  inspectPreparedVideo,
  resolvePlacementStart,
  run: runPreparedPlanner,
} = require('./prepared-phone-material-plan');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');
const ALT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
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

test('canonical phrase resolver maps the phrase start through subtitle time to renderer frame', () => {
  const scriptRaw = '\n===\n===\n標題\n===\n前言開啟籌碼K線，接著說明。\n';
  const intent = preparedIntent({
    layoutId: 'focusstock-phone-portrait.v1', anchor: { phrase: '開啟籌碼K線' },
  });
  const resolvedIntent = resolvePreparedVideoPlacement(intent, scriptRaw);
  assert.equal(resolvedIntent.placement.anchor.startCharIdx, 2,
    'anchor 必須指向完整 phrase 的第一個字');

  const charTimes = Array.from({ length: 12 }, (_, index) => ({
    start: Number((1 + index * 0.04).toFixed(2)),
    end: Number((1.03 + index * 0.04).toFixed(2)),
  }));
  const resolvedStart = resolvePlacementStart(
    resolvedIntent.placement, { _scriptCharTimes: charTimes }, scriptRaw);
  assert.deepEqual(resolvedStart, {
    fps: 30,
    requestedStartSec: 1.08,
    startFrame: 32,
    startSec: 1.066667,
    anchor: { phrase: '開啟籌碼K線', startCharIdx: 2 },
  });
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
  fs.writeFileSync(path.join(publicDirectory, 'script.txt'), 'Synthetic prepared script.\n');
  fs.writeFileSync(path.join(srcDirectory, 'subtitles.json'), '{"_scriptCharTimes":[]}');
  fs.writeFileSync(path.join(srcDirectory, 'video-meta.json'), '{"heygenDurationSec":10}');
  fs.writeFileSync(path.join(srcDirectory, 'Focusstock', 'focusstock-shots.generated.json'), '[]\n');
  runPreparedPlanner([
    '--mode=ready-to-place',
    `--intent=${path.join(publicDirectory, PREPARED_INTENT_INPUT)}`,
    `--video=${path.join(publicDirectory, PREPARED_VIDEO_INPUT)}`,
    `--script=${path.join(publicDirectory, 'script.txt')}`,
    `--subtitles=${path.join(srcDirectory, 'subtitles.json')}`,
    `--video-meta=${path.join(srcDirectory, 'video-meta.json')}`,
    `--out=${path.join(workspaceRoot, ...PREPARED_PLAN.split('/'))}`,
  ]);
  return { workspaceRoot, publicDirectory };
}

function bindReusableFocusstockImage(ctx, compiled, inputName = 'shot1.png') {
  const source = path.join(ctx.root, `${inputName}.source.png`);
  fs.writeFileSync(source, PNG);
  const asset = ctx.projectStore.ingestAsset(ctx.project.id, source, {
    originalName: inputName,
    kind: 'image',
  });
  ctx.projectStore.materializeAsset(ctx.project.id, asset.id,
    path.join(ctx.jobDirectory, 'input', inputName));
  fs.copyFileSync(path.join(ctx.jobDirectory, 'input', inputName),
    path.join(compiled.publicDirectory, inputName));
  ctx.job.assetRefs.push(asset.id);
  ctx.job.focusstockVisualInputs = [{
    kind: 'image',
    assetRef: asset.id,
    inputName,
    sha256: asset.sha256,
    size: asset.size,
    mediaType: asset.mediaType,
  }];
  return asset;
}

function bindSpeakerVideo(ctx, compiled) {
  const source = path.join(ctx.jobDirectory, 'input', PREPARED_VIDEO_INPUT);
  const asset = ctx.projectStore.ingestAsset(ctx.project.id, source, {
    originalName: 'heygen.mp4',
    kind: 'speaker-video',
  });
  ctx.projectStore.materializeAsset(ctx.project.id, asset.id,
    path.join(compiled.publicDirectory, 'heygen.mp4'));
  ctx.job.assetRefs.push(asset.id);
  return asset;
}

function writeFocusstockShotEvidence(compiled, shots, charTimes) {
  fs.writeFileSync(path.join(
    compiled.workspaceRoot, 'src', 'Focusstock', 'focusstock-shots.generated.json'),
  `${JSON.stringify(shots, null, 2)}\n`);
  fs.writeFileSync(path.join(compiled.workspaceRoot, 'src', 'subtitles.json'),
    `${JSON.stringify({ _scriptCharTimes: charTimes }, null, 2)}\n`);
}

function conflictEvidenceFixture(t, { images, shots, charTimes, placement }) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focusstock-conflict-evidence-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspaceRoot, 'public'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'src', 'Focusstock'), { recursive: true });
  const bindings = images.map(({ inputName, bytes }, index) => {
    fs.writeFileSync(path.join(workspaceRoot, 'public', inputName), bytes);
    return {
      kind: 'image',
      assetRef: `asset-image-${index + 1}`,
      inputName,
      sha256: hash(bytes),
      size: bytes.length,
      mediaType: inputName.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    };
  });
  fs.writeFileSync(path.join(
    workspaceRoot, 'src', 'Focusstock', 'focusstock-shots.generated.json'),
  `${JSON.stringify(shots, null, 2)}\n`);
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'subtitles.json'),
    `${JSON.stringify({ _scriptCharTimes: charTimes }, null, 2)}\n`);
  return buildFocusstockVisualConflictEvidence({
    job: { focusstockVisualInputs: bindings },
    workspaceRoot,
    preparedPlan: {
      placement: {
        ...placement,
        startFrame: Math.round(placement.startSec * 30),
        endFrame: Math.round(placement.endSec * 30),
      },
    },
  }).evidence;
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

test('resolved same-Project image runs are accepted and whole overlapping runs are suppressed', async (t) => {
  const ctx = runtimeContext(t);
  await prepareJobMaterialAcquisition(ctx.options);
  const compiled = compileRuntimePlan(ctx);
  const imageAsset = bindReusableFocusstockImage(ctx, compiled);
  writeFocusstockShotEvidence(compiled, [
    { src: 'shot1.png', startCharIdx: 0, endCharIdx: 1 },
    { src: 'shot1.png', startCharIdx: 2, endCharIdx: 3 },
    { src: 'shot1.png', startCharIdx: 4, endCharIdx: 5 },
  ], [
    { start: 0, end: 0.1 }, { start: 0.4, end: 0.5 },
    { start: 2, end: 2.1 }, { start: 2.4, end: 2.5 },
    { start: 5, end: 5.1 }, { start: 5.4, end: 5.5 },
  ]);
  const selected = finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
  });
  const evidence = ctx.job.materialAcquisitionResult.focusstockVisualEvidence;
  assert.equal(evidence.counts.inputs, 1);
  assert.equal(evidence.counts.resolvedShots, 3);
  assert.equal(evidence.counts.runs, 2);
  assert.equal(evidence.counts.suppressedByPrepared, 1);
  assert.equal(evidence.counts.rendered, 1);
  assert.deepEqual(evidence.runs.map((run) => ({
    assetRef: run.assetRef,
    startSec: run.startSec,
    endSec: run.endSec,
    disposition: run.disposition,
  })), [
    {
      assetRef: imageAsset.id,
      startSec: 0,
      endSec: 2.5,
      disposition: 'suppressed_by_prepared',
    },
    {
      assetRef: imageAsset.id,
      startSec: 5,
      endSec: 5.5,
      disposition: 'rendered',
    },
  ]);
  assert.match(ctx.job.materialAcquisitionResult.focusstockVisualEvidenceSha256,
    /^[a-f0-9]{64}$/);
  const placement = commitPreparedPhoneMaterialSelection({
    job: ctx.job, asset: selected.asset, plan: selected.plan, projectStore: ctx.projectStore,
  });
  ctx.job.timelinePlacements = [placement];
  assert.equal(placement.focusstockVisualEvidenceSha256,
    ctx.job.materialAcquisitionResult.focusstockVisualEvidenceSha256);
  assert.equal(validatePreparedPhoneProjectAsset({
    job: ctx.job, projectStore: ctx.projectStore,
  }).asset.id, selected.asset.id);
});

test('ready-to-place assetRefs allow only bound images, exact speaker, and current prepared asset', async (t) => {
  const ctx = runtimeContext(t);
  await prepareJobMaterialAcquisition(ctx.options);
  const compiled = compileRuntimePlan(ctx);
  const imageAsset = bindReusableFocusstockImage(ctx, compiled);
  const speakerAsset = bindSpeakerVideo(ctx, compiled);
  writeFocusstockShotEvidence(compiled,
    [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 }],
    [{ start: 0, end: 0.5 }]);
  const selected = finalizePreparedPhoneMaterial({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    workspaceRoot: compiled.workspaceRoot,
    publicDirectory: compiled.publicDirectory,
    projectStore: ctx.projectStore,
  });
  assert.deepEqual(validatePreparedFocusstockAssetRefs({
    job: ctx.job,
    projectStore: ctx.projectStore,
    workspaceRoot: compiled.workspaceRoot,
  }).map((binding) => binding.assetRef), [imageAsset.id],
  'candidate prepared asset may exist durably before its ref is committed');

  commitPreparedPhoneMaterialSelection({
    job: ctx.job,
    asset: selected.asset,
    plan: selected.plan,
    projectStore: ctx.projectStore,
  });
  assert.deepEqual(new Set(ctx.job.assetRefs),
    new Set([imageAsset.id, speakerAsset.id, selected.asset.id]));
  assert.doesNotThrow(() => validatePreparedFocusstockAssetRefs({
    job: ctx.job,
    projectStore: ctx.projectStore,
    workspaceRoot: compiled.workspaceRoot,
  }));
  const validRefs = [...ctx.job.assetRefs];
  const expectRejected = (assetRefs, name) => {
    ctx.job.assetRefs = assetRefs;
    assert.throws(() => validatePreparedFocusstockAssetRefs({
      job: ctx.job,
      projectStore: ctx.projectStore,
      workspaceRoot: compiled.workspaceRoot,
    }), (error) => error.code === 'placement_compile_failed', name);
  };

  const otherProject = ctx.projectStore.create({
    name: 'Other Project', template: 'focusstock', owner: 'test',
  });
  const crossProjectSource = path.join(ctx.root, 'cross-project.png');
  fs.writeFileSync(crossProjectSource, ALT_PNG);
  const crossProjectAsset = ctx.projectStore.ingestAsset(otherProject.id, crossProjectSource, {
    originalName: 'cross-project.png', kind: 'image',
  });
  expectRejected([...validRefs, crossProjectAsset.id], 'cross-Project assetRef');

  const unboundImage = ctx.projectStore.ingestAsset(ctx.project.id, crossProjectSource, {
    originalName: 'unbound.png', kind: 'image',
  });
  expectRejected([...validRefs, unboundImage.id], 'unbound image');

  const unsupportedVideoSource = path.join(ctx.root, 'unsupported.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=white:s=16x16:r=30:d=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', unsupportedVideoSource,
  ], { stdio: 'ignore', timeout: 15000 });
  const unsupportedVideo = ctx.projectStore.ingestAsset(ctx.project.id, unsupportedVideoSource, {
    originalName: 'unsupported.mp4', kind: 'video',
  });
  expectRejected([...validRefs, unsupportedVideo.id], 'generic video');

  const priorPrepared = ctx.projectStore.ingestAsset(ctx.project.id, unsupportedVideoSource, {
    originalName: 'prior.ready-to-place.mp4',
    kind: 'video',
    role: 'prepared-phone-video',
    origin: 'chipk-simulator-capture',
  });
  assert.notEqual(priorPrepared.id, selected.asset.id);
  expectRejected([...validRefs, priorPrepared.id], 'prior prepared asset');
  expectRejected(validRefs.filter((assetRef) => assetRef !== speakerAsset.id), 'missing speaker');
  expectRejected(validRefs.filter((assetRef) => assetRef !== selected.asset.id),
    'missing current prepared asset');
  ctx.job.assetRefs = validRefs;
});

test('Focusstock conflict evidence uses renderer-equivalent <=2 second run merging', (t) => {
  const evidence = conflictEvidenceFixture(t, {
    images: [{ inputName: 'shot1.png', bytes: Buffer.from('bound-image-one') }],
    shots: [
      { src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 },
      { src: 'shot1.png', startCharIdx: 1, endCharIdx: 1 },
      { src: 'shot1.png', startCharIdx: 2, endCharIdx: 2 },
    ],
    charTimes: [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
      { start: 6.001, end: 7 },
    ],
    placement: { startSec: 20, endSec: 21 },
  });
  assert.equal(evidence.mergeGapSec, 2);
  assert.equal(evidence.runs.length, 2);
  assert.deepEqual(evidence.runs[0].sourceShotIndexes, [0, 1],
    'gap exactly 2 seconds must merge like buildShotRuns');
  assert.equal(evidence.runs[0].startSec, 0);
  assert.equal(evidence.runs[0].endSec, 4);
  assert.deepEqual(evidence.runs[1].sourceShotIndexes, [2],
    'gap above 2 seconds must start a new run like buildShotRuns');
});

test('half-open endpoint touches remain rendered', (t) => {
  const evidence = conflictEvidenceFixture(t, {
    images: [
      { inputName: 'shot1.png', bytes: Buffer.from('bound-image-before') },
      { inputName: 'shot2.jpg', bytes: Buffer.from('bound-image-after') },
    ],
    shots: [
      { src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 },
      { src: 'shot2.jpg', startCharIdx: 1, endCharIdx: 1 },
    ],
    charTimes: [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ],
    placement: { startSec: 2, endSec: 3 },
  });
  assert.equal(evidence.intervalSemantics, 'frame-half-open');
  assert.deepEqual(evidence.runs.map((run) => ({
    startSec: run.startSec,
    endSec: run.endSec,
    startFrame: run.startFrame,
    endFrame: run.endFrame,
    disposition: run.disposition,
  })), [
    { startSec: 1, endSec: 2, startFrame: 30, endFrame: 60, disposition: 'rendered' },
    { startSec: 3, endSec: 4, startFrame: 90, endFrame: 120, disposition: 'rendered' },
  ]);
});

test('fractional seconds are suppressed when renderer-rounded frames overlap prepared video', (t) => {
  const evidence = conflictEvidenceFixture(t, {
    images: [{ inputName: 'shot1.png', bytes: Buffer.from('fractional-bound-image') }],
    shots: [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 }],
    charTimes: [{ start: 0.25, end: 2 }],
    placement: { startSec: 2, endSec: 3 },
  });
  assert.deepEqual(evidence.runs.map((run) => ({
    startSec: run.startSec,
    endSec: run.endSec,
    startFrame: run.startFrame,
    endFrame: run.endFrame,
    durationInFrames: run.durationInFrames,
    disposition: run.disposition,
  })), [{
    startSec: 0.25,
    endSec: 2,
    startFrame: 8,
    endFrame: 61,
    durationInFrames: 53,
    disposition: 'suppressed_by_prepared',
  }]);
});

test('Focusstock visual contract keeps endpoint-touching placements and suppresses a full overlap', () => {
  const endpointTouching = focusstockVisualFrameInterval(1, 2);
  const overlapping = focusstockVisualFrameInterval(2, 3);
  const prepared = { startFrame: 60, endFrame: 75 };
  assert.deepEqual(endpointTouching, {
    fps: 30,
    startFrame: 30,
    endFrame: 60,
    durationInFrames: 30,
  });
  assert.deepEqual(overlapping, {
    fps: 30,
    startFrame: 60,
    endFrame: 90,
    durationInFrames: 30,
  });
  assert.equal(halfOpenFrameIntervalsOverlap(
    endpointTouching.startFrame, endpointTouching.endFrame,
    prepared.startFrame, prepared.endFrame), false,
  'an endpoint-only touch remains rendered');
  assert.equal(halfOpenFrameIntervalsOverlap(
    overlapping.startFrame, overlapping.endFrame,
    prepared.startFrame, prepared.endFrame), true,
  'a half-open interval intersection is suppressed in full');
});

test('Focusstock visual timeline placements are an exact evidence-bound retry contract', (t) => {
  const evidence = conflictEvidenceFixture(t, {
    images: [{ inputName: 'shot1.png', bytes: Buffer.from('placement-bound-image') }],
    shots: [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 }],
    charTimes: [{ start: 0, end: 1 }],
    placement: { startSec: 2, endSec: 3 },
  });
  const evidenceSha256 = hash(JSON.stringify(evidence));
  const expected = buildFocusstockVisualTimelinePlacements(evidence, evidenceSha256);
  const prepared = { kind: 'prepared-phone-video' };
  const recordedCompositionPlacement = {
    clipId: 'broll-01', assetRef: 'asset-video-1', assetSha256: 'a'.repeat(64),
    startSec: 4, endSec: 5, evidenceLevel: 'reconstructed-after-render',
  };
  const validJob = {
    timelinePlacements: [recordedCompositionPlacement, ...expected, prepared],
  };
  assert.deepEqual(validateFocusstockVisualTimelinePlacements(
    validJob, evidence, evidenceSha256), expected);

  const replacementPrepared = { kind: 'prepared-phone-video', assetRef: 'prepared-new' };
  assert.deepEqual(mergePreparedPhoneTimelineChannels({
    existingPlacements: [
      recordedCompositionPlacement,
      { ...expected[0], disposition: 'stale' },
      { kind: 'prepared-phone-video', assetRef: 'prepared-old' },
    ],
    focusstockVisualPlacements: expected,
    preparedPlacement: replacementPrepared,
  }), [recordedCompositionPlacement, ...expected, replacementPrepared]);

  const recordedComposition = {
    schemaVersion: 1,
    mode: 'composition-v1',
    cards: [{ id: 'broll-01' }],
    provenance: { level: 'reconstructed-after-render' },
  };
  const generatedDisabled = { schemaVersion: 1, mode: 'disabled', cards: [] };
  assert.equal(selectPreparedPhoneGraphicBroll(
    recordedComposition, generatedDisabled), recordedComposition,
  'prepared capture must preserve PR36 composition metadata instead of replacing it');
  assert.equal(selectPreparedPhoneGraphicBroll(null, generatedDisabled), generatedDisabled);
  assert.throws(() => selectPreparedPhoneGraphicBroll(
    { schemaVersion: 1, mode: 'composition-v1', cards: [] }, generatedDisabled),
  (error) => error.code === 'placement_compile_failed');

  const mutations = [
    { name: 'missing placement', placements: [prepared] },
    { name: 'extra placement', placements: [...expected, { ...expected[0] }, prepared] },
    {
      name: 'disposition drift',
      placements: [{ ...expected[0], disposition: 'suppressed_by_prepared' }, prepared],
    },
    {
      name: 'frame drift',
      placements: [{ ...expected[0], endFrame: expected[0].endFrame + 1 }, prepared],
    },
    {
      name: 'input hash drift',
      placements: [{ ...expected[0], inputSha256: 'f'.repeat(64) }, prepared],
    },
    {
      name: 'evidence hash drift',
      placements: [{ ...expected[0], conflictEvidenceSha256: 'f'.repeat(64) }, prepared],
    },
  ];
  for (const mutation of mutations) {
    assert.throws(() => validateFocusstockVisualTimelinePlacements(
      { timelinePlacements: mutation.placements }, evidence, evidenceSha256),
    (error) => error.code === 'placement_compile_failed', mutation.name);
  }
});

test('unknown, unselected, unresolved or stale Focusstock image plans fail closed', async (t) => {
  const scenarios = [
    {
      name: 'unknown source',
      shots: [{ src: 'shot2.png', startCharIdx: 0, endCharIdx: 0 }],
      times: [{ start: 0, end: 0.5 }],
    },
    {
      name: 'selected image is unplaced',
      shots: [],
      times: [],
    },
    {
      name: 'unresolved char index',
      shots: [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 2 }],
      times: [{ start: 0, end: 0.5 }],
    },
    {
      name: 'numeric-string subtitle time',
      shots: [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 }],
      times: [{ start: '0', end: 0.5 }],
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (st) => {
      const ctx = runtimeContext(st);
      await prepareJobMaterialAcquisition(ctx.options);
      const compiled = compileRuntimePlan(ctx);
      bindReusableFocusstockImage(ctx, compiled);
      writeFocusstockShotEvidence(compiled, scenario.shots, scenario.times);
      const plan = JSON.parse(fs.readFileSync(path.join(
        compiled.workspaceRoot, ...PREPARED_PLAN.split('/')), 'utf8'));
      assert.throws(() => buildFocusstockVisualConflictEvidence({
        job: ctx.job,
        workspaceRoot: compiled.workspaceRoot,
        preparedPlan: plan,
        jobDirectory: ctx.jobDirectory,
      }), (error) => error.code === 'placement_compile_failed');
    });
  }

  await t.test('bound bytes drift', async (st) => {
    const ctx = runtimeContext(st);
    await prepareJobMaterialAcquisition(ctx.options);
    const compiled = compileRuntimePlan(ctx);
    bindReusableFocusstockImage(ctx, compiled);
    writeFocusstockShotEvidence(compiled,
      [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 0 }],
      [{ start: 0, end: 0.5 }]);
    fs.appendFileSync(path.join(compiled.publicDirectory, 'shot1.png'), Buffer.from('drift'));
    const plan = JSON.parse(fs.readFileSync(path.join(
      compiled.workspaceRoot, ...PREPARED_PLAN.split('/')), 'utf8'));
    assert.throws(() => buildFocusstockVisualConflictEvidence({
      job: ctx.job,
      workspaceRoot: compiled.workspaceRoot,
      preparedPlan: plan,
      jobDirectory: ctx.jobDirectory,
    }), (error) => error.code === 'placement_compile_failed');
  });
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

test('compaction rollback preserves nested binary artifacts with the same basename', async (t) => {
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
  ctx.job.timelinePlacements = [commitPreparedPhoneMaterialSelection({
    job: ctx.job, asset: selected.asset, plan: selected.plan, projectStore: ctx.projectStore,
  })];
  ctx.job.status = 'done';
  ctx.job.renderInputManifestSha256 = 'a'.repeat(64);
  ctx.job.renderEvidence = {
    schemaVersion: 1,
    renderInputManifestSha256: ctx.job.renderInputManifestSha256,
  };

  const binaries = summary.artifacts.filter(({ role }) =>
    role === 'prepared-video' || role === 'screenshot');
  for (const [index, artifact] of binaries.entries()) {
    const source = path.join(ctx.jobDirectory, artifact.evidenceFile);
    const nested = path.join(ctx.jobDirectory, 'acquisition', `nested-${index + 1}`, 'shared.bin');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.renameSync(source, nested);
    artifact.evidenceFile = path.relative(ctx.jobDirectory, nested).split(path.sep).join('/');
  }
  const before = JSON.parse(JSON.stringify(summary.artifacts));
  assert.throws(() => compactPreparedPhoneAcquisition({
    job: ctx.job,
    jobDirectory: ctx.jobDirectory,
    projectStore: ctx.projectStore,
    saveJob: () => { throw new Error('synthetic persistence failure'); },
    nowISO: () => '2026-08-24T00:00:02.000Z',
  }), /synthetic persistence failure/);

  assert.deepEqual(summary.artifacts, before);
  for (const artifact of before.filter(({ role }) =>
    role === 'prepared-video' || role === 'screenshot')) {
    const restored = path.join(ctx.jobDirectory, artifact.evidenceFile);
    assert.equal(fs.existsSync(restored), true, `${artifact.role} must be restored`);
    assert.equal(hash(fs.readFileSync(restored)), artifact.sha256);
  }
  assert.equal(fs.existsSync(path.join(
    ctx.jobDirectory, 'acquisition', '.compacted-binary')), false);
});

test('interrupted compaction restores staged binaries before a safe retry', async (t) => {
  for (const movedCount of [1, 2]) {
    await t.test(`${movedCount} staged binary artifact(s)`, async (st) => {
      const ctx = runtimeContext(st);
      const summary = await prepareJobMaterialAcquisition(ctx.options);
      const compiled = compileRuntimePlan(ctx);
      const selected = finalizePreparedPhoneMaterial({
        job: ctx.job,
        jobDirectory: ctx.jobDirectory,
        workspaceRoot: compiled.workspaceRoot,
        publicDirectory: compiled.publicDirectory,
        projectStore: ctx.projectStore,
      });
      ctx.job.timelinePlacements = [commitPreparedPhoneMaterialSelection({
        job: ctx.job, asset: selected.asset, plan: selected.plan, projectStore: ctx.projectStore,
      })];
      ctx.job.status = 'done';
      ctx.job.renderInputManifestSha256 = 'a'.repeat(64);
      ctx.job.renderEvidence = {
        schemaVersion: 1,
        renderInputManifestSha256: ctx.job.renderInputManifestSha256,
      };

      const before = JSON.parse(JSON.stringify(summary.artifacts));
      const binaries = before.filter(({ role }) =>
        role === 'prepared-video' || role === 'screenshot');
      const trash = path.join(ctx.jobDirectory, 'acquisition', '.compacted-binary');
      fs.mkdirSync(trash, { mode: 0o700 });
      for (const artifact of binaries.slice(0, movedCount)) {
        fs.renameSync(
          path.join(ctx.jobDirectory, artifact.evidenceFile),
          path.join(trash, `${artifact.role}-${artifact.sha256}`));
      }

      let saveAttempts = 0;
      assert.throws(() => compactPreparedPhoneAcquisition({
        job: ctx.job,
        jobDirectory: ctx.jobDirectory,
        projectStore: ctx.projectStore,
        saveJob: () => {
          saveAttempts += 1;
          throw new Error('synthetic persistence failure after recovery');
        },
        nowISO: () => '2026-08-24T00:00:02.000Z',
      }), /synthetic persistence failure after recovery/);
      assert.equal(saveAttempts, 1, 'recovered evidence must reach a fresh durable save attempt');
      assert.deepEqual(summary.artifacts, before);
      for (const artifact of binaries) {
        const restored = path.join(ctx.jobDirectory, artifact.evidenceFile);
        assert.equal(fs.existsSync(restored), true, `${artifact.role} must be restored`);
        assert.equal(hash(fs.readFileSync(restored)), artifact.sha256);
      }
      assert.equal(fs.existsSync(trash), false);

      const compacted = compactPreparedPhoneAcquisition({
        job: ctx.job,
        jobDirectory: ctx.jobDirectory,
        projectStore: ctx.projectStore,
        saveJob: ctx.options.saveJob,
        nowISO: () => '2026-08-24T00:00:03.000Z',
      });
      assert.equal(compacted.compacted, true);
      assert.equal(summary.acquisitionRetention.status, 'sidecars_only');
    });
  }
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
  const scriptRaw = '\n===\n===\n標題\n===\n甲乙\n';
  const plan = compilePreparedPhonePlan({
    intent: input,
    videoPath,
    scriptRaw,
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
    videoPath, scriptRaw, subtitles: {}, videoMeta: { heygenDurationSec: 10 }, inspectedMedia,
  }), (error) => error instanceof PreparedPhonePlanError && error.code === 'placement_out_of_bounds');
  assert.equal(disabledPlan().mode, 'disabled');
  assert.equal(disabledPlan().visualOwnership, null);
});
