'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  materializeFocusstockBrollCarryForward,
  preflightFocusstockBrollCarryForward,
  prepareFocusstockBrollCarryForward,
  validateFocusstockBrollCarryPlan,
  writeCanonicalPlan,
} = require('./focusstock-broll-carry-forward');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focusstock-carry-forward-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetDirectory = path.join(root, 'assets');
  const outputDirectory = path.join(root, 'outputs');
  const materializationDirectory = path.join(root, 'input');
  fs.mkdirSync(assetDirectory);
  fs.mkdirSync(outputDirectory);
  fs.mkdirSync(materializationDirectory);

  const childScript = Buffer.from('VOICE: synthetic\n\n相同的完整 child buildScript');
  const sourceScriptSha256 = sha256(childScript);
  const assets = [];
  const cards = [];
  const placements = [];
  const artifactInputs = [];
  artifactInputs.push({
    path: 'public/script.txt',
    size: childScript.length,
    sha256: sourceScriptSha256,
  });
  const assetPaths = new Map();
  for (let index = 1; index <= 7; index += 1) {
    const bytes = Buffer.from(`synthetic-broll-${index}-exact-bytes`);
    const digest = sha256(bytes);
    const assetRef = `asset-video-${index}`;
    const assetPath = path.join(assetDirectory, `${assetRef}.mp4`);
    fs.writeFileSync(assetPath, bytes);
    assetPaths.set(assetRef, assetPath);
    assets.push({
      id: assetRef,
      kind: 'video',
      mediaType: 'video/mp4',
      originalName: `source-${index}.mp4`,
      sha256: digest,
      size: bytes.length,
      path: `assets/${assetRef}.mp4`,
    });
    const startSec = index === 7 ? 12 : (index * 2) - 1;
    const endSec = index === 7 ? 13 : index * 2;
    const card = {
      id: `broll-${String(index).padStart(2, '0')}`,
      assetRef,
      assetSha256: digest,
      startCharIdx: (index - 1) * 10,
      endCharIdx: (index * 10) - 1,
      resolvedPlacement: { startSec, endSec },
    };
    cards.push(card);
    placements.push({
      clipId: card.id,
      assetRef,
      assetSha256: digest,
      startSec,
      endSec,
      evidenceLevel: 'reconstructed-after-render',
    });
    artifactInputs.push({
      path: `public/broll${index}.mp4`,
      size: bytes.length,
      sha256: digest,
    });
  }

  const speakerBytes = Buffer.from('synthetic-speaker-exact-bytes');
  const speakerSha256 = sha256(speakerBytes);
  const speakerAsset = {
    id: 'asset-speaker-video',
    kind: 'speaker-video',
    mediaType: 'video/mp4',
    originalName: 'speaker.mp4',
    sha256: speakerSha256,
    size: speakerBytes.length,
    path: 'assets/asset-speaker-video.mp4',
  };
  const speakerPath = path.join(assetDirectory, 'asset-speaker-video.mp4');
  fs.writeFileSync(speakerPath, speakerBytes);
  assetPaths.set(speakerAsset.id, speakerPath);
  assets.push(speakerAsset);
  artifactInputs.push({
    path: 'public/heygen.mp4',
    size: speakerBytes.length,
    sha256: speakerSha256,
  });

  const outputBytes = Buffer.from('synthetic-parent-durable-output');
  const outputSha256 = sha256(outputBytes);
  const outputPath = path.join(outputDirectory, 'v005-run-parent-output-focusstock.mp4');
  fs.writeFileSync(outputPath, outputBytes);
  const output = {
    name: 'output-focusstock.mp4',
    size: outputBytes.length,
    sha256: outputSha256,
  };
  const renderInputManifest = {
    schemaVersion: 1,
    template: 'focusstock',
    compositionId: 'Focusstock',
    artifactInputs,
  };
  const renderInputManifestSha256 = sha256(JSON.stringify(renderInputManifest));
  const graphicBroll = {
    schemaVersion: 1,
    mode: 'composition-v1',
    sourceScriptSha256,
    cards,
    provenance: {
      level: 'reconstructed-after-render',
      output,
    },
  };
  const assetRefs = [speakerAsset.id, ...cards.map((card) => card.assetRef)];
  const renderEvidence = {
    schemaVersion: 1,
    renderInputManifestSha256,
    outputs: [output],
  };
  const project = {
    id: 'project-synthetic',
    template: 'focusstock',
    assets,
  };
  const parentJob = {
    id: 'run-parent',
    projectId: project.id,
    revisionId: 'v005',
    template: 'focusstock',
    status: 'done',
    assetRefs,
    graphicBroll,
    timelinePlacements: placements,
    outputs: [output],
    renderInputManifest,
    renderInputManifestSha256,
    renderEvidence,
  };
  const parentRevision = {
    id: 'v005',
    projectId: project.id,
    jobId: parentJob.id,
    runId: parentJob.id,
    status: 'done',
    assetRefs,
    graphicBroll,
    timelinePlacements: placements,
    outputs: [output],
    renderInputManifest,
    renderInputManifestSha256,
    renderEvidence,
  };
  const preparedPlanSha256 = sha256('synthetic-prepared-plan');
  const preparedPlacement = {
    kind: 'prepared-phone-video',
    timelineBasis: 'focusstock-main-v1',
    visualOwner: 'prepared-phone-video',
    conflictPolicy: 'suppress-entire-overlapping-placement',
    fps: 30,
    startFrame: 360,
    endFrame: 390,
    durationInFrames: 30,
    compositionOffsetFrames: 30,
    compositionStartFrame: 390,
    compositionEndFrame: 420,
    sourceSha256: sha256('synthetic-prepared-video'),
    planSha256: preparedPlanSha256,
  };
  let materializeCalls = 0;
  const projectStore = {
    assetPath(projectId, assetRef) {
      assert.equal(projectId, project.id);
      return assetPaths.get(assetRef) || null;
    },
    materializeAsset(projectId, assetRef, target) {
      assert.equal(projectId, project.id);
      materializeCalls += 1;
      fs.copyFileSync(assetPaths.get(assetRef), target);
    },
  };
  const options = {
    project,
    childProjectId: project.id,
    explicitParentRevisionId: parentRevision.id,
    parentRevision,
    parentJob,
    childScript,
    projectStore,
    resolveOutputPath: () => outputPath,
    preparedPlacement,
    preparedPlanSha256,
    materializationDirectory,
  };
  return {
    ...options,
    assetPaths,
    get materializeCalls() { return materializeCalls; },
    setMaterializer(materializeAsset) { projectStore.materializeAsset = materializeAsset; },
    outputPath,
    resignManifest() {
      const digest = sha256(JSON.stringify(parentJob.renderInputManifest));
      parentJob.renderInputManifestSha256 = digest;
      parentRevision.renderInputManifestSha256 = digest;
      parentJob.renderEvidence.renderInputManifestSha256 = digest;
      parentRevision.renderEvidence.renderInputManifestSha256 = digest;
    },
  };
}

