'use strict';

const imagePattern = /\(image(\d+)(?::([a-z0-9,=]+))?\)([\s\S]*?)\(image\1\)/gi;
const n4 = (value) => Number(Number(value).toFixed(4));

function findImageMarkerBlocks(bodyAfterVoice) {
  const pattern = new RegExp(imagePattern.source, imagePattern.flags);
  const blocks = [];
  const markerIndexes = new Set();
  for (const match of String(bodyAfterVoice || '').matchAll(pattern)) {
    const opening = /^\(image\d+(?::[a-z0-9,=]+)?\)/i.exec(match[0]);
    if (!opening) throw new Error(`image marker 開頭無法解析：${match[0].slice(0, 40)}`);
    const markerIndex = Number(match[1]);
    if (!Number.isSafeInteger(markerIndex) || markerIndex < 1)
      throw new Error(`image marker index 不合法：${match[1]}`);
    if (markerIndexes.has(markerIndex)) throw new Error(`image marker index 重複：${markerIndex}`);
    markerIndexes.add(markerIndex);
    const contentStartOrigIdx = match.index + opening[0].length;
    const contentEndOrigIdx = contentStartOrigIdx + match[3].length;
    blocks.push({
      markerIndex,
      options: match[2] || null,
      text: match[3],
      markerStartOrigIdx: match.index,
      contentStartOrigIdx,
      contentEndOrigIdx,
      markerEndOrigIdx: match.index + match[0].length,
    });
  }
  return blocks;
}

function alignMarkerBlocksToTimes({
  blocks,
  cleanedChars,
  charTimes,
  durationSec,
  audioSrc,
  previousSegments = [],
}) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('腳本沒有 image marker blocks');
  if (!Array.isArray(cleanedChars) || !Array.isArray(charTimes)
      || cleanedChars.length !== charTimes.length)
    throw new Error('cleaned chars 與 char-times 長度不一致');
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('durationSec 不合法');
  if (!audioSrc || typeof audioSrc !== 'string') throw new Error('audioSrc 不合法');
  for (let index = 0; index < cleanedChars.length; index += 1) {
    const timed = charTimes[index];
    if (Number(timed.i) !== index || timed.ch !== cleanedChars[index].char
        || !Number.isFinite(Number(timed.start)) || !Number.isFinite(Number(timed.end)))
      throw new Error(`char-times 與標記腳本在 clean index ${index} 不一致`);
  }

  const previousById = new Map(previousSegments.map((segment) => [String(segment.id), segment]));
  let previousEnd = -1;
  const rows = blocks.map((block) => {
    let cleanStart = -1;
    let cleanEnd = -1;
    for (let index = 0; index < cleanedChars.length; index += 1) {
      const origIdx = cleanedChars[index].origIdx;
      if (origIdx < block.contentStartOrigIdx || origIdx >= block.contentEndOrigIdx) continue;
      if (cleanStart < 0) cleanStart = index;
      cleanEnd = index;
    }
    if (cleanStart < 0) throw new Error(`image${block.markerIndex} 內容沒有 clean chars`);
    if (cleanStart <= previousEnd) throw new Error(`image${block.markerIndex} 與前一段重疊或順序錯誤`);
    previousEnd = cleanEnd;
    const id = String(block.markerIndex).padStart(2, '0');
    const previous = previousById.get(id) || {};
    return {
      id,
      markerIndex: block.markerIndex,
      cleanStart,
      cleanEnd,
      startSec: n4(charTimes[cleanStart].start),
      text: cleanedChars.slice(cleanStart, cleanEnd + 1).map((item) => item.char).join(''),
      previousDurationSec: Number(previous.durationSec),
      ...(previous.anchor != null ? { anchor: previous.anchor } : {}),
      ...(previous.responsibility != null ? { responsibility: previous.responsibility } : {}),
    };
  });

  return rows.map((row, index) => {
    const endSec = index + 1 < rows.length ? rows[index + 1].startSec : n4(duration);
    if (!(endSec > row.startSec)) throw new Error(`segment ${row.id} 時間不是正長度`);
    const measuredDuration = n4(endSec - row.startSec);
    const durationSec = Number.isFinite(row.previousDurationSec)
        && Math.abs(row.previousDurationSec - measuredDuration) <= 0.01
      ? row.previousDurationSec
      : measuredDuration;
    return {
      id: row.id,
      markerIndex: row.markerIndex,
      startSec: row.startSec,
      endSec,
      durationSec,
      charRange: [row.cleanStart, row.cleanEnd],
      text: row.text,
      audio: { src: audioSrc, start: row.startSec, end: endSec },
      ...(row.anchor != null ? { anchor: row.anchor } : {}),
      ...(row.responsibility != null ? { responsibility: row.responsibility } : {}),
    };
  });
}

function mergeSegmentAudioClips(segments, {
  durationSec = null,
  toleranceSec = 0.02,
  extendSingleClipToDuration = false,
} = {}) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('segments 不可為空');
  const clips = [];
  for (const segment of segments) {
    const timelineStart = Number(segment.startSec);
    const timelineEnd = Number(segment.endSec);
    const audio = segment.audio;
    if (!audio || typeof audio.src !== 'string') throw new Error(`segment ${segment.id} 缺 audio`);
    const mediaStart = Number(audio.start);
    const mediaEnd = Number(audio.end);
    if (![timelineStart, timelineEnd, mediaStart, mediaEnd].every(Number.isFinite)
        || timelineEnd <= timelineStart || mediaEnd <= mediaStart
        || Math.abs((timelineEnd - timelineStart) - (mediaEnd - mediaStart)) >= toleranceSec)
      throw new Error(`segment ${segment.id} audio range 不合法`);
    const previous = clips.at(-1);
    if (previous && previous.src === audio.src
        && Math.abs(previous.timelineEnd - timelineStart) < toleranceSec
        && Math.abs(previous.mediaEnd - mediaStart) < toleranceSec) {
      previous.timelineEnd = timelineEnd;
      previous.mediaEnd = mediaEnd;
      previous.segmentIds.push(String(segment.id));
    } else {
      clips.push({
        src: audio.src,
        timelineStart,
        timelineEnd,
        mediaStart,
        mediaEnd,
        segmentIds: [String(segment.id)],
      });
    }
  }

  if (extendSingleClipToDuration && clips.length === 1) {
    const clip = clips[0];
    const duration = Number(durationSec);
    if (Number.isFinite(duration) && duration > 0
        && clip.timelineStart > 0
        && Math.abs(clip.timelineStart - clip.mediaStart) < toleranceSec
        && Math.abs(clip.timelineEnd - duration) < toleranceSec
        && Math.abs(clip.mediaEnd - duration) < toleranceSec) {
      clip.timelineStart = 0;
      clip.mediaStart = 0;
      clip.extendedToDuration = true;
    }
  }

  return clips.map((clip) => ({
    ...clip,
    timelineStart: n4(clip.timelineStart),
    timelineEnd: n4(clip.timelineEnd),
    mediaStart: n4(clip.mediaStart),
    mediaEnd: n4(clip.mediaEnd),
  }));
}

module.exports = {
  imagePattern,
  findImageMarkerBlocks,
  alignMarkerBlocksToTimes,
  mergeSegmentAudioClips,
};
