#!/usr/bin/env node

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_KEYS = new Set([
  'WHISPER_MODEL_PATH',
  'WHISPER_MODEL_SHA256',
  'WHISPER_THREADS',
  'WHISPER_DEVICE',
]);

function readAsrEnv(key, envFile = path.join(ROOT, '.env')) {
  if (!ALLOWED_KEYS.has(key)) throw new Error(`不允許讀取 ASR 設定：${key}`);
  require('dotenv').config({ path: envFile, quiet: true });
  return process.env[key] || '';
}

if (require.main === module) {
  try {
    const key = process.argv[2];
    if (!key) throw new Error('用法：read-asr-env.js WHISPER_* [env-file]');
    process.stdout.write(readAsrEnv(key, process.argv[3]));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ALLOWED_KEYS, readAsrEnv };
