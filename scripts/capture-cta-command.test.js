'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const APP_ROOT = path.resolve(
  process.env.MARKETING_VIDEO_TEST_APP_ROOT || path.join(__dirname, '..'));
const PROVIDER_LOCK = require(path.join(
  APP_ROOT, 'config', 'chipk-capture-provider.lock.json'));
const LOCKED_TOOL_VERSION = PROVIDER_LOCK.toolVersion;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');
const PNG_SHA256 = crypto.createHash('sha256').update(PNG).digest('hex');
const EXPECTED_PROVENANCE_KEYS = [
  'schemaVersion', 'sha256', 'bytes', 'absolutePath', 'providerId', 'toolVersion',
  'contractVersion', 'routeId', 'operation', 'mode', 'stockId', 'acquiredAt',
];

function injectedRunnerPreload() {
  return String.raw`'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const adapterPath = path.join(
  process.env.CTA_TEST_APP_ROOT, 'server', 'chipk-capture-cli-adapter.js');
const adapter = require(adapterPath);
const originalCreate = adapter.createChipKCaptureCliAdapter;
const originalProbe = adapter.probeChipKCaptureCli;
const providerLock = require(path.join(
  process.env.CTA_TEST_APP_ROOT, 'config', 'chipk-capture-provider.lock.json'));
const lockedToolVersion = providerLock.toolVersion;
const mismatchedToolVersion = lockedToolVersion + '-mismatch';
const scenario = process.env.CTA_FAKE_SCENARIO || 'success';
const logFile = process.env.CTA_FAKE_LOG;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');

function record(value) {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(value) + '\n');
}

function capabilities() {
  return {
    schemaVersion: 1,
    providerId: 'chipk-simulator-capture',
    toolVersion: scenario === 'version-mismatch'
      ? mismatchedToolVersion : lockedToolVersion,
    productionReady: true,
    operations: ['screenshot', 'record'],
    contractCapabilities: [
      {
        contractVersion: 1,
        operations: ['screenshot', 'record'],
        requestSchema: 'contracts/capture-request.schema.json',
        resultSchema: 'contracts/capture-result.schema.json',
      },
      {
        contractVersion: 2,
        operations: ['prepared-video'],
        requestSchema: 'contracts/capture-request-v2.schema.json',
        resultSchema: 'contracts/capture-result-v2.schema.json',
        presentationProfiles: [{
          id: 'chipk.stock-main-force-portrait.v1',
          version: 1,
          status: 'ready_to_place',
          sourceKind: 'screenshot',
          routeIds: ['chipk.stock.main-force'],
          stockIds: ['3441'],
          artifactRole: 'prepared-video',
        }],
      },
    ],
  };
}

function runner(command, args, _options, callback) {
  record({ type: 'call', command, args });
  if (args.length === 2 && args[0] === 'capabilities' && args[1] === '--json') {
    if (scenario === 'unavailable') {
      callback(Object.assign(new Error('provider unavailable'), { code: 'ENOENT' }), '', '');
      return;
    }
    callback(null, JSON.stringify(capabilities()), '');
    return;
  }
  if (args.length === 4 && args[0] === 'acquire' && args[1] === '--request'
      && args[3] === '--json') {
    const request = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    record({ type: 'request', request });
    if (scenario === 'human-action') {
      const result = {
        contractVersion: 1,
        requestId: request.requestId,
        provider: { id: 'chipk-simulator-capture', toolVersion: lockedToolVersion },
        status: 'human_action_required',
        artifacts: [],
        evidence: { readiness: 'vip_session_required' },
        error: {
          code: 'vip_session_required',
          message: 'Sign in and complete MFA in the dedicated Simulator, then retry.',
          retryable: true,
        },
      };
      callback(Object.assign(new Error('exit 3'), { code: 3 }), JSON.stringify(result), '');
      return;
    }
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      source: 'injected-adapter-runner',
    }));
    fs.writeFileSync(path.join(request.outputDirectory, 'screenshot.png'), png);
    fs.writeFileSync(path.join(request.outputDirectory, 'capture-manifest.json'), manifest);
    const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const result = {
      contractVersion: 1,
      requestId: request.requestId,
      provider: { id: 'chipk-simulator-capture', toolVersion: lockedToolVersion },
      status: 'completed',
      artifacts: [
        {
          role: 'screenshot',
          kind: 'image',
          relativePath: 'screenshot.png',
          sha256: scenario === 'corrupt-hash' ? '0'.repeat(64) : sha256(png),
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
      evidence: { source: 'injected-adapter-runner' },
      error: null,
    };
    callback(null, JSON.stringify(result), '');
    return;
  }
  callback(Object.assign(new Error('unexpected provider command'), { code: 99 }), '', '');
}

adapter.createChipKCaptureCliAdapter = (options = {}) => originalCreate({
  ...options,
  runner,
});
adapter.probeChipKCaptureCli = (options = {}) => originalProbe({
  ...options,
  runner,
});
`;
}

