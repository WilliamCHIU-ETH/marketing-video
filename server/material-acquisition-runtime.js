'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createChipKCaptureCliAdapter } = require('./chipk-capture-cli-adapter');
const {
  MaterialAcquisitionError,
  acquireOptionalMaterial,
  buildCaptureRequest,
} = require('./material-acquisition');
const FOCUSSTOCK_VISUAL_TIMING = require(
  '../src/Focusstock/focusstock-visual-timing.contract.json');
const { halfOpenFrameIntervalsOverlap } = require(
  '../src/Focusstock/focusstock-half-open');
const { validateFocusstockBrollCarryPlan } = require('./focusstock-broll-carry-forward');

const PREPARED_VIDEO_INPUT = 'prepared-phone-material.mp4';
const PREPARED_INTENT_INPUT = 'prepared-phone-material.intent.json';
const PREPARED_PLAN = path.posix.join(
  'src', 'Focusstock', 'prepared-phone-material.generated.json');
const FOCUSSTOCK_BROLL_PLAN = path.posix.join(
  'src', 'Focusstock', 'focusstock-broll.generated.json');
const FOCUSSTOCK_BROLL_SOURCE_INPUT = 'focusstock-broll-carry.source.json';
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PREPARED_FPS = 30;
const FOCUSSTOCK_MAIN_OFFSET_FRAMES = PREPARED_FPS;
const FOCUSSTOCK_SHOT_MERGE_GAP_SEC = FOCUSSTOCK_VISUAL_TIMING.mergeGapSec;
const FOCUSSTOCK_SHOTS = path.posix.join(
  'src', 'Focusstock', 'focusstock-shots.generated.json');
const SUBTITLES = path.posix.join('src', 'subtitles.json');
const REVIEW_EDIT_TRANSACTION = 'review-edit-transaction.json';
const REVIEW_EDIT_PLAN = path.posix.join('state', FOCUSSTOCK_SHOTS);

function fail(message, code, details) {
  throw new MaterialAcquisitionError(message, code, details);
}

function ensureOwnedDirectory(parent, name) {
  const root = fs.realpathSync(parent);
  const target = path.join(root, name);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target)
    fail('Acquisition runtime directory is unsafe', 'acquisition_directory_invalid');
  return target;
}

function nextShotName(inputDirectory) {
  const used = new Set();
  for (const name of fs.readdirSync(inputDirectory)) {
    const match = /^shot(\d{1,3})\.(?:png|jpe?g)$/i.exec(name);
    if (match) used.add(Number(match[1]));
  }
  let index = 1;
  while (used.has(index) && index <= 999) index += 1;
  if (index > 999) fail('No safe shot filename is available', 'materialization_failed');
  return `shot${index}.png`;
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
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const REVIEW_EDIT_EVIDENCE_FIELDS = [
  'assetRefs', 'focusstockVisualInputs', 'materialAcquisitionResult', 'graphicBroll',
  'timelinePlacements', 'renderInputManifest', 'renderInputManifestSha256',
  'outputs', 'renderEvidence',
];

function reviewEditEvidence(record, includePendingEdits = false) {
  const snapshot = {};
  for (const key of REVIEW_EDIT_EVIDENCE_FIELDS) snapshot[key] = cloneJson(record?.[key] ?? null);
  if (includePendingEdits) snapshot.pendingEdits = cloneJson(record?.pendingEdits || []);
  return snapshot;
}

function applyReviewEditJobEvidence(job, snapshot) {
  for (const [key, value] of Object.entries(snapshot)) job[key] = cloneJson(value);
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteDurable(file, bytes) {
  const directory = path.dirname(file);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    fsyncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

function reviewEditFiles(jobDirectory) {
  let root;
  try {
    const stat = fs.lstatSync(jobDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe Run directory');
    root = fs.realpathSync(jobDirectory);
  } catch (_) {
    fail('Review edit Run directory is unsafe', 'review_edit_transaction_invalid');
  }
  const plan = path.join(root, ...REVIEW_EDIT_PLAN.split('/'));
  return {
    root,
    plan,
    jobFile: path.join(root, 'job.json'),
    marker: path.join(root, REVIEW_EDIT_TRANSACTION),
  };
}

function requireSafeReviewEditPlanParent(files) {
  let cursor = files.root;
  for (const component of path.dirname(REVIEW_EDIT_PLAN).split('/')) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (_) {}
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      fail('Review edit plan directory is unsafe', 'review_edit_transaction_invalid');
  }
}

function requireRegularReviewEditPlan(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) {}
  if (!stat?.isFile() || stat.isSymbolicLink())
    fail('Review edit plan is missing or unsafe', 'review_edit_transaction_invalid');
  return stat;
}

function readRegularJsonFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) {}
  if (!stat?.isFile() || stat.isSymbolicLink())
    fail(`${label} is missing or unsafe`, 'review_edit_transaction_invalid');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail(`${label} is invalid`, 'review_edit_transaction_invalid'); }
}

function validateReviewEditStage(stage, needsBytes) {
  const plan = stage?.plan;
  if (!plan || !Number.isSafeInteger(plan.size) || plan.size < 1
      || !SHA256_HEX.test(plan.sha256 || '') || !stage.evidence
      || !SHA256_HEX.test(stage.evidenceSha256 || '')
      || hashJson(stage.evidence) !== stage.evidenceSha256) {
    fail('Review edit transaction snapshot is invalid', 'review_edit_transaction_invalid');
  }
  if (!needsBytes) return null;
  const bytes = Buffer.from(plan.bytesBase64 || '', 'base64');
  if (!plan.bytesBase64 || bytes.toString('base64') !== plan.bytesBase64
      || bytes.length !== plan.size
      || crypto.createHash('sha256').update(bytes).digest('hex') !== plan.sha256) {
    fail('Review edit baseline bytes are invalid', 'review_edit_transaction_invalid');
  }
  return bytes;
}

function readPreparedPhoneReviewEditTransaction({ job, jobDirectory }) {
  const files = reviewEditFiles(jobDirectory);
  if (!fs.existsSync(files.marker)) return null;
  requireSafeReviewEditPlanParent(files);
  const journal = readRegularJsonFile(files.marker, 'Review edit transaction marker');
  if (!journal || journal.schemaVersion !== 1
      || journal.kind !== 'prepared-phone-review-edit-v1'
      || !/^[0-9a-f-]{36}$/i.test(journal.transactionId || '')
      || journal.jobId !== job?.id || journal.planRelativePath !== REVIEW_EDIT_PLAN
      || !['prepared', 'commit_intent'].includes(journal.phase)) {
    fail('Review edit transaction marker identity is invalid',
      'review_edit_transaction_invalid');
  }
  validateReviewEditStage(journal.baseline, true);
  if (journal.phase === 'commit_intent') {
    validateReviewEditStage(journal.target, false);
  } else if (journal.target !== null) {
    fail('Prepared review edit transaction cannot have a target',
      'review_edit_transaction_invalid');
  }
  return { files, journal };
}

