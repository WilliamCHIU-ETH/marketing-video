#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { captureCtaMaterial } = require('../server/material-acquisition-runtime');

const DISALLOWED_FLAGS = new Set([
  '--route-id', '--routeId', '--udid', '--chipk-capture-bin', '--request', '--capabilities',
]);
const HUMAN_ACTION_CODE = /(?:^|_)(?:auth(?:entication|orization)?|login|mfa|captcha|vip_session)(?:_|$)|(?:^|_)session_(?:expired|required|invalid)(?:_|$)/i;

class MaterialCommandError extends Error {
  constructor(message, code = 'invalid_arguments') {
    super(message);
    this.name = 'MaterialCommandError';
    this.code = code;
  }
}

function usage() {
  return 'Usage: npm run material -- capture-cta --project <absolute-project-path> --stock-id <stock-id> --json';
}

function optionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--'))
    throw new MaterialCommandError(`${flag} requires a value`);
  return value;
}

function parseCaptureCtaArgs(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'capture-cta')
    throw new MaterialCommandError('The only supported material command is capture-cta');
  const options = { projectPath: null, stockId: null, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const flag = typeof token === 'string' ? token.split('=', 1)[0] : '';
    if (DISALLOWED_FLAGS.has(flag))
      throw new MaterialCommandError(`${flag} is not allowed for capture-cta`);
    if (token === '--project') {
      if (options.projectPath !== null)
        throw new MaterialCommandError('--project may only be provided once');
      options.projectPath = optionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === '--stock-id') {
      if (options.stockId !== null)
        throw new MaterialCommandError('--stock-id may only be provided once');
      options.stockId = optionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === '--json') {
      if (options.json) throw new MaterialCommandError('--json may only be provided once');
      options.json = true;
      continue;
    }
    throw new MaterialCommandError(`Unsupported capture-cta argument: ${String(token)}`);
  }
  if (!options.projectPath) throw new MaterialCommandError('--project is required');
  if (!path.isAbsolute(options.projectPath))
    throw new MaterialCommandError('--project must be an absolute path');
  if (!options.stockId) throw new MaterialCommandError('--stock-id is required');
  if (!options.json) throw new MaterialCommandError('--json is required');
  return options;
}

function humanActionMessage(code) {
  const normalized = String(code || '').toLowerCase();
  if (normalized.includes('captcha'))
    return '請在 ChipK Simulator 完成 CAPTCHA 驗證後，再重新執行 capture-cta。';
  if (normalized.includes('mfa'))
    return '請在 ChipK Simulator 完成 MFA 驗證後，再重新執行 capture-cta。';
  if (normalized.includes('vip_session') || normalized.includes('session_'))
    return '請在 ChipK Simulator 重新登入並確認 VIP session 有效，再重新執行 capture-cta。';
  return '請在 ChipK Simulator 完成登入或授權後，再重新執行 capture-cta。';
}

function failedMessage(code) {
  if (code === 'provider_version_incompatible')
    return 'ChipK Capture provider 版本與 Marketing consumer lock 不符；請由維護者更新 lock 後重試。';
  if (code === 'provider_unavailable' || code === 'provider_unconfigured')
    return 'ChipK Capture provider 目前不可用；請確認 provider 已安裝並可由 Marketing runtime 啟動。';
  if (code === 'project_path_invalid' || code === 'project_output_invalid')
    return 'Project 或 CTA 輸出路徑不安全；未寫入任何 provider artifact。';
  return 'capture-cta 未完成；未將未驗證素材回報為 completed。';
}

function outcomeForError(error) {
  const code = typeof error?.code === 'string' && error.code
    ? error.code : 'capture_cta_failed';
  const typedStatus = error?.details?.status;
  if (typedStatus === 'human_action_required'
      || (typedStatus == null && HUMAN_ACTION_CODE.test(code))) {
    return {
      exitCode: 3,
      payload: {
        schemaVersion: 1,
        status: 'human_action_required',
        message: humanActionMessage(code),
        error: { code },
      },
    };
  }
  return {
    exitCode: 1,
    payload: {
      schemaVersion: 1,
      status: 'failed',
      message: failedMessage(code),
      error: { code },
    },
  };
}

async function execute(argv, { captureCta = captureCtaMaterial } = {}) {
  const options = parseCaptureCtaArgs(argv);
  return captureCta(options);
}

async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  captureCta = captureCtaMaterial,
} = {}) {
  let options;
  try {
    options = parseCaptureCtaArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  try {
    const result = await captureCta(options);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const outcome = outcomeForError(error);
    stdout.write(`${JSON.stringify(outcome.payload)}\n`);
    return outcome.exitCode;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    process.stderr.write(`capture-cta command failed unexpectedly: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DISALLOWED_FLAGS,
  MaterialCommandError,
  execute,
  main,
  outcomeForError,
  parseCaptureCtaArgs,
  usage,
};
