'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

function revisionOptionsFromJob(job) {
  return {
    skipGenerate: !!job.skipGenerate,
    noSpeed: !!job.noSpeed,
    withAd: !!job.withAd,
    autoApprove: !!job.autoApprove,
    workflowMode: job.workflowMode || 'manual-assets',
    controlPolicy: job.controlPolicy || 'pause-before-render',
    graphicBrollMode: job.graphicBrollMode || 'disabled',
    focusstockBrollMode: job.focusstockBrollMode || 'disabled',
  };
}

function revisionPatchFromJob(job, optionsFromJob = revisionOptionsFromJob) {
  return {
    jobId: job.id,
    runId: job.id,
    status: job.status,
    owner: job.owner,
    title: job.title,
    options: optionsFromJob(job),
    assetRefs: job.assetRefs || [],
    files: job.files || [],
    outputs: job.outputs || [],
    archived: job.archived || [],
    submittedAt: job.submittedAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    ...(job.workflowMode ? {
      workflowMode: job.workflowMode,
      controlPolicy: job.controlPolicy || null,
      stage: job.stage || null,
      failedStage: job.failedStage || null,
      cancelRequestedAt: job.cancelRequestedAt || null,
      cancelledAt: job.cancelledAt || null,
      graphicBroll: job.graphicBroll || null,
      timelinePlacements: job.timelinePlacements || [],
      renderInputManifest: job.renderInputManifest || null,
      renderInputManifestSha256: job.renderInputManifestSha256 || null,
      renderEvidence: job.renderEvidence || null,
      focusstockVisualInputs: job.focusstockVisualInputs || [],
      focusstockBrollCarryForward: job.focusstockBrollCarryForward || null,
    } : {}),
    ...(job.materialAcquisition ? { materialAcquisition: job.materialAcquisition } : {}),
    ...(job.materialAcquisitionResult
      ? { materialAcquisitionResult: job.materialAcquisitionResult } : {}),
  };
}

function atomicWriteFile(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode, flag: 'wx' });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

function createJobStore({ dataDir, nowISO = () => new Date().toISOString() }) {
  if (!dataDir) throw new Error('dataDir 不可為空');
  if (typeof nowISO !== 'function') throw new Error('nowISO 必須是函數');
  const jobsDir = path.join(path.resolve(dataDir), 'jobs');

  function safeRunId(id) {
    const value = String(id || '');
    if (!RUN_ID.test(value)) throw new Error('Run ID 不合法');
    return value;
  }

  function jobDir(id) {
    return path.join(jobsDir, safeRunId(id));
  }

  function jobFile(id) {
    return path.join(jobDir(id), 'job.json');
  }

  function readJob(id) {
    const expectedId = safeRunId(id);
    const file = jobFile(expectedId);
    if (!fs.existsSync(file)) return null;
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!job || job.id !== expectedId) throw new Error('Run job.json identity 不一致');
    return job;
  }

  function writeJobRecord(job) {
    if (!job || typeof job !== 'object') throw new Error('Job 不合法');
    ensureDir(jobDir(job.id));
    atomicWriteFile(jobFile(job.id), JSON.stringify(job, null, 2));
  }

  function saveJob(job, {
    projectStore,
    revisionOptionsFromJob: optionsFromJob = revisionOptionsFromJob,
  } = {}) {
    writeJobRecord(job);
    if (job.projectId && job.revisionId) {
      if (!projectStore || typeof projectStore.updateRevision !== 'function'
          || typeof optionsFromJob !== 'function') {
        throw new Error('Project／Revision job state 無法同步');
      }
      const updatedRevision = projectStore.updateRevision(
        job.projectId,
        job.revisionId,
        revisionPatchFromJob(job, optionsFromJob),
      );
      if (!updatedRevision) throw new Error('Project／Revision job state 無法同步');
    }
  }

  return {
    jobsDir,
    RUN_ID,
    safeRunId,
    jobDir,
    jobFile,
    readJob,
    writeJobRecord,
    saveJob,
  };
}

module.exports = {
  createJobStore,
  revisionOptionsFromJob,
  revisionPatchFromJob,
};
