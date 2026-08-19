#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { inspectMediaFile } = require('../server/project-store');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-smoke-'));
const GUARD_LOG = path.join(DATA_DIR, 'blocked-side-effects.log');
const GUARD_MODULE = path.join(DATA_DIR, 'side-effect-guard.cjs');
let child;

// 1x1 PNG 與一幀 H.264 MP4；MP4 是可解碼的完整容器，不用外部服務生成。
const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64');

// Test-side CRC deliberately uses a small bitwise implementation rather than the production table.
function fixtureCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(fixtureCrc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

// Keep a second, structurally valid PNG for kind-aware dedupe/rollback tests.
const ALT_PNG_FIXTURE = Buffer.concat([
  PNG_FIXTURE.subarray(0, -12),
  pngChunk('tEXt', Buffer.from('fixture\0revision-abort', 'latin1')),
  PNG_FIXTURE.subarray(-12),
]);
const TRUNCATED_PNG_FIXTURE = Buffer.from(PNG_FIXTURE.subarray(0, 24));
const BAD_PNG_CRC_FIXTURE = Buffer.from(PNG_FIXTURE);
BAD_PNG_CRC_FIXTURE[29] ^= 0x01;
const ZERO_WIDTH_PNG_FIXTURE = Buffer.from(PNG_FIXTURE);
ZERO_WIDTH_PNG_FIXTURE.writeUInt32BE(0, 16);
ZERO_WIDTH_PNG_FIXTURE.writeUInt32BE(
  fixtureCrc32(ZERO_WIDTH_PNG_FIXTURE.subarray(12, 29)), 29);
const MISSING_IEND_PNG_FIXTURE = Buffer.from(PNG_FIXTURE.subarray(0, -12));
const TRAILING_DATA_PNG_FIXTURE = Buffer.concat([PNG_FIXTURE, Buffer.from('trailing-data')]);
const NO_IDAT_PNG_FIXTURE = Buffer.concat([PNG_FIXTURE.subarray(0, 33), PNG_FIXTURE.subarray(-12)]);
const OUT_OF_BOUNDS_PNG_FIXTURE = Buffer.from(PNG_FIXTURE);
const idatTypeOffset = OUT_OF_BOUNDS_PNG_FIXTURE.indexOf(Buffer.from('IDAT', 'ascii'));
assert.ok(idatTypeOffset > 4);
OUT_OF_BOUNDS_PNG_FIXTURE.writeUInt32BE(0x7fffffff, idatTypeOffset - 4);

const MP4_FIXTURE = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAs1tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAQZYiEABX//vfJ78Cm69vfgQ==',
  'base64');
const AVIF_DISGUISED_AS_MP4 = Buffer.from(MP4_FIXTURE);
AVIF_DISGUISED_AS_MP4.write('avif', 8, 'latin1');
const WEBM_VIDEO_FIXTURE = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHrEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHV7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYht/3e7E/vOwJyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhDuaygDgkLCBELqBEJqBAlWwhFW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMnNz2mPAi2PFiG3/d7sT+87AZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDIgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnWl54EAo6CBAACAgkmDQgAA8AD2ADgkHBhKAAAwYAAAEL///UiMABxTu2uRu4+zgQC3iveBAfGCAavwgQM=',
  'base64');
const WEBM_AUDIO_ONLY_FIXTURE = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAIkEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggFCTbuMU6uEHFO7a1OsggIO7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiEBbAAAAAAAAFlSua+WuAQAAAAAAAFzXgQFzxYijhMl4lJm3eZyBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQOdwAAAAAABiZIEQY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2f9c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2Mi4xMi4xMDJzc9djwItjxYijhMl4lJm3eWfIokWjh0VOQ09ERVJEh5VMYXZjNjIuMjguMTAyIGxpYm9wdXNnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjEwODAwMDAwMAAfQ7Z1xeeBAKOHgQAAgPj//qOHgQAVgPj//qOHgQApgPj//qOHgQA9gPj//qOHgQBRgPj//qCToYeBAGUA+P/+m4EHdaKEAM3+YBxTu2uRu4+zgQC3iveBAfGCAcTwgQM=',
  'base64');

