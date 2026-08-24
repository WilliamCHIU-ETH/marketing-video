'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRecordedCompositionEvidence } = require('./broll-composition-evidence');
const { halfOpenFrameIntervalsOverlap } = require(
  '../src/Focusstock/focusstock-half-open');

const SCHEMA_VERSION = 2;
const SOURCE_MODE = 'carry-source-v1';
const PLAN_MODE = 'carried-v1';
const TEMPLATE = 'focusstock';
const TIMELINE_BASIS = 'focusstock-main-v1';
const FPS = 30;
const COMPOSITION_OFFSET_FRAMES = FPS;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_MP4_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/i;
const RESERVED_BROLL_INPUTS = new Set([
  'heygen.mp4',
  'prepared-phone-material.mp4',
]);

class FocusstockBrollCarryForwardError extends Error {
  constructor(code, reason, message, details = null) {
    super(message);
    this.name = 'FocusstockBrollCarryForwardError';
    this.code = code;
    this.reason = reason;
    if (details != null) this.details = details;
  }
}

function fail(code, reason, message, details) {
  throw new FocusstockBrollCarryForwardError(code, reason, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  return JSON.stringify(value);
}

function canonicalRecord(value) {
  const canonical = canonicalize(value);
  return { canonical, sha256: sha256(Buffer.from(canonical)) };
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    do {
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function regularFileIdentity(file, expected, code, reason, label) {
  let stat;
  let actualSha256 = null;
  try {
    stat = typeof file === 'string' && file ? fs.lstatSync(file) : null;
    if (stat?.isFile() && !stat.isSymbolicLink()) actualSha256 = hashFile(file);
  } catch (_) {}
  if (!stat?.isFile() || stat.isSymbolicLink()
      || stat.size !== expected.size || actualSha256 !== expected.sha256) {
    fail(code, reason, `${label} 不是符合紀錄的一般檔案`, {
      expectedSize: expected.size,
      expectedSha256: expected.sha256,
    });
  }
  return path.resolve(file);
}

function renderedFrameInterval(startSec, endSec) {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)
      || startSec < 0 || endSec <= startSec) {
    fail('broll_placement_invalid', 'second_interval_invalid',
      'B-roll 秒數區間不合法');
  }
  const startFrame = Math.round(startSec * FPS);
  const durationInFrames = Math.max(1, Math.round((endSec - startSec) * FPS));
  return {
    startFrame,
    endFrame: startFrame + durationInFrames,
    durationInFrames,
  };
}

function childScriptBytes(childScript) {
  if (Buffer.isBuffer(childScript)) return childScript;
  if (typeof childScript === 'string') return Buffer.from(childScript, 'utf8');
  fail('carry_forward_contract_invalid', 'child_script_missing',
    'childScript 必須是字串或 Buffer');
}

function evidenceFailureReason(parentJob) {
  if (!parentJob?.renderInputManifest) return 'render_input_manifest_missing';
  if (!SHA256_HEX.test(parentJob.renderInputManifestSha256 || ''))
    return 'render_input_manifest_sha256_invalid';
  if (!parentJob.renderEvidence) return 'render_evidence_missing';
  if (!parentJob.graphicBroll) return 'composition_broll_missing';
  return 'composition_evidence_invalid';
}

function exactOutputCount(outputs, expected) {
  if (!Array.isArray(outputs)) return 0;
  return outputs.filter((item) => item && item.name === expected.name
    && item.size === expected.size && item.sha256 === expected.sha256).length;
}

function safeManifestInput(input) {
  if (!input || typeof input.path !== 'string'
      || !Number.isSafeInteger(input.size) || input.size <= 0
      || !SHA256_HEX.test(input.sha256 || '')) return null;
  const normalized = path.posix.normalize(input.path);
  if (normalized !== input.path || !normalized.startsWith('public/')
      || path.posix.dirname(normalized) !== 'public') return null;
  const inputName = path.posix.basename(normalized);
  if (!SAFE_MP4_NAME.test(inputName)) return null;
  return { inputName, size: input.size, sha256: input.sha256 };
}

function uniqueManifestInput(manifest, identity, expectedName = null) {
  if (expectedName) {
    const pathMatches = (manifest?.artifactInputs || []).filter(
      (input) => input?.path === `public/${expectedName}`,
    );
    if (pathMatches.length !== 1) {
      fail('broll_manifest_binding_invalid', 'speaker_manifest_path_ambiguous',
        `Parent render manifest 的 public/${expectedName} path 不唯一`);
    }
    const safe = safeManifestInput(pathMatches[0]);
    if (!safe || safe.size !== identity.size || safe.sha256 !== identity.sha256) {
      fail('broll_manifest_binding_invalid', 'speaker_manifest_binding_mismatch',
        `Parent render manifest 的 public/${expectedName} bytes 不符`);
    }
    return safe;
  }
  const matches = (manifest?.artifactInputs || []).flatMap((input) => {
    const safe = safeManifestInput(input);
    if (!safe || safe.size !== identity.size || safe.sha256 !== identity.sha256
        || (expectedName && safe.inputName !== expectedName)) return [];
    return [safe];
  });
  if (matches.length !== 1) {
    fail('broll_manifest_binding_invalid',
      expectedName ? 'speaker_manifest_binding_ambiguous' : 'broll_manifest_binding_ambiguous',
      'Parent render manifest 無法唯一定位素材 input');
  }
  const selected = matches[0];
  const selectedPath = `public/${selected.inputName}`;
  if ((manifest?.artifactInputs || []).filter((input) => input?.path === selectedPath).length !== 1) {
    fail('broll_manifest_binding_invalid', 'broll_manifest_path_ambiguous',
      `Parent render manifest 的 ${selectedPath} path 不唯一`);
  }
  return selected;
}

function verifyParentScriptManifestInput(manifest, expected) {
  const matches = Array.isArray(manifest?.artifactInputs)
    ? manifest.artifactInputs.filter((input) => input?.path === 'public/script.txt') : [];
  if (matches.length !== 1) {
    fail(
      'parent_script_manifest_invalid',
      matches.length === 0
        ? 'parent_script_manifest_binding_missing'
        : 'parent_script_manifest_binding_ambiguous',
      'Parent render manifest 必須唯一綁定 public/script.txt',
    );
  }
  const input = matches[0];
  if (!Number.isSafeInteger(input.size) || input.size <= 0
      || !SHA256_HEX.test(input.sha256 || '')
      || input.size !== expected.size || input.sha256 !== expected.sha256) {
    fail('parent_script_manifest_invalid', 'parent_script_manifest_binding_mismatch',
      'Parent render manifest 的 script bytes 與 child buildScript 不一致');
  }
}

function projectAsset(project, assetRef) {
  const matches = Array.isArray(project?.assets)
    ? project.assets.filter((asset) => asset?.id === assetRef) : [];
  if (matches.length !== 1) {
    fail('broll_asset_invalid', 'project_asset_identity_ambiguous',
      `Project Asset ${assetRef} 無法唯一定位`);
  }
  return matches[0];
}

function projectAssetPath(projectStore, projectId, assetRef, code, reason) {
  try {
    return projectStore.assetPath(projectId, assetRef);
  } catch (error) {
    fail(code, reason, `Project Asset path 無法解析：${assetRef}`, {
      cause: error.message,
    });
  }
}

function validateAssetMetadata(asset, card) {
  if (!asset || asset.kind !== 'video' || asset.role != null || asset.origin != null
      || asset.mediaType !== 'video/mp4' || typeof asset.path !== 'string' || !asset.path
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || !SHA256_HEX.test(asset.sha256 || '')
      || asset.sha256 !== card.assetSha256) {
    fail('broll_asset_invalid', 'project_asset_metadata_invalid',
      `B-roll Asset ${card.assetRef} metadata 不符`);
  }
}

function validateSpeakerMetadata(asset) {
  if (!asset || asset.kind !== 'speaker-video' || asset.role != null || asset.origin != null
      || asset.mediaType !== 'video/mp4' || typeof asset.path !== 'string' || !asset.path
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || !SHA256_HEX.test(asset.sha256 || '')) {
    fail('speaker_selection_invalid', 'speaker_asset_metadata_invalid',
      'Parent speaker Asset metadata 不合法');
  }
}

function assertUniqueRecordedStructure(parentJob, parentRevision) {
  const cards = parentJob?.graphicBroll?.cards;
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 7) return;
  const ids = new Set();
  const assetRefs = new Set();
  for (const card of cards) {
    if (ids.has(card?.id)) {
      fail('duplicate_broll_card', 'duplicate_card_id',
        `Parent B-roll card 重複：${card?.id || '(unknown)'}`);
    }
    if (assetRefs.has(card?.assetRef)) {
      fail('duplicate_broll_asset', 'duplicate_card_asset_ref',
        `Parent B-roll Asset 重複：${card?.assetRef || '(unknown)'}`);
    }
    ids.add(card?.id);
    assetRefs.add(card?.assetRef);
    for (const [owner, placements] of [
      ['job', parentJob.timelinePlacements],
      ['revision', parentRevision?.timelinePlacements],
    ]) {
      const matches = Array.isArray(placements) ? placements.filter((placement) => placement
        && (placement.clipId === card?.id || placement.cardId === card?.id)) : [];
      if (matches.length > 1) {
        fail('duplicate_broll_placement', `duplicate_${owner}_placement`,
          `Parent ${owner} B-roll placement 重複：${card?.id || '(unknown)'}`);
      }
    }
  }
}

