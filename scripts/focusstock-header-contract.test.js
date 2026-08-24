'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Focusstock renders a dynamic 台股晨報 label on the reviewed blank header', () => {
  const composition = read('src/Focusstock/FocusstockComposition.tsx');
  const parser = read('scripts/parse-focusstock-script.js');
  const assetSetup = read('scripts/use-focusstock-assets.js');
  const baselineMeta = JSON.parse(read('src/video-meta.json'));

  assert.match(composition, /staticFile\('focusstock-header-overlay-v2\.png'\)/);
  assert.doesNotMatch(composition, /staticFile\('focusstock-header-overlay\.png'\)/);
  assert.match(composition, /videoMeta as any\)\.headerLabel/);
  assert.match(parser, /meta\.headerLabel = '台股晨報'/);
  assert.equal(baselineMeta.headerLabel, '台股晨報');

  assert.match(assetSetup, /header-overlay-v2\.png/);
  assert.match(assetSetup,
    /86c5e28d0162cfe5b1ad23ebd4d19d33b5b39d7c0b9dd3f3da8b32a22a51633f/);
  assert.match(assetSetup, /SHA-256 不符/);
});
