import React from 'react';
import { Composition } from 'remotion';
import './fonts'; // side-effect：載入 public/ 內的字體檔
import { MarketingVideo } from './MarketingVideo';
import {
  VIDEO_DURATION_SEC,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  secToFrame,
} from './timeline';
import { DapanComposition } from './DapanXiaobao/DapanComposition';
import { DapanLandscapeComposition } from './DapanXiaobao/DapanLandscapeComposition';
import {
  DAPAN_TOTAL_DURATION_SEC,
  DAPAN_LANDSCAPE_DURATION_SEC,
} from './DapanXiaobao/dapan-timeline';
import { InstitutionComposition } from './Institution/InstitutionComposition';
import { INSTITUTION_TOTAL_DURATION_SEC } from './Institution/institution-timeline';
import { FocusstockComposition } from './Focusstock/FocusstockComposition';
import { FOCUSSTOCK_TOTAL_DURATION_SEC } from './Focusstock/focusstock-timeline';
import { FocusstockAdComposition } from './Focusstock/FocusstockAdComposition';

/**
 * Remotion Root：在此註冊所有 Composition
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MarketingVideo"
        component={MarketingVideo}
        durationInFrames={secToFrame(VIDEO_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 大盤小報：獨立 composition，跟 MarketingVideo 互不影響（詳見 docs/tasks.md 第 3 節） */}
      <Composition
        id="DapanXiaobao"
        component={DapanComposition}
        durationInFrames={secToFrame(DAPAN_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 大盤小報「橫式版型」：16:9（1920×1080），與直式共用 heygen/字幕/腳本、版面不同
          （無開場卡、講者左移、日期＋標題常駐右側面板）。詳見 docs/tasks.md 第 3 節。 */}
      <Composition
        id="DapanXiaobaoLandscape"
        component={DapanLandscapeComposition}
        durationInFrames={secToFrame(DAPAN_LANDSCAPE_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={1920}
        height={1080}
      />
      {/* 三大法人：獨立直式 composition（金橘版型、固定主播），跟大盤小報同模子但互不影響。 */}
      <Composition
        id="Institution"
        component={InstitutionComposition}
        durationInFrames={secToFrame(INSTITUTION_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 焦點股日報：獨立直式 composition（藍色版型、固定主播），同模子互不影響。 */}
      <Composition
        id="Focusstock"
        component={FocusstockComposition}
        durationInFrames={secToFrame(FOCUSSTOCK_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 焦點股日報「投廣套框版」：與客製版共用同一支 heygen/字幕，改套籌碼K線外框＋接片尾，
          無開頭。時長 = heygen + outro（= VIDEO_DURATION_SEC）。 */}
      <Composition
        id="FocusstockAd"
        component={FocusstockAdComposition}
        durationInFrames={secToFrame(VIDEO_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
    </>
  );
};
