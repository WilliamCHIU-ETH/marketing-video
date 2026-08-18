#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-smoke-'));
const GUARD_LOG = path.join(DATA_DIR, 'blocked-side-effects.log');
const GUARD_MODULE = path.join(DATA_DIR, 'side-effect-guard.cjs');
let child;

fs.writeFileSync(GUARD_MODULE, `
'use strict';
const fs = require('fs');
const childProcess = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const log = process.env.SMOKE_GUARD_LOG;
function blocked(kind) {
  return function () {
    fs.appendFileSync(log, kind + '\\n');
    throw new Error('smoke guard blocked ' + kind);
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = blocked('child_process.' + name);
}
http.request = blocked('http.request');
http.get = blocked('http.get');
https.request = blocked('https.request');
https.get = blocked('https.get');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
tls.connect = blocked('tls.connect');
global.fetch = blocked('fetch');
`);

function treeFingerprint(dir) {
  const out = [];
  const walk = (base, rel = '') => {
    if (!fs.existsSync(base)) return;
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const file = path.join(base, entry.name);
      if (entry.isDirectory()) walk(file, nextRel);
      else {
        const stat = fs.statSync(file);
        out.push(`${nextRel}:${stat.size}:${Math.round(stat.mtimeMs)}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

function treeState(dir) {
  return JSON.stringify({ exists: fs.existsSync(dir), fingerprint: treeFingerprint(dir) });
}

function waitForReady(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server 啟動逾時\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/SERVER_READY (\{[^\n]+\})/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(JSON.parse(match[1]));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server 提前結束（${code}）\n${output}`));
    });
  });
}

async function request(base, pathname, options) {
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) {}
  assert.ok(res.ok, `${pathname} 回傳 ${res.status}: ${text}`);
  return body;
}

async function main() {
  const lanAttempt = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0', TEST_MODE: '1', DATA_DIR },
    encoding: 'utf8',
  });
  assert.notEqual(lanAttempt.status, 0);
  assert.match(`${lanAttempt.stdout}\n${lanAttempt.stderr}`, /ALLOW_INSECURE_LAN/);

  const repoDataAttempt = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TEST_MODE: '1', DATA_DIR: path.join(ROOT, 'public') },
    encoding: 'utf8',
  });
  assert.notEqual(repoDataAttempt.status, 0);
  assert.match(`${repoDataAttempt.stdout}\n${repoDataAttempt.stderr}`, /repo 外/);

  const repoLink = path.join(DATA_DIR, 'repo-link');
  fs.symlinkSync(path.join(ROOT, 'src'), repoLink, 'dir');
  const symlinkAttempt = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TEST_MODE: '1', DATA_DIR: repoLink },
    encoding: 'utf8',
  });
  assert.notEqual(symlinkAttempt.status, 0);
  assert.match(`${symlinkAttempt.stdout}\n${symlinkAttempt.stderr}`, /symlink/);

  const mutableRepoPaths = ['public', 'src', 'out', 'backups', 'runtime-data'];
  const before = Object.fromEntries(mutableRepoPaths.map((rel) => [rel, treeState(path.join(ROOT, rel))]));

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      TEST_MODE: '1',
      DATA_DIR,
      HEYGEN_API_KEY: '',
      MINIMAX_API_KEY: '',
      MINIMAX_GROUP_ID: '',
      OPENAI_API_KEY: '',
      SMOKE_GUARD_LOG: GUARD_LOG,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--require=${GUARD_MODULE}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = await waitForReady(child);
  assert.equal(ready.mode, 'test');
  assert.equal(ready.workerEnabled, false);
  const base = `http://127.0.0.1:${ready.port}`;

  const html = await request(base, '/');
  assert.match(html, /出片前台/);

  const health = await request(base, '/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'test');
  assert.equal(health.workerEnabled, false);

  const initial = await request(base, '/api/jobs');
  assert.deepEqual(initial.jobs, []);

  const invalidBrand = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: 'default', brand: 'x; echo injected', body: '測試' }),
  });
  assert.equal(invalidBrand.status, 400);

  const created = await request(base, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'focusstock',
      owner: 'smoke-test',
      title: '啟動測試',
      body: '這是一筆不會呼叫外部影片服務的測試工作。',
      skipGenerate: true,
      noSpeed: true,
      autoApprove: false,
    }),
  });
  assert.equal(created.job.status, 'draft');
  const id = created.job.id;

  const invalidUpload = await fetch(base + `/api/jobs/${id}/upload?name=not-allowed.txt`, {
    method: 'POST',
    body: Buffer.from('blocked'),
  });
  assert.equal(invalidUpload.status, 400);

  await request(base, `/api/jobs/${id}/upload?name=heygen.mp4`, {
    method: 'POST',
    body: Buffer.from('fixture-only-not-a-real-video'),
  });
  const submitted = await request(base, `/api/jobs/${id}/submit`, { method: 'POST' });
  assert.equal(submitted.job.status, 'queued');

  const repeatedSubmit = await fetch(base + `/api/jobs/${id}/submit`, { method: 'POST' });
  assert.equal(repeatedSubmit.status, 409);
  const lateUpload = await fetch(base + `/api/jobs/${id}/upload?name=heygen.mp4`, {
    method: 'POST',
    body: Buffer.from('blocked-after-submit'),
  });
  assert.equal(lateUpload.status, 409);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const queued = await request(base, `/api/jobs/${id}`);
  assert.equal(queued.job.status, 'queued');
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'jobs', id, 'job.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, '.run.lock')), false);
  fs.writeFileSync(path.join(DATA_DIR, '.run.lock'), String(Date.now()));
  const unsafeUnlock = await fetch(base + '/api/unlock', { method: 'POST' });
  assert.equal(unsafeUnlock.status, 409);
  assert.equal(fs.existsSync(path.join(DATA_DIR, '.run.lock')), true);

  for (const rel of mutableRepoPaths) {
    assert.equal(treeState(path.join(ROOT, rel)), before[rel], `${rel} 在 smoke 期間被改動`);
  }
  assert.equal(fs.existsSync(GUARD_LOG) ? fs.readFileSync(GUARD_LOG, 'utf8') : '', '');

  console.log('✅ localhost UI: HTTP 200');
  console.log('✅ /api/health: test mode, worker disabled');
  console.log('✅ fixture job: draft → queued，僅寫入臨時 DATA_DIR');
  console.log('✅ 非法 brand 與 upload 檔名被拒絕');
  console.log('✅ submit 後不可重複排隊或覆寫 input');
  console.log('✅ 未知／活躍 lock 不可由 API 強制刪除');
  console.log('✅ LAN bind 未明確 opt-in 時拒絕啟動');
  console.log('✅ TEST_MODE 拒絕 repo 內路徑與 symlink 回指');
  console.log('✅ provider keys 為空、worker 停用，side-effect guard 未見 outbound/spawn 嘗試');
  console.log('✅ repo mutable workspace 前後一致');
}

main()
  .catch((error) => {
    console.error('❌ smoke test 失敗：' + error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
