'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const {
  MaterialAcquisitionError,
  acquireOptionalMaterial,
  buildCaptureRequest,
  normalizeMaterialAcquisitionIntent,
  validateCaptureResult,
} = require('../server/material-acquisition');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-port-'));
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const intent = normalizeMaterialAcquisitionIntent({
    policy: 'prefer-capture',
    operation: 'screenshot',
    mode: 'test',
    route: 'chipk.stock.health-check',
    stock: { id: '2330', name: '台積電' },
  });
  const request = buildCaptureRequest(intent, { requestId: 'request-2330', outputDirectory });
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, synthetic: true }));
  fs.writeFileSync(path.join(outputDirectory, 'screenshot.png'), PNG);
  fs.writeFileSync(path.join(outputDirectory, 'capture-manifest.json'), manifest);
  const result = {
    contractVersion: 1,
    requestId: request.requestId,
    provider: { id: 'chipk-simulator-capture', toolVersion: '0.3.0' },
    status: 'completed',
    artifacts: [
      {
        role: 'screenshot',
        kind: 'image',
        relativePath: 'screenshot.png',
        sha256: sha256(PNG),
        mimeType: 'image/png',
        media: { width: 1, height: 1 },
      },
      {
        role: 'capture-manifest',
        kind: 'json',
        relativePath: 'capture-manifest.json',
        sha256: sha256(manifest),
        mimeType: 'application/json',
      },
    ],
    evidence: { synthetic: true },
    error: null,
  };
  return { root, outputDirectory, request, result };
}

function provider(result, capabilities = CAPABILITIES) {
  return {
    capabilities: async () => capabilities,
    acquire: async () => result,
  };
}

function preparedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-port-v2-'));
  const outputDirectory = path.join(root, 'output');
  const bundle = path.join(outputDirectory, 'ready-to-place');
  fs.mkdirSync(bundle, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = buildCaptureRequest(normalizeMaterialAcquisitionIntent({
    policy: 'require-capture', operation: 'prepared-video', mode: 'test',
    route: 'chipk.stock.main-force', stock: { id: '3441' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
  }), { requestId: 'request-v2-3441', outputDirectory });
  const screenshot = path.join(bundle, 'screenshot.png');
  fs.writeFileSync(screenshot, PNG);
  const video = path.join(bundle, 'prepared.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x32:r=30:d=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', video,
  ]);
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1, route: { id: request.target.routeId },
    parameters: { stockid: request.target.stockId },
    screenshot: { file: 'screenshot.png', sha256: sha256(PNG) },
    verification: {
      expectedTexts: ['主力', '3441'], matchedTexts: ['主力', '3441'],
      contentTexts: { expected: ['買賣家數差'], observed: ['買賣家數差'], missing: [] },
    },
    catalogVersion: 'catalog-v2-test',
  }));
  fs.writeFileSync(path.join(bundle, 'capture-manifest.json'), capture);
  const videoBytes = fs.readFileSync(video);
  const planValue = {
    schemaVersion: 1, contractVersion: 2, requestId: request.requestId,
    operation: 'prepared-video',
    profile: { id: request.presentation.profileId, version: 1, status: 'ready_to_place' },
    target: { routeId: request.target.routeId, stockId: request.target.stockId, mode: request.mode },
    source: {
      kind: 'screenshot', file: 'screenshot.png', sha256: sha256(PNG),
      captureManifest: { file: 'capture-manifest.json', sha256: sha256(capture) },
    },
    timeline: { durationSeconds: 1, fps: 30, frameCount: 30 },
    output: { codec: 'h264', width: 16, height: 32 },
  };
  const plan = Buffer.from(JSON.stringify(planValue));
  fs.writeFileSync(path.join(bundle, 'presentation-plan.json'), plan);
  const preparation = Buffer.from(JSON.stringify({
    schemaVersion: 1, contractVersion: 2, requestId: request.requestId,
    status: 'ready_to_place', profile: planValue.profile, source: planValue.source,
    presentationPlan: { file: 'presentation-plan.json', sha256: sha256(plan) },
    output: {
      role: 'prepared-video', file: 'prepared.mp4', sha256: sha256(videoBytes),
      codec: 'h264', width: 16, height: 32, durationSeconds: 1,
    },
    publication: { strategy: 'staging_directory_atomic_rename', finalDirectory: 'ready-to-place' },
  }));
  fs.writeFileSync(path.join(bundle, 'preparation-manifest.json'), preparation);
  const jsonArtifact = (role, name, bytes) => ({
    role, kind: 'json', relativePath: `ready-to-place/${name}`,
    sha256: sha256(bytes), mimeType: 'application/json',
  });
  const result = {
    contractVersion: 2, requestId: request.requestId,
    provider: { id: 'chipk-simulator-capture', toolVersion: '0.3.0' },
    status: 'completed',
    artifacts: [
      {
        role: 'prepared-video', kind: 'video', relativePath: 'ready-to-place/prepared.mp4',
        sha256: sha256(videoBytes), mimeType: 'video/mp4',
        media: { codec: 'h264', width: 16, height: 32, durationSeconds: 1 },
      },
      {
        role: 'screenshot', kind: 'image', relativePath: 'ready-to-place/screenshot.png',
        sha256: sha256(PNG), mimeType: 'image/png', media: { width: 1, height: 1 },
      },
      jsonArtifact('capture-manifest', 'capture-manifest.json', capture),
      jsonArtifact('presentation-plan', 'presentation-plan.json', plan),
      jsonArtifact('preparation-manifest', 'preparation-manifest.json', preparation),
    ],
    evidence: {
      routeSelection: 'catalog_exact_match', navigation: 'expected_texts_verified',
      material: 'ready_to_place', catalogVersion: 'catalog-v2-test',
      presentationProfile: { id: request.presentation.profileId, version: 1, status: 'ready_to_place' },
      publication: 'atomic_directory_rename',
    },
    error: null,
  };
  return { root, outputDirectory, request, result };
}

