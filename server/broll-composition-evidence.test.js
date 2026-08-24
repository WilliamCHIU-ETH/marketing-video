'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { verifyRecordedCompositionEvidence } = require('./broll-composition-evidence');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const assetSha256 = 'a'.repeat(64);
  const outputSha256 = 'b'.repeat(64);
  const placement = {
    clipId: 'broll-01', assetRef: 'asset-video-1', assetSha256,
    startSec: 1, endSec: 2, evidenceLevel: 'reconstructed-after-render',
  };
  const manifest = {
    schemaVersion: 1,
    artifactInputs: [{ path: 'public/broll1.mp4', size: 321, sha256: assetSha256 }],
  };
  const manifestSha256 = sha256(JSON.stringify(manifest));
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

function carriedFixture() {
  const scriptBytes = Buffer.from('synthetic child script');
  const speakerBytes = Buffer.from('synthetic child speaker');
  const preparedBytes = Buffer.from('synthetic prepared phone');
  const preparedPlanRaw = JSON.stringify({
    schemaVersion: 1,
    mode: 'ready-to-place',
    placement: { startFrame: 60, endFrame: 90 },
  });
  const brollBytes = [Buffer.from('synthetic B-roll 1'), Buffer.from('synthetic B-roll 2')];
  const sourceCards = brollBytes.map((bytes, index) => {
    const ordinal = index + 1;
    const startSec = ordinal;
    const endSec = ordinal + 1;
    const mainStartFrame = startSec * 30;
    const mainEndFrame = endSec * 30;
    return {
      ordinal,
      id: `broll-${String(ordinal).padStart(2, '0')}`,
      assetRef: `asset-video-${ordinal}`,
      assetSha256: sha256(bytes),
      assetSize: bytes.length,
      mediaType: 'video/mp4',
      inputName: `broll${ordinal}.mp4`,
      startCharIdx: index * 5,
      endCharIdx: (ordinal * 5) - 1,
      startSec,
      endSec,
      fps: 30,
      mainStartFrame,
      mainEndFrame,
      mainDurationInFrames: mainEndFrame - mainStartFrame,
      compositionOffsetFrames: 30,
      compositionStartFrame: mainStartFrame + 30,
      compositionEndFrame: mainEndFrame + 30,
      compositionStartSec: Number(((mainStartFrame + 30) / 30).toFixed(6)),
      compositionEndSec: Number(((mainEndFrame + 30) / 30).toFixed(6)),
    };
  });
  const parentOutput = {
    name: 'parent-output.mp4', size: 100, sha256: sha256('parent output'),
  };
  const parentEvidence = {
    status: 'verified',
    projectId: 'project-1',
    revisionId: 'v005',
    renderInputManifestSha256: sha256('parent manifest'),
    cardIds: sourceCards.map((card) => card.id),
    output: parentOutput,
  };
  const parent = {
    projectId: 'project-1',
    revisionId: 'v005',
    runId: 'job-parent',
    renderInputManifestSha256: parentEvidence.renderInputManifestSha256,
    evidenceStatus: 'verified',
    evidence: parentEvidence,
    evidenceSha256: sha256(JSON.stringify(parentEvidence)),
    output: parentOutput,
  };
  const sourceSnapshot = {
    schemaVersion: 2,
    mode: 'carry-source-v1',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    fps: 30,
    intervalSemantics: 'frame-half-open',
    parent,
    sourceScriptSha256: sha256(scriptBytes),
    speaker: {
      assetRef: 'asset-speaker',
      assetSha256: sha256(speakerBytes),
      assetSize: speakerBytes.length,
      inputName: 'heygen.mp4',
    },
    cards: sourceCards,
  };
  const sourceSnapshotSha256 = sha256(JSON.stringify(sourceSnapshot));
  const visualEvidence = {
    schemaVersion: 1,
    algorithm: 'focusstock-shot-runs-v1',
    timelineBasis: 'focusstock-main-v1',
    runs: [],
  };
  const visualEvidenceSha256 = sha256(JSON.stringify(visualEvidence));
  const prepared = {
    planSha256: sha256(preparedPlanRaw),
    sourceSha256: sha256(preparedBytes),
    fps: 30,
    startFrame: 60,
    endFrame: 90,
    durationInFrames: 30,
    intervalSemantics: 'frame-half-open',
  };
  const plan = {
    schemaVersion: 2,
    mode: 'carried-v1',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    fps: 30,
    intervalSemantics: 'frame-half-open',
    sourceSnapshotSha256,
    parent,
    sourceScriptSha256: sourceSnapshot.sourceScriptSha256,
    prepared,
    speaker: sourceSnapshot.speaker,
    cards: sourceCards.map((card, index) => ({
      ...card,
      disposition: index === 1 ? 'suppressed_by_prepared' : 'rendered',
      suppressedBy: index === 1 ? 'prepared-phone-video' : null,
    })),
  };
  const planSha256 = sha256(JSON.stringify(plan));
  const materialized = plan.cards.map((card, index) => ({
    cardId: card.id,
    assetRef: card.assetRef,
    inputName: card.inputName,
    size: card.assetSize,
    sha256: card.assetSha256,
    disposition: card.disposition,
    reusedExactBytes: index === 0,
  }));
  const carry = {
    schemaVersion: 1,
    mode: 'carried-v1',
    status: 'compiled',
    parentRevisionId: parent.revisionId,
    sourceInputName: 'focusstock-broll-carry.source.json',
    sourceSnapshot,
    sourceSnapshotSha256,
    planFile: 'src/Focusstock/focusstock-broll.generated.json',
    plan,
    planSha256,
    materialized,
  };
  const carriedPlacements = plan.cards.map((card) => ({
    kind: 'focusstock-broll-placement',
    channel: 'focusstock-broll',
    clipId: card.id,
    cardId: card.id,
    ordinal: card.ordinal,
    assetRef: card.assetRef,
    assetSha256: card.assetSha256,
    assetSize: card.assetSize,
    inputName: card.inputName,
    timelineBasis: plan.timelineBasis,
    fps: card.fps,
    startCharIdx: card.startCharIdx,
    endCharIdx: card.endCharIdx,
    startSec: card.startSec,
    endSec: card.endSec,
    startFrame: card.mainStartFrame,
    endFrame: card.mainEndFrame,
    durationInFrames: card.mainDurationInFrames,
    compositionOffsetFrames: card.compositionOffsetFrames,
    compositionStartFrame: card.compositionStartFrame,
    compositionEndFrame: card.compositionEndFrame,
    disposition: card.disposition,
    suppressedBy: card.suppressedBy,
    evidenceLevel: 'pre-render-manifest-v1',
    planSha256,
    parentEvidenceSha256: parent.evidenceSha256,
    preparedPlanSha256: prepared.planSha256,
  }));
  const preparedPlacement = {
    kind: 'prepared-phone-video',
    assetRef: 'asset-prepared',
    profileId: 'focusstock-balanced',
    layoutId: 'phone-right',
    visualOwner: 'prepared-phone-video',
    conflictPolicy: 'suppress-entire-overlapping-placement',
    timelineBasis: plan.timelineBasis,
    fps: 30,
    startFrame: 60,
    endFrame: 90,
    durationInFrames: 30,
    startSec: 2,
    endSec: 3,
    compositionTimeline: 'Focusstock',
    compositionOffsetFrames: 30,
    compositionStartFrame: 90,
    compositionEndFrame: 120,
    compositionStartSec: 3,
    compositionEndSec: 4,
    sourceSha256: prepared.sourceSha256,
    planSha256: prepared.planSha256,
    focusstockVisualEvidenceSha256: visualEvidenceSha256,
  };
  const materialAcquisition = {
    operation: 'prepared-video',
    presentation: { profileId: 'focusstock-balanced' },
    placement: { layoutId: 'phone-right' },
  };
  const materialAcquisitionResult = {
    placementStatus: 'compiled',
    automaticTimelineUse: true,
    compiledPlanSha256: prepared.planSha256,
    preparedArtifact: {
      assetRef: 'asset-prepared',
      sha256: prepared.sourceSha256,
      size: preparedBytes.length,
    },
    placement: {
      layoutId: 'phone-right', fps: 30, startFrame: 60, endFrame: 90,
      durationInFrames: 30, startSec: 2, endSec: 3,
    },
    focusstockVisualEvidence: visualEvidence,
    focusstockVisualEvidenceSha256: visualEvidenceSha256,
  };
  const childOutput = {
    name: 'child-output.mp4', size: 200, sha256: sha256('child output'),
  };
  const graphicBroll = {
    schemaVersion: 1,
    mode: 'composition-v1',
    style: 'focusstock-carried-v1',
    sourceScriptSha256: plan.sourceScriptSha256,
    planSha256,
    cards: plan.cards.map((card) => ({
      id: card.id,
      ordinal: card.ordinal,
      assetRef: card.assetRef,
      assetSha256: card.assetSha256,
      assetSize: card.assetSize,
      startCharIdx: card.startCharIdx,
      endCharIdx: card.endCharIdx,
      resolvedPlacement: { startSec: card.startSec, endSec: card.endSec },
      disposition: card.disposition,
      suppressedBy: card.suppressedBy,
    })),
    provenance: {
      level: 'pre-render-manifest-v1',
      parent,
      prepared,
      output: childOutput,
    },
  };
  const fingerprint = (path, bytes) => ({ path, size: bytes.length, sha256: sha256(bytes) });
  const sourceRaw = Buffer.from(JSON.stringify(sourceSnapshot));
  const planRaw = Buffer.from(JSON.stringify(plan));
  const manifest = {
    schemaVersion: 1,
    rendererContractVersion: 'remotion-source-closure-v1',
    template: 'focusstock',
    compositionId: 'Focusstock',
    options: { preparedPhoneMode: 'ready-to-place', focusstockBrollMode: 'carried-v1' },
    artifactInputs: [
      fingerprint('public/script.txt', scriptBytes),
      fingerprint('public/heygen.mp4', speakerBytes),
      fingerprint('public/prepared-phone-material.mp4', preparedBytes),
      fingerprint('src/Focusstock/prepared-phone-material.generated.json',
        Buffer.from(preparedPlanRaw)),
      fingerprint('public/focusstock-broll-carry.source.json', sourceRaw),
      fingerprint('src/Focusstock/focusstock-broll.generated.json', planRaw),
      ...brollBytes.map((bytes, index) => fingerprint(`public/broll${index + 1}.mp4`, bytes)),
    ],
    rendererIdentity: [
      fingerprint('scripts/focusstock-broll-plan.js', Buffer.from('planner executable')),
      fingerprint('src/Focusstock/FocusstockBrollLayer.tsx', Buffer.from('renderer executable')),
    ],
  };
  const manifestSha256 = sha256(JSON.stringify(manifest));
  const renderEvidence = {
    schemaVersion: 1, renderInputManifestSha256: manifestSha256, outputs: [childOutput],
  };
  const assetRefs = [
    ...plan.cards.map((card) => card.assetRef),
    plan.speaker.assetRef,
    'asset-prepared',
  ];
  const timelinePlacements = [...carriedPlacements, preparedPlacement];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const job = {
    id: 'job-child', status: 'done', projectId: 'project-1', revisionId: 'v006',
    assetRefs: clone(assetRefs),
    focusstockBrollCarryForward: clone(carry),
    materialAcquisition: clone(materialAcquisition),
    materialAcquisitionResult: clone(materialAcquisitionResult),
    graphicBroll: clone(graphicBroll),
    timelinePlacements: clone(timelinePlacements),
    outputs: [childOutput],
    renderInputManifest: clone(manifest),
    renderInputManifestSha256: manifestSha256,
    renderEvidence: clone(renderEvidence),
  };
  const project = {
    id: 'project-1',
    template: 'focusstock',
    assets: [
      ...plan.cards.map((card) => ({
        id: card.assetRef, kind: 'video', mediaType: 'video/mp4',
        sha256: card.assetSha256, size: card.assetSize,
      })),
      {
        id: plan.speaker.assetRef, kind: 'speaker-video', mediaType: 'video/mp4',
        sha256: plan.speaker.assetSha256, size: plan.speaker.assetSize,
      },
      {
        id: 'asset-prepared', kind: 'video', role: 'prepared-phone-video',
        origin: 'chipk-simulator-capture', mediaType: 'video/mp4',
        sha256: prepared.sourceSha256, size: preparedBytes.length,
      },
    ],
  };
  const revision = {
    id: 'v006', projectId: 'project-1', jobId: 'job-child', runId: 'job-child', status: 'done',
    parentRevisionId: 'v005',
    assetRefs: clone(assetRefs),
    focusstockBrollCarryForward: clone(carry),
    materialAcquisition: clone(materialAcquisition),
    materialAcquisitionResult: clone(materialAcquisitionResult),
    graphicBroll: clone(graphicBroll),
    timelinePlacements: clone(timelinePlacements),
    outputs: [childOutput],
    renderInputManifest: clone(manifest),
    renderInputManifestSha256: manifestSha256,
    renderEvidence: clone(renderEvidence),
  };
  return { job, project, revision };
}

