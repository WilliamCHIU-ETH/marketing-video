#!/usr/bin/env node

// ─────────────────────────────────────────
//  iOS 模擬器功能截圖工具
//  把 iOS 模擬器目前畫面截圖，存成 public/<shot 名稱>.png，
//  檔名 = script.txt 裡的 (shot:名稱) 標記名，供 parse-script 對應。
//  ⚠️ 需在 macOS、已安裝 Xcode、且模擬器已啟動 App 的情況下執行。
//
//  用法：
//    node scripts/shot.js                  列出 public/script.txt 需要的截圖
//    node scripts/shot.js "<名稱>"          截目前模擬器畫面 → public/<名稱>.png
//    node scripts/shot.js "<名稱>" --open   先用 deeplink 跳該畫面再截（實驗性）
//    node scripts/shot.js --all            依 script.txt 逐一引導截圖
// ─────────────────────────────────────────

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SCRIPT_TXT = path.join(PUBLIC_DIR, "script.txt");
const DEEPLINKS = path.join(ROOT, "assets", "起漲K線", "deeplinks.json");

// 與 parse-script.js 的 shotPattern 一致：名稱不含 ( ) :，opts 為 [a-z0-9,=]
const shotTagPattern = /\(shot:([^():]+)(?::[a-z0-9,=]+)?\)/g;

