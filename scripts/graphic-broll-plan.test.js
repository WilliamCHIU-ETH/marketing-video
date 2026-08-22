'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanBodyWithIndex, getBodyAfterVoice } = require('./script-utils');
const {
  createGraphicBrollPlan,
  disabledPlan,
  parseArgs,
  run,
} = require('./graphic-broll-plan');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureTimes(length) {
  return Array.from({ length }, (_, index) => ({
    start: Number((index * 0.08).toFixed(3)),
    end: Number((index * 0.08 + 0.12).toFixed(3)),
  }));
}

function scriptChars(scriptRaw) {
  return cleanBodyWithIndex(getBodyAfterVoice(scriptRaw));
}

test('card-v1 is deterministic and every displayed character comes from cleaned script', () => {
  const scriptRaw = [
    '台積電→台積電',
    '===',
    '===',
    '# 不會進入圖卡',
    '(image1:top)台積電今日開高，成交量同步放大。(image1)',
    '[盤勢]',
    '電子權值股領漲，金融股維持整理。',
    '(text:忽略標記)市場仍關注晚間數據。(/text)',
    '投資人留意風險控管，分批調整部位。',
  ].join('\n');
  const chars = scriptChars(scriptRaw);
  const subtitles = { _scriptCharTimes: fixtureTimes(chars.length) };
  const first = createGraphicBrollPlan({ scriptRaw, subtitles });
  const second = createGraphicBrollPlan({ scriptRaw, subtitles });

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.mode, 'card-v1');
  assert.equal(first.style, 'morning-report-v1');
  assert.equal(first.sourceScriptSha256, sha256(scriptRaw));
  assert.ok(first.cards.length >= 1 && first.cards.length <= 3);

  const cleaned = chars.map((item) => item.char).join('');
  for (const card of first.cards) {
    assert.equal(
      card.headline + card.body,
      cleaned.slice(card.startCharIdx, card.endCharIdx + 1),
    );
    assert.deepEqual(card.resolvedPlacement, {
      startSec: subtitles._scriptCharTimes[card.startCharIdx].start,
      endSec: subtitles._scriptCharTimes[card.endCharIdx].end,
    });
  }
});

test('selection is bounded, ordered and non-overlapping across a long morning report', () => {
  const scriptRaw = `===\n===\n${Array.from(
    { length: 12 },
    (_, index) => `第${index + 1}段晨報內容包含今日市場重要觀察與風險提醒。`,
  ).join('\n')}`;
  const chars = scriptChars(scriptRaw);
  const plan = createGraphicBrollPlan({
    scriptRaw,
    subtitles: { _scriptCharTimes: fixtureTimes(chars.length) },
  });

  assert.equal(plan.cards.length, 3);
  for (let index = 1; index < plan.cards.length; index += 1) {
    assert.ok(plan.cards[index].startCharIdx > plan.cards[index - 1].endCharIdx);
    assert.ok(
      plan.cards[index].resolvedPlacement.startSec >=
        plan.cards[index - 1].resolvedPlacement.endSec,
    );
  }
});

test('64-char chunk boundary sharing one Whisper timing never emits overlapping cards', () => {
  const scriptRaw = `===\n===\n${'晨報市場觀察'.repeat(12)}。`;
  const chars = scriptChars(scriptRaw);
  assert.ok(chars.length > 64 && chars.length < 128);
  const times = Array.from({ length: chars.length }, (_, index) => ({
    start: index * 0.1,
    end: index * 0.1 + 0.1,
  }));
  // 模擬第 64/65 個 script char 同屬一個 Whisper word。
  times[64] = { ...times[63] };
  for (let index = 65; index < times.length; index += 1) {
    const start = times[index - 1].end;
    times[index] = { start, end: start + 0.1 };
  }

  const plan = createGraphicBrollPlan({ scriptRaw, subtitles: { _scriptCharTimes: times } });
  assert.ok(plan.cards.length >= 1);
  for (let index = 1; index < plan.cards.length; index += 1) {
    assert.ok(plan.cards[index].resolvedPlacement.startSec
      >= plan.cards[index - 1].resolvedPlacement.endSec);
  }
});

