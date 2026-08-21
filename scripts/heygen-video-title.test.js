'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  authorizeHeyGenPreviewPlan,
  buildAudioDrivenPayload,
  buildTextDrivenV2Payload,
  buildTextDrivenV3Payload,
  createHeyGenRequestPreview,
  createHeyGenRequestTracer,
  createHeyGenPreviewPlan,
  loadProviderSecrets,
  normalizeExperimentId,
  resolveHeyGenVideoTitle,
  runVerifiedPaidStep,
  snapshotHeyGenTraceEnvironment,
  submitTracedHeyGenCreate,
} = require('./heygen-video-title');

const TOKEN = '123e4567-e89b-42d3-a456-426614174000';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function managedFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const runId = options.runId || 'run-20260820-120000-abcd';
  const projectId = options.projectId || 'project-20260820-110000-wxyz';
  const revisionId = options.revisionId || 'v002';
  const jobDir = path.join(dataDir, 'jobs', runId);
  const projectDir = path.join(dataDir, 'projects', projectId);
  writeJson(path.join(jobDir, 'job.json'), {
    id: options.jobId || runId,
    projectId,
    revisionId,
    revisionNumber: 2,
    workspaceRunToken: options.token || TOKEN,
    status: options.jobStatus || 'preparing',
    workspaceRunStatus: options.workspaceRunStatus || 'preparing',
  });
  writeJson(path.join(projectDir, 'project.json'), { id: projectId });
  writeJson(path.join(projectDir, 'revisions', `${revisionId}.json`), {
    id: revisionId,
    number: 2,
    projectId,
    jobId: options.revisionJobId || runId,
    runId: options.revisionRunId || runId,
    status: options.revisionStatus || 'preparing',
  });
  return { root, dataDir, runId, projectId, revisionId, jobDir };
}

function fixedClock() {
  const values = [
    '2026-08-20T12:00:00.000Z',
    '2026-08-20T12:00:00.100Z',
    '2026-08-20T12:00:00.200Z',
    '2026-08-20T12:00:00.300Z',
    '2026-08-20T12:00:00.400Z',
    '2026-08-20T12:00:00.500Z',
    '2026-08-20T12:00:00.600Z',
    '2026-08-20T12:00:00.700Z',
  ];
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

function hookedFs(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function assertProjectLedgerPath(ledgerPath, dataDir) {
  const dataRoot = fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : path.resolve(dataDir);
  assert.equal(path.dirname(ledgerPath), path.join(dataRoot, 'provider-ledgers'));
  assert.match(path.basename(ledgerPath), /^project-[0-9a-f]{64}\.json$/);
}

function approvePreviewRequests(tracer, requests) {
  const previews = requests.map((request) => tracer.preview(request));
  const plan = createHeyGenPreviewPlan(previews);
  return tracer.approvePreview({
    requests: previews,
    providedApprovalId: tracer.context.source === 'workspace-run-token'
      ? null
      : plan.approvalId,
  });
}

test('trace env 在 dotenv 前快照，provider .env 只能補 secrets 且不改寫 identity', () => {
  const providerKeys = new Set(['HEYGEN_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID']);
  const inheritedEnvironment = new Proxy({
    DATA_DIR: '/safe/runtime-data',
    HEYGEN_EXPERIMENT_ID: 'EXP-042',
    HEYGEN_REVISION: 'V3',
    HEYGEN_VIDEO_TITLE: 'inherited-title',
  }, {
    get(target, property, receiver) {
      if (providerKeys.has(property)) throw new Error(`trace snapshot read provider key: ${property}`);
      return Reflect.get(target, property, receiver);
    },
  });
  const traceEnvironment = snapshotHeyGenTraceEnvironment(inheritedEnvironment);
  assert.deepEqual(traceEnvironment, {
    DATA_DIR: '/safe/runtime-data',
    HEYGEN_REVISION: 'V3',
    HEYGEN_EXPERIMENT_ID: 'EXP-042',
    HEYGEN_VIDEO_TITLE: 'inherited-title',
  });
  assert.equal(Object.isFrozen(traceEnvironment), true);

  const paidEnvironment = {
    HEYGEN_API_KEY: 'test-shell-heygen-key',
    MINIMAX_API_KEY: '',
    HEYGEN_EXPERIMENT_ID: 'EXP-042',
  };
  const originalPaidEnvironment = { ...paidEnvironment };
  let isolatedEnvironment;
  const providerSecrets = loadProviderSecrets({
    env: paidEnvironment,
    dotenv: {
      config(options) {
        isolatedEnvironment = options.processEnv;
        assert.notEqual(isolatedEnvironment, paidEnvironment);
        assert.equal(options.quiet, true);
        Object.assign(isolatedEnvironment, {
          HEYGEN_API_KEY: 'test-file-heygen-key',
          MINIMAX_API_KEY: 'test-file-minimax-key',
          MINIMAX_GROUP_ID: 'test-file-minimax-group',
          HEYGEN_EXPERIMENT_ID: 'EXP-999',
          HEYGEN_VIDEO_TITLE: 'hostile-dotenv-title',
          DATA_DIR: '/hostile/runtime-data',
        });
        return { parsed: isolatedEnvironment };
      },
    },
  });
  assert.deepEqual(providerSecrets, {
    HEYGEN_API_KEY: 'test-shell-heygen-key',
    MINIMAX_API_KEY: '',
    MINIMAX_GROUP_ID: 'test-file-minimax-group',
  });
  assert.equal(Object.isFrozen(providerSecrets), true);
  assert.deepEqual(paidEnvironment, originalPaidEnvironment);
  assert.deepEqual(traceEnvironment, {
    DATA_DIR: '/safe/runtime-data',
    HEYGEN_REVISION: 'V3',
    HEYGEN_EXPERIMENT_ID: 'EXP-042',
    HEYGEN_VIDEO_TITLE: 'inherited-title',
  });
});

test('managed WORKSPACE_RUN_TOKEN 唯一解析 Project/Revision/Run 並使用 canonical ledger', (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => 'request-1',
    pid: 42,
  });

  assert.deepEqual(tracer.context, {
    kind: 'project',
    source: 'workspace-run-token',
    projectId: fixture.projectId,
    revisionId: fixture.revisionId,
    revisionNumber: 2,
    runId: fixture.runId,
  });
  const manualPreview = createHeyGenRequestPreview({
    projectDir: fixture.root,
    argv: [
      `--project-id=${fixture.projectId}`,
      '--revision=V2',
      `--run-id=${fixture.runId}`,
    ],
    env: { DATA_DIR: fixture.dataDir },
  });
  assert.equal(tracer.ledgerPath, manualPreview.ledgerPath);
  assertProjectLedgerPath(tracer.ledgerPath, fixture.dataDir);
  assert.equal(
    tracer.titleFor('ignored'),
    `MV-${fixture.projectId}-V2-${fixture.runId}`,
  );
  assert.equal(fs.statSync(tracer.ledgerPath).mode & 0o777, 0o400);
});

test('managed dry-run 只讀取 identity，既有 ledger bytes/mtime 不變且不建立 lock', (t) => {
  const fixture = managedFixture(t);
  const ledgerPath = createHeyGenRequestPreview({
    projectDir: fixture.root,
    argv: [
      `--project-id=${fixture.projectId}`,
      '--revision=V2',
      `--run-id=${fixture.runId}`,
    ],
    env: { DATA_DIR: fixture.dataDir },
  }).ledgerPath;
  const ledgerBytes = Buffer.from('{"existing":"operator evidence"}\n');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, ledgerBytes);
  const fixedMtime = new Date('2026-08-20T02:03:04.000Z');
  fs.utimesSync(ledgerPath, fixedMtime, fixedMtime);
  const mtimeBefore = fs.statSync(ledgerPath, { bigint: true }).mtimeNs;

  const planner = createHeyGenRequestPreview({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
  });
  const title = planner.titleFor('ignored');
  const preview = planner.preview({
    api: 'v3-text',
    title,
    payloadMetadata: { mode: 'text-driven', scriptCharacters: 10 },
  });

  assert.equal(preview.endpoint, 'https://api.heygen.com/v3/videos');
  assert.equal(planner.ledgerPath, fs.realpathSync(ledgerPath));
  assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBytes);
  assert.equal(fs.statSync(ledgerPath, { bigint: true }).mtimeNs, mtimeBefore);
  assert.equal(
    fs.existsSync(path.join(path.dirname(ledgerPath), `.${path.basename(ledgerPath)}.lock`)),
    false,
  );
});

test('managed trace 對 directory/job/revision identity mismatch 全部 fail closed', (t) => {
  const badJob = managedFixture(t, { jobId: 'another-run' });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: badJob.root,
      env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: badJob.dataDir },
    }),
    /Run directory、job\.id 與 runId 不一致/,
  );

  const badRevision = managedFixture(t, {
    token: '223e4567-e89b-42d3-a456-426614174000',
    revisionRunId: 'another-run',
  });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: badRevision.root,
      env: {
        WORKSPACE_RUN_TOKEN: '223e4567-e89b-42d3-a456-426614174000',
        DATA_DIR: badRevision.dataDir,
      },
    }),
    /Revision 與 Run identity 不一致/,
  );

  const badNumber = managedFixture(t, {
    token: '323e4567-e89b-42d3-a456-426614174000',
    revisionId: 'v009',
  });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: badNumber.root,
      env: {
        WORKSPACE_RUN_TOKEN: '323e4567-e89b-42d3-a456-426614174000',
        DATA_DIR: badNumber.dataDir,
      },
    }),
    /Revision ID 與 revision number 不一致/,
  );
});

