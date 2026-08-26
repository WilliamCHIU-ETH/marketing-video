'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { cleanBodyWithIndex } = require('./script-utils');
const {
  imagePattern,
  parseImageOptions,
  findImageMarkerBlocks,
  alignMarkerBlocksToTimes,
  mergeSegmentAudioClips,
} = require('./segment-utils');

function timed(cleanedChars, starts) {
  return cleanedChars.map((item, index) => ({
    i: index,
    ch: item.char,
    origIdx: index,
    start: starts[index],
    end: starts[index] + 0.1,
  }));
}

test('shares one marker option grammar with cleaner', () => {
  const body = '前言(image1:fade-in)甲乙。(image1)中段(image12:top, w=720)丙丁(image12)';
  const matches = [...body.matchAll(new RegExp(imagePattern.source, imagePattern.flags))];
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((match) => [match[1], match[2] || null, match[3]]), [
    ['1', 'fade-in', '甲乙。'],
    ['12', 'top, w=720', '丙丁'],
  ]);
  assert.deepEqual(parseImageOptions('top, w=720'), { top: true, w: '720' });
  const blocks = findImageMarkerBlocks(body);
  assert.deepEqual(blocks.map((block) => ({
    markerIndex: block.markerIndex,
    text: body.slice(block.contentStartOrigIdx, block.contentEndOrigIdx),
  })), [
    { markerIndex: 1, text: '甲乙。' },
    { markerIndex: 12, text: '丙丁' },
  ]);
});

test('rejects unowned clean chars between marker blocks', () => {
  const body = '(image1)甲(image1)未標(image2)乙(image2)';
  const cleanedChars = cleanBodyWithIndex(body);
  assert.throws(() => alignMarkerBlocksToTimes({
    blocks: findImageMarkerBlocks(body),
    cleanedChars,
    charTimes: timed(cleanedChars, [1, 2, 3, 4]),
    durationSec: 5,
    audioSrc: 'public/input-video.mp4',
  }), /未被 image marker 覆蓋.*clean index 1–2：「未標」/);
});

test('defines punctuation/newline/full-width-space boundary ownership', () => {
  const body = '(image1)甲(image1)，\n　(image2:top, w=720)乙(image2)';
  const cleanedChars = cleanBodyWithIndex(body);
  const segments = alignMarkerBlocksToTimes({
    blocks: findImageMarkerBlocks(body),
    cleanedChars,
    charTimes: timed(cleanedChars, [0, 2]),
    durationSec: 3,
    audioSrc: 'public/input-video.mp4',
  });
  assert.deepEqual(segments.map(({ id, startSec, endSec, text }) => ({ id, startSec, endSec, text })), [
    { id: '01', startSec: 0, endSec: 2, text: '甲' },
    { id: '02', startSec: 2, endSec: 3, text: '乙' },
  ]);
  const punctuationOnly = '(image1)，\n　(image1)(image2)乙(image2)';
  const punctuationChars = cleanBodyWithIndex(punctuationOnly);
  assert.throws(() => alignMarkerBlocksToTimes({
    blocks: findImageMarkerBlocks(punctuationOnly),
    cleanedChars: punctuationChars,
    charTimes: timed(punctuationChars, [0]),
    durationSec: 1,
    audioSrc: 'public/input-video.mp4',
  }), /image1 內容沒有 clean chars/);
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
      visual: { mode: 'broll' }, anchor: '甲', responsibility: '第一段',
    },
    {
      id: '02', markerIndex: 2, startSec: 2, endSec: 3, durationSec: 1,
      charRange: [2, 3], text: '丙丁',
      audio: { src: 'public/input-video.mp4', start: 2, end: 3 },
      visual: { mode: 'broll' },
    },
  ]);
});

test('explicit visual:none greeting owns the leading envelope', () => {
  const body = '(image0:visual=none)早安(image0)(image1)甲(image1)';
  const cleanedChars = cleanBodyWithIndex(body);
  const segments = alignMarkerBlocksToTimes({
    blocks: findImageMarkerBlocks(body),
    cleanedChars,
    charTimes: timed(cleanedChars, [0.2, 0.4, 1.2]),
    durationSec: 2,
    audioSrc: 'avatar.mp4',
  });
  assert.deepEqual(segments[0], {
    id: '00', markerIndex: 0, startSec: 0, endSec: 1.2, durationSec: 1.2,
    charRange: [0, 1], text: '早安', audio: { src: 'avatar.mp4', start: 0, end: 1.2 },
    visual: { mode: 'none' },
  });
});

test('durationSec always equals endSec minus startSec', () => {
  const body = '(image1)甲(image1)';
  const cleanedChars = cleanBodyWithIndex(body);
  const [segment] = alignMarkerBlocksToTimes({
    blocks: findImageMarkerBlocks(body),
    cleanedChars,
    charTimes: timed(cleanedChars, [0]),
    durationSec: 1,
    audioSrc: 'avatar.mp4',
    previousSegments: [{ id: '01', durationSec: 1.009 }],
  });
  assert.equal(segment.durationSec, 1);
  assert.equal(segment.durationSec, Number((segment.endSec - segment.startSec).toFixed(4)));
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

test('does not synthesize an unowned leading envelope', () => {
  const clips = mergeSegmentAudioClips([
    { id: '01', startSec: 5, endSec: 10, audio: { src: 'a.mp4', start: 5, end: 10 } },
  ]);
  assert.deepEqual(clips, [{
    src: 'a.mp4', timelineStart: 5, timelineEnd: 10,
    mediaStart: 5, mediaEnd: 10, segmentIds: ['01'],
  }]);
});

test('defines leading gap for multiple sources without source-dependent expansion', () => {
  const clips = mergeSegmentAudioClips([
    { id: '01', startSec: 1.85, endSec: 2, audio: { src: 'a.mp4', start: 1.85, end: 2 } },
    { id: '02', startSec: 2, endSec: 3, audio: { src: 'b.mp4', start: 0, end: 1 } },
  ]);
  assert.equal(clips[0].timelineStart, 1.85);
  assert.equal(clips[1].timelineStart, 2);
});
