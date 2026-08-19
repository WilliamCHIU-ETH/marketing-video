#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { capturePaidSpeakerAfterFailure } = require('../server/project-assets');
const { createProjectStore, inspectMediaFile } = require('../server/project-store');

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
function pngWithSingleIdat(data) {
  return Buffer.concat([
    PNG_FIXTURE.subarray(0, idatTypeOffset - 4),
    pngChunk('IDAT', data),
    PNG_FIXTURE.subarray(-12),
  ]);
}
const NON_INFLATABLE_PNG_FIXTURE = pngWithSingleIdat(Buffer.from('not-zlib'));
// 1x1 grayscale+alpha needs filter byte + two pixel bytes; filter method 5 is invalid.
const INVALID_FILTER_PNG_FIXTURE = pngWithSingleIdat(
  zlib.deflateSync(Buffer.from([5, 0, 0])));

const JPEG_FIXTURE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsj'
  + 'HBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo'
  + 'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECA'
  + 'wQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2Jygg'
  + 'kKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5i'
  + 'ZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEB'
  + 'AQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFE'
  + 'KRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6'
  + 'goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09'
  + 'fb3+Pn6/9oADAMBAAIRAxEAPwD6pooooA//2Q==',
  'base64');
const TEXT_DISGUISED_JPEG_FIXTURE = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x0a]),
  Buffer.from('not-jpeg', 'ascii'),
  Buffer.from([0xff, 0xd9]),
]);
const TRUNCATED_JPEG_FIXTURE = Buffer.from(JPEG_FIXTURE.subarray(0, -2));
const TRAILING_DATA_JPEG_FIXTURE = Buffer.concat([JPEG_FIXTURE, Buffer.from('trailing-data')]);
const OUT_OF_BOUNDS_JPEG_FIXTURE = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);
const ZERO_WIDTH_JPEG_FIXTURE = Buffer.from(JPEG_FIXTURE);
const sofTypeOffset = ZERO_WIDTH_JPEG_FIXTURE.indexOf(Buffer.from([0xff, 0xc0]));
assert.ok(sofTypeOffset >= 0);
ZERO_WIDTH_JPEG_FIXTURE.writeUInt16BE(0, sofTypeOffset + 7);

const MP4_FIXTURE = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAs1tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAQZYiEABX//vfJ78Cm69vfgQ==',
  'base64');
const FRAGMENTED_MP4_FIXTURE = Buffer.from(
  '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',
  'base64');
const FAKE_AVC1_MP4_FIXTURE = Buffer.from(
  'AAAAGGZ0eXBpc29tAAAAAGlzb21hdmMxAAABCm1vb3YAAAECdHJhawAAAPptZGlhAAAAIGhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAAAAAADSbWluZgAAAMpzdGJsAAAAZnN0c2QAAAAAAAAAAQAAAFZhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAAEAAAABAAAAFHN0Y28AAAAAAAAAAQAAASoAAAAJbWRhdAA=',
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

function isoBox(type, payload = Buffer.alloc(0)) {
  assert.equal(Buffer.byteLength(type, 'latin1'), 4);
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 'latin1');
  payload.copy(box, 8);
  return box;
}