test('closed intent accepts only policy/operation/mode/route/stock/recipe', () => {
  const normalized = normalizeMaterialAcquisitionIntent({
    policy: 'require-capture',
    operation: 'record',
    mode: 'live',
    route: 'chipk.stock.kline',
    stock: { id: '2330', name: '台積電' },
    recipe: 'kline-pan-v1',
  });
  assert.deepEqual(normalized, {
    policy: 'require-capture', operation: 'record', mode: 'live',
    route: 'chipk.stock.kline', stock: { id: '2330', name: '台積電' },
    recipe: 'kline-pan-v1',
  });
  assert.throws(
    () => normalizeMaterialAcquisitionIntent({
      operation: 'screenshot', mode: 'test', route: 'chipk.stock.kline', outputDirectory: '/tmp/x',
    }),
    (error) => error.code === 'invalid_material_intent',
  );
  assert.throws(
    () => normalizeMaterialAcquisitionIntent({
      operation: 'record', mode: 'test', route: 'chipk.stock.kline',
    }),
    (error) => error.code === 'invalid_material_intent',
  );
});

test('prepared-video intent produces a closed Contract v2 request with presentation profile', (t) => {
  const outputDirectory = fixture(t).outputDirectory;
  const intent = normalizeMaterialAcquisitionIntent({
    policy: 'require-capture', operation: 'prepared-video', mode: 'test',
    route: 'chipk.stock.main-force', stock: { id: '3441' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
  });
  const request = buildCaptureRequest(intent, { requestId: 'request-v2', outputDirectory });
  assert.deepEqual(request, {
    contractVersion: 2, requestId: 'request-v2', operation: 'prepared-video', mode: 'test',
    target: { routeId: 'chipk.stock.main-force', stockId: '3441' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
    outputDirectory: path.resolve(outputDirectory),
  });
  assert.throws(() => normalizeMaterialAcquisitionIntent({
    operation: 'prepared-video', mode: 'test', route: 'chipk.stock.main-force',
    stock: { id: '3441' },
  }), (error) => error.code === 'invalid_material_intent');
});

test('server-built request owns requestId and absolute outputDirectory', (t) => {
  const { request, outputDirectory } = fixture(t);
  assert.equal(request.contractVersion, 1);
  assert.equal(request.outputDirectory, path.resolve(outputDirectory));
  assert.deepEqual(request.target, {
    routeId: 'chipk.stock.health-check', stockId: '2330', stockName: '台積電',
  });
});

test('disable policy performs zero provider calls', async () => {
  let calls = 0;
  const result = await acquireOptionalMaterial({
    policy: 'disable-capture',
    request: {},
    provider: {
      capabilities: async () => { calls += 1; },
      acquire: async () => { calls += 1; },
    },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(calls, 0);
});

test('prefer falls back and require blocks when provider is absent', async (t) => {
  const { request } = fixture(t);
  const fallback = await acquireOptionalMaterial({ request });
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.reason, 'provider_unconfigured');
  assert.equal(fallback.evidenceLevel, 'illustrative_not_fresh_capture');
  await assert.rejects(
    () => acquireOptionalMaterial({ policy: 'require-capture', request }),
    (error) => error instanceof MaterialAcquisitionError && error.code === 'provider_unconfigured',
  );
});

test('capability operation gate prevents unsupported acquisition', async (t) => {
  const { request, result } = fixture(t);
  const contractCapabilities = CAPABILITIES.contractCapabilities.map((item) => (
    item.contractVersion === 1 ? { ...item, operations: ['record'] } : item));
  const value = await acquireOptionalMaterial({
    request, provider: provider(result, { ...CAPABILITIES, contractCapabilities }),
  });
  assert.equal(value.status, 'fallback');
  assert.equal(value.reason, 'provider_operation_unsupported');
});

test('v2 capability coverage gap is explicit and never invokes a lower operation', async (t) => {
  const { request, result } = preparedFixture(t);
  const unsupported = {
    ...request,
    presentation: { profileId: 'chipk.unsupported-profile' },
  };
  let calls = 0;
  const selectedProvider = {
    capabilities: async () => CAPABILITIES,
    acquire: async () => { calls += 1; return result; },
  };
  const preferred = await acquireOptionalMaterial({ request: unsupported, provider: selectedProvider });
  assert.equal(preferred.status, 'fallback');
  assert.equal(preferred.reason, 'provider_coverage_gap');
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request: unsupported, provider: selectedProvider,
    }),
    (error) => error.code === 'provider_coverage_gap',
  );
  assert.equal(calls, 0);
});