function beginPreparedPhoneReviewEditTransaction({ job, jobDirectory, revision }) {
  const files = reviewEditFiles(jobDirectory);
  if (fs.existsSync(files.marker))
    fail('A review edit transaction already exists', 'review_edit_transaction_pending');
  requireSafeReviewEditPlanParent(files);
  requireRegularReviewEditPlan(files.plan);
  const diskJob = readRegularJsonFile(files.jobFile, 'Review edit Job record');
  const evidence = reviewEditEvidence(job, true);
  if (diskJob.id !== job.id || revision?.jobId !== job.id || revision?.runId !== job.id
      || JSON.stringify(reviewEditEvidence(diskJob, true)) !== JSON.stringify(evidence)
      || JSON.stringify(reviewEditEvidence(revision))
        !== JSON.stringify(reviewEditEvidence(job))) {
    fail('Review edit baseline is not durable in both Job and Revision',
      'review_edit_transaction_invalid');
  }
  const planBytes = fs.readFileSync(files.plan);
  const journal = {
    schemaVersion: 1,
    kind: 'prepared-phone-review-edit-v1',
    transactionId: crypto.randomUUID(),
    jobId: job.id,
    planRelativePath: REVIEW_EDIT_PLAN,
    phase: 'prepared',
    baseline: {
      plan: {
        size: planBytes.length,
        sha256: crypto.createHash('sha256').update(planBytes).digest('hex'),
        bytesBase64: planBytes.toString('base64'),
      },
      evidence,
      evidenceSha256: hashJson(evidence),
    },
    target: null,
  };
  atomicWriteDurable(files.marker, `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

function immutableReviewIdentity(snapshot) {
  const result = cloneJson(snapshot.materialAcquisitionResult);
  if (result) {
    delete result.focusstockVisualEvidence;
    delete result.focusstockVisualEvidenceSha256;
  }
  return {
    assetRefs: snapshot.assetRefs,
    focusstockVisualInputs: snapshot.focusstockVisualInputs,
    materialAcquisitionResult: result,
    outputs: snapshot.outputs,
    renderEvidence: snapshot.renderEvidence,
  };
}

function recordPreparedPhoneReviewEditCommitIntent({
  job,
  jobDirectory,
  transactionId,
}) {
  const current = readPreparedPhoneReviewEditTransaction({ job, jobDirectory });
  if (!current || current.journal.transactionId !== transactionId
      || current.journal.phase !== 'prepared') {
    fail('Review edit transaction is not ready for commit intent',
      'review_edit_transaction_invalid');
  }
  const pendingEdits = job.pendingEdits;
  job.pendingEdits = [];
  try {
    const evidence = reviewEditEvidence(job, true);
    if (JSON.stringify(immutableReviewIdentity(evidence))
        !== JSON.stringify(immutableReviewIdentity(current.journal.baseline.evidence))) {
      fail('Review edit changed immutable prepared/output identity',
        'review_edit_transaction_invalid');
    }
    const planStat = requireRegularReviewEditPlan(current.files.plan);
    const target = {
      plan: { size: planStat.size, sha256: hashFile(current.files.plan) },
      evidence,
      evidenceSha256: hashJson(evidence),
    };
    const journal = { ...current.journal, phase: 'commit_intent', target };
    atomicWriteDurable(current.files.marker, `${JSON.stringify(journal, null, 2)}\n`);
    return journal;
  } catch (error) {
    job.pendingEdits = pendingEdits;
    throw error;
  }
}

function planMatches(file, snapshot) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) {}
  return !!stat?.isFile() && !stat.isSymbolicLink() && stat.size === snapshot.size
    && hashFile(file) === snapshot.sha256;
}

const snapshotMatches = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

function recoverPreparedPhoneReviewEditTransaction({ job, jobDirectory, revision }) {
  const current = readPreparedPhoneReviewEditTransaction({ job, jobDirectory });
  if (!current) return null;
  const { files, journal } = current;
  const diskJob = readRegularJsonFile(files.jobFile, 'Review edit Job record');
  if (diskJob.id !== job.id || revision?.jobId !== job.id || revision?.runId !== job.id)
    fail('Review edit recovery ownership is ambiguous', 'review_edit_transaction_ambiguous');
  const diskEvidence = reviewEditEvidence(diskJob, true);
  const revisionEvidence = reviewEditEvidence(revision);
  const baseline = journal.baseline.evidence;
  if (journal.phase === 'commit_intent') {
    const target = journal.target.evidence;
    if (planMatches(files.plan, journal.target.plan)
        && snapshotMatches(diskEvidence, target)
        && snapshotMatches(revisionEvidence, reviewEditEvidence(target))) {
      applyReviewEditJobEvidence(job, target);
      return { action: 'commit_confirmed', transactionId: journal.transactionId };
    }
    const jobKnown = snapshotMatches(diskEvidence, baseline)
      || snapshotMatches(diskEvidence, target);
    const revisionKnown = [baseline, target].some((candidate) =>
      snapshotMatches(revisionEvidence, reviewEditEvidence(candidate)));
    const planKnown = planMatches(files.plan, journal.baseline.plan)
      || planMatches(files.plan, journal.target.plan);
    if (!jobKnown || !revisionKnown || !planKnown)
      fail('Review edit recovery found unknown committed state',
        'review_edit_transaction_ambiguous');
  } else if (!snapshotMatches(diskEvidence, baseline)
      || !snapshotMatches(revisionEvidence, reviewEditEvidence(baseline))) {
    fail('Prepared review edit transaction changed durable evidence unexpectedly',
      'review_edit_transaction_ambiguous');
  }
  const baselineBytes = validateReviewEditStage(journal.baseline, true);
  atomicWriteDurable(files.plan, baselineBytes);
  applyReviewEditJobEvidence(job, baseline);
  return { action: 'baseline_restored', transactionId: journal.transactionId };
}

function finalizePreparedPhoneReviewEditTransaction({
  job,
  jobDirectory,
  revision,
  transactionId,
  expected,
}) {
  const current = readPreparedPhoneReviewEditTransaction({ job, jobDirectory });
  if (!current || current.journal.transactionId !== transactionId
      || !['baseline', 'target'].includes(expected)) {
    fail('Review edit transaction cleanup identity is invalid',
      'review_edit_transaction_invalid');
  }
  const selected = expected === 'target'
    ? current.journal.target : current.journal.baseline;
  if (!selected || !planMatches(current.files.plan, selected.plan))
    fail('Review edit transaction plan is not durably settled',
      'review_edit_transaction_invalid');
  const diskJob = readRegularJsonFile(current.files.jobFile, 'Review edit Job record');
  if (!snapshotMatches(reviewEditEvidence(diskJob, true), selected.evidence)
      || !snapshotMatches(reviewEditEvidence(revision), reviewEditEvidence(selected.evidence))) {
    fail('Review edit Job/Revision evidence is not durably settled',
      'review_edit_transaction_invalid');
  }
  const markerStat = fs.lstatSync(current.files.marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink())
    fail('Review edit transaction marker is unsafe', 'review_edit_transaction_invalid');
  fs.unlinkSync(current.files.marker);
  fsyncDirectory(current.files.root);
  return true;
}

function focusstockVisualFrameInterval(startSec, endSec) {
  if (FOCUSSTOCK_VISUAL_TIMING.schemaVersion !== 1
      || FOCUSSTOCK_VISUAL_TIMING.fps !== PREPARED_FPS
      || FOCUSSTOCK_VISUAL_TIMING.frameInterval?.start
        !== 'round-start-sec-times-fps'
      || FOCUSSTOCK_VISUAL_TIMING.frameInterval?.duration
        !== 'max-one-round-duration-sec-times-fps'
      || FOCUSSTOCK_VISUAL_TIMING.frameInterval?.semantics !== 'half-open'
      || !Number.isFinite(startSec) || !Number.isFinite(endSec)
      || startSec < 0 || endSec <= startSec) {
    fail('Focusstock visual frame timing contract is invalid', 'placement_compile_failed');
  }
  const startFrame = Math.round(startSec * PREPARED_FPS);
  const durationInFrames = Math.max(
    1, Math.round((endSec - startSec) * PREPARED_FPS));
  return {
    fps: PREPARED_FPS,
    startFrame,
    endFrame: startFrame + durationInFrames,
    durationInFrames,
  };
}

function readRegularJson(root, relativePath, label) {
  const file = path.join(root, ...relativePath.split('/'));
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) {}
  if (!stat?.isFile() || stat.isSymbolicLink())
    fail(`${label} is missing or unsafe`, 'placement_compile_failed');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail(`${label} is invalid`, 'placement_compile_failed'); }
  return { file, value, sha256: hashFile(file) };
}

function validateBoundVisualFile(root, binding) {
  const file = path.join(root, 'public', binding.inputName);
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) {}
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== binding.size
      || hashFile(file) !== binding.sha256) {
    fail(`Focusstock image bytes drifted: ${binding.inputName}`, 'placement_compile_failed');
  }
}

function validateFocusstockBrollAssetBindings({ job, projectStore, workspaceRoot, assetsById }) {
  const record = job.focusstockBrollCarryForward;
  if (!record) return { assetRefs: new Set(), plan: null };
  const planFile = readRegularJson(workspaceRoot, FOCUSSTOCK_BROLL_PLAN,
    'Focusstock B-roll plan');
  const sourceFile = path.join(workspaceRoot, 'public', FOCUSSTOCK_BROLL_SOURCE_INPUT);
  let sourceStat;
  let sourceRaw;
  try {
    sourceStat = fs.lstatSync(sourceFile);
    sourceRaw = fs.readFileSync(sourceFile, 'utf8');
  } catch (_) {}
  try { validateFocusstockBrollCarryPlan(planFile.value); }
  catch (error) {
    fail(`Focusstock B-roll carry plan is invalid: ${error.reason || error.message}`,
      'placement_compile_failed');
  }
  const plan = planFile.value;
  if (record.schemaVersion !== 1 || record.status !== 'compiled'
      || record.mode !== 'carried-v1' || record.planFile !== FOCUSSTOCK_BROLL_PLAN
      || record.sourceInputName !== FOCUSSTOCK_BROLL_SOURCE_INPUT
      || plan.parent?.projectId !== job.projectId
      || record.sourceSnapshot?.parent?.projectId !== job.projectId
      || record.sourceSnapshot?.parent?.projectId !== plan.parent?.projectId
      || record.sourceSnapshot?.parent?.revisionId !== plan.parent?.revisionId
      || record.sourceSnapshot?.parent?.runId !== plan.parent?.runId
      || record.parentRevisionId !== plan.parent.revisionId
      || record.planSha256 !== planFile.sha256 || record.planSha256 !== hashJson(plan)
      || JSON.stringify(record.plan) !== JSON.stringify(plan)
      || record.sourceSnapshotSha256 !== plan.sourceSnapshotSha256
      || JSON.stringify(record.sourceSnapshot) !== sourceRaw
      || !sourceStat?.isFile() || sourceStat.isSymbolicLink()
      || hashFile(sourceFile) !== record.sourceSnapshotSha256
      || !Array.isArray(record.materialized)
      || record.materialized.length !== plan.cards.length) {
    fail('Focusstock B-roll Run binding is incomplete', 'placement_compile_failed');
  }

  const prepared = readRegularJson(workspaceRoot, PREPARED_PLAN, 'Prepared phone plan');
  const preparedPlacement = prepared.value?.placement;
  if (prepared.sha256 !== plan.prepared.planSha256
      || prepared.value?.source?.sha256 !== plan.prepared.sourceSha256
      || preparedPlacement?.fps !== plan.prepared.fps
      || preparedPlacement?.startFrame !== plan.prepared.startFrame
      || preparedPlacement?.endFrame !== plan.prepared.endFrame
      || preparedPlacement?.durationInFrames !== plan.prepared.durationInFrames
      || plan.prepared.intervalSemantics !== 'frame-half-open'
      || job.materialAcquisitionResult?.compiledPlanSha256 !== plan.prepared.planSha256
      || job.materialAcquisitionResult?.preparedArtifact?.sha256
        !== plan.prepared.sourceSha256) {
    fail('Focusstock B-roll prepared binding drifted', 'placement_compile_failed');
  }

  const selectedRefs = new Set(job.assetRefs);
  const boundRefs = new Set();
  for (const [index, card] of plan.cards.entries()) {
    const materialized = record.materialized[index];
    const asset = assetsById.get(card.assetRef);
    const source = asset && projectStore.assetPath(job.projectId, asset.id);
    const publicFile = path.join(workspaceRoot, 'public', card.inputName);
    let sourceAssetStat;
    let publicStat;
    try { sourceAssetStat = source && fs.lstatSync(source); } catch (_) {}
    try { publicStat = fs.lstatSync(publicFile); } catch (_) {}
    if (boundRefs.has(card.assetRef) || !selectedRefs.has(card.assetRef)
        || !asset || asset.kind !== 'video' || asset.role != null || asset.origin != null
        || asset.mediaType !== card.mediaType || asset.sha256 !== card.assetSha256
        || asset.size !== card.assetSize
        || !sourceAssetStat?.isFile() || sourceAssetStat.isSymbolicLink()
        || sourceAssetStat.size !== card.assetSize || hashFile(source) !== card.assetSha256
        || !publicStat?.isFile() || publicStat.isSymbolicLink()
        || publicStat.size !== card.assetSize || hashFile(publicFile) !== card.assetSha256
        || !materialized || materialized.cardId !== card.id
        || materialized.assetRef !== card.assetRef
        || materialized.inputName !== card.inputName
        || materialized.size !== card.assetSize || materialized.sha256 !== card.assetSha256
        || materialized.disposition !== card.disposition
        || typeof materialized.reusedExactBytes !== 'boolean') {
      fail(`Focusstock B-roll Asset binding drifted: ${card.assetRef}`,
        'placement_compile_failed');
    }
    boundRefs.add(card.assetRef);
  }
  return { assetRefs: boundRefs, plan };
}

function validatePreparedFocusstockAssetRefs({ job, projectStore, workspaceRoot }) {
  if (job.materialAcquisition?.operation !== 'prepared-video') return [];
  const bindings = job.focusstockVisualInputs == null ? [] : job.focusstockVisualInputs;
  if (!Array.isArray(bindings))
    fail('Ready-to-place image bindings are invalid', 'placement_compile_failed');
  if (!Array.isArray(job.assetRefs) || new Set(job.assetRefs).size !== job.assetRefs.length)
    fail('Ready-to-place Revision assetRefs are invalid', 'placement_compile_failed');
  const project = projectStore.get(job.projectId);
  if (!project) fail('Ready-to-place Project is missing', 'placement_compile_failed');
  const assetsById = new Map((project.assets || []).map((asset) => [asset.id, asset]));
  const carried = validateFocusstockBrollAssetBindings({
    job, projectStore, workspaceRoot, assetsById,
  });
  const bindingByRef = new Map(bindings.map((binding) => [binding?.assetRef, binding]));
  if (bindingByRef.size !== bindings.length)
    fail('Ready-to-place image bindings are duplicated', 'placement_compile_failed');
  for (const binding of bindings) {
    const asset = assetsById.get(binding.assetRef);
    const file = asset && projectStore.assetPath(job.projectId, asset.id);
    let stat;
    try { stat = file && fs.lstatSync(file); } catch (_) {}
    if (!asset || asset.kind !== 'image' || asset.role === 'prepared-phone-video'
        || asset.sha256 !== binding.sha256 || asset.size !== binding.size
        || asset.mediaType !== binding.mediaType
        || !stat?.isFile() || stat.isSymbolicLink() || stat.size !== binding.size
        || hashFile(file) !== binding.sha256) {
      fail(`Ready-to-place image asset drifted: ${binding.assetRef}`,
        'placement_compile_failed');
    }
  }
  const selectedRefs = new Set(job.assetRefs);
  if (bindings.some((binding) => !selectedRefs.has(binding.assetRef)))
    fail('Selected images do not match ready-to-place bindings', 'placement_compile_failed');
  const currentPreparedRef = job.materialAcquisitionResult?.preparedArtifact?.assetRef || null;
  const speakerRefs = [];
  for (const assetRef of job.assetRefs) {
    if (bindingByRef.has(assetRef)) continue;
    if (carried.assetRefs.has(assetRef)) continue;
    const asset = assetsById.get(assetRef);
    if (!asset)
      fail(`Ready-to-place assetRef is outside the Project: ${assetRef}`,
        'placement_compile_failed');
    if (assetRef === currentPreparedRef) {
      if (asset.kind !== 'video' || asset.role !== 'prepared-phone-video'
          || asset.origin !== 'chipk-simulator-capture') {
        fail('Current prepared asset identity is invalid', 'placement_compile_failed');
      }
      continue;
    }
    if (asset.kind === 'speaker-video' && !asset.role && !asset.origin) {
      speakerRefs.push(assetRef);
      continue;
    }
    fail(`Ready-to-place contains an unbound or unsupported assetRef: ${assetRef}`,
      'placement_compile_failed');
  }
  const committed = job.materialAcquisitionResult?.placementStatus === 'compiled';
  if ((committed && (!currentPreparedRef || !selectedRefs.has(currentPreparedRef)))
      || (!committed && currentPreparedRef)) {
    fail('Prepared assetRef does not match commit state', 'placement_compile_failed');
  }
  if (speakerRefs.length !== 1)
    fail('Ready-to-place requires exactly one speaker asset', 'placement_compile_failed');
  const speaker = assetsById.get(speakerRefs[0]);
  const speakerFile = projectStore.assetPath(job.projectId, speaker.id);
  const publicSpeaker = path.join(workspaceRoot, 'public', 'heygen.mp4');
  let speakerStat;
  let publicSpeakerStat;
  try { speakerStat = fs.lstatSync(speakerFile); } catch (_) {}
  try { publicSpeakerStat = fs.lstatSync(publicSpeaker); } catch (_) {}
  if (speaker.mediaType !== 'video/mp4' || !speakerStat?.isFile()
      || speakerStat.isSymbolicLink() || speakerStat.size !== speaker.size
      || hashFile(speakerFile) !== speaker.sha256
      || !publicSpeakerStat?.isFile() || publicSpeakerStat.isSymbolicLink()
      || publicSpeakerStat.size !== speaker.size
      || hashFile(publicSpeaker) !== speaker.sha256) {
    fail('Speaker asset does not match the ready-to-place Render input',
      'placement_compile_failed');
  }
  if (carried.plan && (speaker.id !== carried.plan.speaker.assetRef
      || speaker.sha256 !== carried.plan.speaker.assetSha256
      || speaker.size !== carried.plan.speaker.assetSize)) {
    fail('Speaker asset does not match the carried B-roll plan',
      'placement_compile_failed');
  }
  return bindings;
}

/**
 * Rebuild the same Focusstock shot runs consumed by focusstock-timeline.ts. The evidence is derived
 * from immutable input/hash bindings, the generated shot plan and the exact subtitle char timeline;
 * no filename or upload alone is allowed to claim a rendered placement.
 */
function buildFocusstockVisualConflictEvidence({
  job,
  workspaceRoot,
  preparedPlan,
  jobDirectory = null,
}) {
  if (!workspaceRoot || !preparedPlan?.placement)
    fail('Focusstock visual evidence is missing its prepared interval', 'placement_compile_failed');
  const bindings = job.focusstockVisualInputs == null ? [] : job.focusstockVisualInputs;
  if (!Array.isArray(bindings))
    fail('Focusstock image input bindings are invalid', 'placement_compile_failed');
  const bindingByName = new Map();
  const assetRefs = new Set();
  for (const binding of bindings) {
    if (!binding || binding.kind !== 'image' || typeof binding.assetRef !== 'string'
        || !binding.assetRef || assetRefs.has(binding.assetRef)
        || typeof binding.inputName !== 'string'
        || !/^shot\d{1,3}\.(?:png|jpe?g)$/i.test(binding.inputName)
        || path.basename(binding.inputName) !== binding.inputName
        || bindingByName.has(binding.inputName)
        || !SHA256_HEX.test(binding.sha256 || '')
        || !Number.isSafeInteger(binding.size) || binding.size < 1
        || !['image/png', 'image/jpeg'].includes(binding.mediaType)) {
      fail('Focusstock image input binding is invalid', 'placement_compile_failed');
    }
    assetRefs.add(binding.assetRef);
    bindingByName.set(binding.inputName, binding);
    validateBoundVisualFile(workspaceRoot, binding);
    if (jobDirectory) {
      const inputFile = path.join(jobDirectory, 'input', binding.inputName);
      let stat;
      try { stat = fs.lstatSync(inputFile); } catch (_) {}
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== binding.size
          || hashFile(inputFile) !== binding.sha256) {
        fail(`Run image input bytes drifted: ${binding.inputName}`, 'placement_compile_failed');
      }
    }
  }

  const publicDirectory = path.join(workspaceRoot, 'public');
  let publicShotNames = [];
  try {
    publicShotNames = fs.readdirSync(publicDirectory)
      .filter((name) => /^shot\d{1,3}\.(?:png|jpe?g)$/i.test(name)).sort();
  } catch (_) {
    fail('Focusstock public image inputs are unavailable', 'placement_compile_failed');
  }
  const boundNames = [...bindingByName.keys()].sort();
  if (JSON.stringify(publicShotNames) !== JSON.stringify(boundNames))
    fail('Focusstock public images do not match selected Project Assets', 'placement_compile_failed');
  if (jobDirectory) {
    const inputDirectory = path.join(jobDirectory, 'input');
    const inputShotNames = fs.readdirSync(inputDirectory)
      .filter((name) => /^shot\d{1,3}\.(?:png|jpe?g)$/i.test(name)).sort();
    if (JSON.stringify(inputShotNames) !== JSON.stringify(boundNames))
      fail('Run images do not match selected Project Assets', 'placement_compile_failed');
  }

  const shotPlan = readRegularJson(workspaceRoot, FOCUSSTOCK_SHOTS, 'Focusstock shot plan');
  const subtitles = readRegularJson(workspaceRoot, SUBTITLES, 'Focusstock subtitles timeline');
  if (!Array.isArray(shotPlan.value))
    fail('Focusstock shot plan must be an array', 'placement_compile_failed');
  const charTimes = subtitles.value?._scriptCharTimes;
  if (!Array.isArray(charTimes))
    fail('Focusstock subtitles timeline has no script char times', 'placement_compile_failed');

  const resolvedShots = shotPlan.value.map((shot, sourceIndex) => {
    const binding = shot && bindingByName.get(shot.src);
    if (!shot || !binding || !Number.isInteger(shot.startCharIdx)
        || !Number.isInteger(shot.endCharIdx) || shot.startCharIdx < 0
        || shot.endCharIdx < shot.startCharIdx || shot.endCharIdx >= charTimes.length) {
      fail('Focusstock shot is unknown or unresolved', 'placement_compile_failed');
    }
    const startTime = charTimes[shot.startCharIdx];
    const endTime = charTimes[shot.endCharIdx];
    const startSec = startTime?.start;
    const endSec = endTime?.end;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)
        || startSec < 0 || endSec <= startSec) {
      fail('Focusstock shot has an unresolved subtitle interval', 'placement_compile_failed');
    }
    return {
      sourceIndex,
      src: shot.src,
      assetRef: binding.assetRef,
      inputSha256: binding.sha256,
      startCharIdx: shot.startCharIdx,
      endCharIdx: shot.endCharIdx,
      startSec,
      endSec,
    };
  }).sort((a, b) => a.startSec - b.startSec);
  // A reviewed plan may intentionally delete the final placement that used an image. Keep every
  // selected input bound and byte-verified above, but do not require the renderer to use it. Shots
  // still fail closed unless they resolve to one of those exact bindings.

  // Equivalent to buildShotRuns(..., 2.0): only adjacent same-src shots merge, and the whole
  // merged run is suppressed if its half-open interval intersects the prepared interval.
  const runs = [];
  for (const shot of resolvedShots) {
    const last = runs[runs.length - 1];
    if (last && last.src === shot.src
        && shot.startSec - last.endSec <= FOCUSSTOCK_SHOT_MERGE_GAP_SEC) {
      last.endSec = shot.endSec;
      last.sourceShotIndexes.push(shot.sourceIndex);
    } else {
      runs.push({
        src: shot.src,
        assetRef: shot.assetRef,
        inputSha256: shot.inputSha256,
        startSec: shot.startSec,
        endSec: shot.endSec,
        sourceShotIndexes: [shot.sourceIndex],
      });
    }
  }
  const preparedStart = preparedPlan.placement.startSec;
  const preparedEnd = preparedPlan.placement.endSec;
  const preparedStartFrame = preparedPlan.placement.startFrame;
  const preparedEndFrame = preparedPlan.placement.endFrame;
  if (!Number.isInteger(preparedStartFrame) || !Number.isInteger(preparedEndFrame)
      || preparedStartFrame < 0 || preparedEndFrame <= preparedStartFrame) {
    fail('Prepared phone frame interval is invalid', 'placement_compile_failed');
  }
  for (const run of runs) {
    Object.assign(run, focusstockVisualFrameInterval(run.startSec, run.endSec));
    const overlaps = halfOpenFrameIntervalsOverlap(
      run.startFrame, run.endFrame, preparedStartFrame, preparedEndFrame);
    run.disposition = overlaps ? 'suppressed_by_prepared' : 'rendered';
  }
  const evidence = {
    schemaVersion: 1,
    algorithm: 'focusstock-shot-runs-v1',
    timelineBasis: 'focusstock-main-v1',
    mergeGapSec: FOCUSSTOCK_SHOT_MERGE_GAP_SEC,
    intervalSemantics: 'frame-half-open',
    preparedInterval: {
      fps: PREPARED_FPS,
      startSec: preparedStart,
      endSec: preparedEnd,
      startFrame: preparedStartFrame,
      endFrame: preparedEndFrame,
    },
    sources: {
      shotPlan: { path: FOCUSSTOCK_SHOTS, sha256: shotPlan.sha256 },
      subtitles: { path: SUBTITLES, sha256: subtitles.sha256 },
    },
    inputs: bindings.map((binding) => ({ ...binding })),
    resolvedShots,
    runs,
    counts: {
      inputs: bindings.length,
      resolvedShots: resolvedShots.length,
      runs: runs.length,
      rendered: runs.filter((run) => run.disposition === 'rendered').length,
      suppressedByPrepared: runs.filter(
        (run) => run.disposition === 'suppressed_by_prepared').length,
    },
  };
  return { evidence, sha256: hashJson(evidence) };
}

/**
 * Compile a replacement visual evidence object for one already-verified review transaction.
 *
 * The caller must first verify the recorded snapshot before applying the user's edits. This helper
 * then protects the immutable prepared-video contract while allowing only the derived Focusstock
 * shot/timing evidence to change. The recorded evidence must also still be internally authentic;
 * arbitrary stale/tampered job metadata is never accepted as a recompile baseline.
 */
function compileReviewedFocusstockVisualEvidence({ job, workspaceRoot, preparedPlan }) {
  const summary = job?.materialAcquisitionResult;
  const recordedEvidence = summary?.focusstockVisualEvidence;
  const recordedSha256 = summary?.focusstockVisualEvidenceSha256;
  if (job?.materialAcquisition?.operation !== 'prepared-video'
      || summary?.placementStatus !== 'compiled' || summary.automaticTimelineUse !== true
      || !summary.preparedArtifact?.assetRef
      || !SHA256_HEX.test(summary.compiledPlanSha256 || '')
      || !recordedEvidence || !SHA256_HEX.test(recordedSha256 || '')
      || hashJson(recordedEvidence) !== recordedSha256
      || preparedPlan?.mode !== 'ready-to-place'
      || preparedPlan.source?.sha256 !== summary.preparedArtifact.sha256
      || preparedPlan.source?.size !== summary.preparedArtifact.size
      || JSON.stringify(preparedPlan.placement) !== JSON.stringify(summary.placement)) {
    fail('Reviewed Focusstock visual evidence baseline is invalid', 'placement_compile_failed');
  }
  return buildFocusstockVisualConflictEvidence({ job, workspaceRoot, preparedPlan });
}

function buildFocusstockVisualTimelinePlacements(evidence, evidenceSha256) {
  if (!evidence || evidence.schemaVersion !== 1
      || evidence.algorithm !== 'focusstock-shot-runs-v1'
      || evidence.timelineBasis !== 'focusstock-main-v1'
      || evidence.intervalSemantics !== 'frame-half-open'
      || !SHA256_HEX.test(evidenceSha256 || '')
      || hashJson(evidence) !== evidenceSha256
      || !Array.isArray(evidence.runs)) {
    fail('Focusstock visual timeline evidence is invalid', 'placement_compile_failed');
  }
  return evidence.runs.map((run) => {
    if (!run || typeof run.assetRef !== 'string' || !run.assetRef
        || typeof run.src !== 'string' || !run.src
        || !SHA256_HEX.test(run.inputSha256 || '')
        || !['rendered', 'suppressed_by_prepared'].includes(run.disposition)) {
      fail('Focusstock visual run evidence is invalid', 'placement_compile_failed');
    }
    const interval = focusstockVisualFrameInterval(run.startSec, run.endSec);
    if (run.fps !== interval.fps || run.startFrame !== interval.startFrame
        || run.endFrame !== interval.endFrame
        || run.durationInFrames !== interval.durationInFrames) {
      fail('Focusstock visual run evidence is invalid', 'placement_compile_failed');
    }
    return {
      kind: 'focusstock-shot-run',
      channel: 'focusstock-shots',
      assetRef: run.assetRef,
      inputName: run.src,
      inputSha256: run.inputSha256,
      timelineBasis: 'focusstock-main-v1',
      fps: run.fps,
      startSec: run.startSec,
      endSec: run.endSec,
      startFrame: run.startFrame,
      endFrame: run.endFrame,
      durationInFrames: run.durationInFrames,
      disposition: run.disposition,
      conflictEvidenceSha256: evidenceSha256,
    };
  });
}

function validateFocusstockVisualTimelinePlacements(job, evidence, evidenceSha256) {
  const expected = buildFocusstockVisualTimelinePlacements(evidence, evidenceSha256);
  if (!Array.isArray(job.timelinePlacements))
    fail('Focusstock visual timeline placements are missing', 'placement_compile_failed');
  const actual = job.timelinePlacements.filter((item) =>
    item?.kind === 'focusstock-shot-run' || item?.channel === 'focusstock-shots');
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail('Focusstock visual timeline placements drifted', 'placement_compile_failed');
  return expected;
}

function mergePreparedPhoneTimelineChannels({
  existingPlacements = [], focusstockVisualPlacements = [],
  focusstockBrollPlacements = [], preparedPlacement,
}) {
  if (!Array.isArray(existingPlacements) || !Array.isArray(focusstockVisualPlacements)
      || !Array.isArray(focusstockBrollPlacements)
      || !preparedPlacement || preparedPlacement.kind !== 'prepared-phone-video') {
    fail('Prepared phone timeline merge contract is invalid', 'placement_compile_failed');
  }
  const brollIds = new Set();
  for (const placement of focusstockBrollPlacements) {
    const id = placement?.clipId;
    if (!placement || placement.kind !== 'focusstock-broll-placement'
        || placement.channel !== 'focusstock-broll' || typeof id !== 'string' || !id
        || placement.cardId !== id
        || brollIds.has(id)
        || !['rendered', 'suppressed_by_prepared'].includes(placement.disposition)
        || placement.suppressedBy
          !== (placement.disposition === 'suppressed_by_prepared'
            ? 'prepared-phone-video' : null)) {
      fail('Focusstock B-roll timeline placements are invalid', 'placement_compile_failed');
    }
    brollIds.add(id);
  }
  const preserved = existingPlacements.filter((item) => item
    && item.kind !== 'prepared-phone-video'
    && item.kind !== 'focusstock-shot-run'
    && item.channel !== 'focusstock-shots'
    && item.kind !== 'focusstock-broll-placement'
    && item.channel !== 'focusstock-broll');
  return [
    ...preserved,
    ...focusstockVisualPlacements,
    ...focusstockBrollPlacements,
    preparedPlacement,
  ];
}

function selectPreparedPhoneGraphicBroll(existingGraphicBroll, generatedGraphicBroll) {
  if (existingGraphicBroll?.mode !== 'composition-v1') return generatedGraphicBroll;
  if (existingGraphicBroll.schemaVersion !== 1
      || !Array.isArray(existingGraphicBroll.cards) || existingGraphicBroll.cards.length === 0) {
    fail('Recorded composition B-roll evidence is invalid', 'placement_compile_failed');
  }
  return existingGraphicBroll;
}

function inspectPreparedVideo(file) {
  let value;
  try {
    value = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration',
      '-of', 'json', path.resolve(file),
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 }));
  } catch (_) {
    fail('Prepared phone video is not decodable', 'placement_compile_failed');
  }
  const streams = Array.isArray(value.streams) ? value.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const video = videos[0];
  const durationSeconds = Number(video?.duration || value.format?.duration);
  if (videos.length !== 1 || audio.length !== 0 || video?.codec_name !== 'h264'
      || !Number.isInteger(Number(video.width)) || Number(video.width) < 1
      || !Number.isInteger(Number(video.height)) || Number(video.height) < 1
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0)
    fail('Prepared phone video media is incompatible', 'placement_compile_failed');
  return {
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds,
  };
}

function validatePreparedPhonePlacementMath(plan, videoFile) {
  const source = plan && plan.source;
  const placement = plan && plan.placement;
  const media = source && source.media;
  const actual = inspectPreparedVideo(videoFile);
  const expectedDurationInFrames = Math.ceil(actual.durationSeconds * PREPARED_FPS);
  const expectedStartFrame = Math.round(Number(placement?.startSec) * PREPARED_FPS);
  const expectedEndFrame = expectedStartFrame + expectedDurationInFrames;
  const expectedStartSec = Number((expectedStartFrame / PREPARED_FPS).toFixed(6));
  const expectedEndSec = Number((expectedEndFrame / PREPARED_FPS).toFixed(6));
  if (!media || media.codec !== actual.codec || media.width !== actual.width
      || media.height !== actual.height || !Number.isFinite(media.durationSeconds)
      || Math.abs(media.durationSeconds - actual.durationSeconds) > 0.000001
      || placement?.fps !== PREPARED_FPS
      || placement.startFrame !== expectedStartFrame
      || placement.endFrame !== expectedEndFrame
      || placement.durationInFrames !== expectedDurationInFrames
      || placement.endFrame - placement.startFrame !== placement.durationInFrames
      || placement.startSec !== expectedStartSec || placement.endSec !== expectedEndSec) {
    fail('Prepared phone duration or frame placement is inconsistent with actual media',
      'placement_compile_failed');
  }
  return true;
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function safeEvidenceFile(acquisitionRoot, requestId, evidence) {
  const name = `${requestId}.provider-evidence.json`;
  const file = path.join(acquisitionRoot, name);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  return path.posix.join('acquisition', name);
}

function baseSummary(intent, request, result, nowISO) {
  return {
    requestId: request.requestId,
    policy: intent.policy,
    operation: intent.operation,
    mode: intent.mode,
    route: intent.route,
    status: result.status,
    reason: result.reason || null,
    evidenceLevel: result.evidenceLevel,
    provider: result.provider || null,
    contractVersion: result.contractVersion || null,
    providerVersion: result.providerVersion || null,
    completedAt: nowISO(),
    ...(intent.presentation ? { presentation: intent.presentation } : {}),
    ...(intent.placement ? { requestedPlacement: intent.placement } : {}),
  };
}

function relativeEvidencePath(jobDirectory, file) {
  const root = fs.realpathSync(jobDirectory);
  const target = fs.realpathSync(file);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) fail('Artifact evidence path escaped Run', 'materialization_failed');
  return relative.split(path.sep).join('/');
}

function stagePreparedPhoneMaterial({
  intent,
  request,
  result,
  summary,
  jobDirectory,
}) {
  const prepared = result.material.find((item) => item.role === 'prepared-video');
  if (!prepared || prepared.kind !== 'video' || prepared.mimeType !== 'video/mp4'
      || !prepared.media || !Number.isFinite(prepared.media.durationSeconds)
      || prepared.media.durationSeconds <= 0)
    fail('Validated prepared video artifact is missing', 'materialization_failed');
  const inputDirectory = ensureOwnedDirectory(jobDirectory, 'input');
  const videoFile = path.join(inputDirectory, PREPARED_VIDEO_INPUT);
  fs.copyFileSync(prepared.absolutePath, videoFile, fs.constants.COPYFILE_EXCL);
  if (hashFile(videoFile) !== prepared.sha256)
    fail('Prepared video changed while staging', 'materialization_failed');
  const intentFile = path.join(inputDirectory, PREPARED_INTENT_INPUT);
  writePrivateJson(intentFile, {
    schemaVersion: 1,
    mode: 'ready-to-place',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    provider: { id: result.provider, toolVersion: result.providerVersion },
    target: request.target,
    presentation: intent.presentation,
    placement: intent.placement,
    source: {
      fileName: PREPARED_VIDEO_INPUT,
      artifactRole: prepared.role,
      sha256: prepared.sha256,
      size: prepared.size,
      mimeType: prepared.mimeType,
      media: prepared.media,
    },
  });
  summary.artifacts = result.material.map((artifact) => ({
    role: artifact.role,
    sha256: artifact.sha256,
    mimeType: artifact.mimeType,
    size: artifact.size,
    media: artifact.media || null,
    evidenceFile: relativeEvidencePath(jobDirectory, artifact.absolutePath),
  }));
  summary.preparedArtifact = {
    role: prepared.role,
    inputName: PREPARED_VIDEO_INPUT,
    intentInputName: PREPARED_INTENT_INPUT,
    sha256: prepared.sha256,
    mimeType: prepared.mimeType,
    size: prepared.size,
    media: prepared.media,
  };
  summary.placementStatus = 'pending_compile';
  summary.automaticTimelineUse = false;
}

function readPreparedPlan(workspaceRoot) {
  const file = path.join(workspaceRoot, ...PREPARED_PLAN.split('/'));
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail('Prepared phone placement plan is missing or invalid', 'placement_compile_failed'); }
  return { file, plan };
}

function validateCompiledPreparedPlan({
  job,
  jobDirectory,
  workspaceRoot,
  publicDirectory = path.join(workspaceRoot, 'public'),
}) {
  const summary = job.materialAcquisitionResult;
  if (job.materialAcquisition?.operation !== 'prepared-video'
      || !summary || summary.status !== 'acquired'
      || summary.placementStatus !== 'pending_compile'
      || !summary.preparedArtifact || !SHA256_HEX.test(summary.preparedArtifact.sha256 || ''))
    fail('Prepared phone material is not awaiting placement', 'placement_compile_failed');
  const { file: planFile, plan } = readPreparedPlan(workspaceRoot);
  const placement = plan && plan.placement;
  const source = plan && plan.source;
  const ownership = plan && plan.visualOwnership;
  if (plan.schemaVersion !== 1 || plan.mode !== 'ready-to-place'
      || plan.template !== 'focusstock' || plan.timelineBasis !== 'focusstock-main-v1'
      || plan.contractVersion !== 2 || plan.requestId !== summary.requestId
      || plan.presentation?.profileId !== job.materialAcquisition.presentation.profileId
      || !ownership || ownership.owner !== 'prepared-phone-video'
      || ownership.conflictPolicy !== 'suppress-entire-overlapping-placement'
      || !Array.isArray(ownership.suppressedChannels)
      || ownership.suppressedChannels.length !== 2
      || ownership.suppressedChannels[0] !== 'focusstock-shots'
      || ownership.suppressedChannels[1] !== 'focusstock-broll'
      || !source || source.fileName !== PREPARED_VIDEO_INPUT
      || source.artifactRole !== 'prepared-video'
      || source.sha256 !== summary.preparedArtifact.sha256
      || source.size !== summary.preparedArtifact.size
      || !placement || placement.layoutId !== job.materialAcquisition.placement.layoutId
      || !Number.isFinite(placement.startSec) || placement.startSec < 0
      || !Number.isFinite(placement.endSec) || placement.endSec <= placement.startSec
      || !Number.isInteger(placement.durationInFrames) || placement.durationInFrames < 1
      || placement.playbackRate !== 1 || placement.muted !== true
      || placement.objectFit !== 'contain' || placement.crop !== 'none'
      || placement.trim !== 'none' || placement.loop !== false)
    fail('Prepared phone placement plan is incompatible', 'placement_compile_failed');
  const publicFile = path.join(publicDirectory, PREPARED_VIDEO_INPUT);
  const inputFile = path.join(jobDirectory, 'input', PREPARED_VIDEO_INPUT);
  for (const file of [publicFile, inputFile]) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (_) {}
    if (!stat || !stat.isFile() || stat.isSymbolicLink()
        || stat.size !== source.size || hashFile(file) !== source.sha256)
      fail('Prepared phone video bytes drifted before selection', 'placement_compile_failed');
  }
  validatePreparedPhonePlacementMath(plan, publicFile);
  if (hashFile(planFile) !== summary.compiledPlanSha256 && summary.compiledPlanSha256)
    fail('Prepared phone placement plan drifted', 'placement_compile_failed');
  const visualEvidence = buildFocusstockVisualConflictEvidence({
    job, workspaceRoot, preparedPlan: plan, jobDirectory,
  });
  const resolvedInputNames = new Set(
    visualEvidence.evidence.resolvedShots.map((shot) => shot.src));
  if (visualEvidence.evidence.inputs.some(
    (binding) => !resolvedInputNames.has(binding.inputName))) {
    fail('Every initially selected Focusstock image must have a resolved shot',
      'placement_compile_failed');
  }
  return { plan, planFile, publicFile, visualEvidence };
}

function finalizePreparedPhoneMaterial({
  job,
  jobDirectory,
  workspaceRoot,
  publicDirectory,
  projectStore,
}) {
  if (job.materialAcquisition?.operation !== 'prepared-video') return null;
  const validated = validateCompiledPreparedPlan({
    job, jobDirectory, workspaceRoot, publicDirectory,
  });
  const summary = job.materialAcquisitionResult;
  const asset = projectStore.ingestAsset(job.projectId, validated.publicFile, {
    originalName: `${job.materialAcquisition.route}.ready-to-place.mp4`,
    kind: 'video',
    role: 'prepared-phone-video',
    origin: 'chipk-simulator-capture',
  });
  const assetFile = projectStore.assetPath(job.projectId, asset.id);
  let assetStat;
  try { assetStat = assetFile && fs.lstatSync(assetFile); } catch (_) {}
  if (asset.sha256 !== summary.preparedArtifact.sha256
      || asset.size !== summary.preparedArtifact.size
      || !assetStat?.isFile() || assetStat.isSymbolicLink()
      || assetStat.size !== asset.size || hashFile(assetFile) !== asset.sha256)
    fail('Selected Project Asset does not match prepared bytes', 'placement_compile_failed');
  summary.compiledPlanFile = PREPARED_PLAN;
  summary.compiledPlanSha256 = hashFile(validated.planFile);
  summary.focusstockVisualEvidence = validated.visualEvidence.evidence;
  summary.focusstockVisualEvidenceSha256 = validated.visualEvidence.sha256;
  summary.placement = validated.plan.placement;
  summary.placementStatus = 'compiled_pending_evidence';
  summary.automaticTimelineUse = false;
  delete summary.preparedArtifact.assetRef;
  return { asset, plan: validated.plan };
}

function buildPreparedPhoneTimelinePlacement(job, plan, explicitAssetRef = null) {
  const summary = job.materialAcquisitionResult;
  const source = plan && plan.source;
  const placement = plan && plan.placement;
  const assetRef = explicitAssetRef || summary?.preparedArtifact?.assetRef;
  if (job.materialAcquisition?.operation !== 'prepared-video'
      || !summary || !['compiled_pending_evidence', 'compiled'].includes(summary.placementStatus)
      || !assetRef
      || !SHA256_HEX.test(summary.compiledPlanSha256 || '')
      || !SHA256_HEX.test(summary.focusstockVisualEvidenceSha256 || '')
      || plan?.mode !== 'ready-to-place'
      || plan.presentation?.profileId !== job.materialAcquisition.presentation?.profileId
      || !source || source.sha256 !== summary.preparedArtifact.sha256
      || !placement || placement.layoutId !== job.materialAcquisition.placement?.layoutId) {
    fail('Prepared phone timeline evidence is incomplete', 'placement_compile_failed');
  }
  return {
    kind: 'prepared-phone-video',
    assetRef,
    profileId: plan.presentation.profileId,
    layoutId: placement.layoutId,
    visualOwner: plan.visualOwnership.owner,
    conflictPolicy: plan.visualOwnership.conflictPolicy,
    timelineBasis: plan.timelineBasis,
    fps: placement.fps,
    startFrame: placement.startFrame,
    endFrame: placement.endFrame,
    durationInFrames: placement.durationInFrames,
    startSec: placement.startSec,
    endSec: placement.endSec,
    compositionTimeline: 'Focusstock',
    compositionOffsetFrames: FOCUSSTOCK_MAIN_OFFSET_FRAMES,
    compositionStartFrame: placement.startFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES,
    compositionEndFrame: placement.endFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES,
    compositionStartSec: Number(
      ((placement.startFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES) / PREPARED_FPS).toFixed(6)),
    compositionEndSec: Number(
      ((placement.endFrame + FOCUSSTOCK_MAIN_OFFSET_FRAMES) / PREPARED_FPS).toFixed(6)),
    sourceSha256: source.sha256,
    planSha256: summary.compiledPlanSha256,
    focusstockVisualEvidenceSha256: summary.focusstockVisualEvidenceSha256,
  };
}

function commitPreparedPhoneMaterialSelection({ job, asset, plan, projectStore }) {
  const summary = job.materialAcquisitionResult;
  const storedAsset = projectStore?.get(job.projectId)?.assets?.find((item) => item.id === asset?.id);
  const storedFile = storedAsset && projectStore.assetPath(job.projectId, storedAsset.id);
  let storedStat;
  try { storedStat = storedFile && fs.lstatSync(storedFile); } catch (_) {}
  if (!asset || asset.role !== 'prepared-phone-video'
      || asset.origin !== 'chipk-simulator-capture'
      || asset.sha256 !== summary?.preparedArtifact?.sha256
      || storedAsset?.sha256 !== asset.sha256 || storedAsset?.size !== asset.size
      || !storedStat?.isFile() || storedStat.isSymbolicLink()
      || storedStat.size !== asset.size || hashFile(storedFile) !== asset.sha256
      || summary.placementStatus !== 'compiled_pending_evidence'
      || summary.automaticTimelineUse !== false
      || summary.preparedArtifact.assetRef) {
    fail('Prepared phone selection is not ready to commit', 'placement_compile_failed');
  }
  const timelinePlacement = buildPreparedPhoneTimelinePlacement(job, plan, asset.id);
  if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
  summary.preparedArtifact.assetRef = asset.id;
  summary.placementStatus = 'compiled';
  summary.automaticTimelineUse = true;
  return timelinePlacement;
}

function rollbackPreparedPhoneMaterialSelection(job) {
  const summary = job.materialAcquisitionResult;
  const assetRef = summary?.preparedArtifact?.assetRef;
  if (assetRef) job.assetRefs = job.assetRefs.filter((id) => id !== assetRef);
  if (summary?.preparedArtifact) delete summary.preparedArtifact.assetRef;
  if (summary?.placementStatus === 'compiled') summary.placementStatus = 'compiled_pending_evidence';
  if (summary) summary.automaticTimelineUse = false;
}

function validatePreparedPhoneProjectAsset({ job, projectStore }) {
  if (job.materialAcquisition?.operation !== 'prepared-video') return null;
  const summary = job.materialAcquisitionResult;
  const assetRef = summary?.preparedArtifact?.assetRef;
  const placements = (job.timelinePlacements || []).filter((item) =>
    item?.kind === 'prepared-phone-video');
  if (summary?.placementStatus !== 'compiled' || summary.automaticTimelineUse !== true
      || !assetRef || !job.assetRefs?.includes(assetRef) || placements.length !== 1
      || placements[0].assetRef !== assetRef
      || placements[0].sourceSha256 !== summary.preparedArtifact.sha256
      || placements[0].planSha256 !== summary.compiledPlanSha256
      || placements[0].focusstockVisualEvidenceSha256
        !== summary.focusstockVisualEvidenceSha256) {
    fail('Prepared phone Project Asset selection is incomplete', 'placement_compile_failed');
  }
  const project = projectStore.get(job.projectId);
  const asset = project?.assets?.find((item) => item.id === assetRef);
  const assetFile = asset && projectStore.assetPath(job.projectId, assetRef);
  let stat;
  try { stat = assetFile && fs.lstatSync(assetFile); } catch (_) {}
  if (!asset || asset.role !== 'prepared-phone-video'
      || asset.origin !== 'chipk-simulator-capture'
      || asset.sha256 !== summary.preparedArtifact.sha256
      || asset.size !== summary.preparedArtifact.size
      || !stat?.isFile() || stat.isSymbolicLink() || stat.size !== asset.size
      || hashFile(assetFile) !== asset.sha256) {
    fail('Prepared phone Project Asset bytes are no longer durable', 'placement_compile_failed');
  }
  return { asset, assetFile, placement: placements[0] };
}

function verifyPreparedPhoneDurableOutputs({
  job,
  projectStore,
  archiveRoot,
  durableOutputFiles,
}) {
  const outputs = job.outputs;
  const revision = job.projectId && job.revisionId
    ? projectStore.getRevision(job.projectId, job.revisionId)
    : null;
  const revisionOutputs = revision?.outputs;
  const renderOutputs = job.renderEvidence?.outputs;
  if (!revision || revision.projectId !== job.projectId
      || revision.jobId !== job.id || revision.runId !== job.id
      || !Array.isArray(outputs) || outputs.length < 1
      || !Array.isArray(revisionOutputs) || revisionOutputs.length !== outputs.length
      || !Array.isArray(renderOutputs) || renderOutputs.length !== outputs.length
      || typeof archiveRoot !== 'string' || !path.isAbsolute(archiveRoot)
      || !Array.isArray(durableOutputFiles) || durableOutputFiles.length !== outputs.length) {
    fail('Prepared phone durable output evidence is incomplete',
      'acquisition_compaction_failed');
  }

  let outputRootStat;
  let outputRoot;
  try {
    const directory = projectStore.outputDir(job.projectId);
    outputRootStat = fs.lstatSync(directory);
    outputRoot = fs.realpathSync(directory);
  } catch (_) {}
  if (!outputRootStat?.isDirectory() || outputRootStat.isSymbolicLink() || !outputRoot) {
    fail('Prepared phone durable output directory is unsafe',
      'acquisition_compaction_failed');
  }

  const revisionByName = new Map();
  const renderByName = new Map();
  const indexEvidence = (records, target, requireArchive) => {
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)
          || typeof record.name !== 'string' || !record.name
          || path.basename(record.name) !== record.name
          || !Number.isSafeInteger(record.size) || record.size < 1
          || !SHA256_HEX.test(record.sha256 || '')
          || (requireArchive && (typeof record.archive !== 'string' || !record.archive))
          || target.has(record.name)) {
        fail('Prepared phone durable output ledger is invalid',
          'acquisition_compaction_failed');
      }
      target.set(record.name, record);
    }
  };
  indexEvidence(revisionOutputs, revisionByName, true);
  indexEvidence(renderOutputs, renderByName, false);

  const seenNames = new Set();
  for (const [index, output] of outputs.entries()) {
    if (!output || typeof output !== 'object' || Array.isArray(output)
        || typeof output.name !== 'string' || !output.name
        || path.basename(output.name) !== output.name || seenNames.has(output.name)
        || typeof output.archive !== 'string' || !output.archive
        || !Number.isSafeInteger(output.size) || output.size < 1
        || !SHA256_HEX.test(output.sha256 || '')) {
      fail('Prepared phone durable output ledger is invalid',
        'acquisition_compaction_failed');
    }
    seenNames.add(output.name);
    const revisionOutput = revisionByName.get(output.name);
    const renderOutput = renderByName.get(output.name);
    if (!revisionOutput || revisionOutput.archive !== output.archive
        || revisionOutput.size !== output.size || revisionOutput.sha256 !== output.sha256
        || !renderOutput || renderOutput.size !== output.size
        || renderOutput.sha256 !== output.sha256) {
      fail('Prepared phone durable output ledgers disagree',
        'acquisition_compaction_failed');
    }

    const file = durableOutputFiles[index];
    let stat;
    let real;
    let declaredReal;
    try {
      stat = typeof file === 'string' ? fs.lstatSync(file) : null;
      real = stat && fs.realpathSync(file);
      declaredReal = fs.realpathSync(path.resolve(archiveRoot, output.archive));
    } catch (_) {}
    const relative = real && path.relative(outputRoot, real);
    if (!stat?.isFile() || stat.isSymbolicLink() || !real || real !== declaredReal || !relative
        || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative) || stat.size !== output.size
        || hashFile(file) !== output.sha256) {
      fail('Prepared phone durable output bytes are missing, unsafe, or changed',
        'acquisition_compaction_failed');
    }
  }
}

function acquisitionLedgerPath(jobRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('acquisition/')
      || relativePath.includes('\\') || path.posix.normalize(relativePath) !== relativePath) {
    fail('Prepared acquisition evidence path is unsafe', 'acquisition_compaction_failed');
  }
  const absolute = path.resolve(jobRoot, ...relativePath.split('/'));
  const relative = path.relative(jobRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`))
    fail('Prepared acquisition evidence path is unsafe', 'acquisition_compaction_failed');
  return absolute;
}

