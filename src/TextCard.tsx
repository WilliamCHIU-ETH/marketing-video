import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
import { VIDEO_FPS } from './timeline';

export type TextCardAnim = 'pop' | 'shake' | 'zoom' | 'typewriter' | 'slide' | 'fade' | 'flash' | 'highlight';

export type TextCardItem = {
  text: string;
  anim: TextCardAnim;
  startSec: number;
  endSec: number;
};

const FADE_SEC = 0.2;

const TEXT_SHADOW = '0 2px 8px rgba(0,0,0,0.6), 0 0 2px rgba(0,0,0,0.9), 0 0 1px rgba(0,0,0,1)';

export const TextCard: React.FC<{ item: TextCardItem }> = ({ item }) => {
  const frame = useCurrentFrame();
  const totalFrames = Math.round((item.endSec - item.startSec) * VIDEO_FPS);
  const fadeFrames = Math.round(FADE_SEC * VIDEO_FPS);

  const baseOpacity = interpolate(
    frame,
    [0, fadeFrames, totalFrames - fadeFrames, totalFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  let transform = '';
  let opacity = baseOpacity;
  let extra: React.CSSProperties = {};

  switch (item.anim) {
    case 'pop': {
      const scale = interpolate(frame, [0, fadeFrames, fadeFrames + 4], [0.3, 1.15, 1.0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      transform = `scale(${scale})`;
      break;
    }
    case 'zoom': {
      const scale = interpolate(frame, [0, fadeFrames, fadeFrames + 6, fadeFrames + 10], [0.1, 1.2, 0.95, 1.0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      transform = `scale(${scale})`;
      break;
    }
    case 'slide': {
      const y = interpolate(frame, [0, fadeFrames], [80, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      transform = `translateY(${y}px)`;
      break;
    }
    case 'fade': {
      break;
    }
    case 'shake': {
      const shakeFrames = 12;
      const shakePattern = [0, -12, 12, -10, 10, -6, 6, -3, 3, -1, 1, 0];
      const shakeX = frame < shakeFrames ? (shakePattern[frame] ?? 0) : 0;
      transform = `translateX(${shakeX}px)`;
      break;
    }
    case 'flash': {
      const flashOpacity = frame < 4 ? (frame % 2 === 0 ? 0 : 1) : baseOpacity;
      opacity = flashOpacity;
      break;
    }
    case 'highlight': {
      extra = {
        backgroundImage: `linear-gradient(90deg, transparent ${Math.max(0, 100 - frame * 8)}%, #FFD700 ${Math.max(0, 100 - frame * 8)}%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };
      break;
    }
    case 'typewriter': {
      const visibleChars = Math.floor(interpolate(frame, [0, totalFrames * 0.6], [0, item.text.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
      const displayText = item.text.slice(0, visibleChars);
      return (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none' }}>
          <div style={{
            fontFamily: '"Noto Sans TC", sans-serif',
            fontSize: 96,
            fontWeight: 700,
            color: '#FFD700',
            textAlign: 'center',
            textShadow: TEXT_SHADOW,
            padding: '0 60px',
            opacity: baseOpacity,
          }}>
            {displayText}
          </div>
        </AbsoluteFill>
      );
    }
  }

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none' }}>
      <div style={{
        fontFamily: '"Noto Sans TC", sans-serif',
        fontSize: 96,
        fontWeight: 700,
        color: '#FFD700',
        textAlign: 'center',
        textShadow: TEXT_SHADOW,
        padding: '20px 40px',
        opacity,
        transform,
        ...extra,
      }}>
        {item.text}
      </div>
    </AbsoluteFill>
  );
};