function refreshManifestEvidence(input) {
  const manifestSha256 = sha256(JSON.stringify(input.job.renderInputManifest));
  input.job.renderInputManifestSha256 = manifestSha256;
  input.job.renderEvidence.renderInputManifestSha256 = manifestSha256;
  input.revision.renderInputManifest = JSON.parse(JSON.stringify(input.job.renderInputManifest));
  input.revision.renderInputManifestSha256 = manifestSha256;
  input.revision.renderEvidence.renderInputManifestSha256 = manifestSha256;
}

test('verifies composition playback only across Project, Revision and render-input evidence', () => {
  const input = fixture();
  assert.deepEqual(verifyRecordedCompositionEvidence(input), {
    status: 'verified', projectId: 'project-1', revisionId: 'v001',
    renderInputManifestSha256: input.job.renderInputManifestSha256, cardIds: ['broll-01'],
    output: { name: 'output.mp4', size: 123, sha256: 'b'.repeat(64) },
  });
});

test('fails closed when the stored manifest digest does not match its canonical content', () => {
  const input = fixture();
  input.job.renderInputManifestSha256 = 'c'.repeat(64);
  input.job.renderEvidence.renderInputManifestSha256 = 'c'.repeat(64);
  input.revision.renderInputManifestSha256 = 'c'.repeat(64);
  input.revision.renderEvidence.renderInputManifestSha256 = 'c'.repeat(64);
  assert.equal(verifyRecordedCompositionEvidence(input), null);
});

