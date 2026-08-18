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
  DAPAN_BGM,
  DAPAN_LANDSCAPE_DURATION_SEC,
  DAPAN_SHOT_RUNS,
  VIDEO_FPS,
  secToFrame,
} from './dapan-timeline';
import { Subtitles } from '../Subtitles';
import { ShotFocusImage } from '../ShotFocus';
import videoMeta from '../video-meta.json';

/**
 * 大盤小報「橫式版型」composition（16:9，1920×1080）。
 *
 * 與直式 DapanComposition.tsx 的關係（2026-08-10）：
 *   - **共用**：同一份 public/heygen.mp4、字幕（Subtitles.tsx，reuse）、DAPAN_SHOTS 時間軸、BGM。
 *   - **不共用渲染邏輯**：比照專案既有「dapan 與 MarketingVideo 各自獨立、不共用容易互相拖累的
 *     渲染邏輯檔」原則，本檔自包含（自己的 DateBadge / TitleCard / ShotImage / fadeProgress），
 *     不 import 直式那支——這樣調橫式版面不會誤動到已完成的直式版。
 *
 * 橫式版面差異（使用者 2026-08-10 拍板）：
 *   ① 無開場卡——影片直接開始（直式有 1 秒 intro-frame，橫式沒有）。
 *   ② 日期與標題常駐右側品牌面板內（不是只在開場卡）。
 *   ③ 講者影片往左推、集中在左側可見區（來源 16:9 人物置中；右側是不透明品牌面板）。
 *   ④ 字幕置中在左側講者區底部（避開右側面板）。
 *
 * 素材：public/dapan-intro-frame-horizontal.png（1920×1080 RGBA，右側 x1178–1920 不透明
 *       品牌面板：CMoney logo＋大盤小報 header＋藍色梯形日期牌槽；左側透明給講者）。
 *
 * ⚠️ 以下位置/字級都是第一版預設值，等使用者用 `npm start` 預覽 DapanXiaobaoLandscape 後再微調。
 */

// 右側品牌面板左緣（量自 intro-frame_Horizontal.png 的 alpha 通道：opaque 從 x=1178 起）。
// 講者可見區 = 左側 0 ~ PANEL_LEFT_X。
const PANEL_LEFT_X = 1178;
// 橫式畫布尺寸（Root.tsx 註冊為 1920×1080，與直式的 VIDEO_WIDTH/HEIGHT 不同）
const LANDSCAPE_WIDTH = 1920;
const LANDSCAPE_HEIGHT = 1080;

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

