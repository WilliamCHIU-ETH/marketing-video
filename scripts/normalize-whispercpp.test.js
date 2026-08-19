#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { normalizeWhisperCpp } = require('./normalize-whispercpp');

const fixture = {
  result: { language: 'zh' },
  transcription: [
    {
      text: '營收年增九成',
      offsets: { from: 1000, to: 2600 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 1000, to: 1000 } },
        { text: '營收', offsets: { from: 1040, to: 1500 } },
        { text: '年增', offsets: { from: 1500, to: 2020 } },
        { text: '九成', offsets: { from: 2020, to: 2580 } },
        { text: '[_TT_0050]', offsets: { from: 2580, to: 2580 } },
      ],
    },
  ],
};

const normalized = normalizeWhisperCpp(fixture, {
  duration: 3,
  model: '/tmp/ggml-base-q5_1.bin',
});

assert.strictEqual(normalized.language, 'zh');
assert.strictEqual(normalized._asr.engine, 'whisper.cpp');
assert.strictEqual(normalized._asr.model, 'ggml-base-q5_1.bin');
assert.deepStrictEqual(normalized.segments[0].words, [
  { word: '營收', start: 1.04, end: 1.5 },
  { word: '年增', start: 1.5, end: 2.02 },
  { word: '九成', start: 2.02, end: 2.58 },
]);

assert.throws(
  () => normalizeWhisperCpp({ transcription: [{ offsets: { from: 0, to: 100 }, tokens: [] }] }),
  /沒有可用的 token timestamps/,
);

console.log('✅ whisper.cpp adapter tests passed');
