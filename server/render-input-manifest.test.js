'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildRenderInputManifest,
  verifyDeclaredFileFingerprints,
} = require('./render-input-manifest');

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
  fs.writeFileSync(path.join(artifactRoot, 'src', 'video-meta.json'), '{"heygenDurationSec":1,"outroDurationSec":0,"title":"晨報"}');
  fs.writeFileSync(path.join(rendererRoot, 'src', 'GraphicBrollCard.tsx'), 'export const GraphicBrollCard = 1;');
  fs.writeFileSync(path.join(rendererRoot, 'src', 'MarketingVideo.tsx'), 'export const MarketingVideo = 1;');
  fs.writeFileSync(path.join(rendererRoot, 'src', 'timeline.ts'), 'export const timeline = 1;');
  fs.writeFileSync(path.join(rendererRoot, 'package-lock.json'), '{"lockfileVersion":3}');
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

test('graphic card renderer implementation 或 dependency lock 改變會改變 digest', () => {
  const roots = fixture();
  try {
    const initial = build(roots).sha256;
    for (const relativePath of [
      'src/GraphicBrollCard.tsx',
      'src/MarketingVideo.tsx',
      'src/timeline.ts',
      'package-lock.json',
    ]) {
      const file = path.join(roots.rendererRoot, relativePath);
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, '\n// renderer drift');
      assert.notEqual(build(roots).sha256, initial, `${relativePath} 必須改變 digest`);
      fs.writeFileSync(file, original);
    }
  } finally { fs.rmSync(roots.root, { recursive: true, force: true }); }
});

test('必要 renderer source 或 package-lock 缺檔時 fail closed', () => {
  for (const relativePath of [
    'src/GraphicBrollCard.tsx',
    'src/MarketingVideo.tsx',
    'src/timeline.ts',
    'package-lock.json',
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