function validateParentIdentity({
  project,
  childProjectId,
  explicitParentRevisionId,
  parentRevision,
  parentJob,
}) {
  if (!project || typeof project.id !== 'string' || !project.id
      || project.template !== TEMPLATE || childProjectId !== project.id) {
    fail('parent_project_mismatch', 'same_project_required',
      'B-roll carry-forward 只允許同一個 Focusstock Project');
  }
  if (typeof explicitParentRevisionId !== 'string' || !explicitParentRevisionId
      || explicitParentRevisionId !== parentRevision?.id) {
    fail('parent_revision_not_explicit', 'explicit_parent_revision_required',
      '必須明確指定同 Project 的 parent Revision');
  }
  if (!parentJob || typeof parentJob.id !== 'string' || !SAFE_ID.test(parentJob.id)
      || parentJob.template !== TEMPLATE
      || parentRevision.projectId !== project.id || parentJob.projectId !== project.id
      || parentJob.revisionId !== parentRevision.id
      || parentRevision.jobId !== parentJob.id || parentRevision.runId !== parentJob.id) {
    fail('parent_run_identity_mismatch', 'project_revision_run_identity_mismatch',
      'Parent Project／Revision／Run identity 不一致');
  }
  if (parentJob.status !== 'done' || parentRevision.status !== 'done') {
    fail('parent_not_done', 'parent_revision_or_run_not_done',
      '只有完成的 parent Revision／Run 可以 carry-forward');
  }
}

