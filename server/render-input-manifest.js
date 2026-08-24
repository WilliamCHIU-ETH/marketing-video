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
  'scripts/heygen-video-title.js',
  'scripts/prepared-phone-material-plan.js',
  'scripts/public-utils.js',
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
  REQUIRED_ARTIFACT_INPUTS,
  REQUIRED_RENDERER_INPUTS,
  buildRenderInputManifest,
  verifyDeclaredFileFingerprints,
};