function fixture(t, { symlinkCtaOutside = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-cta-command-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  const preload = path.join(root, 'inject-runner.cjs');
  const log = path.join(root, 'runner.jsonl');
  fs.mkdirSync(project);
  fs.writeFileSync(preload, injectedRunnerPreload());
  if (symlinkCtaOutside) {
    fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, 'assets', 'cta'));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, outside, preload, log };
}

function safePath() {
  return [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .join(path.delimiter);
}

function runMaterial(fx, args, { scenario = 'success', env = {} } = {}) {
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--require=${fx.preload}`,
  ].filter(Boolean).join(' ');
  return spawnSync('npm', [
    '--silent', '--prefix', APP_ROOT, 'run', 'material', '--', ...args,
  ], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: safePath(),
      NODE_OPTIONS: nodeOptions,
      CTA_TEST_APP_ROOT: APP_ROOT,
      CTA_FAKE_SCENARIO: scenario,
      CTA_FAKE_LOG: fx.log,
      CHIPK_CAPTURE_BIN: '',
      ...env,
    },
  });
}

function commandArgs(project, stockId = '2426') {
  return ['capture-cta', '--project', project, '--stock-id', stockId, '--json'];
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
}

function extractJsonDocuments(text) {
  const documents = [];
  const source = String(text || '');
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { documents.push(JSON.parse(source.slice(start, index + 1))); } catch (_) {}
          start = index;
          break;
        }
      }
    }
  }
  return documents;
}

function typedOutput(result) {
  const documents = [
    ...extractJsonDocuments(result.stdout),
    ...extractJsonDocuments(result.stderr),
  ];
  const value = documents.find((item) =>
    item && ['completed', 'human_action_required', 'failed'].includes(item.status));
  assert.ok(value, `expected typed command output\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return value;
}

function assertInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  assert.notEqual(relative, '');
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`), false);
}

function assertNoAsset(project) {
  assert.equal(fs.existsSync(path.join(project, 'assets', 'cta', 'cta.png')), false);
  assert.equal(fs.existsSync(path.join(project, 'assets', 'cta', 'cta.provenance.json')), false);
}

test('Marketing command accepts an absolute Project and stockId through the Port/Adapter runner seam', (t) => {
  const fx = fixture(t);
  const result = runMaterial(fx, commandArgs(fx.project));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const output = typedOutput(result);
  assert.equal(output.status, 'completed');
  assert.deepEqual(JSON.parse(result.stdout.trim()), output, 'stdout must contain one JSON document');

  const canonicalProject = fs.realpathSync(fx.project);
  const assetPath = path.join(canonicalProject, 'assets', 'cta', 'cta.png');
  const provenancePath = path.join(canonicalProject, 'assets', 'cta', 'cta.provenance.json');
  assert.equal(output.asset.absolutePath, assetPath);
  assert.equal(output.asset.mimeType, 'image/png');
  assert.equal(output.asset.bytes, PNG.length);
  assert.equal(output.asset.sha256, PNG_SHA256);
  assert.deepEqual(fs.readFileSync(assetPath), PNG);
  assert.equal(fs.lstatSync(assetPath).isFile(), true);

  assert.deepEqual(output.evidence, {
    providerId: 'chipk-simulator-capture',
    toolVersion: LOCKED_TOOL_VERSION,
    contractVersion: 1,
    stockId: '2426',
  });
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  for (const key of EXPECTED_PROVENANCE_KEYS) assert.ok(
    Object.hasOwn(provenance, key), `missing provenance.${key}`);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.sha256, PNG_SHA256);
  assert.equal(provenance.bytes, PNG.length);
  assert.equal(provenance.absolutePath, assetPath);
  assert.equal(provenance.providerId, 'chipk-simulator-capture');
  assert.equal(provenance.toolVersion, LOCKED_TOOL_VERSION);
  assert.equal(provenance.contractVersion, 1);
  assert.equal(provenance.routeId, 'chipk.stock.realtime');
  assert.equal(provenance.operation, 'screenshot');
  assert.equal(provenance.mode, 'live');
  assert.equal(provenance.stockId, '2426');
  assert.equal(Number.isNaN(Date.parse(provenance.acquiredAt)), false);

  const events = readEvents(fx.log);
  const calls = events.filter((event) => event.type === 'call');
  assert.ok(calls.length >= 2, 'expected capabilities and acquire through the Adapter');
  assert.ok(calls.some((event) => JSON.stringify(event.args) === JSON.stringify(['capabilities', '--json'])));
  assert.equal(calls.filter((event) => event.args[0] === 'acquire').length, 1);
  assert.ok(calls.every((event) => event.command === 'chipk-capture'),
    'the default Adapter command must stay an implementation detail');

  const request = events.find((event) => event.type === 'request')?.request;
  assert.ok(request, 'the injected Adapter runner must observe the request file');
  assert.deepEqual(Object.keys(request).sort(), [
    'contractVersion', 'mode', 'operation', 'outputDirectory', 'requestId', 'target',
  ]);
  assert.equal(request.contractVersion, 1);
  assert.equal(request.operation, 'screenshot');
  assert.equal(request.mode, 'live');
  assert.deepEqual(request.target, { routeId: 'chipk.stock.realtime', stockId: '2426' });
  assert.equal(path.isAbsolute(request.outputDirectory), true);
  assertInside(canonicalProject, request.outputDirectory);
});

test('Marketing command rejects relative Projects and every provider-facing flag before probing', async (t) => {
  await t.test('Project must be absolute', (subtest) => {
    const fx = fixture(subtest);
    const result = runMaterial(fx, commandArgs('relative/project'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absolute|絕對/i);
    assert.deepEqual(readEvents(fx.log), []);
  });

  const forbidden = [
    ['--route-id', 'chipk.stock.realtime'],
    ['--routeId', 'chipk.stock.realtime'],
    ['--udid', 'fixture-udid'],
    ['--chipk-capture-bin', '/tmp/provider'],
    ['--request', '/tmp/request.json'],
    ['--capabilities', 'true'],
    ['--output', '/tmp/outside-cta.png'],
  ];
  for (const option of forbidden) {
    await t.test(`rejects ${option[0]}`, (subtest) => {
      const fx = fixture(subtest);
      const args = commandArgs(fx.project);
      args.splice(args.length - 1, 0, ...option);
      const result = runMaterial(fx, args);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.trim(), 'rejection must explain itself on stderr');
      assert.match(result.stderr, new RegExp(option[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.doesNotMatch(result.stderr, /CHIPK_CAPTURE_BIN/,
        'usage must not advertise the Adapter executable environment variable');
      assert.deepEqual(readEvents(fx.log), []);
    });
  }
});

test('Project-owned destination rejects a cta directory symlink that escapes the Project', (t) => {
  const fx = fixture(t, { symlinkCtaOutside: true });
  const result = runMaterial(fx, commandArgs(fx.project));
  assert.notEqual(result.status, 0);
  assert.equal(typedOutput(result).status, 'failed');
  assert.deepEqual(fs.readdirSync(fx.outside), []);
  assert.equal(fs.lstatSync(path.join(fx.project, 'assets', 'cta')).isSymbolicLink(), true);
});

test('a completed provider envelope cannot bypass PNG hash verification', (t) => {
  const fx = fixture(t);
  const result = runMaterial(fx, commandArgs(fx.project), { scenario: 'corrupt-hash' });
  assert.notEqual(result.status, 0);
  assert.equal(typedOutput(result).status, 'failed');
  assertNoAsset(fx.project);
  const events = readEvents(fx.log);
  assert.equal(events.filter((event) => event.type === 'request').length, 1);
});

test('provider unavailable and exact-version mismatch both fail closed before Project ingest', async (t) => {
  for (const scenario of ['unavailable', 'version-mismatch']) {
    await t.test(scenario, (subtest) => {
      const fx = fixture(subtest);
      const result = runMaterial(fx, commandArgs(fx.project), { scenario });
      assert.notEqual(result.status, 0);
      assert.equal(typedOutput(result).status, 'failed');
      assertNoAsset(fx.project);
      const events = readEvents(fx.log);
      assert.ok(events.some((event) => event.type === 'call' && event.args[0] === 'capabilities'));
      assert.equal(events.some((event) => event.type === 'call' && event.args[0] === 'acquire'), false);
    });
  }
});

test('human_action_required stays typed, actionable, and never becomes completed', (t) => {
  const fx = fixture(t);
  const result = runMaterial(fx, commandArgs(fx.project), { scenario: 'human-action' });
  assert.notEqual(result.status, 0);
  const output = typedOutput(result);
  assert.equal(output.status, 'human_action_required');
  assert.notEqual(output.status, 'completed');
  assert.equal(typeof output.message, 'string');
  assert.match(output.message, /sign.?in|login|MFA|登入|驗證|人工/i);
  assertNoAsset(fx.project);
});