function selectedSpeaker({ project, parentRevision, parentJob, projectStore, manifest }) {
  if (!Array.isArray(parentRevision.assetRefs)
      || new Set(parentRevision.assetRefs).size !== parentRevision.assetRefs.length
      || !Array.isArray(parentJob.assetRefs)
      || new Set(parentJob.assetRefs).size !== parentJob.assetRefs.length) {
    fail('speaker_selection_invalid', 'parent_asset_refs_invalid',
      'Parent assetRefs 不合法');
  }
  const revisionSpeakers = parentRevision.assetRefs.flatMap((assetRef) => {
    const matches = project.assets.filter((asset) => asset?.id === assetRef);
    return matches.length === 1 && matches[0].kind === 'speaker-video' ? [matches[0]] : [];
  });
  const jobSpeakerRefs = parentJob.assetRefs.filter((assetRef) => project.assets.some(
    (asset) => asset?.id === assetRef && asset.kind === 'speaker-video'));
  if (revisionSpeakers.length !== 1 || jobSpeakerRefs.length !== 1
      || jobSpeakerRefs[0] !== revisionSpeakers[0].id) {
    fail('speaker_selection_invalid', 'unique_parent_speaker_required',
      'Parent Revision／Run 必須共同選用唯一 speaker Asset');
  }
  const asset = revisionSpeakers[0];
  validateSpeakerMetadata(asset);
  const manifestInput = uniqueManifestInput(manifest, asset, 'heygen.mp4');
  const sourcePath = projectAssetPath(
    projectStore,
    project.id,
    asset.id,
    'speaker_asset_bytes_drifted',
    'speaker_asset_path_resolution_failed',
  );
  regularFileIdentity(sourcePath, asset, 'speaker_asset_bytes_drifted',
    'speaker_asset_bytes_drifted', `Speaker Asset ${asset.id}`);
  return {
    descriptor: {
      assetRef: asset.id,
      assetSha256: asset.sha256,
      assetSize: asset.size,
      inputName: manifestInput.inputName,
    },
    asset: { ...asset },
    sourcePath: path.resolve(sourcePath),
  };
}

