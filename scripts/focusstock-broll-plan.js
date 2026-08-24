#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateFocusstockBrollCarryPlan } = require(
  '../server/focusstock-broll-carry-forward');

const DEFAULT_OUTPUT = path.resolve(
  __dirname, '..', 'src', 'Focusstock', 'focusstock-broll.generated.json');

function disabledPlan() {
  return {
    schemaVersion: 2,
    mode: 'disabled',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    fps: 30,
    intervalSemantics: 'frame-half-open',
    sourceScriptSha256: null,
    parent: null,
    prepared: null,
    cards: [],
  };
}

function parseArgs(argv) {
  const values = new Map();
  let check = false;
  for (const arg of argv) {
    if (arg === '--check') check = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const split = arg.indexOf('=');
      values.set(arg.slice(2, split), arg.slice(split + 1));
    } else throw new Error(`不支援的 Focusstock B-roll 參數：${arg}`);
  }
  const mode = values.get('mode') || 'disabled';
  const out = path.resolve(values.get('out') || DEFAULT_OUTPUT);
  if (!['disabled', 'carried-v1'].includes(mode))
    throw new Error(`Focusstock B-roll mode 不合法：${mode}`);
  if (mode === 'disabled' && check)
    throw new Error('disabled mode 不接受 --check');
  if (mode === 'carried-v1' && !check)
    throw new Error('carried-v1 只能驗證既有 canonical plan，不可在 render 階段重算');
  return { mode, out, check };
}

function atomicWrite(file, bytes) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'disabled') {
    const canonical = JSON.stringify(disabledPlan());
    atomicWrite(options.out, canonical);
    return { mode: options.mode, file: options.out, canonical };
  }
  let raw;
  let plan;
  try {
    raw = fs.readFileSync(options.out, 'utf8');
    plan = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Focusstock carried B-roll plan 無法讀取：${error.message}`);
  }
  validateFocusstockBrollCarryPlan(plan);
  const canonical = JSON.stringify(plan);
  if (raw !== canonical)
    throw new Error('Focusstock carried B-roll plan 不是 canonical bytes');
  return { mode: options.mode, file: options.out, canonical };
}

if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { DEFAULT_OUTPUT, disabledPlan, parseArgs, run };
