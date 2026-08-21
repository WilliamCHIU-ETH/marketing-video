#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_DOC_IMAGE_BYTES = 512 * 1024;
const MAX_SANITIZED_FIXTURE_BYTES = 64 * 1024;
const MAX_GIT_CONTROL_BYTES = 16 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const FORBIDDEN_TRACKED_ROOTS = [
  '.cache/',
  '.data/',
  '.dual-tmp/',
  '.local/',
  '.remotion/',
  '.verify-dual-tmp/',
  '_frames_check/',
  'assets/',
  'audio/',
  'backups/',
  'build/',
  'captures/',
  'coverage/',
  'exports/',
  'internal-snapshots/',
  'jobs/',
  'keychain-data/',
  'out/',
  'persona-values/',
  'provider-cache/',
  'public/jobs/',
  'recordings/',
  'runtime-data/',
  'screenshots/',
  'sessions/',
  'test-results/',
  'videos/',
  '成品/',
];

const FORBIDDEN_TRACKED_FILES = new Set([
  '.run.lock',
  '.run.owner.json',
  'assets',
  'public/annotations.json',
  'public/heygen.mp4',
  'public/heygen_fast.mp4',
  'public/minimax.mp3',
  'public/outro.mp4',
  'public/script.txt',
]);

const FORBIDDEN_TRACKED_FILE_PATTERNS = [
  /^public\/(?:shot|image).*\.(?:png|jpe?g)$/i,
  /^public\/.*-bgm\.(?:wav|mp3)$/i,
  /^public\/.*-header-overlay\.png$/i,
  /^public\/.*-intro-frame(?:-horizontal)?\.(?:png|jpe?g)$/i,
];

const DOC_IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
const IMAGE_EXTENSIONS = new Set([
  ...DOC_IMAGE_EXTENSIONS,
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.tif',
  '.tiff',
]);
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);
const SHEET_EXTENSIONS = new Set(['.csv', '.numbers', '.ods', '.tsv', '.xls', '.xlsm', '.xlsx']);
const SANITIZED_FIXTURE_EXTENSIONS = new Set([
  '.csv',
  '.json',
  '.jsonl',
  '.md',
  '.txt',
  '.tsv',
  '.yaml',
  '.yml',
]);
const ALLOWED_INDEX_MODES = new Set(['100644', '100755']);
const ARTIFACT_BASENAME_PATTERN = /(?:^|[-_.])(?:capture|final|output|recording|rendered?|screen[-_]?shot)(?:$|[-_.])/i;

const IGNORED_SENTINELS = [
  '.local/captures/frame.png',
  '.cache/provider/cache.json',
  'assets/logo.png',
  'audio/voice.wav',
  'captures/screen.png',
  'coverage/lcov.info',
  'exports/delivery.pdf',
  'internal-snapshots/page.json',
  'jobs/run-1/job.json',
  'keychain-data/export.json',
  'out/final.mp4',
  'persona-values/local.json',
  'provider-cache/response.json',
  'recordings/run.mp4',
  'runtime-data/projects/project-1/project.json',
  'runtime-data/jobs/run-1/job.json',
  'screenshots/page.png',
  'sessions/session.json',
  'test-results/result.json',
  'videos/final.mp4',
];

const VISIBLE_SOURCE_SENTINELS = [
  '.agents/skills/example/SKILL.md',
  'docs/adr.md',
  'docs/images/source.png',
  'fixtures/sanitized/example.json',
  'scripts/example.js',
  'scripts/example.test.js',
  'server/public/example.html',
  'src/example.generated.json',
];

const PLACEHOLDER_USERNAMES = new Set([
  'example',
  'name',
  'user',
  'username',
  'xxx',
  'you',
]);

