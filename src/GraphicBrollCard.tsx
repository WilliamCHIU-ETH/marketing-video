import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';

export type GraphicBrollCardItem = {
  id: string;
  style: 'morning-report-v1';
  headline: string;
  body: string;
  startSec: number;
  endSec: number;
};

/**
 * M02A 的唯一 composition-native graphic B-roll 樣式。
 * 內容只接受 deterministic plan 已從 cleaned script 擷取的 headline/body。
 */
export const GraphicBrollCard: React.FC<{ item: GraphicBrollCardItem }> = ({ item }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(155deg, #07152f 0%, #0b2b62 54%, #0f5a91 100%)',
        color: '#f8fbff',
        fontFamily: '"Noto Sans TC", "PingFang TC", sans-serif',
        opacity: interpolate(frame, [0, 10], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 620,
          height: 620,
          borderRadius: '50%',
          top: -260,
          right: -210,
          backgroundColor: 'rgba(83, 190, 255, 0.16)',
          scale: interpolate(frame, [0, 24], [0.82, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 460,
          height: 460,
          borderRadius: '50%',
          left: -270,
          bottom: 180,
          border: '2px solid rgba(156, 220, 255, 0.18)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 82,
          right: 82,
          top: 350,
          minHeight: 730,
          padding: '82px 74px 88px',
          borderRadius: 44,
          backgroundColor: 'rgba(255, 255, 255, 0.96)',
          boxShadow: '0 36px 100px rgba(0, 8, 28, 0.36)',
          overflow: 'hidden',
          translate: interpolate(frame, [0, 18], ['0px 54px', '0px 0px'], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          scale: interpolate(frame, [0, 18], [0.96, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div
          style={{
            width: interpolate(frame, [4, 22], [0, 126], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            height: 12,
            borderRadius: 99,
            backgroundColor: '#18a7e0',
            marginBottom: 46,
          }}
        />
        <div
          style={{
            color: '#082552',
            fontSize: item.body ? 76 : 88,
            fontWeight: 800,
            lineHeight: 1.3,
            letterSpacing: 1,
            overflowWrap: 'anywhere',
          }}
        >
          {item.headline}
        </div>
        {item.body ? (
          <div
            style={{
              color: '#24476f',
              fontSize: 48,
              fontWeight: 600,
              lineHeight: 1.58,
              letterSpacing: 0.5,
              marginTop: 42,
              overflowWrap: 'anywhere',
            }}
          >
            {item.body}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
