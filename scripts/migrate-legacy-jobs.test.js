'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  loadPlan,
  parseArgs,
  run,
} = require('./migrate-legacy-jobs');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureJob(source, {
  id,
  title,
  createdAt,
  output = `video-${id}`,
  status = 'done',
  image = ONE_PIXEL_PNG,
}) {
  const jobDir = path.join(source, 'jobs', id);
  const inputDir = path.join(jobDir, 'input');
  const outDir = path.join(jobDir, 'out');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, 'shared.png'), image);
  fs.writeFileSync(path.join(inputDir, 'script.txt'), `===\nvoice\n===\n${title}\n===\nbody ${id}\n`);
  const outputBytes = Buffer.from(output);
  fs.writeFileSync(path.join(outDir, 'final.mp4'), outputBytes);
  writeJson(path.join(jobDir, 'job.json'), {
    id,
    title,
    template: 'marketing',
    owner: 'Fixture',
    status,
    createdAt,
    finishedAt: status === 'done' ? createdAt : null,
    outputs: [{ name: 'final.mp4', size: outputBytes.length }],
  });
  fs.writeFileSync(path.join(jobDir, 'log.txt'), `legacy ${id}\n`);
  return jobDir;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-migration-test-'));
  const source = path.join(root, 'legacy-runtime');
  const dataDir = path.join(root, 'target-runtime');
  fixtureJob(source, { id: 'job-v1', title: '共同專案', createdAt: '2026-08-18T10:00:00.000Z' });
  fixtureJob(source, { id: 'job-v2', title: ' 共同專案 ', createdAt: '2026-08-18T11:00:00.000Z' });
  fixtureJob(source, { id: 'job-v3', title: '共同專案', createdAt: '2026-08-19T10:00:00.000Z' });
  fixtureJob(source, { id: 'blank-a', title: '', createdAt: '2026-08-19T11:00:00.000Z' });
  fixtureJob(source, { id: 'blank-b', title: '   ', createdAt: '2026-08-19T12:00:00.000Z' });
  return { root, source, dataDir };
}

function options(source, dataDir, extra = {}) {
  return { source, dataDir, apply: false, verify: false, ...extra };
}

test('parseArgs keeps preview as the safe default', () => {
  const parsed = parseArgs(['--source', './legacy', '--data-dir', './target']);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.verify, false);
  assert.throws(() => parseArgs(['--source', './legacy', '--apply', '--verify']), /不能同時使用/);
});

test('preview validates input, groups V1/V2/V3, and never merges blank titles', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(options(fixture.source, fixture.dataDir));
  assert.equal(result.mode, 'preview');
  assert.equal(result.projects, 3);
  assert.equal(result.revisions, 5);
  assert.equal(result.groups.filter((group) => group.runs.length === 3).length, 1);
  assert.equal(fs.existsSync(fixture.dataDir), false);
});

test('apply is transactional, deduplicates Project Assets, emits minimal Runs, and reruns idempotently', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const applyOptions = options(fixture.source, fixture.dataDir, { apply: true });
  const first = run(applyOptions);
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.projects, 3);
  assert.equal(first.revisions, 5);

  const plans = loadPlan(applyOptions);
  const sharedPlan = plans.find((plan) => plan.records.length === 3);
  const projectDir = path.join(fixture.dataDir, 'projects', sharedPlan.id);
  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  assert.equal(project.latestRevision, 3);
  assert.equal(project.assets.length, 1);
  assert.deepEqual(project.revisions.map((revision) => revision.id), ['v001', 'v002', 'v003']);
  for (const id of ['job-v1', 'job-v2', 'job-v3']) {
    const entries = fs.readdirSync(path.join(fixture.dataDir, 'jobs', id)).sort();
    assert.deepEqual(entries, ['job.json', 'log.txt']);
  }
  assert.equal(fs.readdirSync(path.join(projectDir, 'outputs')).length, 3);

  const second = run(applyOptions);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(fs.readdirSync(path.join(projectDir, 'outputs')).length, 3);
  const verified = run(options(fixture.source, fixture.dataDir, { verify: true }));
  assert.equal(verified.ok, true);
});

test('promotion failure rolls back every target created by this run', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const applyOptions = options(fixture.source, fixture.dataDir, { apply: true });
  const plans = loadPlan(applyOptions);
  const migration = require('./migrate-legacy-jobs');
  assert.throws(() => migration.applyMigration(applyOptions, plans, {
    afterPromote() { throw new Error('fixture promotion failure'); },
  }), /fixture promotion failure/);
  const projectsDir = path.join(fixture.dataDir, 'projects');
  const jobsDir = path.join(fixture.dataDir, 'jobs');
  assert.deepEqual(fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [], []);
  assert.deepEqual(fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [], []);
  assert.equal(fs.readdirSync(fixture.dataDir).some((name) => name.startsWith('.legacy-migration-')), false);
});

test('dry-run fails closed for missing output and unsafe archive', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(fixture.source, 'jobs', 'job-v2', 'out', 'final.mp4'));
  assert.throws(() => run(options(fixture.source, fixture.dataDir)), /找不到 job job-v2 的成品/);
  assert.equal(fs.existsSync(fixture.dataDir), false);

  const outside = path.join(fixture.root, 'outside.mp4');
  fs.writeFileSync(outside, 'outside');
  const jobFile = path.join(fixture.source, 'jobs', 'job-v2', 'job.json');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  job.outputs = [{ name: 'final.mp4', size: 7, archive: outside }];
  writeJson(jobFile, job);
  assert.throws(() => run(options(fixture.source, fixture.dataDir)), /找不到 job job-v2 的成品/);
});