function fatalUtf8(buffer, label) {
  try {
    return UTF8_DECODER.decode(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function regularControlFile(target, label, maxBytes = MAX_GIT_CONTROL_BYTES) {
  let metadata;
  try {
    metadata = fs.lstatSync(target);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return metadata;
}

function controlPathValue(target, label, prefix = '') {
  regularControlFile(target, label);
  const content = fatalUtf8(fs.readFileSync(target), label);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = prefix
    ? new RegExp(`^${escapedPrefix} ([^\\r\\n]+)\\r?\\n?$`)
    : /^([^\r\n]+)\r?\n?$/;
  const match = content.match(pattern);
  if (!match) throw new Error(`${label} is invalid`);
  return match[1];
}

function canonicalDirectory(target, label) {
  let resolved;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  let metadata;
  try {
    metadata = fs.statSync(resolved);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isDirectory()) throw new Error(`${label} is invalid`);
  return resolved;
}

function canonicalGitContext(rootValue, environment = process.env) {
  const root = canonicalDirectory(path.resolve(rootValue || ROOT), 'source root');
  const dotGit = path.join(root, '.git');
  let dotGitMetadata;
  try {
    dotGitMetadata = fs.lstatSync(dotGit);
  } catch {
    throw new Error('canonical Git metadata is unavailable');
  }

  let gitDir;
  if (dotGitMetadata.isDirectory() && !dotGitMetadata.isSymbolicLink()) {
    gitDir = canonicalDirectory(dotGit, 'canonical Git directory');
  } else if (dotGitMetadata.isFile() && !dotGitMetadata.isSymbolicLink()) {
    const pointer = controlPathValue(dotGit, 'canonical Git pointer', 'gitdir:');
    gitDir = canonicalDirectory(path.resolve(path.dirname(dotGit), pointer), 'canonical Git directory');
  } else {
    throw new Error('canonical Git metadata is invalid');
  }

  const commonPointer = path.join(gitDir, 'commondir');
  let commonDir = gitDir;
  if (fs.existsSync(commonPointer)) {
    const pointer = controlPathValue(commonPointer, 'canonical Git common-dir pointer');
    commonDir = canonicalDirectory(path.resolve(gitDir, pointer), 'canonical Git common directory');
  }

  const objectDirectory = canonicalDirectory(path.join(commonDir, 'objects'), 'canonical Git object directory');
  const indexCandidate = path.join(gitDir, 'index');
  regularControlFile(indexCandidate, 'canonical Git index', Number.MAX_SAFE_INTEGER);
  const indexFile = fs.realpathSync(indexCandidate);

  const sanitizedEnvironment = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (!key.startsWith('GIT_')) sanitizedEnvironment[key] = value;
  }
  Object.assign(sanitizedEnvironment, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_COMMON_DIR: commonDir,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: indexFile,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_WORK_TREE: root,
  });

  return {
    commonDir,
    environment: sanitizedEnvironment,
    gitDir,
    indexFile,
    objectDirectory,
    root,
  };
}

function gitResult(gitRunner, context, args, options = {}) {
  let result;
  try {
    result = gitRunner('git', [
      '--no-replace-objects',
      `--git-dir=${context.gitDir}`,
      `--work-tree=${context.root}`,
      ...args,
    ], {
      cwd: context.root,
      encoding: null,
      env: context.environment,
      maxBuffer: options.maxBuffer || MAX_GIT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || result.stdout === undefined) return null;
  return result;
}

function nulRecords(output, label) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output || '');
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error(`${label} is malformed`);
  return fatalUtf8(bytes.subarray(0, -1), label).split('\0');
}

function safeTrackedPath(relative) {
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative) || /[\u0000-\u001f\u007f]/.test(relative)) {
    return false;
  }
  const components = relative.split('/');
  return components.every((component) => component && component !== '.' && component !== '..');
}

function listTrackedEntries(context, gitRunner = spawnSync) {
  const indexResult = gitResult(gitRunner, context, ['ls-files', '--stage', '-z', '--']);
  const flagsResult = gitResult(gitRunner, context, ['ls-files', '-v', '-z', '--']);
  if (!indexResult || !flagsResult) throw new Error('tracked source inventory is unavailable');

  const flags = new Map();
  for (const record of nulRecords(flagsResult.stdout, 'tracked source flags')) {
    const match = record.match(/^(.)(?: )([\s\S]+)$/);
    if (!match || !safeTrackedPath(match[2]) || flags.has(match[2])) {
      throw new Error('tracked source flags are malformed');
    }
    flags.set(match[2], match[1]);
  }

  const entries = [];
  const paths = new Set();
  for (const record of nulRecords(indexResult.stdout, 'tracked source index')) {
    const match = record.match(/^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/);
    if (!match || !safeTrackedPath(match[4]) || paths.has(match[4])) {
      throw new Error('tracked source index is malformed');
    }
    paths.add(match[4]);
    entries.push({
      flag: flags.get(match[4]) || null,
      mode: match[1],
      oid: match[2],
      path: match[4],
      stage: Number(match[3]),
    });
  }
  if (entries.length === 0) throw new Error('tracked source index is empty');
  if (flags.size !== entries.length || entries.some((entry) => entry.flag === null)) {
    throw new Error('tracked source index and flags disagree');
  }
  return entries;
}

