'use strict';

const assert = require('node:assert/strict');
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
