'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

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
