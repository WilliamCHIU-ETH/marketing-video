/**
 * 大盤小報專用時間軸設定。
 *
 * 跟 ../timeline.ts 是平行的兩份設定，不共用 overlay 來源（天條 #4 精神延伸）：
 *   - ../timeline.ts   讀 overlays.generated.json（現有模板 (imageN)/(shot:)/(logo)）
 *   - dapan-timeline.ts 讀 dapan-shots.generated.json（大盤小報 (shot:) 專用）
 *
 * 影片尺寸/幀率/heygen 時長是 stage 0（transcribe）共用產出，兩邊都從 ../timeline.ts
 * re-export 讀，不重複定義；只有「這次要疊什麼圖 / 用什麼 BGM / 開場卡多長」是 dapan 專屬。
 */

import subtitleData from '../subtitles.json';
import { buildShotRuns, type ShotBox } from '../ShotFocus';
import generatedShots from './dapan-shots.generated.json';
import {
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  HEYGEN_DURATION_SEC,
  secToFrame,
} from '../timeline';

export { VIDEO_FPS, VIDEO_WIDTH, VIDEO_HEIGHT, HEYGEN_DURATION_SEC, secToFrame };

// 開場卡（intro-frame.jpg）固定顯示 1 秒
export const DAPAN_INTRO_SEC = 1;
// 大盤小報沒有 outro（不催下載），總長 = 開場卡 + heygen 期
export const DAPAN_TOTAL_DURATION_SEC = DAPAN_INTRO_SEC + HEYGEN_DURATION_SEC;

// 橫式版（DapanXiaobaoLandscape）沒有開場卡，影片直接開始，總長 = heygen 期
export const DAPAN_LANDSCAPE_DURATION_SEC = HEYGEN_DURATION_SEC;

export const DAPAN_BGM = {
  src: 'dapan-bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- char-index → 秒數（複製自 ../timeline.ts 的 resolveByCharIdx，
// 因為那支沒 export、且天條 #4 精神延伸不共用同一份渲染邏輯檔） ----------------
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

type GeneratedShot = {
  src: string;
  startCharIdx: number;
  endCharIdx: number;
  _phrase?: string;
  /** auto-shot 產生：這段旁白要框圖上的哪一格／哪一欄 */
  cell?: ShotBox;
  cellText?: string;
  isColumn?: boolean;
  wholePage?: boolean;
  pan?: boolean;
  panToY?: number;
  titleY?: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export type DapanShot = {
  src: string;
  startSec: number;
  endSec: number;
  cell?: ShotBox;
  cellText?: string;
  isColumn?: boolean;
  wholePage?: boolean;
  pan?: boolean;
  panToY?: number;
  titleY?: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export const DAPAN_SHOTS: DapanShot[] = (generatedShots as GeneratedShot[])
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
    `[dapan-timeline] ${(generatedShots as GeneratedShot[]).length} 個截圖標記 → 命中 ${DAPAN_SHOTS.length} 個`,
    DAPAN_SHOTS
  );
}

// 連續同一張圖合併成 run：圖片全程不下畫面、只有黃框移動（與焦點股同一套）
export const DAPAN_SHOT_RUNS = buildShotRuns(DAPAN_SHOTS, 2.0);
