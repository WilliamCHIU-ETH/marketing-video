import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';

/**
 * 截圖聚焦：所有版型共用的一套視覺語言。
 *
 * 行為（2026-08-12 使用者逐項定案）：
 *   - 連續使用同一張圖的片段合併成一個 run → **圖片全程不下畫面，只有黃框平滑移動**
 *   - 有明確數字 → 框那個數字；只有欄位概念 → 框整欄（列數可由旁白的「連N日」決定）
 *   - 壓暗以**黃框**為準（框多大亮多大），不是以聚焦線固定上下距離
 *   - 圖片沒蓋到的地方壓深灰黑，不露出講者
 *   - wholePage（例：清單頁的 CTA）→ 整張顯示、不框不壓暗
 *
 * 座標來源是 OCR（scripts/analyze-app-images.js）＋規則庫（scripts/app-locators.json），
 * 全部相對於圖片本身，不寫死螢幕座標，所以換手機／解析度都適用。
 */

export type ShotBox = { x: number; y: number; w: number; h: number };

export type ShotCellSpec = {
  startSec: number;
  endSec: number;
  /**
   * 黃框：要圈起來強調的地方。有 cell 才會畫黃框、才會壓暗周圍。
   * ⚠️ 2026-08-17 起 cell 與 region 是兩件事（使用者指出來的設計錯誤）：
   *   只有 region → 捲到那個區域，不畫框、不壓暗
   *   只有 cell   → 捲到框的位置並畫框（＝以前的行為）
   *   兩者都有   → 捲到 region，框畫在 cell
   */
  cell?: ShotBox;
  /** 顯示區域：決定圖要捲到哪裡、放大多少。不畫任何框線。 */
  region?: ShotBox;
  cellText?: string;
  isColumn?: boolean;
  wholePage?: boolean;
  /** true = 從標題開始往下滑過內容（找不到具體目標時的呈現） */
  pan?: boolean;
  /** 滑動終點（圖片座標 y）；沒有就滑完可滑範圍 */
  panToY?: number;
  /** 截圖標題在圖上的 y；滑動起點會讓它落在畫面 PAN_START_FRAC 高度處 */
  titleY?: number;
};

export type ShotRun = {
  src: string;
  startSec: number;
  endSec: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
  cells: ShotCellSpec[];
};

export const SHOT_FOCUS = {
  /** 要框的目標落在畫面的這個高度（避開上方 header、下方字幕） */
  focusY: 760,
  /** 壓暗時，黃框上下各留多少亮區 */
  margin: 70,
  /** 帶外壓暗程度 */
  dim: 0.72,
  /** 圖片外露處的底色：深灰黑，不讓講者透出來 */
  backdrop: '#0b0d12',
  /** 黃框相對目標框的外擴（圖片座標 px） */
  pad: { x: 26, y: 18 },
  highlight: '#FFE600',
  /** 整欄模式下，欄位頂端離聚焦線的距離 */
  columnTopOffset: 70,
  /** 換格時的移動時間（秒） */
  transitionSec: 0.35,
};