function buildSourceSnapshot({
  project,
  parentRevision,
  parentJob,
  evidence,
  childScriptSha256,
  projectStore,
}) {
  const manifest = parentJob.renderInputManifest;
  const usedInputNames = new Set(['heygen.mp4', 'prepared-phone-material.mp4']);
  const sources = [];
  const cards = parentJob.graphicBroll.cards.map((card, index) => {
    if (!card || typeof card.id !== 'string' || !SAFE_ID.test(card.id)
        || typeof card.assetRef !== 'string' || !SAFE_ID.test(card.assetRef)
        || !SHA256_HEX.test(card.assetSha256 || '')
        || !Number.isInteger(card.startCharIdx) || card.startCharIdx < 0
        || !Number.isInteger(card.endCharIdx) || card.endCharIdx < card.startCharIdx) {
      fail('broll_card_invalid', 'card_identity_or_char_range_invalid',
        'Parent B-roll card identity／char range 不合法');
    }
    const asset = projectAsset(project, card.assetRef);
    validateAssetMetadata(asset, card);
    const manifestInput = uniqueManifestInput(manifest, asset);
    if (RESERVED_BROLL_INPUTS.has(manifestInput.inputName)
        || usedInputNames.has(manifestInput.inputName)) {
      fail('broll_manifest_binding_invalid', 'duplicate_or_reserved_broll_input_name',
        `B-roll inputName 不可使用：${manifestInput.inputName}`);
    }
    usedInputNames.add(manifestInput.inputName);
    const sourcePath = projectAssetPath(
      projectStore,
      project.id,
      asset.id,
      'broll_asset_bytes_drifted',
      'project_asset_path_resolution_failed',
    );
    regularFileIdentity(sourcePath, asset, 'broll_asset_bytes_drifted',
      'project_asset_bytes_drifted', `B-roll Asset ${asset.id}`);

    const placement = card.resolvedPlacement;
    const interval = renderedFrameInterval(placement?.startSec, placement?.endSec);
    const compositionStartFrame = interval.startFrame + COMPOSITION_OFFSET_FRAMES;
    const compositionEndFrame = interval.endFrame + COMPOSITION_OFFSET_FRAMES;
    const descriptor = {
      ordinal: index + 1,
      id: card.id,
      assetRef: asset.id,
      assetSha256: asset.sha256,
      assetSize: asset.size,
      mediaType: 'video/mp4',
      inputName: manifestInput.inputName,
      startCharIdx: card.startCharIdx,
      endCharIdx: card.endCharIdx,
      startSec: placement.startSec,
      endSec: placement.endSec,
      fps: FPS,
      mainStartFrame: interval.startFrame,
      mainEndFrame: interval.endFrame,
      mainDurationInFrames: interval.durationInFrames,
      compositionOffsetFrames: COMPOSITION_OFFSET_FRAMES,
      compositionStartFrame,
      compositionEndFrame,
      compositionStartSec: Number((compositionStartFrame / FPS).toFixed(6)),
      compositionEndSec: Number((compositionEndFrame / FPS).toFixed(6)),
    };
    sources.push({
      cardId: card.id,
      assetRef: asset.id,
      inputName: manifestInput.inputName,
      size: asset.size,
      sha256: asset.sha256,
      sourcePath: path.resolve(sourcePath),
    });
    return descriptor;
  });

  const speaker = selectedSpeaker({ project, parentRevision, parentJob, projectStore, manifest });
  const verifiedEvidence = JSON.parse(JSON.stringify(evidence));
  const evidenceRecord = canonicalRecord(verifiedEvidence);
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    mode: SOURCE_MODE,
    template: TEMPLATE,
    timelineBasis: TIMELINE_BASIS,
    fps: FPS,
    intervalSemantics: 'frame-half-open',
    parent: {
      projectId: project.id,
      revisionId: parentRevision.id,
      runId: parentJob.id,
      renderInputManifestSha256: evidence.renderInputManifestSha256,
      evidenceStatus: evidence.status,
      evidence: verifiedEvidence,
      evidenceSha256: evidenceRecord.sha256,
      output: { ...evidence.output },
    },
    sourceScriptSha256: childScriptSha256,
    speaker: speaker.descriptor,
    cards,
  };
  return { snapshot, sources, speaker };
}

function validatePreparedPlacement(preparedPlacement, preparedPlanSha256) {
  if (!preparedPlacement) return null;
  if (!SHA256_HEX.test(preparedPlanSha256 || '')
      || preparedPlacement.kind !== 'prepared-phone-video'
      || preparedPlacement.timelineBasis !== TIMELINE_BASIS
      || preparedPlacement.visualOwner !== 'prepared-phone-video'
      || preparedPlacement.conflictPolicy !== 'suppress-entire-overlapping-placement'
      || preparedPlacement.fps !== FPS
      || !Number.isInteger(preparedPlacement.startFrame)
      || !Number.isInteger(preparedPlacement.endFrame)
      || preparedPlacement.startFrame < 0
      || preparedPlacement.endFrame <= preparedPlacement.startFrame
      || preparedPlacement.durationInFrames
        !== preparedPlacement.endFrame - preparedPlacement.startFrame
      || preparedPlacement.compositionOffsetFrames !== COMPOSITION_OFFSET_FRAMES
      || preparedPlacement.compositionStartFrame
        !== preparedPlacement.startFrame + COMPOSITION_OFFSET_FRAMES
      || preparedPlacement.compositionEndFrame
        !== preparedPlacement.endFrame + COMPOSITION_OFFSET_FRAMES
      || preparedPlacement.planSha256 !== preparedPlanSha256
      || !SHA256_HEX.test(preparedPlacement.sourceSha256 || '')) {
    fail('prepared_placement_invalid', 'compiled_prepared_identity_invalid',
      'Prepared placement／plan identity 不合法');
  }
  return {
    planSha256: preparedPlanSha256,
    sourceSha256: preparedPlacement.sourceSha256,
    fps: FPS,
    startFrame: preparedPlacement.startFrame,
    endFrame: preparedPlacement.endFrame,
    durationInFrames: preparedPlacement.durationInFrames,
    intervalSemantics: 'frame-half-open',
  };
}

