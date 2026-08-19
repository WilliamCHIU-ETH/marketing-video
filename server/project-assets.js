'use strict';

const fs = require('fs');

function appendBestEffort(appendLog, job, message) {
  try { appendLog(job, message); } catch (_) {}
}

/**
 * Preserve a paid speaker video without ever replacing the preparation error that led here.
 * Returning false means there was nothing usable to capture, or the best-effort rescue failed.
 */
function capturePaidSpeakerAfterFailure({
  job,
  speakerFile,
  projectStore,
  saveJob,
  appendLog,
}) {
  if (!job.projectId || !job.revisionId || job.skipGenerate) return false;
  try {
    if (!fs.existsSync(speakerFile)) return false;
    const stat = fs.statSync(speakerFile);
    if (!stat.isFile() || stat.size === 0) return false;
    const asset = projectStore.ingestAsset(job.projectId, speakerFile, {
      originalName: 'heygen.mp4',
      kind: 'speaker-video',
    });
    job.assetRefs ||= [];
    if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
    saveJob(job);
    appendBestEffort(appendLog, job,
      '\n🛟 後續流程失敗，但已把付費產生的 heygen.mp4 保存到影片專案。\n');
    return true;
  } catch (captureError) {
    appendBestEffort(appendLog, job,
      `\n⚠️ 後續流程失敗，且無法保存已產生的 heygen.mp4：${captureError.message}\n`);
    return false;
  }
}

module.exports = { capturePaidSpeakerAfterFailure };