test('v2 live acquisition remains blocked until capability proves VIP readiness before mutation', async (t) => {
  const { request, result } = preparedFixture(t);
  let calls = 0;
  const liveRequest = { ...request, mode: 'live' };
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request: liveRequest,
      provider: {
        capabilities: async () => CAPABILITIES,
        acquire: async () => { calls += 1; return result; },
      },
    }),
    (error) => error.code === 'provider_live_readiness_unverified',
  );
  assert.equal(calls, 0);
});

test('completed v2 bundle is accepted only with exact evidence and cross-file provenance', async (t) => {
  const { request, result, outputDirectory } = preparedFixture(t);
  const acquired = await acquireOptionalMaterial({
    policy: 'require-capture', request, provider: provider(result),
  });
  assert.equal(acquired.status, 'acquired');
  assert.equal(acquired.contractVersion, 2);
  assert.equal(acquired.material.length, 5);

  const manifestFile = path.join(outputDirectory, 'ready-to-place', 'preparation-manifest.json');
  const forged = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  forged.output.sha256 = '0'.repeat(64);
  const forgedBytes = Buffer.from(JSON.stringify(forged));
  fs.writeFileSync(manifestFile, forgedBytes);
  const tampered = {
    ...result,
    artifacts: result.artifacts.map((artifact) => artifact.role === 'preparation-manifest'
      ? { ...artifact, sha256: sha256(forgedBytes) } : artifact),
  };
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request, provider: provider(tampered),
    }),
    (error) => error.code === 'provider_provenance_invalid',
  );
});

