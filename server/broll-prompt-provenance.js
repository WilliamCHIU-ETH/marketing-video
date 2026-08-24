'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROVENANCE_DIR = /^broll-v(\d{1,6})$/i;
const MAX_PROVENANCE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;

function promptDigestMatches(text, digest) {
  if (!SHA256_HEX.test(digest)) return false;
  return [text, `${text}\n`].some((candidate) =>
    crypto.createHash('sha256').update(candidate).digest('hex') === digest);
}

function revisionIdFromDirectory(name) {
  const match = PROVENANCE_DIR.exec(name);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0
    ? `v${String(number).padStart(3, '0')}`
    : null;
}

function readProjectBrollPrompts(projectDir) {
  const prompts = new Map();
  const conflicts = new Set();
  let entries;
  try {
    const projectStat = fs.lstatSync(projectDir);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) return prompts;
    entries = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && PROVENANCE_DIR.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }));
  } catch (_) {
    return prompts;
  }

  for (const entry of entries) {
    const sourceRevisionId = revisionIdFromDirectory(entry.name);
    const provenanceFile = path.join(projectDir, entry.name, 'broll-provenance.json');
    let provenance;
    try {
      const directoryStat = fs.lstatSync(path.join(projectDir, entry.name));
      const fileStat = fs.lstatSync(provenanceFile);
      if (!sourceRevisionId || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()
          || !fileStat.isFile() || fileStat.isSymbolicLink()
          || fileStat.size < 2 || fileStat.size > MAX_PROVENANCE_BYTES) continue;
      provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
    } catch (_) {
      continue;
    }
    if (provenance?.schemaVersion !== 2 || !Array.isArray(provenance.slots)) continue;

    for (const slot of provenance.slots) {
      const outputSha256 = String(slot?.outputSha256 || '').toLowerCase();
      const promptSha256 = String(slot?.promptSha256 || '').toLowerCase();
      const promptText = typeof slot?.promptText === 'string' ? slot.promptText : '';
      if (!SHA256_HEX.test(outputSha256) || !promptText.trim()
          || Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES
          || !promptDigestMatches(promptText, promptSha256)) continue;

      const previous = prompts.get(outputSha256);
      if (previous && (previous.sha256 !== promptSha256 || previous.text !== promptText)) {
        conflicts.add(outputSha256);
        prompts.delete(outputSha256);
        continue;
      }
      if (conflicts.has(outputSha256)) continue;
      if (previous && previous.sourceRevisionId !== sourceRevisionId) {
        prompts.set(outputSha256, { ...previous, sourceRevisionId: null });
        continue;
      }
      prompts.set(outputSha256, {
        status: 'recorded',
        text: promptText,
        sha256: promptSha256,
        sourceRevisionId,
      });
    }
  }
  return prompts;
}

function attachRecordedBrollPrompts({ projectDir, graphicBroll }) {
  if (!graphicBroll || !Array.isArray(graphicBroll.cards)) return graphicBroll;
  const prompts = readProjectBrollPrompts(projectDir);
  return {
    ...graphicBroll,
    cards: graphicBroll.cards.map((card) => {
      const assetSha256 = String(card?.assetSha256 || '').toLowerCase();
      return {
        ...card,
        prompt: prompts.get(assetSha256) || { status: 'missing' },
      };
    }),
  };
}

module.exports = {
  attachRecordedBrollPrompts,
  promptDigestMatches,
  readProjectBrollPrompts,
};