function shotsInScript() {
  if (!fs.existsSync(SCRIPT_TXT)) return [];
  const txt = fs.readFileSync(SCRIPT_TXT, "utf8");
  const names = [];
  for (const m of txt.matchAll(shotTagPattern)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function loadDeeplinks() {
  if (!fs.existsSync(DEEPLINKS)) return {};
  try {
    return JSON.parse(fs.readFileSync(DEEPLINKS, "utf8")).shots || {};
  } catch {
    return {};
  }
}

function ensureBooted() {
  let out = "";
  try {
    out = execFileSync("xcrun", ["simctl", "list", "devices", "booted"], {
      encoding: "utf8",
    });
  } catch {
    console.error("❌ 無法執行 xcrun simctl —— 請確認在 macOS 且已安裝 Xcode。");
    process.exit(1);
  }
  if (!/\(Booted\)/.test(out)) {
    console.error("❌ 沒有已啟動的 iOS 模擬器。請先在 Xcode 把 App run 起來。");
    process.exit(1);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForEnter(msg) {
  process.stdout.write(msg);
  try {
    fs.readSync(0, Buffer.alloc(256), 0, 256, null);
  } catch {
    // 非互動環境（無 stdin）直接略過
  }
}

function capture(name) {
  const dest = path.join(PUBLIC_DIR, name + ".png");
  execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", dest]);
  cropContent(dest);
  console.log(`  ✓ 已截圖  →  public/${name}.png`);
}

// 裁掉 iPhone 17 模擬器原圖(1206×2622)的上方動態島區 + 下方 tab bar，
// 讓 PIP 疊圖只剩淨內容(1206×2162)。
// TOP_CROP=210 才能完整清掉 iPhone 17 動態島；140 只裁掉 status bar、會殘留動態島暗塊。
// 非 iPhone 17 尺寸的截圖自動跳過裁切(保留原圖)。
function cropContent(filePath) {
  const TOP_CROP = 210;
  const BOTTOM_CROP = 250;
  const EXPECTED_W = 1206;
  const EXPECTED_H = 2622;

  let dims;
  try {
    const out = execFileSync(
      "sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", filePath],
      { encoding: "utf8" }
    );
    const wMatch = out.match(/pixelWidth:\s*(\d+)/);
    const hMatch = out.match(/pixelHeight:\s*(\d+)/);
    if (!wMatch || !hMatch) throw new Error("sips 沒回傳尺寸");
    dims = { w: parseInt(wMatch[1], 10), h: parseInt(hMatch[1], 10) };
  } catch (e) {
    console.log(`  ⚠️  讀取截圖尺寸失敗(${e.message})，跳過裁切`);
    return;
  }

  if (dims.w !== EXPECTED_W || dims.h !== EXPECTED_H) {
    console.log(
      `  ⚠️  截圖尺寸 ${dims.w}×${dims.h} 非 iPhone 17(${EXPECTED_W}×${EXPECTED_H})，跳過裁切`
    );
    return;
  }

  const newH = dims.h - TOP_CROP - BOTTOM_CROP;
  const tmp = filePath + ".tmp.png";
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel", "error",
        "-i", filePath,
        "-vf", `crop=${dims.w}:${newH}:0:${TOP_CROP}`,
        tmp,
      ]
    );
    fs.renameSync(tmp, filePath);
    console.log(`  ✂️  已裁切 → ${dims.w}×${newH}(去 status bar 與 tab bar)`);
  } catch (e) {
    console.log(`  ⚠️  ffmpeg 裁切失敗(${e.message})，保留原圖`);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function openDeeplink(name) {
  const url = loadDeeplinks()[name];
  if (!url) {
    console.error(
      `❌ deeplinks.json 沒有「${name}」，無法 --open。請手動導航後不加 --open 再截。`
    );
    process.exit(1);
  }
  // deeplinks.json 存的是 https universal link（CMoney 正式 prod URL），
  // 但 simulator 不認 AASA universal link 驗證（詳見 docs/tasks.md 第 5 節雷區）。
  // 替換成 SuperTrendK 專案 DEBUG-only AppDelegate 攔截的 custom URL scheme。
  const simUrl = url.replace(
    /^https:\/\/www\.cmoney\.tw\//,
    "CMoney.SuperTrendK://"
  );
  console.log(`  → 開啟 deeplink：${simUrl}`);
  execFileSync("xcrun", ["simctl", "openurl", "booted", simUrl]);
}

function printList() {
  const shots = shotsInScript();
  const deep = loadDeeplinks();
  if (shots.length === 0) {
    console.log("public/script.txt 裡沒有 (shot:...) 標記。");
    return;
  }
  console.log("目前 public/script.txt 需要的功能截圖：\n");
  for (const s of shots) {
    const tag = deep[s] ? "deeplink ✓" : "deeplink ✗（需手動導航）";
    console.log(`  • ${s}\n    → public/${s}.png   [${tag}]`);
  }
  console.log('\n截單張： node scripts/shot.js "<名稱>"');
  console.log("逐一引導：node scripts/shot.js --all");
}

function main() {
  const args = process.argv.slice(2);
  const useOpen = args.includes("--open");
  const all = args.includes("--all");
  const name = args.find((a) => !a.startsWith("--"));

  if (all) {
    const shots = shotsInScript();
    if (shots.length === 0) {
      console.error("❌ public/script.txt 裡沒有 (shot:...) 標記。");
      process.exit(1);
    }
    ensureBooted();
    console.log(
      `共 ${shots.length} 張要截。每張請先在模擬器導航到該畫面，再按 Enter。\n`
    );
    for (const s of shots) {
      waitForEnter(`導航到「${s}」後按 Enter 截圖… `);
      capture(s);
    }
    console.log(`\n✅ 完成 ${shots.length} 張，已存進 public/。`);
    console.log("建議接著跑 npm run parse-script 確認對應。");
    return;
  }

  if (!name) {
    printList();
    return;
  }

  ensureBooted();
  if (!shotsInScript().includes(name)) {
    console.log(
      `  ⚠️  public/script.txt 裡目前沒有 (shot:${name}) 標記，截圖仍會存。`
    );
  }
  if (useOpen) {
    openDeeplink(name);
    console.log("  → 等畫面載入 3 秒…");
    sleep(3000);
  }
  capture(name);
  console.log("\n✅ 完成。建議接著跑 npm run parse-script 確認對應。");
}

main();
