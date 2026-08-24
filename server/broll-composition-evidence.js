'use strict';

const crypto = require('node:crypto');

const SHA256_HEX = /^[0-9a-f]{64}$/;

function computeManifestSha256(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function sameOutput(left, right) {
  return left && right
    && typeof left.name === 'string' && left.name
    && left.name === right.name
    && Number.isSafeInteger(left.size) && left.size > 0 && left.size === right.size
    && SHA256_HEX.test(left.sha256 || '') && left.sha256 === right.sha256;
}

function samePlacement(left, right, card) {
  if (!left || !right || !card) return false;
  return (left.clipId === card.id || left.cardId === card.id)
    && (right.clipId === card.id || right.cardId === card.id)
    && left.assetRef === card.assetRef && right.assetRef === card.assetRef
    && left.assetSha256 === card.assetSha256 && right.assetSha256 === card.assetSha256
    && left.startSec === card.resolvedPlacement.startSec
    && right.startSec === card.resolvedPlacement.startSec
    && left.endSec === card.resolvedPlacement.endSec
    && right.endSec === card.resolvedPlacement.endSec
    && left.evidenceLevel === 'reconstructed-after-render'
    && right.evidenceLevel === 'reconstructed-after-render';
}

function verifyRecordedCompositionEvidence({ job, project, revision }) {
  const graphic = job && job.graphicBroll;
  const provenance = graphic && graphic.provenance;
  const expectedOutput = provenance && provenance.output;
  const cards = graphic && graphic.cards;
  if (!job || job.status !== 'done' || job.pruned || !job.projectId || !job.revisionId
      || !project || project.id !== job.projectId
      || !revision || revision.id !== job.revisionId || revision.projectId !== project.id
      || revision.status !== 'done' || revision.jobId !== job.id || revision.runId !== job.id
      || !graphic || graphic.schemaVersion !== 1 || graphic.mode !== 'composition-v1'
      || !Array.isArray(cards) || cards.length < 1 || cards.length > 7
      || new Set(cards.map((card) => card && card.id)).size !== cards.length
      || !provenance || provenance.level !== 'reconstructed-after-render'
      || !expectedOutput || !Array.isArray(project.assets) || !Array.isArray(revision.assetRefs)
      || !Array.isArray(job.timelinePlacements) || !Array.isArray(revision.timelinePlacements)) return null;

  const manifestSha256 = job.renderInputManifestSha256;
  const manifest = job.renderInputManifest;
  const renderEvidence = job.renderEvidence;
  if (!SHA256_HEX.test(manifestSha256 || '')
      || !manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifactInputs)
      || manifestSha256 !== computeManifestSha256(manifest)
      || !renderEvidence || renderEvidence.schemaVersion !== 1
      || renderEvidence.renderInputManifestSha256 !== manifestSha256
      || !Array.isArray(renderEvidence.outputs)
      || !revision.renderEvidence || revision.renderEvidence.schemaVersion !== 1
      || revision.renderEvidence.renderInputManifestSha256 !== manifestSha256
      || !Array.isArray(revision.renderEvidence.outputs)
      || revision.renderInputManifestSha256 !== manifestSha256
      || JSON.stringify(revision.graphicBroll) !== JSON.stringify(graphic)
      || JSON.stringify(revision.renderInputManifest) !== JSON.stringify(manifest)) return null;

  const revisionRefs = new Set(revision.assetRefs.map(String));
  for (const card of cards) {
    const placement = card && card.resolvedPlacement;
    if (!card || typeof card.id !== 'string' || !card.id
        || typeof card.assetRef !== 'string' || !card.assetRef
        || !SHA256_HEX.test(card.assetSha256 || '')
        || !placement || !Number.isFinite(placement.startSec) || placement.startSec < 0
        || !Number.isFinite(placement.endSec) || placement.endSec <= placement.startSec
        || !revisionRefs.has(card.assetRef)) return null;
    const asset = project.assets.find((item) => item && item.id === card.assetRef);
    if (!asset || asset.kind !== 'video' || asset.sha256 !== card.assetSha256
        || !Number.isSafeInteger(asset.size) || asset.size <= 0) return null;
    if (!manifest.artifactInputs.some((input) => input && input.sha256 === asset.sha256
        && input.size === asset.size)) return null;
    const jobPlacements = job.timelinePlacements.filter((item) => item
      && (item.clipId === card.id || item.cardId === card.id));
    const revisionPlacements = revision.timelinePlacements.filter((item) => item
      && (item.clipId === card.id || item.cardId === card.id));
    if (jobPlacements.length !== 1 || revisionPlacements.length !== 1
        || !samePlacement(jobPlacements[0], revisionPlacements[0], card)) return null;
  }

  const jobOutput = (job.outputs || []).find((item) => sameOutput(item, expectedOutput));
  const revisionOutput = (revision.outputs || []).find((item) => sameOutput(item, expectedOutput));
  const renderedOutput = renderEvidence.outputs.find((item) => sameOutput(item, expectedOutput));
  const revisionRenderedOutput = revision.renderEvidence.outputs
    .find((item) => sameOutput(item, expectedOutput));
  if (!jobOutput || !revisionOutput || !renderedOutput || !revisionRenderedOutput) return null;

  return {
    status: 'verified',
    projectId: project.id,
    revisionId: revision.id,
    renderInputManifestSha256: manifestSha256,
    cardIds: cards.map((card) => card.id),
    output: {
      name: expectedOutput.name,
      size: expectedOutput.size,
      sha256: expectedOutput.sha256,
    },
  };
}

module.exports = { verifyRecordedCompositionEvidence };
