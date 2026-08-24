import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import generatedPlan from './focusstock-broll.generated.json';
import { preparedPhoneSuppressesFocusstockVisual } from './PreparedPhoneMaterialLayer';
import { focusstockVisualFrameInterval } from './focusstock-timeline';

type FocusstockBrollClip = {
  id: string;
  src: string;
  sha256: string;
  startSec: number;
  endSec: number;
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
};

type FocusstockBrollPlan = {
  schemaVersion: 1;
  mode: 'disabled' | 'custom-v1';
  timelineBasis: 'focusstock-main-v1';
  clips: FocusstockBrollClip[];
};

function isSafePublicMp4(value: string): boolean {
  return value.length > 0
    && value.length <= 240
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('//')
    && !value.split('/').includes('..')
    && /^[A-Za-z0-9._/-]+\.mp4$/.test(value);
}

function readyPlan(): FocusstockBrollPlan | null {
  const plan = generatedPlan as unknown as FocusstockBrollPlan;
  if (plan.schemaVersion !== 1 || plan.timelineBasis !== 'focusstock-main-v1'
      || !Array.isArray(plan.clips)) {
    throw new Error('Focusstock custom B-roll plan is incompatible');
  }
  if (plan.mode === 'disabled') {
    if (plan.clips.length !== 0)
      throw new Error('disabled Focusstock custom B-roll plan is not empty');
    return null;
  }
  if (plan.mode !== 'custom-v1' || plan.clips.length === 0)
    throw new Error('Focusstock custom B-roll plan is incompatible');

  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const clip of plan.clips) {
    const interval = focusstockVisualFrameInterval(clip?.startSec, clip?.endSec);
    if (!clip || typeof clip.id !== 'string' || !clip.id || ids.has(clip.id)
        || typeof clip.src !== 'string' || !isSafePublicMp4(clip.src)
        || sources.has(clip.src) || !/^[a-f0-9]{64}$/.test(clip.sha256 || '')
        || clip.startFrame !== interval.startFrame || clip.endFrame !== interval.endFrame
        || clip.durationInFrames !== interval.durationInFrames) {
      throw new Error(`Focusstock custom B-roll clip ${clip?.id || '(unknown)'} is incompatible`);
    }
    ids.add(clip.id);
    sources.add(clip.src);
  }
  return plan;
}

const FocusstockBrollClipLayer: React.FC<{ clip: FocusstockBrollClip }> = ({ clip }) => {
  const frame = useCurrentFrame();
  const fadeFrames = Math.min(5, Math.floor((clip.durationInFrames - 1) / 2));
  const opacity = fadeFrames <= 0 ? 1 : interpolate(
    frame,
    [0, fadeFrames, clip.durationInFrames - 1 - fadeFrames, clip.durationInFrames - 1],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity }}>
      <div
        style={{
          position: 'absolute',
          left: 55,
          top: 400,
          width: 970,
          height: 740,
          overflow: 'hidden',
          borderRadius: 32,
          boxShadow: '0 26px 50px rgba(0, 0, 0, 0.34)',
        }}
      >
        <OffthreadVideo
          src={staticFile(clip.src)}
          muted
          volume={0}
          playbackRate={1}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    </AbsoluteFill>
  );
};

/**
 * File-driven Focusstock custom B-roll branch. A prepared phone interval owns the whole visual
 * interval, so every overlapping custom clip is removed in full before JSX is produced.
 */
export const FocusstockBrollLayer: React.FC = () => {
  const { fps } = useVideoConfig();
  const plan = readyPlan();
  if (!plan) return null;
  if (fps !== 30) throw new Error('Focusstock custom B-roll requires the 30fps main timeline');

  return (
    <>
      {plan.clips.filter((clip) =>
        !preparedPhoneSuppressesFocusstockVisual(clip.startSec, clip.endSec)).map((clip) => (
        <Sequence
          key={clip.id}
          from={clip.startFrame}
          durationInFrames={clip.durationInFrames}
        >
          <FocusstockBrollClipLayer clip={clip} />
        </Sequence>
      ))}
    </>
  );
};