function canonicalBlobOid(bytes, oidLength) {
  const algorithm = oidLength === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function readIndexBlob(entry, context, gitRunner) {
  const result = gitResult(gitRunner, context, ['cat-file', 'blob', entry.oid], {
    maxBuffer: MAX_SOURCE_BYTES + (64 * 1024),
  });
  if (!result) return null;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

function readWorktreeFile(root, relative) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('tracked path escapes source root');
  }
  let linkMetadata;
  try {
    linkMetadata = fs.lstatSync(target);
  } catch {
    throw new Error('tracked worktree file is missing');
  }
  if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) {
    throw new Error('tracked worktree entry is not a regular file');
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    throw new Error('tracked worktree file is unreadable');
  }
  if (realTarget !== target) {
    throw new Error('tracked worktree path crosses a symbolic link');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error('tracked worktree entry is not a regular file');
    if (before.size > MAX_SOURCE_BYTES + (64 * 1024)) throw new Error('tracked worktree file is too large');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('tracked worktree file changed during scan');
    }
    return { bytes, metadata: after };
  } catch (error) {
    throw new Error(error && error.message ? error.message : 'tracked worktree file is unreadable');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizeRelative(relative) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isDocsImage(relative) {
  const normalized = normalizeRelative(relative);
  return normalized.startsWith('docs/images/') && DOC_IMAGE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function isSanitizedFixture(relative) {
  return normalizeRelative(relative).startsWith('fixtures/sanitized/');
}

function isForbiddenCredentialPath(relative) {
  const normalized = normalizeRelative(relative);
  const basename = path.posix.basename(normalized);
  if (normalized === '.env.example') return false;
  return basename === '.env'
    || basename.startsWith('.env.')
    || /^\.google-creds.*\.json$/i.test(basename)
    || /service[-_]?account.*\.json$/i.test(basename)
    || /\.(?:key|pem|p12|pfx|mobileprovision)$/i.test(basename);
}

function pathPolicyIssues(relative) {
  const normalized = normalizeRelative(relative);
  const extension = path.posix.extname(normalized).toLowerCase();
  const basename = path.posix.basename(normalized, extension);
  const issues = [];

  if (FORBIDDEN_TRACKED_ROOTS.some((root) => normalized.startsWith(root))) {
    issues.push('runtime-path-tracked');
  }
  if (FORBIDDEN_TRACKED_FILES.has(normalized)) issues.push('runtime-file-tracked');
  if (FORBIDDEN_TRACKED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    issues.push('runtime-file-tracked');
  }
  if (isForbiddenCredentialPath(normalized)) issues.push('credential-path-tracked');

  if (normalized.startsWith('fixtures/') && !isSanitizedFixture(normalized)) {
    issues.push('unsanitized-fixture-location');
  }
  if (isSanitizedFixture(normalized) && !SANITIZED_FIXTURE_EXTENSIONS.has(extension)) {
    issues.push('sanitized-fixture-type');
  }

  const mediaKind = VIDEO_EXTENSIONS.has(extension)
    ? 'video'
    : AUDIO_EXTENSIONS.has(extension)
      ? 'audio'
      : IMAGE_EXTENSIONS.has(extension)
        ? 'image'
        : DOCUMENT_EXTENSIONS.has(extension)
          ? 'document'
          : SHEET_EXTENSIONS.has(extension)
            ? 'sheet'
            : null;
  const allowedDocsImage = mediaKind === 'image' && isDocsImage(normalized);
  const allowedSanitizedSheet = mediaKind === 'sheet'
    && isSanitizedFixture(normalized)
    && SANITIZED_FIXTURE_EXTENSIONS.has(extension);
  if (mediaKind && !allowedDocsImage && !allowedSanitizedSheet) {
    issues.push(`tracked-${mediaKind}-artifact`);
  }
  if (allowedDocsImage && ARTIFACT_BASENAME_PATTERN.test(basename)) {
    issues.push('runtime-named-doc-image');
  }
  return [...new Set(issues)];
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function placeholderSecret(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[;,)]*$/, '')
    .trim()
    .toLowerCase();
  return !normalized
    || normalized.includes('...')
    || normalized.startsWith('${')
    || normalized.startsWith('process.env.')
    || normalized.startsWith('<')
    || normalized.startsWith('your-')
    || normalized.startsWith('example')
    || normalized.startsWith('fake-')
    || normalized.startsWith('test-')
    || ['xxx', 'changeme', 'placeholder', 'must-not-be-readable'].includes(normalized);
}

function scanText(relative, text, report, origin) {
  const homePatterns = [
    new RegExp('/' + 'Users/([A-Za-z0-9._-]+)/', 'g'),
    new RegExp('/' + 'home/([A-Za-z0-9._-]+)/', 'g'),
    new RegExp('[A-Za-z]:\\\\' + 'Users\\\\([^\\\\/]+)\\\\', 'g'),
  ];
  for (const pattern of homePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!PLACEHOLDER_USERNAMES.has(String(match[1]).toLowerCase())) {
        report('machine-path', relative, origin, lineNumber(text, match.index));
      }
    }
  }

  const privateKeyHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
  let offset = text.indexOf(privateKeyHeader);
  while (offset !== -1) {
    report('private-key', relative, origin, lineNumber(text, offset));
    offset = text.indexOf(privateKeyHeader, offset + privateKeyHeader.length);
  }

  const directTokenPatterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  ];
  for (const pattern of directTokenPatterns) {
    for (const match of text.matchAll(pattern)) {
      report('credential-token', relative, origin, lineNumber(text, match.index));
    }
  }

  const assignment = /\b([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY))\b["']?[ \t]*[:=][ \t]*([^\s,}\]]*)/g;
  for (const match of text.matchAll(assignment)) {
    if (!placeholderSecret(match[2])) {
      report('credential-assignment', relative, origin, lineNumber(text, match.index));
    }
  }

  if (normalizeRelative(relative) === '.npmrc') {
    const npmToken = /(?:^|\n)[^#\n]*(?:_authToken|_auth|password)\s*=\s*([^\s#]+)/gi;
    for (const match of text.matchAll(npmToken)) {
      if (!placeholderSecret(match[1])) {
        report('credential-assignment', relative, origin, lineNumber(text, match.index));
      }
    }
  }
}

function validDocImage(relative, buffer) {
  const extension = path.posix.extname(relative).toLowerCase();
  if (extension === '.png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  }
  if (extension === '.webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (extension === '.svg') {
    let text;
    try {
      text = fatalUtf8(buffer, relative);
    } catch {
      return false;
    }
    return !text.includes('\0') && /^(?:\uFEFF|\s)*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(text);
  }
  return false;
}

function inspectBytes(relative, buffer, origin, report) {
  if (!Buffer.isBuffer(buffer)) {
    report('source-bytes-unavailable', relative, origin);
    return;
  }

  if (isDocsImage(relative)) {
    if (buffer.length > MAX_DOC_IMAGE_BYTES) {
      report('doc-image-too-large', relative, origin);
      return;
    }
    if (!validDocImage(relative, buffer)) {
      report('doc-image-signature', relative, origin);
      return;
    }
    if (path.posix.extname(relative).toLowerCase() !== '.svg') return;
  } else if (isSanitizedFixture(relative)) {
    if (buffer.length > MAX_SANITIZED_FIXTURE_BYTES) {
      report('sanitized-fixture-too-large', relative, origin);
      return;
    }
  } else if (buffer.length > MAX_SOURCE_BYTES) {
    report('source-file-too-large', relative, origin);
    return;
  }

  if (buffer.includes(0)) {
    report('binary-source', relative, origin);
    return;
  }
  let text;
  try {
    text = fatalUtf8(buffer, `${relative}:${origin}`);
  } catch {
    report('non-utf8-source', relative, origin);
    return;
  }
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/.test(text)) {
    report('git-lfs-pointer', relative, origin);
  }
  scanText(relative, text, report, origin);
}

function isIgnored(relative, context, gitRunner) {
  const result = gitRunner('git', [
    '--no-replace-objects',
    `--git-dir=${context.gitDir}`,
    `--work-tree=${context.root}`,
    'check-ignore',
    '--no-index',
    '-q',
    '--',
    relative,
  ], {
    cwd: context.root,
    encoding: null,
    env: context.environment,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result && !result.error && result.status === 0) return true;
  if (result && !result.error && result.status === 1) return false;
  throw new Error(`git check-ignore failed for ${relative}`);
}

function scanRepository(options = {}) {
  const findings = [];
  const seen = new Set();
  const report = (rule, file, origin = 'policy', line = 0) => {
    const key = `${rule}:${file}:${origin}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, line, origin, rule });
  };
  const gitRunner = options.gitRunner || spawnSync;
  let context;
  let entries;
  try {
    context = canonicalGitContext(options.root || ROOT, options.environment || process.env);
    entries = listTrackedEntries(context, gitRunner);
  } catch (error) {
    report('git-inventory-unavailable', '.git', 'git');
    return { findings, trackedCount: 0, error };
  }

  for (const entry of entries) {
    const relative = normalizeRelative(entry.path);
    for (const rule of pathPolicyIssues(relative)) report(rule, relative);
    if (entry.stage !== 0) {
      report('unmerged-index-stage', relative, 'index');
      continue;
    }
    if (entry.flag !== 'H') report('hidden-or-sparse-index-entry', relative, 'index');
    if (!ALLOWED_INDEX_MODES.has(entry.mode)) {
      report('unsupported-index-mode', relative, 'index');
      continue;
    }

    const indexBytes = readIndexBlob(entry, context, gitRunner);
    if (!indexBytes) {
      report('index-blob-unavailable', relative, 'index');
      continue;
    }
    if (canonicalBlobOid(indexBytes, entry.oid.length) !== entry.oid) {
      report('index-blob-oid-mismatch', relative, 'index');
      continue;
    }
    inspectBytes(relative, indexBytes, 'index', report);

    let worktree;
    try {
      worktree = readWorktreeFile(context.root, relative);
    } catch (error) {
      report('worktree-entry-unavailable', relative, 'worktree');
      continue;
    }
    inspectBytes(relative, worktree.bytes, 'worktree', report);
    if (!worktree.bytes.equals(indexBytes)) {
      report('index-worktree-mismatch', relative, 'worktree');
    }
    const executable = (worktree.metadata.mode & 0o111) !== 0;
    if ((entry.mode === '100755') !== executable) {
      report('index-worktree-mode-mismatch', relative, 'worktree');
    }
  }

  try {
    for (const sentinel of IGNORED_SENTINELS) {
      if (!isIgnored(sentinel, context, gitRunner)) report('runtime-sentinel-visible', sentinel, 'gitignore');
    }
    for (const sentinel of VISIBLE_SOURCE_SENTINELS) {
      if (isIgnored(sentinel, context, gitRunner)) report('source-sentinel-ignored', sentinel, 'gitignore');
    }
  } catch (error) {
    report('gitignore-check-unavailable', '.gitignore', 'gitignore');
  }

  return { findings, trackedCount: entries.length };
}

function main() {
  const result = scanRepository();
  if (result.findings.length) {
    for (const finding of result.findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`❌ [${finding.rule}:${finding.origin}] ${location}`);
    }
    console.error(`source boundary 失敗：${result.findings.length} 個問題`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ source boundary：${result.trackedCount} 個 canonical tracked files，index/worktree/runtime/secret/media scan 無命中`);
  console.log('✅ .gitignore：runtime sentinels 已忽略，docs images 與 sanitized fixtures 仍可見');
}

if (require.main === module) main();

module.exports = {
  MAX_DOC_IMAGE_BYTES,
  MAX_SANITIZED_FIXTURE_BYTES,
  canonicalGitContext,
  inspectBytes,
  listTrackedEntries,
  pathPolicyIssues,
  scanRepository,
};