test('managed token 只能用於當前 preparing 的 job/workspace run/revision', (t) => {
  const completedJob = managedFixture(t, { jobStatus: 'done' });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: completedJob.root,
      env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: completedJob.dataDir },
    }),
    /只能用於正在 preparing 的 Run/,
  );

  const staleWorkspace = managedFixture(t, {
    token: '223e4567-e89b-42d3-a456-426614174000',
    workspaceRunStatus: 'done',
  });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: staleWorkspace.root,
      env: {
        WORKSPACE_RUN_TOKEN: '223e4567-e89b-42d3-a456-426614174000',
        DATA_DIR: staleWorkspace.dataDir,
      },
    }),
    /只能用於正在 preparing 的 Run/,
  );

  const completedRevision = managedFixture(t, {
    token: '323e4567-e89b-42d3-a456-426614174000',
    revisionStatus: 'done',
  });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: completedRevision.root,
      env: {
        WORKSPACE_RUN_TOKEN: '323e4567-e89b-42d3-a456-426614174000',
        DATA_DIR: completedRevision.dataDir,
      },
    }),
    /Revision 不是 preparing/,
  );
});

test('重複 token 或不合法 token 在任何 request 前拒絕', (t) => {
  const fixture = managedFixture(t);
  const second = path.join(fixture.dataDir, 'jobs', 'run-duplicate');
  writeJson(path.join(second, 'job.json'), {
    id: 'run-duplicate',
    projectId: fixture.projectId,
    revisionId: fixture.revisionId,
    workspaceRunToken: TOKEN,
  });
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: fixture.root,
      env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    }),
    /目前找到 2 個/,
  );
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: fixture.root,
      env: { WORKSPACE_RUN_TOKEN: 'not-a-token', DATA_DIR: fixture.dataDir },
    }),
    /WORKSPACE_RUN_TOKEN 不合法/,
  );
});

test('job.json symlink 即使指回 runtime root 仍拒絕', (t) => {
  const fixture = managedFixture(t);
  const target = path.join(fixture.jobDir, 'actual-job.json');
  fs.renameSync(path.join(fixture.jobDir, 'job.json'), target);
  fs.symlinkSync(target, path.join(fixture.jobDir, 'job.json'));
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: fixture.root,
      env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    }),
    /job\.json 不是安全的一般檔案/,
  );
});

test('jobs/project directory 或 ledger symlink 都不作為 trace root', (t) => {
  const jobsFixture = managedFixture(t);
  const jobsReal = path.join(jobsFixture.dataDir, 'jobs-real');
  fs.renameSync(path.join(jobsFixture.dataDir, 'jobs'), jobsReal);
  fs.symlinkSync(jobsReal, path.join(jobsFixture.dataDir, 'jobs'));
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: jobsFixture.root,
      env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: jobsFixture.dataDir },
    }),
    /jobs runtime directory 不是安全的一般目錄/,
  );

  const ledgerFixture = managedFixture(t, {
    token: '423e4567-e89b-42d3-a456-426614174000',
  });
  const ledgerPreview = createHeyGenRequestPreview({
    projectDir: ledgerFixture.root,
    env: {
      WORKSPACE_RUN_TOKEN: '423e4567-e89b-42d3-a456-426614174000',
      DATA_DIR: ledgerFixture.dataDir,
    },
  });
  const ledgerTarget = path.join(path.dirname(ledgerPreview.ledgerPath), 'ledger-target.json');
  writeJson(ledgerTarget, {});
  fs.symlinkSync(ledgerTarget, ledgerPreview.ledgerPath);
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: ledgerFixture.root,
      env: {
        WORKSPACE_RUN_TOKEN: '423e4567-e89b-42d3-a456-426614174000',
        DATA_DIR: ledgerFixture.dataDir,
      },
    }),
    /provider ledger 不是安全的一般檔案/,
  );
});

test('managed/manual DATA_DIR 與 manual provider-ledgers symlink 全部 fail closed', (t) => {
  const managed = managedFixture(t);
  const managedTarget = path.join(managed.root, 'managed-data-real');
  fs.renameSync(managed.dataDir, managedTarget);
  fs.symlinkSync(managedTarget, managed.dataDir);
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: managed.root,
      env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: managed.dataDir },
    }),
    /DATA_DIR 不是安全的一般目錄/,
  );

  const manualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-manual-symlink-'));
  t.after(() => fs.rmSync(manualRoot, { recursive: true, force: true }));
  const manualTarget = path.join(manualRoot, 'manual-data-real');
  fs.mkdirSync(manualTarget);
  const manualData = path.join(manualRoot, 'manual-data');
  fs.symlinkSync(manualTarget, manualData);
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: manualRoot,
      argv: ['--project-id=project-a', '--revision=V1', '--run-id=run-a'],
      env: { DATA_DIR: manualData },
    }),
    /DATA_DIR 不是安全的一般目錄/,
  );

  const ledgerData = path.join(manualRoot, 'ledger-data');
  const ledgerTarget = path.join(manualRoot, 'ledger-real');
  fs.mkdirSync(ledgerData);
  fs.mkdirSync(ledgerTarget);
  fs.symlinkSync(ledgerTarget, path.join(ledgerData, 'provider-ledgers'));
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: manualRoot,
      argv: ['--project-id=project-a', '--revision=V1', '--run-id=run-a'],
      env: { DATA_DIR: ledgerData },
    }),
    /provider-ledgers 不是安全的一般目錄/,
  );
});

test('manual 缺失 DATA_DIR 的任一既存上層為 symlink 時在 mkdir 前 fail closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-manual-ancestor-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-manual-ancestor-outside-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-manual-external-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const linkedParent = path.join(root, 'linked-parent');
  fs.symlinkSync(outside, linkedParent);
  const dataDir = path.join(linkedParent, 'missing-data');
  const options = {
    projectDir: root,
    argv: ['--project-id=project-a', '--revision=V1', '--run-id=run-a'],
    env: { DATA_DIR: dataDir },
  };

  assert.throws(
    () => createHeyGenRequestPreview(options),
    /DATA_DIR 不是安全的一般目錄（路徑包含 symlink）/,
  );
  assert.throws(
    () => createHeyGenRequestTracer(options),
    /DATA_DIR 不是安全的一般目錄（路徑包含 symlink）/,
  );
  assert.equal(fs.existsSync(path.join(outside, 'missing-data')), false);

  const existingOutside = path.join(outside, 'existing');
  fs.mkdirSync(existingOutside);
  fs.symlinkSync(outside, path.join(external, 'linked-parent'));
  const externalDataDir = path.join(external, 'linked-parent', 'existing', 'missing-data');
  assert.throws(
    () => createHeyGenRequestTracer({
      ...options,
      env: { DATA_DIR: externalDataDir },
    }),
    /DATA_DIR 不是安全的一般目錄（路徑包含 symlink）/,
  );
  assert.equal(fs.existsSync(path.join(existingOutside, 'missing-data')), false);
});

test('DATA_DIR 在驗證後、provider-ledgers mkdir 前被置換時不在外部建立 ledger', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-data-dir-race-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-data-dir-race-outside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const movedDataDir = path.join(root, 'data-canonical-moved');
  fs.mkdirSync(dataDir);
  const options = {
    projectDir: root,
    argv: ['--project-id=project-race', '--revision=V1', '--run-id=run-race'],
    env: { DATA_DIR: dataDir },
  };
  const preview = createHeyGenRequestPreview(options);
  const providerRoot = path.join(fs.realpathSync(dataDir), 'provider-ledgers');
  let swapped = false;
  const fsImpl = hookedFs({
    mkdirSync(target, mkdirOptions) {
      if (!swapped && path.resolve(target) === providerRoot) {
        fs.renameSync(dataDir, movedDataDir);
        fs.symlinkSync(outside, dataDir);
        swapped = true;
      }
      return fs.mkdirSync(target, mkdirOptions);
    },
  });

  assert.throws(
    () => createHeyGenRequestTracer({ ...options, fsImpl }),
    /DATA_DIR (?:不是安全的一般目錄|filesystem identity 已改變)/,
  );
  assert.equal(swapped, true);
  const outsideProviderRoot = path.join(outside, 'provider-ledgers');
  assert.equal(fs.statSync(outsideProviderRoot).isDirectory(), true);
  assert.equal(
    fs.existsSync(path.join(outsideProviderRoot, path.basename(preview.ledgerPath))),
    false,
  );
  assert.deepEqual(fs.readdirSync(outsideProviderRoot), []);
});

test('tracer 初始化後 provider-ledgers 被置換時在 callback/fetch 前 fail closed', async (t) => {
  const fixture = managedFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-ledger-root-race-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  let armed = false;
  let swapped = false;
  let providerRoot = null;
  let movedProviderRoot = null;
  const fsImpl = hookedFs({
    lstatSync(target, ...args) {
      const stat = fs.lstatSync(target, ...args);
      if (armed && !swapped && path.resolve(target) === path.resolve(fixture.dataDir)) {
        fs.renameSync(providerRoot, movedProviderRoot);
        fs.symlinkSync(outside, providerRoot);
        swapped = true;
      }
      return stat;
    },
  });
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    fsImpl,
    randomUUID: () => 'must-not-be-reserved',
    pid: 205,
  });
  providerRoot = path.dirname(tracer.ledgerPath);
  movedProviderRoot = path.join(fixture.dataDir, 'provider-ledgers-canonical-moved');
  const canonicalLedgerName = path.basename(tracer.ledgerPath);
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: tracer.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  armed = true;
  let fetchCalls = 0;
  let onPreparedCalls = 0;

  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v3/videos',
      api: 'v3-text',
      payload,
      onPrepared: () => { onPreparedCalls += 1; },
    }),
    /provider ledger root 不是安全的一般目錄/,
  );
  assert.equal(swapped, true);
  assert.equal(fetchCalls, 0);
  assert.equal(onPreparedCalls, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
  const canonicalLedger = JSON.parse(
    fs.readFileSync(path.join(movedProviderRoot, canonicalLedgerName), 'utf8'),
  );
  assert.deepEqual(canonicalLedger.requests, []);
});