function verifyCompactionArtifactFile(file, artifact, acquisitionRoot, label) {
  let stat;
  let real;
  try {
    stat = fs.lstatSync(file);
    real = fs.realpathSync(file);
  } catch (_) {}
  const relative = real && path.relative(acquisitionRoot, real);
  if (!stat?.isFile() || stat.isSymbolicLink() || !real || relative === '..'
      || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || stat.size !== artifact.size || hashFile(file) !== artifact.sha256) {
    fail(`${label} is missing, unsafe, or changed`, 'acquisition_compaction_failed');
  }
  return stat;
}

function recoverInterruptedPreparedPhoneCompaction({
  artifacts,
  jobRoot,
  acquisitionRoot,
  trash,
}) {
  if (!fs.existsSync(trash)) return false;
  let trashStat;
  try { trashStat = fs.lstatSync(trash); } catch (_) {}
  if (!trashStat?.isDirectory() || trashStat.isSymbolicLink()
      || fs.realpathSync(trash) !== trash) {
    fail('Prepared acquisition compaction staging is unsafe',
      'acquisition_compaction_failed');
  }

  const binaries = artifacts.filter(({ role }) =>
    role === 'prepared-video' || role === 'screenshot');
  const stagedByName = new Map();
  for (const artifact of binaries) {
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1
        || !SHA256_HEX.test(artifact.sha256 || '')) {
      fail('Prepared acquisition binary ledger is invalid',
        'acquisition_compaction_failed');
    }
    stagedByName.set(`${artifact.role}-${artifact.sha256}`, artifact);
  }
  const entries = fs.readdirSync(trash, { withFileTypes: true });
  if (entries.some((entry) => !stagedByName.has(entry.name)
      || !entry.isFile() || entry.isSymbolicLink())) {
    fail('Prepared acquisition compaction staging is ambiguous',
      'acquisition_compaction_failed');
  }

  for (const artifact of binaries) {
    const original = acquisitionLedgerPath(jobRoot, artifact.evidenceFile);
    const staged = path.join(trash, `${artifact.role}-${artifact.sha256}`);
    let originalStat;
    let stagedStat;
    try { originalStat = fs.lstatSync(original); } catch (_) {}
    try { stagedStat = fs.lstatSync(staged); } catch (_) {}
    if (originalStat && stagedStat) {
      fail('Prepared acquisition compaction recovery found duplicate evidence',
        'acquisition_compaction_failed');
    }
    if (!originalStat && !stagedStat) {
      fail('Prepared acquisition compaction recovery evidence is missing',
        'acquisition_compaction_failed');
    }
    if (originalStat) {
      verifyCompactionArtifactFile(original, artifact, acquisitionRoot,
        'Prepared acquisition evidence file');
      continue;
    }
    verifyCompactionArtifactFile(staged, artifact, acquisitionRoot,
      'Prepared acquisition staged evidence file');
    const parent = path.dirname(original);
    let parentStat;
    let realParent;
    try {
      parentStat = fs.lstatSync(parent);
      realParent = fs.realpathSync(parent);
    } catch (_) {}
    const relativeParent = realParent && path.relative(acquisitionRoot, realParent);
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || !realParent
        || relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeParent)) {
      fail('Prepared acquisition evidence directory is unsafe',
        'acquisition_compaction_failed');
    }
    try { fs.renameSync(staged, original); }
    catch (_) {
      fail('Prepared acquisition compaction recovery could not restore evidence',
        'acquisition_compaction_failed');
    }
  }
  if (fs.readdirSync(trash).length !== 0) {
    fail('Prepared acquisition compaction recovery left ambiguous evidence',
      'acquisition_compaction_failed');
  }
  try { fs.rmdirSync(trash); }
  catch (_) {
    fail('Prepared acquisition compaction recovery could not clear staging',
      'acquisition_compaction_failed');
  }
  return true;
}

