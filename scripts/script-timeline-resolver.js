'use strict';

const {
  applyVoiceRulesForward,
  cleanBodyWithIndex,
  getBodyAfterVoice,
  parseVoiceRules,
} = require('./script-utils');

class ScriptTimelineResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScriptTimelineResolverError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScriptTimelineResolverError(code, message);
}

function cleanedScript(scriptRaw) {
  if (typeof scriptRaw !== 'string' || !scriptRaw.trim())
    fail('script_unavailable', 'placement anchor requires the current script');
  return cleanBodyWithIndex(getBodyAfterVoice(scriptRaw)).map(({ char }) => char).join('');
}

function resolveUniquePhraseAnchor({ scriptRaw, phrase }) {
  if (typeof phrase !== 'string' || !phrase.trim())
    fail('placement_anchor_invalid', 'placement anchor phrase is invalid');
  const body = cleanedScript(scriptRaw);
  const voicedPhrase = applyVoiceRulesForward(phrase, parseVoiceRules(scriptRaw));
  const needle = cleanBodyWithIndex(voicedPhrase).map(({ char }) => char).join('');
  if (!needle)
    fail('placement_anchor_invalid', 'placement anchor phrase is empty after script cleaning');
  const matches = [];
  for (let index = body.indexOf(needle); index >= 0; index = body.indexOf(needle, index + 1)) {
    matches.push(index);
    if (matches.length > 1) break;
  }
  if (matches.length !== 1) {
    fail(matches.length ? 'placement_anchor_ambiguous' : 'placement_anchor_not_found',
      matches.length ? 'placement anchor phrase is ambiguous in the cleaned script'
        : 'placement anchor phrase was not found in the cleaned script');
  }
  return { phrase, startCharIdx: matches[0], cleanedCharCount: body.length };
}

function roundedStart(startSec, fps) {
  const startFrame = Math.round(startSec * fps);
  return {
    fps,
    requestedStartSec: startSec,
    startFrame,
    startSec: Number((startFrame / fps).toFixed(6)),
  };
}

function resolvePlacementStart({ placement, scriptRaw = null, subtitles = null, fps = 30 }) {
  if (!placement || typeof placement !== 'object' || Array.isArray(placement))
    fail('placement_invalid', 'placement is invalid');
  if (!Number.isInteger(fps) || fps <= 0 || fps > 240)
    fail('placement_invalid', 'placement fps is invalid');
  const hasStart = placement.startSec != null;
  const hasAnchor = placement.anchor != null;
  if (hasStart === hasAnchor)
    fail('placement_invalid', 'placement requires exactly one startSec or anchor');
  if (hasStart) {
    const startSec = Number(placement.startSec);
    if (!Number.isFinite(startSec) || startSec < 0)
      fail('placement_invalid', 'placement startSec is invalid');
    return roundedStart(startSec, fps);
  }

  const anchor = placement.anchor;
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor))
    fail('placement_anchor_invalid', 'placement anchor is invalid');
  const persistedIndex = Number(anchor.startCharIdx);
  const hasPersistedIndex = Number.isInteger(persistedIndex) && persistedIndex >= 0;
  let startCharIdx = persistedIndex;
  let cleanedCharCount = null;
  if (anchor.phrase != null) {
    const resolved = resolveUniquePhraseAnchor({ scriptRaw, phrase: anchor.phrase });
    startCharIdx = resolved.startCharIdx;
    cleanedCharCount = resolved.cleanedCharCount;
    if (anchor.startCharIdx != null && (!hasPersistedIndex || persistedIndex !== startCharIdx))
      fail('placement_anchor_mismatch',
        'persisted placement anchor does not match the phrase start in the cleaned script');
  } else {
    if (!hasPersistedIndex)
      fail('placement_anchor_invalid', 'placement anchor startCharIdx is invalid');
    if (scriptRaw != null) cleanedCharCount = cleanedScript(scriptRaw).length;
  }
  if (cleanedCharCount != null && startCharIdx >= cleanedCharCount)
    fail('placement_anchor_unresolved', 'placement anchor is outside the cleaned script');

  const charTimes = subtitles?._scriptCharTimes;
  if (!Array.isArray(charTimes))
    fail('placement_anchor_unresolved', 'subtitle character timeline is unavailable');
  if (cleanedCharCount != null && charTimes.length !== cleanedCharCount)
    fail('placement_timeline_drift',
      'subtitle character timeline length does not match the cleaned script');
  const timing = charTimes[startCharIdx];
  if (!timing || !Number.isFinite(timing.start) || !Number.isFinite(timing.end)
      || timing.start < 0 || timing.end <= timing.start)
    fail('placement_anchor_unresolved', 'placement anchor has no valid subtitle time');
  return {
    ...roundedStart(timing.start, fps),
    anchor: {
      ...(anchor.phrase != null ? { phrase: anchor.phrase } : {}),
      startCharIdx,
    },
  };
}

module.exports = {
  ScriptTimelineResolverError,
  resolvePlacementStart,
  resolveUniquePhraseAnchor,
};
