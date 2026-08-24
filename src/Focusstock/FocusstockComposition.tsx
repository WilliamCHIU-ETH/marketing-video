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
  FOCUSSTOCK_BGM,
  FOCUSSTOCK_INTRO_SEC,
  FOCUSSTOCK_SHOT_RUNS,
  FOCUSSTOCK_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  VIDEO_FPS,
  focusstockVisualFrameInterval,
  secToFrame,
} from './focusstock-timeline';
import { Subtitles } from '../Subtitles';
import { ShotFocusImage } from '../ShotFocus';
import videoMeta from '../video-meta.json';
import focusstockAssets from './focusstock-assets.generated.json';
import {
  PreparedPhoneMaterialLayer,
  preparedPhoneSuppressesFocusstockVisual,
} from './PreparedPhoneMaterialLayer';
import { FocusstockBrollLayer } from './FocusstockBrollLayer';

/**
 * 台股晨報 composition（直式 1080×1920）。
 *
 * 跟大盤小報／三大法人同一個模子、各自獨立（只共用 ../Subtitles.tsx）。藍色主題。
 *
 * 版型（2026-08-11 使用者提供參考圖量測）：
 *   - 開場卡（focusstock-intro-frame.jpg，1 秒）：舊底圖上的節目名稱由白底動態標籤完整覆蓋，
 *     動態疊：日期、節目名稱與標題兩行。
 *   - 主段：講者全螢幕 + 無字常駐 header（focusstock-header-overlay-v2.png）
 *     ＋動態日期與節目名稱（皆讀 video-meta.json）＋字幕底部置中。
 *   - 日期顯示 MMDD 無斜線（0810），跟大盤小報/三大法人一致（2026-08-11 使用者統一）。只有直式。
 */

// 日期顏色：主段（白框上）使用品牌藍；開場卡（藍底上）用白。
/**
 * ⚠️⚠️ 版面定案值（使用者拍板，勿隨意覆蓋）⚠️⚠️
 * 版面數字集中在這裡，不要散回 JSX。改動前先確認手上的檔案含有這個區塊。
 */
const FS_LAYOUT = {
  /** 開場卡日期 */
  introDate: { top: 440, left: 0, width: 1080, fontSize: 250 },
  /** 開場卡節目名稱：覆蓋底圖內舊有的印死文字 */
  introLabel: { top: 730, left: 112, width: 856, height: 234, fontSize: 150 },
  /** 開場卡標題：2026-08-12 使用者要求 95 → 145（+50px） */
  // 2026-08-17：145 → 142。中文字寬正好等於字級，7 字 = 7×字級；
  // 可用寬度是 1080-80=1000px，145px 時 7 字要 1015px 會折行，142px 才放得下（994px）。
  // 使用者要求「一行放得下七個字」，且字級不再隨長度縮小（縮小邏輯已移除）。
  introTitle: { top: 1010, fontSize: 142 },
  /** 主段 header bar：無字白框以分隔線切成日期與節目名稱兩區 */
  mainDate: { top: 197, left: 62, width: 258, fontSize: 86 },
  mainLabel: { top: 183, left: 332, width: 625, height: 142, fontSize: 112 },
};

const FOCUS_BLUE = '#0152F5';

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

export const FocusstockComposition: React.FC = () => {
  const introFrames = secToFrame(FOCUSSTOCK_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(FOCUSSTOCK_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：focusstock-intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('focusstock-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 日期：動態節目名稱白框上方、整幅置中、白色（藍底上）。 */}
        {/* 2026-08-11 開場卡日期改直立（italic=false）、往上 10（450→440） */}
        <FocusstockDateBadge
          top={440}
          left={0}
          width={1080}
          fontSize={250}
          color="#ffffff"
          textShadow="5px 3px 14px rgba(0,0,0,0.30)"
          italic={false}
        />
        <FocusstockIntroLabel {...FS_LAYOUT.introLabel} />
        {/* 標題：白框下方（box 底 ≈964），兩行都黃色。 */}
        <FocusstockTitleCard {...FS_LAYOUT.introTitle} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        <AbsoluteFill>
          <OffthreadVideo
            src={staticFile('heygen.mp4')}
            volume={1.5}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center center',
              // 2026-08-11 使用者要求講者影片下移 100px（上緣露出由 header bar 蓋住、底部裁掉 100px）
              transform: 'translateY(100px)',
            }}
          />
        </AbsoluteFill>

        {/* 截圖段：全螢幕切換（v1，FOCUSSTOCK_SHOTS 目前為空） */}
        {/* 截圖段：連續使用同一張圖的片段已合併成 run，
            圖片全程留在畫面上、只有黃框移動，不會圖→人→圖地閃。 */}
        {FOCUSSTOCK_SHOT_RUNS.filter((run) =>
          !preparedPhoneSuppressesFocusstockVisual(run.startSec, run.endSec)).map((run, idx) => {
          const interval = focusstockVisualFrameInterval(run.startSec, run.endSec);
          return (
            <Sequence
              key={`run-${idx}`}
              from={interval.startFrame}
              durationInFrames={interval.durationInFrames}
            >
              <ShotFocusImage run={run} width={VIDEO_WIDTH} height={VIDEO_HEIGHT} fps={VIDEO_FPS} />
            </Sequence>
          );
        })}

        {/* Producer-owned carried plan; suppressed cards never mount. */}
        <FocusstockBrollLayer />

        {/* Capture 已完成手機內部的焦點、縮放與呈現；這裡只負責 scene container 與 placement。 */}
        <PreparedPhoneMaterialLayer />

        {/* 字幕層：沿用同一套（底部置中、未修改） */}
        <Subtitles />

        {/* 常駐 header bar：藍色金融新聞圖層 + CMoney logo + 無字白色長框 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('focusstock-header-overlay-v2.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        <FocusstockDateBadge
          {...FS_LAYOUT.mainDate}
          color={FOCUS_BLUE}
          italic={false}
        />
        <FocusstockHeaderLabel {...FS_LAYOUT.mainLabel} />
      </Sequence>

      {/* === BGM（選配）===
          assets/焦點股日報/bgm.wav 沒放時，use-focusstock-assets 會把 hasBgm 設成 false，
          這裡就整個不掛音軌。否則 Remotion 會去抓不存在的檔案、render 直接失敗
          （2026-08-12 實際踩到：404 focusstock-bgm.wav）。
          檔名讀旗標裡的實際值，因為使用者可能放 BGM.mp3 而不是 bgm.wav。 */}
      {focusstockAssets.hasBgm && (
        <Audio
          src={staticFile(
            (focusstockAssets as { bgmFile?: string | null }).bgmFile || FOCUSSTOCK_BGM.src
          )}
          volume={(f) => {
            const fadeIn = secToFrame(FOCUSSTOCK_BGM.fadeInSec);
            const fadeOut = secToFrame(FOCUSSTOCK_BGM.fadeOutSec);
            if (f < fadeIn) return FOCUSSTOCK_BGM.volume * (f / fadeIn);
            if (f > totalFrames - fadeOut)
              return FOCUSSTOCK_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
            return FOCUSSTOCK_BGM.volume;
          }}
        />
      )}
    </AbsoluteFill>
  );
};

