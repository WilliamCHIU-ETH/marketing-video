'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  buildAudioDrivenPayload,
  buildTextDrivenV2Payload,
  buildTextDrivenV3Payload,
  createHeyGenRequestPreview,
  createHeyGenRequestTracer,
  normalizeExperimentId,
  resolveHeyGenVideoTitle,
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

test('managed WORKSPACE_RUN_TOKEN 唯一解析 Project/Revision/Run 並建立 job-local ledger', (t) => {
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
  assert.equal(
    tracer.ledgerPath,
    path.join(fs.realpathSync(fixture.jobDir), 'provider-ledger.json'),
  );
  assert.equal(
    tracer.titleFor('ignored'),
    `MV-${fixture.projectId}-V2-${fixture.runId}`,
  );
  assert.equal(fs.statSync(tracer.ledgerPath).mode & 0o777, 0o600);
});

test('managed dry-run 只讀取 identity，既有 ledger bytes/mtime 不變且不建立 lock', (t) => {
  const fixture = managedFixture(t);
  const ledgerPath = path.join(fixture.jobDir, 'provider-ledger.json');
  const ledgerBytes = Buffer.from('{"existing":"operator evidence"}\n');
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
  assert.equal(fs.existsSync(path.join(fixture.jobDir, '.provider-ledger.json.lock')), false);
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
  const ledgerTarget = path.join(ledgerFixture.jobDir, 'ledger-target.json');
  writeJson(ledgerTarget, {});
  fs.symlinkSync(ledgerTarget, path.join(ledgerFixture.jobDir, 'provider-ledger.json'));
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
    HEYGEN_API_KEY: 'must-not-be-read',
    MINIMAX_API_KEY: 'must-not-be-read',
    MINIMAX_GROUP_ID: 'must-not-be-read',
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
  assert.equal(preview.requestCount, 1);
  assert.equal(preview.requests[0].api, 'v3-text');
  assert.equal(preview.requests[0].endpoint, 'https://api.heygen.com/v3/videos');
  assert.equal(preview.requests[0].title, 'MV-project-dry-V1-run-dry');
  assert.equal(preview.requests[0].payloadMetadata.mode, 'text-driven');
  assert.equal(Object.hasOwn(preview.requests[0].payloadMetadata, 'scriptText'), false);
  assert.equal(preview.ledgerPath, path.join(dataDir, 'provider-ledgers', 'run-dry.json'));
  assert.equal(fs.existsSync(preview.ledgerPath), false);
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
    '測試用EXP-100-V1-S01A',
    '測試用EXP-100-V1-S02B',
  ]);
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

  const existingLedger = path.join(dataDir, 'provider-ledgers', 'run-existing.json');
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

test('EXP title 延續既有命名並讓多人 segment 唯一', (t) => {
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
    '測試用EXP-001-V2-S01A',
  );
  assert.equal(
    tracer.titleFor('ignored', { index: 1, total: 2, role: 'B' }),
    '測試用EXP-001-V2-S02B',
  );
});

test('EXP/Revision 使用穩定 logical key，跨程序改 title prefix 仍阻擋重送', (t) => {
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
    argv: [...options.argv, '--heygen-title=renamed-dashboard-prefix'],
    now: fixedClock(),
    randomUUID: () => 'request-exp-second',
    pid: 200,
  });
  assert.equal(first.ledgerPath, second.ledgerPath);
  const title = first.titleFor('ignored');
  first.prepare({ api: 'v3-text', title });
  assert.notEqual(second.titleFor('ignored'), title);
  assert.throws(
    () => second.prepare({ api: 'v3-text', title: second.titleFor('ignored') }),
    /logical request 已有 ledger 紀錄（prepared），拒絕自動重送/,
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
  assert.equal(planner.ledgerPath, path.join(dataDir, 'provider-ledgers', 'run-dry.json'));
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
  let ledger = JSON.parse(fs.readFileSync(tracer.ledgerPath, 'utf8'));
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
  ledger = JSON.parse(fs.readFileSync(tracer.ledgerPath, 'utf8'));

  assert.deepEqual(ledger.requests.map((item) => item.status), ['completed', 'failed']);
  assert.notEqual(ledger.requests[0].title, ledger.requests[1].title);
  assert.equal(ledger.requests[0].durationSec, 12.5);
  assert.equal(ledger.requests[0].credits, null);
  assert.equal(ledger.requests[0].creditsEvidence, 'not_available_in_provider_status');
  assert.deepEqual(ledger.requests[1].failure, { phase: 'create', code: 'http_400' });
  assert.equal(
    fs.readdirSync(fixture.jobDir).filter((name) => name.endsWith('.tmp')).length,
    0,
  );
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
    apiKey: 'fixture-key-never-sent',
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
  assert.equal(JSON.stringify(tracer.snapshot()).includes('fixture-key-never-sent'), false);
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
      apiKey: 'fixture-key-never-sent',
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
        HEYGEN_API_KEY: 'fixture-must-not-be-read',
        MINIMAX_API_KEY: 'fixture-must-not-be-read',
        MINIMAX_GROUP_ID: 'fixture-must-not-be-read',
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
  assert.match(source, /submitTracedHeyGenCreate\(\{/);

  const dualPath = source.slice(
    source.indexOf('async function runDualPath'),
    source.indexOf('// ── main'),
  );
  assert.ok(dualPath.indexOf('const ledgerRequestId = tracer.prepare({') >= 0);
  assert.ok(
    dualPath.indexOf('const ledgerRequestId = tracer.prepare({')
      < dualPath.indexOf('const mp3 = await minimaxTTS'),
  );
  assert.match(dualPath, /seg\.ledgerRequestId/);

  const singleMiniMax = source.slice(source.lastIndexOf('if (USE_MINIMAX)'));
  assert.ok(singleMiniMax.indexOf('const ledgerRequestId = tracer.prepare({') >= 0);
  assert.ok(
    singleMiniMax.indexOf('const ledgerRequestId = tracer.prepare({')
      < singleMiniMax.indexOf('const audioBuffer = await minimaxTTS'),
  );

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
