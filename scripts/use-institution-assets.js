#!/usr/bin/env node

// ─────────────────────────────────────────
//  三大法人套版素材複製工具
//  把 assets/三大法人/ 底下的固定檔案複製到 public/，用「institution-」前綴命名，
//  跟大盤小報（dapan-）／品牌切換（frame.png 等）互不撞名。
//
//  用法：node scripts/use-institution-assets.js
//
//  註：複製一律走 fs.copyFileSync；fs.cpSync 覆蓋掛載碟檔案時可能留下 0 byte 壞檔。
//  註：若覆蓋既有 public/institution-* 遇到 EACCES（掛載碟/唯讀），先 rm -f public/institution-* 再重跑。
// ─────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "assets", "三大法人");
const PUBLIC_DIR = path.join(ROOT, "public");

// 來源檔名 → public/ 目標檔名（固定對應）
const FILE_MAP = {
  "intro-frame.jpg": "institution-intro-frame.jpg",
  "header-overlay.png": "institution-header-overlay.png",
  "bgm.wav": "institution-bgm.wav",
};

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ 找不到資料夾 assets/三大法人/`);
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
    console.warn(`⚠️  assets/三大法人/${srcName} 是 0 byte（可能上傳/同步沒完成），仍會複製但目標檔也會是壞檔`);
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ assets/三大法人/${srcName}  →  public/${destName}（${size} bytes）`);
  count++;
}

if (missing.length) {
  console.error(`❌ assets/三大法人/ 缺少檔案：${missing.join(", ")}`);
  process.exit(1);
}

console.log(`✅ 三大法人套版素材已複製（共 ${count} 項）`);