function finalizeCommittedPreparedPhoneCompaction({
  artifacts,
  acquisitionRoot,
  trash,
}) {
  if (!fs.existsSync(trash)) return false;
  let trashStat;
  let trashReal;
  try {
    trashStat = fs.lstatSync(trash);
    trashReal = fs.realpathSync(trash);
  } catch (_) {}
  if (!trashStat?.isDirectory() || trashStat.isSymbolicLink() || trashReal !== trash) {
    fail('Prepared acquisition compaction staging is unsafe',
      'acquisition_compaction_failed');
  }

  const binaries = artifacts.filter(({ role }) =>
    role === 'prepared-video' || role === 'screenshot');
  const expectedByName = new Map();
  for (const artifact of binaries) {
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1
        || !SHA256_HEX.test(artifact.sha256 || '')) {
      fail('Prepared acquisition binary ledger is invalid',
        'acquisition_compaction_failed');
    }
    expectedByName.set(`${artifact.role}-${artifact.sha256}`, artifact);
  }
  const entries = fs.readdirSync(trash, { withFileTypes: true });
  if (entries.some((entry) => !expectedByName.has(entry.name)
      || !entry.isFile() || entry.isSymbolicLink())) {
    fail('Prepared acquisition compaction staging is ambiguous',
      'acquisition_compaction_failed');
  }
  for (const entry of entries) {
    const file = path.join(trash, entry.name);
    verifyCompactionArtifactFile(file, expectedByName.get(entry.name), acquisitionRoot,
      'Prepared acquisition staged evidence file');
  }
  for (const entry of entries) fs.unlinkSync(path.join(trash, entry.name));
  if (fs.readdirSync(trash).length !== 0) {
    fail('Prepared acquisition compaction staging could not be emptied',
      'acquisition_compaction_failed');
  }
  fs.rmdirSync(trash);
  return true;
}

