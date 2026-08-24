'use strict';

const crypto = require('node:crypto');

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CARRY_SOURCE_PATH = 'public/focusstock-broll-carry.source.json';
const CARRY_PLAN_PATH = 'src/Focusstock/focusstock-broll.generated.json';
const CARRY_PLANNER_PATH = 'scripts/focusstock-broll-plan.js';
const CARRY_RENDERER_PATH = 'src/Focusstock/FocusstockBrollLayer.tsx';
const PREPARED_PLAN_PATH = 'src/Focusstock/prepared-phone-material.generated.json';

function computeManifestSha256(manifest) {
  const canonical = JSON.stringify(manifest);
  return typeof canonical === 'string'
    ? crypto.createHash('sha256').update(canonical).digest('hex')
    : null;
}

function sameOutput(left, right) {
  return left && right
    && typeof left.name === 'string' && left.name
    && left.name === right.name
    && Number.isSafeInteger(left.size) && left.size > 0 && left.size === right.size
    && SHA256_HEX.test(left.sha256 || '') && left.sha256 === right.sha256;
}

function exactOutput(outputs, expected) {
  if (!Array.isArray(outputs)) return null;
  const matches = outputs.filter((item) => sameOutput(item, expected));
  return matches.length === 1 ? matches[0] : null;
}

