#!/usr/bin/env node

// ─────────────────────────────────────────
//  雙人 Avatar IV 切換鏡頭模式 ── 一次性驗證腳本
//  RETIRED：只保留歷史 source；provider access 前會固定停止。請改用 run.js --dry-run。
//
//  歷史用法（現已停用）：node scripts/verify-dual.js
//
//  目的：驗證「切段 + N × MiniMax + N × HeyGen + ffmpeg concat」整條路徑
//        不會動 run.js、不會跑後製鏈、輸出到 public/heygen-dual-verify.mp4
//
//  驗證點：
//    ① 段間銜接是否自然（要不要 trim 頭尾靜止秒數？）
//    ② Whisper transcribe 拼好的 mp4 是否正確（先肉眼看，要驗就跑 npm run transcribe）
//    ③ HeyGen 4 段平行 call 會不會被擋（rate limit）
//
//  成本估算：4 段 MiniMax (~0.05 RMB) + 4 段 HeyGen（單支 ~$0.3-0.5；4 段約 $1-2）
// ─────────────────────────────────────────

require('./retired-paid-provider-script').stopRetiredPaidProviderScript('verify-dual.js');

require("dotenv").config();

const { execSync } = require("child_process");
const {
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} = require("fs");
const { resolve } = require("path");
const OpenCC = require("opencc-js");

const PROJECT_DIR = resolve(__dirname, "..");
const tradToSimpConverter = OpenCC.Converter({ from: "t", to: "s" });

// ── 設定 ──────────────────────────────────
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID;

// 第 1 對配對（要換對改這裡即可）
const TALKING_PHOTO = {
  A: "ba346ffd318d4b779dd9d6b872a09789",
  B: "28178c70220c49e1b5b6bddb08c466b9",
};

const VOICE = {
  A: "moss_audio_3a75102e-54db-11f1-981b-8a143315d498",
  B: "moss_audio_44ce6b04-5a39-11f1-981b-8a143315d498",
};

const MINIMAX_MODEL = "speech-02-hd";

// 驗證腳本：4 段 A/B 對話
const SEGMENTS = [
  { role: "A", text: "欸！會不會全市場...只剩你還不知道？" },
  { role: "B", text: "知道什麼啦？" },
  { role: "A", text: "這次台積電技術論壇，最重要的關鍵字是什麼？請回答！" },
  { role: "B", text: "不！知！道！" },
];

// ── 工具 ──────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) =>
  console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}`);

// ── MiniMax T2A ───────────────────────────
async function minimaxTTS(text, voiceId) {
  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${MINIMAX_GROUP_ID}`;
  const payload = {
    model: MINIMAX_MODEL,
    text,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
      emotion: "neutral",
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
    output_format: "hex",
    stream: false,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.data?.audio) {
    console.error("MiniMax 回應：", JSON.stringify(data, null, 2));
    throw new Error("MiniMax T2A 失敗");
  }
  return Buffer.from(data.data.audio, "hex");
}

// ── HeyGen upload audio ───────────────────
async function heygenUpload(audioBuffer) {
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "audio/mpeg",
    },
    body: audioBuffer,
  });
  const data = await res.json();
  const assetId = data?.data?.id || data?.data?.asset_id;
  if (!res.ok || !assetId) {
    console.error("HeyGen upload 回應：", JSON.stringify(data, null, 2));
    throw new Error("HeyGen 音檔上傳失敗");
  }
  return assetId;
}

// ── HeyGen generate video ─────────────────
async function heygenGenerate(audioAssetId, talkingPhotoId) {
  const payload = {
    video_inputs: [
      {
        character: {
          type: "talking_photo",
          talking_photo_id: talkingPhotoId,
        },
        voice: {
          type: "audio",
          audio_asset_id: audioAssetId,
        },
      },
    ],
    dimension: { width: 1080, height: 1920 },
    // 跟 run.js 用同一組 Avatar IV 設定，方便對比品質
    use_avatar_iv_model: true,
    expressiveness: "High",
    custom_motion_prompt: "手勢自然配合語氣",
    enhance_custom_motion_prompt: true,
  };
  const res = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.data?.video_id) {
    console.error("HeyGen 回應：", JSON.stringify(data, null, 2));
    throw new Error("HeyGen 建立影片失敗");
  }
  return data.data.video_id;
}

