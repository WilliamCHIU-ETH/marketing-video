'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ScriptTimelineResolverError,
  resolvePlacementStart,
  resolveUniquePhraseAnchor,
} = require('./script-timeline-resolver');

function script(body) {
  return `\n===\n===\n標題\n===\n${body}\n`;
}

test('full phrase start remains canonical when a suffix has a different char and frame', () => {
  const prefix = '甲'.repeat(253);
  const scriptRaw = script(`${prefix}開啟籌碼K線結尾`);
  const full = resolveUniquePhraseAnchor({ scriptRaw, phrase: '開啟籌碼K線' });
  const suffix = resolveUniquePhraseAnchor({ scriptRaw, phrase: '籌碼K線' });
  assert.equal(full.startCharIdx, 253);
  assert.equal(suffix.startCharIdx, 255);

  const charTimes = Array.from({ length: full.cleanedCharCount }, (_, index) => {
    const start = index < 253 ? index / 10 : 53.4 + ((index - 253) * 0.225);
    return { start, end: start + 0.1 };
  });
  const resolved = resolvePlacementStart({
    placement: { anchor: { phrase: '開啟籌碼K線', startCharIdx: 253 } },
    scriptRaw,
    subtitles: { _scriptCharTimes: charTimes },
    fps: 30,
  });
  assert.equal(resolved.requestedStartSec, 53.4);
  assert.equal(resolved.startFrame, 1602);
  assert.equal(Math.round(charTimes[255].start * 30), 1616);
  assert.throws(() => resolvePlacementStart({
    placement: { anchor: { phrase: '開啟籌碼K線', startCharIdx: 255 } },
    scriptRaw,
    subtitles: { _scriptCharTimes: charTimes },
    fps: 30,
  }), (error) => error instanceof ScriptTimelineResolverError
    && error.code === 'placement_anchor_mismatch');
});

test('resolver fails closed on ambiguous, missing, timeline-length, and timing drift', () => {
  assert.throws(() => resolveUniquePhraseAnchor({
    scriptRaw: script('開啟籌碼K線，再開啟籌碼K線。'), phrase: '開啟籌碼K線',
  }), (error) => error.code === 'placement_anchor_ambiguous');
  assert.throws(() => resolveUniquePhraseAnchor({
    scriptRaw: script('只有其他內容。'), phrase: '開啟籌碼K線',
  }), (error) => error.code === 'placement_anchor_not_found');

  const scriptRaw = script('前言開啟籌碼K線');
  const anchor = resolveUniquePhraseAnchor({ scriptRaw, phrase: '開啟籌碼K線' });
  const validTimes = Array.from({ length: anchor.cleanedCharCount }, (_, index) => ({
    start: index / 10,
    end: (index + 1) / 10,
  }));
  assert.throws(() => resolvePlacementStart({
    placement: { anchor }, scriptRaw,
    subtitles: { _scriptCharTimes: validTimes.slice(1) }, fps: 30,
  }), (error) => error.code === 'placement_timeline_drift');
  for (const invalidTiming of [
    { start: '0.2', end: 0.3 },
    { start: 0.2, end: null },
    { start: 0.2, end: 0.1 },
    { start: 0, end: 0 },
  ]) {
    const driftedTimes = validTimes.map((timing) => ({ ...timing }));
    driftedTimes[anchor.startCharIdx] = invalidTiming;
    assert.throws(() => resolvePlacementStart({
      placement: { anchor }, scriptRaw,
      subtitles: { _scriptCharTimes: driftedTimes }, fps: 30,
    }), (error) => error.code === 'placement_anchor_unresolved');
  }
});

test('explicit startSec is renderer-rounded without requiring script or subtitles', () => {
  assert.deepEqual(resolvePlacementStart({ placement: { startSec: 1.08 }, fps: 30 }), {
    fps: 30,
    requestedStartSec: 1.08,
    startFrame: 32,
    startSec: 1.066667,
  });
});
