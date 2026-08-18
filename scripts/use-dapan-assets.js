#!/usr/bin/env node

// ─────────────────────────────────────────
//  大盤小報套版素材複製工具
//  把 assets/大盤小報/ 底下的固定檔案複製到 public/，用「dapan-」前綴命名，
//  避免跟現有品牌切換系統（use-brand.js 複製進 public/frame.png 等泛用檔名）撞名。
//  大盤小報目前只有一套固定樣式，不像 起漲K線／籌碼K線 需要在多個品牌間切換，
//  所以不走 use-brand.js 那套「互換」邏輯，直接做固定的一對一複製。
//
//  用法：node scripts/use-dapan-assets.js
//
//  註：複製一律走 fs.copyFileSync。不要改用 fs.cpSync —— 它覆蓋掛載碟上
//  既有檔案時會先 truncate、再因 EACCES 失敗，留下 0 byte 壞檔（見 docs/tasks.md 第 5 節雷區）。
// ─────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "assets", "大盤小報");
const PUBLIC_DIR = path.join(ROOT, "public");

// 來源檔名 → public/ 目標檔名（固定對應，不是泛用契約）
const FILE_MAP = {
  "intro-frame.jpg": "dapan-intro-frame.jpg",
  "header-overlay.png": "dapan-header-overlay.png",
  "bgm.wav": "dapan-bgm.wav",
  // 橫式版（DapanXiaobaoLandscape）用的 16:9 常駐品牌面板（1920×1080 RGBA、左側透明）
  "intro-frame_Horizontal.png": "dapan-intro-frame-horizontal.png",
};

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ 找不到資料夾 assets/大盤小報/`);
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
  if (size === 0) {
    console.warn(`⚠️  assets/大盤小報/${srcName} 是 0 byte（可能上傳/同步沒完成），仍會複製但目標檔也會是壞檔`);
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ assets/大盤小報/${srcName}  →  public/${destName}（${size} bytes）`);
  count++;
}

if (missing.length) {
  console.error(`❌ assets/大盤小報/ 缺少檔案：${missing.join(", ")}`);
  process.exit(1);
}

console.log(`✅ 大盤小報套版素材已複製（共 ${count} 項）`);
