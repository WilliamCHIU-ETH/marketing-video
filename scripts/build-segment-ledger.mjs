#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require('./script-utils');
const { findImageMarkerBlocks, alignMarkerBlocksToTimes } = require('./segment-utils');
const {
  resolveExistingPath,
  resolveExistingWithin,
  resolveOutputWithin,
} = require('./path-safety');

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
    if (!['project', 'script', 'charTimes', 'out', 'audioSrc'].includes(key))
      throw new Error(`不認得參數：--${rawKey}`);
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith('--')) throw new Error(`--${rawKey} 缺值`);
    options[key] = value;
  }
  if (!options.project || !path.isAbsolute(options.project)) throw new Error('--project 必須是絕對路徑');
  return options;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} 不是合法 JSON：${error.message}`); }
}

function defaultAudioSrc(projectDir) {
  const avatarDir = path.join(projectDir, 'avatar');
  if (fs.existsSync(avatarDir)) {
    resolveExistingPath(avatarDir, 'avatar/', 'directory');
    const files = fs.readdirSync(avatarDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink()
        && /\.(mp4|mov|webm)$/i.test(entry.name));
    if (files.length === 1) return `avatar/${files[0].name}`;
    if (files.length > 1) throw new Error('avatar/ 有多個影音檔，請用 --audio-src 明確指定');
  }
  resolveExistingWithin(projectDir, 'public/input-video.mp4', 'public/input-video.mp4', 'file');
  return 'public/input-video.mp4';
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
  const projectDir = resolveExistingPath(options.project, '--project', 'directory');
  const scriptFile = resolveExistingWithin(projectDir, options.script, '--script', 'file');
  const charTimesFile = resolveExistingWithin(projectDir, options.charTimes, '--char-times', 'file');
  const outFile = resolveOutputWithin(projectDir, options.out, '--out');

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

  const previousPath = 'segment-ledger.json';
  const previousFile = path.join(projectDir, previousPath);
  const previous = fs.existsSync(previousFile)
    ? readJson(resolveExistingWithin(projectDir, previousPath, previousPath, 'file'), previousPath)
    : {};
  const rawAudioSrc = String(options.audioSrc || defaultAudioSrc(projectDir));
  if (rawAudioSrc.includes('\\')) throw new Error('--audio-src 不可使用反斜線');
  const audioSrc = rawAudioSrc.split(path.sep).join('/');
  const audioFile = resolveExistingWithin(projectDir, audioSrc, '--audio-src', 'file');
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
    visualSegments: segments.filter((segment) => segment.visual?.mode !== 'none').length,
    audioSrc,
  }, null, 2));
  return ledger;
}

try { main(); }
catch (error) {
  console.error(`build-segment-ledger: ${error.message}`);
  process.exitCode = 1;
}
