'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP = path.resolve(__dirname, '..');
const TMP = fs.realpathSync('/tmp');

const modulePromise = import('./broll-slot.mjs');

function revisions() {
  return {
    latestRevision: 3,
    revisions: [
      { id: 'v001', number: 1, status: 'done' },
      { id: 'v002', number: 2, status: 'done' },
      { id: 'v003', number: 3, status: 'done' },
    ],
  };
}

function slots(prefix) {
  return Array.from({ length: 12 }, (_, index) => {
    const slotId = String(index + 1).padStart(2, '0');
    return {
      slotId,
      promptSha256: `prompt-${slotId}`,
      outputSha256: `${prefix}-${slotId}`,
    };
  });
}

test('selectBaseRevision defaults to latest done and validates explicit base', async () => {
  const { selectBaseRevision } = await modulePromise;
  assert.deepEqual(selectBaseRevision(revisions()), {
    id: 'v003', number: 3, status: 'done',
  });
  assert.deepEqual(selectBaseRevision(revisions(), 'v2'), {
    id: 'v002', number: 2, status: 'done',
  });
  assert.throws(() => selectBaseRevision(revisions(), 'v009'), /找不到 base Revision v009/);
  const draft = revisions();
  draft.revisions[2].status = 'draft';
  assert.throws(() => selectBaseRevision(draft), /v003 不是 done/);
});

test('source HTML lineage follows parents and skips render-wrapper anchors', async () => {
  const { resolveLineageSource, traceRevisionLineage } = await modulePromise;
  const manifests = [
    { id: 'v004', parentRevisionId: 'v003' },
    { id: 'v003', parentRevisionId: 'v001' },
    { id: 'v001' },
  ];
  const revisionChain = traceRevisionLineage(manifests, 'v004');
  assert.deepEqual(revisionChain, ['v004', 'v003', 'v001']);
  const sourcesByRevision = {
    v004: [{ fileName: '05-limitup-fact.html', sourcePath: 'revision-artifacts/v004/compositions/05-limitup-fact.html' }],
    v003: [{ fileName: '03-us-split.html', sourcePath: 'revision-artifacts/v003/compositions/03-us-split.html' }],
    v001: [
      { fileName: '03-us-split.html', sourcePath: 'archive-card-v1/compositions/03-us-split.html' },
      { fileName: '05-limitup-fact.html', sourcePath: 'archive-card-v1/compositions/05-limitup-fact.html' },
    ],
  };
  const fallbackSlotsByRevision = { v004: ['05'] };
  assert.deepEqual(resolveLineageSource({
    revisionChain,
    slotId: '05',
    fileName: '05-limitup-fact.html',
    sourcesByRevision,
    fallbackSlotsByRevision,
  }), {
    revisionId: 'v001',
    sourcePath: 'archive-card-v1/compositions/05-limitup-fact.html',
  });
  assert.deepEqual(resolveLineageSource({
    revisionChain,
    slotId: '03',
    fileName: '03-us-split.html',
    sourcesByRevision,
    fallbackSlotsByRevision,
  }), {
    revisionId: 'v003',
    sourcePath: 'revision-artifacts/v003/compositions/03-us-split.html',
  });
});

test('prompt snapshots must remain byte-identical to all 12 working copies', async () => {
  const { validatePromptSnapshotIdentity } = await modulePromise;
  const rows = Array.from({ length: 12 }, (_, index) => {
    const slotId = String(index + 1).padStart(2, '0');
    const workingBytes = Buffer.from(`slot ${slotId}\n動態：test\n`, 'utf8');
    return { slotId, workingBytes, snapshotBytes: Buffer.from(workingBytes) };
  });
  assert.equal(validatePromptSnapshotIdentity(rows), true);
  const changed = rows.map((row) => ({ ...row, snapshotBytes: Buffer.from(row.snapshotBytes) }));
  changed[4].snapshotBytes[0] ^= 1;
  assert.throws(
    () => validatePromptSnapshotIdentity(changed),
    /prompt snapshot 05 與工作副本 byte 不一致/,
  );
});