test('explicit Project identity 必須完整，無 identity 或混用 identity 都 fail closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-manual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: root,
      argv: ['--project-id=project-a', '--revision=V1'],
      env: {},
    }),
    /必須同時提供/,
  );

  const explicit = createHeyGenRequestTracer({
    projectDir: root,
    argv: ['--project-id=project-a', '--revision=v3', '--run-id=run-b'],
    env: { DATA_DIR: path.join(root, 'data-explicit') },
    now: fixedClock(),
    pid: 50,
  });
  assert.equal(explicit.titleFor('ignored'), 'MV-project-a-V3-run-b');
  assert.equal(fs.statSync(path.join(root, 'data-explicit')).isDirectory(), true);
  assert.equal(fs.statSync(explicit.ledgerPath).isFile(), true);
  const requestId = explicit.prepare({ api: 'v3-text', title: explicit.titleFor('ignored') });
  assert.equal(explicit.snapshot().requests[0].requestId, requestId);

  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: root,
      argv: [],
      env: { DATA_DIR: path.join(root, 'data-no-identity') },
    }),
    /必須提供 project-id\/revision\/run-id 或 experiment\/revision identity/,
  );
  assert.throws(
    () => createHeyGenRequestTracer({
      projectDir: root,
      argv: ['--experiment=EXP-1', '--revision=V1', '--run-id=run-b'],
      env: { DATA_DIR: path.join(root, 'data-mixed') },
    }),
    /identity 不可混用/,
  );
});

test('run.js --dry-run --minimax 無 identity 時在 key、script、MiniMax/provider 前停止', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-no-identity-cli-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['run.js', '--dry-run', '--minimax'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: path.join(dataDir, 'must-not-be-created'),
      HEYGEN_API_KEY: '',
      MINIMAX_API_KEY: '',
      MINIMAX_GROUP_ID: '',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必須提供 project-id\/revision\/run-id 或 experiment\/revision identity/);
  assert.doesNotMatch(result.stderr, /缺少 HEYGEN_API_KEY|缺少 MINIMAX_API_KEY|找不到 public\/script\.txt/);
  assert.equal(fs.existsSync(path.join(dataDir, 'must-not-be-created')), false);
});

