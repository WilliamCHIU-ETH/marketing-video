'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProjectStore } = require('../server/project-store');
const { createChipKCaptureCliAdapter } = require('../server/chipk-capture-cli-adapter');
const { normalizeMaterialAcquisitionIntent } = require('../server/material-acquisition');
const { prepareJobMaterialAcquisition } = require('../server/material-acquisition-runtime');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function context(t, policy = 'prefer-capture') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let id = 0;
  const projectStore = createProjectStore({
    dataDir: path.join(root, 'data'),
    nowISO: () => '2026-08-21T00:00:00.000Z',
    idFactory: () => `id-${++id}`,
  });
  const project = projectStore.create({ name: 'Capture test', template: 'default', owner: 'test' });
  const jobDirectory = path.join(root, 'data', 'jobs', 'job-1');
  fs.mkdirSync(path.join(jobDirectory, 'input'), { recursive: true });
  const job = {
    id: 'job-1',
    projectId: project.id,
    assetRefs: [],
    materialAcquisition: normalizeMaterialAcquisitionIntent({
      policy,
      operation: 'screenshot',
      mode: 'test',
      route: 'chipk.stock.health-check',
      stock: { id: '2330', name: '台積電' },
    }),
  };
  const saves = [];
  const logs = [];
  return {
    root, projectStore, project, jobDirectory, job, saves, logs,
    options: {
      job,
      jobDirectory,
      projectStore,
      requestIdFactory: () => 'acq-request-1',
      nowISO: () => '2026-08-21T00:00:01.000Z',
      saveJob: (value) => saves.push(JSON.parse(JSON.stringify(value))),
      appendLog: (_value, line) => logs.push(line),
    },
  };
}

function screenshotProvider(onCall = () => {}) {
  return {
    capabilities: async () => ({
      schemaVersion: 1,
      providerId: 'chipk-simulator-capture',
      toolVersion: '1.0.0',
      productionReady: true,
      operations: ['screenshot', 'record'],
    }),
    acquire: async (request) => {
      onCall(request);
      const manifest = Buffer.from(JSON.stringify({ requestId: request.requestId, synthetic: true }));
      fs.writeFileSync(path.join(request.outputDirectory, 'screenshot.png'), PNG);
      fs.writeFileSync(path.join(request.outputDirectory, 'capture-manifest.json'), manifest);
      return {
        contractVersion: 1,
        requestId: request.requestId,
        provider: { id: 'chipk-simulator-capture', toolVersion: '1.0.0' },
        status: 'completed',
        artifacts: [
          {
            role: 'screenshot', kind: 'image', relativePath: 'screenshot.png',
            sha256: hash(PNG), mimeType: 'image/png', media: { width: 1, height: 1 },
          },
          {
            role: 'capture-manifest', kind: 'json', relativePath: 'capture-manifest.json',
            sha256: hash(manifest), mimeType: 'application/json',
          },
        ],
        evidence: { source: 'fake-cli', device: { private: 'not-for-ui' } },
        error: null,
      };
    },
  };
}

test('validated screenshot is ingested and materialized into actual job input', async (t) => {
  const ctx = context(t);
  let request;
  const summary = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: screenshotProvider((value) => { request = value; }),
  });
  assert.equal(summary.status, 'acquired');
  assert.equal(summary.contractVersion, 1);
  assert.equal(summary.providerVersion, '1.0.0');
  assert.equal(summary.artifact.inputName, 'shot1.png');
  assert.ok(ctx.job.assetRefs.includes(summary.artifact.assetRef));
  assert.deepEqual(fs.readFileSync(path.join(ctx.jobDirectory, 'input', 'shot1.png')), PNG);
  const project = ctx.projectStore.get(ctx.project.id);
  assert.equal(project.assets.length, 1);
  assert.equal(project.assets[0].id, summary.artifact.assetRef);
  assert.equal(path.isAbsolute(request.outputDirectory), true);
  assert.ok(request.outputDirectory.includes(path.join('acquisition', request.requestId)));
  const evidenceFile = path.join(ctx.jobDirectory, summary.evidenceFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')),
    { source: 'fake-cli', device: { private: 'not-for-ui' } });
  assert.equal(JSON.stringify(summary).includes('not-for-ui'), false);
});