test('compareSlotHashes requires exactly one changed output and current prompt hash', async () => {
  const { compareSlotHashes } = await modulePromise;
  const base = slots('base');
  const next = slots('base');
  next[4] = {
    ...next[4],
    outputSha256: 'new-05',
    promptSha256: 'current-prompt-05',
  };
  const rows = compareSlotHashes(base, next, '05', 'current-prompt-05');
  assert.equal(rows.filter((row) => row.result === 'same').length, 11);
  assert.deepEqual(rows.find((row) => row.slotId === '05'), { slotId: '05', result: 'diff' });

  const reusedChanged = structuredClone(next);
  reusedChanged[0].outputSha256 = 'unexpected-01';
  assert.throws(
    () => compareSlotHashes(base, reusedChanged, '05', 'current-prompt-05'),
    /非指定格 01 outputSha256 改變/,
  );
  const targetSame = slots('base');
  targetSame[4].promptSha256 = 'current-prompt-05';
  assert.throws(
    () => compareSlotHashes(base, targetSame, '05', 'current-prompt-05'),
    /指定格 05 outputSha256 沒有改變/,
  );
  assert.throws(
    () => compareSlotHashes(base, next, '05', 'wrong-prompt'),
    /promptSha256 與當前 prompt.txt 不符/,
  );
});

test('changed marker boundary updates slot duration, cards and staged provenance', async () => {
  const {
    visualSegmentsFromLedger,
    deriveCardsFromStagedLedger,
    createLedgerRenderInputManifest,
    synchronizeCompositionDuration,
  } = await modulePromise;
  const visualSegments = visualSegmentsFromLedger({ segments: [
    { id: '00', startSec: 0, endSec: 1.85, visual: { mode: 'none' } },
    { id: '05', startSec: 20, endSec: 26, durationSec: 6,
      charRange: [82, 108], visual: { mode: 'broll' } },
  ] });
  assert.deepEqual(visualSegments.map(({ id, startSec, endSec, durationSec }) => ({
    id, startSec, endSec, durationSec,
  })), [{ id: '05', startSec: 20, endSec: 26, durationSec: 6 }]);
  const projectDir = path.join(path.parse(process.cwd()).root, 'project-fixture');
  const cards = deriveCardsFromStagedLedger({
    baseCards: [{ ordinal: 5, resolvedPlacement: { startSec: 19.52, endSec: 25.63 } }],
    nextItems: [{ slotId: '05', source: path.join(projectDir, 'revision-artifacts/v007/renders/05.mp4'),
      sha256: 'a'.repeat(64), size: 123 }],
    visualSegments,
    projectDir,
  });
  assert.deepEqual(cards[0].resolvedPlacement, { startSec: 20, endSec: 26 });
  assert.deepEqual([cards[0].startCharIdx, cards[0].endCharIdx], [82, 108]);
  const renderInput = createLedgerRenderInputManifest({
    canonicalPath: 'segment-ledger.v2.json', canonicalSha256: 'b'.repeat(64),
    canonicalVisualForm: 'fullframe',
    stagedPath: 'revision-artifacts/v007/segment-ledger.json', stagedSha256: 'c'.repeat(64),
    stagedVisualForm: 'card', targetSegment: visualSegments[0],
  });
  assert.equal(renderInput.manifest.stagedLedger.path, 'revision-artifacts/v007/segment-ledger.json');
  assert.equal(renderInput.manifest.targetVisual.durationSec, 6);
  assert.equal(renderInput.manifest.stagingTransform.visualForm.applied, true);
  assert.match(renderInput.sha256, /^[0-9a-f]{64}$/);
  const html = '<div id="root" data-duration="6.11"></div>';
  assert.equal(synchronizeCompositionDuration(html, 6), '<div id="root" data-duration="6"></div>');
});

