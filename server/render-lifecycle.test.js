'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('reviewed plan edits rebuild evidence before the shared workspace is restored', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const start = source.indexOf('async function doRender(job)');
  const end = source.indexOf('\n// ── HTTP', start);
  assert.ok(start >= 0 && end > start, 'doRender source must remain inspectable');
  const body = source.slice(start, end);
  const apply = body.indexOf('applyPlanEdits(job, job.pendingEdits)');
  const capture = body.indexOf('captureAutomationEvidence(job)', apply);
  const restore = body.indexOf('restoreWorkspace(job)', capture);
  const verify = body.indexOf('verifyRestoredRenderInput(job)', restore);
  assert.ok(apply >= 0 && capture > apply && restore > capture && verify > restore,
    'reviewed bytes must produce new evidence, then be restored and verified in that order');
  assert.equal(body.match(/restoreWorkspace\(job\)/g)?.length, 1,
    'doRender must not restore stale snapshot bytes before reviewed edits are captured');
});