function topLevelBoxes(bytes) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= bytes.length);
    boxes.push({
      type: bytes.subarray(offset + 4, offset + 8).toString('latin1'),
      bytes: Buffer.from(bytes.subarray(offset, offset + size)),
    });
    offset += size;
  }
  assert.equal(offset, bytes.length);
  return boxes;
}

function freeBox(size, marker = '') {
  assert.ok(size >= 8 && size <= 0xffffffff);
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write('free', 4, 'latin1');
  if (marker) box.write(marker, 8, 'latin1');
  return box;
}

function lateMoovMp4Fixture() {
  const boxes = topLevelBoxes(MP4_FIXTURE);
  const ftyp = boxes.find((box) => box.type === 'ftyp').bytes;
  const moov = boxes.find((box) => box.type === 'moov').bytes;
  const mdat = boxes.find((box) => box.type === 'mdat').bytes;
  const stcoType = moov.indexOf(Buffer.from('stco', 'latin1'));
  assert.ok(stcoType >= 4);
  moov.writeUInt32BE(ftyp.length + 8, stcoType + 12);
  return Buffer.concat([ftyp, mdat, freeBox(96 * 1024), moov, freeBox(96 * 1024)]);
}

const LATE_MOOV_MP4_FIXTURE = lateMoovMp4Fixture();
const DECOY_VIDEO_MP4_FIXTURE = Buffer.from(MP4_FIXTURE);
const videoHandler = DECOY_VIDEO_MP4_FIXTURE.indexOf(Buffer.from('vide', 'latin1'));
assert.ok(videoHandler > 0);
DECOY_VIDEO_MP4_FIXTURE.write('soun', videoHandler, 'latin1');
const MP4_WITHOUT_VIDEO_TRACK = Buffer.concat([DECOY_VIDEO_MP4_FIXTURE, freeBox(32, 'vide')]);

fs.writeFileSync(GUARD_MODULE, `
'use strict';
const fs = require('fs');
const childProcess = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const log = process.env.SMOKE_GUARD_LOG;
function blocked(kind) {
  return function () {
    fs.appendFileSync(log, kind + '\\n');
    throw new Error('smoke guard blocked ' + kind);
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = blocked('child_process.' + name);
}
http.request = blocked('http.request');
http.get = blocked('http.get');
https.request = blocked('https.request');
https.get = blocked('https.get');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
tls.connect = blocked('tls.connect');
global.fetch = blocked('fetch');
`);

function treeFingerprint(dir) {
  const out = [];
  const walk = (base, rel = '') => {
    if (!fs.existsSync(base)) return;
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const file = path.join(base, entry.name);
      if (entry.isDirectory()) walk(file, nextRel);
      else {
        const stat = fs.statSync(file);
        out.push(`${nextRel}:${stat.size}:${Math.round(stat.mtimeMs)}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

function treeState(dir) {
  return JSON.stringify({ exists: fs.existsSync(dir), fingerprint: treeFingerprint(dir) });
}

function waitForReady(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server 啟動逾時\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/SERVER_READY (\{[^\n]+\})/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(JSON.parse(match[1]));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server 提前結束（${code}）\n${output}`));
    });
  });
}

async function request(base, pathname, options) {
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) {}
  assert.ok(res.ok, `${pathname} 回傳 ${res.status}: ${text}`);
  return body;
}