test('visual segment count, not a hard-coded twelve, owns hash comparison', async () => {
  const { compareSlotHashes } = await modulePromise;
  const base = [
    { slotId: '01', promptSha256: 'p1', outputSha256: 'a' },
    { slotId: '05', promptSha256: 'p5', outputSha256: 'b' },
  ];
  const next = structuredClone(base);
  next[1] = { ...next[1], promptSha256: 'new-p5', outputSha256: 'changed' };
  assert.deepEqual(compareSlotHashes(base, next, '05', 'new-p5'), [
    { slotId: '01', result: 'same' },
    { slotId: '05', result: 'diff' },
  ]);
});

test('job IDs include project identity and reject a cross-Project collision', async () => {
  const { assertJobIdAvailable, createRunnerStores, formatJobId } = await modulePromise;
  const when = new Date('2026-08-26T11:35:42.000Z');
  const firstProject = 'project-shared-prefix-abcdefghijkl-0001';
  const secondProject = 'project-shared-prefix-abcdefghijkl-0002';
  const first = formatJobId('05', 'v009', firstProject, when);
  const second = formatJobId('05', 'v009', secondProject, when);
  assert.notEqual(first, second);
  assert.match(first, /^slot-05-v009-shared-prefix-abcdef-[0-9a-f]{10}-20260826-113542$/);
  assert.match(first, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

  const dataDir = fs.mkdtempSync(path.join(TMP, 'broll-slot-job-collision-'));
  const { jobStore } = createRunnerStores({
    dataDir,
    nowISO: () => when.toISOString(),
    idFactory: () => 'unused',
  });
  jobStore.writeJobRecord({
    id: first,
    projectId: firstProject,
    revisionId: 'v009',
  });
  assert.throws(
    () => assertJobIdAvailable(jobStore, {
      jobId: first,
      projectId: 'project-other',
      revisionId: 'v009',
    }),
    /Run ID collision.*已屬於 Project project-shared-prefix-abcdefghijkl-0001.*project-other/,
  );
});

test('prepare workspace rollback removes partial staging and permits retry', async () => {
  const { createPrepareWorkspace } = await modulePromise;
  const root = fs.mkdtempSync(path.join(TMP, 'broll-slot-prepare-transaction-'));
  const artifacts = path.join(root, 'revision-artifacts');
  fs.mkdirSync(artifacts);
  const finalWorkdir = path.join(artifacts, 'v009');

  const failed = createPrepareWorkspace(finalWorkdir, { token: 'failed-stage' });
  fs.mkdirSync(path.join(failed.stagingWorkdir, 'assets'));
  fs.writeFileSync(path.join(failed.stagingWorkdir, 'assets', 'partial.bin'), 'partial');
  assert.deepEqual(failed.rollback(), { removed: true, published: false });
  assert.equal(fs.existsSync(failed.stagingWorkdir), false);
  assert.equal(fs.existsSync(finalWorkdir), false);

  const retry = createPrepareWorkspace(finalWorkdir, { token: 'retry' });
  fs.writeFileSync(path.join(retry.stagingWorkdir, 'broll-slot-state.json'), '{}');
  assert.equal(retry.publish(), finalWorkdir);
  assert.equal(fs.existsSync(retry.stagingWorkdir), false);
  assert.equal(fs.existsSync(path.join(finalWorkdir, 'broll-slot-state.json')), true);
});

test('post-save validation rollback removes owned Job and aborts Revision', async () => {
  const { createRunnerStores, rollbackFinishMetadata } = await modulePromise;
  const dataDir = fs.mkdtempSync(path.join(TMP, 'broll-slot-metadata-rollback-'));
  let id = 0;
  const { store, jobStore } = createRunnerStores({
    dataDir,
    nowISO: () => '2026-08-26T11:35:42.000Z',
    idFactory: () => `transaction-${++id}`,
  });
  const project = store.create({ name: 'Transaction fixture', template: 'fixture', owner: 'test' });
  const base = store.addRevision(project.id, { jobId: 'base-run', runId: 'base-run', status: 'draft' });
  store.updateRevision(project.id, base.id, { status: 'done', outputs: [] });
  const draft = store.addRevision(project.id, {
    jobId: 'slot-05-v002-transaction',
    runId: 'slot-05-v002-transaction',
    status: 'draft',
  });
  const job = {
    id: draft.jobId,
    projectId: project.id,
    revisionId: draft.id,
    revisionNumber: draft.number,
    status: 'done',
    outputs: [],
  };
  jobStore.saveJob(job, { projectStore: store });
  assert.equal(fs.existsSync(jobStore.jobDir(job.id)), true);
  assert.equal(store.getRevision(project.id, draft.id).status, 'done');

  const rollback = rollbackFinishMetadata({
    store,
    jobStore,
    projectId: project.id,
    revisionId: draft.id,
    jobId: job.id,
    jobSaveAttempted: true,
    revisionAdded: true,
  });
  assert.deepEqual(rollback.job, { removed: true });
  assert.equal(rollback.revision.aborted, true);
  assert.equal(fs.existsSync(jobStore.jobDir(job.id)), false);
  assert.equal(store.getRevision(project.id, draft.id), null);
  assert.equal(store.get(project.id).latestRevision, 1);
});

test('prepare stages each unique ledger audio source with identical bytes', async () => {
  const { stageLedgerAudioSources } = await modulePromise;
  const projectDir = fs.mkdtempSync(path.join(TMP, 'broll-slot-audio-project-'));
  const workdir = path.join(projectDir, 'revision-artifacts', 'v002');
  fs.mkdirSync(path.join(projectDir, 'avatar'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'recordings'), { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'avatar', 'speaker-a.mp4'), 'speaker-a');
  fs.writeFileSync(path.join(projectDir, 'recordings', 'speaker-b.wav'), 'speaker-b-longer');
  const ledger = { segments: [
    { id: '00', audio: { src: 'avatar/speaker-a.mp4', start: 0, end: 1 } },
    { id: '01', audio: { src: 'avatar/speaker-a.mp4', start: 1, end: 2 } },
    { id: '02', audio: { src: 'recordings/speaker-b.wav', start: 0, end: 1 } },
  ] };
  const rows = stageLedgerAudioSources({ projectDir, workdir, ledger });
  assert.deepEqual(rows.map((row) => row.src), [
    'avatar/speaker-a.mp4',
    'recordings/speaker-b.wav',
  ]);
  for (const row of rows) {
    const source = fs.readFileSync(path.join(projectDir, row.src));
    const staged = fs.readFileSync(path.join(workdir, row.src));
    assert.deepEqual(staged, source);
    assert.equal(row.size, source.length);
    assert.equal(row.sha256, crypto.createHash('sha256').update(source).digest('hex'));
  }
});

test('final output is retry-safe after validation or persistence failure', async () => {
  const { createRetrySafeFinalOutput } = await modulePromise;
  const outputs = fs.mkdtempSync(path.join(TMP, 'broll-slot-output-'));
  const finalFile = path.join(outputs, 'v008-slot05-final.mp4');

  const failedValidation = createRetrySafeFinalOutput(finalFile, { token: 'validation-failure' });
  fs.writeFileSync(failedValidation.tempFile, 'rendered-but-invalid');
  assert.throws(() => { throw new Error('simulated verifyFinalMedia failure'); }, /verifyFinalMedia/);
  assert.deepEqual(failedValidation.rollback(null), {
    removedTemp: true, removedPublished: false, publishedConflict: false,
  });
  assert.equal(fs.existsSync(finalFile), false);

  const failedPersistence = createRetrySafeFinalOutput(finalFile, { token: 'persistence-failure' });
  fs.writeFileSync(failedPersistence.tempFile, 'rendered-and-verified');
  const bytes = fs.readFileSync(failedPersistence.tempFile);
  const evidence = {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  failedPersistence.publish(evidence);
  assert.equal(fs.existsSync(finalFile), true);
  assert.deepEqual(failedPersistence.rollback(evidence), {
    removedTemp: false, removedPublished: true, publishedConflict: false,
  });
  assert.equal(fs.existsSync(finalFile), false);

  const retry = createRetrySafeFinalOutput(finalFile, { token: 'retry-success' });
  fs.writeFileSync(retry.tempFile, bytes);
  assert.equal(retry.publish(evidence), finalFile);
  assert.deepEqual(fs.readFileSync(finalFile), bytes);
});

test('runner honors an external DATA_DIR for project validation and stores', async () => {
  const { createRunnerStores, resolveRunnerDataDir, validateProjectDir } = await modulePromise;
  const dataDir = fs.mkdtempSync(path.join(TMP, 'broll-slot-data-dir-'));
  const projectId = 'project-external-data-dir';
  const projectDir = path.join(dataDir, 'projects', projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: projectId,
    name: 'External fixture',
    latestRevision: 0,
    revisions: [],
    assets: [],
  }, null, 2)}\n`);
  const resolved = resolveRunnerDataDir({ TEST_MODE: '1', DATA_DIR: dataDir });
  assert.equal(resolved, dataDir);
  assert.equal(resolveRunnerDataDir({}), path.join(APP, 'runtime-data'));
  assert.equal(validateProjectDir(projectDir, { dataDir }).projectDir, projectDir);
  const { store, jobStore } = createRunnerStores({
    dataDir,
    nowISO: () => '2026-08-26T00:00:00.000Z',
    idFactory: () => 'unused',
  });
  assert.equal(store.projectsDir, path.join(dataDir, 'projects'));
  assert.equal(jobStore.jobsDir, path.join(dataDir, 'jobs'));
  const foreignDataDir = fs.mkdtempSync(path.join(TMP, 'broll-slot-foreign-data-dir-'));
  fs.mkdirSync(path.join(foreignDataDir, 'projects'));
  assert.throws(
    () => validateProjectDir(projectDir, { dataDir: foreignDataDir }),
    /Project 不在 DATA_DIR\/projects 內/,
  );
});

test('validateManifestIdentity matches summary, revision, outputs and file evidence', async () => {
  const { validateManifestIdentity } = await modulePromise;
  const output = {
    name: 'final.mp4',
    mediaType: 'video/mp4',
    size: 123,
    sha256: 'a'.repeat(64),
    archive: 'runtime-data/projects/project-a/outputs/v004-slot05-final.mp4',
  };
  const revision = {
    id: 'v004',
    number: 4,
    jobId: 'slot-05-v004-20260826-1205',
    runId: 'slot-05-v004-20260826-1205',
    status: 'done',
    outputs: [output],
  };
  const project = {
    revisions: [{
      id: revision.id,
      number: revision.number,
      jobId: revision.jobId,
      status: revision.status,
      outputs: [output],
    }],
  };
  assert.equal(validateManifestIdentity({
    project,
    revision,
    output,
    fileEvidence: { size: 123, sha256: 'a'.repeat(64) },
  }), true);

  const badSummary = structuredClone(project);
  badSummary.revisions[0].jobId = 'other-run';
  assert.throws(
    () => validateManifestIdentity({
      project: badSummary,
      revision,
      output,
      fileEvidence: { size: 123, sha256: 'a'.repeat(64) },
    }),
    /summary\/revision jobId 不一致/,
  );
  assert.throws(
    () => validateManifestIdentity({
      project,
      revision,
      output,
      fileEvidence: { size: 124, sha256: 'a'.repeat(64) },
    }),
    /size\/sha256 與檔案不符/,
  );
});