test('dry-run honors repository-relative legacy archive paths without a Run output fallback', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const jobDir = path.join(fixture.source, 'jobs', 'job-v2');
  const fallback = path.join(jobDir, 'out', 'final.mp4');
  const archived = path.join(fixture.source, 'archive', '2026-08', 'final.mp4');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(fallback, archived);
  const jobFile = path.join(jobDir, 'job.json');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  job.outputs[0].archive = 'runtime-data/archive/2026-08/final.mp4';
  writeJson(jobFile, job);

  const result = run(options(fixture.source, fixture.dataDir));
  assert.equal(result.mode, 'preview');
  assert.equal(result.revisions, 5);
  assert.equal(fs.existsSync(fixture.dataDir), false);
});

test('dry-run rejects symlinked input directories and supported media entries', (t) => {
  const linkedDirectory = makeFixture();
  t.after(() => fs.rmSync(linkedDirectory.root, { recursive: true, force: true }));
  const inputDir = path.join(linkedDirectory.source, 'jobs', 'job-v2', 'input');
  const realInputDir = path.join(linkedDirectory.source, 'jobs', 'job-v2', 'input-real');
  fs.renameSync(inputDir, realInputDir);
  fs.symlinkSync(realInputDir, inputDir);
  assert.throws(() => run(options(linkedDirectory.source, linkedDirectory.dataDir)),
    /legacy input 目錄不是安全的實體目錄/);

  const linkedMedia = makeFixture();
  t.after(() => fs.rmSync(linkedMedia.root, { recursive: true, force: true }));
  const media = path.join(linkedMedia.source, 'jobs', 'job-v2', 'input', 'shared.png');
  const shared = path.join(linkedMedia.source, 'shared.png');
  fs.renameSync(media, shared);
  fs.symlinkSync(shared, media);
  assert.throws(() => run(options(linkedMedia.source, linkedMedia.dataDir)),
    /legacy input 素材不是安全的實體檔案/);
});

test('verify detects byte tampering and partial targets block apply', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const applyOptions = options(fixture.source, fixture.dataDir, { apply: true });
  run(applyOptions);
  const shared = loadPlan(applyOptions).find((plan) => plan.records.length === 3);
  const projectDir = path.join(fixture.dataDir, 'projects', shared.id);
  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  fs.writeFileSync(path.join(projectDir, project.assets[0].path), ONE_PIXEL_PNG.subarray(0, -1));
  assert.throws(() => run(options(fixture.source, fixture.dataDir, { verify: true })), /size 不一致|SHA-256 不一致/);

  const second = makeFixture();
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  const plans = loadPlan(options(second.source, second.dataDir, { apply: true }));
  fs.mkdirSync(path.join(second.dataDir, 'projects', plans[0].id), { recursive: true });
  assert.throws(() => run(options(second.source, second.dataDir, { apply: true })), /部分 migration 結果/);
});

test('verify rejects duplicated revision identity and symlinked durable output', (t) => {
  const duplicate = makeFixture();
  t.after(() => fs.rmSync(duplicate.root, { recursive: true, force: true }));
  const duplicateOptions = options(duplicate.source, duplicate.dataDir, { apply: true });
  run(duplicateOptions);
  const duplicatePlan = loadPlan(duplicateOptions).find((plan) => plan.records.length === 3);
  const duplicateProjectFile = path.join(duplicate.dataDir, 'projects', duplicatePlan.id, 'project.json');
  const duplicateProject = JSON.parse(fs.readFileSync(duplicateProjectFile, 'utf8'));
  duplicateProject.revisions[1] = { ...duplicateProject.revisions[0] };
  writeJson(duplicateProjectFile, duplicateProject);
  assert.throws(() => run(options(duplicate.source, duplicate.dataDir, { verify: true })),
    /Revision 順序或 identity 不一致|重複 Revision/);

  const linked = makeFixture();
  t.after(() => fs.rmSync(linked.root, { recursive: true, force: true }));
  const linkedOptions = options(linked.source, linked.dataDir, { apply: true });
  run(linkedOptions);
  const linkedPlan = loadPlan(linkedOptions).find((plan) => plan.records.length === 3);
  const linkedProjectDir = path.join(linked.dataDir, 'projects', linkedPlan.id);
  const revision = JSON.parse(fs.readFileSync(path.join(linkedProjectDir, 'revisions', 'v001.json'), 'utf8'));
  const output = path.isAbsolute(revision.outputs[0].archive)
    ? revision.outputs[0].archive
    : path.resolve(__dirname, '..', revision.outputs[0].archive);
  const outside = path.join(linked.root, 'outside-output.mp4');
  fs.copyFileSync(output, outside);
  fs.unlinkSync(output);
  fs.symlinkSync(outside, output);
  assert.throws(() => run(options(linked.source, linked.dataDir, { verify: true })),
    /路徑不存在或不安全/);
});

test('apply rejects a target nested inside the immutable source', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const nestedTarget = path.join(fixture.source, 'new-runtime');
  assert.throws(() => run(options(fixture.source, nestedTarget, { apply: true })),
    /source 與 target data-dir 必須彼此分離/);
  assert.equal(fs.existsSync(nestedTarget), false);
});
