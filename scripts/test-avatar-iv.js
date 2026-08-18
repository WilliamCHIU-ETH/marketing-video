#!/usr/bin/env node
/**
 * 一次性測試：用 HeyGen 專用 Avatar IV 端點 (POST /v2/videos) + motion_prompt
 * 驗證「手會不會動」。完全獨立，不碰 run.js / pipeline / public/heygen.mp4。
 *
 * ⚠️ 會消耗 HeyGen 額度，請「手動」執行（Claude 不會自動跑）。
 *
 * 必填 env：
 *   HEYGEN_API_KEY=...                      （沿用 .env 那把）
 *
 * 人物來源（擇一）：
 *   AVATAR_ID=<talking_photo_id 或 avatar_id>   沿用你現有 avatar，最省事，先試這個
 *   IMAGE=/path/to/photo.jpg                    上傳新圖 → image_asset_id（avatar_id 不被接受時用）
 *
 * 聲音來源（擇一）：
 *   AUDIO=/path/to/voice.mp3                    audio-driven，貼近你現在的 MiniMax 流程
 *   TEXT="要講的字" VOICE_ID=<HeyGen voice_id>   讓 HeyGen 自己 TTS，依賴最少
 *
 * 可調（都有預設）：
 *   MOTION_PROMPT  預設「站姿自然，雙手在桌上做出明顯而自然的手勢，配合語氣比劃」
 *   EXPRESSIVENESS 預設 high            （low / medium / high；僅 photo avatar）
 *   ASPECT         預設 9:16            （16:9 / 9:16）
 *   RESOLUTION     預設 1080p           （720p / 1080p）
 *   TITLE          預設 avatar-iv-test
 *   OUT            預設 ./avatar-iv-test.mp4
 *
 * 範例：
 *   HEYGEN_API_KEY=xxx AVATAR_ID=abc123 TEXT="大家好，今天來聊台股的散熱題材" VOICE_ID=zh-CN-xxx \
 *     node scripts/test-avatar-iv.js
 *
 *   HEYGEN_API_KEY=xxx IMAGE=./woman.jpg AUDIO=./voice.mp3 \
 *     node scripts/test-avatar-iv.js
 */

const fs = require("fs");
const path = require("path");
try { require("dotenv").config(); } catch (_) {} // 自動讀 .env（跟 run.js 一樣，拿 HEYGEN_API_KEY）

// ✏️ ============ 改這裡：填你要測的值 ============
const CONFIG = {
  AVATAR_ID: "7d1350a04146452cb56bc2d2794ef6ac", // ← 同事那個「手會動」的 avatar id
  TEXT: "大家好，今天來聊台股的散熱題材", // ←（沒用到，因為下面填了 AUDIO）
  VOICE_ID: "",    // ←（沒用到）
  AUDIO: "./.dual-tmp/seg-2-B.mp3", // ← 現成 4.6 秒短配音，省額度、不用 voice_id
  IMAGE: "",       // ← 或：要上傳的新照片路徑（填了這個就取代 AVATAR_ID）
};
// ==============================================

const pick = (k) => {
  const v = process.env[k] ?? CONFIG[k] ?? "";
  return typeof v === "string" ? v.trim() : v;
};

const API_KEY = (process.env.HEYGEN_API_KEY || "").trim();
const AVATAR_ID = pick("AVATAR_ID");
const IMAGE = pick("IMAGE");
const AUDIO = pick("AUDIO");
const TEXT = pick("TEXT");
const VOICE_ID = pick("VOICE_ID");

const MOTION_PROMPT =
  process.env.MOTION_PROMPT ||
  "站姿自然，雙手在桌上做出明顯而自然的手勢，配合語氣比劃";
const EXPRESSIVENESS = process.env.EXPRESSIVENESS || "high";
const ASPECT = process.env.ASPECT || "9:16";
const RESOLUTION = process.env.RESOLUTION || "1080p";
const TITLE = process.env.TITLE || "avatar-iv-test";
const OUT = path.resolve(process.env.OUT || "./avatar-iv-test.mp4");

const log = (...a) => console.log("›", ...a);
const die = (msg) => {
  console.error("❌", msg);
  process.exit(1);
};

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

