'use strict';

function halfOpenFrameIntervalsOverlap(
  leftStartFrame,
  leftEndFrame,
  rightStartFrame,
  rightEndFrame,
) {
  if (![leftStartFrame, leftEndFrame, rightStartFrame, rightEndFrame]
    .every(Number.isInteger)
      || leftStartFrame < 0 || rightStartFrame < 0
      || leftEndFrame <= leftStartFrame || rightEndFrame <= rightStartFrame) {
    throw new Error('Focusstock half-open frame interval is invalid');
  }
  return leftStartFrame < rightEndFrame && leftEndFrame > rightStartFrame;
}

module.exports = { halfOpenFrameIntervalsOverlap };
