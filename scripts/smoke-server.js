#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
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
const AUXILIARY_CHILDREN = new Set();

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
  'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC7W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHvdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABi21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAMgAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAATZtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAD2c3RibAAAAKpzdHNkAAAAAAAAAAEAAACaYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADRhdmNDAWQACv/hABdnZAAKrNlewEQAAAMABAAAAwDIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAE4bW9vZgAAABBtZmhkAAAAAAAAAAEAAAEgdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADEQAAAgAAAALFAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAA4HRydW4AAAoFAAAAGQAAAUACAAAAAAACxQAABAAAAAAMAAAKAAAAAAwAAAQAAAAADAAAAAAAAAAMAAACAAAAABIAAAoAAAAADgAABAAAAAAMAAAAAAAAAAwAAAIAAAAAEgAACgAAAAAOAAAEAAAAAAwAAAAAAAAADAAAAgAAAAASAAAKAAAAAA4AAAQAAAAADAAAAAAAAAAMAAACAAAAABIAAAoAAAAADgAABAAAAAAMAAAAAAAAAAwAAAIAAAAAEgAACgAAAAAOAAAEAAAAAAwAAAAAAAAADAAAAgAAAAQVbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA9liIQAO//+906/AptUwmEAAAAIQZokbEO//uAAAAAIQZ5CeIX/wYEAAAAIAZ5hdEK/xIAAAAAIAZ5jakK/xIEAAAAOQZpoSahBaJlMCHf//uEAAAAKQZ6GRREsL//BgQAAAAgBnqV0Qr/EgQAAAAgBnqdqQr/EgAAAAA5BmqxJqEFsmUwId//+4AAAAApBnspFFSwv/8GBAAAACAGe6XRCv8SAAAAACAGe62pCv8SAAAAADkGa8EmoQWyZTAhv//7hAAAACkGfDkUVLC//wYEAAAAIAZ8tdEK/xIEAAAAIAZ8vakK/xIAAAAAOQZs0SahBbJlMCGf//uAAAAAKQZ9SRRUsL//BgQAAAAgBn3F0Qr/EgAAAAAgBn3NqQr/EgAAAAA5Bm3hJqEFsmUwIV//+wQAAAApBn5ZFFSwv/8GAAAAACAGftXRCv8SBAAAACAGft2pCv8SBAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAEAAAAAAAAAAMRAQEBAAAAEG1mcm8AAAAAAAAAQw==',
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
const originalSpawn = childProcess.spawn;
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
const blockedSpawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  try {
    const dataRoot = fs.realpathSync(process.env.DATA_DIR);
    const fixture = fs.realpathSync(process.env.TEST_PIPELINE_ENTRY || '');
    const preload = fs.realpathSync(Array.isArray(args) ? args[1] : '');
    if (file === process.execPath && Array.isArray(args) && args[0] === '--require'
        && fs.realpathSync(args[2]) === fixture
        && fixture.startsWith(dataRoot + path.sep)
        && preload.startsWith(path.join(dataRoot, 'jobs') + path.sep))
      return originalSpawn(file, args, options);
  } catch (_) {}
  return blockedSpawn(file, args, options);
};
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
  if (file === 'ps' && Array.isArray(args) && args.length === 4
      && args[0] === '-p' && /^\\d+$/.test(String(args[1]))
      && args[2] === '-o' && ['command=', 'lstart='].includes(args[3]))
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

