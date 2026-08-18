import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {
  INSTITUTION_BGM,
  INSTITUTION_INTRO_SEC,
  INSTITUTION_SHOTS,
  INSTITUTION_FOCUS,
  INSTITUTION_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  secToFrame,
  type InstitutionFocus,
} from './institution-timeline';
import { Subtitles } from '../Subtitles';
import videoMeta from '../video-meta.json';
import institutionRegions from './institution-regions.generated.json';

// 資訊圖檔名由版面偵測寫入（使用者常丟 0812.png 這種日期命名，不再寫死 image.png）
const INSTITUTION_IMAGE_FILE =
  (institutionRegions as { imageFile?: string }).imageFile || 'image.png';

/**
 * 三大法人 composition（直式 1080×1920）。
 *
 * 跟大盤小報（../DapanXiaobao/DapanComposition.tsx）是**同一個模子、各自獨立**的兩條產線
 * （天條 #4 精神：不共用容易互相拖累的渲染邏輯檔），只共用 ../Subtitles.tsx。
 * 差異：金橘配色版型、固定主播 avatar、以及日期/標題在版面上的座標不同。
 *
 * 版型（2026-08-10 使用者提供參考圖量測）：
 *   - 開場卡（institution-intro-frame.jpg，1 秒）：金橘背景，「三大法人」白底方塊是印死的美術，
 *     動態疊：日期（白框上方、置中、白色斜體大字）＋標題兩行（白框下方、第一行白、其餘黃）。
 *   - 主段：講者全螢幕 + 常駐 header（institution-header-overlay.png：CMoney logo＋右側「三大法人」白框）
 *     ＋日期（左側深色 bar、白色斜體）＋字幕（沿用大盤小報底部置中樣式）。
 *   - 只有直式，沒有橫式。
 */

/**
 * ⚠️⚠️ 版面定案值（使用者逐版微調拍板，勿隨意覆蓋）⚠️⚠️
 *
 * 2026-08-10 由使用者一版一版調出來的座標；2026-08-12 曾因為改用到「調整前的舊版檔案」
 * 而被整組蓋回預設值（開場日期跑掉、bar 日期變小、講者沒下移），花了時間才發現。
 * 之後要改這支 composition，請務必先確認手上的檔案含有這個區塊，再動手。
 * 所有版面數字集中在這裡，不要散回 JSX 裡寫死。
 */
const LAYOUT = {
  /** 開場卡日期：270px、往下 30、往左 20（2026-08-10 定案） */
  introDate: { top: 410, left: -20, width: 1080, fontSize: 270 },
  /** 開場卡標題 */
  introTitle: { top: 1030, fontSize: 90 },
  /** 主段 header bar 日期：123→143px（再 +20）、往右 15（2026-08-10 定案） */
  mainDate: { top: 112, left: 45, width: 400, fontSize: 143 },
  /** 日期陰影：淺一點、再擴散一點（2026-08-10 定案） */
  dateShadow: '5px 3px 14px rgba(0,0,0,0.45)',
  /** 講者整體下移 100px（2026-08-10 定案） */
  speakerOffsetY: 100,
};

