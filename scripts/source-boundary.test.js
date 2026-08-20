#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_TRACKED_ROOTS = [
  '.cache/',
  '.data/',
  '.dual-tmp/',
  '.local/',
  '.remotion/',
  '.verify-dual-tmp/',
  '_frames_check/',
  'assets/',
  'backups/',
  'build/',
  'captures/',
  'coverage/',
  'internal-snapshots/',
  'jobs/',
  'keychain-data/',
  'out/',
  'persona-values/',
  'provider-cache/',
  'public/jobs/',
  'recordings/',
  'runtime-data/',
  'sessions/',
  'test-results/',
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

const IGNORED_SENTINELS = [
  '.local/captures/frame.png',
  '.cache/provider/cache.json',
  'assets/logo.png',
  'captures/screen.png',
  'coverage/lcov.info',
  'internal-snapshots/page.json',
  'jobs/run-1/job.json',
  'keychain-data/export.json',
  'out/final.mp4',
  'persona-values/local.json',
  'provider-cache/response.json',
  'recordings/run.mp4',
  'runtime-data/projects/project-1/project.json',
  'runtime-data/jobs/run-1/job.json',
  'sessions/session.json',
  'test-results/result.json',
];

const VISIBLE_SOURCE_SENTINELS = [
  '.agents/skills/example/SKILL.md',
  'docs/adr.md',
  'docs/diagrams/source.png',
  'fixtures/example.json',
  'scripts/example.js',
  'scripts/example.test.js',
  'scripts/sanitized-personas.json',
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

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean);
}

function isIgnored(relativePath) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', relativePath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore 失敗：${relativePath}`);
}

function isForbiddenCredentialPath(relativePath) {
  const basename = path.posix.basename(relativePath);
  if (relativePath === '.env.example') return false;
  return basename === '.env'
    || basename.startsWith('.env.')
    || /^\.google-creds.*\.json$/i.test(basename)
    || /service[-_]?account.*\.json$/i.test(basename)
    || /\.(?:key|pem|p12|pfx|mobileprovision)$/i.test(basename);
}

function isProbablyText(buffer) {
  if (!buffer.length) return true;
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
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

function scanText(relativePath, text, report) {
  const homePatterns = [
    new RegExp('/' + 'Users/([A-Za-z0-9._-]+)/', 'g'),
    new RegExp('/' + 'home/([A-Za-z0-9._-]+)/', 'g'),
    new RegExp('[A-Za-z]:\\\\' + 'Users\\\\([^\\\\/]+)\\\\', 'g'),
  ];
  for (const pattern of homePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!PLACEHOLDER_USERNAMES.has(String(match[1]).toLowerCase()))
        report('machine-path', relativePath, lineNumber(text, match.index));
    }
  }

  const privateKeyHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
  let offset = text.indexOf(privateKeyHeader);
  while (offset !== -1) {
    report('private-key', relativePath, lineNumber(text, offset));
    offset = text.indexOf(privateKeyHeader, offset + privateKeyHeader.length);
  }

  const directTokenPatterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  ];
  for (const pattern of directTokenPatterns) {
    for (const match of text.matchAll(pattern))
      report('credential-token', relativePath, lineNumber(text, match.index));
  }

  // Only scan credential-shaped environment/config names. Runtime ownership tokens such as
  // WORKSPACE_RUN_TOKEN are identifiers, not provider credentials, and belong in deterministic tests.
  const assignment = /\b([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY))\b["']?[ \t]*[:=][ \t]*([^\s,}\]]*)/g;
  for (const match of text.matchAll(assignment)) {
    if (!placeholderSecret(match[2]))
      report('credential-assignment', relativePath, lineNumber(text, match.index));
  }
}

function main() {
  const findings = [];
  const seen = new Set();
  const report = (rule, file, line = 0) => {
    const key = `${rule}:${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, file, line });
  };

  const tracked = trackedFiles();
  for (const relativePath of tracked) {
    const normalized = relativePath.replace(/\\/g, '/');
    if (FORBIDDEN_TRACKED_ROOTS.some((root) => normalized.startsWith(root)))
      report('runtime-path-tracked', normalized);
    if (FORBIDDEN_TRACKED_FILES.has(normalized)) report('runtime-file-tracked', normalized);
    if (FORBIDDEN_TRACKED_FILE_PATTERNS.some((pattern) => pattern.test(normalized)))
      report('runtime-file-tracked', normalized);
    if (isForbiddenCredentialPath(normalized)) report('credential-path-tracked', normalized);

    const absolutePath = path.join(ROOT, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      report('tracked-symlink', normalized);
      continue;
    }
    if (!stat.isFile()) continue;
    const buffer = fs.readFileSync(absolutePath);
    if (isProbablyText(buffer)) scanText(normalized, buffer.toString('utf8'), report);
  }

  for (const sentinel of IGNORED_SENTINELS) {
    if (!isIgnored(sentinel)) report('runtime-sentinel-visible', sentinel);
  }
  for (const sentinel of VISIBLE_SOURCE_SENTINELS) {
    if (isIgnored(sentinel)) report('source-sentinel-ignored', sentinel);
  }

  if (findings.length) {
    for (const finding of findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`❌ [${finding.rule}] ${location}`);
    }
    console.error(`source boundary 失敗：${findings.length} 個問題`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ source boundary：${tracked.length} 個 tracked files，runtime/secret/machine-path scan 無命中`);
  console.log('✅ .gitignore：runtime sentinels 已忽略，source/tests/docs/fixtures sentinels 仍可見');
}

try {
  main();
} catch (error) {
  console.error(`❌ source boundary scanner 無法完成：${error.message}`);
  process.exitCode = 1;
}
