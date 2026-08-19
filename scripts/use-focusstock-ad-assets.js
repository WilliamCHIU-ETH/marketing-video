#!/usr/bin/env node

// ─────────────────────────────────────────
//  焦點股日報「投廣套框版」素材複製工具
//  把籌碼K線品牌素材複製到 public/，給 FocusstockAd composition 用：
//    assets/籌碼K線/frame.png → public/focusstock-ad-frame.png（品牌外框）
//    assets/籌碼K線/outro.mp4 → public/outro.mp4（片尾 CTA；用標準檔名讓 transcribe 量秒數）
//    assets/籌碼K線/bgm.wav   → public/focusstock-ad-bgm.wav（投廣版 BGM）
//
//  用法：node scripts/use-focusstock-ad-assets.js
//  註：outro 要用 public/outro.mp4 這個標準名，transcribe.sh 才會偵測它、寫進
//      video-meta.outroDurationSec，FocusstockAd 的時長才會含片尾。此步驟要在 transcribe 之前跑。
//  註：複製一律走 fs.copyFileSync；fs.cpSync 覆蓋掛載碟檔案時可能留下 0 byte 壞檔。
// ─────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "assets", "籌碼K線");
const PUBLIC_DIR = path.join(ROOT, "public");

const FILE_MAP = {
  "frame.png": "focusstock-ad-frame.png",
  "outro.mp4": "outro.mp4",
  "bgm.wav": "focusstock-ad-bgm.wav",
};

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ 找不到資料夾 assets/籌碼K線/`);
  process.exit(1);
}

let count = 0;
const missing = [];
for (const [srcName, destName] of Object.entries(FILE_MAP)) {
  const srcPath = path.join(SRC_DIR, srcName);
  const destPath = path.join(PUBLIC_DIR, destName);
  if (!fs.existsSync(srcPath)) {
    missing.push(srcName);
    continue;
  }
  const size = fs.statSync(srcPath).size;
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ assets/籌碼K線/${srcName}  →  public/${destName}（${size} bytes）`);
  count++;
}

if (missing.length) {
  console.error(`❌ assets/籌碼K線/ 缺少檔案：${missing.join(", ")}`);
  process.exit(1);
}

console.log(`✅ 焦點股投廣套框素材已複製（共 ${count} 項）`);
