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
  HEYGEN_DURATION_SEC,
  OUTRO_DURATION_SEC,
  secToFrame,
} from '../timeline';
import { FOCUSSTOCK_SHOT_RUNS } from './focusstock-timeline';
import { ShotFocusImage } from '../ShotFocus';
import { VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS } from '../timeline';
import { Subtitles } from '../Subtitles';
import videoMeta from '../video-meta.json';

/**
 * 焦點股日報「投廣套框版」composition（直式 1080×1920）。
 *
 * 跟客製版（FocusstockComposition）**共用同一支 public/heygen.mp4 與字幕**，差別：
 *   - **無開頭一秒開場卡**、無藍色 header、無日期。
 *   - 套上**籌碼K線的品牌外框** public/focusstock-ad-frame.png（來自 assets/籌碼K線/frame.png，
 *     全螢幕講者在後、外框在前、中央透明）。
 *   - 講者講完**接籌碼K線片尾** public/outro.mp4（投廣 CTA）。
 *   - BGM 用籌碼K線 public/focusstock-ad-bgm.wav，只鋪在講者期（片尾播 outro 自己的音）。
 *
 * 時長 = heygen 期 + outro 期（= ../timeline 的 VIDEO_DURATION_SEC）。講者影片與客製版同一支
 * （已在 run.js 統一 120% 加速），所以這版不另外加速。
 */

const AD_BGM = {
  src: 'focusstock-ad-bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

export const FocusstockAdComposition: React.FC = () => {
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const outroFrames = secToFrame(OUTRO_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 講者期：全螢幕講者 + 籌碼K線外框 + 字幕（無開頭、無日期） === */}
      <Sequence from={0} durationInFrames={heygenFrames}>
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

        {/* 截圖段：跟客製版共用同一份 FOCUSSTOCK_SHOTS（自動配圖產生）。
            疊在講者之上、外框與標題之下 —— 投廣版本來就是在推 App，
            講到哪個畫面就秀哪張 App 截圖，比一直看講者更有說服力。 */}
        {FOCUSSTOCK_SHOT_RUNS.map((run, idx) => {
          const from = secToFrame(run.startSec);
          const durationInFrames = Math.max(1, secToFrame(run.endSec - run.startSec));
          return (
            <Sequence key={`ad-run-${idx}`} from={from} durationInFrames={durationInFrames}>
              <ShotFocusImage run={run} width={VIDEO_WIDTH} height={VIDEO_HEIGHT} fps={VIDEO_FPS} />
            </Sequence>
          );
        })}

        {/* 字幕（沿用同一套、底部置中） */}
        <Subtitles />

        {/* 籌碼K線品牌外框（中央透明、蓋住講者上下邊） */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('focusstock-ad-frame.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>

        {/* 標題：填進外框上方的白色標題板（沿用投廣模板 MarketingVideo 為這張 frame 調好的
            TITLE_CENTER_X=651 / rotate -3.37° / 深藍雙色 / 55px；讀 video-meta.titleText） */}
        <AdTitleOverlay />

        {/* BGM：只鋪在講者期，片尾讓 outro 播自己的音，避免打架 */}
        <Audio
          src={staticFile(AD_BGM.src)}
          volume={(f) => {
            const fadeIn = secToFrame(AD_BGM.fadeInSec);
            const fadeOut = secToFrame(AD_BGM.fadeOutSec);
            if (f < fadeIn) return AD_BGM.volume * (f / fadeIn);
            if (f > heygenFrames - fadeOut)
              return AD_BGM.volume * Math.max(0, (heygenFrames - f) / fadeOut);
            return AD_BGM.volume;
          }}
        />
      </Sequence>

      {/* === 片尾：籌碼K線 outro.mp4（無外框、無字幕，CTA 下載） === */}
      {outroFrames > 0 && (
        <Sequence from={heygenFrames} durationInFrames={outroFrames}>
          <AbsoluteFill>
            <OffthreadVideo
              src={staticFile('outro.mp4')}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </AbsoluteFill>
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

// 標題板 overlay：完全沿用投廣模板 MarketingVideo 的 TitleOverlay（同一張 frame.png，座標/角度/配色照抄）。
// 深藍雙色（第一行 #00124E、其餘 #002BB8）、旋轉 -3.37° 對齊白框、以 TITLE_CENTER_X=651 為中心軸自我置中。
const TITLE_COLORS = ['#00124E', '#002BB8'];
const TITLE_CENTER_X = 651;

const AdTitleOverlay: React.FC = () => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          top: 87,
          left: TITLE_CENTER_X,
          transform: 'rotate(-3.37deg)',
          transformOrigin: 'left top',
        }}
      >
        <div
          style={{
            transform: 'translateX(-50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          {lines.map((line: string, i: number) => (
            <div
              key={i}
              style={{
                fontFamily: '"Noto Sans TC", "PingFang TC", sans-serif',
                fontSize: 55,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                color: TITLE_COLORS[i] ?? TITLE_COLORS[TITLE_COLORS.length - 1],
                lineHeight: 1.3,
                letterSpacing: 0,
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