/**
 * A carried Focusstock Run has the same durable intent recorded in both the Run and Revision.
 * Cleanup is destructive, so one surviving carry marker must force every marker and the
 * prepared-video operation to agree before state/ can be removed. This prevents deleting the
 * last exact B-roll bytes after a partially edited or damaged ledger bypasses compaction.
 */
function requireFocusstockCarryCompaction({ job, revision }) {
  const signals = (record) => [
    record?.focusstockBrollCarryForward != null,
    record?.graphicBroll?.style === 'focusstock-carried-v1',
    record?.graphicBroll?.provenance?.level === 'pre-render-manifest-v1',
    record?.renderInputManifest?.options?.focusstockBrollMode === 'carried-v1',
  ];
  const jobSignals = signals(job);
  const revisionSignals = signals(revision);
  const allSignals = [...jobSignals, ...revisionSignals];
  if (!allSignals.some(Boolean)) return false;
  const exactLedgers = JSON.stringify(job?.focusstockBrollCarryForward)
      === JSON.stringify(revision?.focusstockBrollCarryForward)
    && JSON.stringify(job?.graphicBroll) === JSON.stringify(revision?.graphicBroll)
    && job?.renderInputManifestSha256 === revision?.renderInputManifestSha256
    && JSON.stringify(job?.renderInputManifest) === JSON.stringify(revision?.renderInputManifest);
  if (!allSignals.every(Boolean)
      || job?.materialAcquisition?.operation !== 'prepared-video'
      || revision?.materialAcquisition?.operation !== 'prepared-video'
      || !exactLedgers) {
    fail('Carried Focusstock cleanup ledger is incomplete or inconsistent',
      'acquisition_compaction_failed');
  }
  return true;
}