async function uploadAsset(filePath) {
  if (!fs.existsSync(filePath)) die(`找不到檔案：${filePath}`);
  const buf = fs.readFileSync(filePath);
  const ct = contentTypeFor(filePath);
  log(`上傳 ${path.basename(filePath)}（${ct}, ${buf.length} bytes）...`);
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-Api-Key": API_KEY, "Content-Type": ct },
    body: buf,
  });
  const data = await res.json();
  const id =
    data?.data?.id || data?.data?.asset_id || data?.data?.image_key;
  if (!res.ok || !id) {
    console.error("上傳回應：", JSON.stringify(data, null, 2));
    die("資產上傳失敗");
  }
  log(`上傳完成 → ${id}`);
  return id;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) die(`下載失敗 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`已存檔 → ${dest}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!API_KEY) die("缺少 HEYGEN_API_KEY");
  if (!AVATAR_ID && !IMAGE) die("人物來源缺：請給 AVATAR_ID 或 IMAGE");
  if (!AUDIO && !(TEXT && VOICE_ID))
    die("聲音來源缺：請給 AUDIO，或同時給 TEXT 與 VOICE_ID");

  // ── 組 payload ──
  const payload = {
    title: TITLE,
    motion_prompt: MOTION_PROMPT, // 僅 photo avatar 有效，控制身體/手部動作
    expressiveness: EXPRESSIVENESS, // 僅 photo avatar 有效
    aspect_ratio: ASPECT,
    resolution: RESOLUTION,
  };

  // 人物：avatar_id 與 image_asset_id 互斥
  if (AVATAR_ID) {
    payload.avatar_id = AVATAR_ID;
  } else {
    payload.image_asset_id = await uploadAsset(IMAGE);
  }

  // 聲音：audio_asset_id 與 (script + voice_id) 互斥
  if (AUDIO) {
    payload.audio_asset_id = await uploadAsset(AUDIO);
  } else {
    payload.script = TEXT;
    payload.voice_id = VOICE_ID;
  }

  log("送出 payload：", JSON.stringify(payload, null, 2));

  const res = await fetch("https://api.heygen.com/v2/videos", {
    method: "POST",
    headers: { "X-Api-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const created = await res.json();
  log("建立回應：", JSON.stringify(created, null, 2));

  const videoId =
    created?.data?.video_id || created?.video_id || created?.data?.id;
  if (!res.ok || !videoId) die("建立影片失敗（看上面回應）");
  log(`video_id = ${videoId}，開始輪詢...`);

  // ── 輪詢 GET /v2/videos/{video_id} ──
  // 注意：此端點回應 schema 未 100% 證實。首跑會印出完整 raw，
  // 若解析不到 status / video_url，把 raw 貼回來給 Claude 調欄位。
  let printedRaw = false;
  for (let i = 0; i < 90; i++) {
    await sleep(10000); // 每 10 秒
    const sres = await fetch(
      `https://api.heygen.com/v2/videos/${videoId}`,
      { headers: { "X-Api-Key": API_KEY } }
    );
    const sdata = await sres.json();
    if (!printedRaw) {
      log("首次狀態 raw：", JSON.stringify(sdata, null, 2));
      printedRaw = true;
    }

    const d = sdata?.data || sdata;
    const status = d?.status || d?.state;
    const url =
      d?.video_url || d?.url || d?.video_url_caption || d?.output?.video_url;
    log(`  [${i + 1}] status = ${status || "(未知，看 raw)"}`);

    if (["completed", "success", "done", "ready"].includes(String(status))) {
      if (!url) {
        log("狀態完成但找不到 video_url，完整回應：");
        console.log(JSON.stringify(sdata, null, 2));
        die("解析不到下載連結，請把上面 raw 貼回來");
      }
      await download(url, OUT);
      log("✅ 完成！打開檢查：①手有沒有動 ②HeyGen UI 是否標 Avatar IV");
      return;
    }
    if (["failed", "error"].includes(String(status))) {
      console.error(JSON.stringify(sdata, null, 2));
      die("HeyGen 生成失敗（看上面回應）");
    }
  }
  die("輪詢超時（15 分鐘）");
}

main().catch((e) => die(e.stack || e.message));