function buildFinalPlan(sourceSnapshot, sourceSha256, prepared) {
  const cards = sourceSnapshot.cards.map((card) => {
    const suppressed = halfOpenFrameIntervalsOverlap(
      card.mainStartFrame,
      card.mainEndFrame,
      prepared.startFrame,
      prepared.endFrame,
    );
    return {
      ...card,
      disposition: suppressed ? 'suppressed_by_prepared' : 'rendered',
      suppressedBy: suppressed ? 'prepared-phone-video' : null,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: PLAN_MODE,
    template: TEMPLATE,
    timelineBasis: TIMELINE_BASIS,
    fps: FPS,
    intervalSemantics: 'frame-half-open',
    sourceSnapshotSha256: sourceSha256,
    parent: sourceSnapshot.parent,
    sourceScriptSha256: sourceSnapshot.sourceScriptSha256,
    prepared,
    speaker: sourceSnapshot.speaker,
    cards,
  };
}

function validateFocusstockBrollCarryPlan(plan) {
  if (!plan || plan.schemaVersion !== SCHEMA_VERSION || plan.mode !== PLAN_MODE
      || plan.template !== TEMPLATE || plan.timelineBasis !== TIMELINE_BASIS
      || plan.fps !== FPS || plan.intervalSemantics !== 'frame-half-open'
      || !SHA256_HEX.test(plan.sourceSnapshotSha256 || '')
      || !SHA256_HEX.test(plan.sourceScriptSha256 || '')
      || !plan.parent || !plan.parent.projectId || !plan.parent.revisionId || !plan.parent.runId
      || plan.parent.evidenceStatus !== 'verified'
      || !SHA256_HEX.test(plan.parent.renderInputManifestSha256 || '')
      || !plan.parent.evidence || !SHA256_HEX.test(plan.parent.evidenceSha256 || '')
      || sha256(Buffer.from(canonicalize(plan.parent.evidence))) !== plan.parent.evidenceSha256
      || plan.parent.evidence.status !== 'verified'
      || plan.parent.evidence.projectId !== plan.parent.projectId
      || plan.parent.evidence.revisionId !== plan.parent.revisionId
      || plan.parent.evidence.renderInputManifestSha256
        !== plan.parent.renderInputManifestSha256
      || !plan.parent.output || typeof plan.parent.output.name !== 'string'
      || !Number.isSafeInteger(plan.parent.output.size) || plan.parent.output.size <= 0
      || !SHA256_HEX.test(plan.parent.output.sha256 || '')
      || !plan.prepared || !SHA256_HEX.test(plan.prepared.planSha256 || '')
      || !SHA256_HEX.test(plan.prepared.sourceSha256 || '')
      || plan.prepared.fps !== FPS || plan.prepared.intervalSemantics !== 'frame-half-open'
      || !Number.isInteger(plan.prepared.startFrame) || plan.prepared.startFrame < 0
      || !Number.isInteger(plan.prepared.endFrame)
      || plan.prepared.endFrame <= plan.prepared.startFrame
      || plan.prepared.durationInFrames
        !== plan.prepared.endFrame - plan.prepared.startFrame
      || !plan.speaker || typeof plan.speaker.assetRef !== 'string'
      || !SHA256_HEX.test(plan.speaker.assetSha256 || '')
      || !Number.isSafeInteger(plan.speaker.assetSize) || plan.speaker.assetSize <= 0
      || plan.speaker.inputName !== 'heygen.mp4'
      || !Array.isArray(plan.cards) || plan.cards.length < 1 || plan.cards.length > 7) {
    fail('carry_plan_invalid', 'plan_envelope_invalid',
      'Focusstock carry-forward plan envelope 不合法');
  }
  const ids = new Set();
  const assetRefs = new Set();
  const inputNames = new Set();
  for (const [index, card] of plan.cards.entries()) {
    let interval;
    try { interval = renderedFrameInterval(card?.startSec, card?.endSec); }
    catch (_) {
      fail('carry_plan_invalid', 'plan_second_interval_invalid',
        `Focusstock carry-forward card 秒數區間不合法：${card?.id || '(unknown)'}`);
    }
    const compositionStartFrame = interval.startFrame + COMPOSITION_OFFSET_FRAMES;
    const compositionEndFrame = interval.endFrame + COMPOSITION_OFFSET_FRAMES;
    let expectedDisposition;
    try {
      expectedDisposition = halfOpenFrameIntervalsOverlap(
        interval.startFrame,
        interval.endFrame,
        plan.prepared.startFrame,
        plan.prepared.endFrame,
      ) ? 'suppressed_by_prepared' : 'rendered';
    } catch (_) {
      fail('carry_plan_invalid', 'plan_interval_invalid',
        'Focusstock carry-forward plan frame interval 不合法');
    }
    if (!card || typeof card.id !== 'string' || !SAFE_ID.test(card.id) || ids.has(card.id)
        || typeof card.assetRef !== 'string' || !SAFE_ID.test(card.assetRef)
        || assetRefs.has(card.assetRef)
        || card.ordinal !== index + 1
        || !SHA256_HEX.test(card.assetSha256 || '')
        || !Number.isSafeInteger(card.assetSize) || card.assetSize <= 0
        || card.mediaType !== 'video/mp4'
        || !SAFE_MP4_NAME.test(card.inputName || '')
        || RESERVED_BROLL_INPUTS.has(card.inputName) || inputNames.has(card.inputName)
        || !Number.isInteger(card.startCharIdx) || card.startCharIdx < 0
        || !Number.isInteger(card.endCharIdx) || card.endCharIdx < card.startCharIdx
        || card.fps !== FPS
        || card.mainStartFrame !== interval.startFrame
        || card.mainEndFrame !== interval.endFrame
        || card.mainDurationInFrames !== interval.durationInFrames
        || card.compositionOffsetFrames !== COMPOSITION_OFFSET_FRAMES
        || card.compositionStartFrame !== compositionStartFrame
        || card.compositionEndFrame !== compositionEndFrame
        || card.compositionStartSec !== Number((compositionStartFrame / FPS).toFixed(6))
        || card.compositionEndSec !== Number((compositionEndFrame / FPS).toFixed(6))
        || card.disposition !== expectedDisposition
        || card.suppressedBy
          !== (expectedDisposition === 'suppressed_by_prepared'
            ? 'prepared-phone-video' : null)) {
      fail('carry_plan_invalid', 'plan_card_invalid',
        `Focusstock carry-forward card 不合法：${card?.id || '(unknown)'}`);
    }
    ids.add(card.id);
    assetRefs.add(card.assetRef);
    inputNames.add(card.inputName);
  }
  if (!Array.isArray(plan.parent.evidence.cardIds)
      || canonicalize(plan.parent.evidence.cardIds)
        !== canonicalize(plan.cards.map((card) => card.id))
      || canonicalize(plan.parent.evidence.output) !== canonicalize(plan.parent.output)) {
    fail('carry_plan_invalid', 'parent_evidence_identity_invalid',
      'Carry-forward parent evidence 與 cards／output identity 不一致');
  }
  return plan;
}

function preflightFocusstockBrollCarryForward({
  project,
  childProjectId,
  explicitParentRevisionId,
  parentRevision,
  parentJob,
  childScript,
  projectStore,
  resolveOutputPath,
  preparedPlacement = null,
  preparedPlanSha256 = null,
}) {
  validateParentIdentity({
    project, childProjectId, explicitParentRevisionId, parentRevision, parentJob,
  });
  if (!projectStore || typeof projectStore.assetPath !== 'function') {
    fail('carry_forward_contract_invalid', 'project_asset_path_resolver_missing',
      'preflight 需要 Project Asset path resolver');
  }
  if (typeof resolveOutputPath !== 'function') {
    fail('carry_forward_contract_invalid', 'parent_output_path_resolver_missing',
      'preflight 需要 durable parent output path resolver');
  }

  assertUniqueRecordedStructure(parentJob, parentRevision);
  const evidence = verifyRecordedCompositionEvidence({
    job: parentJob,
    project,
    revision: parentRevision,
  });
  if (!evidence) {
    fail('parent_broll_evidence_unverified', evidenceFailureReason(parentJob),
      'Parent B-roll composition evidence 未通過驗證');
  }
  if (parentJob.renderInputManifest.template !== TEMPLATE
      || parentJob.renderInputManifest.compositionId !== 'Focusstock') {
    fail('parent_render_manifest_invalid', 'parent_manifest_focusstock_identity_mismatch',
      'Parent render manifest 必須明確綁定 Focusstock composition');
  }
  if (exactOutputCount(parentJob.outputs, evidence.output) !== 1
      || exactOutputCount(parentRevision.outputs, evidence.output) !== 1
      || exactOutputCount(parentJob.renderEvidence?.outputs, evidence.output) !== 1
      || exactOutputCount(parentRevision.renderEvidence?.outputs, evidence.output) !== 1) {
    fail('parent_output_invalid', 'parent_output_identity_ambiguous',
      'Parent durable output identity 不唯一');
  }
  let outputPath;
  try {
    outputPath = resolveOutputPath({
      projectId: project.id,
      revisionId: parentRevision.id,
      runId: parentJob.id,
      output: { ...evidence.output },
    });
  } catch (error) {
    fail('parent_output_invalid', 'parent_output_path_resolution_failed',
      `Parent durable output path 無法解析：${error.message}`);
  }
  const resolvedOutputPath = regularFileIdentity(
    outputPath,
    evidence.output,
    'parent_output_bytes_drifted',
    'parent_output_bytes_drifted',
    'Parent durable output',
  );

  const scriptBytes = childScriptBytes(childScript);
  const scriptHash = sha256(scriptBytes);
  if (!SHA256_HEX.test(parentJob.graphicBroll?.sourceScriptSha256 || '')
      || parentJob.graphicBroll.sourceScriptSha256 !== scriptHash) {
    fail('child_script_drift', 'source_script_sha256_mismatch',
      'Child buildScript bytes 與 parent B-roll source script 不一致');
  }
  verifyParentScriptManifestInput(parentJob.renderInputManifest, {
    size: scriptBytes.length,
    sha256: scriptHash,
  });
  const built = buildSourceSnapshot({
    project,
    parentRevision,
    parentJob,
    evidence,
    childScriptSha256: scriptHash,
    projectStore,
  });
  const sourceRecord = canonicalRecord(built.snapshot);
  const prepared = validatePreparedPlacement(preparedPlacement, preparedPlanSha256);
  let plan = null;
  let planCanonical = null;
  let planSha256 = null;
  if (prepared) {
    plan = buildFinalPlan(built.snapshot, sourceRecord.sha256, prepared);
    validateFocusstockBrollCarryPlan(plan);
    const planRecord = canonicalRecord(plan);
    planCanonical = planRecord.canonical;
    planSha256 = planRecord.sha256;
  } else if (preparedPlanSha256 != null) {
    fail('prepared_placement_invalid', 'prepared_placement_missing',
      'preparedPlanSha256 不可在沒有 preparedPlacement 時單獨出現');
  }

  return {
    sourceSnapshot: built.snapshot,
    sourceCanonical: sourceRecord.canonical,
    sourceSha256: sourceRecord.sha256,
    plan,
    planCanonical,
    planSha256,
    materializationSources: built.sources,
    speakerAsset: built.speaker.asset,
    speakerSourcePath: built.speaker.sourcePath,
    parentOutputPath: resolvedOutputPath,
  };
}

function validateFinalPreflight(preflight) {
  if (!preflight || !preflight.plan || typeof preflight.planCanonical !== 'string'
      || !SHA256_HEX.test(preflight.planSha256 || '')
      || canonicalize(preflight.plan) !== preflight.planCanonical
      || sha256(Buffer.from(preflight.planCanonical)) !== preflight.planSha256
      || !preflight.sourceSnapshot || typeof preflight.sourceCanonical !== 'string'
      || !SHA256_HEX.test(preflight.sourceSha256 || '')
      || canonicalize(preflight.sourceSnapshot) !== preflight.sourceCanonical
      || sha256(Buffer.from(preflight.sourceCanonical)) !== preflight.sourceSha256
      || preflight.plan.sourceSnapshotSha256 !== preflight.sourceSha256
      || !Array.isArray(preflight.materializationSources)
      || preflight.materializationSources.length !== preflight.plan.cards.length) {
    fail('carry_plan_invalid', 'preflight_snapshot_drifted',
      'Carry-forward preflight snapshot 已改變');
  }
  validateFocusstockBrollCarryPlan(preflight.plan);
}

function materializeFocusstockBrollCarryForward({
  preflight,
  projectStore,
  materializationDirectory,
}) {
  validateFinalPreflight(preflight);
  if (!projectStore || typeof projectStore.assetPath !== 'function'
      || typeof projectStore.materializeAsset !== 'function') {
    fail('carry_forward_contract_invalid', 'project_materializer_missing',
      'materialize 需要 Project Asset path resolver 與 materialize callback');
  }
  let directoryStat;
  try { directoryStat = fs.lstatSync(materializationDirectory); } catch (_) {}
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    fail('materialization_target_invalid', 'materialization_directory_unsafe',
      'B-roll materialization directory 不存在或不安全');
  }
  const directory = fs.realpathSync(materializationDirectory);
  const sourceByCard = new Map(preflight.materializationSources.map((source) => [
    source?.cardId, source,
  ]));
  if (sourceByCard.size !== preflight.plan.cards.length) {
    fail('carry_plan_invalid', 'materialization_sources_ambiguous',
      'Carry-forward materialization source 不唯一');
  }

  const candidates = preflight.plan.cards.map((card) => {
    const source = sourceByCard.get(card.id);
    if (!source || source.assetRef !== card.assetRef || source.inputName !== card.inputName
        || source.size !== card.assetSize || source.sha256 !== card.assetSha256) {
      fail('carry_plan_invalid', 'materialization_source_mismatch',
        `Carry-forward materialization source 不符：${card.id}`);
    }
    const currentSourcePath = projectAssetPath(
      projectStore,
      preflight.plan.parent.projectId,
      card.assetRef,
      'broll_asset_bytes_drifted',
      'project_asset_path_resolution_failed',
    );
    regularFileIdentity(currentSourcePath, {
      size: card.assetSize,
      sha256: card.assetSha256,
    }, 'broll_asset_bytes_drifted', 'project_asset_bytes_drifted',
    `B-roll Asset ${card.assetRef}`);
    if (path.resolve(currentSourcePath) !== source.sourcePath) {
      fail('broll_asset_bytes_drifted', 'project_asset_path_drifted',
        `B-roll Asset path 已改變：${card.assetRef}`);
    }
    const target = path.resolve(directory, card.inputName);
    if (path.dirname(target) !== directory) {
      fail('materialization_target_invalid', 'materialization_target_escaped',
        `B-roll target 超出 materialization directory：${card.inputName}`);
    }
    let existing = null;
    try { existing = fs.lstatSync(target); } catch (_) {}
    let reuse = false;
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()
          || existing.size !== card.assetSize || hashFile(target) !== card.assetSha256) {
        fail('materialization_target_invalid', 'materialization_target_conflict',
          `B-roll target 已存在但 bytes 不符：${card.inputName}`);
      }
      reuse = true;
    }
    return { card, target, reuse };
  });

  const materialized = [];
  for (const candidate of candidates) {
    const { card, target } = candidate;
    if (!candidate.reuse) {
      try {
        projectStore.materializeAsset(
          preflight.plan.parent.projectId,
          card.assetRef,
          target,
        );
      } catch (error) {
        fail('materialization_failed', 'project_asset_materialization_failed',
          `B-roll Asset materialize 失敗：${card.assetRef}`, { cause: error.message });
      }
    }
    regularFileIdentity(target, {
      size: card.assetSize,
      sha256: card.assetSha256,
    }, 'materialized_asset_bytes_drifted', 'materialized_target_bytes_drifted',
    `Materialized B-roll ${card.inputName}`);
    materialized.push({
      cardId: card.id,
      assetRef: card.assetRef,
      inputName: card.inputName,
      target,
      size: card.assetSize,
      sha256: card.assetSha256,
      disposition: card.disposition,
      reusedExactBytes: candidate.reuse,
    });
  }
  return materialized;
}