function compactPreparedPhoneAcquisition({
  job,
  jobDirectory,
  projectStore,
  archiveRoot,
  durableOutputFiles,
  saveJob,
  writeJobRecord,
  renameFile = fs.renameSync,
  nowISO,
}) {
  const summary = job.materialAcquisitionResult;
  if (job.materialAcquisition?.operation !== 'prepared-video') return null;
  const assetRef = summary?.preparedArtifact?.assetRef;
  const preparedPlacements = (job.timelinePlacements || []).filter((item) =>
    item?.kind === 'prepared-phone-video');
  if (job.status !== 'done' || summary?.placementStatus !== 'compiled'
      || summary.automaticTimelineUse !== true || !assetRef
      || !job.assetRefs?.includes(assetRef) || preparedPlacements.length !== 1
      || preparedPlacements[0].assetRef !== assetRef
      || preparedPlacements[0].sourceSha256 !== summary.preparedArtifact.sha256
      || !SHA256_HEX.test(job.renderInputManifestSha256 || '')
      || job.renderEvidence?.schemaVersion !== 1
      || job.renderEvidence.renderInputManifestSha256 !== job.renderInputManifestSha256) {
    fail('Prepared phone acquisition is not eligible for compaction',
      'acquisition_compaction_failed');
  }
  try { validatePreparedPhoneProjectAsset({ job, projectStore }); }
  catch (_) {
    fail('Prepared Project Asset is not durable for acquisition compaction',
      'acquisition_compaction_failed');
  }
  if (job.focusstockBrollCarryForward) {
    try {
      validatePreparedFocusstockAssetRefs({
        job,
        projectStore,
        workspaceRoot: path.join(jobDirectory, 'state'),
      });
    } catch (_) {
      // state/public can be the last exact copy after a Project Asset drifts. Gate before staging
      // acquisition binaries so pruneOldJobs cannot continue on to remove state/input.
      fail('Carried Focusstock B-roll or speaker is not durable for Run compaction',
        'acquisition_compaction_failed');
    }
  }
  verifyPreparedPhoneDurableOutputs({
    job,
    projectStore,
    archiveRoot,
    durableOutputFiles,
  });
  if (summary?.acquisitionRetention?.status === 'sidecars_only') {
    const acquisitionRoot = fs.realpathSync(path.join(jobDirectory, 'acquisition'));
    const staleTrash = path.join(acquisitionRoot, '.compacted-binary');
    finalizeCommittedPreparedPhoneCompaction({
      artifacts: summary.artifacts,
      acquisitionRoot,
      trash: staleTrash,
    });
    return { compacted: true, bytesFreed: 0, alreadyCompacted: true };
  }
  if (typeof saveJob !== 'function' || typeof writeJobRecord !== 'function'
      || typeof renameFile !== 'function') {
    fail('Prepared acquisition compaction persistence is unavailable',
      'acquisition_compaction_failed');
  }
  const expectedRoles = new Set([
    'prepared-video', 'screenshot', 'capture-manifest',
    'presentation-plan', 'preparation-manifest',
  ]);
  if (!Array.isArray(summary.artifacts) || summary.artifacts.length !== expectedRoles.size
      || new Set(summary.artifacts.map(({ role }) => role)).size !== expectedRoles.size
      || summary.artifacts.some(({ role }) => !expectedRoles.has(role))) {
    fail('Prepared acquisition artifact ledger is incomplete', 'acquisition_compaction_failed');
  }
  const jobRoot = fs.realpathSync(jobDirectory);
  const acquisitionRoot = fs.realpathSync(path.join(jobDirectory, 'acquisition'));
  if (path.relative(jobRoot, acquisitionRoot).startsWith('..'))
    fail('Prepared acquisition directory escaped its Run', 'acquisition_compaction_failed');
  const trash = path.join(acquisitionRoot, '.compacted-binary');
  recoverInterruptedPreparedPhoneCompaction({
    artifacts: summary.artifacts,
    jobRoot,
    acquisitionRoot,
    trash,
  });
  const resolveEvidence = (relativePath) => {
    const absolute = acquisitionLedgerPath(jobRoot, relativePath);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch (_) {}
    if (!stat?.isFile() || stat.isSymbolicLink())
      fail('Prepared acquisition evidence file is unavailable', 'acquisition_compaction_failed');
    return { absolute, stat };
  };
  const evidenceLedger = summary.artifacts.map((artifact) => {
    const evidence = resolveEvidence(artifact.evidenceFile);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1
        || evidence.stat.size !== artifact.size
        || !SHA256_HEX.test(artifact.sha256 || '')
        || hashFile(evidence.absolute) !== artifact.sha256) {
      fail('Prepared acquisition evidence bytes drifted', 'acquisition_compaction_failed');
    }
    return { artifact, ...evidence };
  });
  const providerEvidence = resolveEvidence(summary.evidenceFile);
  try { JSON.parse(fs.readFileSync(providerEvidence.absolute, 'utf8')); }
  catch (_) { fail('Provider evidence sidecar is invalid', 'acquisition_compaction_failed'); }

  const binary = evidenceLedger.filter(({ artifact }) =>
    artifact.role === 'prepared-video' || artifact.role === 'screenshot');
  if (fs.existsSync(trash))
    fail('Prepared acquisition compaction staging already exists', 'acquisition_compaction_failed');
  fs.mkdirSync(trash, { mode: 0o700 });
  const previousArtifacts = JSON.parse(JSON.stringify(summary.artifacts));
  const hadPreviousRetention = Object.prototype.hasOwnProperty.call(
    summary, 'acquisitionRetention');
  const previousRetention = hadPreviousRetention
    ? JSON.parse(JSON.stringify(summary.acquisitionRetention)) : undefined;
  const moved = [];
  let bytesFreed = 0;
  try {
    for (const entry of binary) {
      // Provider artifact paths are unique, but their basenames are not required to be. Stage by
      // the already validated unique role + digest so two nested files named alike can never
      // replace one another before saveJob commits the compacted ledger.
      const staged = path.join(trash, `${entry.artifact.role}-${entry.artifact.sha256}`);
      renameFile(entry.absolute, staged);
      moved.push({ from: entry.absolute, staged, artifact: entry.artifact });
      bytesFreed += entry.stat.size;
      delete entry.artifact.evidenceFile;
      entry.artifact.retention = 'compacted_after_verified_render';
    }
    summary.acquisitionRetention = {
      schemaVersion: 1,
      status: 'sidecars_only',
      policy: 'binary_compacted_after_verified_render_v1',
      compactedAt: nowISO(),
      removedRoles: ['prepared-video', 'screenshot'],
      retainedRoles: ['capture-manifest', 'presentation-plan', 'preparation-manifest'],
      bytesFreed,
    };
    saveJob(job);
  } catch (error) {
    summary.artifacts = previousArtifacts;
    if (hadPreviousRetention) summary.acquisitionRetention = previousRetention;
    else delete summary.acquisitionRetention;
    // First make the restored ledger durable. If this atomic write fails, every staged byte stays
    // untouched so the next process can inspect the durable old/new ledger and recover or finish
    // the commit. Never recursively delete an ambiguous transaction directory.
    try { writeJobRecord(job); }
    catch (rollbackError) {
      error.rollbackError = rollbackError;
      throw error;
    }
    let restoreError = null;
    for (const item of moved.reverse()) {
      try {
        renameFile(item.staged, item.from);
        verifyCompactionArtifactFile(item.from, item.artifact, acquisitionRoot,
          'Restored prepared acquisition evidence file');
      } catch (rollbackError) {
        restoreError = restoreError || rollbackError;
      }
    }
    if (restoreError) {
      error.rollbackError = restoreError;
      throw error;
    }
    try { fs.rmdirSync(trash); } catch (_) {}
    throw error;
  }
  finalizeCommittedPreparedPhoneCompaction({
    artifacts: summary.artifacts,
    acquisitionRoot,
    trash,
  });
  return { compacted: true, bytesFreed, alreadyCompacted: false };
}

