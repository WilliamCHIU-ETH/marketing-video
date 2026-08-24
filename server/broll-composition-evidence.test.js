'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyRecordedCompositionEvidence } = require('./broll-composition-evidence');

function fixture() {
  const assetSha256 = 'a'.repeat(64);
  const outputSha256 = 'b'.repeat(64);
  const manifestSha256 = 'c'.repeat(64);
  const placement = {
    clipId: 'broll-01', assetRef: 'asset-video-1', assetSha256,
    startSec: 1, endSec: 2, evidenceLevel: 'reconstructed-after-render',
  };
  const manifest = {
    schemaVersion: 1,
    artifactInputs: [{ path: 'public/broll1.mp4', size: 321, sha256: assetSha256 }],
  };
  const output = { name: 'output.mp4', size: 123, sha256: outputSha256 };
  const graphicBroll = {
    schemaVersion: 1, mode: 'composition-v1',
    cards: [{
      id: 'broll-01', assetRef: 'asset-video-1', assetSha256,
      resolvedPlacement: { startSec: 1, endSec: 2 },
    }],
    provenance: { level: 'reconstructed-after-render', output },
  };
  const job = {
    id: 'job-1', status: 'done', projectId: 'project-1', revisionId: 'v001',
    graphicBroll, timelinePlacements: [placement], outputs: [output],
    renderInputManifest: manifest, renderInputManifestSha256: manifestSha256,
    renderEvidence: {
      schemaVersion: 1, renderInputManifestSha256: manifestSha256, outputs: [output],
    },
  };
  const project = {
    id: 'project-1',
    assets: [{ id: 'asset-video-1', kind: 'video', sha256: assetSha256, size: 321 }],
  };
  const revision = {
    id: 'v001', projectId: 'project-1', jobId: 'job-1', runId: 'job-1', status: 'done',
    assetRefs: ['asset-video-1'], graphicBroll, timelinePlacements: [placement], outputs: [output],
    renderInputManifest: manifest, renderInputManifestSha256: manifestSha256,
    renderEvidence: {
      schemaVersion: 1, renderInputManifestSha256: manifestSha256, outputs: [output],
    },
  };
  return { job, project, revision };
}

test('verifies composition playback only across Project, Revision and render-input evidence', () => {
  const input = fixture();
  assert.deepEqual(verifyRecordedCompositionEvidence(input), {
    status: 'verified', projectId: 'project-1', revisionId: 'v001',
    renderInputManifestSha256: 'c'.repeat(64), cardIds: ['broll-01'],
    output: { name: 'output.mp4', size: 123, sha256: 'b'.repeat(64) },
  });
});

test('fails closed when ownership, selection, placement or render provenance is missing', () => {
  const mutations = [
    (input) => { input.job.projectId = null; },
    (input) => { input.project.assets = []; },
    (input) => { input.revision.assetRefs = []; },
    (input) => { input.revision.timelinePlacements = []; },
    (input) => { input.job.renderInputManifest.artifactInputs = []; },
    (input) => { input.job.renderEvidence.renderInputManifestSha256 = 'd'.repeat(64); },
    (input) => { input.revision.renderEvidence.outputs = []; },
    (input) => { input.revision.outputs = []; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(verifyRecordedCompositionEvidence(input), null);
  }
});
