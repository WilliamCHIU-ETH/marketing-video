#!/usr/bin/env node
/**
 * 把版型層複製進一個 HyperFrames 專案。
 *
 *   node app/scripts/use-template.mjs 台股晨報 app/runtime-data/projects/<project-id>
 *
 * 複製兩種東西，來源不同、理由不同：
 *
 *   config/templates/<版型>/   → <project>/template/   版位定義與 header 片段。
 *                                                      納版控，因為它是會飄的那一半。
 *   assets/<版型>/             → <project>/assets/     png / jpg / mp3。
 *                                                      不納版控（assets 是 symlink → ../data/assets），
 *                                                      因為是二進位素材。
 *
 * 複製而不是共用參照，是刻意的：HyperFrames 專案自我完備才能兩個 session 同時 render。
 * 代價是複製之後會各自演化 —— 但因為來源在版控裡，`diff` 就看得出誰改了什麼，
 * 這正是現在缺的（header 抄了三次、飄了兩次，沒有任何地方看得出來）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(here, '..');

const TEMPLATE_FILES = ['layout.json', 'header.mjs'];

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const [templateName, projectDirArg] = process.argv.slice(2);
if (!templateName || !projectDirArg) {
  die('用法：node app/scripts/use-template.mjs <版型> <專案目錄>\n' +
      `   可用版型：${fs.readdirSync(path.join(APP_ROOT, 'config', 'templates')).join('、')}`);
}

const templateDir = path.join(APP_ROOT, 'config', 'templates', templateName);
const assetDir = path.join(APP_ROOT, 'assets', templateName);
const projectDir = path.resolve(projectDirArg);

if (!fs.existsSync(templateDir)) die(`找不到版型定義：${templateDir}`);
if (!fs.existsSync(projectDir)) die(`找不到專案目錄：${projectDir}`);

const layout = JSON.parse(fs.readFileSync(path.join(templateDir, 'layout.json'), 'utf8'));

const outTemplate = path.join(projectDir, 'template');
const outAssets = path.join(projectDir, 'assets');
fs.mkdirSync(outTemplate, { recursive: true });
fs.mkdirSync(outAssets, { recursive: true });

const copied = [];
for (const name of TEMPLATE_FILES) {
  const src = path.join(templateDir, name);
  if (!fs.existsSync(src)) die(`版型缺檔：${src}`);
  fs.copyFileSync(src, path.join(outTemplate, name));
  copied.push(`template/${name}`);
}

// 只複製 layout.json 宣告過的素材 —— 資料夾裡多出來的東西不跟著跑，
// 免得某支片默默依賴一個沒有宣告的檔案。
const missing = [];
for (const [role, file] of Object.entries(layout.assets || {})) {
  const src = path.join(assetDir, file);
  if (!fs.existsSync(src)) { missing.push(`${role}: ${file}`); continue; }
  fs.copyFileSync(src, path.join(outAssets, file));
  copied.push(`assets/${file}`);
}

console.log(`✅ ${templateName} → ${path.relative(process.cwd(), projectDir) || projectDir}`);
for (const c of copied) console.log(`   ${c}`);
if (missing.length) {
  console.error(`\n⚠️ layout.json 宣告了但 assets/${templateName}/ 找不到：`);
  for (const m of missing) console.error(`   ${m}`);
  process.exit(1);
}