/**
 * APP 截圖聚焦參數（跟三大法人同一套視覺語言）。
 * 有 cell（旁白講到的數字在圖上的位置）時：把該數字捲到聚焦線、其餘壓暗、畫黃框，
 * 圖片沒蓋到的地方壓深灰黑（不露出講者）。沒有 cell 就整張顯示。
 */
const SHOT_FOCUS = {
  /** 要框的數字落在畫面的這個高度（避開上方 header、下方字幕） */
  focusY: 760,
  /** 明亮帶＝以該數字為中心的上下範圍（畫面 px） */
  bandHalf: 190,
  /** 帶外壓暗程度 */
  dim: 0.72,
  /** 圖片外露處的底色：深灰黑，不讓講者透出來 */
  backdrop: '#0b0d12',
  /** 黃框相對數字框的外擴（圖片座標 px） */
  pad: { x: 26, y: 18 },
  highlight: '#FFE600',
};

// 日期牌：讀 video-meta.json.headerDate（MMDD），格式化成「MM/DD」（08/10）後斜體顯示。
// color / textShadow 由呼叫端傳（開場卡白色帶陰影、主段藍色不帶陰影）。
const FocusstockDateBadge: React.FC<{
  top: number;
  left: number;
  width: number;
  fontSize: number;
  color: string;
  textShadow?: string;
  italic?: boolean; // 預設斜體（開場卡）；主段 bar 日期傳 false 不傾斜
}> = ({ top, left, width, fontSize, color, textShadow, italic = true }) => {
  const raw = String((videoMeta as any).headerDate ?? '');
  if (!raw) return null;
  // 2026-08-11 使用者要求三個版型日期一致：都顯示 MMDD 無斜線（0810），不插斜線。
  const date = raw;
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
            fontStyle: italic ? 'italic' : 'normal',
            color,
            letterSpacing: -2,
            lineHeight: 1,
            ...(textShadow ? { textShadow } : {}),
          }}
        >
          {date}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const FocusstockHeaderLabel: React.FC<{
  top: number;
  left: number;
  width: number;
  height: number;
  fontSize: number;
}> = ({ top, left, width, height, fontSize }) => {
  const label = String((videoMeta as any).headerLabel ?? '').trim();
  if (!label) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontFamily:
            '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
          fontSize,
          fontWeight: 900,
          color: FOCUS_BLUE,
          letterSpacing: 6,
          lineHeight: 1,
          textShadow: '0 3px 0 rgba(1,82,245,0.10)',
        }}
      >
        {label}
      </div>
    </AbsoluteFill>
  );
};

const FocusstockIntroLabel: React.FC<{
  top: number;
  left: number;
  width: number;
  height: number;
  fontSize: number;
}> = ({ top, left, width, height, fontSize }) => {
  const label = String((videoMeta as any).headerLabel ?? '').trim();
  if (!label) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width,
          height,
          backgroundColor: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontFamily:
            '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
          fontSize,
          fontWeight: 900,
          color: FOCUS_BLUE,
          letterSpacing: 2,
          lineHeight: 1,
        }}
      >
        {label}
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：只在開場卡顯示，讀 video-meta.json.titleText。焦點股日報兩行都黃色（使用者版型）。
const FOCUS_YELLOW = '#FFE600';

const FocusstockTitleCard: React.FC<{ top: number; fontSize: number }> = ({
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
        {lines.map((line: string, i: number) => {
          // 2026-08-17 使用者定案：標題可以超過六個字、可以換行，但**字級一律不變**。
          // 原本這裡會估算單行寬度、超出就等比例縮小 —— 結果是打長一點整個標題就變小
          //（13 字時 145px 被壓成 78px，使用者回報「標題字太小了」）。
          // 現在拿掉縮放，交給外層 left:40 / right:40 的寬度自然折行。
          return (
          <div
            key={i}
            style={{
              fontFamily:
                '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
              fontSize,
              fontWeight: 800,
              fontStyle: 'italic',
              color: FOCUS_YELLOW,
              lineHeight: 1.4,
              textAlign: 'center',
              WebkitTextStroke: '3px #000000',
              paintOrder: 'stroke fill',
              textShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}
          >
            {line}
          </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