// ── HeyGen poll ───────────────────────────
async function heygenPoll(videoId, label) {
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const res = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { "X-Api-Key": HEYGEN_API_KEY } }
    );
    const data = await res.json();
    const status = data.data?.status;
    const progress = data.data?.progress ?? "?";
    process.stdout.write(`\r  [${label}] 狀態：${status} 進度：${progress}%   `);
    if (status === "completed") {
      console.log("");
      return data.data.video_url;
    }
    if (status === "failed") {
      throw new Error(`HeyGen 失敗（${label}）：${JSON.stringify(data)}`);
    }
  }
  throw new Error(`HeyGen 超時（${label}，10 分鐘）`);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗：${res.status}`);
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
}

// ── 主流程 ────────────────────────────────
async function main() {
  if (!HEYGEN_API_KEY) {
    console.error("❌ 缺少 HEYGEN_API_KEY（請填到 .env）");
    process.exit(1);
  }
  if (!MINIMAX_API_KEY || !MINIMAX_GROUP_ID) {
    console.error("❌ 缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID（請填到 .env）");
    process.exit(1);
  }

  // 暫存目錄
  const tmpDir = resolve(PROJECT_DIR, ".verify-dual-tmp");

  // 快取機制：偵測既有段檔 → 跳過 HeyGen 重 call、只重新 trim+concat（省錢 iterate trim 值）
  // 強制重跑 HeyGen：FORCE_REGEN=1 node scripts/verify-dual.js
  const lastSeg = SEGMENTS[SEGMENTS.length - 1];
  const lastSegFile = resolve(tmpDir, `seg-${SEGMENTS.length}-${lastSeg.role}.mp4`);
  const FORCE_REGEN = process.env.FORCE_REGEN === "1";
  const skipGen = !FORCE_REGEN && existsSync(lastSegFile);

  // trim 參數（env 可調，預設 0.5s 頭、0.5s 尾）
  const HEAD_TRIM = parseFloat(process.env.HEAD_TRIM ?? "0.5");
  const TAIL_TRIM = parseFloat(process.env.TAIL_TRIM ?? "0.5");

  log(`雙人 Avatar IV 切換鏡頭驗證`);
  log(`  A talking_photo: ${TALKING_PHOTO.A}`);
  log(`  B talking_photo: ${TALKING_PHOTO.B}`);
  log(`  A voice: ${VOICE.A}`);
  log(`  B voice: ${VOICE.B}`);
  log(`  段數：${SEGMENTS.length}`);
  log(`  trim 設定：head=${HEAD_TRIM}s / tail=${TAIL_TRIM}s（HEAD_TRIM=N TAIL_TRIM=N 環境變數可調）`);
  log(`  快取段檔：${skipGen ? "✅ 命中、跳過 HeyGen 重 call（省錢）" : "❌ 不存在、跑完整 pipeline"}`);
  for (const [i, s] of SEGMENTS.entries()) {
    log(`    段 ${i + 1} [${s.role}] ${s.text}`);
  }

  let segMp4s;
  if (skipGen) {
    log("\n⚠️ 用 .verify-dual-tmp 既有段檔（不重 call HeyGen）。要重新生成：FORCE_REGEN=1 node scripts/verify-dual.js");
    segMp4s = SEGMENTS.map((seg, i) =>
      resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp4`)
    );
  } else {
    // 每次重跑都清乾淨
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });

    // Step 1: MiniMax 配音 → upload HeyGen（平行）
    log("\n=== Step 1: MiniMax 配音 + upload HeyGen（平行） ===");
    const audioAssets = await Promise.all(
      SEGMENTS.map(async (seg, i) => {
        const simpText = tradToSimpConverter(seg.text);
        log(`  段 ${i + 1} [${seg.role}] 配音中…`);
        const mp3 = await minimaxTTS(simpText, VOICE[seg.role]);
        const mp3Path = resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp3`);
        writeFileSync(mp3Path, mp3);
        const assetId = await heygenUpload(mp3);
        log(`  段 ${i + 1} OK → asset_id = ${assetId} (${mp3.length} bytes)`);
        return { ...seg, mp3Path, assetId };
      })
    );

    // Step 2: HeyGen generate（平行）
    log("\n=== Step 2: HeyGen generate 各段（平行） ===");
    const videoIds = await Promise.all(
      audioAssets.map(async (seg, i) => {
        const vid = await heygenGenerate(seg.assetId, TALKING_PHOTO[seg.role]);
        log(`  段 ${i + 1} [${seg.role}] video_id = ${vid}`);
        return { ...seg, videoId: vid };
      })
    );

    // Step 3: 輪詢 + 下載（平行）
    log("\n=== Step 3: 輪詢 + 下載 各段 mp4（平行） ===");
    segMp4s = await Promise.all(
      videoIds.map(async (seg, i) => {
        const url = await heygenPoll(seg.videoId, `段${i + 1}-${seg.role}`);
        const mp4Path = resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp4`);
        await downloadFile(url, mp4Path);
        log(`  段 ${i + 1} 下載 OK → ${mp4Path}`);
        return mp4Path;
      })
    );
  }

  // Step 3.5: trim 各段頭尾靜止
  // 重編碼確保 trim 精確（stream copy 只能在 keyframe 切，會有 0-2 秒誤差）
  log("\n=== Step 3.5: trim 各段頭尾靜止 ===");
  const trimmedMp4s = segMp4s.map((mp4Path, i) => {
    const trimmedPath = mp4Path.replace(/\.mp4$/, "-trim.mp4");
    const duration = parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mp4Path}"`,
        { encoding: "utf-8" }
      ).trim()
    );
    const newDuration = duration - HEAD_TRIM - TAIL_TRIM;
    if (newDuration <= 0) {
      log(`  ⚠️ 段 ${i + 1} 時長 ${duration.toFixed(2)}s 太短（trim 後會 ≤0），跳過 trim`);
      return mp4Path;
    }
    // -avoid_negative_ts make_zero：強制 PTS 從 0 開始，避免 concat 時段邊界吃幀
    execSync(
      `ffmpeg -y -ss ${HEAD_TRIM} -i "${mp4Path}" -t ${newDuration.toFixed(3)} -c:v libx264 -c:a aac -pix_fmt yuv420p -avoid_negative_ts make_zero "${trimmedPath}" 2>/dev/null`,
      { stdio: "pipe" }
    );
    log(`  段 ${i + 1} trim ${duration.toFixed(2)}s → ${newDuration.toFixed(2)}s`);
    return trimmedPath;
  });

  // Step 4: ffmpeg concat（先試 stream copy，失敗 fallback 重編碼）
  log("\n=== Step 4: ffmpeg concat ===");
  const concatListPath = resolve(tmpDir, "concat-list.txt");
  writeFileSync(concatListPath, trimmedMp4s.map((p) => `file '${p}'`).join("\n"));
  const outPath = resolve(PROJECT_DIR, "public", "heygen-dual-verify.mp4");
  // 強制重編碼 concat（trim 後段檔已經重編碼，stream copy 對 segment 邊界處理會吃幀）
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:v libx264 -c:a aac -pix_fmt yuv420p "${outPath}"`,
    { cwd: PROJECT_DIR, stdio: "inherit" }
  );
  log("✅ concat 完成（強制重編碼避免段邊界吃幀）");

  // Step 5: 加速 125%（保持音調）── 跟 run.js 最終流程對齊
  // 設 SKIP_SPEEDUP=1 可跳過加速直接看原速版本
  const SKIP_SPEEDUP = process.env.SKIP_SPEEDUP === "1";
  if (SKIP_SPEEDUP) {
    log("\n⚠️ SKIP_SPEEDUP=1，跳過加速、保留原速");
  } else {
    log("\n=== Step 5: 加速 125%（保持音調）===");
    const fastPath = outPath.replace(/\.mp4$/, "-fast.mp4");
    execSync(
      `ffmpeg -y -i "${outPath}" -filter_complex "[0:v]setpts=PTS/1.25[v];[0:a]atempo=1.25[a]" -map "[v]" -map "[a]" "${fastPath}"`,
      { cwd: PROJECT_DIR, stdio: "inherit" }
    );
    require("fs").renameSync(fastPath, outPath);
    log(`✅ 加速完成，覆蓋 ${outPath}`);
  }

  log(`\n✅ 完成！輸出：${outPath}`);
  log(`下一步：肉眼看段間銜接、聽配音 A/B 對比、判斷要不要 trim 頭尾靜止`);
  log(`各段 mp4 暫存在 ${tmpDir}（除錯用，可手動 rm）`);
}

main().catch((err) => {
  console.error("\n❌ 錯誤：", err.message);
  process.exit(1);
});
