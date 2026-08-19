/**
 * 三大法人專用時間軸設定。
 *
 * 跟大盤小報（../DapanXiaobao/dapan-timeline.ts）使用相同模式，但維持獨立設定：
 *   - dapan-timeline.ts        讀 dapan-shots.generated.json
 *   - institution-timeline.ts  讀 institution-shots.generated.json（三大法人 (shot:) 專用）
 *
 * 影片尺寸/幀率/heygen 時長從 ../timeline.ts re-export（stage 0 transcribe 共用產出）。
 */

import subtitleData from '../subtitles.json';
import generatedShots from './institution-shots.generated.json';
import generatedFocuses from './institution-focus.generated.json';
import regionsData from './institution-regions.generated.json';
import {
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  HEYGEN_DURATION_SEC,
  secToFrame,
} from '../timeline';

export { VIDEO_FPS, VIDEO_WIDTH, VIDEO_HEIGHT, HEYGEN_DURATION_SEC, secToFrame };

// 開場卡（institution-intro-frame.jpg）固定顯示 1 秒
export const INSTITUTION_INTRO_SEC = 1;
// 三大法人沒有 outro，總長 = 開場卡 + heygen 期（只有直式）
export const INSTITUTION_TOTAL_DURATION_SEC =
  INSTITUTION_INTRO_SEC + HEYGEN_DURATION_SEC;

export const INSTITUTION_BGM = {
  src: 'institution-bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- char-index → 秒數（同 dapan-timeline，不共用同一份渲染邏輯檔） --------
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
};

export type InstitutionShot = {
  src: string;
  startSec: number;
  endSec: number;
};

export const INSTITUTION_SHOTS: InstitutionShot[] = (generatedShots as GeneratedShot[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [{ src: g.src, startSec: t.start, endSec: t.end }];
  })
  .sort((a, b) => a.startSec - b.startSec);

// ---------------- 聚焦效果（focus）：講到某段數據時把資訊圖捲到該區塊、壓暗其餘、框住某格 ----------
// 版面座標（區塊帶 + 逐字框）由 scripts/analyze-institution-image.js 用 OCR 產出，不寫死。
type Box = { x: number; y: number; w: number; h: number };
type RegionsFile = {
  imageWidth: number;
  imageHeight: number;
  sections: Record<string, { top: number; bottom: number }>;
  words: Array<{ t: string; x: number; y: number; w: number; h: number; c: number }>;
};
const REGIONS = regionsData as RegionsFile;

type GeneratedFocus = {
  section: string;
  cellText: string;
  startCharIdx: number;
  endCharIdx: number;
  _phrase?: string;
};

export type InstitutionFocus = {
  startSec: number;
  endSec: number;
  imageWidth: number;
  imageHeight: number;
  section: { top: number; bottom: number }; // 圖片座標
  cell: Box | null; // 圖片座標；要高亮的那格（找不到就不畫框）
};

// 在指定區塊帶內、找 OCR 逐字框裡包含 cellText 的字（避免撞到「重點」框裡同樣數字）。
function findCellBox(
  cellText: string,
  band: { top: number; bottom: number }
): Box | null {
  if (!cellText) return null;
  const cy = (w: { y: number; h: number }) => w.y + w.h / 2;
  const cands = (REGIONS.words || [])
    .filter((w) => w.c >= 30 && w.t.includes(cellText))
    .filter((w) => cy(w) >= band.top && cy(w) <= band.bottom);
  if (cands.length === 0) return null;
  // 取信心最高的一個
  const best = cands.sort((a, b) => b.c - a.c)[0];
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}

export const INSTITUTION_FOCUS: InstitutionFocus[] = (generatedFocuses as GeneratedFocus[])
  .flatMap((f) => {
    const t = resolveByCharIdx(f.startCharIdx, f.endCharIdx);
    if (!t) return [];
    const band = REGIONS.sections?.[f.section];
    if (!band) {
      if (typeof window !== 'undefined') {
        // eslint-disable-next-line no-console
        console.warn(`[institution-focus] 區塊 ${f.section} 不在 regions 內，略過`);
      }
      return [];
    }
    const cell = findCellBox(f.cellText, band);
    return [
      {
        startSec: t.start,
        endSec: t.end,
        imageWidth: REGIONS.imageWidth,
        imageHeight: REGIONS.imageHeight,
        section: { top: band.top, bottom: band.bottom },
        cell,
      },
    ];
  })
  .sort((a, b) => a.startSec - b.startSec);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[institution-timeline] ${(generatedShots as GeneratedShot[]).length} 個截圖標記 → 命中 ${INSTITUTION_SHOTS.length} 個`,
    INSTITUTION_SHOTS
  );
}