function expectCarryError(run, code, reason = null) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code);
    if (reason) assert.equal(error.reason, reason);
    return true;
  });
}

test('two-phase preflight keeps B-roll 1-6, suppresses overlapping B-roll 7, and materializes all exact bytes', (t) => {
  const input = fixture(t);
  const sourceOnly = preflightFocusstockBrollCarryForward({
    ...input,
    preparedPlacement: null,
    preparedPlanSha256: null,
  });
  assert.equal(sourceOnly.plan, null);
  assert.equal(input.materializeCalls, 0, 'pure source preflight must not materialize');
  assert.equal(sourceOnly.sourceSnapshot.cards.length, 7);

  const first = preflightFocusstockBrollCarryForward(input);
  const second = preflightFocusstockBrollCarryForward(input);
  assert.equal(first.sourceCanonical, second.sourceCanonical);
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.equal(first.planCanonical, second.planCanonical);
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(sha256(first.planCanonical), first.planSha256);
  assert.equal(validateFocusstockBrollCarryPlan(first.plan), first.plan);
  assert.equal(
    sha256(JSON.stringify(first.plan.parent.evidence)),
    first.plan.parent.evidenceSha256,
  );
  assert.deepEqual(first.plan.cards.map((card) => card.ordinal), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(first.plan.cards.every((card) => card.mediaType === 'video/mp4'), true);
  assert.deepEqual(
    first.plan.cards.map((card) => card.disposition),
    [
      'rendered', 'rendered', 'rendered', 'rendered', 'rendered', 'rendered',
      'suppressed_by_prepared',
    ],
  );
  assert.deepEqual(
    first.plan.cards.map((card) => card.suppressedBy),
    [null, null, null, null, null, null, 'prepared-phone-video'],
  );
  assert.equal(first.plan.cards[5].mainEndFrame, first.plan.prepared.startFrame,
    'endpoint-only touch remains rendered');
  assert.equal(first.plan.cards[6].mainStartFrame, first.plan.prepared.startFrame,
    'a half-open intersection suppresses the whole B-roll 7');
  assert.equal(first.plan.cards[6].compositionStartFrame,
    first.plan.cards[6].mainStartFrame + 30);

  const materialized = materializeFocusstockBrollCarryForward({
    preflight: first,
    projectStore: input.projectStore,
    materializationDirectory: input.materializationDirectory,
  });
  assert.equal(materialized.length, 7);
  assert.equal(input.materializeCalls, 7, 'suppressed clips are still materialized and evidenced');
  for (const item of materialized) {
    assert.equal(sha256(fs.readFileSync(item.target)), item.sha256);
  }
  assert.equal(materialized[6].disposition, 'suppressed_by_prepared');

  const retried = materializeFocusstockBrollCarryForward({
    preflight: first,
    projectStore: input.projectStore,
    materializationDirectory: input.materializationDirectory,
  });
  assert.equal(input.materializeCalls, 7, 'an exact retry must not rewrite targets');
  assert.equal(retried.every((item) => item.reusedExactBytes), true);

  const planFile = path.join(input.materializationDirectory, 'carry-plan.json');
  const written = writeCanonicalPlan(planFile, first.plan);
  assert.equal(written.sha256, first.planSha256);
  assert.equal(sha256(fs.readFileSync(planFile)), first.planSha256);
  assert.equal(writeCanonicalPlan(planFile, first.plan).reused, true);
});

test('missing render manifest fails before any materialize callback', (t) => {
  const input = fixture(t);
  delete input.parentJob.renderInputManifest;
  expectCarryError(
    () => prepareFocusstockBrollCarryForward(input),
    'parent_broll_evidence_unverified',
    'render_input_manifest_missing',
  );
  assert.equal(input.materializeCalls, 0);
});

test('child buildScript SHA must exactly equal the parent B-roll source script', (t) => {
  const input = fixture(t);
  input.childScript = Buffer.from('drifted child buildScript');
  expectCarryError(
    () => preflightFocusstockBrollCarryForward(input),
    'child_script_drift',
    'source_script_sha256_mismatch',
  );
});

test('parent manifest must uniquely bind exact child script bytes', async (t) => {
  await t.test('missing public/script.txt input', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.renderInputManifest.artifactInputs = input.parentJob.renderInputManifest
      .artifactInputs.filter((item) => item.path !== 'public/script.txt');
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_script_manifest_invalid',
      'parent_script_manifest_binding_missing',
    );
  });
  await t.test('script input bytes mismatch', (subtest) => {
    const input = fixture(subtest);
    const scriptInput = input.parentJob.renderInputManifest.artifactInputs
      .find((item) => item.path === 'public/script.txt');
    scriptInput.sha256 = 'f'.repeat(64);
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_script_manifest_invalid',
      'parent_script_manifest_binding_mismatch',
    );
  });
  await t.test('duplicate public/script.txt input', (subtest) => {
    const input = fixture(subtest);
    const scriptInput = input.parentJob.renderInputManifest.artifactInputs
      .find((item) => item.path === 'public/script.txt');
    input.parentJob.renderInputManifest.artifactInputs.push({
      ...scriptInput,
      size: scriptInput.size + 1,
      sha256: 'e'.repeat(64),
    });
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_script_manifest_invalid',
      'parent_script_manifest_binding_ambiguous',
    );
  });
});

