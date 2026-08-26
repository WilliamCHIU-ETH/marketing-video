#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require('./script-utils');
const { findImageMarkerBlocks, alignMarkerBlocksToTimes } = require('./segment-utils');

function parseArgs(argv) {
  const options = {
    script: 'script/script.v1.txt',
    charTimes: 'asr/script-char-times.json',
    out: 'segment-ledger.json',
    audioSrc: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`不認得參數：${token}`);
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith('--')) throw new Error(`--${rawKey} 缺值`);
    options[key] = value;
  }
  if (!options.project || !path.isAbsolute(options.project)) throw new Error('--project 必須是絕對路徑');
  return options;
}

function assertRegularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`找不到 ${label}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 不是一般檔案`);
  return stat;
}

function projectPath(projectDir, relative, label) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} 必須是 project 相對路徑`);
  const resolved = path.resolve(projectDir, relative);
  const rel = path.relative(projectDir, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error(`${label} 超出 project`);
  return resolved;
}

function readJson(file, label) {
  assertRegularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} 不是合法 JSON：${error.message}`); }
}

function defaultAudioSrc(projectDir) {
  const avatarDir = path.join(projectDir, 'avatar');
  if (fs.existsSync(avatarDir)) {
    const stat = fs.lstatSync(avatarDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('avatar/ 不是安全目錄');
    const files = fs.readdirSync(avatarDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink()
        && /\.(mp4|mov|webm)$/i.test(entry.name));
    if (files.length === 1) return `avatar/${files[0].name}`;
    if (files.length > 1) throw new Error('avatar/ 有多個影音檔，請用 --audio-src 明確指定');
  }
  const fallback = 'public/input-video.mp4';
  assertRegularFile(path.join(projectDir, fallback), fallback);
  return fallback;
}

function probeDuration(file) {
  try {
    return Number(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { encoding: 'utf8' }).trim());
  } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const projectDir = fs.realpathSync(options.project);
  const projectStat = fs.lstatSync(projectDir);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error('--project 不是安全目錄');

  const scriptFile = projectPath(projectDir, options.script, '--script');
  const charTimesFile = projectPath(projectDir, options.charTimes, '--char-times');
  const outFile = projectPath(projectDir, options.out, '--out');
  assertRegularFile(scriptFile, options.script);
  const scriptRaw = fs.readFileSync(scriptFile, 'utf8');
  const bodyAfterVoice = getBodyAfterVoice(scriptRaw);
  const cleanedChars = cleanBodyWithIndex(bodyAfterVoice);
  const blocks = findImageMarkerBlocks(bodyAfterVoice);
  if (!blocks.length) throw new Error('腳本沒有 (imageN)…(imageN) 標記');
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index].markerIndex <= blocks[index - 1].markerIndex)
      throw new Error('image marker index 必須依腳本順序遞增');
  }

  const charTimesRaw = readJson(charTimesFile, options.charTimes);
  const charTimes = Array.isArray(charTimesRaw) ? charTimesRaw : charTimesRaw.list;
  if (!Array.isArray(charTimes)) throw new Error('--char-times 必須是陣列或 {list:[]}');

  const previousFile = path.join(projectDir, 'segment-ledger.json');
  const previous = fs.existsSync(previousFile) ? readJson(previousFile, 'segment-ledger.json') : {};
  const audioSrc = String(options.audioSrc || defaultAudioSrc(projectDir)).split(path.sep).join('/');
  const audioFile = projectPath(projectDir, audioSrc, '--audio-src');
  assertRegularFile(audioFile, audioSrc);
  const durationSec = Number(previous.durationSec)
    || probeDuration(audioFile)
    || Number(charTimes.at(-1)?.end);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('無法決定 durationSec');

  const segments = alignMarkerBlocksToTimes({
    blocks,
    cleanedChars,
    charTimes,
    durationSec,
    audioSrc,
    previousSegments: previous.segments || [],
  });
  const ledger = {
    durationSec,
    visualForm: previous.visualForm || 'card',
    segments,
    ...(previous.fullframe ? { fullframe: previous.fullframe } : {}),
  };
  writeJsonAtomic(outFile, ledger);
  console.log(JSON.stringify({
    ok: true,
    project: projectDir,
    script: options.script,
    charTimes: options.charTimes,
    output: options.out,
    durationSec,
    segments: segments.length,
    audioSrc,
  }, null, 2));
  return ledger;
}

try { main(); }
catch (error) {
  console.error(`build-segment-ledger: ${error.message}`);
  process.exitCode = 1;
}
