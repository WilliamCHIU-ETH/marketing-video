import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  staticFile,
  useVideoConfig,
} from 'remotion';
import generatedPlan from './prepared-phone-material.generated.json';
import { focusstockVisualFrameInterval } from './focusstock-timeline';

type ReadyPlan = {
  schemaVersion: 1;
  mode: 'ready-to-place';
  template: 'focusstock';
  timelineBasis: 'focusstock-main-v1';
  source: {
    fileName: string;
    artifactRole: 'prepared-video';
    sha256: string;
    size: number;
    mimeType: 'video/mp4';
    media: { codec: 'h264'; width: number; height: number; durationSeconds: number };
  };
  presentation: { profileId: 'chipk.stock-main-force-portrait.v1' };
  visualOwnership: {
    owner: 'prepared-phone-video';
    conflictPolicy: 'suppress-entire-overlapping-placement';
    suppressedChannels: ['focusstock-shots', 'focusstock-broll'];
  };
  placement: {
    layoutId: 'focusstock-phone-portrait.v1';
    fps: 30;
    startFrame: number;
    endFrame: number;
    startSec: number;
    endSec: number;
    durationInFrames: number;
    playbackRate: 1;
    muted: true;
    objectFit: 'contain';
    crop: 'none';
    trim: 'none';
    loop: false;
  };
};

function readyPlan(): ReadyPlan | null {
  const value = generatedPlan as unknown as Record<string, unknown>;
  if (value.mode === 'disabled') return null;
  const plan = value as unknown as ReadyPlan;
  const source = plan.source;
  const placement = plan.placement;
  if (plan.schemaVersion !== 1 || plan.mode !== 'ready-to-place'
      || plan.template !== 'focusstock' || plan.timelineBasis !== 'focusstock-main-v1'
      || source?.artifactRole !== 'prepared-video' || source?.mimeType !== 'video/mp4'
      || source?.fileName !== 'prepared-phone-material.mp4'
      || !/^[a-f0-9]{64}$/.test(source?.sha256 || '')
      || source?.media?.codec !== 'h264'
      || !Number.isFinite(source?.media?.durationSeconds) || source.media.durationSeconds <= 0
      || plan.presentation?.profileId !== 'chipk.stock-main-force-portrait.v1'
      || plan.visualOwnership?.owner !== 'prepared-phone-video'
      || plan.visualOwnership?.conflictPolicy !== 'suppress-entire-overlapping-placement'
      || plan.visualOwnership?.suppressedChannels?.length !== 2
      || plan.visualOwnership.suppressedChannels[0] !== 'focusstock-shots'
      || plan.visualOwnership.suppressedChannels[1] !== 'focusstock-broll'
      || placement?.layoutId !== 'focusstock-phone-portrait.v1'
      || placement?.fps !== 30
      || !Number.isInteger(placement?.startFrame) || placement.startFrame < 0
      || !Number.isInteger(placement?.endFrame) || placement.endFrame <= placement.startFrame
      || !Number.isFinite(placement?.startSec) || placement.startSec < 0
      || !Number.isFinite(placement?.endSec) || placement.endSec <= placement.startSec
      || !Number.isInteger(placement?.durationInFrames) || placement.durationInFrames < 1
      || placement.durationInFrames !== Math.ceil(source.media.durationSeconds * 30)
      || placement.startFrame !== Math.round(placement.startSec * 30)
      || placement.endFrame !== Math.round(placement.endSec * 30)
      || placement.endFrame - placement.startFrame !== placement.durationInFrames
      || placement.playbackRate !== 1 || placement.muted !== true
      || placement.objectFit !== 'contain' || placement.crop !== 'none'
      || placement.trim !== 'none' || placement.loop !== false) {
    throw new Error('prepared phone material plan is incompatible');
  }
  return plan;
}

/**
 * Semantic-merge contract for any Focusstock visual channel living beside this clean slice.
 * Suppress the whole generic placement when it overlaps the provider-owned phone interval; do not
 * trim either clip and do not depend on JSX layer order. This is intentionally exported so the
 * existing Focusstock graphic-B-roll branch can consume one deterministic rule during integration.
 */
export function preparedPhoneSuppressesFocusstockVisual(startSec: number, endSec: number): boolean {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new Error('Focusstock visual placement is invalid');
  }
  const plan = readyPlan();
  const interval = focusstockVisualFrameInterval(startSec, endSec);
  return plan !== null
    && interval.startFrame < plan.placement.endFrame
    && interval.endFrame > plan.placement.startFrame;
}

/**
 * Marketing Video only owns the scene container and timeline placement here.
 * The provider-delivered phone clip is played once from frame zero at 1x, muted, with no crop,
 * trim, loop, or internal transform.
 */
export const PreparedPhoneMaterialLayer: React.FC = () => {
  const { fps } = useVideoConfig();
  const plan = readyPlan();
  if (!plan) return null;
  if (fps !== 30) throw new Error('prepared phone material requires the Focusstock 30fps timeline');
  const from = plan.placement.startFrame;
  return (
    <Sequence from={from} durationInFrames={plan.placement.durationInFrames}>
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <div
          style={{
            position: 'absolute',
            left: 85,
            top: 280,
            width: 910,
            height: 1360,
            backgroundColor: '#05070b',
          }}
        >
          <OffthreadVideo
            src={staticFile(plan.source.fileName)}
            muted
            volume={0}
            playbackRate={1}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
      </AbsoluteFill>
    </Sequence>
  );
};
