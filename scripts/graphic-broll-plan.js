#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  cleanBodyWithIndex,
  getBodyAfterVoice,
} = require('./script-utils');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const DEFAULT_SUBTITLES_PATH = path.join(ROOT, 'src', 'subtitles.json');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'src', 'graphic-broll.generated.json');
const SCHEMA_VERSION = 1;
const CARD_MODE = 'card-v1';
const DISABLED_MODE = 'disabled';
const STYLE = 'morning-report-v1';
const MAX_CARDS = 3;
const MAX_CARD_CHARS = 64;
const HEADLINE_CHARS = 18;

class GraphicBrollPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GraphicBrollPlanError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseOption(argv, name) {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function parseArgs(argv) {
  const mode = argv.includes('--disabled')
    ? DISABLED_MODE
    : (parseOption(argv, '--mode') || CARD_MODE);
  if (mode !== CARD_MODE && mode !== DISABLED_MODE) {
    throw new GraphicBrollPlanError(
      'invalid_mode',
      `--mode 只支援 ${CARD_MODE} 或 ${DISABLED_MODE}（收到：${mode}）`,
    );
  }
  return {
    mode,
    scriptPath: path.resolve(parseOption(argv, '--script') || DEFAULT_SCRIPT_PATH),
    subtitlesPath: path.resolve(parseOption(argv, '--subtitles') || DEFAULT_SUBTITLES_PATH),
    outputPath: path.resolve(parseOption(argv, '--out') || DEFAULT_OUTPUT_PATH),
  };
}

function disabledPlan(scriptRaw = '') {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: DISABLED_MODE,
    style: STYLE,
    sourceScriptSha256: sha256(scriptRaw),
    cards: [],
  };
}

function splitIntoCandidateRanges(chars) {
  const sentenceRanges = [];
  let start = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (!chars[index].breakAfter && index !== chars.length - 1) continue;
    if (index >= start) sentenceRanges.push({ start, end: index });
    start = index + 1;
  }

  const chunks = [];
  for (const range of sentenceRanges) {
    for (let chunkStart = range.start; chunkStart <= range.end; chunkStart += MAX_CARD_CHARS) {
      chunks.push({
        start: chunkStart,
        end: Math.min(range.end, chunkStart + MAX_CARD_CHARS - 1),
      });
    }
  }

  const substantial = chunks.filter((range) => range.end - range.start + 1 >= 4);
  return substantial.length > 0 ? substantial : chunks;
}

function selectEvenly(ranges, maxCards = MAX_CARDS) {
  if (ranges.length <= maxCards) return ranges;
  return Array.from({ length: maxCards }, (_, index) => {
    const selectedIndex = Math.floor(((index + 0.5) * ranges.length) / maxCards);
    return ranges[selectedIndex];
  });
}

function validateCharTimes(charTimes, charCount) {
  if (!Array.isArray(charTimes) || charTimes.length !== charCount) {
    throw new GraphicBrollPlanError(
      'char_times_mismatch',
      `subtitles._scriptCharTimes 必須與 cleaned script 等長（${charTimes?.length ?? 0}/${charCount}）`,
    );
  }
}

function resolvePlacement(charTimes, startCharIdx, endCharIdx) {
  const range = charTimes.slice(startCharIdx, endCharIdx + 1);
  if (range.length !== endCharIdx - startCharIdx + 1) {
    throw new GraphicBrollPlanError('unresolved_card', '圖卡字元範圍超出字幕時間軸');
  }

  let previousStart = -1;
  let previousEnd = -1;
  for (const timing of range) {
    if (
      !timing ||
      !Number.isFinite(timing.start) ||
      !Number.isFinite(timing.end) ||
      timing.start < 0 ||
      timing.end < timing.start ||
      timing.start < previousStart ||
      timing.end < previousEnd
    ) {
      throw new GraphicBrollPlanError(
        'unresolved_card',
        `圖卡字元範圍 [${startCharIdx}, ${endCharIdx}] 含無效或逆序時間戳`,
      );
    }
    previousStart = timing.start;
    previousEnd = timing.end;
  }

  // Forced alignment 會把「音訊裡沒有、但講稿裡存在」的 script-extra 字元記成
  // zero-width timing（start === end）。這是合法 evidence，不能讓整張 card 失敗；
  // placement 仍必須由範圍內第一個／最後一個有實際時長的字元界定。
  const firstAudible = range.find((timing) => timing.end > timing.start);
  const lastAudible = [...range].reverse().find((timing) => timing.end > timing.start);
  if (!firstAudible || !lastAudible || lastAudible.end <= firstAudible.start) {
    throw new GraphicBrollPlanError(
      'unresolved_card',
      `圖卡字元範圍 [${startCharIdx}, ${endCharIdx}] 沒有可播放的時間區間`,
    );
  }

  return {
    startSec: Number(firstAudible.start.toFixed(3)),
    endSec: Number(lastAudible.end.toFixed(3)),
  };
}

