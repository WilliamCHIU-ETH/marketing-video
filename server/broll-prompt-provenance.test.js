'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  attachRecordedBrollPrompts,
  readProjectBrollPrompts,
} = require('./broll-prompt-provenance');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeProvenance(projectDir, revision, slots) {
  const directory = path.join(projectDir, `broll-v${revision}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'broll-provenance.json'), JSON.stringify({
    schemaVersion: 2,
    slots,
  }));
}

test('attaches only digest-verified Project prompt provenance without mutating Revision data', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-prompts-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const assetSha256 = sha256('rendered-broll');
  const promptText = '970×740 的深海軍藍資訊圖卡，呈現台股支撐。';
  writeProvenance(projectDir, '2', [{
    outputSha256: assetSha256,
    promptText,
    promptSha256: sha256(`${promptText}\n`),
  }]);
  const graphicBroll = {
    schemaVersion: 1,
    cards: [
      { id: 'broll-01', assetSha256 },
      { id: 'broll-02', assetSha256: sha256('unrecorded') },
    ],
  };
  const before = JSON.stringify(graphicBroll);

  const attached = attachRecordedBrollPrompts({ projectDir, graphicBroll });

  assert.equal(JSON.stringify(graphicBroll), before);
  assert.deepEqual(attached.cards[0].prompt, {
    status: 'recorded',
    text: promptText,
    sha256: sha256(`${promptText}\n`),
    sourceRevisionId: 'v002',
  });
  assert.deepEqual(attached.cards[1].prompt, { status: 'missing' });
});

test('fails closed for invalid digests and conflicting prompt records', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-prompts-conflict-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const conflictingAsset = sha256('conflicting-output');
  const invalidAsset = sha256('invalid-output');
  writeProvenance(projectDir, '2', [
    { outputSha256: conflictingAsset, promptText: '第一份 Prompt', promptSha256: sha256('第一份 Prompt') },
    { outputSha256: invalidAsset, promptText: '未通過雜湊', promptSha256: sha256('different') },
  ]);
  writeProvenance(projectDir, '3', [
    { outputSha256: conflictingAsset, promptText: '第二份 Prompt', promptSha256: sha256('第二份 Prompt') },
  ]);

  const prompts = readProjectBrollPrompts(projectDir);

  assert.equal(prompts.has(conflictingAsset), false);
  assert.equal(prompts.has(invalidAsset), false);
});

test('does not follow a symlinked provenance file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-prompts-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const outside = path.join(root, 'outside.json');
  const directory = path.join(projectDir, 'broll-v002');
  const assetSha256 = sha256('symlink-output');
  const promptText = '不應讀取';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(outside, JSON.stringify({
    schemaVersion: 2,
    slots: [{ outputSha256: assetSha256, promptText, promptSha256: sha256(promptText) }],
  }));
  fs.symlinkSync(outside, path.join(directory, 'broll-provenance.json'));

  assert.equal(readProjectBrollPrompts(projectDir).size, 0);
});
