'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_COMPOSITION_FILES = [
  'src/graphic-broll.generated.json',
  'src/marketing-shots.generated.json',
  'src/overlays.generated.json',
  'src/subtitles.json',
  'src/textcards.generated.json',
  'src/video-meta.json',
];
const DEFAULT_RENDERER_FILES = [
  'package-lock.json',
  'package.json',
  'remotion.config.ts',
  'run.js',
  'scripts/focusstock-broll-plan.js',
  'scripts/heygen-video-title.js',
  'scripts/prepared-phone-material-plan.js',
  'scripts/public-utils.js',
  'scripts/script-timeline-resolver.js',
  'scripts/script-utils.js',
  'tsconfig.json',
];
const REQUIRED_ARTIFACT_INPUTS = [
  'public/script.txt',
  'public/heygen.mp4',
  'src/graphic-broll.generated.json',
  'src/subtitles.json',
  'src/video-meta.json',
];
const REQUIRED_RENDERER_INPUTS = [
  ...DEFAULT_RENDERER_FILES,
  'src/index.ts',
];
const FOCUSSTOCK_BROLL_SOURCE_INPUT = 'public/focusstock-broll-carry.source.json';
const FOCUSSTOCK_BROLL_PLAN_INPUT = 'src/Focusstock/focusstock-broll.generated.json';
const FOCUSSTOCK_BROLL_PLANNER_IDENTITY = 'scripts/focusstock-broll-plan.js';
const FOCUSSTOCK_BROLL_LAYER_IDENTITY = 'src/Focusstock/FocusstockBrollLayer.tsx';
const PREPARED_PHONE_PLAN_INPUT = 'src/Focusstock/prepared-phone-material.generated.json';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function regularFilesUnder(baseDir, relativeDir) {
  const root = path.join(baseDir, relativeDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue;
      const absolute = path.join(directory, entry.name);
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`render input 不可為 symlink：${nextRelative}`);
      if (entry.isDirectory()) walk(absolute, nextRelative);
      else if (entry.isFile()) out.push(`${relativeDir}/${nextRelative}`);
    }
  };
  walk(root, '');
  return out;
}

function fingerprintFile(baseDir, relativePath) {
  const file = path.join(baseDir, relativePath);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`render input 不可為 symlink：${relativePath}`);
  if (!stat.isFile())
    throw new Error(`render input 不是一般檔案：${relativePath}`);
  const bytes = fs.readFileSync(file);
  return { path: relativePath, size: stat.size, sha256: sha256(bytes) };
}

function safeDeclaredPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && path.posix.normalize(value) === value
    && value !== '..'
    && !value.startsWith('../');
}

/**
 * Verify only the immutable state manifest's declared artifact set against the live workspace.
 * Extra files are intentionally ignored: restoreWorkspace preserves template assets belonging to
 * other templates, and those unrelated bytes must not make an otherwise exact Run unretryable.
 */
function verifyDeclaredFileFingerprints({ baseDir, expectedFiles, label = 'render artifact' }) {
  if (!baseDir || !Array.isArray(expectedFiles) || expectedFiles.length === 0)
    throw new Error(`${label} fingerprint contract 不完整`);
  const seen = new Set();
  for (const expected of expectedFiles) {
    if (!expected || !safeDeclaredPath(expected.path) || seen.has(expected.path)
        || !Number.isSafeInteger(expected.size) || expected.size < 0
        || !/^[a-f0-9]{64}$/.test(expected.sha256 || ''))
      throw new Error(`${label} fingerprint descriptor 不合法`);
    seen.add(expected.path);
    const actual = fingerprintFile(baseDir, expected.path);
    if (!actual) throw new Error(`${label} 缺少宣告檔案：${expected.path}`);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error(`${label} 宣告檔案 bytes 已改變：${expected.path}`);
  }
  return true;
}

function uniqueIdentity(inputs, relativePath, label) {
  const matches = inputs.filter((input) => input?.path === relativePath);
  const input = matches.length === 1 ? matches[0] : null;
  if (!input || !Number.isSafeInteger(input.size) || input.size <= 0
      || !/^[a-f0-9]{64}$/.test(input.sha256 || ''))
    throw new Error(`${label} identity 必須唯一：${relativePath}`);
  return input;
}