function fadeProgress(
  frame: number,
  start: number,
  end: number,
  fadeSec: number,
): number {
  const dur = end - start;
  if (dur <= 0) return frame >= start && frame <= end ? 1 : 0;
  const fade = Math.min(
    Math.round(fadeSec * VIDEO_FPS),
    Math.floor((dur - 1) / 2),
  );
  if (fade <= 0) return frame >= start && frame <= end ? 1 : 0;
  return interpolate(
    frame,
    [start, start + fade, end - fade, end],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
}

export const InstitutionComposition: React.FC = () => {
  const introFrames = secToFrame(INSTITUTION_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(INSTITUTION_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：institution-intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('institution-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 日期：白框上方、整幅置中（實測「三大法人」白框 y764–992、cx≈540）。第一版預設值。 */}
        <InstitutionDateBadge {...LAYOUT.introDate} />
        {/* 標題：白框下方（box 底 ≈992），第一行白、其餘黃。第一版預設值。 */}
        <InstitutionTitleCard {...LAYOUT.introTitle} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        {/* 主軌：講者影片，objectFit cover 置中填滿直式畫布（來源不論橫直都能填） */}
        <AbsoluteFill style={{ transform: `translateY(${LAYOUT.speakerOffsetY}px)` }}>
          <OffthreadVideo
            src={staticFile('heygen.mp4')}
            volume={1.5}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center center',
            }}
          />
        </AbsoluteFill>

        {/* 截圖段：全螢幕切換（v1，INSTITUTION_SHOTS 目前為空） */}
        {INSTITUTION_SHOTS.map((shot, idx) => {
          const from = secToFrame(shot.startSec);
          const durationInFrames = Math.max(
            1,
            secToFrame(shot.endSec - shot.startSec)
          );
          return (
            <Sequence
              key={`${shot.src}-${idx}`}
              from={from}
              durationInFrames={durationInFrames}
            >
              <InstitutionShotImage src={shot.src} />
            </Sequence>
          );
        })}

        {/* 聚焦段：講到某段數據時，蓋掉講者、把資訊圖捲到該區塊、壓暗其餘、框住某格。
            座標由 OCR（analyze-institution-image.js）產出，區塊/黃框都不寫死。
            疊在講者之上、字幕/header/日期之下（下面那三層仍在最上層）。 */}
        {INSTITUTION_FOCUS.map((focus, idx) => {
          const from = secToFrame(focus.startSec);
          const durationInFrames = Math.max(
            1,
            secToFrame(focus.endSec - focus.startSec)
          );
          return (
            <Sequence key={`focus-${idx}`} from={from} durationInFrames={durationInFrames}>
              <InstitutionFocusImage focus={focus} />
            </Sequence>
          );
        })}

        {/* 字幕層：沿用大盤小報／投廣模板同一套（底部置中、未修改） */}
        <Subtitles />

        {/* 常駐 header bar：金橘 bar + CMoney logo + 右側「三大法人」白框 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('institution-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 日期：主段左側深色 bar（實測白框 x461–998 / y139–249；日期擺白框左邊的深色區）。第一版預設值。 */}
        <InstitutionDateBadge {...LAYOUT.mainDate} />
      </Sequence>

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出 === */}
      <Audio
        src={staticFile(INSTITUTION_BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(INSTITUTION_BGM.fadeInSec);
          const fadeOut = secToFrame(INSTITUTION_BGM.fadeOutSec);
          if (f < fadeIn) return INSTITUTION_BGM.volume * (f / fadeIn);
          if (f > totalFrames - fadeOut)
            return INSTITUTION_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
          return INSTITUTION_BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 聚焦段：把三大法人資訊圖（public/image.png）依 OCR 抓到的區塊位置捲到聚焦區、壓暗其餘、
 * 在指定的數字格畫黃框。圖片底下露出的地方壓純黑（不出現講者，天條：三大法人固定這樣做）。
 *
 * 座標換算（跟 mockup 一致）：
 *   sc     = 畫布寬 / 圖片寬（貼齊寬度）
 *   yoff   = FOCUS_TOP − 區塊頂×sc（把區塊頂端捲到 FOCUS_TOP 這條線）
 *   螢幕Y  = 圖片Y×sc + yoff
 * 壓暗用「區塊帶上方一條、下方一條」兩塊半透明黑達成（帶內保持明亮）。
 */
const FOCUS_TOP = 330; // 區塊頂端要落在的螢幕 y（在常駐 header 之下）
const DIM_ALPHA = 0.7; // 區塊帶以外壓暗程度
const HL = '#FFE600'; // 黃框顏色
// 黃框留白：跟著格子大小等比例調整，並設上下限。
// 固定值的問題是「框單一數字」時留白過大（2026-08-12 使用者：黃線條框起區域再小一點點）。
function cellPad(h: number) {
  const x = Math.min(Math.max(h * 0.55, 14), 46);
  const y = Math.min(Math.max(h * 0.40, 10), 34);
  return { x, top: y, bottom: y };
}

const InstitutionFocusImage: React.FC<{ focus: InstitutionFocus }> = ({ focus }) => {
  const frame = useCurrentFrame();
  // 進場：淡入 + 輕微上移收斂（約 0.35s）
  const appear = interpolate(frame, [0, Math.round(0.35 * VIDEO_FPS)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = (1 - appear) * 30; // 起始多往下 30px，收斂到 0

  const sc = VIDEO_WIDTH / focus.imageWidth;
  const yoff = FOCUS_TOP - focus.section.top * sc;
  const S = (y: number) => y * sc + yoff; // 圖片Y → 螢幕Y
  const bandTop = S(focus.section.top);
  const bandBot = S(focus.section.bottom);

  const cell = focus.cell
    ? {
        left: (focus.cell.x - cellPad(focus.cell.h).x) * sc,
        top: S(focus.cell.y - cellPad(focus.cell.h).top),
        width: (focus.cell.w + cellPad(focus.cell.h).x * 2) * sc,
        height: (focus.cell.h + cellPad(focus.cell.h).top + cellPad(focus.cell.h).bottom) * sc,
      }
    : null;

  return (
    <AbsoluteFill style={{ opacity: appear }}>
      {/* 純黑底：蓋掉講者 */}
      <AbsoluteFill style={{ backgroundColor: '#000000' }} />

      {/* 資訊圖（貼齊寬度、依 yoff 捲動） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: yoff + rise,
          width: VIDEO_WIDTH,
        }}
      >
        <Img src={staticFile(INSTITUTION_IMAGE_FILE)} style={{ width: VIDEO_WIDTH, display: 'block' }} />
      </div>

      {/* 壓暗：區塊帶上方一條 + 下方一條（帶內保持明亮） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: VIDEO_WIDTH,
          height: Math.max(0, bandTop + rise),
          backgroundColor: `rgba(0,0,0,${DIM_ALPHA})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: bandBot + rise,
          width: VIDEO_WIDTH,
          height: Math.max(0, VIDEO_HEIGHT - (bandBot + rise)),
          backgroundColor: `rgba(0,0,0,${DIM_ALPHA})`,
        }}
      />

      {/* 黃色高亮框（含外光暈） */}
      {cell && (
        <div
          style={{
            position: 'absolute',
            left: cell.left,
            top: cell.top + rise,
            width: cell.width,
            height: cell.height,
            border: `5px solid ${HL}`,
            borderRadius: 16,
            boxShadow: `0 0 18px 4px rgba(255,230,0,0.55)`,
            boxSizing: 'border-box',
          }}
        />
      )}
    </AbsoluteFill>
  );
};

/** 截圖段全螢幕圖片：淡入淡出，蓋滿整個畫面 */
const InstitutionShotImage: React.FC<{ src: string }> = ({ src }) => {
  const frame = useCurrentFrame();
  const opacity = fadeProgress(frame, 0, 999999, 0.25);
  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={staticFile(src)}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </AbsoluteFill>
  );
};

// 日期牌：讀 video-meta.json.headerDate（MMDD），白色斜體。
// 傳入 left/width 決定水平置中範圍（開場卡＝整幅置中；主段＝左側 bar 內置中）。
const InstitutionDateBadge: React.FC<{
  top: number;
  left: number;
  width: number;
  fontSize: number;
}> = ({ top, left, width, fontSize }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily:
              '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
            fontSize,
            fontWeight: 800,
            fontStyle: 'italic',
            color: '#ffffff',
            letterSpacing: -2,
            lineHeight: 1,
            textShadow: LAYOUT.dateShadow,
          }}
        >
          {headerDate}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：只在開場卡顯示，讀 video-meta.json.titleText。第一句白色、其餘黃色（沿用大盤小報配色/描邊）。
const TITLE_COLORS = ['#ffffff', '#FFE600'];

const InstitutionTitleCard: React.FC<{ top: number; fontSize: number }> = ({
  top,
  fontSize,
}) => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 40,
          right: 40,
          top,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        {lines.map((line: string, i: number) => (
          <div
            key={i}
            style={{
              fontFamily:
                '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
              fontSize,
              fontWeight: 800,
              fontStyle: 'italic',
              color: i === 0 ? TITLE_COLORS[0] : TITLE_COLORS[1],
              lineHeight: 1.4,
              textAlign: 'center',
              WebkitTextStroke: '3px #000000',
              paintOrder: 'stroke fill',
              textShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
