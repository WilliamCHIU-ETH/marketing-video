#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { root: process.cwd(), json: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--check') out.check = true;
    else if (arg === '--root') out.root = argv[++i];
    else if (arg.startsWith('--root=')) out.root = arg.slice(7);
    else throw new Error(`不認得參數：${arg}`);
  }
  if (!out.root) throw new Error('--root 不可為空');
  return out;
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function safeStat(file) {
  try { return fs.lstatSync(file); } catch (_) { return null; }
}

function walkFiles(root, anomalies) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const stat = safeStat(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        anomalies.push({ severity: 'critical', code: 'symlink', path: file, message: '清理掃描不跟隨 symlink' });
      } else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  return files;
}

function dirBytes(dir, anomalies) {
  return walkFiles(dir, anomalies).reduce((sum, file) => sum + file.size, 0);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function recoveryFingerprint(dir) {
  const names = ['heygen.mp4', 'script.txt', 'image.png', 'annotations.json'];
  const parts = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || !safeStat(file).isFile()) continue;
    parts.push(`${name}:${await sha256File(file)}`);
  }
  if (!parts.length) return null;
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function lockSignature(root) {
  const file = path.join(root, '.run.lock');
  const stat = safeStat(file);
  return stat ? `${stat.size}:${stat.mtimeMs}` : null;
}

function relative(root, file) {
  return path.relative(root, file) || '.';
}

