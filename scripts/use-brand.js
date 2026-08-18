#!/usr/bin/env node

// ─────────────────────────────────────────
//  品牌素材切換工具
//  把 assets/<品牌>/ 底下的「所有」檔案與子資料夾複製覆蓋到 public/，
//  供後續 run.js → Remotion render 使用。渲染端讀的檔名不變。
//  用法：node scripts/use-brand.js <品牌>
//
//  註：複製一律走 fs.copyFileSync。不要改用 fs.cpSync —— 它覆蓋掛載碟上
//  既有檔案時會先 truncate、再因 EACCES 失敗，留下 0 byte 壞檔。
// ─────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ASSETS_ROOT = path.join(ROOT, "assets");
const PUBLIC_DIR = path.join(ROOT, "public");
// 渲染端一定會用到的檔；品牌資料夾缺這些就先擋下來，避免後面 render 才爆。
const ESSENTIAL = ["frame.png", "outro.mp4", "bgm.wav"];
// 不該被當成素材複製過去的系統垃圾檔。
const IGNORED = new Set([".DS_Store"]);

function listBrands() {
  if (!fs.existsSync(ASSETS_ROOT)) return [];
  return fs
    .readdirSync(ASSETS_ROOT)
    .filter((d) => fs.statSync(path.join(ASSETS_ROOT, d)).isDirectory());
}

// 逐檔複製；遇到子資料夾就遞迴。只用 copyFileSync / mkdirSync。
function copyInto(src, dest) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (IGNORED.has(name)) continue;
      copyInto(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

const brands = listBrands();
const brandHint = brands.length ? brands.join(" / ") : "（無，請先在 assets/ 底下建立品牌資料夾）";

const brand = process.argv[2];
if (!brand) {
  console.error("❌ 請指定品牌。用法：node scripts/use-brand.js <品牌>");
  console.error(`   目前 assets/ 底下的品牌：${brandHint}`);
  process.exit(1);
}

const srcDir = path.join(ASSETS_ROOT, brand);
if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
  console.error(`❌ 找不到資料夾 assets/${brand}/`);
  console.error(`   目前 assets/ 底下的品牌：${brandHint}`);
  process.exit(1);
}

const entries = fs.readdirSync(srcDir).filter((name) => !IGNORED.has(name));

const missing = ESSENTIAL.filter((f) => !entries.includes(f));
if (missing.length) {
  console.error(`❌ assets/${brand}/ 缺少渲染必要檔案：${missing.join(", ")}`);
  console.error(`   每個品牌資料夾至少要有這三個檔，檔名需完全一致：${ESSENTIAL.join(", ")}`);
  process.exit(1);
}

if (entries.length === 0) {
  console.error(`❌ assets/${brand}/ 是空的，沒有東西可複製`);
  process.exit(1);
}

let count = 0;
for (const name of entries) {
  const src = path.join(srcDir, name);
  const dest = path.join(PUBLIC_DIR, name);
  const isDir = fs.statSync(src).isDirectory();
  copyInto(src, dest);
  console.log(`  ✓ assets/${brand}/${name}${isDir ? "/" : ""}  →  public/${name}${isDir ? "/" : ""}`);
  count++;
}
console.log(`✅ 已套用品牌素材：${brand}（共複製 ${count} 項）`);
