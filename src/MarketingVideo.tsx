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
  BGM,
  HEYGEN_DURATION_SEC,
  GRAPHIC_BROLL_CARDS,
  OUTRO_DURATION_SEC,
  OVERLAYS,
  MARKETING_SHOT_RUNS,
  TEXT_CARDS,
  Overlay,
  VIDEO_DURATION_SEC,
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  secToFrame,
} from './timeline';
import { TextCard } from './TextCard';
import { Subtitles } from './Subtitles';
import { ShotFocusImage } from './ShotFocus';
import { GraphicBrollCard } from './GraphicBrollCard';

/**
 * 安全淡入淡出進度（0→1→0）。
 * 當 overlay 太短，塞不下兩段 fade 時，interpolate 的 inputRange 會出現
 * 中間兩點交叉 / 重合 → 「inputRange must be strictly monotonically increasing」報錯。
 * 這裡把 fade 夾到「嚴格小於半長」，太短就直接全顯示，保證 inputRange 永遠遞增。
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

/**
 * 主行銷影片：
 *   階段 1（heygen 期）：HeyGen 主影片 + 疊圖 + 字幕 + 品牌外框
 *   階段 2（outro 期，選配）：結尾影片 outro.mp4（無字幕、無疊圖、無外框）
 *   BGM：跨整支影片，頭尾淡入淡出
 */