test('capability version mismatch falls back or fails closed before acquire', async (t) => {
  const { request, result } = fixture(t);
  let acquireCalls = 0;
  const mismatched = {
    capabilities: async () => ({ ...CAPABILITIES, toolVersion: '0.2.9' }),
    acquire: async () => { acquireCalls += 1; return result; },
  };
  const preferred = await acquireOptionalMaterial({ request, provider: mismatched });
  assert.equal(preferred.status, 'fallback');
  assert.equal(preferred.reason, 'provider_version_incompatible');
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request, provider: mismatched,
    }),
    (error) => error instanceof MaterialAcquisitionError
      && error.code === 'provider_version_incompatible',
  );
  assert.equal(acquireCalls, 0);
});

test('completed screenshot bundle becomes fresh only after full validation', async (t) => {
  const { request, result } = fixture(t);
  const value = await acquireOptionalMaterial({ request, provider: provider(result) });
  assert.equal(value.status, 'acquired');
  assert.equal(value.evidenceLevel, 'fresh_capture');
  assert.equal(value.contractVersion, 1);
  assert.equal(value.providerVersion, '0.3.0');
  assert.deepEqual(value.acquisitionEvidence, { synthetic: true });
  assert.equal(value.material.find((item) => item.role === 'screenshot').size, PNG.length);
});

test('result version drift follows prefer fallback and require fail-closed policy', async (t) => {
  const { request, result } = fixture(t);
  const drifted = {
    ...result,
    provider: { ...result.provider, toolVersion: '0.2.9' },
  };
  const preferred = await acquireOptionalMaterial({ request, provider: provider(drifted) });
  assert.equal(preferred.status, 'fallback');
  assert.equal(preferred.reason, 'provider_version_incompatible');
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request, provider: provider(drifted),
    }),
    (error) => error instanceof MaterialAcquisitionError
      && error.code === 'provider_version_incompatible',
  );
});

test('result envelope is closed and bound to request/provider/status/error invariants', (t) => {
  const { request, result } = fixture(t);
  const badValues = [
    { ...result, requestId: 'other' },
    { ...result, provider: { id: 'other', toolVersion: '0.3.0' } },
    { ...result, evidence: [] },
    { ...result, error: { code: 'x', message: 'x', retryable: false } },
    { ...result, extra: true },
    {
      ...result, status: 'failed', artifacts: [], error: null,
    },
    {
      ...result, status: 'failed', artifacts: [],
      error: { code: 'failed', message: 'failed' },
    },
  ];
  for (const value of badValues) assert.throws(
    () => validateCaptureResult(value, request),
    (error) => error.code === 'provider_result_incompatible',
  );
});

test('artifact descriptor rejects absolute/traversal/backslash/role/MIME drift', (t) => {
  const { request, result, outputDirectory } = fixture(t);
  const unsafePaths = [
    { relativePath: path.join(outputDirectory, 'screenshot.png') },
    { relativePath: '../screenshot.png' },
    { relativePath: 'nested\\screenshot.png' },
  ];
  for (const replacement of unsafePaths) {
    const artifacts = result.artifacts.map((item, index) =>
      index === 0 ? { ...item, ...replacement } : item);
    assert.throws(
      () => validateCaptureResult({ ...result, artifacts }, request),
      (error) => error.code === 'provider_artifact_path_invalid',
    );
  }
  const incompatible = [
    { role: 'raw-video' },
    { mimeType: 'video/mp4' },
    { unknown: true },
  ];
  for (const replacement of incompatible) {
    const artifacts = result.artifacts.map((item, index) =>
      index === 0 ? { ...item, ...replacement } : item);
    assert.throws(
      () => validateCaptureResult({ ...result, artifacts }, request),
      (error) => error.code === 'provider_artifact_invalid',
    );
  }
});