test('run.js --dry-run 輸出 exact preview、零 outbound 且不留 prepared reservation', (t) => {
  const repoRoot = path.join(__dirname, '..');
  const scriptPath = path.join(repoRoot, 'public', 'script.txt');
  const hadScript = fs.existsSync(scriptPath);
  const originalScript = hadScript ? fs.readFileSync(scriptPath) : null;
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '這是 provider-free dry-run 測試腳本。\n');
  t.after(() => {
    if (hadScript) fs.writeFileSync(scriptPath, originalScript);
    else fs.rmSync(scriptPath, { force: true });
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-dry-run-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const guardLog = path.join(root, 'outbound.log');
  const guardModule = path.join(root, 'guard.cjs');
  fs.writeFileSync(guardModule, [
    "const fs = require('node:fs');",
    "const childProcess = require('node:child_process');",
    "const guardLog = process.env.HEYGEN_TEST_GUARD_LOG;",
    "const blocked = (kind) => {",
    "  fs.appendFileSync(guardLog, kind + '\\n');",
    "  throw new Error(kind + ' blocked by dry-run test');",
    '};',
    "for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {",
    "  childProcess[name] = () => blocked('child_process:' + name);",
    '}',
    "const originalEnv = process.env;",
    "const providerKeys = new Set(['HEYGEN_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID']);",
    'process.env = new Proxy(originalEnv, {',
    '  get(target, property, receiver) {',
    "    if (providerKeys.has(property)) return blocked('provider_env:' + property);",
    '    return Reflect.get(target, property, receiver);',
    '  },',
    '});',
    "const Module = require('node:module');",
    'const originalLoad = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    "  if (request === 'dotenv') return blocked('dotenv');",
    '  return originalLoad.call(this, request, parent, isMain);',
    '};',
    "global.fetch = async () => blocked('fetch');",
  ].join('\n'));
  const ownerPath = path.join(repoRoot, '.run.owner.json');
  const ownerBefore = fs.existsSync(ownerPath) ? fs.readFileSync(ownerPath) : null;
  const dataDir = path.join(root, 'data');
  const childEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    HEYGEN_API_KEY: 'test-must-not-be-read',
    MINIMAX_API_KEY: 'test-must-not-be-read',
    MINIMAX_GROUP_ID: 'test-must-not-be-read',
    HEYGEN_TEST_GUARD_LOG: guardLog,
    NODE_OPTIONS: `--require=${guardModule}`,
  };
  const result = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--project-id=project-dry',
    '--revision=V1',
    '--run-id=run-dry',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: childEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(preview.dryRun, true);
  assert.match(preview.approvalId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.requestCount, 1);
  assert.equal(preview.requests[0].api, 'v3-text');
  assert.equal(preview.requests[0].endpoint, 'https://api.heygen.com/v3/videos');
  assert.equal(preview.requests[0].title, 'MV-project-dry-V1-run-dry');
  assert.equal(preview.requests[0].payloadMetadata.mode, 'text-driven');
  assert.match(preview.requests[0].previewDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(preview.requests[0].payloadMetadata.scriptSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(preview.requests[0].payloadMetadata, 'scriptText'), false);
  assertProjectLedgerPath(preview.ledgerPath, dataDir);
  assert.equal(fs.existsSync(preview.ledgerPath), false);
  assert.equal(fs.existsSync(dataDir), false);

  const missingApproval = spawnSync(process.execPath, [
    'run.js',
    '--project-id=project-dry',
    '--revision=V1',
    '--run-id=run-dry',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(missingApproval.status, 1);
  assert.match(missingApproval.stderr, /缺少 matching dry-run approval/);
  assert.doesNotMatch(missingApproval.stderr, /sha256:[0-9a-f]{64}/);
  assert.equal(fs.existsSync(guardLog), false);
  assert.equal(fs.existsSync(dataDir), false);

  const audioResult = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--minimax',
    '--project-id=project-dry',
    '--revision=V1',
    '--run-id=run-dry',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(audioResult.status, 0, audioResult.stderr);
  const audioPreview = JSON.parse(audioResult.stdout.slice(audioResult.stdout.indexOf('{')));
  assert.equal(audioPreview.requests[0].api, 'v2-audio');
  assert.equal(audioPreview.requests[0].endpoint, 'https://api.heygen.com/v2/videos');
  assert.equal(fs.existsSync(audioPreview.ledgerPath), false);
  assert.equal(fs.existsSync(dataDir), false);

  const v2Result = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--heygen-v2',
    '--project-id=project-dry',
    '--revision=V1',
    '--run-id=run-dry',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(v2Result.status, 0, v2Result.stderr);
  const v2Preview = JSON.parse(v2Result.stdout.slice(v2Result.stdout.indexOf('{')));
  assert.equal(v2Preview.requests[0].api, 'v2-text');
  assert.equal(v2Preview.requests[0].endpoint, 'https://api.heygen.com/v2/videos');
  assert.equal(fs.existsSync(v2Preview.ledgerPath), false);
  assert.equal(fs.existsSync(dataDir), false);

  fs.writeFileSync(scriptPath, '[A] 第一段\n[B] 第二段\n');
  const dualResult = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--experiment=EXP-100',
    '--revision=V1',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(dualResult.status, 0, dualResult.stderr);
  const dualPreview = JSON.parse(dualResult.stdout.slice(dualResult.stdout.indexOf('{')));
  assert.equal(dualPreview.requestCount, 2);
  assert.deepEqual(dualPreview.requests.map((item) => item.segment), [
    { index: 0, total: 2, role: 'A' },
    { index: 1, total: 2, role: 'B' },
  ]);
  assert.deepEqual(dualPreview.requests.map((item) => item.title), [
    '測試用EXP-100-V1',
    '測試用EXP-100-V1',
  ]);
  assert.equal(new Set(dualPreview.requests.map((item) => item.logicalKey)).size, 2);
  assert.equal(fs.existsSync(dualPreview.ledgerPath), false);
  assert.equal(fs.existsSync(dataDir), false);

  const dualAudioResult = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--minimax',
    '--experiment=EXP-101',
    '--revision=V1',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(dualAudioResult.status, 0, dualAudioResult.stderr);
  const dualAudioPreview = JSON.parse(
    dualAudioResult.stdout.slice(dualAudioResult.stdout.indexOf('{')),
  );
  assert.equal(dualAudioPreview.requestCount, 2);
  assert.deepEqual(dualAudioPreview.requests.map((item) => item.api), ['v2-audio', 'v2-audio']);
  assert.deepEqual(
    dualAudioPreview.requests.map((item) => item.endpoint),
    ['https://api.heygen.com/v2/videos', 'https://api.heygen.com/v2/videos'],
  );
  assert.equal(fs.existsSync(dualAudioPreview.ledgerPath), false);
  assert.equal(fs.existsSync(dataDir), false);

  fs.writeFileSync(scriptPath, '固定主播 dry-run 測試。\n');
  for (const template of ['dapan', 'institution', 'focusstock']) {
    const fixedResult = spawnSync(process.execPath, [
      'run.js',
      '--dry-run',
      `--template=${template}`,
      '--project-id=project-dry',
      '--revision=V1',
      `--run-id=run-${template}`,
    ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
    assert.equal(fixedResult.status, 0, `${template}: ${fixedResult.stderr}`);
    const fixedPreview = JSON.parse(fixedResult.stdout.slice(fixedResult.stdout.indexOf('{')));
    assert.equal(fixedPreview.requestCount, 1);
    assert.equal(fixedPreview.requests[0].api, 'v3-text');
    assert.equal(fixedPreview.requests[0].endpoint, 'https://api.heygen.com/v3/videos');
    assert.equal(fs.existsSync(fixedPreview.ledgerPath), false);
    assert.equal(fs.existsSync(dataDir), false);
  }

  const fixedV2Result = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--heygen-v2',
    '--template=dapan',
    '--project-id=project-dry',
    '--revision=V1',
    '--run-id=run-dapan-v2',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(fixedV2Result.status, 0, fixedV2Result.stderr);
  const fixedV2Preview = JSON.parse(fixedV2Result.stdout.slice(fixedV2Result.stdout.indexOf('{')));
  assert.equal(fixedV2Preview.requests[0].api, 'v2-text');
  assert.equal(fixedV2Preview.requests[0].endpoint, 'https://api.heygen.com/v2/videos');
  assert.equal(fs.existsSync(fixedV2Preview.ledgerPath), false);
  assert.equal(fs.existsSync(dataDir), false);

  const existingLedger = createHeyGenRequestPreview({
    projectDir: repoRoot,
    argv: ['--project-id=project-dry', '--revision=V1', '--run-id=run-existing'],
    env: { DATA_DIR: dataDir },
  }).ledgerPath;
  const existingBytes = Buffer.from('{"historical":"must remain byte-identical"}\n');
  fs.mkdirSync(path.dirname(existingLedger), { recursive: true });
  fs.writeFileSync(existingLedger, existingBytes);
  const fixedMtime = new Date('2026-08-20T01:02:03.000Z');
  fs.utimesSync(existingLedger, fixedMtime, fixedMtime);
  const mtimeBefore = fs.statSync(existingLedger, { bigint: true }).mtimeNs;
  const existingResult = spawnSync(process.execPath, [
    'run.js',
    '--dry-run',
    '--project-id=project-dry',
    '--revision=V1',
    '--run-id=run-existing',
  ], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  assert.equal(existingResult.status, 0, existingResult.stderr);
  const existingPreview = JSON.parse(existingResult.stdout.slice(existingResult.stdout.indexOf('{')));
  assert.equal(existingPreview.ledgerPath, fs.realpathSync(existingLedger));
  assert.deepEqual(fs.readFileSync(existingLedger), existingBytes);
  assert.equal(fs.statSync(existingLedger, { bigint: true }).mtimeNs, mtimeBefore);
  assert.deepEqual(
    fs.readdirSync(path.dirname(existingLedger)).filter((name) => name.endsWith('.lock')),
    [],
  );

  assert.equal(fs.existsSync(guardLog), false);
  assert.equal(fs.existsSync(path.join(repoRoot, '.run.lock')), false);
  const ownerAfter = fs.existsSync(ownerPath) ? fs.readFileSync(ownerPath) : null;
  assert.deepEqual(ownerAfter, ownerBefore);
});

test('EXP title 保持 canonical，並由 trace segment 區分多人 request', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-exp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracer = createHeyGenRequestTracer({
    projectDir: root,
    argv: [
      '--experiment=experience-1',
      '--revision=v2',
    ],
    env: { DATA_DIR: path.join(root, 'data') },
    now: fixedClock(),
    pid: 52,
  });
  assert.equal(normalizeExperimentId('exp-7'), 'EXP-007');
  assert.equal(tracer.context.runId, 'experiment-exp-001-v2');
  assert.equal(path.basename(tracer.ledgerPath), 'experiment-exp-001-v2.json');
  assert.equal(tracer.titleFor('ignored'), '測試用EXP-001-V2');
  assert.equal(
    tracer.titleFor('ignored', { index: 0, total: 2, role: 'A' }),
    '測試用EXP-001-V2',
  );
  assert.equal(
    tracer.titleFor('ignored', { index: 1, total: 2, role: 'B' }),
    '測試用EXP-001-V2',
  );
  const first = tracer.preview({
    api: 'v3-text',
    title: tracer.titleFor('ignored', { index: 0, total: 2, role: 'A' }),
    segment: { index: 0, total: 2, role: 'A' },
  });
  const second = tracer.preview({
    api: 'v3-text',
    title: tracer.titleFor('ignored', { index: 1, total: 2, role: 'B' }),
    segment: { index: 1, total: 2, role: 'B' },
  });
  assert.notEqual(first.logicalKey, second.logicalKey);
});

test('EXP/Revision 固定 canonical title，拒絕自訂 prefix 並跨程序阻擋重送', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-exp-dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    projectDir: root,
    argv: ['--experiment=EXP-9', '--revision=V3'],
    env: { DATA_DIR: path.join(root, 'data') },
  };
  const first = createHeyGenRequestTracer({
    ...options,
    now: fixedClock(),
    randomUUID: () => 'request-exp-first',
    pid: 100,
  });
  const second = createHeyGenRequestTracer({
    ...options,
    now: fixedClock(),
    randomUUID: () => 'request-exp-second',
    pid: 200,
  });
  assert.equal(first.ledgerPath, second.ledgerPath);
  const title = first.titleFor('ignored');
  assert.equal(title, '測試用EXP-009-V3');
  assert.equal(second.titleFor('ignored'), title);
  first.prepare({ api: 'v3-text', title });
  assert.throws(
    () => second.prepare({ api: 'v3-text', title }),
    /logical request 已有 ledger 紀錄（prepared），拒絕自動重送/,
  );
  assert.throws(
    () => createHeyGenRequestTracer({
      ...options,
      argv: [...options.argv, '--heygen-title=renamed-dashboard-prefix'],
    }).titleFor('ignored'),
    /EXP context.*不支援自訂 heygen-title prefix/,
  );
  assert.throws(
    () => createHeyGenRequestTracer({
      ...options,
      env: { ...options.env, HEYGEN_VIDEO_TITLE: 'renamed-dashboard-prefix' },
    }).titleFor('ignored'),
    /EXP context.*不支援自訂 heygen-title prefix/,
  );
  assert.throws(
    () => createHeyGenRequestTracer({
      ...options,
      argv: [...options.argv, '--experiment-run-id=escape'],
    }),
    /experiment-run-id 會繞過 EXP\/Revision 去重/,
  );
});

test('Project/Revision/Run logical key 不受 --heygen-title prefix 影響', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-project-prefix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const identity = ['--project-id=project-a', '--revision=V4', '--run-id=run-a'];
  const first = createHeyGenRequestTracer({
    projectDir: root,
    argv: [...identity, '--heygen-title=prefix-one'],
    env: { DATA_DIR: dataDir },
    randomUUID: () => 'request-project-prefix-one',
  });
  const second = createHeyGenRequestTracer({
    projectDir: root,
    argv: [...identity, '--heygen-title=prefix-two'],
    env: { DATA_DIR: dataDir },
    randomUUID: () => 'request-project-prefix-two',
  });
  const firstTitle = first.titleFor('ignored');
  const secondTitle = second.titleFor('ignored');
  assert.notEqual(firstTitle, secondTitle);
  first.prepare({ api: 'v2-audio', title: firstTitle });
  assert.throws(
    () => second.prepare({ api: 'v2-audio', title: secondTitle }),
    /logical request 已有 ledger 紀錄（prepared）/,
  );
  assert.equal(second.snapshot().requests.length, 1);
});

test('相同 Revision/Run 在不同 Project 下使用不同 canonical namespace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-project-namespace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const previewFor = (projectId) => createHeyGenRequestPreview({
    projectDir: root,
    argv: [`--project-id=${projectId}`, '--revision=V2', '--run-id=run-shared'],
    env: { DATA_DIR: dataDir },
  });
  const first = previewFor('project-a');
  const second = previewFor('project-b');
  const firstRequest = first.preview({ api: 'v3-text', title: first.titleFor('ignored') });
  const secondRequest = second.preview({ api: 'v3-text', title: second.titleFor('ignored') });

  assert.notEqual(first.ledgerPath, second.ledgerPath);
  assert.notEqual(firstRequest.logicalKey, secondRequest.logicalKey);
  assert.equal(fs.existsSync(dataDir), false);
});

test('managed-first/manual-second 共用 canonical reservation，第二次在 fetch 前拒絕', async (t) => {
  const fixture = managedFixture(t);
  const managed = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'managed-first-reservation',
    pid: 201,
  });
  const managedTitle = managed.titleFor('ignored');
  managed.prepare({ api: 'v3-text', title: managedTitle });

  const manual = createHeyGenRequestTracer({
    projectDir: fixture.root,
    argv: [
      `--project-id=${fixture.projectId}`,
      '--revision=V2',
      `--run-id=${fixture.runId}`,
    ],
    env: { DATA_DIR: fixture.dataDir },
    randomUUID: () => 'manual-second-must-not-reserve',
    pid: 202,
  });
  assert.equal(manual.ledgerPath, managed.ledgerPath);
  assert.deepEqual(manual.snapshot().trace, {
    kind: 'project',
    projectId: fixture.projectId,
    revision: 'V2',
    runId: fixture.runId,
  });

  let fetchCalls = 0;
  let onPreparedCalls = 0;
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: manual.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer: manual,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v3/videos',
      api: 'v3-text',
      payload,
      onPrepared: () => { onPreparedCalls += 1; },
    }),
    /logical request 已有 ledger 紀錄（prepared），拒絕自動重送/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(onPreparedCalls, 0);
  assert.equal(manual.snapshot().requests.length, 1);
});

