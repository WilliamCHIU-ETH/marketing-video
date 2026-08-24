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

// The plan is generated or restored before Remotion bundles this module. A typed CommonJS load
// keeps a fresh checkout typecheckable without committing runtime-generated JSON.
declare const require: (id: string) => unknown;
const generatedPlan = require('./focusstock-broll.generated.json');

type CarriedCard = {
  id: string;
  ordinal: number;
  assetRef: string;
  assetSha256: string;
  assetSize: number;
  mediaType: string;
  inputName: string;
  startCharIdx: number;
  endCharIdx: number;
  startSec: number;
  endSec: number;
  fps: 30;
  mainStartFrame: number;
  mainEndFrame: number;
  mainDurationInFrames: number;
  compositionOffsetFrames: number;
  compositionStartFrame: number;
  compositionEndFrame: number;
  disposition: 'rendered' | 'suppressed_by_prepared';
  suppressedBy: null | 'prepared-phone-video';
};

type CarriedPlan = {
  schemaVersion: 2;
  mode: 'carried-v1';
  template: 'focusstock';
  timelineBasis: 'focusstock-main-v1';
  fps: 30;
  intervalSemantics: 'frame-half-open';
  sourceScriptSha256: string;
  prepared: { planSha256: string; startFrame: number; endFrame: number };
  cards: CarriedCard[];
};

function carriedPlan(): CarriedPlan | null {
  const value = generatedPlan as unknown as Record<string, unknown>;
  if (value.mode === 'disabled') return null;
  const plan = value as unknown as CarriedPlan;
  if (plan.schemaVersion !== 2 || plan.mode !== 'carried-v1'
      || plan.template !== 'focusstock' || plan.timelineBasis !== 'focusstock-main-v1'
      || plan.fps !== 30 || plan.intervalSemantics !== 'frame-half-open'
      || !/^[a-f0-9]{64}$/.test(plan.sourceScriptSha256 || '')
      || !/^[a-f0-9]{64}$/.test(plan.prepared?.planSha256 || '')
      || !Number.isInteger(plan.prepared?.startFrame) || plan.prepared.startFrame < 0
      || !Number.isInteger(plan.prepared?.endFrame)
      || plan.prepared.endFrame <= plan.prepared.startFrame
      || !Array.isArray(plan.cards) || plan.cards.length < 1 || plan.cards.length > 7) {
    throw new Error('Focusstock carried B-roll plan is incompatible');
  }
  const ids = new Set<string>();
  const inputs = new Set<string>();
  for (const [index, card] of plan.cards.entries()) {
    if (!card || typeof card.id !== 'string' || !card.id || ids.has(card.id)
        || card.ordinal !== index + 1 || typeof card.assetRef !== 'string' || !card.assetRef
        || !/^[a-f0-9]{64}$/.test(card.assetSha256 || '')
        || !Number.isSafeInteger(card.assetSize) || card.assetSize < 1
        || card.mediaType !== 'video/mp4'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/i.test(card.inputName || '')
        || card.inputName === 'heygen.mp4'
        || card.inputName === 'prepared-phone-material.mp4'
        || inputs.has(card.inputName)
        || !Number.isInteger(card.startCharIdx) || card.startCharIdx < 0
        || !Number.isInteger(card.endCharIdx) || card.endCharIdx < card.startCharIdx
        || card.fps !== 30
        || !Number.isInteger(card.mainStartFrame) || card.mainStartFrame < 0
        || !Number.isInteger(card.mainEndFrame) || card.mainEndFrame <= card.mainStartFrame
        || card.mainDurationInFrames !== card.mainEndFrame - card.mainStartFrame
        || card.compositionOffsetFrames !== 30
        || card.compositionStartFrame !== card.mainStartFrame + card.compositionOffsetFrames
        || card.compositionEndFrame !== card.mainEndFrame + card.compositionOffsetFrames
        || !['rendered', 'suppressed_by_prepared'].includes(card.disposition)
        || card.suppressedBy !== (card.disposition === 'suppressed_by_prepared'
          ? 'prepared-phone-video' : null)) {
      throw new Error('Focusstock carried B-roll card evidence is incompatible');
    }
    ids.add(card.id);
    inputs.add(card.inputName);
  }
  return plan;
}

const FocusstockGraphicBroll: React.FC<{
  inputName: string;
  durationInFrames: number;
}> = ({ inputName, durationInFrames }) => {
  const frame = useCurrentFrame();
  const fadeFrames = Math.min(5, Math.floor((durationInFrames - 1) / 2));
  const opacity = fadeFrames > 0
    ? interpolate(
        frame,
        [0, fadeFrames, durationInFrames - 1 - fadeFrames, durationInFrames - 1],
        [0, 1, 1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 1;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity }}>
      <div style={{
        position: 'absolute', left: 55, top: 400, width: 970, height: 740,
        overflow: 'hidden', borderRadius: 32,
        boxShadow: '0 26px 50px rgba(0, 0, 0, 0.34)',
      }}>
        <OffthreadVideo
          src={staticFile(inputName)}
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
 * The producer owns placement and disposition. This layer only verifies that contract and renders
 * cards already marked `rendered`; it never shortens clips or decides conflicts from JSX order.
 */
export const FocusstockBrollLayer: React.FC = () => {
  const { fps } = useVideoConfig();
  const plan = carriedPlan();
  if (!plan) return null;
  if (fps !== 30) throw new Error('Focusstock carried B-roll requires a 30fps composition');
  return (
    <>
      {plan.cards.filter((card) => card.disposition === 'rendered').map((card) => (
        <Sequence
          key={card.id}
          from={card.mainStartFrame}
          durationInFrames={card.mainDurationInFrames}
        >
          <FocusstockGraphicBroll
            inputName={card.inputName}
            durationInFrames={card.mainDurationInFrames}
          />
        </Sequence>
      ))}
    </>
  );
};
