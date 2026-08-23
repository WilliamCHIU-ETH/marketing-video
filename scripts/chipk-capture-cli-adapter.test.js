'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CaptureCliAdapterError,
  createChipKCaptureCliAdapter,
  probeChipKCaptureCli,
} = require('../server/chipk-capture-cli-adapter');

const capabilities = {
  schemaVersion: 1,
  providerId: 'chipk-simulator-capture',
  toolVersion: '0.2.1',
  productionReady: true,
  operations: ['screenshot', 'record'],
};

function outputDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('capabilities uses the stable command and parses one JSON document', async () => {
  const calls = [];
  const runner = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, JSON.stringify(capabilities), '');
  };
  const result = await probeChipKCaptureCli({ command: '/provider/bin', runner });
  assert.deepEqual(result, capabilities);
  assert.deepEqual(calls[0].args, ['capabilities', '--json']);
  assert.equal(calls[0].command, '/provider/bin');
  assert.equal(calls[0].options.shell, undefined);
});

test('acquire writes a private request file and invokes the locked CLI shape', async (t) => {
  const dir = outputDir(t);
  const request = {
    contractVersion: 1,
    requestId: 'req-1',
    operation: 'screenshot',
    mode: 'test',
    target: { routeId: 'chipk.stock.health-check' },
    outputDirectory: dir,
  };
  let requestFile;
  const runner = (_command, args, _options, callback) => {
    if (args[0] === 'capabilities') return callback(null, JSON.stringify(capabilities), '');
    assert.deepEqual(args.slice(0, 2), ['acquire', '--request']);
    assert.equal(args[3], '--json');
    requestFile = args[2];
    assert.ok(path.isAbsolute(requestFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), request);
    assert.equal(fs.statSync(requestFile).mode & 0o777, 0o600);
    return callback(null, JSON.stringify({
      contractVersion: 1,
      requestId: request.requestId,
      provider: { id: 'chipk-simulator-capture', toolVersion: '0.2.1' },
      status: 'completed',
      artifacts: [],
    }), '');
  };
  const adapter = createChipKCaptureCliAdapter({ command: '/provider/bin', runner });
  const result = await adapter.acquire(request);
  assert.equal(result.status, 'completed');
  assert.equal(fs.existsSync(requestFile), false);
});

test('typed non-completed result on provider exit 3 is returned to the Port', async (t) => {
  const dir = outputDir(t);
  const error = Object.assign(new Error('exit 3'), { code: 3 });
  const runner = (_command, _args, _options, callback) => callback(error, JSON.stringify({
    contractVersion: 1,
    requestId: 'req-human',
    provider: { id: 'chipk-simulator-capture', toolVersion: '0.2.1' },
    status: 'human_action_required',
    artifacts: [],
    error: { code: 'vip_session_required' },
  }), '');
  const adapter = createChipKCaptureCliAdapter({ runner });
  const result = await adapter.acquire({
    contractVersion: 1,
    requestId: 'req-human',
    operation: 'screenshot',
    mode: 'test',
    target: { routeId: 'chipk.stock.health-check' },
    outputDirectory: dir,
  });
  assert.equal(result.status, 'human_action_required');
});

test('acquire enforces exit 0 completed, exit 3 non-completed, and exit 2 CLI fault', async (t) => {
  const dir = outputDir(t);
  const request = {
    contractVersion: 1, requestId: 'req-exit', operation: 'screenshot', mode: 'test',
    target: { routeId: 'chipk.stock.health-check' }, outputDirectory: dir,
  };
  const completed = JSON.stringify({ status: 'completed' });
  const rejected = JSON.stringify({ status: 'rejected' });
  const cases = [
    { error: null, stdout: rejected },
    { error: Object.assign(new Error('exit 3'), { code: 3 }), stdout: completed },
    { error: Object.assign(new Error('exit 2'), { code: 2 }), stdout: completed },
    { error: Object.assign(new Error('killed'), { code: 3, killed: true }), stdout: rejected },
  ];
  for (const item of cases) {
    const adapter = createChipKCaptureCliAdapter({
      runner: (_c, _a, _o, cb) => cb(item.error, item.stdout, ''),
    });
    await assert.rejects(
      () => adapter.acquire(request),
      (error) => error instanceof CaptureCliAdapterError,
    );
  }
});

test('invalid stdout, timeout and typed CLI stderr remain bounded errors', async () => {
  await assert.rejects(
    () => probeChipKCaptureCli({ runner: (_c, _a, _o, cb) => cb(null, 'not json', '') }),
    (error) => error instanceof CaptureCliAdapterError && error.code === 'provider_invalid_json',
  );
  await assert.rejects(
    () => probeChipKCaptureCli({
      runner: (_c, _a, _o, cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '', ''),
    }),
    (error) => error instanceof CaptureCliAdapterError && error.code === 'provider_timeout',
  );
  await assert.rejects(
    () => probeChipKCaptureCli({
      runner: (_c, _a, _o, cb) => cb(Object.assign(new Error('exit 2'), { code: 2 }), '',
        JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'private detail' } })),
    }),
    (error) => error instanceof CaptureCliAdapterError && error.code === 'INVALID_REQUEST'
      && !error.message.includes('private detail'),
  );
});

test('capability identity mismatch is rejected', async () => {
  await assert.rejects(
    () => probeChipKCaptureCli({
      runner: (_c, _a, _o, cb) => cb(null, JSON.stringify({ ...capabilities, providerId: 'other' }), ''),
    }),
    (error) => error instanceof CaptureCliAdapterError
      && error.code === 'provider_contract_incompatible',
  );
});

test('capability version mismatch is rejected by the exact consumer lock', async () => {
  await assert.rejects(
    () => probeChipKCaptureCli({
      runner: (_c, _a, _o, cb) => cb(null,
        JSON.stringify({ ...capabilities, toolVersion: '0.2.0' }), ''),
    }),
    (error) => error instanceof CaptureCliAdapterError
      && error.code === 'provider_version_incompatible',
  );
});
