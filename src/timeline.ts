/**
 * 影片整體設定 + overlay/textcard 時間軸
 *
 * 定位機制：用 cleaned script body 的 char index → subtitles.json._scriptCharTimes
 * 直接查每張圖的開始/結束秒數。不再用字串前綴搜尋（不會撞名、不會跨 segment 找不到）。
 */

import subtitleData from './subtitles.json';
import generatedOverlays from './overlays.generated.json';
import generatedTextCards from './textcards.generated.json';
import videoMeta from './video-meta.json';

// IG Reels / Stories 直式：1080x1920 (9:16)
export const VIDEO_FPS = 30;
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;

// 影片時長：由 npm run transcribe 自動偵測（ffprobe）寫入 video-meta.json
export const HEYGEN_DURATION_SEC = videoMeta.heygenDurationSec;
export const OUTRO_DURATION_SEC = videoMeta.outroDurationSec ?? 0;
export const VIDEO_DURATION_SEC = HEYGEN_DURATION_SEC + OUTRO_DURATION_SEC;

export const BGM = {
  src: 'bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- Subtitle 型別 ----------------
type WhisperWord = { word: string; start: number; end: number };
type WhisperSegment = {
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
};
type ScriptCharTime = { start: number; end: number };
type WhisperOutput = {
  segments: WhisperSegment[];
  language?: string;
  _scriptBreaks?: number[];
  _scriptCharTimes?: ScriptCharTime[];
};

const subtitles = subtitleData as WhisperOutput;
const SCRIPT_CHAR_TIMES: ScriptCharTime[] = subtitles._scriptCharTimes ?? [];

if (SCRIPT_CHAR_TIMES.length === 0 && typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.warn(
    '[timeline] subtitles.json 缺少 _scriptCharTimes — 請重跑 npm run correct-subtitles 產生'
  );
}

/**
 * 用 cleaned script body 中的 char index 範圍解出 overlay 時間。
 * 找不到對應時間戳（resolve 失敗）→ 回 null。
 */
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

// ---------------- Overlay 設定 ----------------

export type OverlayPosition = 'top' | 'center' | 'bottom';
export type OverlaySize = 'small' | 'medium' | 'full';

type GeneratedOverlay = {
  src: string;
  startCharIdx: number;
  endCharIdx: number;
  startAnchor?: string;
  endAnchor?: string;
  _phrase?: string;
  position?: OverlayPosition;
  size?: OverlaySize;
  pip?: boolean;
  offsetPx?: number;
  widthPx?: number;
  heightPx?: number;
  noBlur?: boolean;
};

export type Overlay = {
  src: string;
  startSec: number;
  endSec: number;
  fade?: number;
  position?: OverlayPosition;
  size?: OverlaySize;
  pip?: boolean;
  offsetPx?: number;
  widthPx?: number;
  heightPx?: number;
  noBlur?: boolean;
};

type AnchorResolution = {
  cfg: GeneratedOverlay;
  status: 'matched' | 'unresolved';
  startSec?: number;
  endSec?: number;
};

const RESOLVED: AnchorResolution[] = (generatedOverlays as GeneratedOverlay[]).map((cfg) => {
  const t = resolveByCharIdx(cfg.startCharIdx, cfg.endCharIdx);
  if (!t) return { cfg, status: 'unresolved' };
  return { cfg, status: 'matched', startSec: t.start, endSec: t.end };
});

export const OVERLAYS: Overlay[] = RESOLVED.filter(
  (r): r is AnchorResolution & { startSec: number; endSec: number } => r.status === 'matched'
)
  .map((r) => ({
    src: r.cfg.src,
    startSec: r.startSec,
    endSec: r.endSec,
    position: r.cfg.position,
    size: r.cfg.size,
    pip: r.cfg.pip,
    offsetPx: r.cfg.offsetPx,
    widthPx: r.cfg.widthPx,
    heightPx: r.cfg.heightPx,
    noBlur: r.cfg.noBlur,
  }))
  .sort((a, b) => a.startSec - b.startSec);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    '[Overlay resolution]',
    RESOLVED.map((r) => ({
      src: r.cfg.src,
      charIdx: `[${r.cfg.startCharIdx}, ${r.cfg.endCharIdx}]`,
      phrase: r.cfg._phrase,
      status: r.status === 'matched' ? '✅ 顯示' : '❌ 跳過：char idx 解不到時間',
      startSec: r.startSec?.toFixed(2) ?? '-',
      endSec: r.endSec?.toFixed(2) ?? '-',
    }))
  );
  // eslint-disable-next-line no-console
  console.log(
    `[Overlay resolution] 共 ${RESOLVED.length} 張，命中 ${OVERLAYS.length} 張、跳過 ${
      RESOLVED.length - OVERLAYS.length
    } 張`
  );
}

// ---------------- TextCard 設定 ----------------
import type { TextCardAnim, TextCardItem } from './TextCard';

type GeneratedTextCard = {
  text: string;
  anim: string;
  skip: boolean;
  startCharIdx: number;
  endCharIdx: number;
  startAnchor?: string;
  endAnchor?: string;
  _phrase?: string;
};

export const TEXT_CARDS: TextCardItem[] = (generatedTextCards as GeneratedTextCard[]).flatMap(
  (g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [
      {
        text: g.text,
        anim: g.anim as TextCardAnim,
        startSec: t.start,
        endSec: t.end,
      },
    ];
  }
);

/** 把秒轉成 frame 的小工具 */
export const secToFrame = (sec: number): number => Math.round(sec * VIDEO_FPS);

// ─────────────────────────────────────────────
// 投廣模板的「全螢幕聚焦截圖」（auto-shot 產生）
//
// 跟既有的 (imageN) 子母畫面 overlay **並存、互不干擾**：
//   - (imageN)…(imageN) 手動標記 → 仍然走 OVERLAYS，行為完全不變
//   - 這裡是自動配圖產生的全螢幕聚焦段，只會出現在「你沒有手動標記」的段落
// 資料來源 src/marketing-shots.generated.json（auto-shot --out 寫入）。
// ─────────────────────────────────────────────
import marketingShots from './marketing-shots.generated.json';
import { buildShotRuns, type ShotBox } from './ShotFocus';

type MarketingGeneratedShot = {
  src: string;
  startCharIdx: number;
  endCharIdx: number;
  cell?: ShotBox;
  cellText?: string;
  isColumn?: boolean;
  wholePage?: boolean;
  pan?: boolean;
  panToY?: number;
  titleY?: number;
  imageWidth?: number;
  imageHeight?: number;
};

const MARKETING_SHOTS = (marketingShots as MarketingGeneratedShot[]).flatMap((g) => {
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
}).sort((a, b) => a.startSec - b.startSec);

export const MARKETING_SHOT_RUNS = buildShotRuns(MARKETING_SHOTS, 2.0);
