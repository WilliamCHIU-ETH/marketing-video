#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.resolve(__dirname, 'read-asr-env.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-asr-env-'));
const envFile = path.join(tempDir, '.env');
fs.writeFileSync(envFile, [
  'WHISPER_MODEL_PATH=.cache/whisper/custom.bin',
  'WHISPER_THREADS=7',
  'HEYGEN_API_KEY=must-not-be-readable',
  '',
].join('\n'));

function read(key, extraEnv = {}) {
  return spawnSync(process.execPath, [script, key, envFile], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

assert.strictEqual(read('WHISPER_MODEL_PATH').stdout, '.cache/whisper/custom.bin');
assert.strictEqual(read('WHISPER_THREADS').stdout, '7');
assert.strictEqual(read('WHISPER_THREADS', { WHISPER_THREADS: '9' }).stdout, '9');
assert.notStrictEqual(read('HEYGEN_API_KEY').status, 0);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('✅ ASR .env reader tests passed');