export const DapanLandscapeComposition: React.FC = () => {
  const totalFrames = secToFrame(DAPAN_LANDSCAPE_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* 講者影片：往左集中在左側可見區（x0 ~ PANEL_LEFT_X），cover 置中。
          寬度多墊 20px 塞到面板底下，避免左右接縫露黑邊（面板不透明會蓋住）。
          來源 16:9 人物置中 → cover 進 ~1198×1080 後人物仍落在可見區正中央。 */}
      <AbsoluteFill>
        <OffthreadVideo
          src={staticFile('heygen.mp4')}
          volume={1.5}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: PANEL_LEFT_X + 20,
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center center',
            transform: 'scale(1.2)', // 2026-08-10 使用者定案人物放大 1.2（往中心放大；右側溢出被面板蓋掉、上下由畫布裁掉，頭仍在框內）
            transformOrigin: 'center center',
          }}
        />
      </AbsoluteFill>

      {/* 截圖段：全螢幕切換（v1，DAPAN_SHOTS 目前為空）。橫式擺在左側講者可見區。 */}
      {/* 截圖段：只在左側講者可見區（0 ~ PANEL_LEFT_X）作用，右側品牌面板不覆蓋。
          左右各留 20px、捲到重點、上下壓黑（2026-08-12 使用者選定 V3 捲動式）。
          橫式畫布只有 1080 高，聚焦線改用 0.45 高度（直式的 760 在這裡會太低）。 */}
      {DAPAN_SHOT_RUNS.map((run, idx) => {
        const from = secToFrame(run.startSec);
        const durationInFrames = Math.max(
          1,
          secToFrame(run.endSec - run.startSec),
        );
        return (
          <Sequence
            key={`run-${idx}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <ShotFocusImage
              run={run}
              width={LANDSCAPE_WIDTH}
              height={LANDSCAPE_HEIGHT}
              fps={VIDEO_FPS}
              region={{ x: 0, width: PANEL_LEFT_X }}
              focusY={Math.round(LANDSCAPE_HEIGHT * 0.45)}
              margin={20}
            />
          </Sequence>
        );
      })}

      {/* 字幕改放到最上層（面板/日期/標題之後）並靠左 —— 見下方 LandscapeTitleCard 之後 */}

      {/* 常駐右側品牌面板（整片，左側透明、右側不透明）。橫式全程都在，不是只有開場。 */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <Img
          src={staticFile('dapan-intro-frame-horizontal.png')}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>

      {/* 日期牌：常駐在右側面板的藍色梯形槽內 */}
      <LandscapeDateBadge />

      {/* 標題：常駐在右側面板 header 下方 */}
      <LandscapeTitleCard />

      {/* 字幕：靠左、置於左側講者區底部，且放在最上層（面板/日期/標題之後）→ 永遠不被蓋到。
          alignItems: 'flex-start' = 靠左；right = 面板寬 → 字幕只落在左側可見區、不會頂到右側面板；
          maxWidth 收窄讓長句在碰到面板前就自動換行。 */}
      <Subtitles
        containerStyle={{
          justifyContent: 'flex-end',
          alignItems: 'flex-start',
          paddingTop: 0,
          paddingBottom: 70,
          paddingLeft: 60,
          right: 1920 - PANEL_LEFT_X,
        }}
        textStyle={{ fontSize: 52, maxWidth: PANEL_LEFT_X - 180, textAlign: 'left' }}
      />

      {/* BGM：跨整支影片墊底，頭尾淡入淡出（與直式同一支 dapan-bgm.wav） */}
      <Audio
        src={staticFile(DAPAN_BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(DAPAN_BGM.fadeInSec);
          const fadeOut = secToFrame(DAPAN_BGM.fadeOutSec);
          if (f < fadeIn) return DAPAN_BGM.volume * (f / fadeIn);
          if (f > totalFrames - fadeOut)
            return DAPAN_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
          return DAPAN_BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

/** 截圖段全螢幕圖片（橫式：擺在左側講者可見區、淡入淡出） */


// 日期牌：讀 video-meta.json.headerDate（MMDD），擺在右側面板藍色梯形槽內。
// 藍色梯形實測約 x1240–1425 / y255–390（量自 intro-frame_Horizontal.png）。第一版預設值。
const LandscapeDateBadge: React.FC = () => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 1244, // 2026-08-10 依實測校正置中（1240→1258 偏右、又偏低 → 回 1244）
          top: 240, // 實測 0810 略偏低，往上挪 10px 對準梯形中心
          width: 185,
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily:
              '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
            fontSize: 68, // 2026-08-10 使用者要求：先縮到 60、後又要大一點 → 68
            fontWeight: 800,
            fontStyle: 'italic', // 傾斜（配合藍色梯形槽的斜向）
            color: '#ffffff',
            letterSpacing: -2,
            lineHeight: 1,
            textShadow: '3px 3px 6px rgba(0,0,0,0.45)',
          }}
        >
          {headerDate}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：讀 video-meta.json.titleText，常駐在右側面板 header 下方的空白區。
// 第一句白色、其餘黃色（沿用直式的配色與黑描邊海報字風格）。第一版預設值。
const TITLE_COLORS = ['#ffffff', '#FFE600'];

const LandscapeTitleCard: React.FC = () => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: PANEL_LEFT_X + 12,
          right: 24,
          top: 470,
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
              fontSize: 68, // 2026-08-10 使用者要求標題再大一點（58 → 68）
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