async function buildPlan(options) {
  const root = fs.realpathSync(path.resolve(options.root));
  const anomalies = [];
  const eligibleCandidates = [];
  const manualCandidates = [];
  const protectedItems = [];
  const classes = [];
  const keepRecent = Number(process.env.KEEP_RECENT || 20);
  const keepDays = Number(process.env.KEEP_DAYS || 7);
  const activeStatuses = ['draft', 'queued', 'preparing', 'review', 'approved', 'rendering', 'detached', 'detached-done'];
  const terminalStatuses = ['done', 'failed', 'cancelled', 'pruned'];
  const lockAtStart = lockSignature(root);
  const scanned = new Set();

  const targets = ['jobs', 'backups', 'out', '成品', '.cache', '.dual-tmp', '.verify-dual-tmp', '_frames_check'];
  let scannedBytes = 0;
  for (const name of targets) {
    const dir = path.join(root, name);
    const bytes = dirBytes(dir, anomalies);
    scannedBytes += bytes;
    scanned.add(dir);
    classes.push({ class: `area.${name}`, path: name, bytes });
  }

  const jobsDir = path.join(root, 'jobs');
  const jobs = [];
  if (fs.existsSync(jobsDir)) {
    for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(jobsDir, entry.name);
      const file = path.join(dir, 'job.json');
      if (!fs.existsSync(file)) {
        anomalies.push({ severity: 'critical', code: 'job.missing-manifest', path: relative(root, dir), message: 'job 缺少 job.json' });
        continue;
      }
      try {
        const job = JSON.parse(fs.readFileSync(file, 'utf8'));
        jobs.push({ id: entry.name, dir, bytes: dirBytes(dir, anomalies), job });
      } catch (error) {
        anomalies.push({ severity: 'critical', code: 'job.invalid-manifest', path: relative(root, file), message: error.message });
      }
    }
  }

  jobs.sort((a, b) => String(b.job.createdAt || '').localeCompare(String(a.job.createdAt || '')));
  const recent = new Set(jobs.slice(0, keepRecent).map((item) => item.id));
  const cutoff = Date.now() - keepDays * 86400000;
  const planByTemplate = {
    focusstock: 'state/src/Focusstock/focusstock-shots.generated.json',
    dapan: 'state/src/DapanXiaobao/dapan-shots.generated.json',
    institution: 'state/src/Institution/institution-focus.generated.json',
    default: 'state/src/marketing-shots.generated.json',
  };

  for (const item of jobs) {
    const status = item.job.status || 'unknown';
    if (activeStatuses.includes(status)) {
      protectedItems.push({ class: 'job.active', path: relative(root, item.dir), bytes: item.bytes, reason: `status=${status}` });
    }
    if (status === 'review') {
      const required = [
        'state/public/heygen.mp4',
        'state/public/script.txt',
        planByTemplate[item.job.template],
      ].filter(Boolean);
      const missing = required.filter((rel) => !fs.existsSync(path.join(item.dir, rel)));
      if (missing.length) {
        anomalies.push({
          severity: 'critical', code: 'review.snapshot-incomplete', path: relative(root, item.dir),
          message: `review job 無法可靠續跑，缺少：${missing.join(', ')}`,
        });
      }
    }
    if (status === 'done') {
      for (const output of item.job.outputs || []) {
        if (output.archive) continue;
        const fallback = path.join(item.dir, 'out', output.name || '');
        if (output.name && fs.existsSync(fallback)) {
          anomalies.push({
            severity: 'critical', code: 'done.unarchived-output', path: relative(root, fallback),
            message: '完成工作的唯一成品仍在 job fallback，必須保護',
          });
        }
      }
    }
    const time = Date.parse(item.job.finishedAt || item.job.createdAt || '') || 0;
    const oldEnough = !recent.has(item.id) && time < cutoff;
    const archivesPresent = (item.job.outputs || []).length > 0 && (item.job.outputs || []).every((output) => {
      if (!output.archive) return false;
      const file = path.isAbsolute(output.archive) ? output.archive : path.resolve(root, output.archive);
      const stat = safeStat(file);
      return !!stat && stat.isFile();
    });
    if (terminalStatuses.includes(status) && oldEnough && archivesPresent) {
      const payloads = ['state', 'input', 'out', 'thumbs'].map((name) => path.join(item.dir, name)).filter(fs.existsSync);
      for (const payload of payloads) {
        manualCandidates.push({
          id: `job:${item.id}:${path.basename(payload)}`, class: 'job.terminal-payload', action: 'delete-tree',
          path: relative(root, payload), bytes: dirBytes(payload, anomalies), decision: 'manual',
          reason: `terminal status=${status} 且超出 retention，但 archive 尚無內容 digest 契約`,
        });
      }
    }
  }

  const backupsDir = path.join(root, 'backups');
  const backupGroups = new Map();
  if (fs.existsSync(backupsDir)) {
    for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(backupsDir, entry.name);
      const fingerprint = await recoveryFingerprint(dir);
      if (!fingerprint) continue;
      const item = { dir, bytes: dirBytes(dir, anomalies), fingerprint };
      if (!backupGroups.has(fingerprint)) backupGroups.set(fingerprint, []);
      backupGroups.get(fingerprint).push(item);
    }
  }
  for (const group of backupGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.dir.localeCompare(b.dir));
    const survivor = group[group.length - 1];
    for (const item of group.slice(0, -1)) {
      manualCandidates.push({
        id: `backup:${path.basename(item.dir)}`, class: 'backup.exact-duplicate', action: 'delete-tree',
        path: relative(root, item.dir), bytes: item.bytes, decision: 'manual',
        reason: '可恢復檔案的 SHA-256 與另一份 backup 完全相同',
        evidence: { recoverySha256: item.fingerprint, duplicateOf: relative(root, survivor.dir) },
      });
    }
  }

  const archiveDir = path.join(root, '成品');
  const archiveByHash = new Map();
  for (const file of walkFiles(archiveDir, anomalies).filter((item) => item.path.endsWith('.mp4'))) {
    const hash = await sha256File(file.path);
    archiveByHash.set(hash, file.path);
  }
  for (const file of walkFiles(path.join(root, 'out'), anomalies).filter((item) => item.path.endsWith('.mp4'))) {
    const hash = await sha256File(file.path);
    if (!archiveByHash.has(hash)) {
      manualCandidates.push({
        id: `out:${path.basename(file.path)}`, class: 'out.unreferenced', action: 'review',
        path: relative(root, file.path), bytes: file.size, decision: 'manual', reason: '找不到內容相同的已封存成品',
      });
      continue;
    }
    eligibleCandidates.push({
      id: `out:${path.basename(file.path)}`, class: 'out.archive-duplicate', action: 'delete-file',
      path: relative(root, file.path), bytes: file.size, decision: 'eligible',
      reason: '與成品庫檔案 SHA-256 完全相同',
      evidence: { sha256: hash, duplicateOf: relative(root, archiveByHash.get(hash)) },
    });
  }

  for (const name of ['.dual-tmp', '.verify-dual-tmp']) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) protectedItems.push({ class: 'cache.paid', path: name, bytes: dirBytes(dir, anomalies), reason: '可能避免重複消耗付費生成點數' });
  }
  for (const name of ['.cache', '_frames_check']) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) manualCandidates.push({ id: `cache:${name}`, class: 'cache.derived', action: 'review', path: name, bytes: dirBytes(dir, anomalies), decision: 'manual', reason: '可重建，但目前不自動刪除' });
  }

  const lockAtEnd = lockSignature(root);
  if (lockAtStart || lockAtEnd || lockAtStart !== lockAtEnd) {
    anomalies.push({ severity: 'blocking', code: 'active-writer', path: '.run.lock', message: '掃描期間偵測到執行鎖，禁止 apply' });
  }

  const eligibleBytes = eligibleCandidates.reduce((sum, item) => sum + item.bytes, 0);
  const manualPotentialBytes = manualCandidates.reduce((sum, item) => sum + item.bytes, 0);
  const protectedBytes = protectedItems.reduce((sum, item) => sum + item.bytes, 0);
  const policy = { keepRecent, keepDays, activeStatuses, terminalStatuses };
  const planSeed = JSON.stringify({ root, policy, eligibleCandidates, manualCandidates, anomalies });
  const hasBlockingAnomaly = anomalies.some((item) => item.severity === 'blocking' || item.severity === 'critical');
  const plan = {
    schemaVersion: 1,
    mode: 'read-only',
    root,
    generatedAt: new Date().toISOString(),
    complete: !hasBlockingAnomaly,
    safeToApply: !hasBlockingAnomaly,
    policy,
    runtime: { lockAtStart, lockAtEnd },
    totals: { scannedBytes, eligibleBytes, manualPotentialBytes, protectedBytes },
    classes,
    eligibleCandidates,
    manualCandidates,
    protected: protectedItems,
    anomalies,
    planId: crypto.createHash('sha256').update(planSeed).digest('hex'),
  };
  return plan;
}