test('real child-process CLI completes request-file to Project Asset connected flow', async (t) => {
  const ctx = context(t);
  const cli = path.join(ctx.root, 'fake-chipk-capture');
  const source = `#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') === 'capabilities --json') {
  process.stdout.write(JSON.stringify({schemaVersion:1,providerId:'chipk-simulator-capture',toolVersion:'1.0.0',productionReady:true,operations:['screenshot','record']}));
  process.exit(0);
}
if (args[0] !== 'acquire' || args[1] !== '--request' || args[3] !== '--json') process.exit(2);
const request = JSON.parse(fs.readFileSync(args[2], 'utf8'));
const png = Buffer.from('${PNG.toString('base64')}', 'base64');
const manifest = Buffer.from(JSON.stringify({requestId:request.requestId,source:'fake-child'}));
fs.writeFileSync(path.join(request.outputDirectory, 'screenshot.png'), png);
fs.writeFileSync(path.join(request.outputDirectory, 'capture-manifest.json'), manifest);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
process.stdout.write(JSON.stringify({
  contractVersion:1,requestId:request.requestId,
  provider:{id:'chipk-simulator-capture',toolVersion:'1.0.0'},status:'completed',
  artifacts:[
    {role:'screenshot',kind:'image',relativePath:'screenshot.png',sha256:sha(png),mimeType:'image/png',media:{width:1,height:1}},
    {role:'capture-manifest',kind:'json',relativePath:'capture-manifest.json',sha256:sha(manifest),mimeType:'application/json'}
  ],evidence:{source:'fake-child'},error:null
}));
`;
  fs.writeFileSync(cli, source, { mode: 0o700 });
  const summary = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: createChipKCaptureCliAdapter({ command: cli }),
  });
  assert.equal(summary.status, 'acquired');
  assert.equal(summary.artifact.inputName, 'shot1.png');
  assert.ok(ctx.projectStore.get(ctx.project.id).assets
    .some((asset) => asset.id === summary.artifact.assetRef));
  assert.deepEqual(fs.readFileSync(path.join(ctx.jobDirectory, 'input', 'shot1.png')), PNG);
});

test('materialization selects a new safe shot name', async (t) => {
  const ctx = context(t);
  fs.writeFileSync(path.join(ctx.jobDirectory, 'input', 'shot1.png'), PNG);
  const summary = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: screenshotProvider(),
  });
  assert.equal(summary.artifact.inputName, 'shot2.png');
  assert.ok(fs.existsSync(path.join(ctx.jobDirectory, 'input', 'shot2.png')));
});

test('disable policy performs zero probe and persists skipped provenance', async (t) => {
  const ctx = context(t, 'disable-capture');
  let calls = 0;
  const summary = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: {
      capabilities: async () => { calls += 1; },
      acquire: async () => { calls += 1; },
    },
  });
  assert.equal(calls, 0);
  assert.equal(summary.status, 'skipped');
  assert.equal(ctx.saves.at(-1).materialAcquisitionResult.evidenceLevel, 'none');
  assert.equal(fs.existsSync(path.join(ctx.jobDirectory, 'acquisition')), false);
});

test('prefer persists limitation and continues when provider is absent', async (t) => {
  const ctx = context(t);
  const error = Object.assign(new Error('missing'), { code: 'provider_unavailable' });
  const summary = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: { capabilities: async () => { throw error; } },
  });
  assert.equal(summary.status, 'fallback');
  assert.equal(summary.reason, 'provider_unavailable');
  assert.equal(summary.evidenceLevel, 'illustrative_not_fresh_capture');
  assert.ok(ctx.logs.some((line) => line.includes('illustrative limitation')));
});

test('prefer also falls back when post-validation evidence persistence conflicts', async (t) => {
  const ctx = context(t);
  const summary = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: screenshotProvider((request) => {
      fs.writeFileSync(path.join(
        path.dirname(request.outputDirectory), `${request.requestId}.provider-evidence.json`), '{}');
    }),
  });
  assert.equal(summary.status, 'fallback');
  assert.equal(summary.reason, 'materialization_failed');
  assert.equal(summary.evidenceLevel, 'illustrative_not_fresh_capture');
  assert.equal(ctx.projectStore.get(ctx.project.id).assets.length, 0);
});

test('require persists failure and throws before pipeline work', async (t) => {
  const ctx = context(t, 'require-capture');
  const error = Object.assign(new Error('missing'), { code: 'provider_unavailable' });
  await assert.rejects(
    () => prepareJobMaterialAcquisition({
      ...ctx.options,
      provider: { capabilities: async () => { throw error; } },
    }),
    (value) => value.code === 'provider_unavailable',
  );
  assert.equal(ctx.saves.at(-1).materialAcquisitionResult.status, 'failed');
  assert.equal(ctx.saves.at(-1).materialAcquisitionResult.reason, 'provider_unavailable');
});

test('job without intent remains a provider-free no-op', async (t) => {
  const ctx = context(t);
  delete ctx.job.materialAcquisition;
  let calls = 0;
  const result = await prepareJobMaterialAcquisition({
    ...ctx.options,
    provider: { capabilities: async () => { calls += 1; } },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(ctx.jobDirectory, 'acquisition')), false);
});
