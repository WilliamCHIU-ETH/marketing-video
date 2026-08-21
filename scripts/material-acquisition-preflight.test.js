'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  toolVersion: '1.0.0',
  productionReady: true,
  operations: ['screenshot', 'record'],
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
    provider: { id: 'chipk-simulator-capture', toolVersion: '1.0.0' },
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
  const value = await acquireOptionalMaterial({
    request,
    provider: provider(result, { ...CAPABILITIES, operations: ['record'] }),
  });
  assert.equal(value.status, 'fallback');
  assert.equal(value.reason, 'provider_operation_unsupported');
});

test('completed screenshot bundle becomes fresh only after full validation', async (t) => {
  const { request, result } = fixture(t);
  const value = await acquireOptionalMaterial({ request, provider: provider(result) });
  assert.equal(value.status, 'acquired');
  assert.equal(value.evidenceLevel, 'fresh_capture');
  assert.equal(value.contractVersion, 1);
  assert.equal(value.providerVersion, '1.0.0');
  assert.deepEqual(value.acquisitionEvidence, { synthetic: true });
  assert.equal(value.material.find((item) => item.role === 'screenshot').size, PNG.length);
});

test('result envelope is closed and bound to request/provider/status/error invariants', (t) => {
  const { request, result } = fixture(t);
  const badValues = [
    { ...result, requestId: 'other' },
    { ...result, provider: { id: 'other', toolVersion: '1.0.0' } },
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