test('parent manifest must identify Focusstock and keep selected paths globally unique', async (t) => {
  await t.test('wrong template identity', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.renderInputManifest.template = 'reels';
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_render_manifest_invalid',
      'parent_manifest_focusstock_identity_mismatch',
    );
  });
  await t.test('wrong composition identity', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.renderInputManifest.compositionId = 'MorningNews';
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_render_manifest_invalid',
      'parent_manifest_focusstock_identity_mismatch',
    );
  });
  await t.test('speaker path has one correct and one conflicting entry', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.renderInputManifest.artifactInputs.push({
      path: 'public/heygen.mp4',
      size: 1,
      sha256: 'd'.repeat(64),
    });
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'broll_manifest_binding_invalid',
      'speaker_manifest_path_ambiguous',
    );
  });
  await t.test('B-roll path has one correct and one conflicting entry', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.renderInputManifest.artifactInputs.push({
      path: 'public/broll1.mp4',
      size: 1,
      sha256: 'c'.repeat(64),
    });
    input.resignManifest();
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'broll_manifest_binding_invalid',
      'broll_manifest_path_ambiguous',
    );
  });
});

test('carry-forward requires an explicit parent in the same Project', async (t) => {
  await t.test('missing explicit parent', (subtest) => {
    const input = fixture(subtest);
    input.explicitParentRevisionId = null;
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_revision_not_explicit',
      'explicit_parent_revision_required',
    );
  });
  await t.test('cross-Project child', (subtest) => {
    const input = fixture(subtest);
    input.childProjectId = 'project-other';
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'parent_project_mismatch',
      'same_project_required',
    );
  });
});

