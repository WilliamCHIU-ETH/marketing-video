'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP_ROOT = path.resolve(__dirname, '..');

function workspaceRoot() {
  if (process.env.MARKETING_VIDEO_WORKSPACE_ROOT) {
    return path.resolve(process.env.MARKETING_VIDEO_WORKSPACE_ROOT);
  }
  const parent = path.dirname(APP_ROOT);
  return path.basename(parent) === 'worktrees' ? path.dirname(parent) : parent;
}

function regularFilesRecursively(root) {
  const files = [];
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files.push(entry);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
  };
  visit(root);
  return files;
}

function routingFiles(root) {
  const fixed = [path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md')];
  const skill = path.join(root, '.agents', 'skills', 'morning-brief-video');
  for (const file of [...fixed, skill]) assert.ok(fs.existsSync(file), `missing routing source: ${file}`);
  return [...fixed, ...regularFilesRecursively(skill)];
}

const FORBIDDEN = [
  {
    name: 'caller-configurable Provider executable',
    pattern: /\bCHIPK_CAPTURE_BIN\b/,
  },
  {
    name: 'placeholder Provider capabilities/acquire command',
    pattern: /<command>\s+(?:capabilities|acquire)\b/i,
  },
  {
    name: 'direct chipk-capture capabilities/acquire command',
    pattern: /(?:^|[\s`$>])(?:[^\s`]+\/)?chipk-capture(?:\.js)?\s+(?:capabilities|acquire)\b/i,
  },
  {
    name: 'direct Provider bootstrap command',
    pattern: /(?:^|[\s`$>])(?:[^\s`]+\/)?chipk-capture-bootstrap\s+configure\b/i,
  },
];

function directProviderCommands(root, files) {
  const violations = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          violations.push(`${relative}:${index + 1}: ${rule.name}: ${line.trim()}`);
        }
      }
    });
  }
  return violations;
}

test('Agent-facing routing exposes only the Marketing capture-cta command', () => {
  const root = workspaceRoot();
  const files = routingFiles(root);
  const violations = directProviderCommands(root, files);
  assert.deepEqual(violations, [],
    `Agent-facing routing contains executable Provider details:\n${violations.join('\n')}`);

  const normalized = files.map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n').replace(/\\\s*\n/g, ' ').replace(/\s+/g, ' ');
  assert.match(normalized,
    /node \/Users\/chiu\/Developer\/marketing-video\/app\/scripts\/material\.js capture-cta --project \S+ --stock-id \S+ --json/,
    'routing must publish the frozen agent-facing entry (direct node, not npm)');
});
