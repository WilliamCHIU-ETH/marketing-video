'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  FOCUSSTOCK_BROLL_LAYER_IDENTITY,
  FOCUSSTOCK_BROLL_PLAN_INPUT,
  FOCUSSTOCK_BROLL_PLANNER_IDENTITY,
  FOCUSSTOCK_BROLL_SOURCE_INPUT,
  buildRenderInputManifest,
  verifyDeclaredFileFingerprints,
} = require('./render-input-manifest');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-manifest-'));
  const artifactRoot = path.join(root, 'run-state');
  const rendererRoot = path.join(root, 'checkout');
  fs.mkdirSync(path.join(artifactRoot, 'public'), { recursive: true });
  fs.mkdirSync(path.join(artifactRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(rendererRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'public', 'script.txt'), '晨報測試');
  fs.writeFileSync(path.join(artifactRoot, 'public', 'heygen.mp4'), 'avatar-fixture');
  fs.writeFileSync(path.join(artifactRoot, 'src', 'subtitles.json'), '{"_scriptCharTimes":[]}');
  fs.writeFileSync(path.join(artifactRoot, 'src', 'graphic-broll.generated.json'), '{"schemaVersion":1,"mode":"disabled","cards":[]}');
  fs.mkdirSync(path.join(artifactRoot, 'src', 'Focusstock'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'src', 'Focusstock', 'prepared-phone-material.generated.json'),
    '{"schemaVersion":1,"mode":"disabled","template":"focusstock","timelineBasis":"focusstock-main-v1","source":null,"presentation":null,"placement":null,"visualOwnership":null}');
  fs.writeFileSync(path.join(artifactRoot, 'src', 'video-meta.json'), '{"heygenDurationSec":1,"outroDurationSec":0,"title":"晨報"}');
  for (const [relativePath, content] of [
    ['package-lock.json', '{"lockfileVersion":3}'],
    ['package.json', '{"scripts":{"render":"remotion render MarketingVideo out/output.mp4"}}'],
    ['remotion.config.ts', "import {Config} from '@remotion/cli/config';"],
    ['run.js', "require('child_process').execSync('npm run render');"],
    ['scripts/focusstock-broll-plan.js', 'module.exports = {};'],
    ['scripts/heygen-video-title.js', 'module.exports = {};'],
    ['scripts/prepared-phone-material-plan.js', 'module.exports = {};'],
    ['scripts/public-utils.js', 'module.exports = {};'],
    ['scripts/script-timeline-resolver.js', 'module.exports = {};'],
    ['scripts/script-utils.js', 'module.exports = {};'],
    ['tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx"}}'],
    ['src/GraphicBrollCard.tsx', 'export const GraphicBrollCard = 1;'],
    ['src/MarketingVideo.tsx', 'export const MarketingVideo = 1;'],
    ['src/Root.tsx', 'export const Root = 1;'],
    ['src/ShotFocus.tsx', 'export const ShotFocus = 1;'],
    ['src/Subtitles.tsx', 'export const Subtitles = 1;'],
    ['src/TextCard.tsx', 'export const TextCard = 1;'],
    ['src/fonts.ts', 'export const fonts = 1;'],
    ['src/index.ts', 'export const index = 1;'],
    ['src/timeline.ts', 'export const timeline = 1;'],
  ]) {
    const file = path.join(rendererRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, artifactRoot, rendererRoot };
}

function build({ artifactRoot, rendererRoot }) {
  return buildRenderInputManifest({
    artifactRoot,
    rendererRoot,
    template: 'default',
    compositionId: 'MarketingVideo',
    brand: 'chipk',
    workflowMode: 'auto-broll',
    graphicBrollMode: 'card-v1',
  });
}

function carriedFixture() {
  const roots = fixture();
  const scriptBytes = fs.readFileSync(path.join(roots.artifactRoot, 'public', 'script.txt'));
  const speakerBytes = fs.readFileSync(path.join(roots.artifactRoot, 'public', 'heygen.mp4'));
  const preparedBytes = Buffer.from('synthetic-prepared-phone-video');
  const preparedPlanRaw = JSON.stringify({
    schemaVersion: 1,
    mode: 'ready-to-place',
    placement: { startFrame: 60, endFrame: 90 },
  });
  fs.writeFileSync(
    path.join(roots.artifactRoot, 'public', 'prepared-phone-material.mp4'), preparedBytes);
  fs.writeFileSync(
    path.join(roots.artifactRoot, 'public', 'prepared-phone-material.intent.json'),
    JSON.stringify({ mode: 'ready-to-place' }));
  fs.writeFileSync(
    path.join(roots.artifactRoot, 'src', 'Focusstock',
      'prepared-phone-material.generated.json'), preparedPlanRaw);

  const brollBytes = [Buffer.from('synthetic-broll-one'), Buffer.from('synthetic-broll-two')];
  const card = ({ ordinal, startSec, endSec }) => {
    const mainStartFrame = Math.round(startSec * 30);
    const mainDurationInFrames = Math.max(1, Math.round((endSec - startSec) * 30));
    const mainEndFrame = mainStartFrame + mainDurationInFrames;
    const compositionStartFrame = mainStartFrame + 30;
    const compositionEndFrame = mainEndFrame + 30;
    return {
      ordinal,
      id: `broll-${String(ordinal).padStart(2, '0')}`,
      assetRef: `asset-video-${ordinal}`,
      assetSha256: sha256(brollBytes[ordinal - 1]),
      assetSize: brollBytes[ordinal - 1].length,
      mediaType: 'video/mp4',
      inputName: `broll${ordinal}.mp4`,
      startCharIdx: (ordinal - 1) * 5,
      endCharIdx: (ordinal * 5) - 1,
      startSec,
      endSec,
      fps: 30,
      mainStartFrame,
      mainEndFrame,
      mainDurationInFrames,
      compositionOffsetFrames: 30,
      compositionStartFrame,
      compositionEndFrame,
      compositionStartSec: Number((compositionStartFrame / 30).toFixed(6)),
      compositionEndSec: Number((compositionEndFrame / 30).toFixed(6)),
    };
  };
  const sourceCards = [
    card({ ordinal: 1, startSec: 1, endSec: 2 }),
    card({ ordinal: 2, startSec: 2, endSec: 3 }),
  ];
  for (const [index, bytes] of brollBytes.entries()) {
    fs.writeFileSync(path.join(roots.artifactRoot, 'public', `broll${index + 1}.mp4`), bytes);
  }
  const parentOutput = {
    name: 'parent-output.mp4', size: 99, sha256: sha256('parent-output'),
  };
  const parentEvidence = {
    status: 'verified',
    projectId: 'project-1',
    revisionId: 'v005',
    renderInputManifestSha256: sha256('parent-manifest'),
    cardIds: sourceCards.map((item) => item.id),
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
  const source = {
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
  const sourceRaw = JSON.stringify(source);
  const plan = {
    schemaVersion: 2,
    mode: 'carried-v1',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    fps: 30,
    intervalSemantics: 'frame-half-open',
    sourceSnapshotSha256: sha256(sourceRaw),
    parent,
    sourceScriptSha256: source.sourceScriptSha256,
    prepared: {
      planSha256: sha256(preparedPlanRaw),
      sourceSha256: sha256(preparedBytes),
      fps: 30,
      startFrame: 60,
      endFrame: 90,
      durationInFrames: 30,
      intervalSemantics: 'frame-half-open',
    },
    speaker: source.speaker,
    cards: sourceCards.map((item, index) => ({
      ...item,
      disposition: index === 1 ? 'suppressed_by_prepared' : 'rendered',
      suppressedBy: index === 1 ? 'prepared-phone-video' : null,
    })),
  };
  fs.writeFileSync(path.join(roots.artifactRoot, FOCUSSTOCK_BROLL_SOURCE_INPUT), sourceRaw);
  fs.writeFileSync(
    path.join(roots.artifactRoot, FOCUSSTOCK_BROLL_PLAN_INPUT), JSON.stringify(plan));
  const layerFile = path.join(roots.rendererRoot, FOCUSSTOCK_BROLL_LAYER_IDENTITY);
  fs.mkdirSync(path.dirname(layerFile), { recursive: true });
  fs.writeFileSync(layerFile, 'export const FocusstockBrollLayer = 1;');
  return {
    ...roots,
    options: {
      artifactRoot: roots.artifactRoot,
      rendererRoot: roots.rendererRoot,
      template: 'focusstock',
      compositionId: 'Focusstock',
      workflowMode: 'manual-assets',
      graphicBrollMode: 'disabled',
      preparedPhoneMode: 'ready-to-place',
      focusstockBrollMode: 'carried-v1',
    },
    plan,
  };
}

test('render input manifest 對相同輸入 byte-identical，且 entries 固定排序', () => {
  const roots = fixture();
  try {
    const first = build(roots);
    const second = build(roots);
    assert.equal(first.canonical, second.canonical);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.manifest.artifactInputs.map((item) => item.path),
      [...first.manifest.artifactInputs.map((item) => item.path)].sort());
    assert.deepEqual(first.manifest.rendererIdentity.map((item) => item.path),
      [...first.manifest.rendererIdentity.map((item) => item.path)].sort());
    assert.equal(first.manifest.artifactInputs.some(
      (item) => item.path === 'src/GraphicBrollCard.tsx'), false);
    assert.equal(first.manifest.rendererIdentity.some(
      (item) => item.path === 'public/heygen.mp4'), false);
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('script、Avatar、subtitle、graphic plan 或 video-meta 任一 byte 改變都會改變 digest', () => {
  const roots = fixture();
  try {
    const initial = build(roots).sha256;
    for (const [relativePath, content] of [
      ['public/script.txt', '晨報測試二'],
      ['public/heygen.mp4', 'different-avatar'],
      ['src/subtitles.json', '{"_scriptCharTimes":[{"start":0,"end":1}]}'],
      ['src/graphic-broll.generated.json', '{"schemaVersion":1,"mode":"card-v1","cards":[]}'],
      ['src/video-meta.json', '{"heygenDurationSec":2,"outroDurationSec":0,"title":"晨報二"}'],
    ]) {
      const file = path.join(roots.artifactRoot, relativePath);
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, content);
      assert.notEqual(build(roots).sha256, initial, `${relativePath} 必須改變 digest`);
      fs.writeFileSync(file, original);
    }
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('必要的 script、Avatar、subtitle、graphic plan 或 video-meta 缺檔時 fail closed', () => {
  for (const relativePath of [
    'public/script.txt',
    'public/heygen.mp4',
    'src/subtitles.json',
    'src/graphic-broll.generated.json',
    'src/video-meta.json',
  ]) {
    const roots = fixture();
    try {
      fs.unlinkSync(path.join(roots.artifactRoot, relativePath));
      assert.throws(() => build(roots), new RegExp(relativePath.replace('.', '\\.')));
    } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
  }
});

test('ready-to-place mode requires and fingerprints prepared MP4, intent, and generated plan', () => {
  const roots = fixture();
  try {
    fs.writeFileSync(path.join(roots.artifactRoot, 'public', 'prepared-phone-material.mp4'),
      'prepared-video-bytes');
    fs.writeFileSync(path.join(roots.artifactRoot, 'public', 'prepared-phone-material.intent.json'),
      '{"mode":"ready-to-place"}');
    const options = {
      artifactRoot: roots.artifactRoot,
      rendererRoot: roots.rendererRoot,
      template: 'focusstock',
      compositionId: 'Focusstock',
      workflowMode: 'manual-assets',
      graphicBrollMode: 'disabled',
      preparedPhoneMode: 'ready-to-place',
    };
    const first = buildRenderInputManifest(options);
    assert.equal(first.manifest.options.preparedPhoneMode, 'ready-to-place');
    for (const relativePath of [
      'public/prepared-phone-material.mp4',
      'public/prepared-phone-material.intent.json',
      'src/Focusstock/prepared-phone-material.generated.json',
    ]) assert.ok(first.manifest.artifactInputs.some((item) => item.path === relativePath));
    fs.appendFileSync(path.join(roots.artifactRoot, 'public', 'prepared-phone-material.mp4'), 'drift');
    assert.notEqual(buildRenderInputManifest(options).sha256, first.sha256);
    fs.unlinkSync(path.join(roots.artifactRoot, 'public', 'prepared-phone-material.intent.json'));
    assert.throws(() => buildRenderInputManifest(options), /prepared-phone-material\.intent\.json/);
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('完整 renderer source、launch/config 或 dependency lock 改變都會改變 digest', () => {
  const roots = fixture();
  try {
    const initial = build(roots).sha256;
    for (const relativePath of [
      'src/GraphicBrollCard.tsx',
      'src/MarketingVideo.tsx',
      'src/Root.tsx',
      'src/ShotFocus.tsx',
      'src/Subtitles.tsx',
      'src/TextCard.tsx',
      'src/fonts.ts',
      'src/index.ts',
      'src/timeline.ts',
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
    ]) {
      const file = path.join(roots.rendererRoot, relativePath);
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, '\n// renderer drift');
      assert.notEqual(build(roots).sha256, initial, `${relativePath} 必須改變 digest`);
      fs.writeFileSync(file, original);
    }
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('新增或刪除 nested renderer source 都會改變 digest', () => {
  const roots = fixture();
  try {
    const initial = build(roots).sha256;
    const nested = path.join(roots.rendererRoot, 'src', 'components', 'FutureCard.tsx');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'export const FutureCard = 1;');
    const withNested = build(roots).sha256;
    assert.notEqual(withNested, initial);

    fs.unlinkSync(nested);
    assert.equal(build(roots).sha256, initial);

    fs.unlinkSync(path.join(roots.rendererRoot, 'src', 'Subtitles.tsx'));
    assert.notEqual(build(roots).sha256, initial);
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('state/src 的 nested artifacts 歸 artifact evidence，不重複算 renderer identity', () => {
  const roots = fixture();
  try {
    const nestedArtifact = path.join(
      roots.artifactRoot,
      'src',
      'nested',
      'future.generated.json',
    );
    fs.mkdirSync(path.dirname(nestedArtifact), { recursive: true });
    fs.writeFileSync(nestedArtifact, '{"future":true}');
    const sameLivePath = path.join(
      roots.rendererRoot,
      'src',
      'nested',
      'future.generated.json',
    );
    fs.mkdirSync(path.dirname(sameLivePath), { recursive: true });
    fs.writeFileSync(sameLivePath, '{"stale":"must-not-own-identity"}');

    const manifest = build(roots).manifest;
    assert.equal(manifest.artifactInputs.some(
      (item) => item.path === 'src/nested/future.generated.json'), true);
    assert.equal(manifest.rendererIdentity.some(
      (item) => item.path === 'src/nested/future.generated.json'), false);
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('必要 renderer entry、launch/config 或 dependency lock 缺檔時 fail closed', () => {
  for (const relativePath of [
    'src/index.ts',
    'package-lock.json',
    'package.json',
    'remotion.config.ts',
    'run.js',
    'scripts/focusstock-broll-plan.js',
    'scripts/heygen-video-title.js',
    'scripts/prepared-phone-material-plan.js',
    'scripts/public-utils.js',
    'tsconfig.json',
  ]) {
    const roots = fixture();
    try {
      fs.unlinkSync(path.join(roots.rendererRoot, relativePath));
      assert.throws(() => build(roots), new RegExp(relativePath.replace('.', '\\.')));
    } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
  }
});

test('render input symlink fail closed', () => {
  const roots = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'render-manifest-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
    fs.symlinkSync(path.join(outside, 'outside.txt'),
      path.join(roots.artifactRoot, 'public', 'unsafe.txt'));
    assert.throws(() => build(roots), /symlink/);
  } finally {
    fs.rmSync(roots.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('renderer identity symlink also fails closed', () => {
  const roots = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-manifest-outside-'));
  try {
    const outsideSource = path.join(outside, 'timeline.ts');
    fs.writeFileSync(outsideSource, 'export const outside = true;');
    const rendererSource = path.join(roots.rendererRoot, 'src', 'timeline.ts');
    fs.unlinkSync(rendererSource);
    fs.symlinkSync(outsideSource, rendererSource);
    assert.throws(() => build(roots), /symlink/);
  } finally {
    fs.rmSync(roots.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('live restore gate ignores unreferenced template assets but verifies declared bytes', () => {
  const roots = fixture();
  const liveRoot = path.join(roots.root, 'live-checkout');
  try {
    fs.cpSync(roots.artifactRoot, liveRoot, { recursive: true });
    const expectedFiles = build(roots).manifest.artifactInputs;
    fs.writeFileSync(path.join(liveRoot, 'public', 'dapan-header-overlay.png'), 'other-template');
    assert.doesNotThrow(() => verifyDeclaredFileFingerprints({
      baseDir: liveRoot,
      expectedFiles,
      label: 'restored artifacts',
    }));

    fs.writeFileSync(path.join(liveRoot, 'public', 'script.txt'), '同名但 bytes 已漂移');
    assert.throws(() => verifyDeclaredFileFingerprints({
      baseDir: liveRoot,
      expectedFiles,
      label: 'restored artifacts',
    }), /宣告檔案 bytes 已改變：public\/script\.txt/);
  } finally {
    fs.rmSync(roots.root, { recursive: true, force: true });
  }
});

test('carried Focusstock manifest binds canonical source, plan, every B-roll byte and executables', () => {
  const roots = carriedFixture();
  try {
    const built = buildRenderInputManifest(roots.options);
    assert.equal(built.manifest.options.focusstockBrollMode, 'carried-v1');
    for (const relativePath of [
      FOCUSSTOCK_BROLL_SOURCE_INPUT,
      FOCUSSTOCK_BROLL_PLAN_INPUT,
      'public/broll1.mp4',
      'public/broll2.mp4',
    ]) {
      assert.equal(built.manifest.artifactInputs.filter(
        (item) => item.path === relativePath).length, 1, relativePath);
    }
    for (const relativePath of [
      FOCUSSTOCK_BROLL_PLANNER_IDENTITY,
      FOCUSSTOCK_BROLL_LAYER_IDENTITY,
    ]) {
      assert.equal(built.manifest.rendererIdentity.filter(
        (item) => item.path === relativePath).length, 1, relativePath);
    }
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('carried Focusstock manifest fails closed on missing or drifted suppressed B-roll bytes', () => {
  for (const mutation of [
    (roots) => fs.unlinkSync(path.join(roots.artifactRoot, 'public', 'broll2.mp4')),
    (roots) => fs.appendFileSync(path.join(roots.artifactRoot, 'public', 'broll2.mp4'), 'drift'),
  ]) {
    const roots = carriedFixture();
    try {
      mutation(roots);
      assert.throws(() => buildRenderInputManifest(roots.options),
        /Carried Focusstock B-roll input|carried Focusstock B-roll input/);
    } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
  }
});

test('carried Focusstock manifest fails closed on source, child or executable identity drift', () => {
  const mutations = [
    (roots) => {
      const sourceFile = path.join(roots.artifactRoot, FOCUSSTOCK_BROLL_SOURCE_INPUT);
      const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
      fs.writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
    },
    (roots) => fs.appendFileSync(path.join(roots.artifactRoot, 'public', 'script.txt'), 'drift'),
    (roots) => fs.appendFileSync(path.join(
      roots.artifactRoot, 'src', 'Focusstock',
      'prepared-phone-material.generated.json'), 'drift'),
    (roots) => fs.unlinkSync(path.join(roots.rendererRoot, FOCUSSTOCK_BROLL_LAYER_IDENTITY)),
  ];
  for (const mutation of mutations) {
    const roots = carriedFixture();
    try {
      mutation(roots);
      assert.throws(() => buildRenderInputManifest(roots.options));
    } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
  }
});

test('carried Focusstock mode only accepts ready-to-place Focusstock renders', () => {
  for (const override of [
    { template: 'default' },
    { preparedPhoneMode: 'disabled' },
    { focusstockBrollMode: 'unknown' },
  ]) {
    const roots = carriedFixture();
    try {
      assert.throws(() => buildRenderInputManifest({ ...roots.options, ...override }));
    } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
  }
});
