'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createJobStore } = require('./job-store');
const { createProjectStore } = require('./project-store');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-job-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let tick = 0;
  const nowISO = () => `2026-08-26T08:00:${String(tick++).padStart(2, '0')}.000Z`;
  return {
    dataDir,
    nowISO,
    jobStore: createJobStore({ dataDir, nowISO }),
  };
}

test('writeJobRecord atomically persists mode-0600 JSON and readJob reads it back', (t) => {
  const { jobStore } = fixture(t);
  const job = {
    id: 'run-001',
    status: 'done',
    outputs: [{ name: 'final.mp4', size: 123, sha256: 'a'.repeat(64) }],
  };
  jobStore.writeJobRecord(job);
  assert.deepEqual(jobStore.readJob(job.id), job);
  assert.equal(fs.statSync(jobStore.jobFile(job.id)).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(jobStore.jobDir(job.id)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('RUN_ID rejects path traversal and other illegal ids', (t) => {
  const { jobStore } = fixture(t);
  assert.equal(jobStore.RUN_ID.test('run.OK_2026-08-26'), true);
  for (const id of ['', '../run', 'run/child', '.hidden', 'run id', '/absolute']) {
    assert.throws(() => jobStore.safeRunId(id), /Run ID 不合法/);
  }
  assert.throws(() => jobStore.writeJobRecord({ id: '../escape' }), /Run ID 不合法/);
});

test('saveJob writes the Run and synchronizes Revision plus Project summary', (t) => {
  const { dataDir, nowISO, jobStore } = fixture(t);
  const projectStore = createProjectStore({ dataDir, nowISO, idFactory: () => 'job-store-test' });
  const project = projectStore.create({
    name: 'Job Store Test',
    template: 'tw-morning-report',
    owner: 'Agent',
  });
  const revision = projectStore.addRevision(project.id, {
    jobId: 'run-001',
    runId: 'run-001',
    owner: 'Agent',
    title: 'Before',
    status: 'draft',
    outputs: [],
  });
  const output = {
    name: 'final.mp4',
    mediaType: 'video/mp4',
    size: 123,
    sha256: 'b'.repeat(64),
    archive: 'runtime-data/projects/project-job-store-test/outputs/v001-final.mp4',
  };
  const job = {
    id: 'run-001',
    template: 'tw-morning-report',
    owner: 'Agent',
    title: 'After',
    status: 'done',
    createdAt: '2026-08-26T08:00:00.000Z',
    startedAt: '2026-08-26T08:00:01.000Z',
    finishedAt: '2026-08-26T08:00:02.000Z',
    projectId: project.id,
    revisionId: revision.id,
    revisionNumber: revision.number,
    outputs: [output],
    files: [],
    assetRefs: [],
    workflowMode: 'agent-broll-slot',
    skipGenerate: true,
    noSpeed: true,
  };
  jobStore.saveJob(job, { projectStore });

  assert.deepEqual(jobStore.readJob(job.id), job);
  const savedRevision = projectStore.getRevision(project.id, revision.id);
  assert.equal(savedRevision.jobId, job.id);
  assert.equal(savedRevision.runId, job.id);
  assert.equal(savedRevision.status, 'done');
  assert.equal(savedRevision.title, 'After');
  assert.deepEqual(savedRevision.outputs, [output]);
  assert.deepEqual(savedRevision.options, {
    skipGenerate: true,
    noSpeed: true,
    withAd: false,
    autoApprove: false,
    workflowMode: 'agent-broll-slot',
    controlPolicy: 'pause-before-render',
    graphicBrollMode: 'disabled',
    focusstockBrollMode: 'disabled',
  });
  const summary = projectStore.get(project.id).revisions[0];
  assert.equal(summary.jobId, job.id);
  assert.equal(summary.status, 'done');
  assert.deepEqual(summary.outputs, [output]);
});