async function prepareJobMaterialAcquisition({
  job,
  jobDirectory,
  projectStore,
  requestIdFactory,
  nowISO,
  saveJob,
  appendLog = () => {},
  provider = createChipKCaptureCliAdapter(),
}) {
  const intent = job.materialAcquisition;
  if (!intent) return null;
  const requestId = requestIdFactory();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId))
    fail('Server generated an invalid acquisition request ID', 'invalid_request');
  if (intent.policy === 'disable-capture') {
    const summary = {
      requestId,
      policy: intent.policy,
      operation: intent.operation,
      mode: intent.mode,
      route: intent.route,
      status: 'skipped',
      reason: 'capture_disabled',
      evidenceLevel: 'none',
      provider: null,
      contractVersion: null,
      providerVersion: null,
      completedAt: nowISO(),
    };
    job.materialAcquisitionResult = summary;
    saveJob(job);
    return summary;
  }
  const acquisitionRoot = ensureOwnedDirectory(jobDirectory, 'acquisition');
  const outputDirectory = path.join(acquisitionRoot, requestId);
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const request = buildCaptureRequest(intent, { requestId, outputDirectory });
  let result;
  try {
    result = await acquireOptionalMaterial({
      policy: intent.policy,
      request,
      provider,
      fallback: async () => ({
        source: 'existing-project-assets',
        evidenceLevel: 'illustrative_not_fresh_capture',
      }),
    });
  } catch (error) {
    job.materialAcquisitionResult = {
      requestId,
      policy: intent.policy,
      operation: intent.operation,
      mode: intent.mode,
      route: intent.route,
      status: 'failed',
      reason: error.code || 'provider_request_failed',
      evidenceLevel: 'none',
      provider: null,
      contractVersion: null,
      providerVersion: null,
      completedAt: nowISO(),
    };
    saveJob(job);
    throw error;
  }

  const summary = baseSummary(intent, request, result, nowISO);
  if (result.status !== 'acquired') {
    job.materialAcquisitionResult = summary;
    saveJob(job);
    if (result.status === 'fallback')
      appendLog(job, `\n⚠️ Capture provider 未提供 fresh material（${result.reason}）；`
        + '沿用既有素材並標記 illustrative limitation。\n');
    return summary;
  }

  try {
    summary.evidenceFile = safeEvidenceFile(
      acquisitionRoot, requestId, result.acquisitionEvidence || {});
    if (intent.operation === 'screenshot') {
      const artifact = result.material.find((item) => item.role === 'screenshot');
      if (!artifact) fail('Validated screenshot artifact is missing', 'materialization_failed');
      const asset = projectStore.ingestAsset(job.projectId, artifact.absolutePath, {
        originalName: `${intent.route}.png`,
        kind: 'image',
      });
      const inputDirectory = ensureOwnedDirectory(jobDirectory, 'input');
      const inputName = nextShotName(inputDirectory);
      projectStore.materializeAsset(job.projectId, asset.id, path.join(inputDirectory, inputName));
      if (!job.assetRefs.includes(asset.id)) job.assetRefs.push(asset.id);
      summary.artifact = {
        assetRef: asset.id,
        role: artifact.role,
        inputName,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        size: artifact.size,
        media: artifact.media,
      };
    } else if (intent.operation === 'record') {
      summary.artifacts = result.material.map((artifact) => ({
        role: artifact.role,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        size: artifact.size,
        media: artifact.media || null,
      }));
      summary.automaticTimelineUse = false;
    } else {
      stagePreparedPhoneMaterial({ intent, request, result, summary, jobDirectory });
    }
  } catch (error) {
    summary.status = intent.policy === 'require-capture' ? 'failed' : 'fallback';
    summary.reason = 'materialization_failed';
    summary.evidenceLevel = intent.policy === 'require-capture'
      ? 'none' : 'illustrative_not_fresh_capture';
    job.materialAcquisitionResult = summary;
    saveJob(job);
    if (intent.policy === 'require-capture' && error instanceof MaterialAcquisitionError)
      throw error;
    if (intent.policy === 'require-capture')
      fail('Required capture could not be materialized', 'materialization_failed');
    appendLog(job, '\n⚠️ Fresh Capture 驗證成功，但未能安全保存或加入 Project；沿用既有素材。\n');
    return summary;
  }
  job.materialAcquisitionResult = summary;
  saveJob(job);
  appendLog(job, intent.operation === 'screenshot'
    ? `\n📷 Fresh Capture 已驗證並加入 ${summary.artifact.inputName}。\n`
    : intent.operation === 'record'
      ? '\n🎬 Raw recording 已驗證；本輪不自動剪入 timeline。\n'
      : '\n📱 Ready-to-place 手機素材已驗證；等待 timeline placement 編譯。\n');
  return summary;
}

