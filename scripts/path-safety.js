'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function rejectParentTraversal(input, label) {
  const parts = String(input).split(/[\\/]+/);
  if (parts.includes('..')) throw new Error(`${label} 不可包含 ..`);
}

/**
 * Inspect the supplied lexical path before realpath. Every existing component is lstat'ed, so a
 * middle symlink (for example app/assets -> ../data/assets) cannot disappear behind realpath.
 */
function assertNoSymlinkComponents(input, label, { allowMissingTail = false } = {}) {
  rejectParentTraversal(input, label);
  const absolute = path.resolve(input);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissingTail) {
        return { absolute, nearestExisting: path.dirname(current), missingFrom: index };
      }
      throw new Error(`${label} 路徑 component 不存在：${current}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} 路徑 component 是 symlink：${current}`);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`${label} 路徑 component 不是目錄：${current}`);
  }
  return { absolute, nearestExisting: absolute, missingFrom: null };
}

function assertExpectedType(file, label, type) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`${label} 不可為 symlink`);
  if (type === 'file' && !stat.isFile()) throw new Error(`${label} 不是一般檔案`);
  if (type === 'directory' && !stat.isDirectory()) throw new Error(`${label} 不是一般目錄`);
  return stat;
}

function resolveExistingPath(input, label, type) {
  const { absolute } = assertNoSymlinkComponents(input, label);
  assertExpectedType(absolute, label, type);
  const canonical = fs.realpathSync(absolute);
  if (canonical !== absolute) throw new Error(`${label} canonical path 與 supplied path 不一致`);
  return canonical;
}

function resolveExistingWithin(root, relative, label, type = 'file') {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} 必須是相對路徑`);
  rejectParentTraversal(relative, label);
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) throw new Error(`${label} 超出 root`);
  const canonical = resolveExistingPath(candidate, label, type);
  if (!isInside(root, canonical)) throw new Error(`${label} canonical path 超出 root`);
  return canonical;
}

function resolveOutputWithin(root, relative, label) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} 必須是相對路徑`);
  rejectParentTraversal(relative, label);
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) throw new Error(`${label} 超出 root`);
  const inspected = assertNoSymlinkComponents(candidate, label, { allowMissingTail: true });
  if (fs.existsSync(candidate)) {
    const canonical = fs.realpathSync(candidate);
    if (!isInside(root, canonical)) throw new Error(`${label} canonical path 超出 root`);
    assertExpectedType(candidate, label, 'file');
    return candidate;
  }
  let existing = inspected.nearestExisting;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  assertNoSymlinkComponents(existing, `${label} 最近既存 parent`);
  const parentStat = fs.lstatSync(existing);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error(`${label} 最近既存 parent 不是安全目錄`);
  const canonicalParent = fs.realpathSync(existing);
  if (canonicalParent !== root && !isInside(root, canonicalParent))
    throw new Error(`${label} 最近既存 parent canonical path 超出 root`);
  return candidate;
}

module.exports = {
  isInside,
  assertNoSymlinkComponents,
  resolveExistingPath,
  resolveExistingWithin,
  resolveOutputWithin,
};