function printHuman(plan) {
  console.log(`cleanup plan: ${plan.root}`);
  console.log(`mode: ${plan.mode}`);
  console.log(`scanned: ${human(plan.totals.scannedBytes)}`);
  console.log(`eligible: ${human(plan.totals.eligibleBytes)} (${plan.eligibleCandidates.length})`);
  console.log(`manual: ${human(plan.totals.manualPotentialBytes)} (${plan.manualCandidates.length})`);
  console.log(`protected: ${human(plan.totals.protectedBytes)} (${plan.protected.length})`);
  console.log(`anomalies: ${plan.anomalies.length}`);
  for (const item of plan.anomalies) console.log(`  ❌ ${item.code} ${item.path}: ${item.message}`);
  for (const item of plan.eligibleCandidates) console.log(`  ✅ eligible ${item.path} (${human(item.bytes)}): ${item.reason}`);
  for (const item of plan.manualCandidates) console.log(`  ⚠️  manual ${item.path} (${human(item.bytes)}): ${item.reason}`);
  console.log(`planId: ${plan.planId}`);
  console.log('本指令不會刪除或修改任何檔案。');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const plan = await buildPlan(options);
    if (options.json) console.log(JSON.stringify(plan, null, 2));
    else printHuman(plan);
    if (plan.anomalies.some((item) => item.code === 'active-writer')) process.exitCode = 3;
    else if (plan.anomalies.some((item) => item.severity === 'critical')) process.exitCode = 2;
    else if (options.check && plan.eligibleCandidates.length) process.exitCode = 10;
  } catch (error) {
    console.error('❌ cleanup plan 失敗：' + error.message);
    process.exitCode = 1;
  }
}

main();
