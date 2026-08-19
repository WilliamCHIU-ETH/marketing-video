#!/usr/bin/env node

// ─────────────────────────────────────────
//  焦點股日報套版素材複製工具
//  把 assets/焦點股日報/ 底下的固定檔案複製到 public/，用「focusstock-」前綴命名。
//
//  用法：node scripts/use-focusstock-assets.js
//
//  註：bgm.wav 設成「選配」——使用者可能還沒放 BGM，缺 bgm 只警告不中止，
//      讓你先把 intro-frame / header-overlay 複製過去、先預覽版面（BGM 補上後再跑一次即可）。
//  註：複製一律走 fs.copyFileSync；fs.cpSync 覆蓋掛載碟檔案時可能留下 0 byte 壞檔。
//  註：覆蓋既有 public/focusstock-* 若遇 EACCES，先 rm -f public/focusstock-* 再重跑。
// ─────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "assets", "焦點股日報");
const PUBLIC_DIR = path.join(ROOT, "public");

// 來源檔名 → public/ 目標檔名。optional=true 的缺檔只警告、不中止。
const FILES = [
  { src: "intro-frame.jpg", dest: "focusstock-intro-frame.jpg", optional: false },
  { src: "header-overlay.png", dest: "focusstock-header-overlay.png", optional: false },
  { src: "bgm.wav", dest: "focusstock-bgm.wav", optional: true },
];

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ 找不到資料夾 assets/焦點股日報/`);
  process.exit(1);
}

let count = 0;
const missingRequired = [];
// BGM 檔名容錯：使用者可能放成 BGM.mp3 / bgm.wav / Bgm.m4a。
// 只要 assets 資料夾裡有這幾種組合之一，就當作 BGM 存在並複製成 public/focusstock-bgm.<原副檔名>。
// （2026-08-12 使用者放的是 BGM.mp3，原本只找 bgm.wav 而漏掉。）
(function resolveBgm() {
  const dir = path.join(ROOT, "assets", "焦點股日報");
  if (!fs.existsSync(dir)) return;
  const found = fs
    .readdirSync(dir)
    .find((f) => /^bgm\.(wav|mp3|m4a|aac)$/i.test(f));
  if (!found) return;
  const idx = FILES.findIndex((f) => /bgm/i.test(f.src));
  const ext = path.extname(found).toLowerCase();
  const entry = { src: found, dest: "focusstock-bgm" + ext, optional: true };
  if (idx >= 0) FILES[idx] = entry;
  else FILES.push(entry);
})();

for (const { src, dest, optional } of FILES) {
  const srcPath = path.join(SRC_DIR, src);
  const destPath = path.join(PUBLIC_DIR, dest);
  if (!fs.existsSync(srcPath)) {
    if (optional) {
      console.warn(`⚠️  assets/焦點股日報/${src} 還沒放（選配）→ 跳過。補上後再跑一次此指令即可。`);
    } else {
      missingRequired.push(src);
    }
    continue;
  }
  const size = fs.statSync(srcPath).size;
  if (size === 0) {
    console.warn(`⚠️  assets/焦點股日報/${src} 是 0 byte（可能上傳/同步沒完成），仍會複製但目標檔也會是壞檔`);
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ assets/焦點股日報/${src}  →  public/${dest}（${size} bytes）`);
  count++;
}

if (missingRequired.length) {
  console.error(`❌ assets/焦點股日報/ 缺少必要檔案：${missingRequired.join(", ")}`);
  process.exit(1);
}

// BGM 是選配。把「這次到底有沒有 BGM」寫成旗標，讓 composition 決定要不要掛音軌——
// 否則 Remotion 會去抓不存在的 focusstock-bgm.wav 而整個 render 失敗（2026-08-12 實際踩到）。
const bgmExists = fs
  .readdirSync(PUBLIC_DIR)
  .some((f) => /^focusstock-bgm\.(wav|mp3|m4a|aac)$/i.test(f));
const bgmFile = fs
  .readdirSync(PUBLIC_DIR)
  .find((f) => /^focusstock-bgm\.(wav|mp3|m4a|aac)$/i.test(f));
const flagPath = path.join(ROOT, "src", "Focusstock", "focusstock-assets.generated.json");
fs.writeFileSync(flagPath, JSON.stringify({ hasBgm: bgmExists, bgmFile: bgmFile || null }, null, 2));
console.log(`  ↳ BGM 旗標：hasBgm=${bgmExists}${bgmExists ? "" : "（沒放 BGM，出片時自動不掛音軌）"}`);

console.log(`✅ 焦點股日報套版素材已複製（共 ${count} 項）`);
