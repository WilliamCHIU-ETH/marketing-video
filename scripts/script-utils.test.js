const test = require('node:test');
const assert = require('node:assert/strict');
const { getTitleText } = require('./script-utils');

test('getTitleText reads the historical three-part script title', () => {
  assert.equal(getTitleText('===\n仁寶漲停後\n===\n早安，投資人。'), '仁寶漲停後');
});

test('getTitleText reads the UI four-part script title instead of the reserved empty section', () => {
  const script = '櫃買→櫃賣\n===\n===\n仁寶漲停後還能追嗎\n===\n早安，投資人。';
  assert.equal(getTitleText(script), '仁寶漲停後還能追嗎');
});

test('getTitleText preserves the legacy plain-script fallback', () => {
  assert.equal(getTitleText('沒有分隔符的歷史腳本'), '沒有分隔符的歷史腳本');
});
