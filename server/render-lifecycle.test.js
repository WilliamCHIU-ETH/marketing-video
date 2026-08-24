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
  const baseline = body.indexOf('validateReviewedPreparedPlanBaseline(job,');
  const transaction = body.indexOf('beginPreparedPhoneReviewEditTransaction({', baseline);
  const apply = body.indexOf('applyPlanEdits(job, job.pendingEdits)', transaction);
  const capture = body.indexOf('captureAutomationEvidence(job, null, {', apply);
  const handoff = body.indexOf("job.status = 'approved'", capture);
  const handoffSave = body.indexOf('saveJob(job)', handoff);
  const commit = body.indexOf('finalizePreparedPhoneReviewEditTransaction({', handoffSave);
  const restore = body.indexOf('restoreWorkspace(job)', commit);
  const verify = body.indexOf('verifyRestoredRenderInput(job)', restore);
  assert.ok(baseline >= 0 && transaction > baseline && apply > transaction && capture > apply
    && handoff > capture && handoffSave > handoff && commit > handoffSave
    && restore > commit && verify > restore,
  'journal cleanup must follow the durable approved handoff and precede restore verification');
  assert.equal(body.slice(0, transaction).includes('saveJob(job)'), false,
    'rendering must not become durable without a workspace intent token');
  assert.equal(body.slice(apply, capture).includes('job.pendingEdits = []'), false,
    'a pre-commit compile failure must retain the baseline pending edits for recovery');
  assert.equal(body.match(/restoreWorkspace\(job\)/g)?.length, 1,
    'doRender must not restore stale snapshot bytes before reviewed edits are captured');

  const baselineStart = source.indexOf('function validateReviewedPreparedPlanBaseline(job, state)');
  const baselineEnd = source.indexOf('\nfunction verifyRestoredRenderInput(job)', baselineStart);
  const baselineBody = source.slice(baselineStart, baselineEnd);
  for (const requiredCheck of [
    'validatePreparedFocusstockAssetRefs({',
    'validatePreparedPhoneProjectAsset({ job, projectStore: PROJECT_STORE })',
    'validatePreparedPhonePlanForJob(job, state)',
    'validateFocusstockVisualTimelinePlacements(',
    'buildJobRenderInput(job, state)',
  ]) {
    assert.ok(baselineBody.includes(requiredCheck),
      `review baseline must retain ${requiredCheck}`);
  }

  const captureStart = source.indexOf('function captureAutomationEvidence(');
  const captureEnd = source.indexOf('\nfunction validateReviewedPreparedPlanBaseline(', captureStart);
  const captureBody = source.slice(captureStart, captureEnd);
  assert.ok(captureBody.indexOf('pendingEdits: job.pendingEdits')
    < captureBody.indexOf('try {'));
  assert.ok(captureBody.indexOf('job.pendingEdits = previous.pendingEdits')
    < captureBody.indexOf('try { saveJob(job); } catch (_) {}'),
  'capture rollback must restore pending edits before persisting the baseline evidence');

  const pipelineStart = source.indexOf('function runPipeline(job, args)');
  const pipelineEnd = source.indexOf('\n// ── 配圖計畫', pipelineStart);
  const pipelineBody = source.slice(pipelineStart, pipelineEnd);
  const token = pipelineBody.indexOf('job.workspaceRunToken = workspaceRunToken');
  const runStatus = pipelineBody.indexOf('job.workspaceRunStatus = job.status', token);
  const intentSave = pipelineBody.indexOf('saveJob(job)', runStatus);
  const spawn = pipelineBody.indexOf('spawn(process.execPath', intentSave);
  assert.ok(token >= 0 && runStatus > token && intentSave > runStatus && spawn > intentSave,
    'the first durable rendering handoff must include token and run status before spawn');
});
