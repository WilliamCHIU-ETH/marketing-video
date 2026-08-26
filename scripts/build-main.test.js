'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const APP = path.resolve(__dirname, '..');
const BUILD_MAIN = path.join(APP, 'config', 'templates', '台股晨報', 'build-main.mjs');
const BUILD_LEDGER = path.join(APP, 'scripts', 'build-segment-ledger.mjs');
const TEMPLATE = path.dirname(BUILD_MAIN);
const TMP = fs.realpathSync('/tmp');
const { assertNoSymlinkComponents } = require('./path-safety');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writePcmWav(file, durationSec, sampleRate = 8000) {
  const samples = Math.round(durationSec * sampleRate);
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wav);
}

function fixture(segments, durationSec = Math.max(...segments.map((segment) => segment.endSec))) {
  const root = fs.mkdtempSync(path.join(TMP, 'seam01-build-main-'));
  for (const dir of ['renders', 'public', 'script']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  writeJson(path.join(root, 'segment-ledger.json'), { durationSec, visualForm: 'card', segments });
  writeJson(path.join(root, 'caption-ledger.json'), [{
    id: '01', start: 0, end: durationSec, duration: durationSec, text: '測試',
  }]);
  writeJson(path.join(root, 'main.config.json'), {
    compositionId: 'fixture-main', topBar: 'none', intro: false, bgm: false, brollAudio: false,
  });
  writeJson(path.join(root, 'package.json'), { name: 'fixture' });
  const audioSources = new Set(segments.flatMap((segment) => segment.audio?.src ? [segment.audio.src] : []));
  if (!audioSources.size) audioSources.add('public/input-video.mp4');
  for (const source of audioSources) {
    const file = path.join(root, source);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'audio fixture');
  }
  for (const segment of segments) {
    if ((segment.visual?.mode ?? 'broll') === 'none') continue;
    fs.writeFileSync(path.join(root, 'renders', `${segment.id}-fixture.mp4`), 'render fixture');
  }
  return root;
}

function runBuild(project, extra = []) {
  return spawnSync(process.execPath, [BUILD_MAIN, '--project', project, ...extra], {
    cwd: APP,
    encoding: 'utf8',
  });
}

function segment(id, startSec, endSec, { audio = true, visual = 'broll', src = 'public/input-video.mp4' } = {}) {
  return {
    id, startSec, endSec, durationSec: Number((endSec - startSec).toFixed(4)),
    ...(audio ? { audio: { src, start: startSec, end: endSec } } : {}),
    visual: { mode: visual },
  };
}

test('visual:none segment owns audio but does not resolve or mount B-roll', () => {
  const root = fixture([
    segment('00', 0, 1.85, { visual: 'none' }),
    segment('01', 1.85, 3),
  ], 3);
  const result = runBuild(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.segments, 2);
  assert.equal(output.visualSegments, 1);
  assert.deepEqual(output.avatarClips[0], {
    src: 'public/input-video.mp4', start: 0, duration: 3, mediaStart: 0, segments: ['00', '01'],
  });
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /broll-00/);
  assert.match(html, /broll-01/);
});

test('rejects partially migrated segment audio', () => {
  const root = fixture([
    segment('01', 0, 1),
    segment('02', 1, 2, { audio: false }),
  ], 2);
  const result = runBuild(root);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /audio schema 混合；缺 audio 的段：02/);
});

test('all segments without audio use only the explicit legacy fallback', () => {
  const root = fixture([
    segment('01', 0, 1, { audio: false }),
    segment('02', 1, 2, { audio: false }),
  ], 2);
  const result = runBuild(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN legacy-ledger-no-audio/);
  const output = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(output.legacyAvatarAudio, true);
});

test('durationSec always renders endSec minus startSec instead of stale fixture value', () => {
  const stale = segment('01', 0, 5.195);
  stale.durationSec = 5.2;
  const root = fixture([stale], 5.195);
  const result = runBuild(root);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="broll-01"[^>]+data-duration="5\.195"/);
  assert.doesNotMatch(html, /id="broll-01"[^>]+data-duration="5\.2"/);
});

