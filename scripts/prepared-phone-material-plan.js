#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ScriptTimelineResolverError,
  resolvePlacementStart: resolveScriptPlacementStart,
} = require('./script-timeline-resolver');

const ROOT = path.resolve(__dirname, '..');
const READY_MODE = 'ready-to-place';
const DISABLED_MODE = 'disabled';
const FPS = 30;
const DEFAULT_INTENT_PATH = path.join(ROOT, 'public', 'prepared-phone-material.intent.json');
const DEFAULT_VIDEO_PATH = path.join(ROOT, 'public', 'prepared-phone-material.mp4');
const DEFAULT_SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const DEFAULT_SUBTITLES_PATH = path.join(ROOT, 'src', 'subtitles.json');
const DEFAULT_VIDEO_META_PATH = path.join(ROOT, 'src', 'video-meta.json');
const DEFAULT_OUTPUT_PATH = path.join(
  ROOT, 'src', 'Focusstock', 'prepared-phone-material.generated.json');
const SHA256_HEX = /^[a-f0-9]{64}$/;

class PreparedPhonePlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreparedPhonePlanError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreparedPhonePlanError(code, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function parseOption(argv, name) {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseArgs(argv) {
  const mode = parseOption(argv, '--mode') || DISABLED_MODE;
  if (![READY_MODE, DISABLED_MODE].includes(mode))
    fail('invalid_mode', `--mode 只支援 ${READY_MODE} 或 ${DISABLED_MODE}`);
  return {
    mode,
    intentPath: path.resolve(parseOption(argv, '--intent') || DEFAULT_INTENT_PATH),
    videoPath: path.resolve(parseOption(argv, '--video') || DEFAULT_VIDEO_PATH),
    scriptPath: path.resolve(parseOption(argv, '--script') || DEFAULT_SCRIPT_PATH),
    subtitlesPath: path.resolve(parseOption(argv, '--subtitles') || DEFAULT_SUBTITLES_PATH),
    videoMetaPath: path.resolve(parseOption(argv, '--video-meta') || DEFAULT_VIDEO_META_PATH),
    outputPath: path.resolve(parseOption(argv, '--out') || DEFAULT_OUTPUT_PATH),
  };
}

function disabledPlan() {
  return {
    schemaVersion: 1,
    mode: DISABLED_MODE,
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    source: null,
    presentation: null,
    placement: null,
    visualOwnership: null,
  };
}

function inspectPreparedVideo(file) {
  let parsed;
  try {
    parsed = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration',
      '-of', 'json', path.resolve(file),
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 }));
  } catch (_) {
    fail('prepared_video_invalid', '無法解析 prepared phone MP4');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const video = videos[0];
  const durationSeconds = Number(video?.duration || parsed.format?.duration);
  if (videos.length !== 1 || audio.length !== 0 || video.codec_name !== 'h264'
      || !Number.isInteger(Number(video.width)) || Number(video.width) < 1
      || !Number.isInteger(Number(video.height)) || Number(video.height) < 1
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0)
    fail('prepared_video_invalid', 'prepared phone MP4 必須是無音軌的單一 H.264 影片');
  return {
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds,
  };
}

function validateIntent(intent) {
  if (!intent || intent.schemaVersion !== 1 || intent.mode !== READY_MODE
      || intent.template !== 'focusstock' || intent.timelineBasis !== 'focusstock-main-v1'
      || intent.contractVersion !== 2
      || typeof intent.requestId !== 'string' || !intent.requestId
      || intent.provider?.id !== 'chipk-simulator-capture'
      || intent.provider?.toolVersion !== '0.3.0'
      || intent.target?.routeId !== 'chipk.stock.main-force'
      || intent.target?.stockId !== '3441' || intent.target?.stockName !== '聯一光'
      || intent.presentation?.profileId !== 'chipk.stock-main-force-portrait.v1'
      || intent.placement?.layoutId !== 'focusstock-phone-portrait.v1'
      || !intent.source || intent.source.fileName !== 'prepared-phone-material.mp4'
      || intent.source.artifactRole !== 'prepared-video'
      || intent.source.mimeType !== 'video/mp4'
      || !SHA256_HEX.test(intent.source.sha256 || '')
      || !Number.isSafeInteger(intent.source.size) || intent.source.size < 1)
    fail('intent_incompatible', 'prepared phone intent 與 Focusstock ready-to-place contract 不符');
}

function resolvePlacementStart(placement, subtitles, scriptRaw = null) {
  try {
    return resolveScriptPlacementStart({ placement, subtitles, scriptRaw, fps: FPS });
  } catch (error) {
    if (error instanceof ScriptTimelineResolverError) fail(error.code, error.message);
    throw error;
  }
}

