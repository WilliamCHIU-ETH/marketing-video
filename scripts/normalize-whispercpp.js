#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} 缺少值`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function seconds(ms, label) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 不是有效的毫秒時間碼`);
  return value / 1000;
}

function isWhisperControlToken(text) {
  return /^\[_.*\]$/.test(text.trim());
}

function normalizeWhisperCpp(input, options = {}) {
  if (!input || !Array.isArray(input.transcription)) {
    throw new Error('whisper.cpp JSON 缺少 transcription[]');
  }

  const duration = options.duration == null ? null : Number(options.duration);
  if (duration != null && (!Number.isFinite(duration) || duration <= 0)) {
    throw new Error('--duration 必須是正數秒數');
  }

  let previousStart = -1;
  let wordCount = 0;
  const segments = input.transcription.map((segment, segmentIndex) => {
    const segmentStart = seconds(segment?.offsets?.from, `segment ${segmentIndex} start`);
    const segmentEnd = seconds(segment?.offsets?.to, `segment ${segmentIndex} end`);
    if (segmentEnd < segmentStart) throw new Error(`segment ${segmentIndex} 結束早於開始`);

    const words = (Array.isArray(segment.tokens) ? segment.tokens : [])
      .filter((token) => typeof token?.text === 'string' && token.text.trim() && !isWhisperControlToken(token.text))
      .map((token, tokenIndex) => {
        const start = seconds(token?.offsets?.from, `segment ${segmentIndex} token ${tokenIndex} start`);
        const end = seconds(token?.offsets?.to, `segment ${segmentIndex} token ${tokenIndex} end`);
        if (end < start) throw new Error(`segment ${segmentIndex} token ${tokenIndex} 結束早於開始`);
        if (start < previousStart) throw new Error(`token timestamps 在 segment ${segmentIndex} 不是單調遞增`);
        if (duration != null && end > duration + 0.25) {
          throw new Error(`token timestamp ${end.toFixed(3)}s 超過影片長度 ${duration.toFixed(3)}s`);
        }
        previousStart = start;
        wordCount += 1;
        return { word: token.text, start, end };
      });

    return {
      start: segmentStart,
      end: segmentEnd,
      text: typeof segment.text === 'string' ? segment.text : words.map((word) => word.word).join(''),
      words,
    };
  });

  if (wordCount === 0) throw new Error('whisper.cpp JSON 沒有可用的 token timestamps');

  return {
    text: segments.map((segment) => segment.text).join('').trim(),
    segments,
    language: input?.result?.language || input?.params?.language || 'zh',
    _asr: {
      engine: 'whisper.cpp',
      model: options.model ? path.basename(options.model) : null,
      timingSource: 'token-offsets',
    },
  };
}

function writeJsonAtomic(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, outputPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error('用法：normalize-whispercpp.js --input raw.json --output subtitles.json [--duration 秒] [--model 路徑]');
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'));
  const normalized = normalizeWhisperCpp(input, { duration: args.duration, model: args.model });
  writeJsonAtomic(path.resolve(args.output), normalized);
  const words = normalized.segments.reduce((sum, segment) => sum + segment.words.length, 0);
  console.log(`✅ 已正規化 ${normalized.segments.length} segments / ${words} tokens → ${path.resolve(args.output)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { isWhisperControlToken, normalizeWhisperCpp, parseArgs };