module.exports = {
  REVIEW_EDIT_TRANSACTION,
  beginPreparedPhoneReviewEditTransaction,
  buildFocusstockVisualConflictEvidence,
  buildFocusstockVisualTimelinePlacements,
  buildPreparedPhoneTimelinePlacement,
  compileReviewedFocusstockVisualEvidence,
  compactPreparedPhoneAcquisition,
  commitPreparedPhoneMaterialSelection,
  PREPARED_INTENT_INPUT,
  PREPARED_PLAN,
  PREPARED_VIDEO_INPUT,
  finalizePreparedPhoneMaterial,
  focusstockVisualFrameInterval,
  mergePreparedPhoneTimelineChannels,
  nextShotName,
  prepareJobMaterialAcquisition,
  recordPreparedPhoneReviewEditCommitIntent,
  recoverPreparedPhoneReviewEditTransaction,
  requireFocusstockCarryCompaction,
  rollbackPreparedPhoneMaterialSelection,
  selectPreparedPhoneGraphicBroll,
  finalizePreparedPhoneReviewEditTransaction,
  validateCompiledPreparedPlan,
  validateFocusstockVisualTimelinePlacements,
  validatePreparedPhonePlacementMath,
  validatePreparedFocusstockAssetRefs,
  verifyPreparedPhoneDurableOutputs,
  validatePreparedPhoneProjectAsset,
};