test('fails closed when a card has ambiguous duplicate placements', () => {
  for (const owner of ['job', 'revision']) {
    const input = fixture();
    input[owner].timelinePlacements.push({
      ...input[owner].timelinePlacements[0],
      startSec: 4,
      endSec: 5,
    });
    assert.equal(verifyRecordedCompositionEvidence(input), null, owner);
  }
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

test('verifies authoritative carried B-roll, prepared, parent, renderer and output evidence', () => {
  const input = carriedFixture();
  assert.deepEqual(verifyRecordedCompositionEvidence(input), {
    status: 'verified',
    projectId: 'project-1',
    revisionId: 'v006',
    renderInputManifestSha256: input.job.renderInputManifestSha256,
    cardIds: ['broll-01', 'broll-02'],
    renderedCardIds: ['broll-01'],
    suppressedCardIds: ['broll-02'],
    rendererIdentities: input.job.renderInputManifest.rendererIdentity,
    parent: {
      projectId: 'project-1',
      revisionId: 'v005',
      runId: 'job-parent',
      output: input.job.focusstockBrollCarryForward.plan.parent.output,
    },
    output: input.job.graphicBroll.provenance.output,
  });
});

test('carried evidence fails closed on source, manifest, executable, disposition or timeline drift', () => {
  const mutations = [
    (input) => {
      input.job.renderInputManifest.artifactInputs.find(
        (item) => item.path === 'public/broll2.mp4').sha256 = 'f'.repeat(64);
      refreshManifestEvidence(input);
    },
    (input) => {
      input.job.renderInputManifest.rendererIdentity = input.job.renderInputManifest.rendererIdentity
        .filter((item) => item.path !== 'src/Focusstock/FocusstockBrollLayer.tsx');
      refreshManifestEvidence(input);
    },
    (input) => {
      input.job.focusstockBrollCarryForward.materialized.reverse();
      input.revision.focusstockBrollCarryForward.materialized.reverse();
    },
    (input) => {
      input.job.graphicBroll.cards[1].disposition = 'rendered';
      input.job.graphicBroll.cards[1].suppressedBy = null;
      input.revision.graphicBroll.cards[1].disposition = 'rendered';
      input.revision.graphicBroll.cards[1].suppressedBy = null;
    },
    (input) => {
      const mutate = (record) => {
        const placement = record.timelinePlacements.find(
          (item) => item.kind === 'focusstock-broll-placement' && item.cardId === 'broll-01');
        placement.compositionStartFrame += 1;
      };
      mutate(input.job);
      mutate(input.revision);
    },
  ];
  for (const mutate of mutations) {
    const input = carriedFixture();
    mutate(input);
    assert.equal(verifyRecordedCompositionEvidence(input), null);
  }
});

test('carried evidence fails closed on child speaker, prepared or output ambiguity', () => {
  const mutations = [
    (input) => {
      input.project.assets.find((asset) => asset.id === 'asset-speaker').sha256 = 'e'.repeat(64);
    },
    (input) => {
      input.project.assets.find((asset) => asset.id === 'asset-prepared').size += 1;
    },
    (input) => {
      input.job.materialAcquisitionResult.focusstockVisualEvidence.runs.push({ id: 'drift' });
      input.revision.materialAcquisitionResult.focusstockVisualEvidence.runs.push({ id: 'drift' });
    },
    (input) => {
      for (const outputs of [
        input.job.outputs,
        input.revision.outputs,
        input.job.renderEvidence.outputs,
        input.revision.renderEvidence.outputs,
      ]) outputs.push({ ...outputs[0] });
    },
  ];
  for (const mutate of mutations) {
    const input = carriedFixture();
    mutate(input);
    assert.equal(verifyRecordedCompositionEvidence(input), null);
  }
});

test('carried evidence requires the durable child Revision to name the exact verified parent', () => {
  for (const parentRevisionId of [null, 'v004']) {
    const input = carriedFixture();
    input.revision.parentRevisionId = parentRevisionId;
    assert.equal(verifyRecordedCompositionEvidence(input), null, String(parentRevisionId));
  }
});

test('every prepared placement field is exact-derived and tamper-evident in carried evidence', () => {
  const mutations = [
    (placement) => { placement.profileId = 'wrong-profile'; },
    (placement) => { placement.layoutId = 'wrong-layout'; },
    (placement) => { placement.startSec = 2.1; },
    (placement) => { placement.endSec = 3.1; },
    (placement) => { placement.compositionTimeline = 'WrongComposition'; },
    (placement) => { placement.compositionOffsetFrames = 31; },
    (placement) => { placement.compositionStartFrame = 91; },
    (placement) => { placement.compositionEndFrame = 121; },
    (placement) => { placement.compositionStartSec = 3.1; },
    (placement) => { placement.compositionEndSec = 4.1; },
    (placement) => { placement.focusstockVisualEvidenceSha256 = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const input = carriedFixture();
    const jobPlacement = input.job.timelinePlacements.find(
      (item) => item.kind === 'prepared-phone-video');
    const revisionPlacement = input.revision.timelinePlacements.find(
      (item) => item.kind === 'prepared-phone-video');
    mutate(jobPlacement);
    mutate(revisionPlacement);
    assert.equal(verifyRecordedCompositionEvidence(input), null);
  }
});
