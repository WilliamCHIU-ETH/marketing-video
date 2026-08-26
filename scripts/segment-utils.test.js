'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { cleanBodyWithIndex } = require('./script-utils');
const {
  imagePattern,
  findImageMarkerBlocks,
  alignMarkerBlocksToTimes,
  mergeSegmentAudioClips,
} = require('./segment-utils');

test('exported imagePattern preserves parse-script marker syntax and block origIdx', () => {
  const body = '前言(image1:top,w=720)甲乙。(image1)中段(image12)丙丁(image12)';
  const matches = [...body.matchAll(new RegExp(imagePattern.source, imagePattern.flags))];
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((match) => [match[1], match[2] || null, match[3]]), [
    ['1', 'top,w=720', '甲乙。'],
    ['12', null, '丙丁'],
  ]);
  const blocks = findImageMarkerBlocks(body);
  assert.deepEqual(blocks.map((block) => ({
    markerIndex: block.markerIndex,
    text: body.slice(block.contentStartOrigIdx, block.contentEndOrigIdx),
  })), [
    { markerIndex: 1, text: '甲乙。' },
    { markerIndex: 12, text: '丙丁' },
  ]);
});

test('marker blocks use current origIdx while ASR seconds remain bound by clean index', () => {
  const body = '(image1)甲乙(image1)，(image2)丙丁(image2)';
  const cleanedChars = cleanBodyWithIndex(body);
  const charTimes = [
    { i: 0, ch: '甲', origIdx: 0, start: 1, end: 1.2 },
    { i: 1, ch: '乙', origIdx: 1, start: 1.2, end: 1.5 },
    { i: 2, ch: '丙', origIdx: 3, start: 2, end: 2.2 },
    { i: 3, ch: '丁', origIdx: 4, start: 2.2, end: 2.5 },
  ];
  const segments = alignMarkerBlocksToTimes({
    blocks: findImageMarkerBlocks(body),
    cleanedChars,
    charTimes,
    durationSec: 3,
    audioSrc: 'public/input-video.mp4',
    previousSegments: [{ id: '01', anchor: '甲', responsibility: '第一段' }],
  });
  assert.deepEqual(segments, [
    {
      id: '01', markerIndex: 1, startSec: 1, endSec: 2, durationSec: 1,
      charRange: [0, 1], text: '甲乙',
      audio: { src: 'public/input-video.mp4', start: 1, end: 2 },
      anchor: '甲', responsibility: '第一段',
    },
    {
      id: '02', markerIndex: 2, startSec: 2, endSec: 3, durationSec: 1,
      charRange: [2, 3], text: '丙丁',
      audio: { src: 'public/input-video.mp4', start: 2, end: 3 },
    },
  ]);
});

test('audio clips merge only across continuous timeline and source ranges', () => {
  const segment = (id, src, start, end, mediaStart = start, mediaEnd = end) => ({
    id, startSec: start, endSec: end, audio: { src, start: mediaStart, end: mediaEnd },
  });
  assert.deepEqual(mergeSegmentAudioClips([
    segment('01', 'avatar.mp4', 1, 2),
    segment('02', 'avatar.mp4', 2.01, 3, 2.01, 3),
  ]), [{
    src: 'avatar.mp4', timelineStart: 1, timelineEnd: 3,
    mediaStart: 1, mediaEnd: 3, segmentIds: ['01', '02'],
  }]);

  const split = mergeSegmentAudioClips([
    segment('01', 'a.mp4', 0, 1),
    segment('02', 'b.mp4', 1, 2),
    segment('03', 'b.mp4', 2, 3, 4, 5),
  ]);
  assert.equal(split.length, 3);
});

test('single all-avatar clip can preserve the legacy full-ledger envelope', () => {
  const clips = mergeSegmentAudioClips([
    { id: '01', startSec: 1.85, endSec: 8.06,
      audio: { src: 'public/input-video.mp4', start: 1.85, end: 8.06 } },
    { id: '02', startSec: 8.06, endSec: 60.505,
      audio: { src: 'public/input-video.mp4', start: 8.06, end: 60.505 } },
  ], { durationSec: 60.505, extendSingleClipToDuration: true });
  assert.deepEqual(clips, [{
    src: 'public/input-video.mp4', timelineStart: 0, timelineEnd: 60.505,
    mediaStart: 0, mediaEnd: 60.505, segmentIds: ['01', '02'], extendedToDuration: true,
  }]);
});