const fixtureTopLevelBoxes = topLevelBoxes(MP4_FIXTURE);
const FIXTURE_FTYP = fixtureTopLevelBoxes.find((box) => box.type === 'ftyp').bytes;
const FIXTURE_MOOV = fixtureTopLevelBoxes.find((box) => box.type === 'moov').bytes;
const videoHandlerPayload = Buffer.alloc(12);
videoHandlerPayload.write('vide', 8, 'latin1');
const VIDEO_HANDLER_ONLY_MP4_FIXTURE = Buffer.concat([
  FIXTURE_FTYP,
  isoBox('moov', isoBox('trak', isoBox('mdia', isoBox('hdlr', videoHandlerPayload)))),
]);
const MP4_WITHOUT_MDAT_FIXTURE = Buffer.concat([FIXTURE_FTYP, FIXTURE_MOOV]);
const MOV_FIXTURE = Buffer.from(MP4_FIXTURE);
MOV_FIXTURE.write('qt  ', 8, 'latin1');
const OUTSIDE_MDAT_MP4_FIXTURE = Buffer.from(MP4_FIXTURE);
const outsideMdatStco = OUTSIDE_MDAT_MP4_FIXTURE.indexOf(Buffer.from('stco', 'latin1'));
assert.ok(outsideMdatStco >= 4);
OUTSIDE_MDAT_MP4_FIXTURE.writeUInt32BE(0, outsideMdatStco + 12);

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
const path = require('path');
const tls = require('tls');
const log = process.env.SMOKE_GUARD_LOG;
const originalExecFileSync = childProcess.execFileSync;
function blocked(kind) {
  return function () {
    fs.appendFileSync(log, kind + '\\n');
    throw new Error('smoke guard blocked ' + kind);
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = blocked('child_process.' + name);
}
const blockedExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, options) {
  const input = Array.isArray(args) ? args[args.length - 1] : null;
  let localProbe = false;
  try {
    const dataRoot = fs.realpathSync(process.env.DATA_DIR);
    const target = fs.realpathSync(input);
    localProbe = target.startsWith(dataRoot + path.sep);
  } catch (_) {}
  if (file === 'ffprobe' && Array.isArray(args) && args.includes('-count_frames') && localProbe)
    return originalExecFileSync(file, args, options);
  return blockedExecFileSync();
};
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

