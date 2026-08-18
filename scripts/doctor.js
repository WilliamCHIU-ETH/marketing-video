#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const full = process.argv.includes('--full');
const json = process.argv.includes('--json');
const checks = [];

try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) {}

function add(scope, status, name, detail) {
  checks.push({ scope, status, name, detail });
}

function commandExists(name) {
  const r = spawnSync('sh', ['-lc', `command -v "${name}"`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim();
}

function requireFromRoot(name) {
  try {
    require.resolve(name, { paths: [ROOT] });
    return true;
  } catch (_) {
    return false;
  }
}

function validFontFile(file) {
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    if (fs.readSync(fd, magic, 0, magic.length, 0) !== magic.length) return false;
    const ascii = magic.toString('ascii');
    return magic.equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))
      || ['OTTO', 'ttcf', 'true', 'wOFF', 'wOF2'].includes(ascii);
  } finally {
    fs.closeSync(fd);
  }
}

for (const rel of [
  'package.json',
  'package-lock.json',
  'server/index.js',
  'server/public/index.html',
  'run.js',
]) {
  add('startup', fs.existsSync(path.join(ROOT, rel)) ? 'pass' : 'fail', rel,
    fs.existsSync(path.join(ROOT, rel)) ? '存在' : '缺少必要檔案');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
add('startup', nodeMajor >= 20 ? (nodeMajor === 22 ? 'pass' : 'warn') : 'fail', 'Node.js',
  `v${process.versions.node}；專案目標為 Node 22 LTS`);

for (const name of ['npm', 'ffmpeg', 'ffprobe', 'whisper', 'tesseract']) {
  const found = commandExists(name);
  const scope = name === 'npm' ? 'install' : 'pipeline';
  add(scope, found ? 'pass' : 'fail', name, found ? found : '找不到 command');
}

if (commandExists('tesseract')) {
  const langs = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
  const available = String(langs.stdout || '').split(/\s+/).includes('chi_tra');
  add('pipeline', available ? 'pass' : 'fail', 'tesseract:chi_tra',
    available ? '繁體中文語言資料可用' : '缺少 chi_tra；請安裝 tesseract-lang');
}

for (const name of ['dotenv', 'opencc-js', 'react', 'react-dom', 'remotion', 'typescript']) {
  add('install', requireFromRoot(name) ? 'pass' : 'fail', `package:${name}`,
    requireFromRoot(name) ? '可解析' : '未安裝；請執行 npm ci');
}

for (const rel of ['public/NotoSansTC-Regular.ttf', 'public/NotoSansTC-Bold.ttf']) {
  const file = path.join(ROOT, rel);
  add('pipeline', validFontFile(file) ? 'pass' : 'fail', rel,
    fs.existsSync(file) ? '檔案不是有效的 OpenType/TrueType/WOFF 字型' : '缺少可重現渲染所需字型');
}

for (const { name, required } of [
  { name: 'HEYGEN_API_KEY', required: true },
  { name: 'MINIMAX_API_KEY', required: false },
  { name: 'MINIMAX_GROUP_ID', required: false },
  { name: 'OPENAI_API_KEY', required: false },
]) {
  add('provider', process.env[name] ? 'pass' : (required ? 'fail' : 'warn'), name,
    process.env[name]
      ? '已設定（內容未顯示）'
      : required ? '完整 HeyGen 生成流程必要；不影響 localhost/smoke' : '未設定；選用功能才需要');
}

for (const rel of ['.env', '.google-creds.json']) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    add('security', 'pass', rel, '候選 repo 未包含');
    continue;
  }
  const mode = fs.statSync(file).mode & 0o777;
  add('security', (mode & 0o077) === 0 ? 'pass' : 'fail', rel,
    `permissions ${mode.toString(8)}；應為 600`);
}

const startupReady = !checks.some((c) => c.scope === 'startup' && c.status === 'fail');
const fullReady = !checks.some((c) => c.status === 'fail');

if (json) {
  console.log(JSON.stringify({ startupReady, fullReady, checks }, null, 2));
} else {
  const icon = { pass: '✅', warn: '⚠️ ', fail: '❌' };
  for (const c of checks) console.log(`${icon[c.status]} [${c.scope}] ${c.name}: ${c.detail}`);
  console.log('');
  console.log(`localhost 啟動：${startupReady ? 'READY' : 'BLOCKED'}`);
  console.log(`完整出片鏈：${fullReady ? 'READY' : 'BLOCKED'}（不影響本 milestone 的免費 smoke test）`);
}

process.exitCode = (full ? !fullReady : !startupReady) ? 1 : 0;