test('rejects symlinked project/template/audio path components', () => {
  assert.throws(
    () => assertNoSymlinkComponents(
      path.join(APP, 'assets', 'avatar-pairs.json'),
      'app/assets reviewer fixture',
    ),
    /component 是 symlink.*app\/assets/,
  );

  const base = fixture([segment('01', 0, 1)], 1);
  const projectLink = `${base}-project-link`;
  fs.symlinkSync(base, projectLink);
  let result = runBuild(projectLink);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--project 路徑 component 是 symlink/);

  const templateLink = `${base}-template-link`;
  fs.symlinkSync(TEMPLATE, templateLink);
  result = runBuild(base, ['--template', templateLink]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--template 路徑 component 是 symlink/);

  const unsafeAudioRoot = fixture([segment('01', 0, 1)], 1);
  const external = fs.mkdtempSync(path.join(TMP, 'seam01-external-audio-'));
  fs.writeFileSync(path.join(external, 'secret.mp4'), 'secret');
  fs.symlinkSync(external, path.join(unsafeAudioRoot, 'media'));
  writeJson(path.join(unsafeAudioRoot, 'segment-ledger.json'), {
    durationSec: 1,
    visualForm: 'card',
    segments: [segment('01', 0, 1, { src: 'media/secret.mp4' })],
  });
  result = runBuild(unsafeAudioRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /segment audio\.src.*路徑 component 是 symlink/);

  const headerRoot = fs.mkdtempSync(path.join(TMP, 'seam01-template-header-'));
  fs.copyFileSync(path.join(TEMPLATE, 'layout.json'), path.join(headerRoot, 'layout.json'));
  fs.symlinkSync(path.join(TEMPLATE, 'header.mjs'), path.join(headerRoot, 'header.mjs'));
  result = runBuild(base, ['--template', headerRoot]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /template\/header\.mjs 路徑 component 是 symlink/);
});

test('build-segment-ledger measures selected audio and rejects retained duration conflicts', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'seam01-audio-duration-'));
  for (const dir of ['script', 'asr', 'recordings']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'script', 'script.v1.txt'), '(image1)甲(image1)');
  writeJson(path.join(root, 'asr', 'script-char-times.json'), [
    { i: 0, ch: '甲', origIdx: 8, start: 0, end: 0.5 },
  ]);
  writePcmWav(path.join(root, 'recordings', 'selected.wav'), 1);
  writeJson(path.join(root, 'segment-ledger.json'), { durationSec: 2, segments: [] });
  let result = spawnSync(process.execPath, [
    BUILD_LEDGER,
    '--project', root,
    '--audio-src', 'recordings/selected.wav',
    '--out', 'rebuilt.json',
  ], { cwd: APP, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /audio source duration 1\.000000s/);
  assert.match(`${result.stdout}${result.stderr}`, /metadata duration 2\.000000s 衝突/);
  assert.equal(fs.existsSync(path.join(root, 'rebuilt.json')), false);

  writeJson(path.join(root, 'segment-ledger.json'), { durationSec: 1.05, segments: [] });
  result = spawnSync(process.execPath, [
    BUILD_LEDGER,
    '--project', root,
    '--audio-src', 'recordings/selected.wav',
    '--out', 'rebuilt.json',
  ], { cwd: APP, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rebuilt = JSON.parse(fs.readFileSync(path.join(root, 'rebuilt.json'), 'utf8'));
  assert.equal(rebuilt.durationSec, 1);
  assert.equal(rebuilt.segments[0].endSec, 1);
  assert.deepEqual(rebuilt.segments[0].audio, {
    src: 'recordings/selected.wav', start: 0, end: 1,
  });
});

test('build-segment-ledger rejects symlinked --out nearest parent', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'seam01-build-ledger-'));
  for (const dir of ['script', 'asr', 'public']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'script', 'script.v1.txt'), '(image1)甲(image1)');
  writeJson(path.join(root, 'asr', 'script-char-times.json'), [
    { i: 0, ch: '甲', origIdx: 8, start: 0, end: 1 },
  ]);
  fs.writeFileSync(path.join(root, 'public', 'input-video.mp4'), 'audio');
  writeJson(path.join(root, 'segment-ledger.json'), { durationSec: 1, segments: [] });
  const external = fs.mkdtempSync(path.join(TMP, 'seam01-external-out-'));
  fs.symlinkSync(external, path.join(root, 'out-link'));
  const result = spawnSync(process.execPath, [
    BUILD_LEDGER,
    '--project', root,
    '--out', 'out-link/ledger.json',
  ], { cwd: APP, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--out 路徑 component 是 symlink/);
  assert.equal(fs.existsSync(path.join(external, 'ledger.json')), false);
});