test('manual-first/managed-second 共用 canonical reservation，第二次在 fetch 前拒絕', async (t) => {
  const fixture = managedFixture(t);
  const manual = createHeyGenRequestTracer({
    projectDir: fixture.root,
    argv: [
      `--project-id=${fixture.projectId}`,
      '--revision=V2',
      `--run-id=${fixture.runId}`,
    ],
    env: { DATA_DIR: fixture.dataDir },
    randomUUID: () => 'manual-first-reservation',
    pid: 203,
  });
  manual.prepare({ api: 'v3-text', title: manual.titleFor('ignored') });

  const managed = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'managed-second-must-not-reserve',
    pid: 204,
  });
  assert.equal(managed.ledgerPath, manual.ledgerPath);

  let fetchCalls = 0;
  let onPreparedCalls = 0;
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: managed.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer: managed,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v3/videos',
      api: 'v3-text',
      payload,
      onPrepared: () => { onPreparedCalls += 1; },
    }),
    /logical request 已有 ledger 紀錄（prepared），拒絕自動重送/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(onPreparedCalls, 0);
  assert.equal(managed.snapshot().requests.length, 1);
});

test('三種 HeyGen create payload 都由同一個 non-empty title gate 建立', () => {
  const common = { title: 'MV-project-a-V1-run-a', motionPrompt: 'move' };
  const audio = buildAudioDrivenPayload({
    ...common,
    audioAssetId: 'audio-id',
    avatarId: 'avatar-id',
  });
  const v2 = buildTextDrivenV2Payload({
    ...common,
    scriptText: 'hello',
    avatarId: 'avatar-id',
    voiceId: 'voice-id',
    expressiveness: 'medium',
  });
  const v3 = buildTextDrivenV3Payload({
    ...common,
    scriptText: 'hello',
    avatarId: 'avatar-id',
    voiceId: 'voice-id',
    expressiveness: 'medium',
  });
  assert.deepEqual(audio, {
    avatar_id: 'avatar-id',
    audio_asset_id: 'audio-id',
    motion_prompt: 'move',
    expressiveness: 'medium',
    aspect_ratio: '9:16',
    resolution: '1080p',
    title: common.title,
  });
  assert.deepEqual(v2, {
    avatar_id: 'avatar-id',
    script: 'hello',
    voice_id: 'voice-id',
    motion_prompt: 'move',
    expressiveness: 'medium',
    aspect_ratio: '9:16',
    resolution: '1080p',
    title: common.title,
  });
  assert.deepEqual(v3, {
    type: 'avatar',
    avatar_id: 'avatar-id',
    script: 'hello',
    voice_id: 'voice-id',
    motion_prompt: 'move',
    expressiveness: 'medium',
    aspect_ratio: '9:16',
    resolution: '1080p',
    engine: { type: 'avatar_iv' },
    title: common.title,
  });
  assert.throws(
    () => buildAudioDrivenPayload({ ...common, title: '', audioAssetId: 'a', avatarId: 'b' }),
    /title 不合法/,
  );
});

test('read-only dry-run preview 覆蓋三種 API 且不建立 DATA_DIR 或 ledger', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-dry-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const planner = createHeyGenRequestPreview({
    projectDir: root,
    argv: ['--project-id=project-dry', '--revision=V1', '--run-id=run-dry'],
    env: { DATA_DIR: dataDir },
  });
  const segment = { index: 0, total: 2, role: 'a' };
  const title = planner.titleFor('ignored', segment);
  const audio = planner.preview({
    api: 'v2-audio',
    title,
    segment,
    payloadMetadata: {
      mode: 'audio-driven',
      audioAssetIdSource: 'minimax_then_heygen_upload',
      avatarIdPresent: true,
    },
  });
  const v2 = planner.preview({
    api: 'v2-text',
    title,
    segment,
    payloadMetadata: { mode: 'text-driven', scriptCharacters: 12, voiceIdPresent: true },
  });
  const v3 = planner.preview({
    api: 'v3-text',
    title,
    segment,
    payloadMetadata: { mode: 'text-driven', engine: 'avatar_iv', scriptCharacters: 12 },
  });
  assert.equal(audio.endpoint, 'https://api.heygen.com/v2/videos');
  assert.equal(v2.endpoint, 'https://api.heygen.com/v2/videos');
  assert.equal(v3.endpoint, 'https://api.heygen.com/v3/videos');
  assert.deepEqual(audio.segment, { index: 0, total: 2, role: 'A' });
  assert.equal(audio.title, title);
  assert.notEqual(audio.logicalKey, v2.logicalKey);
  assert.notEqual(v2.logicalKey, v3.logicalKey);
  assertProjectLedgerPath(planner.ledgerPath, dataDir);
  assert.equal(fs.existsSync(dataDir), false);
  assert.throws(
    () => planner.preview({
      api: 'v3-text',
      title,
      segment,
      payloadMetadata: { scriptText: 'must-not-leak' },
    }),
    /metadata 欄位不允許：scriptText/,
  );
  assert.equal(fs.existsSync(dataDir), false);
});

test('manual approval 必須精確匹配 preview，managed token 單獨不能放行 paid claim', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-preview-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const argv = ['--project-id=project-approved', '--revision=V1', '--run-id=run-approved'];
  const env = { DATA_DIR: path.join(root, 'manual-data') };
  const planner = createHeyGenRequestPreview({ projectDir: root, argv, env });
  const title = planner.titleFor('ignored');
  const payloadMetadata = {
    mode: 'text-driven',
    scriptCharacters: 12,
    scriptSha256: `sha256:${'a'.repeat(64)}`,
  };
  const preview = planner.preview({ api: 'v3-text', title, payloadMetadata });
  const plan = createHeyGenPreviewPlan([preview]);
  const sameLengthChangedScript = planner.preview({
    api: 'v3-text',
    title,
    payloadMetadata: { ...payloadMetadata, scriptSha256: `sha256:${'b'.repeat(64)}` },
  });
  assert.notEqual(createHeyGenPreviewPlan([sameLengthChangedScript]).approvalId, plan.approvalId);
  assert.throws(
    () => authorizeHeyGenPreviewPlan({ requests: [preview], context: planner.context }),
    /缺少 matching dry-run approval/,
  );
  assert.throws(
    () => authorizeHeyGenPreviewPlan({
      requests: [preview],
      context: planner.context,
      providedApprovalId: `sha256:${'0'.repeat(64)}`,
    }),
    /缺少 matching dry-run approval/,
  );
  const approval = authorizeHeyGenPreviewPlan({
    requests: [preview],
    context: planner.context,
    providedApprovalId: plan.approvalId,
  });
  const tracer = createHeyGenRequestTracer({
    projectDir: root,
    argv,
    env,
    previewApproval: approval,
    randomUUID: () => 'approved-request',
  });
  const requestId = tracer.prepare({ api: 'v3-text', title, payloadMetadata });
  const durableRequest = tracer.snapshot().requests[0];
  assert.equal(durableRequest.previewProof.approvalId, plan.approvalId);
  assert.equal(durableRequest.previewProof.previewDigest, preview.previewDigest);
  assert.deepEqual(durableRequest.previewProof.planRequestDigests, [preview.previewDigest]);
  assert.equal(durableRequest.previewProof.approvalSource, 'explicit-dry-run-token');
  let paidCalls = 0;
  await runVerifiedPaidStep({
    tracer,
    ledgerRequestId: requestId,
    api: 'v3-text',
    title,
    payloadMetadata,
    operationKey: 'heygen-video-create',
    paidStep: async () => { paidCalls += 1; },
  });
  assert.equal(paidCalls, 1);

  const managedApproved = managedFixture(t, { runId: 'run-managed-preview-approved' });
  const managedEnv = { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: managedApproved.dataDir };
  const managedPlanner = createHeyGenRequestPreview({
    projectDir: managedApproved.root,
    env: managedEnv,
  });
  const managedApprovedTitle = managedPlanner.titleFor('ignored');
  const managedPreview = managedPlanner.preview({
    api: 'v2-audio',
    title: managedApprovedTitle,
  });
  const managedApproval = authorizeHeyGenPreviewPlan({
    requests: [managedPreview],
    context: managedPlanner.context,
  });
  assert.equal(managedApproval.approvalSource, 'managed-workspace-submit');
  const managedApprovedTracer = createHeyGenRequestTracer({
    projectDir: managedApproved.root,
    env: managedEnv,
    previewApproval: managedApproval,
    randomUUID: () => 'managed-with-preview-proof',
  });
  assert.throws(
    () => managedApprovedTracer.prepare({
      api: 'v2-audio',
      title: managedApprovedTitle,
      payloadMetadata: { mode: 'audio-driven' },
    }),
    /approved dry-run preview 不一致/,
  );
  assert.equal(managedApprovedTracer.snapshot().requests.length, 0);
  const managedApprovedRequestId = managedApprovedTracer.prepare({
    api: 'v2-audio',
    title: managedApprovedTitle,
  });
  assert.equal(
    managedApprovedTracer.snapshot().requests[0].previewProof.previewDigest,
    managedPreview.previewDigest,
  );

  const managed = managedFixture(t, { runId: 'run-managed-proof-required' });
  const managedTracer = createHeyGenRequestTracer({
    projectDir: managed.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: managed.dataDir },
    randomUUID: () => 'managed-without-preview-proof',
  });
  const managedTitle = managedTracer.titleFor('ignored');
  const managedRequestId = managedTracer.prepare({ api: 'v2-audio', title: managedTitle });
  let managedPaidCalls = 0;
  await assert.rejects(
    () => runVerifiedPaidStep({
      tracer: managedTracer,
      ledgerRequestId: managedRequestId,
      api: 'v2-audio',
      title: managedTitle,
      operationKey: 'minimax-tts',
      paidStep: async () => { managedPaidCalls += 1; },
    }),
    /缺少 durable matching preview proof/,
  );
  assert.equal(managedPaidCalls, 0);
});