function readCanonicalJson(baseDir, relativePath, label) {
  let raw;
  let value;
  try {
    raw = fs.readFileSync(path.join(baseDir, relativePath), 'utf8');
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 無法讀取：${error.message}`);
  }
  if (raw !== JSON.stringify(value)) throw new Error(`${label} 不是 canonical JSON`);
  return { raw, value };
}

function sourceCardMatchesPlan(sourceCard, planCard) {
  if (!sourceCard || !planCard) return false;
  const planSource = { ...planCard };
  delete planSource.disposition;
  delete planSource.suppressedBy;
  return JSON.stringify(sourceCard) === JSON.stringify(planSource);
}

function verifyCarriedFocusstockInputs({ artifactRoot, artifactInputs, rendererIdentity }) {
  const sourceInput = uniqueIdentity(
    artifactInputs, FOCUSSTOCK_BROLL_SOURCE_INPUT, 'Focusstock B-roll carry source');
  const planInput = uniqueIdentity(
    artifactInputs, FOCUSSTOCK_BROLL_PLAN_INPUT, 'Focusstock B-roll generated plan');
  const plannerIdentity = uniqueIdentity(
    rendererIdentity, FOCUSSTOCK_BROLL_PLANNER_IDENTITY, 'Focusstock B-roll planner executable');
  const layerIdentity = uniqueIdentity(
    rendererIdentity, FOCUSSTOCK_BROLL_LAYER_IDENTITY, 'Focusstock B-roll renderer executable');
  const source = readCanonicalJson(
    artifactRoot, FOCUSSTOCK_BROLL_SOURCE_INPUT, 'Focusstock B-roll carry source');
  const plan = readCanonicalJson(
    artifactRoot, FOCUSSTOCK_BROLL_PLAN_INPUT, 'Focusstock B-roll generated plan');
  try {
    require('./focusstock-broll-carry-forward').validateFocusstockBrollCarryPlan(plan.value);
  } catch (error) {
    throw new Error(`Focusstock B-roll generated plan 不合法：${error.message}`);
  }

  const sourceSha256 = sha256(Buffer.from(source.raw));
  const planSha256 = sha256(Buffer.from(plan.raw));
  if (source.value?.schemaVersion !== 2 || source.value.mode !== 'carry-source-v1'
      || source.value.template !== 'focusstock'
      || source.value.timelineBasis !== plan.value.timelineBasis
      || source.value.fps !== plan.value.fps
      || source.value.intervalSemantics !== plan.value.intervalSemantics
      || sourceSha256 !== sourceInput.sha256 || sourceInput.size !== Buffer.byteLength(source.raw)
      || sourceSha256 !== plan.value.sourceSnapshotSha256
      || planSha256 !== planInput.sha256 || planInput.size !== Buffer.byteLength(plan.raw)
      || source.value.sourceScriptSha256 !== plan.value.sourceScriptSha256
      || JSON.stringify(source.value.parent) !== JSON.stringify(plan.value.parent)
      || JSON.stringify(source.value.speaker) !== JSON.stringify(plan.value.speaker)
      || !Array.isArray(source.value.cards)
      || source.value.cards.length !== plan.value.cards.length
      || source.value.cards.some((card, index) => !sourceCardMatchesPlan(card, plan.value.cards[index]))) {
    throw new Error('carried Focusstock source／plan identity 不一致');
  }

  const scriptInput = uniqueIdentity(artifactInputs, 'public/script.txt', 'Child script');
  const speakerInput = uniqueIdentity(artifactInputs, 'public/heygen.mp4', 'Child speaker');
  const preparedVideoInput = uniqueIdentity(
    artifactInputs, 'public/prepared-phone-material.mp4', 'Prepared phone video');
  const preparedPlanInput = uniqueIdentity(
    artifactInputs, PREPARED_PHONE_PLAN_INPUT, 'Prepared phone generated plan');
  if (scriptInput.sha256 !== plan.value.sourceScriptSha256
      || speakerInput.sha256 !== plan.value.speaker.assetSha256
      || speakerInput.size !== plan.value.speaker.assetSize
      || plan.value.speaker.inputName !== 'heygen.mp4'
      || preparedVideoInput.sha256 !== plan.value.prepared.sourceSha256
      || preparedPlanInput.sha256 !== plan.value.prepared.planSha256) {
    throw new Error('carried Focusstock child script／speaker／prepared identity 不一致');
  }

  const declaredPublicPaths = new Set();
  for (const card of plan.value.cards) {
    const relativePath = `public/${card.inputName}`;
    if (declaredPublicPaths.has(relativePath))
      throw new Error(`carried Focusstock B-roll input 重複：${relativePath}`);
    declaredPublicPaths.add(relativePath);
    const input = uniqueIdentity(artifactInputs, relativePath, 'Carried Focusstock B-roll input');
    if (input.size !== card.assetSize || input.sha256 !== card.assetSha256)
      throw new Error(`carried Focusstock B-roll input bytes 不符：${relativePath}`);
  }
  return { source: sourceInput, plan: planInput, plannerIdentity, layerIdentity };
}

function buildRenderInputManifest({
  artifactRoot,
  rendererRoot,
  template,
  compositionId,
  brand = null,
  withAd = false,
  workflowMode = 'manual-assets',
  graphicBrollMode = 'disabled',
  preparedPhoneMode = 'disabled',
  focusstockBrollMode = 'disabled',
}) {
  if (!artifactRoot || !rendererRoot || !template || !compositionId)
    throw new Error('render input manifest 缺少 artifactRoot／rendererRoot 或必要欄位');
  // state/src owns every generated render artifact captured for this Run. The live checkout owns
  // every remaining source file. Their union is the complete repo-local Remotion source envelope;
  // recursive discovery avoids silently losing provenance when a new component is imported later.
  const artifactSourcePaths = regularFilesUnder(artifactRoot, 'src');
  const artifactPaths = [...new Set([
    ...regularFilesUnder(artifactRoot, 'public'),
    ...artifactSourcePaths,
  ])].sort();
  const artifactSourceSet = new Set(artifactSourcePaths);
  const rendererPaths = [...new Set([
    ...DEFAULT_RENDERER_FILES,
    ...regularFilesUnder(rendererRoot, 'src')
      .filter((relativePath) => !artifactSourceSet.has(relativePath)),
  ])].sort();
  const artifactInputs = artifactPaths
    .map((relativePath) => fingerprintFile(artifactRoot, relativePath)).filter(Boolean);
  const rendererIdentity = rendererPaths
    .map((relativePath) => fingerprintFile(rendererRoot, relativePath)).filter(Boolean);
  const presentArtifacts = new Set(artifactInputs.map((item) => item.path));
  const presentRenderer = new Set(rendererIdentity.map((item) => item.path));
  const missingArtifacts = REQUIRED_ARTIFACT_INPUTS
    .filter((relativePath) => !presentArtifacts.has(relativePath));
  if (preparedPhoneMode === 'ready-to-place') {
    for (const relativePath of [
      'public/prepared-phone-material.intent.json',
      'public/prepared-phone-material.mp4',
      'src/Focusstock/prepared-phone-material.generated.json',
    ]) {
      if (!presentArtifacts.has(relativePath)) missingArtifacts.push(relativePath);
    }
  } else if (preparedPhoneMode !== 'disabled') {
    throw new Error(`render input preparedPhoneMode 不合法：${preparedPhoneMode}`);
  }
  if (focusstockBrollMode === 'carried-v1') {
    if (template !== 'focusstock' || preparedPhoneMode !== 'ready-to-place')
      throw new Error('carried Focusstock B-roll 必須搭配 ready-to-place Focusstock render');
    verifyCarriedFocusstockInputs({ artifactRoot, artifactInputs, rendererIdentity });
  } else if (focusstockBrollMode !== 'disabled') {
    throw new Error(`render input focusstockBrollMode 不合法：${focusstockBrollMode}`);
  }
  const missingRenderer = REQUIRED_RENDERER_INPUTS
    .filter((relativePath) => !presentRenderer.has(relativePath));
  if (missingArtifacts.length)
    throw new Error(`render artifact inputs 缺少必要檔案：${missingArtifacts.join(', ')}`);
  if (missingRenderer.length)
    throw new Error(`renderer identity 缺少必要檔案：${missingRenderer.join(', ')}`);
  const manifest = {
    schemaVersion: 1,
    rendererContractVersion: 'remotion-source-closure-v1',
    template,
    compositionId,
    options: {
      brand,
      withAd: Boolean(withAd),
      workflowMode,
      graphicBrollMode,
      preparedPhoneMode,
      focusstockBrollMode,
    },
    artifactInputs,
    rendererIdentity,
  };
  const canonical = JSON.stringify(manifest);
  return { manifest, sha256: sha256(Buffer.from(canonical)), canonical };
}

module.exports = {
  DEFAULT_COMPOSITION_FILES,
  DEFAULT_RENDERER_FILES,
  FOCUSSTOCK_BROLL_LAYER_IDENTITY,
  FOCUSSTOCK_BROLL_PLAN_INPUT,
  FOCUSSTOCK_BROLL_PLANNER_IDENTITY,
  FOCUSSTOCK_BROLL_SOURCE_INPUT,
  REQUIRED_ARTIFACT_INPUTS,
  REQUIRED_RENDERER_INPUTS,
  buildRenderInputManifest,
  verifyDeclaredFileFingerprints,
};
