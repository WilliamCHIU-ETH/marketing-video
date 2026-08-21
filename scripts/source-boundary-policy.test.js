#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  MAX_DOC_IMAGE_BYTES,
  MAX_SANITIZED_FIXTURE_BYTES,
  scanRepository,
} = require('./source-boundary.test');

const BASE_IGNORE = `
/assets
/.cache/
/.data/
/.dual-tmp/
/.local/
/.remotion/
/.verify-dual-tmp/
/_frames_check/
/audio/
/backups/
/build/
/captures/
/coverage/
/exports/
/internal-snapshots/
/jobs/
/keychain-data/
/out/
/persona-values/
/provider-cache/
/public/jobs/
/recordings/
/runtime-data/
/screenshots/
/sessions/
/test-results/
/videos/
/成品/
`;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function git(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: options.environment || process.env,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.error || '')}`);
  }
  return result.stdout;
}

function writeEntry(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function makeRepository(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-source-boundary-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, ['init', '--quiet']);
  writeEntry(root, '.gitignore', BASE_IGNORE);
  writeEntry(root, 'src/index.js', "'use strict';\nmodule.exports = true;\n");
  for (const [relative, value] of Object.entries(files)) writeEntry(root, relative, value);
  git(root, ['add', '--force', '--', '.']);
  return root;
}

function rulesFor(result, relative) {
  return result.findings
    .filter((finding) => finding.file === relative)
    .map((finding) => `${finding.rule}:${finding.origin}`);
}

function assertFinding(result, relative, rule, origin) {
  assert.ok(
    result.findings.some((finding) => finding.file === relative
      && finding.rule === rule
      && (origin === undefined || finding.origin === origin)),
    `expected ${rule}${origin ? `:${origin}` : ''} for ${relative}; got ${JSON.stringify(rulesFor(result, relative))}`,
  );
}

test('canonical clean source allows capped docs images and sanitized text fixtures', (t) => {
  const root = makeRepository(t, {
    'docs/images/architecture.png': PNG_1X1,
    'docs/images/architecture.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n',
    'fixtures/sanitized/project.json': '{"project":"fixture-project","revision":"V1"}\n',
  });
  const result = scanRepository({ root });
  assert.deepEqual(result.findings, []);
  assert.equal(result.trackedCount, 5);
});

test('ambient Git variables cannot redirect the canonical index or object store', (t) => {
  const machinePath = ['', 'Users', 'alice', 'private-project'].join('/');
  const target = makeRepository(t, {
    'src/index.js': `module.exports = ${JSON.stringify(machinePath)};\n`,
  });
  const decoy = makeRepository(t, {
    'src/index.js': "module.exports = 'safe';\n",
  });
  const environment = {
    ...process.env,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git', 'objects'),
    GIT_COMMON_DIR: path.join(decoy, '.git'),
    GIT_DIR: path.join(decoy, '.git'),
    GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(decoy, '.git', 'objects'),
    GIT_REPLACE_REF_BASE: 'refs/replace-decoy/',
    GIT_WORK_TREE: decoy,
  };
  const result = scanRepository({ environment, root: target });
  assertFinding(result, 'src/index.js', 'machine-path', 'index');
  assertFinding(result, 'src/index.js', 'machine-path', 'worktree');
});

test('an empty canonical index fails closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-source-boundary-empty-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, ['init', '--quiet']);
  git(root, ['read-tree', '--empty']);
  const result = scanRepository({ root });
  assert.equal(result.trackedCount, 0);
  assertFinding(result, '.git', 'git-inventory-unavailable', 'git');
});

test('index and worktree mismatches cannot hide sensitive bytes in either side', async (t) => {
  const machinePath = ['', 'Users', 'alice', 'private-project'].join('/');
  await t.test('sensitive index with safe worktree', (subtest) => {
    const root = makeRepository(subtest, {
      'src/index.js': `module.exports = ${JSON.stringify(machinePath)};\n`,
    });
    writeEntry(root, 'src/index.js', "module.exports = 'safe-worktree';\n");
    const result = scanRepository({ root });
    assertFinding(result, 'src/index.js', 'machine-path', 'index');
    assertFinding(result, 'src/index.js', 'index-worktree-mismatch', 'worktree');
  });

  await t.test('safe index with sensitive worktree', (subtest) => {
    const root = makeRepository(subtest, {
      'src/index.js': "module.exports = 'safe-index';\n",
    });
    writeEntry(root, 'src/index.js', `module.exports = ${JSON.stringify(machinePath)};\n`);
    const result = scanRepository({ root });
    assertFinding(result, 'src/index.js', 'machine-path', 'worktree');
    assertFinding(result, 'src/index.js', 'index-worktree-mismatch', 'worktree');
  });
});

test('replace refs and dishonest blob bytes cannot replace the indexed object', async (t) => {
  const machinePath = ['', 'Users', 'alice', 'private-project'].join('/');
  const root = makeRepository(t, {
    'src/index.js': `module.exports = ${JSON.stringify(machinePath)};\n`,
    'src/safe.js': "module.exports = 'safe';\n",
  });
  const sensitiveOid = String(git(root, ['rev-parse', ':src/index.js'])).trim();
  const safeOid = String(git(root, ['rev-parse', ':src/safe.js'])).trim();
  git(root, ['replace', sensitiveOid, safeOid]);
  const replaceResult = scanRepository({ root });
  assertFinding(replaceResult, 'src/index.js', 'machine-path', 'index');

  const dishonestRunner = (command, args, options) => {
    if (args.includes('cat-file') && args.at(-1) === sensitiveOid) {
      return { status: 0, stdout: Buffer.from("module.exports = 'safe';\n") };
    }
    return spawnSync(command, args, options);
  };
  const oidResult = scanRepository({ gitRunner: dishonestRunner, root });
  assertFinding(oidResult, 'src/index.js', 'index-blob-oid-mismatch', 'index');
});

test('tracked media, delivery documents and spreadsheets fail closed outside explicit boundaries', (t) => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  const root = makeRepository(t, {
    'audio/voice.mp3': bytes,
    'docs/images/screenshot.png': PNG_1X1,
    'image.png': bytes,
    'out/final.mp4': bytes,
    'recordings/take.mov': bytes,
    'report.pdf': bytes,
    'sheet.xlsx': bytes,
    'video.webm': bytes,
  });
  const result = scanRepository({ root });
  assertFinding(result, 'audio/voice.mp3', 'tracked-audio-artifact');
  assertFinding(result, 'docs/images/screenshot.png', 'runtime-named-doc-image');
  assertFinding(result, 'image.png', 'tracked-image-artifact');
  assertFinding(result, 'out/final.mp4', 'tracked-video-artifact');
  assertFinding(result, 'recordings/take.mov', 'tracked-video-artifact');
  assertFinding(result, 'report.pdf', 'tracked-document-artifact');
  assertFinding(result, 'sheet.xlsx', 'tracked-sheet-artifact');
  assertFinding(result, 'video.webm', 'tracked-video-artifact');
});

test('docs images require valid signatures and a small size cap', async (t) => {
  await t.test('invalid image signature', (subtest) => {
    const root = makeRepository(subtest, {
      'docs/images/architecture.png': 'not a png\n',
    });
    const result = scanRepository({ root });
    assertFinding(result, 'docs/images/architecture.png', 'doc-image-signature', 'index');
  });

  await t.test('oversized documentation image', (subtest) => {
    const oversized = Buffer.concat([
      PNG_1X1.subarray(0, 8),
      Buffer.alloc(MAX_DOC_IMAGE_BYTES + 1),
    ]);
    const root = makeRepository(subtest, {
      'docs/images/architecture.png': oversized,
    });
    const result = scanRepository({ root });
    assertFinding(result, 'docs/images/architecture.png', 'doc-image-too-large', 'index');
  });
});

test('sanitized fixtures require the explicit location, text type and size cap', async (t) => {
  await t.test('raw fixture location', (subtest) => {
    const root = makeRepository(subtest, {
      'fixtures/raw/project.json': '{"project":"internal"}\n',
    });
    const result = scanRepository({ root });
    assertFinding(result, 'fixtures/raw/project.json', 'unsanitized-fixture-location');
  });

  await t.test('binary fixture type', (subtest) => {
    const root = makeRepository(subtest, {
      'fixtures/sanitized/frame.png': PNG_1X1,
    });
    const result = scanRepository({ root });
    assertFinding(result, 'fixtures/sanitized/frame.png', 'sanitized-fixture-type');
    assertFinding(result, 'fixtures/sanitized/frame.png', 'tracked-image-artifact');
  });

  await t.test('oversized fixture', (subtest) => {
    const root = makeRepository(subtest, {
      'fixtures/sanitized/project.json': Buffer.alloc(MAX_SANITIZED_FIXTURE_BYTES + 1, 0x20),
    });
    const result = scanRepository({ root });
    assertFinding(result, 'fixtures/sanitized/project.json', 'sanitized-fixture-too-large', 'index');
  });
});

test('tracked symlinks and hidden index entries fail closed', async (t) => {
  await t.test('tracked symlink', (subtest) => {
    const root = makeRepository(subtest);
    fs.symlinkSync('src/index.js', path.join(root, 'linked.js'));
    git(root, ['add', '--force', '--', 'linked.js']);
    const result = scanRepository({ root });
    assertFinding(result, 'linked.js', 'unsupported-index-mode', 'index');
  });

  await t.test('assume-unchanged index flag', (subtest) => {
    const root = makeRepository(subtest);
    git(root, ['update-index', '--assume-unchanged', '--', 'src/index.js']);
    const result = scanRepository({ root });
    assertFinding(result, 'src/index.js', 'hidden-or-sparse-index-entry', 'index');
  });

  await t.test('tracked file below a replaced symlink directory', (subtest) => {
    const root = makeRepository(subtest, {
      'nested/source.js': "module.exports = 'indexed';\n",
    });
    const original = path.join(root, 'nested-original');
    fs.renameSync(path.join(root, 'nested'), original);
    fs.symlinkSync(original, path.join(root, 'nested'), 'dir');
    const result = scanRepository({ root });
    assertFinding(result, 'nested/source.js', 'worktree-entry-unavailable', 'worktree');
  });
});