function startTestServer(extraEnv = {}) {
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
      ...extraEnv,
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

async function waitForJobStatus(base, id, expected, timeoutMs = 10000) {
  const wanted = new Set(Array.isArray(expected) ? expected : [expected]);
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await request(base, `/api/jobs/${id}`);
    if (wanted.has(latest.job.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 ${id} 進入 ${[...wanted].join('/')} 逾時；最後狀態 ${latest?.job?.status}`
    + (latest?.job?.error ? `；${latest.job.error}` : ''));
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
  assert.match(html, /4・B-Roll/);
  assert.match(html, /自動生成圖卡/);
  assert.match(html, /Render 前先暫停/);
  assert.match(html, /Automation stage/);
  assert.match(html, /停止工作/);
  assert.match(html, /從.*階段重試/);
  assert.match(html, /本版輸入與沿用內容/);
  assert.match(html, /版本脈絡與時間/);
  assert.match(html, /說明版本時間的定義/);
  assert.match(html, /popovertarget/);
  assert.match(html, /showPopover/);
  assert.match(html, /revision-time-help-fallback/);
  assert.match(html, /匯入紀錄・時間語意未保存/);
  assert.match(html, /原始指派、生成與匯入時點沒有分別保存，無法回推/);
  assert.match(html, /送出後不暫停，素材準備完成就直接出片/);
  assert.match(html, /本版系統生成的 B-roll/);
  assert.match(html, /成片實際畫面/);
  assert.match(html, /段落總覽/);
  assert.match(html, /Prompt 檢視器/);
  assert.match(html, /一次查看全部 Prompt/);
  assert.match(html, /broll-review-layout/);
  assert.match(html, /broll-prompt-missing/);
  assert.match(html, /prompt\.recorded \? prompt\.text : '缺失'/);
  assert.doesNotMatch(html, /Prompt 缺失/);
  assert.match(html, /const startSec = Math\.max\(0, placement\.startSec\)/);
  assert.doesNotMatch(html, /placement\.startSec - 0\.3/);
  assert.match(html, /graphic B-roll 不是獨立 MP4/);
  assert.match(html, /尚無可驗證成片畫面/);
  assert.match(html, /專案素材庫/);
  assert.match(html, /網頁預覽/);
  assert.match(html, /是否實際出現在成片/);
  assert.match(html, /Revision 仍保留素材引用/);
  assert.match(html, /成品已保存於這台 Mac/);
  assert.match(html, /技術資訊與執行記錄/);
  assert.match(html, /素材資料暫時無法載入/);
  assert.match(html, /已完成手機畫面 placement/);
  assert.match(html, /source／plan／render linkage/);
  assert.match(html, /compositionStartSec/);
  assert.match(html, /（主段 /);
  assert.match(html, /暫存工作/);
  assert.match(html, /跨影片專案/);
  assert.doesNotMatch(html, /也存進成品庫了/);
  assert.match(html, /返回 V/);
  assert.match(html, /reuseSpeakerAssetId/);
  assert.match(html, /下載專案 Avatar/);
  assert.match(html, /<button data-v="list" class="on">影片專案<\/button>/);
  assert.match(html, /<section id="v-list">/);
  assert.match(html, /collapsible-card/);
  assert.match(html, /output-list/);

  const outputSectionStart = html.indexOf("} else if (job.status === 'done' && job.outputs)");
  const outputSectionEnd = html.indexOf('\n  const canCancel =', outputSectionStart);
  assert.ok(outputSectionStart > 0 && outputSectionEnd > outputSectionStart,
    '必須能獨立檢查完成版成品輸出 UI');
  assert.match(html.slice(outputSectionStart, outputSectionEnd),
    /if \(!hasBrollEvidencePreview\(job\)\)/,
    '只有沒有 B-roll evidence player 的完成版才顯示 fallback 成片播放器');
  assert.match(html.slice(outputSectionStart, outputSectionEnd), /el\('video'/,
    'manual-assets 與 legacy 完成版必須保留頁內成片播放器');

  const inlineScript = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(inlineScript, '前台必須保留可解析的 inline script');
  assert.doesNotThrow(() => new Function(inlineScript[1]));
  const previewGateStart = html.indexOf('function verifiedGraphicPreviewOutput(job)');
  const previewGateEnd = html.indexOf('\nfunction revisionTimeHelp()', previewGateStart);
  assert.ok(previewGateStart > 0 && previewGateEnd > previewGateStart,
    '必須能獨立驗證 graphic B-roll 成片預覽 evidence gate');
  const previewGates = new Function(
    `${html.slice(previewGateStart, previewGateEnd)}\nreturn {verifiedGraphicPreviewOutput, recordedCompositionPreviewOutput, hasBrollEvidencePreview};`)();
  const {
    verifiedGraphicPreviewOutput, recordedCompositionPreviewOutput, hasBrollEvidencePreview,
  } = previewGates;
  const previewFixture = {
    status: 'done', pruned: false, workflowMode: 'auto-broll',
    graphicBroll: {
      schemaVersion: 1, mode: 'card-v1', planSha256: 'a'.repeat(64),
      cards: [{ resolvedPlacement: { startSec: 1, endSec: 2 } }],
    },
    renderInputManifestSha256: 'b'.repeat(64),
    renderInputManifest: {
      schemaVersion: 1,
      options: { workflowMode: 'auto-broll', graphicBrollMode: 'card-v1' },
      artifactInputs: [{ path: 'src/graphic-broll.generated.json', sha256: 'a'.repeat(64) }],
    },
    outputs: [{ name: 'output.mp4', size: 123, sha256: 'c'.repeat(64) }],
    renderEvidence: {
      schemaVersion: 1, renderInputManifestSha256: 'b'.repeat(64),
      outputs: [{ name: 'output.mp4', size: 123, sha256: 'c'.repeat(64) }],
    },
  };
  const previewFixtureBefore = JSON.stringify(previewFixture);
  assert.equal(verifiedGraphicPreviewOutput(previewFixture), previewFixture.outputs[0]);
  assert.equal(hasBrollEvidencePreview(previewFixture), true,
    '已有 verified B-roll player 時不得再顯示 output fallback player');
  assert.equal(JSON.stringify(previewFixture), previewFixtureBefore, '預覽 evidence gate 必須唯讀');
  for (const mutate of [
    (fixture) => { fixture.status = 'review'; },
    (fixture) => { fixture.pruned = true; },
    (fixture) => { fixture.workflowMode = 'manual-assets'; },
    (fixture) => { fixture.renderInputManifest.artifactInputs[0].sha256 = 'wrong-plan'; },
    (fixture) => {
      delete fixture.graphicBroll.planSha256;
      delete fixture.renderInputManifest.artifactInputs[0].sha256;
    },
    (fixture) => { fixture.renderInputManifestSha256 = 'not-a-sha256'; },
    (fixture) => { fixture.renderEvidence.renderInputManifestSha256 = 'wrong-manifest'; },
    (fixture) => { fixture.outputs[0].size = 0; fixture.renderEvidence.outputs[0].size = 0; },
    (fixture) => {
      fixture.outputs[0].sha256 = 'invalid';
      fixture.renderEvidence.outputs[0].sha256 = 'invalid';
    },
    (fixture) => { fixture.renderEvidence.outputs[0].size = 999; },
    (fixture) => { fixture.outputs = []; },
  ]) {
    const fixture = JSON.parse(JSON.stringify(previewFixture));
    mutate(fixture);
    assert.equal(verifiedGraphicPreviewOutput(fixture), null,
      '不完整或不相符的 evidence 不得顯示成片實際畫面');
  }

  const recordedFixture = {
    status: 'done', pruned: false, projectId: 'project-1', revisionId: 'v001',
    renderInputManifestSha256: 'e'.repeat(64),
    graphicBroll: {
      schemaVersion: 1, mode: 'composition-v1',
      sourceScriptSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64),
      cards: [{
        id: 'broll-01', assetRef: 'asset-video-1', assetSha256: 'c'.repeat(64),
        resolvedPlacement: { startSec: 1, endSec: 2 },
      }],
      provenance: {
        level: 'reconstructed-after-render',
        output: { name: 'output.mp4', size: 123, sha256: 'd'.repeat(64) },
      },
    },
    timelinePlacements: [{
      clipId: 'broll-01', assetRef: 'asset-video-1', assetSha256: 'c'.repeat(64),
      startSec: 1, endSec: 2, evidenceLevel: 'reconstructed-after-render',
    }],
    outputs: [{ name: 'output.mp4', size: 123, sha256: 'd'.repeat(64) }],
    renderEvidence: {
      outputs: [{ name: 'output.mp4', size: 123, sha256: 'd'.repeat(64) }],
    },
    recordedCompositionEvidence: {
      status: 'verified', projectId: 'project-1', revisionId: 'v001',
      renderInputManifestSha256: 'e'.repeat(64), cardIds: ['broll-01'],
      output: { name: 'output.mp4', size: 123, sha256: 'd'.repeat(64) },
    },
  };
  const recordedFixtureBefore = JSON.stringify(recordedFixture);
  assert.equal(recordedCompositionPreviewOutput(recordedFixture), recordedFixture.outputs[0]);
  assert.equal(hasBrollEvidencePreview(recordedFixture), true,
    '已有 recorded placement player 時不得再顯示 output fallback player');
  assert.equal(JSON.stringify(recordedFixture), recordedFixtureBefore,
    'placement evidence gate 必須唯讀');
  for (const mutate of [
    (fixture) => { fixture.graphicBroll.provenance.level = 'project-asset-only'; },
    (fixture) => { fixture.timelinePlacements = []; },
    (fixture) => { fixture.timelinePlacements[0].assetRef = 'other-asset'; },
    (fixture) => { fixture.timelinePlacements[0].evidenceLevel = 'selected-only'; },
    (fixture) => { fixture.graphicBroll.cards[0].assetSha256 = 'invalid'; },
    (fixture) => { fixture.renderEvidence.outputs[0].size = 999; },
    (fixture) => { fixture.recordedCompositionEvidence = null; },
    (fixture) => { fixture.recordedCompositionEvidence.projectId = 'other-project'; },
  ]) {
    const fixture = JSON.parse(JSON.stringify(recordedFixture));
    mutate(fixture);
    assert.equal(recordedCompositionPreviewOutput(fixture), null,
      '不完整的 Project Asset／placement／Render linkage 不得顯示成片片段');
  }
  assert.equal(hasBrollEvidencePreview({
    status: 'done', workflowMode: 'manual-assets',
    outputs: [{ name: 'output.mp4', size: 123, sha256: 'e'.repeat(64) }],
  }), false, 'manual-assets 完成版沒有 B-roll evidence player，必須使用 output fallback player');

  const preparedGateStart = html.indexOf('function verifiedPreparedPhoneTimelineEvidence(job)');
  const preparedGateEnd = html.indexOf('\nfunction preparedPhoneEvidenceCard(job)', preparedGateStart);
  assert.ok(preparedGateStart > 0 && preparedGateEnd > preparedGateStart,
    '必須能獨立驗證 ready-to-place timeline/render evidence gate');
  const verifiedPreparedPhoneTimelineEvidence = new Function(
    `${html.slice(preparedGateStart, preparedGateEnd)}\nreturn verifiedPreparedPhoneTimelineEvidence;`)();
  const preparedFixture = {
    materialAcquisition: {
      policy: 'require-capture', operation: 'prepared-video', route: 'chipk.stock.main-force',
      stock: { id: '3441', name: '聯一光' },
      presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
      placement: { layoutId: 'focusstock-phone-portrait.v1', anchor: { startCharIdx: 3 } },
    },
    materialAcquisitionResult: {
      status: 'acquired', contractVersion: 2, provider: 'chipk-simulator-capture',
      providerVersion: '0.3.0', placementStatus: 'compiled', automaticTimelineUse: true,
      presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
      compiledPlanSha256: 'd'.repeat(64),
      preparedArtifact: {
        role: 'prepared-video', assetRef: 'asset-prepared', sha256: 'c'.repeat(64),
        size: 123, media: { durationSeconds: 1 },
      },
      placement: {
        layoutId: 'focusstock-phone-portrait.v1', fps: 30,
        startFrame: 60, endFrame: 90, durationInFrames: 30, startSec: 2, endSec: 3,
        playbackRate: 1, muted: true, objectFit: 'contain', crop: 'none', trim: 'none', loop: false,
      },
    },
    timelinePlacements: [{
      kind: 'prepared-phone-video', assetRef: 'asset-prepared',
      profileId: 'chipk.stock-main-force-portrait.v1',
      layoutId: 'focusstock-phone-portrait.v1', timelineBasis: 'focusstock-main-v1',
      visualOwner: 'prepared-phone-video',
      conflictPolicy: 'suppress-entire-overlapping-placement',
      fps: 30, startFrame: 60, endFrame: 90, durationInFrames: 30, startSec: 2, endSec: 3,
      compositionTimeline: 'Focusstock', compositionOffsetFrames: 30,
      compositionStartFrame: 90, compositionEndFrame: 120,
      compositionStartSec: 3, compositionEndSec: 4,
      sourceSha256: 'c'.repeat(64), planSha256: 'd'.repeat(64),
    }],
    renderInputManifestSha256: 'e'.repeat(64),
    renderInputManifest: {
      schemaVersion: 1, template: 'focusstock', compositionId: 'Focusstock',
      options: { preparedPhoneMode: 'ready-to-place', withAd: false },
      artifactInputs: [
        { path: 'public/prepared-phone-material.mp4', size: 123, sha256: 'c'.repeat(64) },
        { path: 'src/Focusstock/prepared-phone-material.generated.json', size: 456, sha256: 'd'.repeat(64) },
      ],
    },
    renderEvidence: { schemaVersion: 1, renderInputManifestSha256: 'e'.repeat(64) },
  };
  const preparedFixtureBefore = JSON.stringify(preparedFixture);
  const preparedEvidence = verifiedPreparedPhoneTimelineEvidence(preparedFixture);
  assert.equal(preparedEvidence.renderVerified, true);
  assert.equal(preparedEvidence.placement.compositionStartSec, 3);
  assert.equal(JSON.stringify(preparedFixture), preparedFixtureBefore,
    'ready-to-place evidence gate 必須唯讀');
  for (const mutate of [
    (fixture) => { fixture.materialAcquisitionResult.placementStatus = 'compiled_pending_evidence'; },
    (fixture) => { fixture.materialAcquisitionResult.automaticTimelineUse = false; },
    (fixture) => { fixture.timelinePlacements[0].durationInFrames = 1; },
    (fixture) => { fixture.timelinePlacements[0].compositionStartFrame = 60; },
    (fixture) => { fixture.timelinePlacements[0].sourceSha256 = 'f'.repeat(64); },
    (fixture) => { fixture.timelinePlacements[0].planSha256 = 'f'.repeat(64); },
    (fixture) => { fixture.renderInputManifest.options.withAd = true; },
    (fixture) => { fixture.renderInputManifest.artifactInputs[0].sha256 = 'f'.repeat(64); },
    (fixture) => { fixture.renderInputManifestSha256 = 'invalid'; },
    (fixture) => { fixture.timelinePlacements.push({ ...fixture.timelinePlacements[0] }); },
  ]) {
    const fixture = JSON.parse(JSON.stringify(preparedFixture));
    mutate(fixture);
    assert.equal(verifiedPreparedPhoneTimelineEvidence(fixture), null,
      '不完整或不相符的 prepared evidence 不得宣稱已配置 timeline');
  }

  const invalidWorkflow = await fetch(base + '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'default', title: 'invalid workflow', body: 'invalid workflow',
      workflowMode: 'provider-magic',
    }),
  });
  assert.equal(invalidWorkflow.status, 400);
  const invalidAutoTemplate = await fetch(base + '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'dapan', title: 'invalid auto template', body: 'invalid auto template',
      workflowMode: 'auto-broll', controlPolicy: 'auto',
    }),
  });
  assert.equal(invalidAutoTemplate.status, 400);
  const invalidPreparedWithAd = await fetch(base + '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock', title: 'invalid prepared ad', body: 'prepared ad must fail closed',
      withAd: true,
      materialAcquisition: {
        policy: 'require-capture', operation: 'prepared-video', mode: 'test',
        route: 'chipk.stock.main-force', stock: { id: '3441', name: '聯一光' },
        presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
        placement: { layoutId: 'focusstock-phone-portrait.v1', startSec: 2 },
      },
    }),
  });
  assert.equal(invalidPreparedWithAd.status, 400);
  assert.match((await invalidPreparedWithAd.json()).error, /不支援 Focusstock 廣告版/);

  const preparedPhraseDraft = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock', withAd: false, title: '聯一光主力觀察',
      body: '今天看聯一光的主力動向，接著說明籌碼變化。',
      workflowMode: 'manual-assets', controlPolicy: 'auto',
      materialAcquisition: {
        policy: 'require-capture', operation: 'prepared-video', mode: 'test',
        route: 'chipk.stock.main-force', stock: { id: '3441', name: '聯一光' },
        presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
        placement: {
          layoutId: 'focusstock-phone-portrait.v1', anchor: { phrase: '聯一光的主力動向' },
        },
      },
    }),
  });
  assert.equal(preparedPhraseDraft.job.status, 'draft');
  assert.equal(preparedPhraseDraft.job.materialAcquisition.placement.anchor.phrase,
    '聯一光的主力動向');
  assert.equal(preparedPhraseDraft.job.materialAcquisition.placement.anchor.startCharIdx, 3);
  const preparedShotUpload = await fetch(
    base + `/api/jobs/${preparedPhraseDraft.job.id}/upload?name=shot1.png`, {
      method: 'POST', body: PNG_FIXTURE,
    });
  assert.equal(preparedShotUpload.status, 409);
  assert.match((await preparedShotUpload.json()).error, /不可再混入/);
  await request(base, `/api/jobs/${preparedPhraseDraft.job.id}/abort`, { method: 'POST' });

  const ambiguousPreparedPhrase = await fetch(base + '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock', title: '重複 anchor', body: '主力動向，稍後再看主力動向。',
      materialAcquisition: {
        policy: 'require-capture', operation: 'prepared-video', mode: 'test',
        route: 'chipk.stock.main-force', stock: { id: '3441', name: '聯一光' },
        presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
        placement: {
          layoutId: 'focusstock-phone-portrait.v1', anchor: { phrase: '主力動向' },
        },
      },
    }),
  });
  assert.equal(ambiguousPreparedPhrase.status, 400);
  assert.match((await ambiguousPreparedPhrase.json()).error, /ambiguous/);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const renderDoneBlock = serverSource.match(
    /transitionJobSafely\(job, \{[\s\S]{0,400}status: 'done',[\s\S]{0,700}\}\);/);
  assert.ok(renderDoneBlock, 'render 完成狀態必須以 durable transition 保存，再交給 cleanup');
  assert.doesNotMatch(renderDoneBlock[0],
    /rmrf\(path\.join\(jobDir\(job\.id\), 'state'\)\);/);
  assert.match(serverSource,
    /\.finally\(\(\) => \{[\s\S]{0,200}pruneOldJobsNonFatal\('工作結束'\);/);
  assert.match(serverSource,
    /spawn\(process\.execPath, \['--require', evidenceFiles\.preload, pipelineEntry/,
    'run.js 必須在同一個 process 內載入 durable completion evidence hook');
  assert.match(serverSource,
    /evidence = await runPipeline\(job, args\);[\s\S]{0,1800}finalizeRenderOutputs\(job, evidence\)/,
    '正常 render 必須與 detached recovery 共用 output finalizer');
  assert.match(serverSource,
    /function writeJobRecord\(j\) \{[\s\S]{0,160}atomicWriteFile\(jobFile\(j\.id\)/,
    'job.json 必須透過 atomic temp + rename 寫入');
  const preloadSource = serverSource.match(
    /const PIPELINE_EVIDENCE_PRELOAD = String\.raw`([\s\S]+?)`;\n\nfunction preparePipelineEvidence/);
  assert.ok(preloadSource, '找不到 pipeline completion evidence preload source');
  const preloadHarnessDir = path.join(DATA_DIR, 'preload-harness');
  fs.mkdirSync(preloadHarnessDir, { recursive: true });
  const preloadHarness = path.join(preloadHarnessDir, 'evidence.preload.cjs');
  const preloadConfig = path.join(preloadHarnessDir, 'evidence.config.json');
  const preloadResult = path.join(preloadHarnessDir, 'evidence.result.json');
  const preloadOwner = path.join(preloadHarnessDir, 'owner.json');
  const preloadOutput = path.join(preloadHarnessDir, 'output.mp4');
  const preloadToken = '00000000-0000-4000-8000-000000000009';
  fs.writeFileSync(preloadHarness, preloadSource[1]);
  fs.writeFileSync(preloadConfig, JSON.stringify({
    schemaVersion: 1,
    jobId: 'preload-harness-job',
    projectId: 'preload-harness-project',
    revisionId: 'v001',
    workspaceRunToken: preloadToken,
    runStatus: 'rendering',
    startedAt: '2001-01-01T00:00:00.000Z',
    ownerFile: preloadOwner,
    resultFile: preloadResult,
    outputs: [{ relativePath: 'out/output.mp4', file: preloadOutput }],
  }));
  const preloadAttempt = spawnSync(process.execPath, ['--require', preloadHarness, '-e', [
    "const fs = require('fs')",
    "fs.writeFileSync(process.env.SMOKE_PRELOAD_OUTPUT, Buffer.from('fresh-render-output'))",
    'fs.writeFileSync(process.env.SMOKE_PRELOAD_OWNER, JSON.stringify({',
    '  pid: process.pid,',
    "  startedAt: '2001-01-01T00:00:00.000Z',",
    '  token: process.env.SMOKE_PRELOAD_TOKEN,',
    '}))',
  ].join('\n')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKSPACE_EVIDENCE_CONFIG: preloadConfig,
      SMOKE_PRELOAD_OUTPUT: preloadOutput,
      SMOKE_PRELOAD_OWNER: preloadOwner,
      SMOKE_PRELOAD_TOKEN: preloadToken,
    },
    encoding: 'utf8',
  });
  assert.equal(preloadAttempt.status, 0, preloadAttempt.stderr);
  const preloadEvidence = JSON.parse(fs.readFileSync(preloadResult, 'utf8'));
  assert.equal(preloadEvidence.exitCode, 0);
  assert.equal(preloadEvidence.owner.token, preloadToken);
  assert.equal(preloadEvidence.outputs[0].changedFromBefore, true);
  assert.equal(preloadEvidence.outputs[0].after.sha256,
    crypto.createHash('sha256').update('fresh-render-output').digest('hex'));

  const health = await request(base, '/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'test');
  assert.equal(health.workerEnabled, false);

  const initial = await request(base, '/api/jobs');
  assert.deepEqual(initial.jobs, []);
  const initialProjects = await request(base, '/api/projects');
  assert.deepEqual(initialProjects.projects, []);

  const autoDraft = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'default', owner: 'smoke-auto-broll', title: '晨報自動圖卡',
      body: '今天市場聚焦成交量與主要族群輪動。', workflowMode: 'auto-broll',
      controlPolicy: 'auto',
    }),
  });
  assert.equal(autoDraft.job.workflowMode, 'auto-broll');
  assert.equal(autoDraft.job.controlPolicy, 'auto');
  assert.equal(autoDraft.job.skipGenerate, true);
  assert.equal(autoDraft.job.autoApprove, true);
  const autoManualUpload = await fetch(base + `/api/jobs/${autoDraft.job.id}/upload?name=shot1.png`, {
    method: 'POST', body: PNG_FIXTURE,
  });
  assert.equal(autoManualUpload.status, 409);
  const autoSubmitWithoutAvatar = await fetch(base + `/api/jobs/${autoDraft.job.id}/submit`, {
    method: 'POST',
  });
  assert.equal(autoSubmitWithoutAvatar.status, 400);
  await request(base, `/api/jobs/${autoDraft.job.id}/upload?name=heygen.mp4`, {
    method: 'POST', body: MP4_FIXTURE,
  });
  const autoSubmitted = await request(base, `/api/jobs/${autoDraft.job.id}/submit`, { method: 'POST' });
  assert.equal(autoSubmitted.job.status, 'queued');
  assert.equal(autoSubmitted.job.stage, 'queued');
  assert.ok(autoSubmitted.job.submittedAt);
  const autoProject = await request(base,
    `/api/projects/${autoDraft.job.projectId}?revision=${autoDraft.job.revisionId}`);
  assert.equal(autoProject.revision.options.graphicBrollMode, 'card-v1');
  assert.equal(autoProject.revision.submittedAt, autoSubmitted.job.submittedAt);
  assert.equal(autoProject.revisionSummaries.length, 1);
  assert.equal(autoProject.revisionSummaries[0].workflowMode, 'auto-broll');
  assert.equal(autoProject.revisionSummaries[0].source.kind, 'run');
  assert.equal(autoProject.revisionSummaries[0].source.parentRevisionId, null);
  assert.equal(autoProject.revisionSummaries[0].submittedAt, autoSubmitted.job.submittedAt);
  assert.equal(autoProject.project.assets.filter((asset) => asset.kind === 'speaker-video').length, 1);
  assert.equal(autoProject.project.assets.some((asset) => ['image', 'video'].includes(asset.kind)), false);
  const compactProjects = await request(base, '/api/projects');
  const compactAutoProject = compactProjects.projects.find((item) => item.id === autoDraft.job.projectId);
  assert.equal(Object.hasOwn(compactAutoProject, 'revisionSummaries'), false);

  // Legacy migration metadata is useful for time semantics, but local manifest paths must never
  // escape through the public read model. Restore the fixture before lifecycle tests continue.
  const autoRevisionFile = path.join(DATA_DIR, 'projects', autoDraft.job.projectId,
    'revisions', `${autoDraft.job.revisionId}.json`);
  const autoProjectFile = path.join(DATA_DIR, 'projects', autoDraft.job.projectId, 'project.json');
  const autoRevisionFixture = JSON.parse(fs.readFileSync(autoRevisionFile, 'utf8'));
  const autoProjectFixture = JSON.parse(fs.readFileSync(autoProjectFile, 'utf8'));
  try {
    const migratedFixture = JSON.parse(JSON.stringify(autoRevisionFixture));
    migratedFixture.migration = {
      id: 'smoke-import', tool: 'fixture', manifest: '/private/secret/manifest.json',
      sourceJobDir: '/private/secret/job',
    };
    migratedFixture.workflowMode = 'unknown-workflow';
    migratedFixture.options.workflowMode = 'unknown-workflow';
    migratedFixture.outputs = [{
      id: 'secret-output', name: 'fixture.mp4', mediaType: 'video/mp4', size: 1,
      path: '/private/secret/revision-output.mp4',
      archive: '/private/secret/revision-archive.mp4',
    }];
    migratedFixture.archived = ['/private/secret/revision-archive.mp4'];
    fs.writeFileSync(autoRevisionFile, JSON.stringify(migratedFixture, null, 2));
    const migratedProjectFixture = JSON.parse(JSON.stringify(autoProjectFixture));
    migratedProjectFixture.migration = {
      tool: 'fixture', migratedAt: '2026-08-23T00:00:00.000Z',
      source: '/private/secret/project', sourceJobDir: '/private/secret/project-job',
    };
    migratedProjectFixture.assets[0].sourcePaths = ['/private/secret/avatar.mp4'];
    migratedProjectFixture.revisions[0].outputs = [{
      id: 'secret-output', name: 'fixture.mp4', mediaType: 'video/mp4', size: 1,
      path: '/private/secret/project-output.mp4',
      archive: '/private/secret/project-archive.mp4',
    }];
    fs.writeFileSync(autoProjectFile, JSON.stringify(migratedProjectFixture, null, 2));
    const migratedReadModel = await request(base,
      `/api/projects/${autoDraft.job.projectId}?revision=${autoDraft.job.revisionId}`);
    assert.equal(migratedReadModel.revisionSummaries[0].source.kind, 'imported');
    assert.equal(migratedReadModel.revisionSummaries[0].source.migration.id, 'smoke-import');
    assert.equal(migratedReadModel.revisionSummaries[0].source.migration.tool, 'fixture');
    assert.equal(migratedReadModel.revisionSummaries[0].workflowMode, null);
    assert.deepEqual(migratedReadModel.project.migration, {
      tool: 'fixture', migratedAt: '2026-08-23T00:00:00.000Z',
    });
    assert.equal(Object.hasOwn(migratedReadModel.project.assets[0], 'sourcePaths'), false);
    assert.equal(Object.hasOwn(migratedReadModel.revision, 'archived'), false);
    assert.equal(Object.hasOwn(migratedReadModel.revision.outputs[0], 'archive'), false);
    assert.equal(Object.hasOwn(migratedReadModel.revision.outputs[0], 'path'), false);
    assert.equal(Object.hasOwn(migratedReadModel.project.revisions[0].outputs[0], 'archive'), false);
    assert.equal(JSON.stringify(migratedReadModel).includes('/private/secret/'), false);
    const migratedListModel = await request(base, '/api/projects');
    const migratedListProject = migratedListModel.projects
      .find((item) => item.id === autoDraft.job.projectId);
    assert.equal(Object.hasOwn(migratedListProject.assets[0], 'sourcePaths'), false);
    assert.equal(Object.hasOwn(migratedListProject.revisions[0].outputs[0], 'archive'), false);
    assert.equal(JSON.stringify(migratedListProject).includes('/private/secret/'), false);
  } finally {
    fs.writeFileSync(autoRevisionFile, JSON.stringify(autoRevisionFixture, null, 2));
    fs.writeFileSync(autoProjectFile, JSON.stringify(autoProjectFixture, null, 2));
  }
  const autoCancelled = await request(base, `/api/jobs/${autoDraft.job.id}/cancel`, { method: 'POST' });
  assert.equal(autoCancelled.job.status, 'cancelled');
  assert.ok(autoCancelled.job.cancelledAt);

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
  await request(base,
    `/api/jobs/${id}/upload?name=shot1.png&originalName=${encodeURIComponent('產品畫面')}`, {
    method: 'POST',
    body: PNG_FIXTURE,
  });
  const uploadProjectFile = path.join(DATA_DIR, 'projects', created.job.projectId, 'project.json');
  const uploadProjectFixture = JSON.parse(fs.readFileSync(uploadProjectFile, 'utf8'));
  try {
    const legacyImage = uploadProjectFixture.assets.find((asset) => asset.kind === 'image');
    legacyImage.sourcePaths = ['/private/secret/legacy-image.png'];
    fs.writeFileSync(uploadProjectFile, JSON.stringify(uploadProjectFixture, null, 2));
    const duplicateUpload = await request(base,
      `/api/jobs/${id}/upload?name=shot1.png&originalName=${encodeURIComponent('重複素材')}`, {
        method: 'POST', body: PNG_FIXTURE,
      });
    assert.equal(Object.hasOwn(duplicateUpload.asset, 'path'), false);
    assert.equal(Object.hasOwn(duplicateUpload.asset, 'sourcePaths'), false);
    assert.equal(JSON.stringify(duplicateUpload).includes('/private/secret/'), false);
  } finally {
    const restoredProject = JSON.parse(fs.readFileSync(uploadProjectFile, 'utf8'));
    for (const asset of restoredProject.assets) delete asset.sourcePaths;
    fs.writeFileSync(uploadProjectFile, JSON.stringify(restoredProject, null, 2));
  }
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
  assert.equal(reusableImage.originalName, '產品畫面');
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
  assert.equal(imageAsset.headers.get('content-disposition'), null);
  const imageDownload = await fetch(
    base + `/api/projects/${created.job.projectId}/assets/${reusableImage.id}?dl=1`);
  assert.equal(imageDownload.status, 200);
  assert.equal(imageDownload.headers.get('content-disposition'),
    `attachment; filename="download.png"; filename*=UTF-8''%E7%94%A2%E5%93%81%E7%95%AB%E9%9D%A2.png`);

  const videoAssetUrl = `/api/projects/${created.job.projectId}/assets/${reusableVideo.id}`;
  const videoRange = await fetch(base + videoAssetUrl, { headers: { Range: 'bytes=0-7' } });
  assert.equal(videoRange.status, 206);
  assert.equal(videoRange.headers.get('content-type'), 'video/mp4');
  assert.equal(videoRange.headers.get('content-disposition'), null);
  assert.equal(videoRange.headers.get('content-range'), `bytes 0-7/${MP4_FIXTURE.length}`);
  assert.deepEqual(Buffer.from(await videoRange.arrayBuffer()), MP4_FIXTURE.subarray(0, 8));
  const invalidRange = await fetch(base + videoAssetUrl, {
    headers: { Range: `bytes=${MP4_FIXTURE.length + 100}-` },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${MP4_FIXTURE.length}`);
  const videoDownload = await fetch(base + videoAssetUrl + '?dl=1');
  assert.equal(videoDownload.status, 200);
  assert.equal(videoDownload.headers.get('content-disposition'),
    `attachment; filename="B Roll.mp4"; filename*=UTF-8''B%20Roll.mp4`);

  // Historical metadata is read from disk on every request. Even if an older Project contains
  // control characters or quotes, it must not be able to add a response header.
  const projectFile = path.join(DATA_DIR, 'projects', created.job.projectId, 'project.json');
  const storedProjectForHeaderTest = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const storedVideoForHeaderTest = storedProjectForHeaderTest.assets
    .find((asset) => asset.id === reusableVideo.id);
  storedVideoForHeaderTest.originalName = '測試"\r\nX-Injected: yes';
  fs.writeFileSync(projectFile, JSON.stringify(storedProjectForHeaderTest, null, 2));
  const injectionSafeDownload = await fetch(base + videoAssetUrl + '?dl=1');
  assert.equal(injectionSafeDownload.status, 200);
  assert.equal(injectionSafeDownload.headers.get('x-injected'), null);
  assert.equal(injectionSafeDownload.headers.get('content-disposition'),
    `attachment; filename="_X-Injected: yes.mp4"; filename*=UTF-8''%E6%B8%AC%E8%A9%A6%22X-Injected%3A%20yes.mp4`);
  storedVideoForHeaderTest.originalName = `${'a'.repeat(219)}😀`;
  fs.writeFileSync(projectFile, JSON.stringify(storedProjectForHeaderTest, null, 2));
  const longUnicodeDownload = await fetch(base + videoAssetUrl + '?dl=1');
  assert.equal(longUnicodeDownload.status, 200);
  assert.match(longUnicodeDownload.headers.get('content-disposition'), /\.mp4"; filename\*=/);
  storedVideoForHeaderTest.originalName = reusableVideo.originalName;
  fs.writeFileSync(projectFile, JSON.stringify(storedProjectForHeaderTest, null, 2));

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

  const beforeInvalidParent = await request(base, `/api/projects/${created.job.projectId}`);
  const invalidParent = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      parentRevisionId: 'v999',
      template: 'focusstock',
      title: '不應建立的來源版本',
      body: '來源版本不存在時不得留下新 Revision。',
    }),
  });
  assert.equal(invalidParent.status, 409);
  const afterInvalidParent = await request(base, `/api/projects/${created.job.projectId}`);
  assert.equal(afterInvalidParent.project.latestRevision, beforeInvalidParent.project.latestRevision);
  assert.equal(afterInvalidParent.project.revisions.length, beforeInvalidParent.project.revisions.length);

  const iterated = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      parentRevisionId: created.job.revisionId,
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
  assert.equal(secondRevision.revision.parentRevisionId, created.job.revisionId);
  assert.equal(secondRevision.revisionSummaries.find((item) => item.id === iterated.job.revisionId)
    .source.parentRevisionId, created.job.revisionId);

  const preparedCarrySource = path.join(DATA_DIR, 'prepared-carry-source.mp4');
  fs.writeFileSync(preparedCarrySource, MP4_FIXTURE);
  const carryStore = createProjectStore({
    dataDir: DATA_DIR,
    nowISO: () => '2026-08-24T00:00:00.000Z',
    idFactory: () => 'unused-carry-id',
  });
  const preparedCarryAsset = carryStore.ingestAsset(
    created.job.projectId, preparedCarrySource, {
      originalName: 'prior-ready-to-place.mp4',
      kind: 'video',
      role: 'prepared-phone-video',
      origin: 'chipk-simulator-capture',
    });
  const preparedCarryDraft = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: created.job.projectId,
      parentRevisionId: iterated.job.revisionId,
      reuseAssetIds: [preparedCarryAsset.id],
      template: 'focusstock',
      title: 'Prepared clip 不沿用',
      body: '下一版必須重新取得 ready-to-place placement。',
    }),
  });
  assert.deepEqual(preparedCarryDraft.job.assetRefs, []);
  assert.equal(fs.existsSync(path.join(
    DATA_DIR, 'jobs', preparedCarryDraft.job.id, 'input', 'broll1.mp4')), false);
  await request(base, `/api/jobs/${preparedCarryDraft.job.id}/abort`, { method: 'POST' });

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
  recoveryJobJson.sourceJobDir = '/private/secret/top-level-job';
  recoveryJobJson.sourceRoots = ['/private/secret/root'];
  recoveryJobJson.manifest = '/private/secret/top-level-manifest.json';
  recoveryJobJson.migration = {
    tool: 'fixture', migratedAt: '2026-08-23T00:00:00.000Z',
    sourceJobDir: '/private/secret/nested-job', manifest: '/private/secret/nested-manifest.json',
  };
  recoveryJobJson.outputs = [{
    id: 'secret-job-output', name: 'fixture.mp4', mediaType: 'video/mp4', size: 1,
    path: '/private/secret/job-output.mp4', archive: '/private/secret/job-archive.mp4',
  }];
  recoveryJobJson.archived = ['/private/secret/job-archive.mp4'];
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
  assert.deepEqual(recoveredJob.job.migration, {
    tool: 'fixture', migratedAt: '2026-08-23T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(recoveredJob.job, 'archived'), false);
  assert.equal(Object.hasOwn(recoveredJob.job.outputs[0], 'archive'), false);
  assert.equal(Object.hasOwn(recoveredJob.job.outputs[0], 'path'), false);
  assert.equal(JSON.stringify(recoveredJob.job).includes('/private/secret/'), false);
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
  assert.equal(detachedCancel.status, 202);
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
  assert.equal(detachedRecoveredJob.job.status, 'cancelled');
  assert.ok(detachedRecoveredJob.job.cancelRequestedAt);
  assert.ok(detachedRecoveredJob.job.cancelledAt);
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

  // A token-bearing lock can survive SIGKILL. If that PID is later reused by an unrelated live
  // process, cancellation must never turn the stale lock into kill authority.
  const staleLockDraft = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'default', owner: 'stale-lock-smoke', title: 'PID reuse gate',
      body: 'stale lock 不可誤殺無關 process。', skipGenerate: true,
    }),
  });
  await stopTestServer(child);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  AUXILIARY_CHILDREN.add(unrelated);
  unrelated.unref();
  const staleToken = '00000000-0000-4000-8000-000000000003';
  const staleStartedAt = new Date().toISOString();
  const staleJobFile = path.join(DATA_DIR, 'jobs', staleLockDraft.job.id, 'job.json');
  const staleJob = JSON.parse(fs.readFileSync(staleJobFile, 'utf8'));
  Object.assign(staleJob, {
    status: 'detached',
    pid: unrelated.pid,
    workspaceRunPid: unrelated.pid,
    workspaceRunStatus: 'preparing',
    workspaceRunStartedAt: staleStartedAt,
    workspaceRunToken: staleToken,
    detachedFromStatus: 'preparing',
  });
  fs.writeFileSync(staleJobFile, JSON.stringify(staleJob, null, 2));
  const staleOwner = { pid: unrelated.pid, startedAt: staleStartedAt, token: staleToken };
  fs.writeFileSync(path.join(DATA_DIR, '.run.lock'), JSON.stringify(staleOwner));
  fs.writeFileSync(path.join(DATA_DIR, '.run.owner.json'), JSON.stringify(staleOwner));

  child = startTestServer();
  const staleRestartReady = await waitForReady(child);
  base = `http://127.0.0.1:${staleRestartReady.port}`;
  const staleCancelResponse = await fetch(base + `/api/jobs/${staleLockDraft.job.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(staleCancelResponse.status, 202);
  const staleCancelBody = await staleCancelResponse.json();
  assert.equal(staleCancelBody.signalled, false);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));

  fs.rmSync(path.join(DATA_DIR, '.run.lock'));
  const unrelatedExited = new Promise((resolve) => unrelated.once('exit', resolve));
  unrelated.kill('SIGTERM');
  await unrelatedExited;
  AUXILIARY_CHILDREN.delete(unrelated);
  await request(base, '/api/health');
  const safelySettledStale = await waitForJobStatus(base, staleLockDraft.job.id, 'cancelled');
  assert.ok(safelySettledStale.job.cancelledAt);

  const workspaceOut = path.join(DATA_DIR, 'workspace', 'out');
  let detachedRenderSequence = 0x10;
  const renderExpected = (template, withAd) => {
    if (template === 'dapan')
      return ['out/output-dapan.mp4', 'out/output-dapan-landscape.mp4'];
    if (template === 'institution') return ['out/output-institution.mp4'];
    if (template === 'focusstock') return withAd
      ? ['out/output-focusstock.mp4', 'out/output-focusstock-ad.mp4']
      : ['out/output-focusstock.mp4'];
    return ['out/output.mp4'];
  };
  const setupDetachedRender = async ({
    template,
    withAd = false,
    title,
    produced,
    exitCode = 0,
    unchanged = [],
    ownerToken,
    beforeRestart,
  }) => {
    const createdRun = await request(base, '/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template,
        withAd,
        owner: 'smoke-detached-render',
        title,
        body: `${title} 的 detached output recovery fixture。`,
        skipGenerate: true,
      }),
    });
    await stopTestServer(child);

    const suffix = String(detachedRenderSequence++).padStart(12, '0');
    const token = `00000000-0000-4000-8000-${suffix}`;
    const pid = 2147483000 + detachedRenderSequence;
    const startedAt = '2001-01-01T00:00:00.000Z';
    const finishedAt = '2001-01-01T00:01:00.000Z';
    const expected = renderExpected(template, withAd);
    const runFile = path.join(DATA_DIR, 'jobs', createdRun.job.id, 'job.json');
    const runJson = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    Object.assign(runJson, {
      status: 'rendering',
      pid,
      workspaceRunPid: pid,
      workspaceRunStatus: 'rendering',
      workspaceRunStartedAt: startedAt,
      workspaceRunToken: token,
      workspaceRunEvidenceVersion: 1,
      workspaceRunExpectedOutputs: expected,
    });
    fs.writeFileSync(runFile, JSON.stringify(runJson, null, 2));

    fs.rmSync(workspaceOut, { recursive: true, force: true });
    fs.mkdirSync(workspaceOut, { recursive: true });
    const producedByName = new Map(Object.entries(produced || {}));
    const unchangedNames = new Set(unchanged);
    for (const [name, bytes] of producedByName) fs.writeFileSync(path.join(workspaceOut, name), bytes);
    const resultOutputs = expected.map((relativePath) => {
      const name = path.basename(relativePath);
      const bytes = producedByName.get(name);
      const after = bytes ? {
        state: 'file',
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        mtimeNs: '2',
        ctimeNs: '2',
        ino: '2',
      } : { state: 'missing' };
      return {
        relativePath,
        name,
        before: unchangedNames.has(name) ? after : { state: 'missing' },
        after,
        changedFromBefore: Boolean(bytes) && !unchangedNames.has(name),
      };
    });
    const pipelineDir = path.join(DATA_DIR, 'jobs', createdRun.job.id, 'pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(path.join(pipelineDir, `${token}.result.json`), JSON.stringify({
      schemaVersion: 1,
      jobId: createdRun.job.id,
      projectId: createdRun.job.projectId,
      revisionId: createdRun.job.revisionId,
      workspaceRunToken: token,
      runStatus: 'rendering',
      startedAt,
      finishedAt,
      exitCode,
      owner: { pid, startedAt, token },
      outputs: resultOutputs,
    }, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, '.run.owner.json'), JSON.stringify({
      pid,
      startedAt,
      token: ownerToken || token,
    }));
    if (beforeRestart) await beforeRestart(createdRun);

    child = startTestServer();
    const restart = await waitForReady(child);
    base = `http://127.0.0.1:${restart.port}`;
    await request(base, '/api/health');
    return { createdRun, token, pid, expected };
  };
  const retireDetachedRenderFixture = async (createdRun) => {
    await stopTestServer(child);
    const runFile = path.join(DATA_DIR, 'jobs', createdRun.job.id, 'job.json');
    const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    record.status = 'cancelled';
    record.pid = null;
    delete record.detachedWorkspaceContested;
    delete record.detachedCaptureRetryAt;
    delete record.detachedCaptureAttempts;
    fs.writeFileSync(runFile, JSON.stringify(record, null, 2));
    child = startTestServer();
    const ready = await waitForReady(child);
    base = `http://127.0.0.1:${ready.port}`;
  };

  // Exact cardinality matters: Focusstock normally has one output, Dapan always has two, and the
  // Focusstock ad output is required only when withAd was selected.
  const detachedSingle = await setupDetachedRender({
    template: 'focusstock',
    title: 'Detached 單輸出恢復',
    produced: { 'output-focusstock.mp4': MP4_FIXTURE },
  });
  let recoveredRender = await request(base, `/api/jobs/${detachedSingle.createdRun.job.id}`);
  let recoveredRenderProject = await request(base,
    `/api/projects/${detachedSingle.createdRun.job.projectId}`
      + `?revision=${detachedSingle.createdRun.job.revisionId}`);
  assert.equal(recoveredRender.job.status, 'done');
  assert.deepEqual(recoveredRender.job.outputs.map((output) => output.name),
    ['output-focusstock.mp4']);
  assert.equal(recoveredRenderProject.revision.status, 'done');
  assert.equal(recoveredRenderProject.revision.outputs.length, 1);
  assert.equal(recoveredRenderProject.project.revisions.find(
    (item) => item.id === detachedSingle.createdRun.job.revisionId).status, 'done');
  assert.equal((await fetch(base
    + `/api/jobs/${detachedSingle.createdRun.job.id}/file/output-focusstock.mp4`)).status, 200);

  // Simulate a crash after atomic job.json reached done but before Revision/project metadata did.
  // Startup repair must replay only this mismatch and restore the Project side.
  await stopTestServer(child);
  const halfTransitionProjectDir = path.join(DATA_DIR, 'projects',
    detachedSingle.createdRun.job.projectId);
  const halfTransitionRevisionFile = path.join(halfTransitionProjectDir, 'revisions',
    `${detachedSingle.createdRun.job.revisionId}.json`);
  const halfTransitionProjectFile = path.join(halfTransitionProjectDir, 'project.json');
  const halfTransitionRevision = JSON.parse(fs.readFileSync(halfTransitionRevisionFile, 'utf8'));
  halfTransitionRevision.status = 'rendering';
  halfTransitionRevision.outputs = [];
  halfTransitionRevision.archived = [];
  fs.writeFileSync(halfTransitionRevisionFile, JSON.stringify(halfTransitionRevision, null, 2));
  const halfTransitionProject = JSON.parse(fs.readFileSync(halfTransitionProjectFile, 'utf8'));
  const halfTransitionSummary = halfTransitionProject.revisions.find(
    (item) => item.id === detachedSingle.createdRun.job.revisionId);
  halfTransitionSummary.status = 'rendering';
  halfTransitionSummary.outputs = [];
  fs.writeFileSync(halfTransitionProjectFile, JSON.stringify(halfTransitionProject, null, 2));
  child = startTestServer();
  const halfTransitionRestart = await waitForReady(child);
  base = `http://127.0.0.1:${halfTransitionRestart.port}`;
  recoveredRenderProject = await request(base,
    `/api/projects/${detachedSingle.createdRun.job.projectId}`
      + `?revision=${detachedSingle.createdRun.job.revisionId}`);
  assert.equal(recoveredRenderProject.revision.status, 'done');
  assert.equal(recoveredRenderProject.revision.outputs.length, 1);

  const detachedDapan = await setupDetachedRender({
    template: 'dapan',
    title: 'Detached 大盤雙輸出恢復',
    produced: {
      'output-dapan.mp4': MP4_FIXTURE,
      'output-dapan-landscape.mp4': MP4_FIXTURE,
    },
  });
  recoveredRender = await request(base, `/api/jobs/${detachedDapan.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'done');
  assert.deepEqual(recoveredRender.job.outputs.map((output) => output.name).sort(),
    ['output-dapan-landscape.mp4', 'output-dapan.mp4']);

  const detachedWithAd = await setupDetachedRender({
    template: 'focusstock',
    withAd: true,
    title: 'Detached Focusstock 選配雙輸出恢復',
    produced: {
      'output-focusstock.mp4': MP4_FIXTURE,
      'output-focusstock-ad.mp4': MP4_FIXTURE,
    },
  });
  recoveredRender = await request(base, `/api/jobs/${detachedWithAd.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'done');
  assert.deepEqual(recoveredRender.job.outputs.map((output) => output.name).sort(),
    ['output-focusstock-ad.mp4', 'output-focusstock.mp4']);

  // A non-zero worker exit plus one missing Dapan output is an explicit failed Run. The one file
  // that did exist is copied into job/out before the shared workspace is released.
  const detachedPartial = await setupDetachedRender({
    template: 'dapan',
    title: 'Detached partial render 失敗保留',
    produced: { 'output-dapan.mp4': MP4_FIXTURE },
    exitCode: 1,
  });
  recoveredRender = await request(base, `/api/jobs/${detachedPartial.createdRun.job.id}`);
  recoveredRenderProject = await request(base,
    `/api/projects/${detachedPartial.createdRun.job.projectId}`
      + `?revision=${detachedPartial.createdRun.job.revisionId}`);
  assert.equal(recoveredRender.job.status, 'review');
  assert.match(recoveredRender.job.error, /可人工確認後重新出片/);
  assert.equal(recoveredRenderProject.revision.status, 'review');
  assert.deepEqual(recoveredRender.job.outputs.map((output) => output.name),
    [`${detachedPartial.token}-output-dapan.mp4`]);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', detachedPartial.createdRun.job.id,
    'out', recoveredRender.job.outputs[0].name)), true);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'projects', detachedPartial.createdRun.job.projectId,
    'outputs')).length, 0);

  const detachedStale = await setupDetachedRender({
    template: 'institution',
    title: 'Detached 舊 output 不得誤收',
    produced: { 'output-institution.mp4': MP4_FIXTURE },
    unchanged: ['output-institution.mp4'],
  });
  recoveredRender = await request(base, `/api/jobs/${detachedStale.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'review');
  assert.match(recoveredRender.job.error, /與 render 前完全相同/);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'projects', detachedStale.createdRun.job.projectId,
    'outputs')).length, 0);

  // A Project outputs failure retains fallback and keeps the detached gate closed. Once the same
  // destination becomes safe, the evidence is replayed idempotently and the Run becomes done.
  const archiveFailureTarget = path.join(DATA_DIR, 'unsafe-project-output-target');
  fs.mkdirSync(archiveFailureTarget, { recursive: true });
  const detachedArchiveRetry = await setupDetachedRender({
    template: 'institution',
    title: 'Detached archive failure retry',
    produced: { 'output-institution.mp4': MP4_FIXTURE },
    beforeRestart: async (run) => {
      const outputDir = path.join(DATA_DIR, 'projects', run.job.projectId, 'outputs');
      fs.rmdirSync(outputDir);
      fs.symlinkSync(archiveFailureTarget, outputDir, 'dir');
    },
  });
  recoveredRender = await request(base, `/api/jobs/${detachedArchiveRetry.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'detached');
  assert.match(recoveredRender.job.error, /Project output 封存失敗/);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', detachedArchiveRetry.createdRun.job.id,
    'out', `${detachedArchiveRetry.token}-output-institution.mp4`)), true);
  const retryOutputDir = path.join(DATA_DIR, 'projects', detachedArchiveRetry.createdRun.job.projectId,
    'outputs');
  fs.unlinkSync(retryOutputDir);
  fs.mkdirSync(retryOutputDir);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await request(base, '/api/health');
  recoveredRender = await request(base, `/api/jobs/${detachedArchiveRetry.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'done');
  assert.equal(recoveredRender.job.outputs.length, 1);
  const retryProjectBeforeRestart = await request(base,
    `/api/projects/${detachedArchiveRetry.createdRun.job.projectId}`
      + `?revision=${detachedArchiveRetry.createdRun.job.revisionId}`);
  const retryOutputNames = fs.readdirSync(retryOutputDir);

  await stopTestServer(child);
  child = startTestServer();
  const idempotentRestart = await waitForReady(child);
  base = `http://127.0.0.1:${idempotentRestart.port}`;
  const retryAfterRestart = await request(base, `/api/jobs/${detachedArchiveRetry.createdRun.job.id}`);
  const retryProjectAfterRestart = await request(base,
    `/api/projects/${detachedArchiveRetry.createdRun.job.projectId}`
      + `?revision=${detachedArchiveRetry.createdRun.job.revisionId}`);
  assert.equal(retryAfterRestart.job.status, 'done');
  assert.deepEqual(fs.readdirSync(retryOutputDir), retryOutputNames);
  assert.equal(retryProjectAfterRestart.revision.updatedAt, retryProjectBeforeRestart.revision.updatedAt);

  // A foreign owner token must never be allowed to collect even otherwise valid evidence.
  const detachedContestedRender = await setupDetachedRender({
    template: 'institution',
    title: 'Detached contested ownership',
    produced: { 'output-institution.mp4': MP4_FIXTURE },
    ownerToken: '00000000-0000-4000-8000-999999999999',
  });
  recoveredRender = await request(base, `/api/jobs/${detachedContestedRender.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'detached');
  const contestedRecord = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs',
    detachedContestedRender.createdRun.job.id, 'job.json'), 'utf8'));
  assert.match(contestedRecord.detachedWorkspaceContested, /owner token changed/);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'projects',
    detachedContestedRender.createdRun.job.projectId, 'outputs')).length, 0);
  await retireDetachedRenderFixture(detachedContestedRender.createdRun);

  // A valid-looking result reached through a Run pipeline symlink is not owned evidence.
  const detachedPipelineSymlink = await setupDetachedRender({
    template: 'institution',
    title: 'Detached pipeline symlink 拒收',
    produced: { 'output-institution.mp4': MP4_FIXTURE },
    beforeRestart: async (run) => {
      const pipelineDir = path.join(DATA_DIR, 'jobs', run.job.id, 'pipeline');
      const outside = path.join(DATA_DIR, 'outside-pipeline-evidence', run.job.id);
      fs.mkdirSync(outside, { recursive: true });
      for (const name of fs.readdirSync(pipelineDir))
        fs.copyFileSync(path.join(pipelineDir, name), path.join(outside, name));
      fs.rmSync(pipelineDir, { recursive: true });
      fs.symlinkSync(outside, pipelineDir, 'dir');
    },
  });
  recoveredRender = await request(base, `/api/jobs/${detachedPipelineSymlink.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'detached');
  const pipelineSymlinkRecord = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs',
    detachedPipelineSymlink.createdRun.job.id, 'job.json'), 'utf8'));
  assert.match(pipelineSymlinkRecord.detachedWorkspaceContested, /pipeline evidence 目錄 ownership/);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'projects',
    detachedPipelineSymlink.createdRun.job.projectId, 'outputs')).length, 0);
  await retireDetachedRenderFixture(detachedPipelineSymlink.createdRun);

  // A Run out/ symlink must not be accepted as a fallback source or destination after the shared
  // workspace copy disappears. The queue remains closed instead of releasing an unowned file.
  const detachedOutSymlink = await setupDetachedRender({
    template: 'institution',
    title: 'Detached out symlink 拒收',
    produced: { 'output-institution.mp4': MP4_FIXTURE },
    beforeRestart: async (run) => {
      const outside = path.join(DATA_DIR, 'outside-run-output', run.job.id);
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'output-institution.mp4'), MP4_FIXTURE);
      fs.rmSync(path.join(workspaceOut, 'output-institution.mp4'));
      fs.symlinkSync(outside, path.join(DATA_DIR, 'jobs', run.job.id, 'out'), 'dir');
    },
  });
  recoveredRender = await request(base, `/api/jobs/${detachedOutSymlink.createdRun.job.id}`);
  assert.equal(recoveredRender.job.status, 'detached');
  assert.match(recoveredRender.job.error, /fallback 尚未保存/);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'projects',
    detachedOutSymlink.createdRun.job.projectId, 'outputs')).length, 0);
  await retireDetachedRenderFixture(detachedOutSymlink.createdRun);

  // 成功的 Project Run 不需要等 retention：正式 output 已在 Project 後，Run 只保留
  // job.json／log.txt。清掉 input/state/thumbs/out 後，Revision、播放與下一版重用仍要成立。
  const compactable = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-run-compaction',
      title: 'Run payload 立即清理測試',
      body: '正式資料進入 Project 後，Run 素材可以直接清掉。',
      skipGenerate: false,
    }),
  });
  const compactUpload = await request(base,
    `/api/jobs/${compactable.job.id}/upload?name=shot1.png&originalName=shared.png`, {
      method: 'POST', body: PNG_FIXTURE,
    });
  await request(base, `/api/jobs/${compactable.job.id}/submit`, { method: 'POST' });

  const createQueuedCompactionFixture = async (title) => {
    const createdRun = await request(base, '/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'focusstock',
        owner: 'smoke-run-compaction',
        title,
        body: `${title} 不得造成錯誤的立即清理。`,
        skipGenerate: false,
      }),
    });
    await request(base, `/api/jobs/${createdRun.job.id}/submit`, { method: 'POST' });
    return createdRun;
  };
  const missingSizeRun = await createQueuedCompactionFixture('缺少 output size');
  const wrongProjectRun = await createQueuedCompactionFixture('錯誤 Project output');
  const wrongRunRevision = await createQueuedCompactionFixture('Revision 屬於錯誤 Run');
  const missingProjectIdentityRun = await createQueuedCompactionFixture('遺失 Project identity');
  const symlinkOutputRun = await createQueuedCompactionFixture('Project outputs 是 symlink');
  const extraFallbackRun = await createQueuedCompactionFixture('未列入 manifest 的 fallback');
  const hashMismatchRun = await createQueuedCompactionFixture('同 size 不同內容 fallback');
  const protectedDraft = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-run-compaction',
      title: 'Active Run fail closed',
      body: 'draft／queued 的 payload 不得由 prune 清掉。',
    }),
  });
  const compactionFixtures = [
    compactable,
    missingSizeRun,
    wrongProjectRun,
    wrongRunRevision,
    missingProjectIdentityRun,
    symlinkOutputRun,
    extraFallbackRun,
    hashMismatchRun,
    protectedDraft,
  ];
  for (const run of compactionFixtures) {
    const stateDir = path.join(DATA_DIR, 'jobs', run.job.id, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'active.json'), '{}');
  }
  await request(base, '/api/prune', { method: 'POST' });
  for (const run of compactionFixtures) {
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', run.job.id, 'input')), true);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', run.job.id, 'state')), true);
  }
  await stopTestServer(child);

  const compactJobDir = path.join(DATA_DIR, 'jobs', compactable.job.id);
  const compactJobFile = path.join(compactJobDir, 'job.json');
  const compactStore = createProjectStore({
    dataDir: DATA_DIR,
    nowISO: () => new Date().toISOString(),
    idFactory: () => 'unused-in-compaction-test',
  });
  const compactOutput = compactStore.outputPath(
    compactable.job.projectId, compactable.job.revisionId, 'final.mp4');
  fs.writeFileSync(compactOutput, MP4_FIXTURE);
  const compactOutputRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, compactOutput),
  };
  const markDoneProjectRun = (run, outputRecord) => {
    const runDir = path.join(DATA_DIR, 'jobs', run.job.id);
    const runFile = path.join(runDir, 'job.json');
    const runJson = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    runJson.status = 'done';
    runJson.finishedAt = new Date().toISOString();
    runJson.outputs = [outputRecord];
    runJson.archived = [outputRecord.archive];
    fs.writeFileSync(runFile, JSON.stringify(runJson, null, 2));
    compactStore.updateRevision(run.job.projectId, run.job.revisionId, {
      status: 'done',
      outputs: [outputRecord],
      archived: [outputRecord.archive],
      finishedAt: runJson.finishedAt,
    });
    for (const sub of ['state', 'thumbs', 'out'])
      fs.mkdirSync(path.join(runDir, sub), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state', 'derived.json'), '{}');
    fs.writeFileSync(path.join(runDir, 'thumbs', 'derived.png'), PNG_FIXTURE);
    fs.writeFileSync(path.join(runDir, 'out', outputRecord.name), MP4_FIXTURE);
    return runDir;
  };
  markDoneProjectRun(compactable, compactOutputRecord);
  fs.writeFileSync(path.join(compactJobDir, 'log.txt'), 'minimal run trace\n');

  const missingSizeOutput = compactStore.outputPath(
    missingSizeRun.job.projectId, missingSizeRun.job.revisionId, 'final.mp4');
  fs.writeFileSync(missingSizeOutput, MP4_FIXTURE);
  const missingSizeRecord = {
    name: 'final.mp4',
    archive: path.relative(ROOT, missingSizeOutput),
  };
  const missingSizeDir = markDoneProjectRun(missingSizeRun, missingSizeRecord);

  const wrongProjectRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, compactOutput),
  };
  const wrongProjectDir = markDoneProjectRun(wrongProjectRun, wrongProjectRecord);

  const wrongRunOutput = compactStore.outputPath(
    wrongRunRevision.job.projectId, wrongRunRevision.job.revisionId, 'final.mp4');
  fs.writeFileSync(wrongRunOutput, MP4_FIXTURE);
  const wrongRunRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, wrongRunOutput),
  };
  const wrongRunDir = markDoneProjectRun(wrongRunRevision, wrongRunRecord);
  compactStore.updateRevision(wrongRunRevision.job.projectId, wrongRunRevision.job.revisionId, {
    jobId: compactable.job.id,
    runId: compactable.job.id,
  });

  const missingIdentityOutput = compactStore.outputPath(
    missingProjectIdentityRun.job.projectId, missingProjectIdentityRun.job.revisionId, 'final.mp4');
  fs.writeFileSync(missingIdentityOutput, MP4_FIXTURE);
  const missingIdentityRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, missingIdentityOutput),
  };
  const missingIdentityDir = markDoneProjectRun(missingProjectIdentityRun, missingIdentityRecord);
  const missingIdentityJobFile = path.join(missingIdentityDir, 'job.json');
  const missingIdentityJob = JSON.parse(fs.readFileSync(missingIdentityJobFile, 'utf8'));
  delete missingIdentityJob.projectId;
  delete missingIdentityJob.revisionId;
  fs.writeFileSync(missingIdentityJobFile, JSON.stringify(missingIdentityJob, null, 2));

  const symlinkProjectDir = compactStore.projectDir(symlinkOutputRun.job.projectId);
  const symlinkOutputDir = compactStore.outputDir(symlinkOutputRun.job.projectId);
  const outsideProjectOutputDir = path.join(DATA_DIR, 'outside-project-output');
  fs.mkdirSync(outsideProjectOutputDir, { recursive: true });
  fs.rmSync(symlinkOutputDir, { recursive: true });
  fs.symlinkSync(outsideProjectOutputDir, symlinkOutputDir, 'dir');
  const symlinkOutput = path.join(symlinkOutputDir, 'final.mp4');
  fs.writeFileSync(symlinkOutput, MP4_FIXTURE);
  const symlinkOutputRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, symlinkOutput),
  };
  const symlinkOutputRunDir = markDoneProjectRun(symlinkOutputRun, symlinkOutputRecord);
  assert.equal(fs.lstatSync(path.join(symlinkProjectDir, 'outputs')).isSymbolicLink(), true);

  const extraFallbackOutput = compactStore.outputPath(
    extraFallbackRun.job.projectId, extraFallbackRun.job.revisionId, 'final.mp4');
  fs.writeFileSync(extraFallbackOutput, MP4_FIXTURE);
  const extraFallbackRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, extraFallbackOutput),
  };
  const extraFallbackDir = markDoneProjectRun(extraFallbackRun, extraFallbackRecord);
  fs.writeFileSync(path.join(extraFallbackDir, 'out', 'unlisted.mp4'), MP4_FIXTURE);

  const hashMismatchOutput = compactStore.outputPath(
    hashMismatchRun.job.projectId, hashMismatchRun.job.revisionId, 'final.mp4');
  fs.writeFileSync(hashMismatchOutput, MP4_FIXTURE);
  const hashMismatchRecord = {
    name: 'final.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, hashMismatchOutput),
  };
  const hashMismatchDir = markDoneProjectRun(hashMismatchRun, hashMismatchRecord);
  const sameSizeDifferentOutput = Buffer.from(MP4_FIXTURE);
  sameSizeDifferentOutput[sameSizeDifferentOutput.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(hashMismatchDir, 'out', 'final.mp4'), sameSizeDifferentOutput);
  assert.equal(sameSizeDifferentOutput.length, MP4_FIXTURE.length);

  const outsideRunDir = path.join(DATA_DIR, 'outside-run');
  fs.mkdirSync(outsideRunDir, { recursive: true });
  const outsideMarker = path.join(outsideRunDir, 'must-survive.txt');
  fs.writeFileSync(outsideMarker, 'keep');
  const mismatchedManifestDir = path.join(DATA_DIR, 'jobs', 'mismatched-manifest');
  fs.mkdirSync(mismatchedManifestDir, { recursive: true });
  fs.writeFileSync(path.join(mismatchedManifestDir, 'job.json'), JSON.stringify({
    id: '../outside-run', status: 'done', outputs: [compactOutputRecord],
  }));
  fs.symlinkSync(outsideRunDir, path.join(DATA_DIR, 'jobs', 'symlink-run'), 'dir');
  const malformedOutputDir = path.join(DATA_DIR, 'jobs', 'malformed-output');
  fs.mkdirSync(path.join(malformedOutputDir, 'input'), { recursive: true });
  fs.writeFileSync(path.join(malformedOutputDir, 'input', 'must-survive.txt'), 'keep');
  fs.writeFileSync(path.join(malformedOutputDir, 'job.json'), JSON.stringify({
    id: 'malformed-output',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'done',
    outputs: [{ archive: 123, name: ['not-a-name'] }],
  }));

  child = startTestServer({ AUTO_PRUNE_ON_START: '1' });
  const compactRestartReady = await waitForReady(child);
  base = `http://127.0.0.1:${compactRestartReady.port}`;
  for (const sub of ['input', 'state', 'thumbs', 'out'])
    assert.equal(fs.existsSync(path.join(compactJobDir, sub)), false, `${sub} 應立即清理`);
  assert.equal(fs.existsSync(compactJobFile), true);
  assert.equal(fs.readFileSync(path.join(compactJobDir, 'log.txt'), 'utf8'), 'minimal run trace\n');
  assert.deepEqual(fs.readFileSync(compactOutput), MP4_FIXTURE);
  const compactProject = await request(base,
    `/api/projects/${compactable.job.projectId}?revision=${compactable.job.revisionId}`);
  assert.equal(compactProject.revision.status, 'done');
  assert.deepEqual(compactProject.revision.assetRefs, [compactUpload.asset.id]);
  assert.deepEqual(compactProject.revision.outputs, [{
    name: compactOutputRecord.name, size: compactOutputRecord.size,
  }]);
  const compactPlayback = await fetch(base + `/api/jobs/${compactable.job.id}/file/final.mp4`);
  assert.equal(compactPlayback.status, 200);
  assert.deepEqual(Buffer.from(await compactPlayback.arrayBuffer()), MP4_FIXTURE);
  const compactDownload = await fetch(
    base + `/api/jobs/${compactable.job.id}/file/final.mp4?dl=1`);
  assert.equal(compactDownload.status, 200);
  assert.equal(compactDownload.headers.get('content-disposition'),
    'attachment; filename="v001-final.mp4"');
  const strictGateDirs = [
    missingSizeDir,
    wrongProjectDir,
    wrongRunDir,
    missingIdentityDir,
    symlinkOutputRunDir,
  ];
  for (const runDir of strictGateDirs) {
    for (const sub of ['input', 'state', 'thumbs', 'out'])
      assert.equal(fs.existsSync(path.join(runDir, sub)), true,
        `${path.basename(runDir)} ${sub} 必須 fail closed`);
  }
  assert.equal(fs.existsSync(path.join(extraFallbackDir, 'input')), false);
  assert.equal(fs.existsSync(path.join(extraFallbackDir, 'state')), false);
  assert.equal(fs.existsSync(path.join(extraFallbackDir, 'thumbs')), false);
  assert.equal(fs.existsSync(path.join(extraFallbackDir, 'out', 'final.mp4')), true);
  assert.equal(fs.existsSync(path.join(extraFallbackDir, 'out', 'unlisted.mp4')), true);
  for (const sub of ['input', 'state', 'thumbs'])
    assert.equal(fs.existsSync(path.join(hashMismatchDir, sub)), false);
  assert.equal(fs.existsSync(path.join(hashMismatchDir, 'out', 'final.mp4')), true);
  assert.deepEqual(fs.readFileSync(path.join(hashMismatchDir, 'out', 'final.mp4')),
    sameSizeDifferentOutput);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', protectedDraft.job.id, 'input')), true);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', protectedDraft.job.id, 'state')), true);
  assert.equal(fs.readFileSync(outsideMarker, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(malformedOutputDir, 'input', 'must-survive.txt'), 'utf8'), 'keep');
  const jobsAfterUnsafeManifests = await request(base, '/api/jobs');
  assert.equal(jobsAfterUnsafeManifests.jobs.some((job) => job.id === '../outside-run'), false);

  const afterCompaction = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: compactable.job.projectId,
      reuseAssetIds: [compactUpload.asset.id],
      template: 'focusstock',
      owner: 'smoke-run-compaction',
      title: '清理後的 V2',
      body: '沿用 Project 素材建立下一版。',
    }),
  });
  assert.equal(afterCompaction.job.revisionNumber, 2);
  assert.deepEqual(afterCompaction.job.assetRefs, [compactUpload.asset.id]);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', afterCompaction.job.id,
    'input', 'shot1.png')), true);
  const projectAfterCompaction = await request(base, `/api/projects/${compactable.job.projectId}`);
  assert.equal(projectAfterCompaction.project.assets.filter((asset) => asset.kind === 'image').length, 1);
  await request(base, `/api/jobs/${afterCompaction.job.id}/abort`, { method: 'POST' });

  // 成功 Project Run 若 archive 缺檔，就可能握有唯一完成品；即使已超過 retention，
  // 整份 payload 都必須 fail closed，不能只留下看似最重要的 fallback out/。
  const fallbackRetention = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-fallback-retention',
      title: '未封存成品保留測試',
      body: '成品庫缺檔時，Run fallback 必須保留。',
      skipGenerate: true,
    }),
  });
  await request(base, `/api/jobs/${fallbackRetention.job.id}/cancel`, { method: 'POST' });
  await stopTestServer(child);
  const fallbackJobDir = path.join(DATA_DIR, 'jobs', fallbackRetention.job.id);
  const fallbackJobFile = path.join(fallbackJobDir, 'job.json');
  const fallbackJobJson = JSON.parse(fs.readFileSync(fallbackJobFile, 'utf8'));
  const missingArchive = path.join(DATA_DIR, 'archive', 'missing-output.mp4');
  fallbackJobJson.status = 'done';
  fallbackJobJson.finishedAt = '2001-01-01T00:00:00.000Z';
  fallbackJobJson.outputs = [{
    name: 'fallback.mp4',
    size: MP4_FIXTURE.length,
    archive: path.relative(ROOT, missingArchive),
  }];
  fs.writeFileSync(fallbackJobFile, JSON.stringify(fallbackJobJson, null, 2));
  for (const sub of ['out', 'input', 'state', 'thumbs'])
    fs.mkdirSync(path.join(fallbackJobDir, sub), { recursive: true });
  const fallbackOutput = path.join(fallbackJobDir, 'out', 'fallback.mp4');
  fs.writeFileSync(fallbackOutput, MP4_FIXTURE);
  fs.writeFileSync(path.join(fallbackJobDir, 'input', 'expired.txt'), 'expired');
  fs.writeFileSync(path.join(fallbackJobDir, 'state', 'recovery.json'), '{}');
  fs.writeFileSync(path.join(fallbackJobDir, 'thumbs', 'expired.png'), PNG_FIXTURE);

  child = startTestServer({ KEEP_RECENT: '0', KEEP_DAYS: '0' });
  const pruneRestartReady = await waitForReady(child);
  base = `http://127.0.0.1:${pruneRestartReady.port}`;
  await request(base, '/api/prune', { method: 'POST' });
  assert.equal(fs.existsSync(fallbackOutput), true);
  assert.deepEqual(fs.readFileSync(fallbackOutput), MP4_FIXTURE);
  assert.equal(fs.existsSync(path.join(fallbackJobDir, 'input')), true);
  assert.equal(fs.existsSync(path.join(fallbackJobDir, 'state')), true);
  assert.equal(fs.existsSync(path.join(fallbackJobDir, 'thumbs')), true);
  assert.equal(fs.existsSync(path.join(hashMismatchDir, 'out', 'final.mp4')), true);
  for (const runDir of strictGateDirs) {
    for (const sub of ['input', 'state', 'thumbs', 'out'])
      assert.equal(fs.existsSync(path.join(runDir, sub)), true,
        `${path.basename(runDir)} 不得由 retention 繞過 Project gate`);
  }
  assert.equal(fs.readFileSync(path.join(malformedOutputDir, 'input', 'must-survive.txt'), 'utf8'), 'keep');

  fs.writeFileSync(path.join(DATA_DIR, '.run.lock'), String(Date.now()));
  const unsafeUnlock = await fetch(base + '/api/unlock', { method: 'POST' });
  assert.equal(unsafeUnlock.status, 409);
  assert.equal(fs.existsSync(path.join(DATA_DIR, '.run.lock')), true);

  // Exercise the real queue -> doRender -> runPipeline path without providers or Remotion. The
  // DATA_DIR-local fixture is the only subprocess allowed by the smoke guard: it writes one valid
  // Dapan output, records the real owner token, and exits non-zero.
  await stopTestServer(child);
  const normalWorkerDir = path.join(DATA_DIR, 'normal-render-worker');
  fs.mkdirSync(normalWorkerDir, { recursive: true });
  const normalWorkerFixtureMp4 = path.join(normalWorkerDir, 'fixture.mp4');
  const normalWorkerRetryFixtureMp4 = path.join(normalWorkerDir, 'retry-fixture.mp4');
  const normalWorkerEntry = path.join(normalWorkerDir, 'partial-render.cjs');
  const normalWorkerInvocations = path.join(normalWorkerDir, 'invocations.log');
  fs.writeFileSync(normalWorkerFixtureMp4, MP4_FIXTURE);
  fs.writeFileSync(normalWorkerRetryFixtureMp4, FRAGMENTED_MP4_FIXTURE);
  fs.writeFileSync(normalWorkerEntry, `
'use strict';
const fs = require('fs');
const path = require('path');
const dataDir = process.env.DATA_DIR;
const mode = process.env.SMOKE_PIPELINE_MODE || 'partial';
const outDir = path.join(dataDir, 'workspace', 'out');
fs.mkdirSync(outDir, { recursive: true });
const output = path.join(outDir, 'output-dapan.mp4');
try { fs.unlinkSync(output); } catch (_) {}
fs.copyFileSync(process.env.SMOKE_PIPELINE_MP4, output);
if (mode.startsWith('success')) {
  const landscape = path.join(outDir, 'output-dapan-landscape.mp4');
  try { fs.unlinkSync(landscape); } catch (_) {}
  fs.copyFileSync(process.env.SMOKE_PIPELINE_MP4, landscape);
}
fs.writeFileSync(path.join(dataDir, '.run.owner.json'), JSON.stringify({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  token: process.env.WORKSPACE_RUN_TOKEN,
}));
fs.appendFileSync(process.env.SMOKE_PIPELINE_INVOCATIONS, process.argv.slice(2).join(' ') + '\\n');
if (mode === 'wait') {
  process.on('SIGTERM', () => {
    fs.appendFileSync(process.env.SMOKE_PIPELINE_SIGNAL, 'SIGTERM\\n');
    setTimeout(() => process.exit(143), 80);
  });
  setInterval(() => {}, 1000);
}
if (mode.endsWith('log-fail')) {
  const pipelineDir = path.dirname(process.env.WORKSPACE_EVIDENCE_CONFIG);
  const logFile = path.join(path.dirname(pipelineDir), 'log.txt');
  fs.rmSync(logFile, { recursive: true, force: true });
  fs.mkdirSync(logFile);
}
if (mode !== 'wait') process.exitCode = mode.startsWith('success') ? 0 : 1;
`);
  child = startTestServer({ DATA_DIR: normalWorkerDir });
  const normalSetupReady = await waitForReady(child);
  base = `http://127.0.0.1:${normalSetupReady.port}`;
  const normalPartial = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'dapan', owner: 'normal-partial-smoke', title: '正常 partial 回待確認',
      body: '正常 render non-zero 必須先保存 partial output。', skipGenerate: true,
    }),
  });
  const normalUnsafeFallback = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'dapan', owner: 'normal-partial-smoke', title: '正常 fallback fail closed',
      body: 'fallback 不安全時不得放行下一支。', skipGenerate: true,
    }),
  });
  const normalPipelineSymlink = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'dapan', owner: 'normal-partial-smoke', title: '正常 pipeline symlink 拒寫',
      body: 'completion evidence 不可寫到 Run 外。', skipGenerate: true,
    }),
  });
  const normalSuccessLogFailure = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'dapan', owner: 'normal-partial-smoke', title: '正常 success log fail',
      body: 'log 寫入失敗不可破壞 durable done transition。', skipGenerate: true,
    }),
  });
  const normalQueuedBehind = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'dapan', owner: 'normal-partial-smoke', title: '不得越過 detached gate',
      body: '前一支 fallback 尚未安全前不能執行。', skipGenerate: true,
    }),
  });
  await stopTestServer(child);
  const armNormalRender = (run, approvedAt) => {
    const runDir = path.join(normalWorkerDir, 'jobs', run.job.id);
    const runFile = path.join(runDir, 'job.json');
    const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    record.status = 'approved';
    record.approvedAt = approvedAt;
    record.approvedBy = 'smoke';
    fs.writeFileSync(runFile, JSON.stringify(record, null, 2));
    fs.mkdirSync(path.join(runDir, 'state'), { recursive: true });
  };
  const workerEnv = {
    DATA_DIR: normalWorkerDir,
    ENABLE_TEST_WORKER: '1',
    TEST_PIPELINE_ENTRY: normalWorkerEntry,
    SMOKE_PIPELINE_MP4: normalWorkerFixtureMp4,
    SMOKE_PIPELINE_INVOCATIONS: normalWorkerInvocations,
  };
  armNormalRender(normalPartial, '2001-01-01T00:00:00.000Z');
  child = startTestServer({ ...workerEnv, SMOKE_PIPELINE_MODE: 'partial-log-fail' });
  const normalWorkerReady = await waitForReady(child);
  assert.equal(normalWorkerReady.workerEnabled, true);
  base = `http://127.0.0.1:${normalWorkerReady.port}`;
  const normalPartialResult = await waitForJobStatus(base, normalPartial.job.id, 'review');
  assert.match(normalPartialResult.job.error, /可人工確認後重新出片/);
  assert.equal(normalPartialResult.job.outputs.length, 1);
  const normalFallback = path.join(normalWorkerDir, 'jobs', normalPartial.job.id,
    'out', normalPartialResult.job.outputs[0].name);
  assert.match(normalPartialResult.job.outputs[0].name,
    /^[0-9a-f-]{36}-output-dapan\.mp4$/);
  assert.equal(fs.existsSync(normalFallback), true);
  assert.deepEqual(fs.readFileSync(normalFallback), MP4_FIXTURE);
  const normalPartialProject = await request(base,
    `/api/projects/${normalPartial.job.projectId}?revision=${normalPartial.job.revisionId}`);
  assert.equal(normalPartialProject.revision.status, 'review');
  assert.equal(fs.readdirSync(path.join(normalWorkerDir, 'projects', normalPartial.job.projectId,
    'outputs')).length, 0);
  assert.equal(fs.lstatSync(path.join(normalWorkerDir, 'jobs', normalPartial.job.id,
    'log.txt')).isDirectory(), true);

  // Retrying the same Revision receives a fresh workspace token. A different valid partial output
  // must be preserved under a second filename instead of colliding with the first attempt and
  // permanently closing the queue.
  await stopTestServer(child);
  const normalPartialLog = path.join(normalWorkerDir, 'jobs', normalPartial.job.id, 'log.txt');
  fs.rmSync(normalPartialLog, { recursive: true, force: true });
  fs.writeFileSync(normalPartialLog, 'retry after verified log failure\n');
  armNormalRender(normalPartial, '2001-01-01T00:00:15.000Z');
  child = startTestServer({
    ...workerEnv,
    SMOKE_PIPELINE_MODE: 'partial',
    SMOKE_PIPELINE_MP4: normalWorkerRetryFixtureMp4,
  });
  const normalRetryReady = await waitForReady(child);
  base = `http://127.0.0.1:${normalRetryReady.port}`;
  const normalRetryResult = await waitForJobStatus(base, normalPartial.job.id, 'review');
  assert.match(normalRetryResult.job.error, /可人工確認後重新出片/);
  assert.equal(normalRetryResult.job.outputs.length, 1);
  assert.notEqual(normalRetryResult.job.outputs[0].name, normalPartialResult.job.outputs[0].name);
  const normalRetryFallback = path.join(normalWorkerDir, 'jobs', normalPartial.job.id,
    'out', normalRetryResult.job.outputs[0].name);
  assert.deepEqual(fs.readFileSync(normalFallback), MP4_FIXTURE);
  assert.deepEqual(fs.readFileSync(normalRetryFallback), FRAGMENTED_MP4_FIXTURE);
  assert.equal(fs.readdirSync(path.dirname(normalFallback)).filter(
    (name) => name.endsWith('-output-dapan.mp4')).length, 2);
  const normalRetryPlayback = await fetch(base
    + `/api/jobs/${normalPartial.job.id}/file/${normalRetryResult.job.outputs[0].name}`);
  assert.equal(normalRetryPlayback.status, 200);
  assert.deepEqual(Buffer.from(await normalRetryPlayback.arrayBuffer()), FRAGMENTED_MP4_FIXTURE);

  await stopTestServer(child);
  armNormalRender(normalPipelineSymlink, '2001-01-01T00:00:30.000Z');
  const unsafePipeline = path.join(normalWorkerDir, 'jobs', normalPipelineSymlink.job.id, 'pipeline');
  const outsideNormalPipeline = path.join(normalWorkerDir, 'outside-normal-pipeline');
  fs.mkdirSync(outsideNormalPipeline, { recursive: true });
  fs.symlinkSync(outsideNormalPipeline, unsafePipeline, 'dir');
  const failedLogPath = path.join(normalWorkerDir, 'jobs', normalPipelineSymlink.job.id, 'log.txt');
  fs.rmSync(failedLogPath, { recursive: true, force: true });
  fs.mkdirSync(failedLogPath);
  child = startTestServer(workerEnv);
  const normalPipelineReady = await waitForReady(child);
  base = `http://127.0.0.1:${normalPipelineReady.port}`;
  const normalPipelineResult = await waitForJobStatus(base, normalPipelineSymlink.job.id, 'failed');
  assert.match(normalPipelineResult.job.error, /pipeline evidence 目錄 ownership/);
  const normalPipelineProject = await request(base,
    `/api/projects/${normalPipelineSymlink.job.projectId}`
      + `?revision=${normalPipelineSymlink.job.revisionId}`);
  assert.equal(normalPipelineProject.revision.status, 'failed');
  assert.deepEqual(fs.readdirSync(outsideNormalPipeline), []);
  assert.equal(fs.readFileSync(normalWorkerInvocations, 'utf8').trim().split('\n').length, 2);

  await stopTestServer(child);
  armNormalRender(normalSuccessLogFailure, '2001-01-01T00:00:45.000Z');
  child = startTestServer({ ...workerEnv, SMOKE_PIPELINE_MODE: 'success-log-fail' });
  const normalSuccessReady = await waitForReady(child);
  base = `http://127.0.0.1:${normalSuccessReady.port}`;
  const normalSuccessResult = await waitForJobStatus(base, normalSuccessLogFailure.job.id, 'done');
  assert.equal(normalSuccessResult.job.outputs.length, 2);
  assert.equal(Object.hasOwn(normalSuccessResult.job, 'archived'), false);
  const normalSuccessStored = JSON.parse(fs.readFileSync(path.join(normalWorkerDir, 'jobs',
    normalSuccessLogFailure.job.id, 'job.json'), 'utf8'));
  assert.equal(normalSuccessStored.archived.length, 2);
  const normalSuccessProject = await request(base,
    `/api/projects/${normalSuccessLogFailure.job.projectId}`
      + `?revision=${normalSuccessLogFailure.job.revisionId}`);
  assert.equal(normalSuccessProject.revision.status, 'done');
  assert.equal(normalSuccessProject.revision.outputs.length, 2);
  assert.equal(normalSuccessProject.project.revisions.find(
    (item) => item.id === normalSuccessLogFailure.job.revisionId).status, 'done');
  assert.equal(fs.readdirSync(path.join(normalWorkerDir, 'projects',
    normalSuccessLogFailure.job.projectId, 'outputs')).length, 2);
  assert.equal(fs.lstatSync(path.join(normalWorkerDir, 'jobs', normalSuccessLogFailure.job.id,
    'log.txt')).isDirectory(), true);
  assert.equal(fs.readFileSync(normalWorkerInvocations, 'utf8').trim().split('\n').length, 3);

  const renderRetryDraft = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'default', owner: 'render-retry-smoke', title: 'Render retry fixture',
      body: 'Render 失敗時只重跑同一份 plan 與 manifest。',
      workflowMode: 'auto-broll', controlPolicy: 'auto',
    }),
  });
  await request(base, `/api/jobs/${renderRetryDraft.job.id}/upload?name=heygen.mp4`, {
    method: 'POST', body: MP4_FIXTURE,
  });

  await stopTestServer(child);
  const renderRetryJobDir = path.join(normalWorkerDir, 'jobs', renderRetryDraft.job.id);
  const renderRetryJobFile = path.join(renderRetryJobDir, 'job.json');
  const renderRetryRecord = JSON.parse(fs.readFileSync(renderRetryJobFile, 'utf8'));
  renderRetryRecord.status = 'failed';
  renderRetryRecord.stage = 'rendering';
  renderRetryRecord.failedStage = 'rendering';
  renderRetryRecord.error = 'fixture render failure';
  renderRetryRecord.renderInputManifestSha256 = 'a'.repeat(64);
  fs.writeFileSync(renderRetryJobFile, JSON.stringify(renderRetryRecord, null, 2));
  fs.mkdirSync(path.join(renderRetryJobDir, 'state'), { recursive: true });
  child = startTestServer({ DATA_DIR: normalWorkerDir });
  const retryApiReady = await waitForReady(child);
  base = `http://127.0.0.1:${retryApiReady.port}`;
  const retried = await request(base, `/api/jobs/${renderRetryDraft.job.id}/retry`, { method: 'POST' });
  assert.equal(retried.job.status, 'approved');
  assert.equal(retried.job.id, renderRetryDraft.job.id);
  assert.equal(retried.job.revisionId, renderRetryDraft.job.revisionId);
  assert.equal(fs.readFileSync(normalWorkerInvocations, 'utf8').trim().split('\n').length, 3);
  const duplicateRetry = await fetch(base + `/api/jobs/${renderRetryDraft.job.id}/retry`, {
    method: 'POST',
  });
  assert.equal(duplicateRetry.status, 409);
  const retriedProject = await request(base,
    `/api/projects/${renderRetryDraft.job.projectId}?revision=${renderRetryDraft.job.revisionId}`);
  assert.equal(retriedProject.revision.status, 'approved');
  await request(base, `/api/jobs/${renderRetryDraft.job.id}/cancel`, { method: 'POST' });
  await stopTestServer(child);

  const activeCancelSignal = path.join(normalWorkerDir, 'active-cancel-signal.log');
  child = startTestServer({
    ...workerEnv,
    SMOKE_PIPELINE_MODE: 'wait',
    SMOKE_PIPELINE_SIGNAL: activeCancelSignal,
  });
  const activeCancelReady = await waitForReady(child);
  base = `http://127.0.0.1:${activeCancelReady.port}`;
  const activeAuto = await request(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'default', owner: 'active-cancel-smoke', title: '執行中停止測試',
      body: '執行中的自動圖卡流程必須先停止 process，再標記取消。',
      workflowMode: 'auto-broll', controlPolicy: 'auto',
    }),
  });
  await request(base, `/api/jobs/${activeAuto.job.id}/upload?name=heygen.mp4`, {
    method: 'POST', body: MP4_FIXTURE,
  });
  await request(base, `/api/jobs/${activeAuto.job.id}/submit`, { method: 'POST' });
  const activeDeadline = Date.now() + 10000;
  while (Date.now() < activeDeadline) {
    const invocationCount = fs.existsSync(normalWorkerInvocations)
      ? fs.readFileSync(normalWorkerInvocations, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    if (invocationCount >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const activeBeforeCancel = await request(base, `/api/jobs/${activeAuto.job.id}`);
  assert.equal(activeBeforeCancel.job.status, 'preparing');
  const activeCancelResponse = await fetch(base + `/api/jobs/${activeAuto.job.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(activeCancelResponse.status, 202);
  const stoppingJob = (await activeCancelResponse.json()).job;
  assert.equal(stoppingJob.status, 'preparing');
  assert.ok(stoppingJob.cancelRequestedAt);
  const activeCancelled = await waitForJobStatus(base, activeAuto.job.id, 'cancelled');
  assert.ok(activeCancelled.job.cancelledAt);
  assert.equal(fs.readFileSync(activeCancelSignal, 'utf8').trim(), 'SIGTERM');
  assert.equal(fs.existsSync(path.join(normalWorkerDir, 'jobs', activeAuto.job.id, 'state')), true);
  assert.match(fs.readFileSync(normalWorkerInvocations, 'utf8').trim().split('\n').at(-1),
    /--stop-before-render.*--graphic-broll=card-v1/);
  const activeCancelledProject = await request(base,
    `/api/projects/${activeAuto.job.projectId}?revision=${activeAuto.job.revisionId}`);
  assert.equal(activeCancelledProject.revision.status, 'cancelled');

  await stopTestServer(child);
  armNormalRender(normalUnsafeFallback, '2001-01-01T00:01:00.000Z');
  armNormalRender(normalQueuedBehind, '2001-01-01T00:02:00.000Z');
  const unsafeRunOut = path.join(normalWorkerDir, 'jobs', normalUnsafeFallback.job.id, 'out');
  const outsideNormalOut = path.join(normalWorkerDir, 'outside-normal-run-out');
  fs.mkdirSync(outsideNormalOut, { recursive: true });
  fs.rmSync(unsafeRunOut, { recursive: true, force: true });
  fs.symlinkSync(outsideNormalOut, unsafeRunOut, 'dir');
  child = startTestServer(workerEnv);
  const normalFailClosedReady = await waitForReady(child);
  base = `http://127.0.0.1:${normalFailClosedReady.port}`;
  const normalUnsafeResult = await waitForJobStatus(base, normalUnsafeFallback.job.id, 'detached');
  assert.match(normalUnsafeResult.job.error, /fallback 尚未保存/);
  const queuedBehindResult = await request(base, `/api/jobs/${normalQueuedBehind.job.id}`);
  assert.equal(queuedBehindResult.job.status, 'approved');
  assert.equal(fs.readFileSync(normalWorkerInvocations, 'utf8').trim().split('\n').length, 5);
  await stopTestServer(child);

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
  console.log('✅ detached 停止請求先持久化；spawn intent 不誤殺，owner token 相符且 process 停止後才 cancelled');
  console.log('✅ stale lock／PID reuse gate：live unrelated process 不會收到停止訊號');
  console.log('✅ detached render evidence：單／雙／選配輸出、partial fallback、archive retry、owner gate 與 idempotent restart');
  console.log('✅ 正常 render non-zero/partial：durable fallback 後回待確認；fallback 失敗維持 queue gate');
  console.log('✅ active auto-broll cancel：先 202/停止中，owned process 收到 SIGTERM 且關閉後才 cancelled，快照保留');
  console.log('✅ render retry endpoint：同一 Run／Revision 回 approved，duplicate 409，worker 未重跑 prepare');
  console.log('✅ success／partial／failed 的 log 寫入失敗不影響 durable Job／Revision transition');
  console.log('✅ job.json atomic、半完成 terminal transition 啟動修復、pipeline/out symlink fail closed');
  console.log('✅ 成功 Project Run 立即清 payload；Project 素材、Revision、成品與下一版仍可用');
  console.log('✅ Project durable gate 不可由 retention 繞過；archive 缺失時保留完整 payload');
  console.log('✅ 未知／活躍 lock 不可由 API 強制刪除');
  console.log('✅ LAN bind 未明確 opt-in 時拒絕啟動');
  console.log('✅ TEST_MODE 拒絕 repo 內路徑與 symlink 回指');
  console.log('✅ provider keys 為空、預設 worker 停用；受限 fixture worker 無 outbound/provider 嘗試');
  console.log('✅ repo mutable workspace 前後一致');
}

main()
  .catch((error) => {
    console.error('❌ smoke test 失敗：' + error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    for (const auxiliary of AUXILIARY_CHILDREN) {
      try { auxiliary.kill('SIGTERM'); } catch (_) {}
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
