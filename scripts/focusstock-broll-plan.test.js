'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { disabledPlan, parseArgs, run } = require('./focusstock-broll-plan');

test('disabled mode atomically replaces any carried workspace residue', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focusstock-broll-disabled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'focusstock-broll.generated.json');
  fs.writeFileSync(out, '{"mode":"stale"}');
  const result = run(['--mode=disabled', `--out=${out}`]);
  assert.equal(result.canonical, JSON.stringify(disabledPlan()));
  assert.equal(fs.readFileSync(out, 'utf8'), result.canonical);
});

test('carried mode is check-only and rejects non-canonical bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focusstock-broll-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'focusstock-broll.generated.json');
  fs.writeFileSync(out, `${JSON.stringify(disabledPlan(), null, 2)}\n`);
  assert.throws(() => run(['--mode=carried-v1', '--check', `--out=${out}`]),
    /plan envelope|canonical|不合法|invalid/i);
  assert.throws(() => parseArgs(['--mode=carried-v1', `--out=${out}`]), /只能驗證/);
});

test('renderer mounts B-roll 1-6 but never mounts producer-suppressed B-roll 7', () => {
  const plan = {
    schemaVersion: 2,
    mode: 'carried-v1',
    template: 'focusstock',
    timelineBasis: 'focusstock-main-v1',
    fps: 30,
    intervalSemantics: 'frame-half-open',
    sourceScriptSha256: 'a'.repeat(64),
    prepared: { planSha256: 'b'.repeat(64), startFrame: 360, endFrame: 390 },
    cards: Array.from({ length: 7 }, (_, index) => {
      const ordinal = index + 1;
      const start = ordinal * 30;
      const suppressed = ordinal === 7;
      return {
        id: `broll-${String(ordinal).padStart(2, '0')}`,
        ordinal,
        assetRef: `asset-${ordinal}`,
        assetSha256: String(ordinal).repeat(64),
        assetSize: ordinal,
        mediaType: 'video/mp4',
        inputName: `broll${ordinal}.mp4`,
        startCharIdx: index * 10,
        endCharIdx: (index * 10) + 9,
        startSec: start / 30,
        endSec: (start + 30) / 30,
        fps: 30,
        mainStartFrame: start,
        mainEndFrame: start + 30,
        mainDurationInFrames: 30,
        compositionOffsetFrames: 30,
        compositionStartFrame: start + 30,
        compositionEndFrame: start + 60,
        disposition: suppressed ? 'suppressed_by_prepared' : 'rendered',
        suppressedBy: suppressed ? 'prepared-phone-video' : null,
      };
    }),
  };
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'src', 'Focusstock', 'FocusstockBrollLayer.tsx'), 'utf8');
  assert.doesNotMatch(source, /preparedPhoneSuppressesFocusstockVisual|halfOpenFrameIntervalsOverlap/,
    'renderer must not recompute producer conflict policy');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const element = (type, props, key) => ({ type, props: props || {}, key });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(id) {
      if (id === 'react') return { __esModule: true, default: {} };
      if (id === 'react/jsx-runtime')
        return { Fragment: 'Fragment', jsx: element, jsxs: element };
      if (id === 'remotion') return {
        AbsoluteFill: 'AbsoluteFill', OffthreadVideo: 'OffthreadVideo', Sequence: 'Sequence',
        interpolate: () => 1, staticFile: (name) => name,
        useCurrentFrame: () => 0, useVideoConfig: () => ({ fps: 30 }),
      };
      if (id === './focusstock-broll.generated.json') return plan;
      throw new Error(`unexpected renderer dependency: ${id}`);
    },
  }, { filename: 'FocusstockBrollLayer.js' });
  const rendered = module.exports.FocusstockBrollLayer();
  assert.equal(rendered.type, 'Fragment');
  assert.deepEqual(Array.from(rendered.props.children, (child) => child.key),
    ['broll-01', 'broll-02', 'broll-03', 'broll-04', 'broll-05', 'broll-06']);
});
