#!/usr/bin/env node
/**
 * 把版型宣告的二進位素材複製進一個 HyperFrames Project。
 *
 *   node app/scripts/use-template.mjs 台股晨報 app/runtime-data/projects/<project-id>
 *
 * `config/templates/<版型>/` 的程式與 layout 不再複製：組裝器直接從 App 版型目錄執行，
 * Project 只保留自己的 ledger、config 與素材。這支命令只複製 layout.json 宣告的
 * png / jpg / mp3 到 `<project>/assets/`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(here, '..');

// 文字檔用行數差，二進位用位元組差 —— 只是給人看「差多少」的量級，不是 diff 工具。
const TEXT_EXT = new Set(['.json', '.mjs', '.js', '.md', '.txt']);

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function describeDiff(srcBuf, dstBuf, name) {
  if (!TEXT_EXT.has(path.extname(name))) {
    const delta = srcBuf.length - dstBuf.length;
    return `二進位，${dstBuf.length} → ${srcBuf.length} bytes（${delta >= 0 ? '+' : ''}${delta}）`;
  }
  const a = dstBuf.toString('utf8').split('\n');
  const b = srcBuf.toString('utf8').split('\n');
  let differing = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) differing += 1;
  }
  return `目標 ${a.length} 行 → 來源 ${b.length} 行，逐行比對 ${differing} 行不同`;
}

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const [templateName, projectDirArg] = argv.filter((a) => a !== '--force');
if (!templateName || !projectDirArg) {
  die('用法：node app/scripts/use-template.mjs <版型> <專案目錄> [--force]\n' +
      `   可用版型：${fs.readdirSync(path.join(APP_ROOT, 'config', 'templates')).join('、')}`);
}

const templateDir = path.join(APP_ROOT, 'config', 'templates', templateName);
const assetDir = path.join(APP_ROOT, 'assets', templateName);
const projectDir = path.resolve(projectDirArg);

if (!fs.existsSync(templateDir)) die(`找不到版型定義：${templateDir}`);
if (!fs.existsSync(projectDir)) die(`找不到專案目錄：${projectDir}`);

const layout = JSON.parse(fs.readFileSync(path.join(templateDir, 'layout.json'), 'utf8'));

const outAssets = path.join(projectDir, 'assets');
// 目錄不在這裡建 —— 被拒絕的執行必須連一個空目錄都不留下，否則「未寫入任何檔案」是騙人的。
// 建目錄移到下面真正要寫的時候。

// 先把整份計畫算完，再決定要不要動手。分兩段是刻意的：只要有一個檔會被無聲覆蓋，
// 就一個位元組都不寫 —— 寫一半再中止比不寫更難善後。
const plan = [];
const missing = [];

function stage(srcDir, name, outDir, label) {
  const src = path.join(srcDir, name);
  if (!fs.existsSync(src)) die(`版型缺檔：${src}`);
  const dst = path.join(outDir, name);
  const srcBuf = fs.readFileSync(src);
  if (!fs.existsSync(dst)) { plan.push({ src, dst, label, state: 'new' }); return; }
  const dstBuf = fs.readFileSync(dst);
  plan.push(srcBuf.equals(dstBuf)
    ? { src, dst, label, state: 'same' }
    : { src, dst, label, state: 'conflict', diff: describeDiff(srcBuf, dstBuf, name) });
}

// 只複製 layout.json 宣告過的素材 —— 資料夾裡多出來的東西不跟著跑，
// 免得某支片默默依賴一個沒有宣告的檔案。
for (const [role, file] of Object.entries(layout.assets || {})) {
  if (!fs.existsSync(path.join(assetDir, file))) { missing.push(`${role}: ${file}`); continue; }
  stage(assetDir, file, outAssets, `assets/${file}`);
}

// 內容相同就直接覆蓋、不吵，因為重跑同一個版型是常態。
// 內容不同代表 Project 素材被替換過（或版型素材變了），無聲蓋掉會丟掉別人的工作。
const conflicts = plan.filter((p) => p.state === 'conflict');
if (conflicts.length && !force) {
  console.error(`❌ ${conflicts.length} 個目標檔已存在且內容不同，未寫入任何檔案：\n`);
  for (const c of conflicts) console.error(`   ${c.label}\n      ${c.diff}`);
  console.error('\n這些檔可能是專案自己手改過的。先 diff 看清楚：\n');
  for (const c of conflicts) {
    console.error(`   diff "${c.dst}" \\\n        "${c.src}"`);
  }
  console.error(`\n確定要用版型覆蓋，加 --force：\n\n`
    + `   node app/scripts/use-template.mjs ${templateName} ${projectDirArg} --force\n\n`
    + '--force 會在覆蓋前把原檔存成 <name>.bak.<timestamp>。');
  process.exit(1);
}

const copied = [];
const backedUp = [];
for (const p of plan) {
  fs.mkdirSync(path.dirname(p.dst), { recursive: true });
  if (p.state === 'conflict') {
    const bak = `${p.dst}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(p.dst, bak);
    backedUp.push(path.relative(projectDir, bak));
  }
  fs.copyFileSync(p.src, p.dst);
  copied.push(`${p.label}${p.state === 'conflict' ? '  （覆蓋，已備份）' : p.state === 'new' ? '  （新增）' : ''}`);
}

console.log(`✅ ${templateName} → ${path.relative(process.cwd(), projectDir) || projectDir}`);
for (const c of copied) console.log(`   ${c}`);
if (backedUp.length) {
  console.log('\n覆蓋前的備份：');
  for (const b of backedUp) console.log(`   ${b}`);
}
if (missing.length) {
  console.error(`\n⚠️ layout.json 宣告了但 assets/${templateName}/ 找不到：`);
  for (const m of missing) console.error(`   ${m}`);
  process.exit(1);
}