test('parent speaker selection and bytes fail closed', async (t) => {
  await t.test('speaker bytes drift', (subtest) => {
    const input = fixture(subtest);
    fs.writeFileSync(input.assetPaths.get('asset-speaker-video'), 'drifted-speaker-bytes');
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'speaker_asset_bytes_drifted',
      'speaker_asset_bytes_drifted',
    );
  });
  await t.test('ambiguous speaker selection', (subtest) => {
    const input = fixture(subtest);
    const duplicate = {
      ...input.project.assets.find((asset) => asset.id === 'asset-speaker-video'),
      id: 'asset-speaker-other',
      path: 'assets/asset-speaker-other.mp4',
    };
    input.project.assets.push(duplicate);
    input.parentJob.assetRefs = [...input.parentJob.assetRefs, duplicate.id];
    input.parentRevision.assetRefs = [...input.parentRevision.assetRefs, duplicate.id];
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'speaker_selection_invalid',
      'unique_parent_speaker_required',
    );
  });
});

test('prepared identity and finalized preflight cannot drift before materialization', async (t) => {
  await t.test('compiled prepared plan identity mismatch', (subtest) => {
    const input = fixture(subtest);
    input.preparedPlacement.planSha256 = 'f'.repeat(64);
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'prepared_placement_invalid',
      'compiled_prepared_identity_invalid',
    );
  });
  await t.test('final plan mutated after preflight', (subtest) => {
    const input = fixture(subtest);
    const preflight = preflightFocusstockBrollCarryForward(input);
    preflight.plan.prepared.startFrame += 1;
    expectCarryError(
      () => materializeFocusstockBrollCarryForward({
        preflight,
        projectStore: input.projectStore,
        materializationDirectory: input.materializationDirectory,
      }),
      'carry_plan_invalid',
      'preflight_snapshot_drifted',
    );
    assert.equal(input.materializeCalls, 0);
  });
});

test('Project Asset bytes are verified before carry-forward', (t) => {
  const input = fixture(t);
  fs.writeFileSync(input.assetPaths.get('asset-video-3'), 'drifted-broll-bytes');
  expectCarryError(
    () => preflightFocusstockBrollCarryForward(input),
    'broll_asset_bytes_drifted',
    'project_asset_bytes_drifted',
  );
});

test('parent durable output bytes are verified before carry-forward', (t) => {
  const input = fixture(t);
  fs.writeFileSync(input.outputPath, 'drifted-output-bytes');
  expectCarryError(
    () => preflightFocusstockBrollCarryForward(input),
    'parent_output_bytes_drifted',
    'parent_output_bytes_drifted',
  );
});

test('duplicate parent placement or selected B-roll Asset fails with a stable code', async (t) => {
  await t.test('duplicate job placement', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.timelinePlacements.push({ ...input.parentJob.timelinePlacements[0] });
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'duplicate_broll_placement',
      'duplicate_job_placement',
    );
  });
  await t.test('duplicate B-roll Asset selection', (subtest) => {
    const input = fixture(subtest);
    input.parentJob.graphicBroll.cards[1].assetRef
      = input.parentJob.graphicBroll.cards[0].assetRef;
    expectCarryError(
      () => preflightFocusstockBrollCarryForward(input),
      'duplicate_broll_asset',
      'duplicate_card_asset_ref',
    );
  });
});

test('materialized target must match the preflighted exact bytes', (t) => {
  const input = fixture(t);
  const preflight = preflightFocusstockBrollCarryForward(input);
  input.setMaterializer((_projectId, _assetRef, target) => {
    fs.writeFileSync(target, 'wrong-materialized-bytes');
  });
  expectCarryError(
    () => materializeFocusstockBrollCarryForward({
      preflight,
      projectStore: input.projectStore,
      materializationDirectory: input.materializationDirectory,
    }),
    'materialized_asset_bytes_drifted',
    'materialized_target_bytes_drifted',
  );
});