test('ledger 在 fetch 前 prepared，並保存 submitted/completed/failed 的最小證據', (t) => {
  const fixture = managedFixture(t);
  const ids = ['request-a', 'request-b'];
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => ids.shift(),
    pid: 53,
  });
  const segmentA = { index: 0, total: 2, role: 'A' };
  const segmentB = { index: 1, total: 2, role: 'B' };
  const requestA = tracer.prepare({
    api: 'v3-text',
    title: tracer.titleFor('ignored', segmentA),
    segment: segmentA,
  });
  let ledger = tracer.snapshot();
  assert.equal(ledger.requests[0].status, 'prepared');
  assert.equal(ledger.requests[0].providerVideoId, null);

  tracer.submitted(requestA, 'provider-video-a');
  tracer.completed(requestA, { durationSec: 12.5 });
  const requestB = tracer.prepare({
    api: 'v2-audio',
    title: tracer.titleFor('ignored', segmentB),
    segment: segmentB,
  });
  tracer.failed(requestB, { phase: 'create', code: 'http_400' });
  ledger = tracer.snapshot();

  assert.deepEqual(ledger.requests.map((item) => item.status), ['completed', 'failed']);
  assert.deepEqual(ledger.trace, {
    kind: 'project',
    projectId: fixture.projectId,
    revision: 'V2',
    runId: fixture.runId,
  });
  assert.notEqual(ledger.requests[0].title, ledger.requests[1].title);
  assert.equal(ledger.requests[0].durationSec, 12.5);
  assert.equal(ledger.requests[0].credits, null);
  assert.equal(ledger.requests[0].creditsEvidence, 'not_available_in_provider_status');
  assert.deepEqual(ledger.requests[1].failure, { phase: 'create', code: 'http_400' });
  assert.equal(
    fs.readdirSync(path.dirname(tracer.ledgerPath)).filter((name) => name.endsWith('.tmp')).length,
    0,
  );
  const eventRoot = path.join(
    path.dirname(tracer.ledgerPath),
    `.${path.basename(tracer.ledgerPath)}.events`,
  );
  assert.equal(fs.readdirSync(eventRoot).filter((name) => name.endsWith('.tmp')).length, 0);
  assert.equal(JSON.stringify(ledger).includes('audio-id'), false);
  assert.equal(JSON.stringify(ledger).includes('scriptText'), false);
  assert.equal(JSON.stringify(ledger).includes(TOKEN), false);
});

test('同一 trace/api/segment 不因改 title 或 crash/retry 自動重送付費 create', (t) => {
  const fixture = managedFixture(t);
  const ids = ['request-original', 'request-retry'];
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => ids.shift(),
    pid: 57,
  });
  const title = tracer.titleFor('ignored');
  tracer.prepare({ api: 'v3-text', title });
  assert.throws(
    () => tracer.prepare({ api: 'v3-text', title: `${title}-renamed` }),
    /logical request 已有 ledger 紀錄（prepared），拒絕自動重送/,
  );
  assert.equal(tracer.snapshot().requests.length, 1);
  assert.match(tracer.snapshot().requests[0].logicalKey, /^sha256:[0-9a-f]{64}$/);
});

test('custom title 會清除控制字元，未正規化 payload 不能進 ledger', (t) => {
  assert.equal(
    resolveHeyGenVideoTitle('fallback', {
      argv: ['--heygen-title=  自訂\u0000  名稱  '],
      env: {},
    }),
    '自訂 名稱',
  );
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => 'request-c',
    pid: 54,
  });
  assert.throws(
    () => tracer.prepare({ api: 'v3-text', title: '  bad title  ' }),
    /未通過 dry-run 正規化/,
  );
  assert.equal(tracer.snapshot().requests.length, 0);
});

test('onPrepared 置換 provider-ledgers 後會重驗 reservation，fetch 絕不執行', async (t) => {
  const fixture = managedFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-on-prepared-race-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'on-prepared-reservation',
    pid: 551,
  });
  const providerRoot = path.dirname(tracer.ledgerPath);
  const movedProviderRoot = path.join(fixture.dataDir, 'provider-ledgers-on-prepared-moved');
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: tracer.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  let fetchCalls = 0;
  let onPreparedCalls = 0;

  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v3/videos',
      api: 'v3-text',
      payload,
      onPrepared: () => {
        onPreparedCalls += 1;
        fs.renameSync(providerRoot, movedProviderRoot);
        fs.symlinkSync(outside, providerRoot);
      },
    }),
    /provider ledger root 不是安全的一般目錄/,
  );
  assert.equal(onPreparedCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
  const eventRoot = path.join(
    movedProviderRoot,
    `.${path.basename(tracer.ledgerPath)}.events`,
  );
  assert.equal(fs.readdirSync(eventRoot).filter((name) => name.startsWith('prepared-')).length, 1);
});

test('預先保留 request 在 callback 後同樣重驗，ledger root 置換時 fetch 為零', async (t) => {
  const fixture = managedFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-reserved-callback-race-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'pre-reserved-callback-reservation',
    pid: 552,
  });
  const title = tracer.titleFor('ignored');
  const ledgerRequestId = tracer.prepare({ api: 'v2-audio', title });
  const payload = buildAudioDrivenPayload({
    audioAssetId: 'fixture-audio',
    avatarId: 'fixture-avatar',
    title,
    motionPrompt: 'move',
  });
  const providerRoot = path.dirname(tracer.ledgerPath);
  const movedProviderRoot = path.join(fixture.dataDir, 'provider-ledgers-reserved-moved');
  let fetchCalls = 0;

  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v2/videos',
      api: 'v2-audio',
      payload,
      ledgerRequestId,
      onPrepared: () => {
        fs.renameSync(providerRoot, movedProviderRoot);
        fs.symlinkSync(outside, providerRoot);
      },
    }),
    /provider ledger root 不是安全的一般目錄/,
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('MiniMax/upload paid step 前 ledger inode 被替換時 callback 為零', async (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'audio-paid-step-reservation',
    pid: 555,
  });
  const title = tracer.titleFor('ignored');
  const ledgerRequestId = tracer.prepare({ api: 'v2-audio', title });
  const canonicalLedger = `${tracer.ledgerPath}.canonical-moved`;
  fs.renameSync(tracer.ledgerPath, canonicalLedger);
  fs.writeFileSync(tracer.ledgerPath, fs.readFileSync(canonicalLedger), { mode: 0o600 });
  let paidCalls = 0;

  await assert.rejects(
    () => runVerifiedPaidStep({
      tracer,
      ledgerRequestId,
      api: 'v2-audio',
      title,
      operationKey: 'minimax-tts',
      paidStep: async () => { paidCalls += 1; },
    }),
    /provider ledger filesystem identity 已改變/,
  );
  assert.equal(paidCalls, 0);
});

test('同 reservation/operation 的並行 paid callback 只有一個 claim winner', async (t) => {
  const fixture = managedFixture(t);
  const primaryTracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'parallel-paid-operation',
    pid: 558,
  });
  const title = primaryTracer.titleFor('ignored');
  approvePreviewRequests(primaryTracer, [{ api: 'v2-audio', title }]);
  const ledgerRequestId = primaryTracer.prepare({ api: 'v2-audio', title });
  const competingTracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'unused-competing-operation-id',
    pid: 1558,
  });
  let releasePaidStep;
  const paidStepGate = new Promise((resolve) => { releasePaidStep = resolve; });
  let paidCalls = 0;
  const invoke = (tracer) => runVerifiedPaidStep({
    tracer,
    ledgerRequestId,
    api: 'v2-audio',
    title,
    operationKey: 'minimax-tts',
    paidStep: async () => {
      paidCalls += 1;
      await paidStepGate;
      return 'paid-step-ok';
    },
  });

  const first = invoke(primaryTracer);
  const second = invoke(competingTracer);
  releasePaidStep();
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
  assert.match(settled.find((item) => item.status === 'rejected').reason.message, /已被 claim/);
  assert.equal(paidCalls, 1);
  assert.deepEqual(
    primaryTracer.snapshot().operationClaims.map((claim) => claim.operationKey),
    ['minimax-tts'],
  );
});

test('不同合法 operation 與不同 segment 各自取得一個 claim', async (t) => {
  const fixture = managedFixture(t);
  const requestIds = ['segment-a-request', 'segment-b-request'];
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => requestIds.shift(),
    pid: 559,
  });
  const segmentA = { index: 0, total: 2, role: 'A' };
  const segmentB = { index: 1, total: 2, role: 'B' };
  const titleA = tracer.titleFor('ignored', segmentA);
  const titleB = tracer.titleFor('ignored', segmentB);
  approvePreviewRequests(tracer, [
    { api: 'v2-audio', title: titleA, segment: segmentA },
    { api: 'v2-audio', title: titleB, segment: segmentB },
  ]);
  const requestA = tracer.prepare({ api: 'v2-audio', title: titleA, segment: segmentA });
  const requestB = tracer.prepare({ api: 'v2-audio', title: titleB, segment: segmentB });
  const calls = { ttsA: 0, uploadA: 0, ttsB: 0 };

  await Promise.all([
    runVerifiedPaidStep({
      tracer,
      ledgerRequestId: requestA,
      api: 'v2-audio',
      title: titleA,
      segment: segmentA,
      operationKey: 'minimax-tts',
      paidStep: async () => { calls.ttsA += 1; },
    }),
    runVerifiedPaidStep({
      tracer,
      ledgerRequestId: requestA,
      api: 'v2-audio',
      title: titleA,
      segment: segmentA,
      operationKey: 'heygen-audio-upload',
      paidStep: async () => { calls.uploadA += 1; },
    }),
    runVerifiedPaidStep({
      tracer,
      ledgerRequestId: requestB,
      api: 'v2-audio',
      title: titleB,
      segment: segmentB,
      operationKey: 'minimax-tts',
      paidStep: async () => { calls.ttsB += 1; },
    }),
  ]);
  assert.deepEqual(calls, { ttsA: 1, uploadA: 1, ttsB: 1 });
  const claims = tracer.snapshot().operationClaims;
  assert.equal(claims.length, 3);
  assert.equal(new Set(claims.map((claim) => claim.claimId)).size, 3);
});

