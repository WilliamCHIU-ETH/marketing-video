#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const ts = require('typescript');

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
  '.json',
  '.jsonl',
]);
const ALLOWED_INDEX_MODES = new Set(['100644', '100755']);
const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
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

const SANITIZED_CREDENTIAL_FIELDS = [
  'apikey',
  'accesstoken',
  'authtoken',
  'clientsecret',
  'credential',
  'groupid',
  'keychain',
  'password',
  'privatekey',
  'secret',
  'secretkey',
  'token',
];
const SANITIZED_IDENTITY_FIELDS = [
  'accountname',
  'clientid',
  'displayname',
  'email',
  'fullname',
  'jobid',
  'persona',
  'personaname',
  'profileid',
  'projectid',
  'requestid',
  'revisionid',
  'runid',
  'sessionid',
  'threadid',
  'tenantid',
  'userid',
  'username',
  'workspaceruntoken',
];
const SANITIZED_NETWORK_FIELDS = ['baseurl', 'endpoint', 'host', 'hostname', 'uri', 'url'];
const SANITIZED_EXAMPLE_HOSTS = ['example.com', 'example.net', 'example.org'];
const SANITIZED_SAFE_TOKENS = new Set([
  'account',
  'anonymous',
  'api',
  'auth',
  'client',
  'credential',
  'dummy',
  'email',
  'example',
  'fake',
  'file',
  'fixture',
  'group',
  'heygen',
  'id',
  'job',
  'key',
  'masked',
  'minimax',
  'mock',
  'must',
  'not',
  'none',
  'openai',
  'persona',
  'placeholder',
  'private',
  'profile',
  'project',
  'redacted',
  'request',
  'revision',
  'run',
  'sample',
  'secret',
  'session',
  'shell',
  'synthetic',
  'test',
  'thread',
  'token',
  'read',
  'user',
  'value',
  'be',
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

function sanitizedFieldKind(field) {
  const compact = String(field || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (SANITIZED_CREDENTIAL_FIELDS.some((candidate) => compact === candidate || compact.endsWith(candidate))) {
    return 'credential';
  }
  if (SANITIZED_IDENTITY_FIELDS.some((candidate) => compact === candidate || compact.endsWith(candidate))) {
    return 'identity';
  }
  if (SANITIZED_NETWORK_FIELDS.some((candidate) => compact === candidate || compact.endsWith(candidate))) {
    return 'network';
  }
  return null;
}

function syntheticFixtureValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
  if (!normalized) return true;
  if (/^0{8}-0{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}$/i.test(normalized)) return true;
  const tokens = normalized.split(/[-_.\s]+/).filter(Boolean);
  const markerTokens = new Set([
    'anonymous',
    'dummy',
    'example',
    'fake',
    'fixture',
    'masked',
    'mock',
    'none',
    'placeholder',
    'redacted',
    'sample',
    'synthetic',
    'test',
  ]);
  return tokens.some((token) => markerTokens.has(token))
    && tokens.every((token) => /^\d+$/.test(token)
    || /^v\d+$/.test(token)
    || SANITIZED_SAFE_TOKENS.has(token));
}

function sanitizedExampleHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  return normalized === 'invalid'
    || normalized.endsWith('.invalid')
    || SANITIZED_EXAMPLE_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function sanitizedNetworkValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^['"]|['"]$/g, '').trim();
  if (!normalized) return true;
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return true;
  try {
    const parsed = new URL(normalized.includes('://') ? normalized : `https://${normalized}`);
    return sanitizedExampleHost(parsed.hostname);
  } catch {
    return false;
  }
}

function sanitizedScalarIssue(field, value) {
  const kind = sanitizedFieldKind(field);
  if (kind === 'network') return sanitizedNetworkValue(value) ? null : 'sanitized-non-example-url';
  const emailMatch = typeof value === 'string' ? value.trim().match(/@([^@\s]+)$/) : null;
  if (kind === 'identity' && emailMatch && sanitizedExampleHost(emailMatch[1])) return null;
  if (!kind || syntheticFixtureValue(value)) return null;
  return kind === 'credential' ? 'sanitized-credential-value' : 'sanitized-identity-value';
}

function scanSanitizedStructure(value, reportIssue) {
  if (Array.isArray(value)) {
    for (const item of value) scanSanitizedStructure(item, reportIssue);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [field, child] of Object.entries(value)) {
    const issue = sanitizedScalarIssue(field, child);
    if (issue) reportIssue(issue, field);
    scanSanitizedStructure(child, reportIssue);
  }
}

function scanSanitizedFixture(relative, text, report, origin) {
  const reportAt = (rule, offset = 0) => report(rule, relative, origin, lineNumber(text, Math.max(0, offset)));
  const semanticText = text
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\\//g, '/');

  const absoluteUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>'"`]+/gi;
  for (const match of semanticText.matchAll(absoluteUrl)) {
    const raw = match[0].replace(/[),.;}\]]+$/, '');
    try {
      const parsed = new URL(raw);
      if (!sanitizedExampleHost(parsed.hostname)) reportAt('sanitized-non-example-url', match.index);
    } catch {
      reportAt('sanitized-url-invalid', match.index);
    }
  }

  const email = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  for (const match of semanticText.matchAll(email)) {
    if (!sanitizedExampleHost(match[1])) reportAt('sanitized-personal-email', match.index);
  }

  const fieldValue = /(?=(["']?([A-Za-z][A-Za-z0-9_. -]*?)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]\r\n]+)))/g;
  for (const match of semanticText.matchAll(fieldValue)) {
    let value = match[3].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const issue = sanitizedScalarIssue(match[2], value);
    if (issue) reportAt(issue, match.index);
  }

  const extension = path.posix.extname(relative).toLowerCase();
  if (extension === '.json' || extension === '.jsonl') {
    const documents = extension === '.json'
      ? [text]
      : text.split(/\r?\n/).filter((line) => line.trim());
    for (const document of documents) {
      try {
        const parsed = JSON.parse(document);
        scanSanitizedStructure(parsed, (rule, field) => {
          const fieldOffset = semanticText.search(new RegExp(`["']${String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`));
          reportAt(rule, fieldOffset < 0 ? 0 : fieldOffset);
        });
      } catch {
        reportAt('sanitized-structure-invalid');
        break;
      }
    }
  }
}

function sourceCredentialExpressionSafe(value, relative, variableName = '') {
  const raw = String(value || '').trim().replace(/[;,]*$/, '').trim();
  const shellSequence = raw.match(/^(\S+)(?:\s+[A-Z][A-Z0-9_]*=)/);
  if (shellSequence) return strictSourcePlaceholder(shellSequence[1]);
  const directReference = raw.match(/^(?:providerSecrets|process\.env)\.([A-Z][A-Z0-9_]*)$/);
  if (directReference && variableName) {
    return directReference[1] === variableName
      || (variableName === 'API_KEY' && directReference[1].endsWith('_API_KEY'));
  }
  const literals = [...raw.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  if (literals.length) return literals.every((literal) => strictSourcePlaceholder(literal));
  const extension = path.posix.extname(relative).toLowerCase();
  if (path.posix.basename(relative).endsWith('.env.example')
      || ['.env', '.json', '.jsonl', '.toml', '.yaml', '.yml'].includes(extension)) {
    return strictSourcePlaceholder(raw);
  }
  return true;
}

function strictSourcePlaceholder(value) {
  const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
  return !normalized
    || ['changeme', 'must-not-be-readable', 'placeholder', 'xxx'].includes(normalized.toLowerCase())
    || /^<[^>]+>$/.test(normalized)
    || syntheticFixtureValue(normalized);
}

function sourceCredentialField(field) {
  const compact = String(field || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'apikey',
    'accesstoken',
    'authtoken',
    'bearertoken',
    'clientsecret',
    'credential',
    'groupid',
    'keychain',
    'password',
    'privatekey',
    'providertoken',
    'refreshtoken',
    'secret',
    'secretkey',
  ].some((candidate) => compact === candidate || compact.endsWith(candidate));
}

function sourceFieldName(node) {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return '';
}

function dottedSourceReference(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) {
    const parent = dottedSourceReference(current.expression);
    return parent ? `${parent}.${current.name.text}` : '';
  }
  return '';
}

function sourceCredentialNodeSafe(node, variableName = '') {
  const directReference = dottedSourceReference(node).match(/^(?:providerSecrets|process\.env)\.([A-Z][A-Z0-9_]*)$/);
  if (directReference && variableName) {
    return directReference[1] === variableName
      || (variableName === 'API_KEY' && directReference[1].endsWith('_API_KEY'));
  }

  const literalValues = [];
  let numericLiteral = false;
  const visit = (current) => {
    if (ts.isStringLiteralLike(current)) {
      literalValues.push(current.text);
      return;
    }
    if (ts.isTemplateExpression(current)) {
      literalValues.push(current.head.text, ...current.templateSpans.map((span) => span.literal.text));
    }
    if (ts.isNumericLiteral(current)) numericLiteral = true;
    ts.forEachChild(current, visit);
  };
  visit(node);
  if (numericLiteral) return false;
  return literalValues.every((value) => strictSourcePlaceholder(value));
}

function scanCodeCredentials(relative, text, report, origin) {
  const extension = path.posix.extname(relative).toLowerCase();
  const scriptKind = extension === '.ts'
    ? ts.ScriptKind.TS
    : extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKind);
  if (source.parseDiagnostics.length) {
    const first = source.parseDiagnostics[0];
    const location = source.getLineAndCharacterOfPosition(first.start || 0);
    report('source-parse-invalid', relative, origin, location.line + 1);
    return;
  }

  const inspect = (fieldNode, initializer, locationNode) => {
    const field = sourceFieldName(fieldNode);
    if (!initializer || !sourceCredentialField(field)) return;
    const uppercaseVariable = /^[A-Z][A-Z0-9_]*$/.test(field) ? field : '';
    if (!sourceCredentialNodeSafe(initializer, uppercaseVariable)) {
      const location = source.getLineAndCharacterOfPosition(locationNode.getStart(source));
      report('credential-assignment', relative, origin, location.line + 1);
    }
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
        || ts.isPropertyAssignment(node)
        || ts.isPropertyDeclaration(node)
        || ts.isParameter(node)) {
      inspect(node.name, node.initializer, node);
    } else if (ts.isBindingElement(node)) {
      inspect(node.propertyName || node.name, node.initializer, node);
    } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      inspect(node.left, node.right, node);
    } else if (ts.isJsxAttribute(node)) {
      const initializer = node.initializer && ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      inspect(node.name, initializer, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scanStructuredSourceCredentials(relative, text, report, origin) {
  const extension = path.posix.extname(relative).toLowerCase();
  if (extension !== '.json' && extension !== '.jsonl') return;
  const documents = extension === '.json'
    ? [{ line: 1, text }]
    : text.split(/\r?\n/)
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter((document) => document.text.trim());
  const runtimeShapedFile = /^(?:jobs?|projects?|revisions?|runs?|sessions?|workspaces?)(?:[-_.].*)?\.jsonl?$/i
    .test(path.posix.basename(relative));
  const reportField = (rule, field) => {
    const fieldPattern = new RegExp(`["']${String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
    const offset = text.search(fieldPattern);
    report(rule, relative, origin, lineNumber(text, Math.max(0, offset)));
  };
  const containsRuntimeIdentity = (value) => {
    if (Array.isArray(value)) return value.some(containsRuntimeIdentity);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([field, child]) => sanitizedFieldKind(field) === 'identity'
      || containsRuntimeIdentity(child));
  };
  const rejectDuplicateSensitiveFields = (document, baseLine) => {
    const source = ts.parseJsonText(relative, document);
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const seen = new Set();
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const field = sourceFieldName(property.name);
          const normalized = String(field || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
          if (normalized && sanitizedFieldKind(field) && seen.has(normalized)) {
            const location = source.getLineAndCharacterOfPosition(property.getStart(source));
            report('runtime-sensitive-field-duplicate', relative, origin, baseLine + location.line);
          }
          if (normalized) seen.add(normalized);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  const inspect = (value, inheritedRuntimeContext = false) => {
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, inheritedRuntimeContext);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    const runtimeContext = inheritedRuntimeContext
      || entries.some(([field]) => sanitizedFieldKind(field) === 'identity');
    for (const [field, child] of entries) {
      const kind = sanitizedFieldKind(field);
      if (child !== null && typeof child !== 'object') {
        const issue = sanitizedScalarIssue(field, child);
        if (kind === 'credential' && issue) reportField('credential-assignment', field);
        if (kind === 'identity' && issue) reportField('runtime-identity-value', field);
        if (kind === 'network' && runtimeContext && issue) reportField('runtime-non-example-url', field);
      }
      inspect(child, runtimeContext);
    }
  };
  for (const document of documents) {
    try {
      const parsed = JSON.parse(document.text);
      rejectDuplicateSensitiveFields(document.text, document.line);
      inspect(parsed, runtimeShapedFile || containsRuntimeIdentity(parsed));
    } catch {
      report('source-structure-invalid', relative, origin, document.line);
      break;
    }
  }
}

function scanYamlCredentials(relative, text, report, origin) {
  const extension = path.posix.extname(relative).toLowerCase();
  if (extension !== '.yaml' && extension !== '.yml') return;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s*)?["']?([A-Za-z][A-Za-z0-9_. -]*?)["']?\s*:\s*(.*?)\s*$/);
    if (!match || !sourceCredentialField(match[2])) continue;
    let raw = match[3].replace(/\s+#.*$/, '').trim();
    if (!raw) {
      const parentIndent = match[1].length;
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next];
        if (!candidate.trim() || /^\s*#/.test(candidate)) continue;
        const indent = candidate.match(/^\s*/)[0].length;
        if (indent <= parentIndent) break;
        raw = candidate.trim().replace(/^-\s*/, '');
        break;
      }
    }
    const uppercaseVariable = /^[A-Z][A-Z0-9_]*$/.test(match[2]) ? match[2] : '';
    if (!sourceCredentialExpressionSafe(raw, relative, uppercaseVariable)) {
      report('credential-assignment', relative, origin, index + 1);
    }
  }
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

  const extension = path.posix.extname(relative).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) {
    scanCodeCredentials(relative, text, report, origin);
  } else {
    const assignment = /(?=(\b["']?([A-Za-z][A-Za-z0-9_. -]*?)["']?[ \t]*(?::|=(?![=>]))[ \t]*([^,}\]\r\n]*)))/g;
    for (const match of text.matchAll(assignment)) {
      if (!sourceCredentialField(match[2])) continue;
      const uppercaseVariable = /^[A-Z][A-Z0-9_]*$/.test(match[2]) ? match[2] : '';
      const raw = match[3].trim();
      const emptyExampleEnvironment = !raw && path.posix.basename(relative).endsWith('.env.example');
      if ((!raw && !emptyExampleEnvironment)
          || !sourceCredentialExpressionSafe(raw, relative, uppercaseVariable)) {
        report('credential-assignment', relative, origin, lineNumber(text, match.index));
      }
    }
    scanStructuredSourceCredentials(relative, text, report, origin);
    scanYamlCredentials(relative, text, report, origin);
  }

  if (normalizeRelative(relative) === '.npmrc') {
    const npmToken = /(?:^|\n)[^#\n]*(?:_authToken|_auth|password)\s*=\s*([^\s#]+)/gi;
    for (const match of text.matchAll(npmToken)) {
      if (!strictSourcePlaceholder(match[1])) {
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
  if (isSanitizedFixture(relative)) scanSanitizedFixture(relative, text, report, origin);
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
