'use strict';

/**
 * Provider 版本的單一來源是 config/chipk-capture-provider.lock.json。
 *
 * 為什麼要測：`server/public/index.html` 的 prepared-video 驗證曾經寫死
 * `result.providerVersion !== '0.3.0'`。lock 升到 0.3.1 之後，合法取得的
 * Contract v2 evidence 會被前台判成不成立——後端通過、前台說沒有，而且沒有任何錯誤訊息。
 * 同型的寫死也出現過在 `scripts/prepared-phone-material-plan.js`（回 intent_incompatible，
 * 看起來完全不像版本問題）與四支測試的 fixture。
 *
 * 這組測試擋的就是「有人又把版本抄一次」。它不檢查版本值是什麼，
 * 只檢查**除了 lock 以外沒有第二個地方寫得出版本**。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(APP_ROOT, 'config', 'chipk-capture-provider.lock.json');
const LOCK = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));

// 語意版本樣式。刻意不釘特定值——釘了就變成第二個需要維護的地方。
const SEMVER = /(?<![\w.-])v?\d+\.\d+\.\d+(?![\w.-])/g;

const read = (rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');

/** 去掉註解與 npm 套件版本，只留真正宣告 provider 版本的地方。 */
function providerVersionLiterals(source, { stripComments = true } = {}) {
  let text = source;
  if (stripComments) {
    text = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*(\/\/|#|\*).*$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }
  return [...text.matchAll(SEMVER)].map((m) => m[0]);
}

test('lock 自己帶著版本，其餘欄位齊全', () => {
  assert.equal(typeof LOCK.toolVersion, 'string');
  assert.match(LOCK.toolVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(LOCK.providerId, 'chipk-simulator-capture');
  assert.equal(typeof LOCK.readyToPlaceProfileId, 'string');
  assert.equal(typeof LOCK.readyToPlaceLiveEnabled, 'boolean');
});

test('前台不含任何 provider 版本 literal', () => {
  const found = providerVersionLiterals(read('server/public/index.html'));
  assert.deepEqual(found, [],
    `server/public/index.html 出現版本字串 ${found.join('、')}；` +
    '版本判定要從 /api/health 的 providerLock 派生，不要寫死。');
});

test('前台的驗證函式吃的是派生值', () => {
  const html = read('server/public/index.html');
  const fn = html.slice(html.indexOf('function verifiedPreparedPhoneTimelineEvidence'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const field of ['providerId', 'toolVersion', 'readyToPlaceContractVersion',
    'readyToPlaceProfileId']) {
    assert.ok(body.includes(`PROVIDER_LOCK.${field}`),
      `verifiedPreparedPhoneTimelineEvidence 應該用 PROVIDER_LOCK.${field}，不是 literal`);
  }
});

test('server 把 lock 的識別欄位吐給前台', () => {
  const src = read('server/index.js');
  assert.ok(src.includes('providerLock: {'), '/api/health 應該回傳 providerLock');
  for (const field of ['providerId', 'toolVersion', 'readyToPlaceContractVersion',
    'readyToPlaceProfileId', 'readyToPlaceLiveEnabled']) {
    assert.ok(new RegExp(`${field}: PROVIDER_LOCK\\.${field}`).test(src),
      `providerLock.${field} 應該從 PROVIDER_LOCK 派生`);
  }
  assert.ok(!src.includes('PROVIDER_LOCK.release'),
    'release 欄位不要吐給前台——那是釋出身分，不是前台需要的判定依據');
});

test('正式程式碼的版本閘跟著 lock 走', () => {
  const found = providerVersionLiterals(read('scripts/prepared-phone-material-plan.js'));
  assert.deepEqual(found, [],
    `prepared-phone-material-plan.js 出現版本字串 ${found.join('、')}；` +
    '這裡寫死過 0.3.0，升版時會回 intent_incompatible 而不是版本錯誤。');
});

test('測試 fixture 也不得自己宣告版本', () => {
  for (const rel of [
    'scripts/chipk-capture-cli-adapter.test.js',
    'scripts/material-acquisition-preflight.test.js',
    'scripts/material-acquisition-runtime.test.js',
    'scripts/prepared-phone-material.test.js',
    'scripts/smoke-server.js',
  ]) {
    const found = providerVersionLiterals(read(rel));
    assert.deepEqual(found, [],
      `${rel} 出現版本字串 ${found.join('、')}；fixture 要從 lock 讀。`);
  }
});

test('文件指向 lock，不重複版本號', () => {
  const offenders = [];
  for (const rel of [
    'AGENTS.md',
    'docs/operator-runbook.md',
    'docs/architecture/chipk-capture-compatibility.md',
    '.env.example',
  ]) {
    const found = providerVersionLiterals(read(rel), { stripComments: false });
    if (found.length) offenders.push(`${rel}（${found.join('、')}）`);
  }
  // 一次列出全部，不要第一個就丟——分批修比逐個修快。
  assert.deepEqual(offenders, [],
    `這些文件複述了版本：${offenders.join('；')}。` +
    '改成指向 config/chipk-capture-provider.lock.json。');
});