/** 一個 run＝連續使用同一張圖的整段時間。fps/畫布尺寸由呼叫端傳入，各版型可不同。 */
export const ShotFocusImage: React.FC<{
  run: ShotRun;
  width: number;
  height: number;
  fps: number;
  /** 只在畫面的某個橫向區間內作用（橫式用：左側講者可見區，右側品牌面板不能蓋） */
  region?: { x: number; width: number };
  /** 覆寫聚焦線位置（橫式畫布只有 1080 高，760 會太低） */
  focusY?: number;
  /** 圖片左右留白（橫式使用者定案 20px） */
  margin?: number;
}> = ({ run, width, height, fps, region, focusY: focusYProp, margin = 0 }) => {
  const rx = region ? region.x : 0;
  const rw = region ? region.width : width;
  const imgW = rw - margin * 2;
  const imgX = rx + margin;
  const focusY = focusYProp ?? SHOT_FOCUS.focusY;
  const frame = useCurrentFrame();
  const appear = interpolate(frame, [0, Math.round(0.3 * fps)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 有 cell（要畫黃框）或有 region（只是要捲到某處）都算有目標
  const withCell = run.cells.filter((c) => (c.cell || c.region) && !c.wholePage);

  // 沒有要框的東西，或只是「看一下 App」→ 整張顯示
  if (!run.imageWidth || !run.imageHeight || withCell.length === 0) {
    return (
      <AbsoluteFill style={{ opacity: appear }}>
        <div
          style={{
            position: 'absolute', left: rx, top: 0, width: rw, height,
            backgroundColor: SHOT_FOCUS.backdrop,
          }}
        />
        {/* ⚠️ 圖片一定要包在 AbsoluteFill 裡：CSS 繪製順序上，絕對定位的元素會蓋在
            靜態元素之上（與 DOM 順序無關）。直接放 <Img> 會被上面那層黑底蓋成全黑。 */}
        {/* 沒有要框的目標時的顯示方式：
              直式（margin=0、整個畫布）→ cover 滿版，使用者定案「圖片就讓它滿版放」
              橫式（有 margin/region）→ contain，完整放進左側可見區、不裁切 */}
        <div
          style={{
            position: 'absolute',
            left: imgX,
            top: margin,
            width: imgW,
            height: height - margin * 2,
          }}
        >
          <Img
            src={staticFile(run.src)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: margin > 0 ? 'contain' : 'cover',
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  const sc = imgW / run.imageWidth;
  const T = SHOT_FOCUS.transitionSec;

  // 定位以 region 為準（沒指定 region 才用黃框的位置 —— 也就是以前的行為）。
  // 黃框的幾何只在「這一格有 cell」時才有意義；沒有 cell 的格子 hasBox=false，
  // 框與壓暗都會淡出，但為了讓插值序列連續，幾何值沿用上一格。
  let lastGeom: { left: number; top: number; width: number; height: number } | null = null;
  const targets = withCell.map((c) => {
    const anchor = (c.region || c.cell) as ShotBox;
    const anchorY = c.isColumn && !c.region
      ? anchor.y * sc + SHOT_FOCUS.columnTopOffset
      : (anchor.y + anchor.h / 2) * sc;
    const yoff = focusY - anchorY;
    const geom = c.cell
      ? {
          left: imgX + (c.cell.x - SHOT_FOCUS.pad.x) * sc,
          top: (c.cell.y - SHOT_FOCUS.pad.y) * sc + yoff,
          width: (c.cell.w + SHOT_FOCUS.pad.x * 2) * sc,
          height: (c.cell.h + SHOT_FOCUS.pad.y * 2) * sc,
        }
      : lastGeom || { left: imgX, top: focusY, width: 0, height: 0 };
    if (c.cell) lastGeom = geom;
    return { t: c.startSec - run.startSec, yoff, hasBox: c.cell ? 1 : 0, ...geom };
  });

  // 關鍵影格：在每一格停住，換格前 T 秒開始平滑移動過去
  const buildFrames = () => {
    const fr: number[] = [];
    targets.forEach((tg, i) => {
      if (i === 0) fr.push(0);
      else {
        const move = Math.max(fr[fr.length - 1] + 1, Math.round((tg.t - T) * fps));
        fr.push(move);
        fr.push(Math.max(move + 1, Math.round(tg.t * fps)));
      }
    });
    return fr;
  };
  const frames = buildFrames();
  const seriesOf = (key: 'yoff' | 'left' | 'top' | 'width' | 'height' | 'hasBox') => {
    const vals: number[] = [];
    targets.forEach((tg, i) => {
      if (i === 0) vals.push(tg[key]);
      else {
        vals.push(targets[i - 1][key]);
        vals.push(tg[key]);
      }
    });
    return vals;
  };
  const at = (key: 'yoff' | 'left' | 'top' | 'width' | 'height' | 'hasBox') => {
    const vals = seriesOf(key);
    return frames.length > 1
      ? interpolate(frame, frames, vals, {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : vals[0];
  };

  // ── pan 模式：從標題開始慢慢往下滑過內容 ──
  // 只有一格、且標記為 pan 時啟用。與其定格在標題，不如把整頁帶過去。
  // 速度自動算：這一段有多久，就在這段時間內滑完「可滑範圍」，並限制不超過舒適速度。
  const onlyCell = withCell.length === 1 ? withCell[0] : null;
  const isPan = !!(onlyCell && onlyCell.pan);
  let yoff = at('yoff');
  let box = { left: at('left'), top: at('top'), width: at('width'), height: at('height') };

  if (isPan) {
    // ⚠️ 滑動一律「從截圖頂端開始、往下滑」。
    // 2026-08-12 修正：原本以「目標欄位」當起點，而欄位多半在畫面中下方，
    // 結果一開場就看到截圖下半部（使用者回報「完全錯誤，要先顯示上方標題再往下滑」）。
    const durSec = Math.max(0.5, run.endSec - run.startSec);
    const imgH = (run.imageHeight || 0) * sc;
    // 起點：讓「截圖的標題」落在畫面 PAN_START_FRAC 高度處。
    // 貼齊畫面頂端的話，標題會被上方的節目 header 蓋掉（2026-08-12 使用者回報）。
    const PAN_START_FRAC = 0.25;
    const titleY = onlyCell && onlyCell.titleY != null ? onlyCell.titleY : 0;
    const startY = Math.max(0, height * PAN_START_FRAC - titleY * sc);
    const minY = Math.min(0, height - imgH);  // 滑到底（圖片下緣對齊畫面下緣）
    // ── 滑動節奏（2026-08-12 使用者定案）──
    // 「先顯示上方標題時要停留一下，再往下滑動」「滑動偏快，可以再慢一點」
    //   ① 開頭先停 PAN_HOLD_SEC 秒讓觀眾看清楚標題
    //   ② 之後在整段的 PAN_FINISH_FRAC 之前滑完，速度上限 COMFORT_PX_PER_SEC
    // 理想版本是「講到下方資訊時剛好滑到那裡」，但清單頁的 OCR 讀不出個股名，
    // 無法對位，所以先用固定節奏；哪天 OCR 讀得到就會改用 panToY 精準對位。
    const PAN_HOLD_SEC = 1.5;
    const PAN_FINISH_FRAC = 0.8;
    const COMFORT_PX_PER_SEC = 175;
    const hold = Math.min(PAN_HOLD_SEC, durSec * 0.3);
    const moveSec = Math.max(0.8, durSec * PAN_FINISH_FRAC - hold);
    const travel = Math.min(startY - minY, COMFORT_PX_PER_SEC * moveSec);
    const endY = startY - Math.max(0, travel);
    yoff = interpolate(
      frame,
      [0, Math.round(hold * fps), Math.round((hold + moveSec) * fps)],
      [startY, startY, endY],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    // 黃框跟著圖一起往上移出畫面
    const shift = yoff - targets[0].yoff;
    box = { ...box, top: targets[0].top + shift };
  }
  // 這一格到底有沒有黃框（0~1，換格時會淡入淡出）。
  // 「只指定顯示區域、不畫黃線」就是靠這個 —— 框與壓暗一起關掉
  //（2026-08-17 使用者：框出顯示區域跟拉黃線是兩件事，要分開）。
  const boxOn = at('hasBox');
  const boxOpacity = boxOn * (isPan
    ? interpolate(frame, [0, Math.round(1.6 * fps), Math.round(2.4 * fps)], [1, 1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1);
  // pan 模式在瀏覽整頁，不壓暗；聚焦模式才以黃框為準壓暗。
  // 沒有黃框的格子也不壓暗 —— 壓暗的意義是「把注意力導到框裡」，沒框就沒對象。
  const bandTop = isPan ? 0 : box.top - SHOT_FOCUS.margin;
  const bandBot = isPan ? height : box.top + box.height + SHOT_FOCUS.margin;
  const dimColor = `rgba(11,13,18,${SHOT_FOCUS.dim * boxOn})`;

  return (
    <AbsoluteFill style={{ opacity: appear }}>
      <div
        style={{
          position: 'absolute', left: rx, top: 0, width: rw, height,
          backgroundColor: SHOT_FOCUS.backdrop,
        }}
      />

      <div style={{ position: 'absolute', left: imgX, top: yoff, width: imgW }}>
        <Img src={staticFile(run.src)} style={{ width: imgW, display: 'block' }} />
      </div>

      <div
        style={{
          position: 'absolute', left: rx, top: 0, width: rw,
          height: Math.max(0, bandTop), backgroundColor: dimColor,
        }}
      />
      <div
        style={{
          position: 'absolute', left: rx, top: bandBot, width: rw,
          height: Math.max(0, height - bandBot), backgroundColor: dimColor,
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: box.left, top: box.top, width: box.width, height: box.height,
          border: `5px solid ${SHOT_FOCUS.highlight}`,
          borderRadius: 12,
          boxShadow: '0 0 16px 3px rgba(255,230,0,0.5)',
          boxSizing: 'border-box',
          opacity: boxOpacity,
        }}
      />
    </AbsoluteFill>
  );
};

/** 把「連續使用同一張圖」的片段合併成 run（間隔小於 gapSec 視為連續）。 */
export function buildShotRuns<
  T extends {
    src: string;
    startSec: number;
    endSec: number;
    cell?: ShotBox;
    region?: ShotBox;
    cellText?: string;
    isColumn?: boolean;
    wholePage?: boolean;
    pan?: boolean;
    panToY?: number;
    titleY?: number;
    imageWidth?: number | null;
    imageHeight?: number | null;
  }
>(shots: T[], gapSec = 2.0): ShotRun[] {
  const runs: ShotRun[] = [];
  for (const s of shots) {
    const cell: ShotCellSpec = {
      startSec: s.startSec,
      endSec: s.endSec,
      cell: s.cell,
      region: s.region,
      cellText: s.cellText,
      isColumn: s.isColumn,
      wholePage: s.wholePage,
      pan: s.pan,
      panToY: s.panToY,
      titleY: s.titleY,
    };
    const last = runs[runs.length - 1];
    if (last && last.src === s.src && s.startSec - last.endSec <= gapSec) {
      last.endSec = s.endSec;
      last.cells.push(cell);
    } else {
      runs.push({
        src: s.src,
        startSec: s.startSec,
        endSec: s.endSec,
        imageWidth: s.imageWidth,
        imageHeight: s.imageHeight,
        cells: [cell],
      });
    }
  }
  return runs;
}