function startTestServer() {
  return spawn(process.execPath, ['server/index.js'], {
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
}

async function stopTestServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await exited;
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
    ['non-inflatable.png', NON_INFLATABLE_PNG_FIXTURE, null],
    ['invalid-filter.png', INVALID_FILTER_PNG_FIXTURE, null],
    ['valid.jpg', JPEG_FIXTURE, 'image/jpeg'],
    ['text-disguised.jpg', TEXT_DISGUISED_JPEG_FIXTURE, null],
    ['truncated.jpg', TRUNCATED_JPEG_FIXTURE, null],
    ['trailing-data.jpg', TRAILING_DATA_JPEG_FIXTURE, null],
    ['out-of-bounds.jpg', OUT_OF_BOUNDS_JPEG_FIXTURE, null],
    ['zero-width.jpg', ZERO_WIDTH_JPEG_FIXTURE, null],
    ['valid.mp4', MP4_FIXTURE, 'video/mp4'],
    ['valid.mov', MOV_FIXTURE, 'video/quicktime'],
    ['late-moov.mp4', LATE_MOOV_MP4_FIXTURE, 'video/mp4'],
    ['fragmented.mp4', FRAGMENTED_MP4_FIXTURE, 'video/mp4'],
    ['fake-avc1.mp4', FAKE_AVC1_MP4_FIXTURE, null],
    ['video-handler-only.mp4', VIDEO_HANDLER_ONLY_MP4_FIXTURE, null],
    ['missing-mdat.mp4', MP4_WITHOUT_MDAT_FIXTURE, null],
    ['sample-outside-mdat.mp4', OUTSIDE_MDAT_MP4_FIXTURE, null],
    ['video.webm', WEBM_VIDEO_FIXTURE, 'video/webm'],
    ['audio-only.webm', WEBM_AUDIO_ONLY_FIXTURE, null],
    ['decoy-vide.mp4', MP4_WITHOUT_VIDEO_TRACK, null],
  ];
  for (const [name, bytes, expectedMediaType] of containerFixtures) {
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file, bytes);
    assert.equal(inspectMediaFile(file)?.mediaType || null, expectedMediaType, name);
  }

  const rescueStore = createProjectStore({
    dataDir: path.join(DATA_DIR, 'speaker-rescue'),
    nowISO: () => '2026-08-19T00:00:00.000Z',
    idFactory: () => 'speaker-rescue-fixture',
  });
  const rescueProject = rescueStore.create({
    name: '付費講者影片救援測試', template: 'focusstock', owner: 'smoke-test',
  });
  const rescueRevision = rescueStore.addRevision(rescueProject.id, { jobId: 'speaker-rescue-job' });
  const rescueJob = {
    id: 'speaker-rescue-job',
    projectId: rescueProject.id,
    revisionId: rescueRevision.id,
    skipGenerate: false,
    assetRefs: [],
  };
  const paidSpeakerFile = path.join(DATA_DIR, 'paid-speaker.mp4');
  fs.writeFileSync(paidSpeakerFile, MP4_FIXTURE);
  const savedPaidSpeaker = capturePaidSpeakerAfterFailure({
    job: rescueJob,
    speakerFile: paidSpeakerFile,
    projectStore: rescueStore,
    saveJob: (job) => rescueStore.updateRevision(job.projectId, job.revisionId, {
      assetRefs: job.assetRefs,
    }),
    appendLog: () => {},
  });
  assert.equal(savedPaidSpeaker, true);
  const rescuedDetail = rescueStore.detail(rescueProject.id, rescueRevision.id);
  const rescuedSpeaker = rescuedDetail.project.assets.find((asset) => asset.kind === 'speaker-video');
  assert.ok(rescuedSpeaker);
  assert.equal(rescuedSpeaker.mediaType, 'video/mp4');
  assert.deepEqual(rescuedDetail.revision.assetRefs, [rescuedSpeaker.id]);

  const invalidSpeakerFile = path.join(DATA_DIR, 'invalid-paid-speaker.mp4');
  fs.writeFileSync(invalidSpeakerFile, 'not-a-video');
  let invalidCaptureResult;
  assert.doesNotThrow(() => {
    invalidCaptureResult = capturePaidSpeakerAfterFailure({
      job: { ...rescueJob, assetRefs: [...rescueJob.assetRefs] },
      speakerFile: invalidSpeakerFile,
      projectStore: rescueStore,
      saveJob: () => { throw new Error('invalid capture must not save'); },
      appendLog: () => {},
    });
  });
  assert.equal(invalidCaptureResult, false);
  let ingestThrowResult;
  assert.doesNotThrow(() => {
    ingestThrowResult = capturePaidSpeakerAfterFailure({
      job: { ...rescueJob, assetRefs: [...rescueJob.assetRefs] },
      speakerFile: paidSpeakerFile,
      projectStore: { ingestAsset: () => { throw new Error('fixture ingest failure'); } },
      saveJob: () => { throw new Error('ingest failure must not save'); },
      appendLog: () => {},
    });
  });
  assert.equal(ingestThrowResult, false);
  const skipGenerateResult = capturePaidSpeakerAfterFailure({
    job: { ...rescueJob, skipGenerate: true, assetRefs: [] },
    speakerFile: paidSpeakerFile,
    projectStore: { ingestAsset: () => { throw new Error('skip-generate must not ingest'); } },
    saveJob: () => { throw new Error('skip-generate must not save'); },
    appendLog: () => { throw new Error('skip-generate must not log'); },
  });
  assert.equal(skipGenerateResult, false);

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

  child = startTestServer();

  const ready = await waitForReady(child);
  assert.equal(ready.mode, 'test');
  assert.equal(ready.workerEnabled, false);
  let base = `http://127.0.0.1:${ready.port}`;

  const html = await request(base, '/');
  assert.match(html, /出片前台/);
  assert.match(html, /3・講者 Avatar/);
  assert.match(html, /4・圖片與 B-Roll 影片素材/);
  assert.match(html, /本版素材/);
  assert.match(html, /返回 V/);
  assert.match(html, /reuseSpeakerAssetId/);
  assert.match(html, /下載專案 Avatar/);

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

  const fragmentedDraft = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-test',
      title: 'fragmented MP4 驗證',
      body: '合法 fragmented B-Roll 不應被 container validator 誤拒。',
      skipGenerate: true,
    }),
  });
  await request(base, `/api/jobs/${fragmentedDraft.job.id}/upload?name=broll1.mp4`, {
    method: 'POST',
    body: FRAGMENTED_MP4_FIXTURE,
  });
  await request(base, `/api/jobs/${fragmentedDraft.job.id}/abort`, { method: 'POST' });

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
  const expectRejectedMediaUpload = async (name, body) => {
    const inputDir = path.join(DATA_DIR, 'jobs', id, 'input');
    const response = await fetch(base + `/api/jobs/${id}/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body,
    });
    // `fetch()` 已收到 response headers；此刻 temp 就必須不存在，不能依賴 eventual cleanup。
    const entriesAtResponse = fs.readdirSync(inputDir);
    assert.equal(response.status, 415, name);
    assert.equal(fs.existsSync(path.join(inputDir, name)), false, name);
    assert.equal(entriesAtResponse.some((entry) => entry.startsWith(`${name}.upload-`)), false, name);
    await response.text();
    assert.equal(fs.readdirSync(inputDir)
      .some((entry) => entry.startsWith(`${name}.upload-`)), false, name);
  };

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
  await expectRejectedMediaUpload('shot4.png', NON_INFLATABLE_PNG_FIXTURE);
  await expectRejectedMediaUpload('shot3.png', INVALID_FILTER_PNG_FIXTURE);
  const disguisedJpeg = await fetch(base + `/api/jobs/${id}/upload?name=shot6.jpg`, {
    method: 'POST',
    body: TEXT_DISGUISED_JPEG_FIXTURE,
  });
  assert.equal(disguisedJpeg.status, 415);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', id, 'input', 'shot6.jpg')), false);
  const truncatedJpeg = await fetch(base + `/api/jobs/${id}/upload?name=shot5.jpeg`, {
    method: 'POST',
    body: TRUNCATED_JPEG_FIXTURE,
  });
  assert.equal(truncatedJpeg.status, 415);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', id, 'input', 'shot5.jpeg')), false);
  const mismatchedImage = await fetch(base + `/api/jobs/${id}/upload?name=shot8.png`, {
    method: 'POST',
    body: MP4_FIXTURE,
  });
  assert.equal(mismatchedImage.status, 415);
  await expectRejectedMediaUpload('broll9.mp4', AVIF_DISGUISED_AS_MP4);
  await expectRejectedMediaUpload('broll8.mp4', VIDEO_HANDLER_ONLY_MP4_FIXTURE);
  await expectRejectedMediaUpload('broll7.mp4', MP4_WITHOUT_MDAT_FIXTURE);
  await expectRejectedMediaUpload('broll6.mp4', FAKE_AVC1_MP4_FIXTURE);
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

  const jobsBeforeReuseLimit = await request(base, '/api/jobs');
  const jobDirsBeforeReuseLimit = fs.readdirSync(path.join(DATA_DIR, 'jobs')).sort();
  const projectBeforeReuseLimit = await request(base, `/api/projects/${created.job.projectId}`);
  const overLimitReuse = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseAssetIds: Array.from({ length: 51 }, (_, index) => `asset-over-limit-${index}`),
      template: 'focusstock',
      title: '不應建立的素材超限版本',
      body: '超過五十個素材時，不能留下 Revision 或 Run。',
    }),
  });
  assert.equal(overLimitReuse.status, 400);
  assert.match((await overLimitReuse.json()).error, /50/);
  const projectAfterReuseLimit = await request(base, `/api/projects/${created.job.projectId}`);
  const jobsAfterReuseLimit = await request(base, '/api/jobs');
  assert.equal(projectAfterReuseLimit.project.latestRevision,
    projectBeforeReuseLimit.project.latestRevision);
  assert.equal(projectAfterReuseLimit.project.revisions.length,
    projectBeforeReuseLimit.project.revisions.length);
  assert.deepEqual(jobsAfterReuseLimit.jobs.map((job) => job.id),
    jobsBeforeReuseLimit.jobs.map((job) => job.id));
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'jobs')).sort(), jobDirsBeforeReuseLimit);

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

  const brollAsSpeaker = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseSpeakerAssetId: reusableVideo.id,
      template: 'focusstock',
      title: '不應建立的 Avatar 版本',
      body: 'B-Roll 不能當作講者 Avatar。',
    }),
  });
  assert.equal(brollAsSpeaker.status, 400);

  const speakerIteration = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      reuseSpeakerAssetId: speakerVideo.id,
      template: 'focusstock',
      title: '沿用專案 Avatar 的 V2',
      body: '沿用 Avatar 時不應再次呼叫付費生成。',
    }),
  });
  assert.equal(speakerIteration.job.revisionNumber, 2);
  assert.equal(speakerIteration.job.skipGenerate, true);
  assert.deepEqual(speakerIteration.job.assetRefs, [speakerVideo.id]);
  assert.deepEqual(
    fs.readFileSync(path.join(DATA_DIR, 'jobs', speakerIteration.job.id, 'input', 'heygen.mp4')),
    MP4_FIXTURE);
  await request(base, `/api/jobs/${speakerIteration.job.id}/abort`, { method: 'POST' });
  const afterSpeakerIterationAbort = await request(base, `/api/projects/${created.job.projectId}`);
  assert.equal(afterSpeakerIterationAbort.project.latestRevision, 1);
  assert.equal(afterSpeakerIterationAbort.project.revisions.length, 1);
  assert.ok(afterSpeakerIterationAbort.project.assets.some((asset) => asset.id === speakerVideo.id));

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

  const timestampState = ({ project, revision }) => ({
    project: project.updatedAt,
    revision: revision.updatedAt,
    summaries: project.revisions.map((item) => [item.id, item.updatedAt]),
  });
  const stableBeforeRestart = await request(base,
    `/api/projects/${created.job.projectId}?revision=${created.job.revisionId}`);
  const stableTimestamps = timestampState(stableBeforeRestart);
  const recoveryJob = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-recovery',
      title: '重啟恢復時間測試',
      body: '只有真正的 recovery 狀態變更可以更新 Project 時間。',
      skipGenerate: true,
    }),
  });

  await stopTestServer(child);
  const recoverySentinel = '2001-01-01T00:00:00.000Z';
  const recoveryJobFile = path.join(DATA_DIR, 'jobs', recoveryJob.job.id, 'job.json');
  const recoveryJobJson = JSON.parse(fs.readFileSync(recoveryJobFile, 'utf8'));
  recoveryJobJson.status = 'rendering';
  recoveryJobJson.pid = 0;
  fs.writeFileSync(recoveryJobFile, JSON.stringify(recoveryJobJson, null, 2));
  const recoveryProjectFile = path.join(DATA_DIR, 'projects', recoveryJob.job.projectId, 'project.json');
  const recoveryProjectJson = JSON.parse(fs.readFileSync(recoveryProjectFile, 'utf8'));
  recoveryProjectJson.updatedAt = recoverySentinel;
  recoveryProjectJson.revisions[0].status = 'rendering';
  recoveryProjectJson.revisions[0].updatedAt = recoverySentinel;
  fs.writeFileSync(recoveryProjectFile, JSON.stringify(recoveryProjectJson, null, 2));
  const recoveryRevisionFile = path.join(DATA_DIR, 'projects', recoveryJob.job.projectId,
    'revisions', `${recoveryJob.job.revisionId}.json`);
  const recoveryRevisionJson = JSON.parse(fs.readFileSync(recoveryRevisionFile, 'utf8'));
  recoveryRevisionJson.status = 'rendering';
  recoveryRevisionJson.updatedAt = recoverySentinel;
  fs.writeFileSync(recoveryRevisionFile, JSON.stringify(recoveryRevisionJson, null, 2));

  child = startTestServer();
  const restartReady = await waitForReady(child);
  base = `http://127.0.0.1:${restartReady.port}`;
  const stableAfterRestart = await request(base,
    `/api/projects/${created.job.projectId}?revision=${created.job.revisionId}`);
  assert.deepEqual(timestampState(stableAfterRestart), stableTimestamps);
  const recoveredJob = await request(base, `/api/jobs/${recoveryJob.job.id}`);
  const recoveredProject = await request(base,
    `/api/projects/${recoveryJob.job.projectId}?revision=${recoveryJob.job.revisionId}`);
  assert.equal(recoveredJob.job.status, 'failed');
  assert.equal(recoveredProject.revision.status, 'failed');
  assert.equal(recoveredProject.project.revisions[0].status, 'failed');
  assert.notEqual(recoveredProject.project.updatedAt, recoverySentinel);
  assert.equal(recoveredProject.project.updatedAt, recoveredProject.revision.updatedAt);
  const recoveredTimestamps = timestampState(recoveredProject);

  // Recovery 只發生一次；第二次一般 restart 不得再刷新 Project／Revision 時間。
  await stopTestServer(child);
  child = startTestServer();
  const secondRestartReady = await waitForReady(child);
  base = `http://127.0.0.1:${secondRestartReady.port}`;
  const stableAfterSecondRestart = await request(base,
    `/api/projects/${created.job.projectId}?revision=${created.job.revisionId}`);
  const recoveryAfterSecondRestart = await request(base,
    `/api/projects/${recoveryJob.job.projectId}?revision=${recoveryJob.job.revisionId}`);
  assert.deepEqual(timestampState(stableAfterSecondRestart), stableTimestamps);
  assert.deepEqual(timestampState(recoveryAfterSecondRestart), recoveredTimestamps);

  // 模擬 server 在 spawn 後、pid 持久化前關閉：job 只有 intent token，child 稍後才取得
  // lock 並留下 owner marker。先證明 intent 不會被誤當 ownership，再補 matching marker，
  // 驗證 Avatar 會在放行 shared workspace 前收入原 Project。
  const detachedRecovery = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-detached-recovery',
      title: '背景 Avatar 保存測試',
      body: '重啟後先保存付費 Avatar，再放行共用工作區。',
      skipGenerate: false,
    }),
  });
  await stopTestServer(child);
  const detachedPid = 2147483647;
  const detachedRunToken = '00000000-0000-4000-8000-000000000001';
  const detachedJobFile = path.join(DATA_DIR, 'jobs', detachedRecovery.job.id, 'job.json');
  const detachedJobJson = JSON.parse(fs.readFileSync(detachedJobFile, 'utf8'));
  detachedJobJson.status = 'preparing';
  detachedJobJson.pid = detachedPid;
  detachedJobJson.workspaceRunPid = detachedPid;
  detachedJobJson.workspaceRunStatus = 'preparing';
  detachedJobJson.workspaceRunStartedAt = new Date().toISOString();
  detachedJobJson.workspaceRunToken = detachedRunToken;
  fs.writeFileSync(detachedJobFile, JSON.stringify(detachedJobJson, null, 2));
  const detachedOwnerFile = path.join(DATA_DIR, '.run.owner.json');
  fs.writeFileSync(detachedOwnerFile, JSON.stringify({
    pid: detachedPid - 1,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    token: '00000000-0000-4000-8000-000000000002',
  }));
  const detachedWorkspacePublic = path.join(DATA_DIR, 'workspace', 'public');
  fs.mkdirSync(detachedWorkspacePublic, { recursive: true });
  fs.writeFileSync(path.join(detachedWorkspacePublic, 'heygen.mp4'), MP4_FIXTURE);

  child = startTestServer();
  const detachedRestartReady = await waitForReady(child);
  base = `http://127.0.0.1:${detachedRestartReady.port}`;
  const detachedCancel = await fetch(base + `/api/jobs/${detachedRecovery.job.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(detachedCancel.status, 400);
  await request(base, '/api/health');
  const unownedDetachedJob = await request(base, `/api/jobs/${detachedRecovery.job.id}`);
  const unownedDetachedProject = await request(base,
    `/api/projects/${detachedRecovery.job.projectId}?revision=${detachedRecovery.job.revisionId}`);
  assert.equal(unownedDetachedJob.job.status, 'detached');
  assert.equal(
    JSON.parse(fs.readFileSync(detachedJobFile, 'utf8')).detachedWorkspaceContested,
    undefined,
  );
  assert.equal(unownedDetachedProject.project.assets.some((asset) => asset.kind === 'speaker-video'), false);

  // Spawn token alone only keeps the recovery gate closed. Once run.js writes the matching owner
  // marker after atomic lock acquisition, the same live server can attach the child pid and recover.
  fs.writeFileSync(detachedOwnerFile, JSON.stringify({
    pid: detachedPid,
    startedAt: detachedJobJson.workspaceRunStartedAt,
    token: detachedRunToken,
  }));
  await request(base, '/api/health');
  const detachedRecoveredJob = await request(base, `/api/jobs/${detachedRecovery.job.id}`);
  const detachedRecoveredProject = await request(base,
    `/api/projects/${detachedRecovery.job.projectId}?revision=${detachedRecovery.job.revisionId}`);
  assert.equal(detachedRecoveredJob.job.status, 'detached-done');
  const detachedSpeakers = detachedRecoveredProject.project.assets
    .filter((asset) => asset.kind === 'speaker-video');
  assert.equal(detachedSpeakers.length, 1);
  assert.deepEqual(detachedRecoveredProject.revision.assetRefs, [detachedSpeakers[0].id]);
  const detachedSpeakerResponse = await fetch(base
    + `/api/projects/${detachedRecovery.job.projectId}/assets/${detachedSpeakers[0].id}`);
  assert.equal(detachedSpeakerResponse.status, 200);
  assert.deepEqual(Buffer.from(await detachedSpeakerResponse.arrayBuffer()), MP4_FIXTURE);
  assert.deepEqual(timestampState(await request(base,
    `/api/projects/${created.job.projectId}?revision=${created.job.revisionId}`)), stableTimestamps);

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
  console.log('✅ PNG 驗證 chunk／CRC 並 bounded inflate scanlines，損毀 payload／filter 被拒絕');
  console.log('✅ JPEG marker stream 驗證 SOF／SOS／entropy／EOI，偽裝、截斷與尾隨資料被拒絕');
  console.log('✅ MP4/MOV/WebM bounded probe 可解碼畫格；fragmented 合法，空殼／偽造被拒絕');
  console.log('✅ 超過 50 個沿用素材時不建立 Revision、Run 或 job 目錄');
  console.log('✅ 付費講者影片失敗救援寫回 Project／Revision；invalid／ingest error 維持 best-effort');
  console.log('✅ Project Avatar 以獨立 speaker ID 沿用，不混入 B-Roll，並強制跳過付費生成');
  console.log('✅ 非法 brand、upload 檔名與偽裝媒體內容被拒絕，415 前已清除 temp');
  console.log('✅ 上傳／重用失敗會回收草稿 Revision、新 Project 與本次新增素材');
  console.log('✅ submit 後不可重複排隊或覆寫 input');
  console.log('✅ 一般 restart 保留 Project 時間；真正 recovery 只同步一次狀態與時間');
  console.log('✅ detached 不可取消；spawn intent 不誤收，owner token 相符才保存 Avatar 並放行');
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