function resolveStartSec(placement, subtitles, scriptRaw = null) {
  return resolvePlacementStart(placement, subtitles, scriptRaw).requestedStartSec;
}

function compilePreparedPhonePlan({
  intent, videoPath, scriptRaw = null, subtitles, videoMeta, inspectedMedia,
}) {
  validateIntent(intent);
  let stat;
  try { stat = fs.lstatSync(videoPath); } catch (_) {}
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== intent.source.size
      || hashFile(videoPath) !== intent.source.sha256)
    fail('source_hash_mismatch', 'prepared phone MP4 bytes 與 provider descriptor 不一致');
  const declared = intent.source.media;
  if (!declared || declared.codec !== inspectedMedia.codec
      || declared.width !== inspectedMedia.width || declared.height !== inspectedMedia.height
      || !Number.isFinite(declared.durationSeconds)
      || Math.abs(declared.durationSeconds - inspectedMedia.durationSeconds) > 0.1)
    fail('source_media_mismatch', 'prepared phone MP4 實際媒體規格與 descriptor 不一致');
  const heygenDurationSec = Number(videoMeta?.heygenDurationSec);
  if (!Number.isFinite(heygenDurationSec) || heygenDurationSec <= 0)
    fail('timeline_unavailable', 'Focusstock main timeline 時長無法確定');
  const resolvedStart = resolvePlacementStart(intent.placement, subtitles, scriptRaw);
  const startFrame = resolvedStart.startFrame;
  const durationInFrames = Math.ceil(inspectedMedia.durationSeconds * FPS);
  const timelineFrames = Math.round(heygenDurationSec * FPS);
  if (startFrame < 0 || startFrame + durationInFrames > timelineFrames)
    fail('placement_out_of_bounds', 'prepared phone clip 無法完整放進 Focusstock main timeline');
  const endFrame = startFrame + durationInFrames;
  const startSec = resolvedStart.startSec;
  const endSec = Number((endFrame / FPS).toFixed(6));
  return {
    schemaVersion: 1,
    mode: READY_MODE,
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    contractVersion: intent.contractVersion,
    requestId: intent.requestId,
    source: {
      fileName: intent.source.fileName,
      artifactRole: intent.source.artifactRole,
      sha256: intent.source.sha256,
      size: intent.source.size,
      mimeType: intent.source.mimeType,
      media: {
        ...inspectedMedia,
        durationSeconds: Number(inspectedMedia.durationSeconds.toFixed(6)),
      },
    },
    presentation: { profileId: intent.presentation.profileId },
    visualOwnership: {
      owner: 'prepared-phone-video',
      conflictPolicy: 'suppress-entire-overlapping-placement',
      suppressedChannels: ['focusstock-shots', 'focusstock-broll'],
    },
    placement: {
      layoutId: intent.placement.layoutId,
      fps: FPS,
      startFrame,
      endFrame,
      startSec,
      endSec,
      durationInFrames,
      playbackRate: 1,
      muted: true,
      objectFit: 'contain',
      crop: 'none',
      trim: 'none',
      loop: false,
    },
  };
}

function writePlan(outputPath, plan) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = path.join(
    path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`);
  fs.renameSync(temporary, outputPath);
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === DISABLED_MODE) {
    const plan = disabledPlan();
    writePlan(args.outputPath, plan);
    return plan;
  }
  try {
    const intent = JSON.parse(fs.readFileSync(args.intentPath, 'utf8'));
    const scriptRaw = fs.readFileSync(args.scriptPath, 'utf8');
    const subtitles = JSON.parse(fs.readFileSync(args.subtitlesPath, 'utf8'));
    const videoMeta = JSON.parse(fs.readFileSync(args.videoMetaPath, 'utf8'));
    const inspectedMedia = inspectPreparedVideo(args.videoPath);
    const plan = compilePreparedPhonePlan({
      intent, videoPath: args.videoPath, scriptRaw, subtitles, videoMeta, inspectedMedia,
    });
    writePlan(args.outputPath, plan);
    return plan;
  } catch (error) {
    writePlan(args.outputPath, disabledPlan());
    throw error;
  }
}

if (require.main === module) {
  try {
    const plan = run();
    console.log(`Prepared phone plan: mode=${plan.mode}, out=${parseArgs(process.argv.slice(2)).outputPath}`);
  } catch (error) {
    console.error(`Prepared phone planner 失敗 [${error.code || 'unknown'}]: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DISABLED_MODE,
  PreparedPhonePlanError,
  READY_MODE,
  compilePreparedPhonePlan,
  disabledPlan,
  inspectPreparedVideo,
  parseArgs,
  resolvePlacementStart,
  resolveStartSec,
  run,
  writePlan,
};