test('paid callback crash 後同 operation retry fail closed', async (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'crash-retry-paid-operation',
    pid: 560,
  });
  const title = tracer.titleFor('ignored');
  approvePreviewRequests(tracer, [{ api: 'v2-audio', title }]);
  const ledgerRequestId = tracer.prepare({ api: 'v2-audio', title });
  let paidCalls = 0;
  const invoke = () => runVerifiedPaidStep({
    tracer,
    ledgerRequestId,
    api: 'v2-audio',
    title,
    operationKey: 'minimax-tts',
    paidStep: async () => {
      paidCalls += 1;
      throw new Error('simulated paid callback crash');
    },
  });

  await assert.rejects(invoke, /simulated paid callback crash/);
  await assert.rejects(invoke, /已被 claim/);
  assert.equal(paidCalls, 1);
  const snapshot = tracer.snapshot();
  assert.equal(snapshot.requests[0].status, 'prepared');
  assert.equal(snapshot.operationClaims[0].operationKey, 'minimax-tts');
});

test('同一 pre-reserved create 並行 submit 只有一個 fetch winner', async (t) => {
  const fixture = managedFixture(t);
  const primaryTracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'parallel-create-reservation',
    pid: 561,
  });
  const title = primaryTracer.titleFor('ignored');
  approvePreviewRequests(primaryTracer, [{ api: 'v3-text', title }]);
  const ledgerRequestId = primaryTracer.prepare({ api: 'v3-text', title });
  const competingTracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'unused-competing-create-id',
    pid: 1561,
  });
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title,
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    await fetchGate;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { video_id: 'parallel-provider-video' } }),
    };
  };
  const invoke = (tracer) => submitTracedHeyGenCreate({
    fetchImpl,
    tracer,
    apiKey: 'test-api-key',
    endpoint: 'https://api.heygen.com/v3/videos',
    api: 'v3-text',
    payload,
    ledgerRequestId,
  });

  const first = invoke(primaryTracer);
  const second = invoke(competingTracer);
  releaseFetch();
  const settled = await Promise.allSettled([first, second]);
  assert.equal(fetchCalls, 1);
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
  assert.deepEqual(
    primaryTracer.snapshot().operationClaims.map((claim) => claim.operationKey),
    ['heygen-video-create'],
  );
});

test('immutable header 同 inode 內容被改寫時 paid callback 為零', async (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'header-content-reservation',
    pid: 556,
  });
  const title = tracer.titleFor('ignored');
  const ledgerRequestId = tracer.prepare({ api: 'v2-audio', title });
  const inodeBefore = fs.statSync(tracer.ledgerPath, { bigint: true }).ino;
  const header = JSON.parse(fs.readFileSync(tracer.ledgerPath, 'utf8'));
  header.updatedAt = '2026-08-21T23:59:59.999Z';
  fs.chmodSync(tracer.ledgerPath, 0o600);
  fs.writeFileSync(tracer.ledgerPath, `${JSON.stringify(header, null, 2)}\n`);
  fs.chmodSync(tracer.ledgerPath, 0o400);
  assert.equal(fs.statSync(tracer.ledgerPath, { bigint: true }).ino, inodeBefore);
  let paidCalls = 0;

  await assert.rejects(
    () => runVerifiedPaidStep({
      tracer,
      ledgerRequestId,
      api: 'v2-audio',
      title,
      operationKey: 'minimax-tts',
      paidStep: async () => { paidCalls += 1; },
    }),
    /immutable header bytes 已改變/,
  );
  assert.equal(paidCalls, 0);
});

test('immutable reservation event 同 inode 內容被改寫時 paid callback 為零', async (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    randomUUID: () => 'event-content-reservation',
    pid: 557,
  });
  const title = tracer.titleFor('ignored');
  const ledgerRequestId = tracer.prepare({ api: 'v2-audio', title });
  const eventRoot = path.join(
    path.dirname(tracer.ledgerPath),
    `.${path.basename(tracer.ledgerPath)}.events`,
  );
  const preparedName = fs.readdirSync(eventRoot).find((name) => name.startsWith('prepared-'));
  const preparedPath = path.join(eventRoot, preparedName);
  const inodeBefore = fs.statSync(preparedPath, { bigint: true }).ino;
  const event = JSON.parse(fs.readFileSync(preparedPath, 'utf8'));
  event.request.title = `${title}-mutated`;
  fs.chmodSync(preparedPath, 0o600);
  fs.writeFileSync(preparedPath, `${JSON.stringify(event, null, 2)}\n`);
  fs.chmodSync(preparedPath, 0o400);
  assert.equal(fs.statSync(preparedPath, { bigint: true }).ino, inodeBefore);
  let paidCalls = 0;

  await assert.rejects(
    () => runVerifiedPaidStep({
      tracer,
      ledgerRequestId,
      api: 'v2-audio',
      title,
      operationKey: 'minimax-tts',
      paidStep: async () => { paidCalls += 1; },
    }),
    /immutable event bytes 或 inode 已改變/,
  );
  assert.equal(paidCalls, 0);
});

test('immutable publish 遇到 destination 競爭者時不覆寫 reservation 且 fetch 為零', async (t) => {
  const fixture = managedFixture(t);
  let armed = false;
  let injected = false;
  const fsImpl = hookedFs({
    linkSync(source, destination) {
      if (armed && !injected && path.basename(destination).startsWith('prepared-')) {
        const competing = JSON.parse(fs.readFileSync(source, 'utf8'));
        competing.request.requestId = 'competing-destination-reservation';
        fs.writeFileSync(destination, `${JSON.stringify(competing, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        injected = true;
      }
      return fs.linkSync(source, destination);
    },
  });
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    fsImpl,
    randomUUID: () => 'must-not-overwrite-destination',
    pid: 553,
  });
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: tracer.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  armed = true;
  let fetchCalls = 0;

  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v3/videos',
      api: 'v3-text',
      payload,
    }),
    /immutable event 已存在/,
  );
  assert.equal(injected, true);
  assert.equal(fetchCalls, 0);
  assert.equal(tracer.snapshot().requests[0].requestId, 'competing-destination-reservation');
});

test('immutable publish 的 temp 被替換時以 inode 證明拒絕，fetch 為零', async (t) => {
  const fixture = managedFixture(t);
  let armed = false;
  let injected = false;
  const fsImpl = hookedFs({
    linkSync(source, destination) {
      if (armed && !injected && path.basename(destination).startsWith('prepared-')) {
        const replacement = JSON.parse(fs.readFileSync(source, 'utf8'));
        replacement.request.requestId = 'competing-temp-reservation';
        fs.renameSync(source, `${source}.reviewer-original`);
        fs.writeFileSync(source, `${JSON.stringify(replacement, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        injected = true;
      }
      return fs.linkSync(source, destination);
    },
  });
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    fsImpl,
    randomUUID: () => 'must-not-trust-replaced-temp',
    pid: 554,
  });
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: tracer.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  armed = true;
  let fetchCalls = 0;

  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer,
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v3/videos',
      api: 'v3-text',
      payload,
    }),
    /provider ledger event temp filesystem identity 已改變/,
  );
  assert.equal(injected, true);
  assert.equal(fetchCalls, 0);
  assert.equal(tracer.snapshot().requests[0].requestId, 'competing-temp-reservation');
});

test('fake transport 觀察到 fetch 前 ledger 已是 prepared，成功後才轉 submitted', async (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => 'request-before-fetch',
    pid: 56,
  });
  const payload = buildTextDrivenV3Payload({
    scriptText: 'fixture only',
    avatarId: 'avatar-fixture',
    voiceId: 'voice-fixture',
    title: tracer.titleFor('ignored'),
    motionPrompt: 'move',
    expressiveness: 'medium',
  });
  approvePreviewRequests(tracer, [{ api: 'v3-text', title: payload.title }]);
  let fetchCalls = 0;
  const result = await submitTracedHeyGenCreate({
    fetchImpl: async (_url, options) => {
      fetchCalls += 1;
      assert.equal(tracer.snapshot().requests[0].status, 'prepared');
      assert.equal(JSON.parse(options.body).title, payload.title);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { video_id: 'provider-video-fixture' } }),
      };
    },
    tracer,
    apiKey: 'test-api-key',
    endpoint: 'https://api.heygen.com/v3/videos',
    api: 'v3-text',
    payload,
  });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(result, {
    videoId: 'provider-video-fixture',
    ledgerRequestId: 'request-before-fetch',
  });
  assert.equal(tracer.snapshot().requests[0].status, 'submitted');
  assert.equal(JSON.stringify(tracer.snapshot()).includes('test-api-key'), false);
});