test('card-v1 fails closed for empty content, char-time drift or unresolved timing', () => {
  assert.throws(
    () => createGraphicBrollPlan({ scriptRaw: '===\n===\n，。', subtitles: { _scriptCharTimes: [] } }),
    (error) => error.code === 'empty_cleaned_script',
  );

  const scriptRaw = '===\n===\n今日市場震盪整理。';
  const chars = scriptChars(scriptRaw);
  assert.throws(
    () => createGraphicBrollPlan({ scriptRaw, subtitles: { _scriptCharTimes: [] } }),
    (error) => error.code === 'char_times_mismatch',
  );

  const invalidTimes = fixtureTimes(chars.length);
  invalidTimes[2] = { start: 0, end: 0 };
  assert.throws(
    () => createGraphicBrollPlan({ scriptRaw, subtitles: { _scriptCharTimes: invalidTimes } }),
    (error) => error.code === 'unresolved_card',
  );
});

test('forced-alignment script-extra zero-width timing is allowed inside a playable card', () => {
  const scriptRaw = '===\n===\n今日AI市場焦點明確。';
  const chars = scriptChars(scriptRaw);
  const times = fixtureTimes(chars.length);
  const extraIndex = chars.findIndex((item) => item.char === 'A');
  assert.ok(extraIndex > 0);
  times[extraIndex] = {
    start: times[extraIndex - 1].end,
    end: times[extraIndex - 1].end,
  };
  // 後一字從相同時間接續，維持 forced-alignment 的單調 timing contract。
  times[extraIndex + 1] = {
    start: times[extraIndex].end,
    end: Number((times[extraIndex].end + 0.12).toFixed(3)),
  };
  for (let index = extraIndex + 2; index < times.length; index += 1) {
    const start = times[index - 1].end;
    times[index] = { start, end: Number((start + 0.12).toFixed(3)) };
  }

  const plan = createGraphicBrollPlan({ scriptRaw, subtitles: { _scriptCharTimes: times } });
  assert.ok(plan.cards.length >= 1);
  assert.ok(plan.cards.every((card) => card.resolvedPlacement.endSec > card.resolvedPlacement.startSec));
});

test('disabled mode always emits an empty plan and does not require subtitles', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphic-broll-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'missing-script.txt');
  const outputPath = path.join(root, 'generated', 'plan.json');

  const result = run(['--mode', 'disabled', '--script', scriptPath, '--out', outputPath]);
  assert.deepEqual(result, disabledPlan(''));
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), result);
});

test('failed card-v1 invocation overwrites a stale active plan with disabled', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphic-broll-fail-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'script.txt');
  const subtitlesPath = path.join(root, 'subtitles.json');
  const outputPath = path.join(root, 'plan.json');
  const scriptRaw = '===\n===\n今日市場震盪整理。';
  fs.writeFileSync(scriptPath, scriptRaw);
  fs.writeFileSync(subtitlesPath, JSON.stringify({ _scriptCharTimes: [] }));
  fs.writeFileSync(outputPath, JSON.stringify({ mode: 'card-v1', cards: [{ stale: true }] }));

  assert.throws(
    () => run([
      '--mode=card-v1',
      `--script=${scriptPath}`,
      `--subtitles=${subtitlesPath}`,
      `--out=${outputPath}`,
    ]),
    (error) => error.code === 'char_times_mismatch',
  );
  const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(saved.mode, 'disabled');
  assert.deepEqual(saved.cards, []);
  assert.equal(saved.sourceScriptSha256, sha256(scriptRaw));
});

test('missing card-v1 script also clears a stale active plan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphic-broll-missing-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, 'plan.json');
  fs.writeFileSync(outputPath, JSON.stringify({ mode: 'card-v1', cards: [{ stale: true }] }));

  assert.throws(() => run([
    '--mode=card-v1',
    `--script=${path.join(root, 'missing.txt')}`,
    `--subtitles=${path.join(root, 'missing.json')}`,
    `--out=${outputPath}`,
  ]), (error) => error.code === 'ENOENT');
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), disabledPlan(''));
});

test('parseArgs supports explicit mode and both option syntaxes', () => {
  const parsed = parseArgs([
    '--mode=disabled',
    '--script', './one.txt',
    '--subtitles=./two.json',
    '--out', './three.json',
  ]);
  assert.equal(parsed.mode, 'disabled');
  assert.equal(parsed.scriptPath, path.resolve('./one.txt'));
  assert.equal(parsed.subtitlesPath, path.resolve('./two.json'));
  assert.equal(parsed.outputPath, path.resolve('./three.json'));
});
