'use strict';

/**
 * Image-marker contract (shared by parse-script and segment-ledger):
 *
 *   (imageN[:opt[,opt|key=value]...])content(imageN)
 *
 * N is a non-negative integer; option names may contain `-`, commas may carry surrounding spaces,
 * and `visual=none` declares an audio-only segment. Marker tokens are removed by the same cleaner
 * that supplies clean chars. Punctuation, newlines, ASCII whitespace and full-width spaces never
 * own clean indexes; the pause between two owned clean chars belongs to the preceding segment
 * because its end is the next segment's first ASR start. A block containing only removed boundary
 * characters is invalid. Every remaining clean char must be owned by exactly one marker block.
 */
const imagePattern = /\(image(\d+)(?::([^)]*))?\)([\s\S]*?)\(image\1\)/gi;
const n4 = (value) => Number(Number(value).toFixed(4));

function parseImageOptions(raw, markerIndex = '?') {
  const options = {};
  if (raw == null || String(raw).trim() === '') return options;
  for (const item of String(raw).split(',')) {
    const token = item.trim();
    if (!token) throw new Error(`image${markerIndex} marker option 有空項目`);
    const match = /^([a-z][a-z0-9-]*)(?:\s*=\s*([a-z0-9._-]+))?$/i.exec(token);
    if (!match) throw new Error(`image${markerIndex} marker option 不合法：${token}`);
    const key = match[1].toLowerCase();
    if (Object.hasOwn(options, key)) throw new Error(`image${markerIndex} marker option 重複：${key}`);
    options[key] = match[2] == null ? true : match[2];
  }
  if (options.visual != null && options.visual !== 'none' && options.visual !== 'broll')
    throw new Error(`image${markerIndex} visual 只能是 none 或 broll`);
  return options;
}

function findImageMarkerBlocks(bodyAfterVoice) {
  const pattern = new RegExp(imagePattern.source, imagePattern.flags);
  const blocks = [];
  const markerIndexes = new Set();
  for (const match of String(bodyAfterVoice || '').matchAll(pattern)) {
    const opening = /^\(image\d+(?::[^)]*)?\)/i.exec(match[0]);
    if (!opening) throw new Error(`image marker 開頭無法解析：${match[0].slice(0, 40)}`);
    const markerIndex = Number(match[1]);
    if (!Number.isSafeInteger(markerIndex) || markerIndex < 0)
      throw new Error(`image marker index 不合法：${match[1]}`);
    if (markerIndexes.has(markerIndex)) throw new Error(`image marker index 重複：${markerIndex}`);
    markerIndexes.add(markerIndex);
    const parsedOptions = parseImageOptions(match[2], markerIndex);
    const contentStartOrigIdx = match.index + opening[0].length;
    const contentEndOrigIdx = contentStartOrigIdx + match[3].length;
    blocks.push({
      markerIndex,
      options: match[2] || null,
      parsedOptions,
      text: match[3],
      markerStartOrigIdx: match.index,
      contentStartOrigIdx,
      contentEndOrigIdx,
      markerEndOrigIdx: match.index + match[0].length,
    });
  }
  return blocks;
}

function formatUnownedRanges(indexes, cleanedChars) {
  const ranges = [];
  let start = indexes[0];
  let end = start;
  for (const index of indexes.slice(1)) {
    if (index === end + 1) { end = index; continue; }
    ranges.push([start, end]);
    start = index;
    end = index;
  }
  ranges.push([start, end]);
  return ranges.map(([from, to]) => {
    const source = cleanedChars.slice(from, to + 1).map((item) => item.char).join('');
    return `clean index ${from}${to === from ? '' : `–${to}`}：「${source}」`;
  }).join('；');
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

  const ownership = Array(cleanedChars.length).fill(null);
  const previousById = new Map(previousSegments.map((segment) => [String(segment.id), segment]));
  const rows = blocks.map((block) => {
    const owned = [];
    for (let index = 0; index < cleanedChars.length; index += 1) {
      const origIdx = cleanedChars[index].origIdx;
      if (origIdx < block.contentStartOrigIdx || origIdx >= block.contentEndOrigIdx) continue;
      if (ownership[index] != null)
        throw new Error(`clean index ${index} 同時屬於 image${ownership[index]} 與 image${block.markerIndex}`);
      ownership[index] = block.markerIndex;
      owned.push(index);
    }
    if (!owned.length) throw new Error(`image${block.markerIndex} 內容沒有 clean chars`);
    const cleanStart = owned[0];
    const cleanEnd = owned.at(-1);
    if (owned.length !== cleanEnd - cleanStart + 1)
      throw new Error(`image${block.markerIndex} 的 clean chars 不是連續範圍`);
    const id = String(block.markerIndex).padStart(2, '0');
    const previous = previousById.get(id) || {};
    return {
      id,
      markerIndex: block.markerIndex,
      cleanStart,
      cleanEnd,
      startSec: block.parsedOptions.visual === 'none' && cleanStart === 0
        ? 0
        : n4(charTimes[cleanStart].start),
      text: cleanedChars.slice(cleanStart, cleanEnd + 1).map((item) => item.char).join(''),
      visual: { mode: block.parsedOptions.visual || 'broll' },
      ...(previous.anchor != null ? { anchor: previous.anchor } : {}),
      ...(previous.responsibility != null ? { responsibility: previous.responsibility } : {}),
    };
  });

  const unowned = ownership.flatMap((owner, index) => owner == null ? [index] : []);
  if (unowned.length)
    throw new Error(`存在未被 image marker 覆蓋的文字：${formatUnownedRanges(unowned, cleanedChars)}`);
  rows.sort((a, b) => a.cleanStart - b.cleanStart);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].cleanStart !== rows[index - 1].cleanEnd + 1)
      throw new Error(`segment ${rows[index - 1].id}/${rows[index].id} clean coverage 不連續`);
  }

  return rows.map((row, index) => {
    const endSec = index + 1 < rows.length ? rows[index + 1].startSec : n4(duration);
    if (!(endSec > row.startSec)) throw new Error(`segment ${row.id} 時間不是正長度`);
    return {
      id: row.id,
      markerIndex: row.markerIndex,
      startSec: row.startSec,
      endSec,
      durationSec: n4(endSec - row.startSec),
      charRange: [row.cleanStart, row.cleanEnd],
      text: row.text,
      audio: { src: audioSrc, start: row.startSec, end: endSec },
      visual: row.visual,
      ...(row.anchor != null ? { anchor: row.anchor } : {}),
      ...(row.responsibility != null ? { responsibility: row.responsibility } : {}),
    };
  });
}

function mergeSegmentAudioClips(segments, { toleranceSec = 0.02 } = {}) {
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
  parseImageOptions,
  findImageMarkerBlocks,
  alignMarkerBlocksToTimes,
  mergeSegmentAudioClips,
};