function sameLegacyPlacement(left, right, card) {
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

function uniqueIdentity(inputs, relativePath) {
  if (!Array.isArray(inputs)) return null;
  const matches = inputs.filter((input) => input?.path === relativePath);
  const input = matches.length === 1 ? matches[0] : null;
  return input && Number.isSafeInteger(input.size) && input.size > 0
    && SHA256_HEX.test(input.sha256 || '') ? input : null;
}

function uniqueProjectAsset(project, assetRef) {
  const matches = Array.isArray(project?.assets)
    ? project.assets.filter((asset) => asset?.id === assetRef) : [];
  return matches.length === 1 ? matches[0] : null;
}

function uniqueRefs(record) {
  return Array.isArray(record?.assetRefs)
    && new Set(record.assetRefs.map(String)).size === record.assetRefs.length;
}

function sourceCardMatchesPlan(sourceCard, planCard) {
  if (!sourceCard || !planCard) return false;
  const expected = { ...planCard };
  delete expected.disposition;
  delete expected.suppressedBy;
  return JSON.stringify(sourceCard) === JSON.stringify(expected);
}

function sameCarriedPlacement(placement, planCard, planSha256, plan) {
  return placement && placement.kind === 'focusstock-broll-placement'
    && placement.channel === 'focusstock-broll'
    && placement.clipId === planCard.id && placement.cardId === planCard.id
    && placement.ordinal === planCard.ordinal
    && placement.assetRef === planCard.assetRef
    && placement.assetSha256 === planCard.assetSha256
    && placement.assetSize === planCard.assetSize
    && placement.inputName === planCard.inputName
    && placement.timelineBasis === plan.timelineBasis
    && placement.fps === planCard.fps
    && placement.startCharIdx === planCard.startCharIdx
    && placement.endCharIdx === planCard.endCharIdx
    && placement.startSec === planCard.startSec && placement.endSec === planCard.endSec
    && placement.startFrame === planCard.mainStartFrame
    && placement.endFrame === planCard.mainEndFrame
    && placement.durationInFrames === planCard.mainDurationInFrames
    && placement.compositionOffsetFrames === planCard.compositionOffsetFrames
    && placement.compositionStartFrame === planCard.compositionStartFrame
    && placement.compositionEndFrame === planCard.compositionEndFrame
    && placement.disposition === planCard.disposition
    && placement.suppressedBy === planCard.suppressedBy
    && placement.evidenceLevel === 'pre-render-manifest-v1'
    && placement.planSha256 === planSha256
    && placement.parentEvidenceSha256 === plan.parent.evidenceSha256
    && placement.preparedPlanSha256 === plan.prepared.planSha256;
}

function verifyCarriedSpeaker({ job, project, revision, manifest, plan }) {
  const speaker = plan.speaker;
  const asset = uniqueProjectAsset(project, speaker?.assetRef);
  if (!speaker || speaker.inputName !== 'heygen.mp4'
      || !asset || asset.kind !== 'speaker-video' || asset.role != null || asset.origin != null
      || asset.mediaType !== 'video/mp4' || asset.sha256 !== speaker.assetSha256
      || asset.size !== speaker.assetSize || !uniqueRefs(job) || !uniqueRefs(revision)) return false;
  const selectedSpeakerRefs = (record) => record.assetRefs.filter((assetRef) =>
    project.assets.some((item) => item?.id === assetRef && item.kind === 'speaker-video'));
  const manifestInput = uniqueIdentity(manifest.artifactInputs, 'public/heygen.mp4');
  return JSON.stringify(selectedSpeakerRefs(job)) === JSON.stringify([speaker.assetRef])
    && JSON.stringify(selectedSpeakerRefs(revision)) === JSON.stringify([speaker.assetRef])
    && manifestInput?.sha256 === speaker.assetSha256
    && manifestInput?.size === speaker.assetSize;
}

function samePreparedPlacement(placement, plan, assetRef, job) {
  const prepared = plan.prepared;
  const request = job.materialAcquisition;
  const summary = job.materialAcquisitionResult;
  const compiledPlacement = summary?.placement;
  const compositionOffsetFrames = plan.fps;
  const compositionStartFrame = prepared.startFrame + compositionOffsetFrames;
  const compositionEndFrame = prepared.endFrame + compositionOffsetFrames;
  return placement && placement.kind === 'prepared-phone-video'
    && placement.assetRef === assetRef
    && placement.profileId === request?.presentation?.profileId
    && placement.layoutId === request?.placement?.layoutId
    && placement.timelineBasis === plan.timelineBasis
    && placement.visualOwner === 'prepared-phone-video'
    && placement.conflictPolicy === 'suppress-entire-overlapping-placement'
    && placement.fps === prepared.fps
    && placement.startFrame === prepared.startFrame
    && placement.endFrame === prepared.endFrame
    && placement.durationInFrames === prepared.durationInFrames
    && placement.startSec === compiledPlacement?.startSec
    && placement.endSec === compiledPlacement?.endSec
    && compiledPlacement?.fps === prepared.fps
    && compiledPlacement?.startFrame === prepared.startFrame
    && compiledPlacement?.endFrame === prepared.endFrame
    && compiledPlacement?.durationInFrames === prepared.durationInFrames
    && compiledPlacement?.layoutId === request?.placement?.layoutId
    && placement.compositionTimeline === 'Focusstock'
    && placement.compositionOffsetFrames === compositionOffsetFrames
    && placement.compositionStartFrame === compositionStartFrame
    && placement.compositionEndFrame === compositionEndFrame
    && placement.compositionStartSec
      === Number((compositionStartFrame / prepared.fps).toFixed(6))
    && placement.compositionEndSec
      === Number((compositionEndFrame / prepared.fps).toFixed(6))
    && placement.sourceSha256 === prepared.sourceSha256
    && placement.planSha256 === prepared.planSha256
    && SHA256_HEX.test(summary?.focusstockVisualEvidenceSha256 || '')
    && computeManifestSha256(summary.focusstockVisualEvidence)
      === summary.focusstockVisualEvidenceSha256
    && placement.focusstockVisualEvidenceSha256
      === summary.focusstockVisualEvidenceSha256;
}

function verifyCarriedPrepared({ job, project, revision, manifest, plan }) {
  const summary = job.materialAcquisitionResult;
  const prepared = plan.prepared;
  const assetRef = summary?.preparedArtifact?.assetRef;
  const asset = uniqueProjectAsset(project, assetRef);
  if (job.materialAcquisition?.operation !== 'prepared-video'
      || typeof job.materialAcquisition?.presentation?.profileId !== 'string'
      || !job.materialAcquisition.presentation.profileId
      || typeof job.materialAcquisition?.placement?.layoutId !== 'string'
      || !job.materialAcquisition.placement.layoutId
      || JSON.stringify(revision.materialAcquisition) !== JSON.stringify(job.materialAcquisition)
      || JSON.stringify(revision.materialAcquisitionResult) !== JSON.stringify(summary)
      || summary?.placementStatus !== 'compiled' || summary.automaticTimelineUse !== true
      || !Number.isFinite(summary.placement?.startSec) || summary.placement.startSec < 0
      || !Number.isFinite(summary.placement?.endSec)
      || summary.placement.endSec <= summary.placement.startSec
      || summary.compiledPlanSha256 !== prepared.planSha256
      || summary.preparedArtifact?.sha256 !== prepared.sourceSha256
      || !Number.isSafeInteger(summary.preparedArtifact?.size) || summary.preparedArtifact.size <= 0
      || !asset || asset.kind !== 'video' || asset.role !== 'prepared-phone-video'
      || asset.origin !== 'chipk-simulator-capture' || asset.mediaType !== 'video/mp4'
      || asset.sha256 !== prepared.sourceSha256 || asset.size !== summary.preparedArtifact.size
      || !job.assetRefs.includes(assetRef) || !revision.assetRefs.includes(assetRef)) return false;

  const selectedPreparedRefs = (record) => record.assetRefs.filter((selectedRef) =>
    project.assets.some((item) => item?.id === selectedRef && item.role === 'prepared-phone-video'));
  const jobPlacements = job.timelinePlacements.filter((item) => item?.kind === 'prepared-phone-video');
  const revisionPlacements = revision.timelinePlacements
    .filter((item) => item?.kind === 'prepared-phone-video');
  const preparedInput = uniqueIdentity(
    manifest.artifactInputs, 'public/prepared-phone-material.mp4');
  const preparedPlanInput = uniqueIdentity(manifest.artifactInputs, PREPARED_PLAN_PATH);
  return JSON.stringify(selectedPreparedRefs(job)) === JSON.stringify([assetRef])
    && JSON.stringify(selectedPreparedRefs(revision)) === JSON.stringify([assetRef])
    && jobPlacements.length === 1 && revisionPlacements.length === 1
    && samePreparedPlacement(jobPlacements[0], plan, assetRef, job)
    && samePreparedPlacement(revisionPlacements[0], plan, assetRef, job)
    && preparedInput?.sha256 === prepared.sourceSha256
    && preparedInput?.size === summary.preparedArtifact.size
    && preparedPlanInput?.sha256 === prepared.planSha256;
}

function verifyCarriedEvidence({ job, project, revision, graphic, cards, manifest }) {
  const carry = job.focusstockBrollCarryForward;
  const plan = carry?.plan;
  const source = carry?.sourceSnapshot;
  if (manifest.template !== 'focusstock' || manifest.compositionId !== 'Focusstock'
      || manifest.options?.focusstockBrollMode !== 'carried-v1'
      || manifest.options?.preparedPhoneMode !== 'ready-to-place'
      || graphic.style !== 'focusstock-carried-v1'
      || graphic.provenance?.level !== 'pre-render-manifest-v1'
      || !SHA256_HEX.test(graphic.sourceScriptSha256 || '')
      || !SHA256_HEX.test(graphic.planSha256 || '')
      || !carry || carry.schemaVersion !== 1 || carry.mode !== 'carried-v1'
      || carry.status !== 'compiled'
      || carry.parentRevisionId !== plan?.parent?.revisionId
      || carry.sourceInputName !== CARRY_SOURCE_PATH.slice(CARRY_SOURCE_PATH.lastIndexOf('/') + 1)
      || carry.planFile !== CARRY_PLAN_PATH || carry.planSha256 !== graphic.planSha256
      || !plan || !source || !SHA256_HEX.test(carry.sourceSnapshotSha256 || '')
      || plan.parent?.projectId !== project.id
      || revision.parentRevisionId !== plan.parent.revisionId
      || JSON.stringify(revision.assetRefs) !== JSON.stringify(job.assetRefs)
      || graphic.sourceScriptSha256 !== plan.sourceScriptSha256
      || computeManifestSha256(plan) !== carry.planSha256
      || computeManifestSha256(source) !== carry.sourceSnapshotSha256
      || plan.sourceSnapshotSha256 !== carry.sourceSnapshotSha256
      || source.schemaVersion !== 2 || source.mode !== 'carry-source-v1'
      || source.template !== 'focusstock' || source.timelineBasis !== plan.timelineBasis
      || source.fps !== plan.fps || source.intervalSemantics !== plan.intervalSemantics
      || source.sourceScriptSha256 !== plan.sourceScriptSha256
      || JSON.stringify(source.parent) !== JSON.stringify(plan.parent)
      || JSON.stringify(source.speaker) !== JSON.stringify(plan.speaker)
      || !Array.isArray(source.cards) || source.cards.length !== plan.cards?.length
      || source.cards.some((card, index) => !sourceCardMatchesPlan(card, plan.cards[index]))
      || JSON.stringify(revision.focusstockBrollCarryForward) !== JSON.stringify(carry)
      || JSON.stringify(graphic.provenance.parent) !== JSON.stringify(plan.parent)
      || JSON.stringify(graphic.provenance.prepared) !== JSON.stringify(plan.prepared)) return null;

  try {
    require('./focusstock-broll-carry-forward').validateFocusstockBrollCarryPlan(plan);
  } catch (_) { return null; }

  const sourceInput = uniqueIdentity(manifest.artifactInputs, CARRY_SOURCE_PATH);
  const planInput = uniqueIdentity(manifest.artifactInputs, CARRY_PLAN_PATH);
  const plannerIdentity = uniqueIdentity(manifest.rendererIdentity, CARRY_PLANNER_PATH);
  const rendererIdentity = uniqueIdentity(manifest.rendererIdentity, CARRY_RENDERER_PATH);
  const scriptInput = uniqueIdentity(manifest.artifactInputs, 'public/script.txt');
  if (!sourceInput || sourceInput.sha256 !== carry.sourceSnapshotSha256
      || sourceInput.size !== Buffer.byteLength(JSON.stringify(source))
      || !planInput || planInput.sha256 !== carry.planSha256
      || planInput.size !== Buffer.byteLength(JSON.stringify(plan))
      || !plannerIdentity || !rendererIdentity
      || !scriptInput || scriptInput.sha256 !== plan.sourceScriptSha256
      || plan.cards.length !== cards.length
      || !verifyCarriedSpeaker({ job, project, revision, manifest, plan })
      || !verifyCarriedPrepared({ job, project, revision, manifest, plan })) return null;

  const materialized = carry.materialized;
  if (!Array.isArray(materialized) || materialized.length !== plan.cards.length
      || materialized.some((item, index) => {
        const card = plan.cards[index];
        return !item || item.cardId !== card.id || item.assetRef !== card.assetRef
          || item.inputName !== card.inputName || item.size !== card.assetSize
          || item.sha256 !== card.assetSha256 || item.disposition !== card.disposition
          || typeof item.reusedExactBytes !== 'boolean';
      })) return null;

  const carriedPlacement = (item) => item
    && (item.kind === 'focusstock-broll-placement' || item.channel === 'focusstock-broll');
  const jobPlacements = job.timelinePlacements.filter(carriedPlacement);
  const revisionPlacements = revision.timelinePlacements.filter(carriedPlacement);
  if (jobPlacements.length !== cards.length || revisionPlacements.length !== cards.length)
    return null;

  for (const [index, planCard] of plan.cards.entries()) {
    const card = cards[index];
    if (!card || card.id !== planCard.id || card.ordinal !== planCard.ordinal
        || card.assetRef !== planCard.assetRef || card.assetSha256 !== planCard.assetSha256
        || card.assetSize !== planCard.assetSize
        || card.startCharIdx !== planCard.startCharIdx || card.endCharIdx !== planCard.endCharIdx
        || card.resolvedPlacement?.startSec !== planCard.startSec
        || card.resolvedPlacement?.endSec !== planCard.endSec
        || card.disposition !== planCard.disposition
        || card.suppressedBy !== planCard.suppressedBy
        || !job.assetRefs.includes(card.assetRef) || !revision.assetRefs.includes(card.assetRef))
      return null;
    const asset = uniqueProjectAsset(project, card.assetRef);
    if (!asset || asset.kind !== 'video' || asset.role != null || asset.origin != null
        || asset.mediaType !== 'video/mp4' || asset.sha256 !== card.assetSha256
        || asset.size !== card.assetSize) return null;
    const artifact = uniqueIdentity(manifest.artifactInputs, `public/${planCard.inputName}`);
    if (!artifact || artifact.sha256 !== planCard.assetSha256
        || artifact.size !== planCard.assetSize) return null;
    const matchingJobPlacements = jobPlacements.filter((item) => item.clipId === card.id
      || item.cardId === card.id);
    const matchingRevisionPlacements = revisionPlacements.filter((item) => item.clipId === card.id
      || item.cardId === card.id);
    if (matchingJobPlacements.length !== 1 || matchingRevisionPlacements.length !== 1
        || !sameCarriedPlacement(matchingJobPlacements[0], planCard, carry.planSha256, plan)
        || !sameCarriedPlacement(matchingRevisionPlacements[0], planCard, carry.planSha256, plan))
      return null;
  }

  return {
    renderedCardIds: cards.filter((card) => card.disposition === 'rendered')
      .map((card) => card.id),
    suppressedCardIds: cards.filter((card) => card.disposition === 'suppressed_by_prepared')
      .map((card) => card.id),
    rendererIdentities: [plannerIdentity, rendererIdentity].map((identity) => ({ ...identity })),
    parent: {
      projectId: plan.parent.projectId,
      revisionId: plan.parent.revisionId,
      runId: plan.parent.runId,
      output: { ...plan.parent.output },
    },
  };
}

function verifyRecordedCompositionEvidence({ job, project, revision }) {
  const graphic = job && job.graphicBroll;
  const provenance = graphic && graphic.provenance;
  const expectedOutput = provenance && provenance.output;
  const cards = graphic && graphic.cards;
  const manifest = job && job.renderInputManifest;
  const carry = job && job.focusstockBrollCarryForward;
  const carriedSignals = [
    provenance?.level === 'pre-render-manifest-v1',
    graphic?.style === 'focusstock-carried-v1',
    manifest?.options?.focusstockBrollMode === 'carried-v1',
    carry?.mode === 'carried-v1',
  ];
  const carried = carriedSignals.some(Boolean);
  if (carried && !carriedSignals.every(Boolean)) return null;
  if (!job || job.status !== 'done' || job.pruned || !job.projectId || !job.revisionId
      || !project || project.id !== job.projectId
      || !revision || revision.id !== job.revisionId || revision.projectId !== project.id
      || revision.status !== 'done' || revision.jobId !== job.id || revision.runId !== job.id
      || !graphic || graphic.schemaVersion !== 1 || graphic.mode !== 'composition-v1'
      || !Array.isArray(cards) || cards.length < 1 || cards.length > 7
      || new Set(cards.map((card) => card && card.id)).size !== cards.length
      || !provenance || !['reconstructed-after-render', 'pre-render-manifest-v1']
        .includes(provenance.level)
      || !expectedOutput || !Array.isArray(project.assets) || !Array.isArray(revision.assetRefs)
      || !Array.isArray(job.timelinePlacements) || !Array.isArray(revision.timelinePlacements))
    return null;

  const manifestSha256 = job.renderInputManifestSha256;
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

  let carriedResult = null;
  if (carried) {
    carriedResult = verifyCarriedEvidence({ job, project, revision, graphic, cards, manifest });
    if (!carriedResult) return null;
  } else {
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
          || !sameLegacyPlacement(jobPlacements[0], revisionPlacements[0], card)) return null;
    }
  }

  const outputCollections = [
    job.outputs, revision.outputs, renderEvidence.outputs, revision.renderEvidence.outputs,
  ];
  if (outputCollections.some((outputs) => carried
    ? outputs?.length !== 1 || !exactOutput(outputs, expectedOutput)
    : !outputs?.find((item) => sameOutput(item, expectedOutput)))) return null;

  return {
    status: 'verified',
    projectId: project.id,
    revisionId: revision.id,
    renderInputManifestSha256: manifestSha256,
    cardIds: cards.map((card) => card.id),
    ...(carriedResult || {}),
    output: {
      name: expectedOutput.name,
      size: expectedOutput.size,
      sha256: expectedOutput.sha256,
    },
  };
}

module.exports = { verifyRecordedCompositionEvidence };