function prepareFocusstockBrollCarryForward(options) {
  const preflight = preflightFocusstockBrollCarryForward(options);
  if (!preflight.plan) {
    fail('prepared_placement_invalid', 'final_prepared_placement_required',
      'prepare 需要已編譯的 prepared placement');
  }
  const materialized = materializeFocusstockBrollCarryForward({
    preflight,
    projectStore: options.projectStore,
    materializationDirectory: options.materializationDirectory,
  });
  return {
    ...preflight,
    materialized,
  };
}

function writeCanonicalPlan(file, plan) {
  validateFocusstockBrollCarryPlan(plan);
  const record = canonicalRecord(plan);
  const target = path.resolve(file);
  const directory = path.dirname(target);
  let directoryStat;
  try { directoryStat = fs.lstatSync(directory); } catch (_) {}
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    fail('carry_plan_write_failed', 'plan_directory_unsafe',
      'Carry-forward plan directory 不存在或不安全');
  }
  let targetStat;
  try { targetStat = fs.lstatSync(target); } catch (_) {}
  if (targetStat) {
    if (!targetStat.isFile() || targetStat.isSymbolicLink()
        || targetStat.size !== Buffer.byteLength(record.canonical)
        || hashFile(target) !== record.sha256) {
      fail('carry_plan_write_failed', 'plan_target_conflict',
        'Carry-forward plan 已存在但內容不符');
    }
    return { file: target, canonical: record.canonical, sha256: record.sha256, reused: true };
  }
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, record.canonical, { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, target);
  } catch (error) {
    if (error.code === 'EEXIST') {
      let concurrentStat;
      let concurrentSha256 = null;
      try {
        concurrentStat = fs.lstatSync(target);
        if (concurrentStat.isFile() && !concurrentStat.isSymbolicLink())
          concurrentSha256 = hashFile(target);
      } catch (_) {}
      if (concurrentStat?.isFile() && !concurrentStat.isSymbolicLink()
          && concurrentStat.size === Buffer.byteLength(record.canonical)
          && concurrentSha256 === record.sha256) {
        return { file: target, canonical: record.canonical, sha256: record.sha256, reused: true };
      }
    }
    fail('carry_plan_write_failed', 'plan_atomic_write_failed',
      `Carry-forward plan 寫入失敗：${error.message}`);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
  return { file: target, canonical: record.canonical, sha256: record.sha256, reused: false };
}

module.exports = {
  COMPOSITION_OFFSET_FRAMES,
  FPS,
  PLAN_MODE,
  SCHEMA_VERSION,
  SOURCE_MODE,
  FocusstockBrollCarryForwardError,
  materializeFocusstockBrollCarryForward,
  preflightFocusstockBrollCarryForward,
  prepareFocusstockBrollCarryForward,
  validateFocusstockBrollCarryPlan,
  writeCanonicalPlan,
};