export const MarketingVideo: React.FC = () => {
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const outroFrames = secToFrame(OUTRO_DURATION_SEC);
  const hasOutro = OUTRO_DURATION_SEC > 0;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 階段 1：heygen 期 === */}
      <Sequence from={0} durationInFrames={heygenFrames}>
        {/* 主軌：HeyGen 影片（疊圖出現時自動打霧或淡出讓位給 PIP）
            預設置中（translateY: 0）— 適用於直式 1080×1920 的 heygen.mp4
            如果換成 16:9 影片，可能需要 translateY('100px') 把人物往下挪避免被外框蓋到 */}
        <HeygenMain />

        {/* M02A composition-native graphic B-roll：蓋在 Avatar 上；
            manual marketing shots／overlay 若同時存在，仍由後面的 layer 優先顯示。 */}
        {GRAPHIC_BROLL_CARDS.map((card) => (
          <Sequence
            key={card.id}
            from={secToFrame(card.startSec)}
            durationInFrames={Math.max(1, secToFrame(card.endSec - card.startSec))}
          >
            <GraphicBrollCard item={card} />
          </Sequence>
        ))}

        {/* 圖片疊層（只在 heygen 期顯示）
            如果這張與下一張都是 PIP 且間隔 < PIP_BRIDGE_SEC，
            把這張的視覺結束時間延伸到下一張開始 → 兩張圖無縫銜接 */}
        {/* 自動配圖的全螢幕聚焦截圖（auto-shot 產生）。
            與下方 (imageN) 子母畫面 overlay **並存**：手動標記的段落自動不會產生，
            所以兩者不會打架。放在 overlay 與外框之下、講者之上。 */}
        {MARKETING_SHOT_RUNS.map((run, idx) => {
          const from = secToFrame(run.startSec);
          const durationInFrames = Math.max(1, secToFrame(run.endSec - run.startSec));
          return (
            <Sequence key={`mshot-${idx}`} from={from} durationInFrames={durationInFrames}>
              <ShotFocusImage run={run} width={VIDEO_WIDTH} height={VIDEO_HEIGHT} fps={VIDEO_FPS} />
            </Sequence>
          );
        })}

        {OVERLAYS.map((overlay, idx) => {
          const next = OVERLAYS[idx + 1];
          const shouldBridge =
            overlay.pip &&
            next?.pip &&
            next.startSec - overlay.endSec < PIP_BRIDGE_SEC;
          // bridge 只延長、不縮短（兩張圖同 startSec 時避免算出 0/負 frame）
          const visualEndSec = shouldBridge
            ? Math.max(overlay.endSec, next.startSec)
            : overlay.endSec;

          const from = secToFrame(overlay.startSec);
          const durationInFrames = Math.max(
            1,
            secToFrame(visualEndSec - overlay.startSec)
          );
          const adjustedOverlay = { ...overlay, endSec: visualEndSec };

          return (
            <Sequence
              key={`${overlay.src}-${idx}`}
              from={from}
              durationInFrames={durationInFrames}
            >
              <OverlayImage overlay={adjustedOverlay} />
            </Sequence>
          );
        })}

        {/* 文字特效卡 */}
        {TEXT_CARDS.map((card, idx) => (
          <Sequence
            key={`textcard-${idx}`}
            from={secToFrame(card.startSec)}
            durationInFrames={Math.max(1, secToFrame(card.endSec - card.startSec))}
          >
            <TextCard item={card} />
          </Sequence>
        ))}

        {/* PIP 右上角圓框：放在「疊圖之後」確保在最上層、不會被圖蓋住 */}
        <HeygenPip />

        {/* 字幕層：放在外框下、截圖上（只在 heygen 期）*/}
        <Subtitles />

        {/* 品牌外框（靜態 PNG）：只在 heygen 期蓋在最上層；outro 期不顯示
            - frame.png 必須是 1080×1920 RGBA（中央透明）
              抽取指令：ffmpeg -i frame.mov -vf format=rgba -frames:v 1 frame.png
            - 想換回動畫版本：把 Img 換回 OffthreadVideo，src 改 frame.webm */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('frame.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>

        {/* 標題文字：動態從 video-meta.json 讀取 */}
        <TitleOverlay />
      </Sequence>

      {/* === 階段 2：outro 期（選配，僅當有 outro.mp4 時播放）=== */}
      {hasOutro && (
        <Sequence from={heygenFrames} durationInFrames={outroFrames}>
          <AbsoluteFill>
            <OffthreadVideo
              src={staticFile('outro.mp4')}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </AbsoluteFill>
        </Sequence>
      )}

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出，音量 15% 不蓋過人聲 === */}
      <Audio
        src={staticFile(BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(BGM.fadeInSec);
          const fadeOut = secToFrame(BGM.fadeOutSec);
          const total = secToFrame(VIDEO_DURATION_SEC);
          if (f < fadeIn) return BGM.volume * (f / fadeIn);
          if (f > total - fadeOut)
            return BGM.volume * Math.max(0, (total - f) / fadeOut);
          return BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 計算當前 frame 的視覺狀態（blur / pip 進度）
 * 拆出來給 HeygenMain 與 HeygenPip 共用
 */
const BLUR_MAX = 20;
const PIP_SIZE = 360;
const PIP_TOP = 268;
const PIP_RIGHT = 60;
const PIP_BRIDGE_SEC = 0; // 兩個 PIP 疊圖相距 < 此值 → 自動橋接成連續 PIP（不會中間跳回主畫面）

/**
 * 把連續的 PIP overlay 合併成「PIP 區塊」
 * 例：image2 (25.50~27.52) + image3 (27.90~30.72) 間隔 0.4s → 合併成 25.50~30.72 一塊
 * 中間的空檔 PIP 不會消失，視覺更連貫
 */
type PipBlock = {
  startSec: number;
  endSec: number;
  fade: number;
  /** 此區塊「全部成員」都標 noBlur 才視為 noBlur（保守做法） */
  noBlur: boolean;
};

const PIP_BLOCKS: PipBlock[] = (() => {
  const pipOnly = OVERLAYS.filter((o) => o.pip).sort(
    (a, b) => a.startSec - b.startSec
  );
  const blocks: PipBlock[] = [];
  for (const o of pipOnly) {
    const last = blocks[blocks.length - 1];
    if (last && o.startSec - last.endSec < PIP_BRIDGE_SEC) {
      last.endSec = Math.max(last.endSec, o.endSec); // 合併
      last.noBlur = last.noBlur && (o.noBlur ?? false); // 全員都 noBlur 才 noBlur
    } else {
      blocks.push({
        startSec: o.startSec,
        endSec: o.endSec,
        fade: o.fade ?? 0.25,
        noBlur: o.noBlur ?? false,
      });
    }
  }
  return blocks;
})();

function useOverlayState() {
  const frame = useCurrentFrame();
  let blur = 0;
  let pipProgress = 0;

  // 一般疊圖 → 累加 blur（除非 noBlur）
  for (const overlay of OVERLAYS) {
    if (overlay.pip) continue; // pip 在下方用 PIP_BLOCKS 處理
    const oStart = secToFrame(overlay.startSec);
    const oEnd = secToFrame(overlay.endSec);
    if (frame < oStart || frame > oEnd) continue;
    const progress = fadeProgress(frame, oStart, oEnd, overlay.fade ?? 0.25);
    if (!overlay.noBlur) {
      blur = Math.max(blur, BLUR_MAX * progress);
    }
  }

  // PIP → 用合併後的 block 算進度（連貫）；block.noBlur 全員都 noBlur 才不打霧
  for (const block of PIP_BLOCKS) {
    const bStart = secToFrame(block.startSec);
    const bEnd = secToFrame(block.endSec);
    if (frame < bStart || frame > bEnd) continue;
    const progress = fadeProgress(frame, bStart, bEnd, block.fade);
    pipProgress = Math.max(pipProgress, progress);
    if (!block.noBlur) {
      blur = Math.max(blur, BLUR_MAX * progress);
    }
  }

  // 如果有任何 noBlur 的一般疊圖正在顯示，強制 blur 歸零
  const hasActiveNoBlur = OVERLAYS.some(o => {
    if (o.pip) return false;
    if (!o.noBlur) return false;
    const oStart = secToFrame(o.startSec);
    const oEnd = secToFrame(o.endSec);
    return frame >= oStart && frame <= oEnd;
  });
  if (hasActiveNoBlur) blur = 0;
  return { blur, pipProgress };
}

/**
 * 主畫面講者：依 useOverlayState() 算出的 blur 強度套濾鏡
 *   - 一般疊圖 / PIP 疊圖都會貢獻 blur（除非該疊圖標 noblur）
 *   - 永遠顯示（PIP 時也是「模糊背景」而非黑屏）
 */
const HeygenMain: React.FC = () => {
  const { blur } = useOverlayState();
  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={staticFile('heygen.mp4')}
        volume={1.5}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          transform: 'scale(1.03)',
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 右上角 PIP 圓框：要放在「疊圖之後」渲染才會在最上層、不被圖蓋住
 * 音訊跟主畫面同源 → 用 muted 避免雙重播放
 *
 * 為避免 render 時 OffthreadVideo 重複 fetch 同一支 heygen.mp4 造成 proxy timeout：
 *   - 只在 PIP 區段內渲染 OffthreadVideo（不顯示時直接 return null）
 *   - 即使 Studio 預覽切入時有一瞬間冷啟動，render 端反而省下大量重複 fetch
 */
const HeygenPip: React.FC = () => {
  const { pipProgress } = useOverlayState();
  if (pipProgress <= 0) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          top: PIP_TOP,
          right: PIP_RIGHT,
          width: PIP_SIZE,
          height: PIP_SIZE,
          borderRadius: '50%',
          overflow: 'hidden',
          border: '6px solid #ffffff',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
          opacity: pipProgress,
          transform: `scale(${0.6 + 0.4 * pipProgress})`,
          transformOrigin: 'center',
        }}
      >
        <OffthreadVideo
          src={staticFile('heygen.mp4')}
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center 28%',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

/**
 * 單張疊圖元件：含淡入淡出 + 位置 / 大小控制
 *
 * 位置（在 public/script.txt 用 (imageN:top) (imageN:bottom) 標記）：
 *   - top    → 靠上（避開講者頭部）
 *   - center → 置中（預設，會蓋住講者）
 *   - bottom → 靠下（避開講者下半身與字幕）
 *
 * 大小（用 ,small ,medium 加在位置後面，例：(imageN:top,small)）：
 *   - small  → 寬度 50%
 *   - medium → 寬度 75%
 *   - full   → 寬度 100%（預設）
 */
const OverlayImage: React.FC<{ overlay: Overlay }> = ({ overlay }) => {
  const frame = useCurrentFrame();
  const totalFrames = secToFrame(overlay.endSec - overlay.startSec);

  const opacity = fadeProgress(frame, 0, totalFrames, overlay.fade ?? 0.25);

  // 位置 → flexbox 對齊（垂直）
  const position = overlay.position ?? 'center';
  const justify: React.CSSProperties['justifyContent'] =
    position === 'top'
      ? 'flex-start'
      : position === 'bottom'
        ? 'flex-end'
        : 'center';

  // 上下位置時保留的安全邊距（避免太貼邊或撞到字幕條）
  // 若有指定 offsetPx，就用自訂值覆寫預設
  const paddingTop =
    position === 'top'
      ? (overlay.offsetPx ?? 220)
      : 0;
  const paddingBottom =
    position === 'bottom'
      ? (overlay.offsetPx ?? 420)
      : 0;

  // 大小 → 寬度
  //   widthPx（自訂）優先 → size 預設 → 預設 calc(100% - 110px)
  //   small  → 50%
  //   medium → 75%
  //   full   → 100%（真正貼滿邊）
  const widthByMap: Record<string, string> = {
    small: '50%',
    medium: '75%',
    full: '100%',
  };
  const width = overlay.widthPx
    ? `${overlay.widthPx}px`
    : overlay.size
      ? widthByMap[overlay.size]
      : 'calc(100% - 110px)';
  // 高度：有指定就用 px，否則 auto 依寬度比例
  const height = overlay.heightPx ? `${overlay.heightPx}px` : 'auto';

  return (
    <AbsoluteFill
      style={{
        opacity,
        justifyContent: justify,
        alignItems: 'center',
        paddingTop,
        paddingBottom,
      }}
    >
      <Img
        src={staticFile(overlay.src)}
        style={{
          width,
          height,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 標題覆蓋層：從 video-meta.json 讀取標題文字，渲染成深藍色文字框
 */
import videoMeta from './video-meta.json';

const TITLE_COLORS = ['#00124E', '#002BB8'];
// 標題視覺中心軸（白色標題板的中心 x，量自 frame.png）。標題塊自己 translateX(-50%) 對齊到此軸，
// 不論字數多寡都置中，不需再隨標題長度手動微調。要左右微調整個標題就改這一個值。
const TITLE_CENTER_X = 651;

const TitleOverlay: React.FC = () => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {/* 外層：把旋轉軸釘在標題板中心 x、top=97；內層 translateX(-50%) 讓標題塊以自身中心對齊此軸 */}
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
