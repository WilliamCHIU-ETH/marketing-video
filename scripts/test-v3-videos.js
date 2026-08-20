#!/usr/bin/env node
/**
 * RETIRED: historical payload experiment only; execution is blocked before provider access.
 * Use run.js with explicit identity and --dry-run instead.
 *
 * 一次性測試：POST /v3/videos（Avatar IV 是 v3 的預設引擎）。
 * 專門用來驗「斷句」有沒有改善 —— 同一段腳本，可開關 <break> 標籤與 voice_settings。
 *
 * ⚠️ 會消耗 HeyGen 額度，請「手動」執行（Claude 不會自動跑）。
 * 完全獨立，不碰 run.js / public/heygen.mp4 / pipeline。
 *
 * 歷史用法（現已停用）：
 *   node scripts/test-v3-videos.js                    # 用下面 CONFIG 的預設
 *   TEXT="要唸的字" node scripts/test-v3-videos.js
 *   SPEED=0.95 LOCALE=zh-TW node scripts/test-v3-videos.js
 *   NO_BREAK=1 node scripts/test-v3-videos.js         # 拿掉 <break>，跟有 break 的版本 A/B 對照
 *
 * 建議測法：先跑一次 NO_BREAK=1 當基準，再跑一次帶 break 的，兩支並排聽。
 */

require('./retired-paid-provider-script').stopRetiredPaidProviderScript('test-v3-videos.js');

const fs = require("fs");
const path = require("path");
try { require("dotenv").config(); } catch (_) {}

// ✏️ ============ 改這裡 ============
const CONFIG = {
  AVATAR_ID: "7765f68aaa6a4b658b95f4e5357c21d5", // 焦點股日報主播
  VOICE_ID: "65b04effe83f423dbb1f66317318c37f",  // 焦點股日報中文女聲
  // 這段就是 2026-08-17 唸壞的那句。<break> 插在三個被切錯的詞前後。
  TEXT:
    '大盤在四萬六千點附近震盪！<break time="0.3s"/>' +
    '但貨櫃三雄<break time="0.2s"/>萬海漲停、<break time="0.2s"/>長榮陽明漲逾百分之五，' +
    '<break time="0.3s"/>為什麼今天漲？還能追嗎？',
};
// =================================

const API_KEY = (process.env.HEYGEN_API_KEY || "").trim();
const AVATAR_ID = process.env.AVATAR_ID || CONFIG.AVATAR_ID;
const VOICE_ID = process.env.VOICE_ID || CONFIG.VOICE_ID;
const NO_BREAK = !!process.env.NO_BREAK;
const TEXT_RAW = process.env.TEXT || CONFIG.TEXT;
const TEXT = NO_BREAK ? TEXT_RAW.replace(/<break[^>]*\/>/gi, "") : TEXT_RAW;

const SPEED = process.env.SPEED ? Number(process.env.SPEED) : null;   // 0.5–1.5
const PITCH = process.env.PITCH ? Number(process.env.PITCH) : null;   // -50–+50
const LOCALE = process.env.LOCALE || null;                            // 例 zh-TW（先確認 support_locale）
const EXPRESSIVENESS = process.env.EXPRESSIVENESS || "medium";        // high / medium / low（預設 low）
const ASPECT = process.env.ASPECT || "9:16";
const RESOLUTION = process.env.RESOLUTION || "1080p";
const MOTION_PROMPT =
  process.env.MOTION_PROMPT ||
  "站姿自然，雙手在胸前或身側做出適度自然的手勢，配合語氣比劃，不要十指交握不動";
const OUT = path.resolve(
  process.env.OUT || `./v3-test-${NO_BREAK ? "nobreak" : "break"}.mp4`
);

const log = (...a) => console.log("›", ...a);
const die = (m) => { console.error("❌", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!API_KEY) die("缺少 HEYGEN_API_KEY（.env）");

  const voice_settings = {};
  if (SPEED !== null) voice_settings.speed = SPEED;
  if (PITCH !== null) voice_settings.pitch = PITCH;
  if (LOCALE) voice_settings.locale = LOCALE;

  const payload = {
    type: "avatar",
    avatar_id: AVATAR_ID,
    script: TEXT,
    voice_id: VOICE_ID,
    motion_prompt: MOTION_PROMPT,
    expressiveness: EXPRESSIVENESS,
    aspect_ratio: ASPECT,
    resolution: RESOLUTION,
    engine: { type: "avatar_iv" }, // 省略也是 Avatar IV，這裡明示避免日後預設換掉
    title: `v3-test-${NO_BREAK ? "nobreak" : "break"}`,
  };
  if (Object.keys(voice_settings).length) payload.voice_settings = voice_settings;

  log("送出 payload：\n" + JSON.stringify(payload, null, 2));

  const res = await fetch("https://api.heygen.com/v3/videos", {
    method: "POST",
    headers: { "X-Api-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const created = await res.json().catch(() => null);
  log("建立回應：", JSON.stringify(created, null, 2));

  const videoId = created?.data?.video_id || created?.data?.id;
  if (!res.ok || !videoId) die(`建立失敗（HTTP ${res.status}），看上面回應`);
  log(`video_id = ${videoId}，開始輪詢 GET /v3/videos/${videoId} ...`);

  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    const sres = await fetch(`https://api.heygen.com/v3/videos/${videoId}`, {
      headers: { "X-Api-Key": API_KEY },
    });
    const sdata = await sres.json().catch(() => null);
    const d = sdata?.data || sdata || {};

    if (i === 0) log("首次狀態 raw：\n" + JSON.stringify(sdata, null, 2));

    if (d.failure_code || d.failure_message) {
      console.error(JSON.stringify(sdata, null, 2));
      die(`生成失敗：${d.failure_code || ""} ${d.failure_message || ""}`);
    }

    const status = d.status || d.state || (d.video_url ? "completed" : "processing");
    log(`  [${i + 1}] status = ${status}`);

    if (d.video_url) {
      const vres = await fetch(d.video_url);
      if (!vres.ok) die(`下載失敗 HTTP ${vres.status}`);
      fs.writeFileSync(OUT, Buffer.from(await vres.arrayBuffer()));
      log(`✅ 已存檔 → ${OUT}（時長 ${d.duration ?? "?"} 秒）`);
      if (d.subtitle_url) log(`   順便：HeyGen 也產了字幕檔 ${d.subtitle_url}`);
      if (d.video_page_url) log(`   後台頁面：${d.video_page_url}`);
      return;
    }
  }
  die("輪詢超時（15 分鐘）");
}

main().catch((e) => die(e.stack || e.message));
