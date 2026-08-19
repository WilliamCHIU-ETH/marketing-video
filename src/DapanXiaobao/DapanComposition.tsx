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
  DAPAN_INTRO_SEC,
  DAPAN_SHOT_RUNS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  DAPAN_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_FPS,
  secToFrame,
} from './dapan-timeline';
import { Subtitles } from '../Subtitles';
import { ShotFocusImage } from '../ShotFocus';
import videoMeta from '../video-meta.json';

/**
 * 大盤小報 composition。
 *
 * v1 範圍（2026-08-06，「先不考慮全自動化」拍板）：
 *   - 開場卡（intro-frame.jpg，1 秒）+ 主段（heygen 影片 + 常駐 header bar + 字幕 + 全螢幕截圖切換）
 *   - 日期牌動態渲染（video-meta.json.headerDate，MMDD），標題文字是固定畫在 intro-frame.jpg /
 *     header-overlay.png 上的美術、不動態產生
 *   - 截圖段 v1：只做「全螢幕切換」，不含 OCR 黃框標註 / 鏡頭推進放大（留待下一輪）
 *   - 無 PIP、無主畫面模糊、無 outro CTA（大盤小報單純講內容、不催下載）
 *
 * 跟 ../MarketingVideo.tsx 是完全獨立的兩條 composition；為避免版型互相拖累，
 * 不共用渲染邏輯檔，只共用 ../Subtitles.tsx（原樣重用、未修改）。
 */

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

export const DapanComposition: React.FC = () => {
  const introFrames = secToFrame(DAPAN_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(DAPAN_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('dapan-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 2026-08-07 修正：intro-frame.jpg 的日期牌梯形跟 header-overlay.png 不同 y 座標
            （量到 top≈479，header-overlay.png 是 top≈108），之前誤用同一組座標疊在兩張圖上、
            intro 那張因此歪掉。兩張圖分開傳 top 值 */}
        <DateBadge top={479} />
        <TitleCard topOffset={70} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        {/* 主軌：講者影片，無 PIP、無模糊
            2026-08-07 修正：大盤小報的來源影片是「橫式（16:9）、人物置中」，不是 HeyGen
            直式輸出，所以用 objectFit:'cover'（等比放大＋置中裁切左右）把畫面填滿直式畫布，
            人物本來就在正中央，裁掉的是左右兩側背景，跟現有 MarketingVideo.tsx 那套
            「contain + scale(1.03)」（給直式來源用）是不同情境，這裡不能沿用 */}
        <AbsoluteFill>
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

        {/* 截圖段：全螢幕切換（v1，無 OCR 黃框標註） */}
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
              <ShotFocusImage run={run} width={VIDEO_WIDTH} height={VIDEO_HEIGHT} fps={VIDEO_FPS} />
            </Sequence>
          );
        })}

        {/* 字幕層：跟講者段同一套樣式（直接 reuse，未修改），截圖段也照樣顯示在最上層 */}
        <Subtitles />

        {/* 常駐 header bar：全片主段都在最上層，蓋在截圖/字幕之上 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('dapan-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        <DateBadge top={108} />
      </Sequence>

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出 === */}
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

/**
 * 截圖段全螢幕圖片：淡入淡出，蓋滿整個畫面（不是現有模板的 PIP+局部疊圖）
 */


// 日期牌空白區座標（分別實測 intro-frame.jpg 與 header-overlay.png 兩張圖的實際像素，2026-08-07）：
// 藍色梯形 x:60-379 兩張圖一致，但 y 不同——header-overlay.png 是 y:108-293，
// intro-frame.jpg 是 y:479-664（低了 371px，兩張圖的版面設計不是同一個基準）。
// 呼叫端要各自傳對的 top 值，不能共用一組座標（2026-08-06 版本的 bug 就是共用同一組）。
const DateBadge: React.FC<{ top: number }> = ({ top }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 55, // 2026-08-07 使用者要求再往左移 5px（原本 60）
          top,
          width: 319,
          height: 185,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily:
              '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
            fontSize: 106, // 2026-08-10 使用者要求放大一點點（110 → 98 → 再 +8 → 106）
            fontWeight: 800,
            fontStyle: 'italic',
            color: '#ffffff',
            letterSpacing: -2,
            lineHeight: 1,
            textShadow: '3px 3px 6px rgba(0,0,0,0.45)', // 2026-08-10 使用者要求右下方向加一點陰影
          }}
        >
          {headerDate}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：只在開場卡（intro-frame.jpg）顯示，讀 video-meta.json.titleText
// （parse-dapan-script.js 從 script.txt 標題段寫入）。第一句白色、其餘黃色（2026-08-07 使用者要求）。
// 位置目前放在 header bar 下方的空白深色區（y 900~1300 一帶），沒有參考影片可以核對，
// 是第一版預設，尚未經實際渲染確認；後續仍要以人工檢視結果調整。
const TITLE_COLORS = ['#ffffff', '#FFE600']; // 2026-08-10 使用者要求第二句更飽和更亮（原本 #FFD700）

const TitleCard: React.FC<{ topOffset?: number }> = ({ topOffset = 0 }) => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 60,
          right: 60,
          // 2026-08-10 使用者要求標題小框跟日期整體區塊下移，topOffset 由呼叫端傳入
          top: 700 + topOffset, // 900 → 850 → 700 → +10 → +30 → 再 +30（區塊整體下移）
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center', // 2026-08-07 使用者要求置中（原本靠左）
          textAlign: 'center',
        }}
      >
        {lines.map((line: string, i: number) => (
          <div
            key={i}
            style={{
              fontFamily:
                '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
              fontSize: 103, // 2026-08-10 使用者要求再放大 5px（72 → 88 → 103 → 113 → 98 → 再 +5 → 103）
              fontWeight: 800,
              fontStyle: 'italic', // 2026-08-10 使用者要求兩句都斜體
              color: i === 0 ? TITLE_COLORS[0] : TITLE_COLORS[1],
              lineHeight: 1.4,
              textAlign: 'center',
              // 2026-08-07 使用者參考圖是「粗黑描邊」海報字風格，用 -webkit-text-stroke
              // 加黑色描邊（Remotion render 走 headless Chrome，支援這個屬性）
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
