/**
 * 焦點股日報專用時間軸設定（直式）。
 *
 * 跟大盤小報／三大法人使用相同模式但各自獨立，讀自己的
 * focusstock-shots.generated.json。影片尺寸/幀率/heygen 時長從 ../timeline.ts re-export。
 */

import subtitleData from '../subtitles.json';
import { buildShotRuns } from '../ShotFocus';
import generatedShots from './focusstock-shots.generated.json';
import visualTimingContract from './focusstock-visual-timing.contract.json';
import {
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  HEYGEN_DURATION_SEC,
  secToFrame,
} from '../timeline';

export { VIDEO_FPS, VIDEO_WIDTH, VIDEO_HEIGHT, HEYGEN_DURATION_SEC, secToFrame };

type FocusstockVisualFrameInterval = {
  fps: number;
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
};

/** Single frame-interval contract shared with server-side conflict evidence. */
export function focusstockVisualFrameInterval(
  startSec: number,
  endSec: number,
): FocusstockVisualFrameInterval {
  if (visualTimingContract.schemaVersion !== 1 || visualTimingContract.fps !== VIDEO_FPS
      || visualTimingContract.frameInterval.start !== 'round-start-sec-times-fps'
      || visualTimingContract.frameInterval.duration
        !== 'max-one-round-duration-sec-times-fps'
      || visualTimingContract.frameInterval.semantics !== 'half-open'
      || !Number.isFinite(startSec) || !Number.isFinite(endSec)
      || startSec < 0 || endSec <= startSec) {
    throw new Error('Focusstock visual frame timing contract is invalid');
  }
  const startFrame = Math.round(startSec * VIDEO_FPS);
  const durationInFrames = Math.max(1, Math.round((endSec - startSec) * VIDEO_FPS));
  return {
    fps: VIDEO_FPS,
    startFrame,
    endFrame: startFrame + durationInFrames,
    durationInFrames,
  };
}

// 開場卡（focusstock-intro-frame.jpg）固定顯示 1 秒
export const FOCUSSTOCK_INTRO_SEC = 1;
// 焦點股日報沒有 outro，總長 = 開場卡 + heygen 期（只有直式）
export const FOCUSSTOCK_TOTAL_DURATION_SEC =
  FOCUSSTOCK_INTRO_SEC + HEYGEN_DURATION_SEC;

export const FOCUSSTOCK_BGM = {
  src: 'focusstock-bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- char-index → 秒數（同 institution-timeline，不共用同一份渲染邏輯檔） --------
type ScriptCharTime = { start: number; end: number };
type WhisperOutput = { _scriptCharTimes?: ScriptCharTime[] };
const subtitles = subtitleData as WhisperOutput;
const SCRIPT_CHAR_TIMES: ScriptCharTime[] = subtitles._scriptCharTimes ?? [];

function resolveByCharIdx(
  startCharIdx: number,
  endCharIdx: number
): { start: number; end: number } | null {
  if (
    SCRIPT_CHAR_TIMES.length === 0 ||
    startCharIdx < 0 ||
    endCharIdx >= SCRIPT_CHAR_TIMES.length
  ) {
    return null;
  }
  const startT = SCRIPT_CHAR_TIMES[startCharIdx];
  const endT = SCRIPT_CHAR_TIMES[endCharIdx];
  if (!startT || !endT) return null;
  if (endT.end <= startT.start) return null;
  return { start: startT.start, end: endT.end };
}

type Box = { x: number; y: number; w: number; h: number };
type GeneratedShot = {
  src: string;
  startCharIdx: number;
  endCharIdx: number;
  _phrase?: string;
  /** 這段旁白講到、且圖上有的數字所在位置（auto-shot 產生）。有 cell 就做聚焦＋黃框。 */
  cell?: Box;
  cellText?: string;
  isColumn?: boolean;
  wholePage?: boolean;
  pan?: boolean;
  panToY?: number;
  titleY?: number;
  imageWidth?: number;
  imageHeight?: number;
};

export type FocusstockShot = {
  src: string;
  startSec: number;
  endSec: number;
  /** 有 cell → 捲到該數字、壓暗其餘、畫黃框；沒有 → 整張顯示 */
  cell?: Box;
  cellText?: string;
  /** true = 框的是「整欄」（欄位概念）；false = 框單一數字 */
  isColumn?: boolean;
  /** true = 這段只是「看一下 App」，整張顯示、不框不壓暗 */
  wholePage?: boolean;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export const FOCUSSTOCK_SHOTS: FocusstockShot[] = (generatedShots as GeneratedShot[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [
      {
        src: g.src,
        startSec: t.start,
        endSec: t.end,
        cell: g.cell,
        cellText: g.cellText,
        isColumn: g.isColumn,
        wholePage: g.wholePage,
        pan: g.pan,
        panToY: g.panToY,
        titleY: g.titleY,
        imageWidth: g.imageWidth,
        imageHeight: g.imageHeight,
      },
    ];
  })
  .sort((a, b) => a.startSec - b.startSec);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[focusstock-timeline] ${(generatedShots as GeneratedShot[]).length} 個截圖標記 → 命中 ${FOCUSSTOCK_SHOTS.length} 個`,
    FOCUSSTOCK_SHOTS
  );
}

// runs 由共用工具建立（src/ShotFocus.tsx），各版型一致
export const FOCUSSTOCK_SHOT_RUNS = buildShotRuns(
  FOCUSSTOCK_SHOTS, visualTimingContract.mergeGapSec);