test('conforming nested relativePath is accepted without filename coupling', (t) => {
  const { request, result, outputDirectory } = fixture(t);
  const nested = path.join(outputDirectory, 'nested');
  fs.mkdirSync(nested);
  fs.renameSync(path.join(outputDirectory, 'screenshot.png'), path.join(nested, 'alternate.png'));
  const artifacts = result.artifacts.map((item, index) =>
    index === 0 ? { ...item, relativePath: 'nested/alternate.png' } : item);
  const validated = validateCaptureResult({ ...result, artifacts }, request);
  assert.equal(validated.artifacts[0].relativePath, 'nested/alternate.png');
});

test('hash, MIME/decode and media dimension mismatches are rejected', (t) => {
  const { request, result, outputDirectory } = fixture(t);
  assert.throws(
    () => validateCaptureResult({
      ...result,
      artifacts: result.artifacts.map((item, index) =>
        index === 0 ? { ...item, sha256: '0'.repeat(64) } : item),
    }, request),
    (error) => error.code === 'provider_artifact_hash_mismatch',
  );
  assert.throws(
    () => validateCaptureResult({
      ...result,
      artifacts: result.artifacts.map((item, index) =>
        index === 0 ? { ...item, media: { width: 2, height: 1 } } : item),
    }, request),
    (error) => error.code === 'provider_media_mismatch',
  );
  const text = Buffer.from('{"not":"png"}');
  fs.writeFileSync(path.join(outputDirectory, 'screenshot.png'), text);
  assert.throws(
    () => validateCaptureResult({
      ...result,
      artifacts: result.artifacts.map((item, index) =>
        index === 0 ? { ...item, sha256: sha256(text) } : item),
    }, request),
    (error) => error.code === 'provider_mime_mismatch',
  );
});

test('symlink artifacts and escaped canonical targets are rejected', (t) => {
  const { root, request, result, outputDirectory } = fixture(t);
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.unlinkSync(path.join(outputDirectory, 'screenshot.png'));
  fs.symlinkSync(outside, path.join(outputDirectory, 'screenshot.png'));
  assert.throws(
    () => validateCaptureResult(result, request),
    (error) => error.code === 'provider_artifact_path_invalid',
  );
});

test('prefer saves a limitation while require blocks validation failures', async (t) => {
  const { request, result } = fixture(t);
  const invalid = {
    ...result,
    artifacts: result.artifacts.map((item, index) =>
      index === 0 ? { ...item, sha256: '0'.repeat(64) } : item),
  };
  const preferred = await acquireOptionalMaterial({ request, provider: provider(invalid) });
  assert.equal(preferred.status, 'fallback');
  assert.equal(preferred.reason, 'provider_artifact_hash_mismatch');
  assert.equal(preferred.evidenceLevel, 'illustrative_not_fresh_capture');
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request, provider: provider(invalid),
    }),
    (error) => error instanceof MaterialAcquisitionError
      && error.code === 'provider_artifact_hash_mismatch',
  );
});

test('typed non-completed provider result falls back or blocks by policy', async (t) => {
  const { request, result } = fixture(t);
  const rejected = {
    ...result,
    status: 'human_action_required',
    artifacts: [],
    evidence: { missingConfiguration: ['CHIPK_SIMULATOR_UDID'] },
    error: { code: 'RUNTIME_CONFIGURATION_REQUIRED', message: 'configuration required', retryable: true },
  };
  const preferred = await acquireOptionalMaterial({ request, provider: provider(rejected) });
  assert.equal(preferred.status, 'fallback');
  assert.equal(preferred.reason, 'RUNTIME_CONFIGURATION_REQUIRED');
  await assert.rejects(
    () => acquireOptionalMaterial({
      policy: 'require-capture', request, provider: provider(rejected),
    }),
    (error) => error.code === 'RUNTIME_CONFIGURATION_REQUIRED',
  );
});