async function main() {
  const containerFixtures = [
    ['valid.png', PNG_FIXTURE, 'image/png'],
    ['valid-ancillary.png', ALT_PNG_FIXTURE, 'image/png'],
    ['truncated-ihdr.png', TRUNCATED_PNG_FIXTURE, null],
    ['bad-crc.png', BAD_PNG_CRC_FIXTURE, null],
    ['zero-width.png', ZERO_WIDTH_PNG_FIXTURE, null],
    ['missing-iend.png', MISSING_IEND_PNG_FIXTURE, null],
    ['trailing-data.png', TRAILING_DATA_PNG_FIXTURE, null],
    ['missing-idat.png', NO_IDAT_PNG_FIXTURE, null],
    ['out-of-bounds.png', OUT_OF_BOUNDS_PNG_FIXTURE, null],
    ['late-moov.mp4', LATE_MOOV_MP4_FIXTURE, 'video/mp4'],
    ['video.webm', WEBM_VIDEO_FIXTURE, 'video/webm'],
    ['audio-only.webm', WEBM_AUDIO_ONLY_FIXTURE, null],
    ['decoy-vide.mp4', MP4_WITHOUT_VIDEO_TRACK, null],
  ];
  for (const [name, bytes, expectedMediaType] of containerFixtures) {
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file, bytes);
    assert.equal(inspectMediaFile(file)?.mediaType || null, expectedMediaType, name);
  }

  const lanAttempt = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0', TEST_MODE: '1', DATA_DIR },
    encoding: 'utf8',
  });
  assert.notEqual(lanAttempt.status, 0);
  assert.match(`${lanAttempt.stdout}\n${lanAttempt.stderr}`, /ALLOW_INSECURE_LAN/);

  const repoDataAttempt = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TEST_MODE: '1', DATA_DIR: path.join(ROOT, 'public') },
    encoding: 'utf8',
  });
  assert.notEqual(repoDataAttempt.status, 0);
  assert.match(`${repoDataAttempt.stdout}\n${repoDataAttempt.stderr}`, /repo 外/);

  const repoLink = path.join(DATA_DIR, 'repo-link');
  fs.symlinkSync(path.join(ROOT, 'src'), repoLink, 'dir');
  const symlinkAttempt = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TEST_MODE: '1', DATA_DIR: repoLink },
    encoding: 'utf8',
  });
  assert.notEqual(symlinkAttempt.status, 0);
  assert.match(`${symlinkAttempt.stdout}\n${symlinkAttempt.stderr}`, /symlink/);

  const mutableRepoPaths = ['public', 'src', 'out', 'backups', 'runtime-data'];
  const before = Object.fromEntries(mutableRepoPaths.map((rel) => [rel, treeState(path.join(ROOT, rel))]));

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      TEST_MODE: '1',
      DATA_DIR,
      HEYGEN_API_KEY: '',
      MINIMAX_API_KEY: '',
      MINIMAX_GROUP_ID: '',
      OPENAI_API_KEY: '',
      SMOKE_GUARD_LOG: GUARD_LOG,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--require=${GUARD_MODULE}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = await waitForReady(child);
  assert.equal(ready.mode, 'test');
  assert.equal(ready.workerEnabled, false);
  const base = `http://127.0.0.1:${ready.port}`;

  const html = await request(base, '/');
  assert.match(html, /出片前台/);
  assert.match(html, /3・講者 Avatar/);
  assert.match(html, /4・圖片與 B-Roll 影片素材/);
  assert.match(html, /本版素材/);
  assert.match(html, /返回 V/);

  const health = await request(base, '/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'test');
  assert.equal(health.workerEnabled, false);

  const initial = await request(base, '/api/jobs');
  assert.deepEqual(initial.jobs, []);
  const initialProjects = await request(base, '/api/projects');
  assert.deepEqual(initialProjects.projects, []);

  const invalidBrand = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: 'default', brand: 'x; echo injected', body: '測試' }),
  });
  assert.equal(invalidBrand.status, 400);

  const abandoned = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-test',
      title: '會回收的草稿',
      body: '素材上傳失敗時不應留下空專案。',
    }),
  });
  const abandonedUpload = await fetch(base + `/api/jobs/${abandoned.job.id}/upload?name=shot1.png`, {
    method: 'POST',
    body: Buffer.from('not-a-real-image'),
  });
  assert.equal(abandonedUpload.status, 415);
  const abandonedAbort = await request(base, `/api/jobs/${abandoned.job.id}/abort`, { method: 'POST' });
  assert.equal(abandonedAbort.deletedProject, true);
  assert.equal((await fetch(base + `/api/jobs/${abandoned.job.id}`)).status, 404);
  assert.equal((await fetch(base + `/api/projects/${abandoned.job.projectId}`)).status, 404);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', abandoned.job.id)), false);

  const created = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-test',
      title: '啟動測試',
      body: '這是一筆不會呼叫外部影片服務的測試工作。',
      skipGenerate: true,
      noSpeed: true,
      autoApprove: false,
    }),
  });
  assert.equal(created.job.status, 'draft');
  assert.equal(created.job.revisionNumber, 1);
  assert.match(created.job.projectId, /^project-/);
  assert.equal(created.job.revisionId, 'v001');
  const id = created.job.id;

  const invalidUpload = await fetch(base + `/api/jobs/${id}/upload?name=not-allowed.txt`, {
    method: 'POST',
    body: Buffer.from('blocked'),
  });
  assert.equal(invalidUpload.status, 400);

  const disguisedImage = await fetch(base + `/api/jobs/${id}/upload?name=shot9.png`, {
    method: 'POST',
    body: Buffer.from('not-a-real-image'),
  });
  assert.equal(disguisedImage.status, 415);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', id, 'input', 'shot9.png')), false);
  const truncatedPng = await fetch(base + `/api/jobs/${id}/upload?name=shot7.png`, {
    method: 'POST',
    body: TRUNCATED_PNG_FIXTURE,
  });
  assert.equal(truncatedPng.status, 415);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', id, 'input', 'shot7.png')), false);
  const mismatchedImage = await fetch(base + `/api/jobs/${id}/upload?name=shot8.png`, {
    method: 'POST',
    body: MP4_FIXTURE,
  });
  assert.equal(mismatchedImage.status, 415);
  const avifVideo = await fetch(base + `/api/jobs/${id}/upload?name=broll9.mp4`, {
    method: 'POST',
    body: AVIF_DISGUISED_AS_MP4,
  });
  assert.equal(avifVideo.status, 415);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'jobs', id, 'input'))
    .some((name) => name.includes('.upload-')), false);

  await request(base, `/api/jobs/${id}/upload?name=heygen.mp4&originalName=presenter.mp4`, {
    method: 'POST',
    body: MP4_FIXTURE,
  });
  await request(base, `/api/jobs/${id}/upload?name=shot1.png&originalName=screen.png`, {
    method: 'POST',
    body: PNG_FIXTURE,
  });
  await request(base, `/api/jobs/${id}/upload?name=broll1.mp4&originalName=${encodeURIComponent('../B Roll.mp4')}`, {
    method: 'POST',
    body: MP4_FIXTURE,
  });
  const submitted = await request(base, `/api/jobs/${id}/submit`, { method: 'POST' });
  assert.equal(submitted.job.status, 'queued');

  const projectDetail = await request(base, `/api/projects/${created.job.projectId}`);
  assert.equal(projectDetail.project.revisions.length, 1);
  assert.equal(projectDetail.revision.id, 'v001');
  assert.equal(projectDetail.revision.script.body, '這是一筆不會呼叫外部影片服務的測試工作。');
  const reusableImage = projectDetail.project.assets.find((asset) => asset.kind === 'image');
  const reusableVideo = projectDetail.project.assets.find((asset) => asset.kind === 'video');
  const speakerVideo = projectDetail.project.assets.find((asset) => asset.kind === 'speaker-video');
  assert.ok(reusableImage);
  assert.ok(reusableVideo);
  assert.ok(speakerVideo);
  assert.notEqual(reusableVideo.id, speakerVideo.id);
  assert.equal(reusableVideo.originalName, 'B Roll.mp4');
  assert.equal(reusableVideo.mediaType, 'video/mp4');
  assert.equal(Object.hasOwn(reusableImage, 'path'), false);
  assert.equal(Object.hasOwn(reusableVideo, 'path'), false);

  const imageAsset = await fetch(base + `/api/projects/${created.job.projectId}/assets/${reusableImage.id}`);
  assert.equal(imageAsset.status, 200);
  assert.equal(imageAsset.headers.get('content-type'), 'image/png');

  const videoAssetUrl = `/api/projects/${created.job.projectId}/assets/${reusableVideo.id}`;
  const videoRange = await fetch(base + videoAssetUrl, { headers: { Range: 'bytes=0-7' } });
  assert.equal(videoRange.status, 206);
  assert.equal(videoRange.headers.get('content-type'), 'video/mp4');
  assert.equal(videoRange.headers.get('content-range'), `bytes 0-7/${MP4_FIXTURE.length}`);
  assert.deepEqual(Buffer.from(await videoRange.arrayBuffer()), MP4_FIXTURE.subarray(0, 8));
  const invalidRange = await fetch(base + videoAssetUrl, {
    headers: { Range: `bytes=${MP4_FIXTURE.length + 100}-` },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${MP4_FIXTURE.length}`);

  const speakerReuse = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseAssetIds: [speakerVideo.id],
      template: 'focusstock',
      title: '不應建立的版本',
      body: '講者影片不能當作 B-Roll。',
    }),
  });
  assert.equal(speakerReuse.status, 400);

  // 舊 manifest 可能來自只看副檔名的版本；重用時要重新驗內容，失敗也不能留下 V2。
  const storedProjectFile = path.join(DATA_DIR, 'projects', created.job.projectId, 'project.json');
  let storedProject = JSON.parse(fs.readFileSync(storedProjectFile, 'utf8'));
  const storedImage = storedProject.assets.find((asset) => asset.id === reusableImage.id);
  const storedImageFile = path.join(DATA_DIR, 'projects', created.job.projectId, storedImage.path);
  const storedImageBytes = fs.readFileSync(storedImageFile);
  const jobDirsBeforeCorruptReuse = fs.readdirSync(path.join(DATA_DIR, 'jobs')).sort();
  fs.writeFileSync(storedImageFile, 'corrupted-old-asset');
  const corruptReuse = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseAssetIds: [reusableImage.id],
      template: 'focusstock',
      title: '不應留下的 V2',
      body: '損毀素材應讓版本建立失敗。',
    }),
  });
  assert.equal(corruptReuse.status, 422);
  fs.writeFileSync(storedImageFile, storedImageBytes);
  const afterCorruptReuse = await request(base, `/api/projects/${created.job.projectId}`);
  assert.equal(afterCorruptReuse.project.latestRevision, 1);
  assert.equal(afterCorruptReuse.project.revisions.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'jobs')).sort(), jobDirsBeforeCorruptReuse);

  // V2 上傳到一半失敗／取消時，版本號與本次才新增的素材都要回收。
  const abandonedV2 = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseAssetIds: [reusableImage.id, reusableVideo.id],
      template: 'focusstock',
      title: '會回收的 V2',
      body: '這個版本只用來驗證 rollback。',
    }),
  });
  assert.equal(abandonedV2.job.revisionNumber, 2);
  const abandonedAssetUpload = await request(base,
    `/api/jobs/${abandonedV2.job.id}/upload?name=shot2.png&originalName=temporary.png`, {
      method: 'POST', body: ALT_PNG_FIXTURE,
    });
  const abandonedAssetId = abandonedAssetUpload.asset.id;
  storedProject = JSON.parse(fs.readFileSync(storedProjectFile, 'utf8'));
  const abandonedAsset = storedProject.assets.find((asset) => asset.id === abandonedAssetId);
  const abandonedAssetFile = path.join(DATA_DIR, 'projects', created.job.projectId, abandonedAsset.path);
  assert.equal(fs.existsSync(abandonedAssetFile), true);
  const abortedV2 = await request(base, `/api/jobs/${abandonedV2.job.id}/abort`, { method: 'POST' });
  assert.equal(abortedV2.deletedProject, false);
  assert.deepEqual(abortedV2.removedAssetIds, [abandonedAssetId]);
  assert.equal(fs.existsSync(abandonedAssetFile), false);
  const afterAbortV2 = await request(base, `/api/projects/${created.job.projectId}`);
  assert.equal(afterAbortV2.project.latestRevision, 1);
  assert.equal(afterAbortV2.project.revisions.length, 1);
  assert.equal(afterAbortV2.project.assets.some((asset) => asset.id === abandonedAssetId), false);
  assert.equal((await fetch(base + `/api/jobs/${abandonedV2.job.id}`)).status, 404);

  const iterated = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseAssetIds: [reusableImage.id, reusableVideo.id],
      template: 'focusstock',
      owner: 'smoke-test',
      title: '啟動測試 V2',
      body: '第二版沿用第一版素材。',
      skipGenerate: false,
    }),
  });
  assert.equal(iterated.job.revisionNumber, 2);
  assert.equal(iterated.job.revisionId, 'v002');
  assert.deepEqual(iterated.job.assetRefs, [reusableImage.id, reusableVideo.id]);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', iterated.job.id, 'input', 'shot1.png')), true);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', iterated.job.id, 'input', 'broll1.mp4')), true);
  await request(base, `/api/jobs/${iterated.job.id}/upload?name=shot2.png`, {
    method: 'POST',
    body: PNG_FIXTURE,
  });
  await request(base, `/api/jobs/${iterated.job.id}/submit`, { method: 'POST' });
  const iteratedProject = await request(base, `/api/projects/${created.job.projectId}`);
  assert.equal(iteratedProject.project.revisions.length, 2);
  assert.equal(iteratedProject.project.assets.filter((asset) => asset.kind === 'image').length, 1);
  assert.equal(iteratedProject.project.assets.filter((asset) => asset.kind === 'video').length, 1);
  assert.deepEqual(iteratedProject.revision.assetRefs, [reusableImage.id, reusableVideo.id]);
  const firstRevision = await request(base,
    `/api/projects/${created.job.projectId}?revision=${created.job.revisionId}`);
  assert.equal(firstRevision.revision.id, 'v001');
  assert.deepEqual(firstRevision.revision.assetRefs,
    [speakerVideo.id, reusableImage.id, reusableVideo.id]);
  const secondRevision = await request(base,
    `/api/projects/${created.job.projectId}?revision=${iterated.job.revisionId}`);
  assert.equal(secondRevision.revision.id, 'v002');
  assert.deepEqual(secondRevision.revision.assetRefs, [reusableImage.id, reusableVideo.id]);

  const repeatedSubmit = await fetch(base + `/api/jobs/${id}/submit`, { method: 'POST' });
  assert.equal(repeatedSubmit.status, 409);
  const lateUpload = await fetch(base + `/api/jobs/${id}/upload?name=heygen.mp4`, {
    method: 'POST',
    body: Buffer.from('blocked-after-submit'),
  });
  assert.equal(lateUpload.status, 409);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const queued = await request(base, `/api/jobs/${id}`);
  assert.equal(queued.job.status, 'queued');
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', id, 'job.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, '.run.lock')), false);
  fs.writeFileSync(path.join(DATA_DIR, '.run.lock'), String(Date.now()));
  const unsafeUnlock = await fetch(base + '/api/unlock', { method: 'POST' });
  assert.equal(unsafeUnlock.status, 409);
  assert.equal(fs.existsSync(path.join(DATA_DIR, '.run.lock')), true);

  for (const rel of mutableRepoPaths) {
    assert.equal(treeState(path.join(ROOT, rel)), before[rel], `${rel} 在 smoke 期間被改動`);
  }
  assert.equal(fs.existsSync(GUARD_LOG) ? fs.readFileSync(GUARD_LOG, 'utf8') : '', '');

  console.log('✅ localhost UI: HTTP 200');
  console.log('✅ /api/health: test mode, worker disabled');
  console.log('✅ fixture job: draft → queued，僅寫入臨時 DATA_DIR');
  console.log('✅ 同一 Project 建立 V1/V2，Revision 不複製成新專案');
  console.log('✅ Project 圖片與 B-Roll 可跨 Revision 重用，SHA-256 相同角色內容只保存一次');
  console.log('✅ B-Roll 與講者影片角色分離，影片預覽支援 Range／416');
  console.log('✅ PNG 逐 chunk 驗證邊界、IHDR／IDAT／IEND 與 CRC，截斷／偽裝結構被拒絕');
  console.log('✅ MP4/MOV/WebM 依 video track 驗證；late-moov 合法，純音訊與偽裝內容拒絕');
  console.log('✅ 非法 brand、upload 檔名與偽裝媒體內容被拒絕');
  console.log('✅ 上傳／重用失敗會回收草稿 Revision、新 Project 與本次新增素材');
  console.log('✅ submit 後不可重複排隊或覆寫 input');
  console.log('✅ 未知／活躍 lock 不可由 API 強制刪除');
  console.log('✅ LAN bind 未明確 opt-in 時拒絕啟動');
  console.log('✅ TEST_MODE 拒絕 repo 內路徑與 symlink 回指');
  console.log('✅ provider keys 為空、worker 停用，side-effect guard 未見 outbound/spawn 嘗試');
  console.log('✅ repo mutable workspace 前後一致');
}

main()
  .catch((error) => {
    console.error('❌ smoke test 失敗：' + error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