function createCard(chars, charTimes, range, index) {
  const text = chars
    .slice(range.start, range.end + 1)
    .map((item) => item.char)
    .join('');
  if (!text) {
    throw new GraphicBrollPlanError('empty_card', 'deterministic planner 產生了空圖卡');
  }
  return {
    id: `graphic-broll-${String(index + 1).padStart(2, '0')}`,
    headline: text.slice(0, HEADLINE_CHARS),
    body: text.slice(HEADLINE_CHARS),
    startCharIdx: range.start,
    endCharIdx: range.end,
    resolvedPlacement: range.resolvedPlacement
      || resolvePlacement(charTimes, range.start, range.end),
  };
}

function resolveNonOverlappingRanges(ranges, charTimes) {
  const accepted = [];
  let previousEndSec = -1;
  for (const range of ranges) {
    const resolvedPlacement = resolvePlacement(charTimes, range.start, range.end);
    // Whisper 的一個 word timing 可能對應多個 script char。若 64-char chunk boundary
    // 切在同一個 word 裡，兩個候選會重疊；保留前一個完整 chunk、略過重疊候選，
    // 讓 planner 產物在寫檔前就符合 timeline 的非重疊 contract。
    if (resolvedPlacement.startSec < previousEndSec) continue;
    accepted.push({ ...range, resolvedPlacement });
    previousEndSec = resolvedPlacement.endSec;
  }
  return accepted;
}

function createGraphicBrollPlan({ scriptRaw, subtitles, mode = CARD_MODE }) {
  if (typeof scriptRaw !== 'string') {
    throw new GraphicBrollPlanError('invalid_script', 'scriptRaw 必須是字串');
  }
  if (mode === DISABLED_MODE) return disabledPlan(scriptRaw);
  if (mode !== CARD_MODE) {
    throw new GraphicBrollPlanError('invalid_mode', `不支援的圖卡模式：${mode}`);
  }

  const chars = cleanBodyWithIndex(getBodyAfterVoice(scriptRaw));
  if (chars.length === 0) {
    throw new GraphicBrollPlanError('empty_cleaned_script', '講稿清洗後沒有可生成圖卡的內容');
  }
  const charTimes = subtitles?._scriptCharTimes;
  validateCharTimes(charTimes, chars.length);
  const ranges = selectEvenly(resolveNonOverlappingRanges(
    splitIntoCandidateRanges(chars),
    charTimes,
  ));
  if (ranges.length === 0) {
    throw new GraphicBrollPlanError('empty_card_plan', 'card-v1 至少必須產生一張圖卡');
  }

  const cards = ranges.map((range, index) => createCard(chars, charTimes, range, index));
  if (cards.length === 0) {
    throw new GraphicBrollPlanError('empty_card_plan', 'card-v1 至少必須產生一張圖卡');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: CARD_MODE,
    style: STYLE,
    sourceScriptSha256: sha256(scriptRaw),
    cards,
  };
}

function writePlan(outputPath, plan) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`);
  fs.renameSync(temporaryPath, outputPath);
}

function readScript(scriptPath, mode) {
  if (mode === DISABLED_MODE && !fs.existsSync(scriptPath)) return '';
  return fs.readFileSync(scriptPath, 'utf8');
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let scriptRaw = '';
  try {
    scriptRaw = readScript(args.scriptPath, args.mode);
    if (args.mode === DISABLED_MODE) {
      const plan = disabledPlan(scriptRaw);
      writePlan(args.outputPath, plan);
      return plan;
    }
    const subtitles = JSON.parse(fs.readFileSync(args.subtitlesPath, 'utf8'));
    const plan = createGraphicBrollPlan({ scriptRaw, subtitles, mode: args.mode });
    writePlan(args.outputPath, plan);
    return plan;
  } catch (error) {
    // Fail closed: a failed automated plan must not leave a previous Run's cards active.
    writePlan(args.outputPath, disabledPlan(scriptRaw));
    throw error;
  }
}

if (require.main === module) {
  try {
    const plan = run();
    console.log(
      `Graphic B-roll plan: mode=${plan.mode}, cards=${plan.cards.length}, out=${parseArgs(process.argv.slice(2)).outputPath}`,
    );
  } catch (error) {
    console.error(`Graphic B-roll planner 失敗 [${error.code || 'unknown'}]: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  CARD_MODE,
  DISABLED_MODE,
  STYLE,
  GraphicBrollPlanError,
  createGraphicBrollPlan,
  disabledPlan,
  parseArgs,
  resolvePlacement,
  resolveNonOverlappingRanges,
  run,
  selectEvenly,
  splitIntoCandidateRanges,
  writePlan,
};