test('預先保留的 audio request 可被 create 使用一次，不一致時 fetch 絕不執行', async (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => 'request-reserved-before-minimax',
    pid: 58,
  });
  const title = tracer.titleFor('ignored');
  approvePreviewRequests(tracer, [{ api: 'v2-audio', title }]);
  const ledgerRequestId = tracer.prepare({ api: 'v2-audio', title });
  const payload = buildAudioDrivenPayload({
    audioAssetId: 'fixture-audio',
    avatarId: 'fixture-avatar',
    title,
    motionPrompt: 'move',
  });
  let fetchCalls = 0;
  const result = await submitTracedHeyGenCreate({
    fetchImpl: async () => {
      fetchCalls += 1;
      assert.equal(tracer.snapshot().requests.length, 1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { video_id: 'provider-reserved' } }),
      };
    },
    tracer,
    apiKey: 'fixture-key',
    endpoint: 'https://api.heygen.com/v2/videos',
    api: 'v2-audio',
    payload,
    ledgerRequestId,
  });
  assert.equal(fetchCalls, 1);
  assert.equal(result.ledgerRequestId, ledgerRequestId);
  assert.equal(tracer.snapshot().requests.length, 1);
  assert.equal(tracer.snapshot().requests[0].status, 'submitted');

  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer,
      apiKey: 'fixture-key',
      endpoint: 'https://api.heygen.com/v2/videos',
      api: 'v2-audio',
      payload: { ...payload, title: `${title}-mismatch` },
      ledgerRequestId,
    }),
    /已保留 request 與 create payload 不一致/,
  );
  assert.equal(fetchCalls, 1);
});

test('provider ledger lock 存在時 fail closed，不使用 stale in-memory ledger', (t) => {
  const fixture = managedFixture(t);
  const tracer = createHeyGenRequestTracer({
    projectDir: fixture.root,
    env: { WORKSPACE_RUN_TOKEN: TOKEN, DATA_DIR: fixture.dataDir },
    now: fixedClock(),
    randomUUID: () => 'request-lock',
    pid: 59,
  });
  const lockPath = path.join(
    path.dirname(tracer.ledgerPath),
    `.${path.basename(tracer.ledgerPath)}.lock`,
  );
  fs.mkdirSync(lockPath);
  assert.throws(
    () => tracer.prepare({ api: 'v3-text', title: tracer.titleFor('ignored') }),
    /正由另一個程序使用/,
  );
});

test('ledger prepare 失敗時 fake transport 絕不執行', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => submitTracedHeyGenCreate({
      fetchImpl: async () => { fetchCalls += 1; },
      tracer: {
        prepare() { throw new Error('ledger unavailable'); },
      },
      apiKey: 'test-api-key',
      endpoint: 'https://api.heygen.com/v2/videos',
      api: 'v2-audio',
      payload: { title: 'MV-project-a-V1-run-a' },
    }),
    /ledger unavailable/,
  );
  assert.equal(fetchCalls, 0);
});

test('三支 legacy paid-provider scripts 在讀 key、upload、MiniMax/create 前 deterministic retired', () => {
  const scriptsDir = __dirname;
  const scriptNames = ['test-v3-videos.js', 'test-avatar-iv.js', 'verify-dual.js'];
  for (const scriptName of scriptNames) {
    const scriptPath = path.join(scriptsDir, scriptName);
    const source = fs.readFileSync(scriptPath, 'utf8');
    const guardIndex = source.indexOf("stopRetiredPaidProviderScript('");
    assert.ok(guardIndex >= 0, `${scriptName} missing retirement guard`);
    for (const paidMarker of ['require("dotenv")', 'process.env.HEYGEN_API_KEY', 'minimaxTTS(', 'fetch(']) {
      const markerIndex = source.indexOf(paidMarker);
      if (markerIndex >= 0) assert.ok(guardIndex < markerIndex, `${scriptName}: ${paidMarker}`);
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HEYGEN_API_KEY: 'test-fixture-must-not-be-read',
        MINIMAX_API_KEY: 'test-fixture-must-not-be-read',
        MINIMAX_GROUP_ID: 'test-fixture-must-not-be-read',
      },
    });
    assert.equal(result.status, 2, `${scriptName}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`PAID_PROVIDER_SCRIPT_RETIRED: ${scriptName.replace('.', '\\.')} is disabled`));
    assert.equal(result.stdout, '');
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(packageJson.scripts, 'test:v3'), false);
});

test('AGENTS.md versioned HeyGen policy 鎖定 title、dry-run、ledger 與不重生', () => {
  const policy = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.match(policy, /## HeyGen create naming/);
  assert.match(policy, /Every HeyGen create request must send a non-empty `title`/);
  assert.match(policy, /`測試用EXP-NNN-VN`/);
  assert.match(policy, /Generate and verify the title in the payload dry-run before the paid request/);
  assert.match(policy, /When a provider ledger exists, save the same title there/);
  assert.match(policy, /Never regenerate a video merely to change its title/);
});

test('run.js 的 audio/v2-text/v3-text create paths 都只走共同 trace gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'run.js'), 'utf8');
  assert.equal((source.match(/return submitHeyGenCreate\(\{/g) || []).length, 3);
  assert.match(source, /buildAudioDrivenPayload\(\{/);
  assert.match(source, /buildTextDrivenV2Payload\(\{/);
  assert.match(source, /buildTextDrivenV3Payload\(\{/);
  assert.doesNotMatch(source, /title:\s*["']marketing-auto["']/);
  assert.match(source, /createHeyGenRequestPreview\(\{/);
  assert.match(source, /createHeyGenRequestTracer\(\{/);
  assert.match(source, /const HEYGEN_TRACE_ENV = snapshotHeyGenTraceEnvironment\(process\.env\)/);
  assert.equal((source.match(/env: HEYGEN_TRACE_ENV/g) || []).length, 3);
  assert.match(source, /loadProviderSecrets\(\{ env: process\.env \}\)/);
  assert.doesNotMatch(source, /require\(["']dotenv["']\)\.config\(\)/);
  assert.match(source, /submitTracedHeyGenCreate\(\{/);

  const dualPath = source.slice(
    source.indexOf('async function runDualPath'),
    source.indexOf('// ── 主流程'),
  );
  assert.ok(dualPath.indexOf('const ledgerRequestId = tracer.prepare({') >= 0);
  assert.ok(
    dualPath.indexOf('const ledgerRequestId = tracer.prepare({')
      < dualPath.indexOf('const mp3 = await runVerifiedPaidStep'),
  );
  assert.equal((dualPath.match(/await runVerifiedPaidStep\(\{/g) || []).length, 2);
  assert.match(dualPath, /operationKey: "minimax-tts"/);
  assert.match(dualPath, /operationKey: "heygen-audio-upload"/);
  assert.match(dualPath, /paidStep: \(\) => minimaxTTS\(/);
  assert.match(dualPath, /paidStep: \(\) => heygenUploadAudio\(/);
  assert.doesNotMatch(dualPath, /await minimaxTTS\(|await heygenUploadAudio\(/);
  assert.match(dualPath, /seg\.ledgerRequestId/);

  const singleMiniMax = source.slice(source.lastIndexOf('if (USE_MINIMAX)'));
  assert.ok(singleMiniMax.indexOf('const ledgerRequestId = tracer.prepare({') >= 0);
  assert.ok(
    singleMiniMax.indexOf('const ledgerRequestId = tracer.prepare({')
      < singleMiniMax.indexOf('const audioBuffer = await runVerifiedPaidStep'),
  );
  assert.equal((singleMiniMax.match(/await runVerifiedPaidStep\(\{/g) || []).length, 2);
  assert.match(singleMiniMax, /operationKey: "minimax-tts"/);
  assert.match(singleMiniMax, /operationKey: "heygen-audio-upload"/);
  assert.match(singleMiniMax, /paidStep: \(\) => minimaxTTS\(/);
  assert.match(singleMiniMax, /paidStep: \(\) => heygenUploadAudio\(/);
  assert.doesNotMatch(singleMiniMax, /await minimaxTTS\(|await heygenUploadAudio\(/);

  const dryRunPlanner = source.slice(
    source.indexOf('function audioDryRunMetadata'),
    source.indexOf('// ── 主流程'),
  );
  assert.match(dryRunPlanner, /api: "v2-audio"/);
  assert.match(dryRunPlanner, /"v2-text" : "v3-text"/);
  assert.doesNotMatch(
    dryRunPlanner,
    /await minimaxTTS|heygenUploadAudio\(|submitHeyGenCreate\(|createHeyGenRequestTracer\(|fetch\(/,
  );

  const mainSource = source.slice(source.indexOf('async function main()'));
  assert.ok(mainSource.indexOf('if (DRY_RUN)') >= 0);
  assert.ok(mainSource.indexOf('buildHeyGenDryRunPlan(previewPlanner)') >= 0);
  assert.ok(mainSource.indexOf('authorizeHeyGenPreviewPlan({') >= 0);
  assert.ok(
    mainSource.indexOf('authorizeHeyGenPreviewPlan({')
      < mainSource.indexOf('loadProviderEnvironment()'),
  );
  assert.match(mainSource, /previewApproval: paidPreviewApproval/);
  assert.ok(mainSource.indexOf('if (DRY_RUN)') < mainSource.indexOf('openSync(lockFile, "wx")'));
  assert.ok(
    mainSource.indexOf('if (DRY_RUN)') < mainSource.indexOf('loadProviderEnvironment()'),
  );
  assert.ok(
    mainSource.indexOf('runHeyGenDryRun()') < mainSource.indexOf('loadProviderEnvironment()'),
  );
  assert.ok(
    mainSource.indexOf('heygenRequestTracer = createHeyGenRequestTracer({')
      < mainSource.indexOf('await generateHeygenVideo(heygenPath)'),
  );
});
