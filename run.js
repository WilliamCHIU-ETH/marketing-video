#!/usr/bin/env node

// ─────────────────────────────────────────
//  行銷影片自動化 orchestrator
//  使用方式：node run.js
// ─────────────────────────────────────────

const { execSync, execFileSync } = require("child_process");
const { createHash } = require("crypto");
const { readFileSync, writeFileSync, existsSync, openSync, closeSync } = require("fs");
const { resolve } = require("path");
const OpenCC = require("opencc-js");
const { cleanStaleStaging, backupJob } = require("./scripts/public-utils");
const {
  authorizeHeyGenPreviewPlan,
  buildAudioDrivenPayload,
  buildTextDrivenV2Payload,
  buildTextDrivenV3Payload,
  createHeyGenRequestPreview,
  createHeyGenRequestTracer,
  createHeyGenPreviewPlan,
  loadProviderSecrets,
  runVerifiedPaidStep,
  snapshotHeyGenTraceEnvironment,
  submitTracedHeyGenCreate,
} = require("./scripts/heygen-video-title");

const PROJECT_DIR = __dirname;
const HEYGEN_TRACE_ENV = snapshotHeyGenTraceEnvironment(process.env);
// 繁中 → 簡中：MiniMax 對簡體念法比較準（純字形轉換、不動詞彙；避免「公車→公交」這種詞義替換）
const tradToSimpConverter = OpenCC.Converter({ from: "t", to: "s" });

// ── 版型選擇（2026-08-06 新增）──────────────
// 用法：node run.js --template=dapan（不帶參數 = 預設既有 MarketingVideo 流程，行為完全不變）
// 大盤小報是獨立 composition，不走 use-brand.js 品牌切換、不走隨機 avatar 池、
// 最後跑的 parse-script / render 也是專用版本（parse-script:dapan / render:dapan）。
const TEMPLATE_ARG = process.argv.find((a) => a.startsWith("--template="));
const TEMPLATE = TEMPLATE_ARG ? TEMPLATE_ARG.split("=")[1] : "default";
if (!["default", "dapan", "institution", "focusstock"].includes(TEMPLATE)) {
  console.error(`❌ 不認得的 --template=${TEMPLATE}（目前支援：default / dapan / institution / focusstock）`);
  process.exit(1);
}
// 大盤小報／三大法人／焦點股日報是「同一個模子」的三條固定主播產線：HeyGen 文字驅動、固定 avatar、125% 加速。
// 用這個集合統一判斷，避免每處都寫 (dapan || institution || focusstock)。
// ⚠️ 這個集合是「加速只跑一次」的守門依據：generateHeygenVideo() 末尾的加速用 !FIXED_ANCHOR_TEMPLATE
//    擋掉，固定主播三條線一律只走 main() 內那一次。新增固定主播版型時只要加進這個集合即可，
//    不要再另外寫 TEMPLATE !== "xxx" 的個別判斷（2026-08-17 的雙重加速 bug 就是這樣來的）。
const FIXED_ANCHOR_TEMPLATE =
  TEMPLATE === "dapan" || TEMPLATE === "institution" || TEMPLATE === "focusstock";

// ── 跳過生成（2026-08-07 新增）──────────────
// 用法：node run.js --template=dapan --skip-generate
// 給「影片已經手動放好在 public/heygen.mp4」的情境用（例如大盤小報這次不經 HeyGen、
// 使用者自己準備好的橫式講者影片）。加這個旗標會：
//   ① 完全不呼叫 HeyGen／MiniMax（不需要 API key、不會生新影片、不會覆蓋你手動放的檔）
//   ② 不做既有投廣模板的 125% 加速（那個只在真的呼叫 HeyGen 生成時做）
//      —— 但固定主播三條線的 125% 加速不受這個旗標影響，無論有沒有 --skip-generate 都會套用
//         （2026-08-07 使用者定案：手動放的影片也要一起加速，見 main() 內統一加速那段）
//   ③ 直接跳到 transcribe → correct-subtitles → parse-script(:dapan) → render(:dapan)
// 之前「一直被蓋回舊的直式影片」就是因為沒加這個旗標——每次跑 --template=dapan
// 都會真的重新呼叫 HeyGen 生一支新的 9:16 直式影片蓋掉 public/heygen.mp4。
const SKIP_GENERATE = process.argv.includes("--skip-generate");

// ── 額外開關（2026-08-12 使用者要求）──
//   --no-speed ：跳過 125% 加速（想保留原始講話速度時用）。四個版型都吃這個旗標。
//   --no-ad    ：焦點股只出客製版，不出投廣套框版
//   --minimax  ：投廣模板／雙人 path 退回 MiniMax 配音（2026-08-17 起預設用 HeyGen 內建語音）
//   --heygen-v2：文字驅動退回舊的 /v2/videos 端點（預設走 /v3/videos）
//   --dry-run   ：只輸出 exact endpoint/segment/title 與 payload-safe metadata；不碰任何 provider。
//   server-managed Run 會用 WORKSPACE_RUN_TOKEN 自動綁定 Project/Revision/Run 與 provider ledger。
//   手動執行可傳 --project-id / --revision / --run-id，或 --experiment / --revision；
//   沒有完整 identity 一律 fail closed，不允許匿名或 timestamp/PID 充當付費 request identity。
//   --heygen-title 只供 Project context 作人類可讀 prefix；EXP 固定使用測試用EXP-NNN-VN。
//   手動 paid run 必須先檢查 --dry-run 輸出的 approvalId，再用 --approve-preview=<id> 明確核准；
//   managed run 仍會 build 同一份 preview，WORKSPACE_RUN_TOKEN 只作 approval source，不能取代 proof。
const NO_SPEED = process.argv.includes("--no-speed");
const DRY_RUN = process.argv.includes("--dry-run");
const APPROVE_PREVIEW_ARG = process.argv.find((arg) => arg.startsWith("--approve-preview="));
const PROVIDED_PREVIEW_APPROVAL = APPROVE_PREVIEW_ARG
  ? APPROVE_PREVIEW_ARG.slice("--approve-preview=".length)
  : null;

// 焦點股日報：2026-08-13 使用者定案「之後只要出客製版，不用多出投廣套框版」。
// 所以預設不出投廣版；真的要的時候加 --with-ad。
// （--no-ad 保留但已是預設值，舊指令照打不會出事。）
const WITH_AD = process.argv.includes("--with-ad");
const NO_AD = !WITH_AD;

// 投廣模板（default）的品牌：起漲K線 / 籌碼K線。
// 這兩個差在 frame.png / logo.png / outro.mp4 / bgm.wav / deeplinks.json，
// 都放在 assets/<品牌>/。以前要自己先跑 node scripts/use-brand.js <品牌>，
// 忘了跑就會沿用上一支的外框（2026-08-13 接前台時補上）。
const BRAND_ARG = process.argv.find((a) => a.startsWith("--brand="));
const BRAND = BRAND_ARG ? BRAND_ARG.split("=").slice(1).join("=") : null;

// ── 兩段式出片（2026-08-13 前台網頁需要）──
//   --stop-before-render：跑到「算出配圖計畫」就停，不 render。
//        給前台在 render 前插入「人看一眼、要改就改」的關卡用。
//   --render-only       ：跳過前面全部，直接用現有的 public/ 與 *.generated.json 出片。
//        前台把使用者改過的配圖計畫寫回去之後，用這個旗標接著跑。
//   兩個旗標都不加時行為跟以前完全一樣（一路跑到底），既有終端機指令不受影響。
const STOP_BEFORE_RENDER = process.argv.includes("--stop-before-render");
const RENDER_ONLY = process.argv.includes("--render-only");

// ── 設定 ──────────────────────────────────
let HEYGEN_API_KEY;
let MINIMAX_API_KEY;
let MINIMAX_GROUP_ID;
let providerEnvironmentLoaded = false;

function loadProviderEnvironment() {
  if (providerEnvironmentLoaded) return;
  const providerSecrets = loadProviderSecrets({ env: process.env });
  HEYGEN_API_KEY = providerSecrets.HEYGEN_API_KEY;
  MINIMAX_API_KEY = providerSecrets.MINIMAX_API_KEY;
  MINIMAX_GROUP_ID = providerSecrets.MINIMAX_GROUP_ID;
  providerEnvironmentLoaded = true;
}
// MiniMax 語音設定（非 secret，hardcode 在這裡）
const MINIMAX_VOICE_ID = "moss_audio_3a75102e-54db-11f1-981b-8a143315d498";
const MINIMAX_MODEL = "speech-02-hd"; // HD 品質，3.5 元/萬字符。要省可改 speech-02-turbo

// 單人池：每個 avatar 帶 gender，配音時用 SOLO_VOICES[gender] 抽對應聲音
const AVATAR_IDS = [
  { id: "9d4c8154a0aa4122b20ed60eb1028d69", gender: "female" },
  { id: "1375ec16cd124aaf9a3e182530495776", gender: "female" },
  { id: "2abd791fb4cc4c84a228ea47898c9015", gender: "female" },
  { id: "e0ed406031924df7835cf290d289dc77", gender: "female" },
  { id: "7765f68aaa6a4b658b95f4e5357c21d5", gender: "female" },
  { id: "0855d9402c184b4bbcb0f7df94f63996", gender: "female" },
  { id: "423ce3555c4240999d1400060405997e", gender: "female" },
  { id: "62d14dcef42848e48620d102b31de477", gender: "female" },
  { id: "b69172d0150d4b7dbf2c295f2daa884f", gender: "female" },
  { id: "ba346ffd318d4b779dd9d6b872a09789", gender: "female" },
  { id: "5df65f6c51f441d0b9ded595be814bf5", gender: "female" },
  { id: "2d5baec141644babad17be304f3ae30a", gender: "female" },
  { id: "4e9bcc7c3a1f453b9f4b9b594fc00a31", gender: "female" },
  { id: "54399f608b3d4a47afc628110eb636fc", gender: "female" },
  { id: "69453202ed5c44bdb2e1a9abb230c97e", gender: "female" },
  { id: "6b9907657bf74194a68c866e2ee3bb4b", gender: "female" },
  { id: "74465fc8e46148a4a333090c191a3b12", gender: "female" },
  // 2026-06-08 移除雙人配對 A（85e20f2b / ee70c6af / ca62aa65）：改為只走雙人 path，不進單人池
  // 2026-06-04 新增
  { id: "2e37d4c4903649b8996bd3b7aa2d8c0e", gender: "female" },
  { id: "a658d9acf3bd43dbb0e52394368e7cc4", gender: "female" },
  { id: "f74d88d33a184418b68588bfee84064b", gender: "female" },
  // 2026-06-05 新增：男生（配 SOLO_VOICES.male 男聲）
  { id: "0f51e6a9edad4b7bbf19383b7e9910d1", gender: "male" },
  { id: "6cfb6b22ad064130b50c259313ca4564", gender: "male" },
  { id: "9c4a7be4283c4fc9b0a76f2408bc21e3", gender: "male" },
  { id: "28178c70220c49e1b5b6bddb08c466b9", gender: "male" },
  { id: "1103287ef96b4ef0b9a346ae27b4fc64", gender: "male" },
  { id: "ab9724f5685f4f819a135ac3237460f0", gender: "male" },
  { id: "ba0e4bfa8596449d86041ef91677465c", gender: "male" },
  { id: "c9f3346b2bb942c3847f179989d1809d", gender: "male" },
  { id: "e128f42cf398437ca866c9b94d3e9da3", gender: "male" },
];

// 單人 path 的 voice 對應：抽到的 avatar 性別決定配音
// male 與 DUAL_VOICES.B 同一支聲音，但各自引用、互不影響
const SOLO_VOICES = {
  female: MINIMAX_VOICE_ID,
  male: "moss_audio_44ce6b04-5a39-11f1-981b-8a143315d498",
};

// 雙人 path：A/B 配對表（從 assets/avatar-pairs.json 載入）
// 隨機抽一對對話用；單人 path 仍從 AVATAR_IDS 抽
let avatarPairs = null;
function getAvatarPairs() {
  if (!avatarPairs) avatarPairs = require("./assets/avatar-pairs.json").pairs;
  return avatarPairs;
}

// 雙人 path 的 voice 對應（A 用現有 MINIMAX_VOICE_ID，B 是新 voice）
const DUAL_VOICES = {
  A: MINIMAX_VOICE_ID,
  B: "moss_audio_44ce6b04-5a39-11f1-981b-8a143315d498",
};

// ── HeyGen 內建語音（2026-08-17）────────────
// 使用者：「MiniMax 點數沒了，先不加值」→ 投廣模板（default）與雙人 path 一併改走
// HeyGen 自己的 TTS（script + voice_id 文字驅動），跟固定主播三條線同一條路。
// 影響：①不再需要 MINIMAX_API_KEY／MINIMAX_GROUP_ID ②不再做繁→簡轉換（HeyGen 吃繁中）
//       ③不再產 public/minimax.mp3
// 要退回 MiniMax（例如之後加值了）：指令加 --minimax，整條路徑原封不動復原。
const USE_MINIMAX = process.argv.includes("--minimax");

// 投廣模板單人 path 的 HeyGen voice（2026-08-17 使用者提供）。
// 結構刻意跟 MiniMax 的 SOLO_VOICES 一模一樣 —— 抽到的 avatar 性別決定配音，
// 所以男 avatar 配男聲、女 avatar 配女聲，跟 MiniMax 時代的行為一致。
const HEYGEN_SOLO_VOICES = {
  female: "65b04effe83f423dbb1f66317318c37f", // 與焦點股日報同一支女聲
  male: "c223c1b3c779490ca14f4525eb30006e",
};

// 雙人 path 的 HeyGen voice：A 女、B 男，對應 MiniMax 時代 DUAL_VOICES 的分工。
const HEYGEN_DUAL_VOICES = {
  A: HEYGEN_SOLO_VOICES.female,
  B: HEYGEN_SOLO_VOICES.male,
};

// 大盤小報：固定單一 avatar（「每日固定主播」形式，不像投廣模板從池子隨機抽），
// 2026-08-06 使用者定案。只在 TEMPLATE === "dapan" 時使用。
const DAPAN_AVATAR = { id: "8032bdb625654e1ab849163373dfcf0a", gender: "female" }; // 2026-08-10 使用者更換主播 avatar（原 c2c2963b…）
// 大盤小報：HeyGen 內建語音 voice_id（2026-08-07 使用者要求聲音改用 HeyGen 生、不經 MiniMax）。
// ⚠️ 待補：目前是空值，去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v2/voices
// 找一個中文女聲的 voice_id 填進來，沒填就跑 --template=dapan 會直接報錯擋下來（見 main() 內檢查）。
const DAPAN_HEYGEN_VOICE_ID = "f331fe732c7f44c88803ae019811ef50";

// 三大法人：跟大盤小報同一個模子（固定主播、HeyGen 文字驅動、125% 加速），只在 TEMPLATE === "institution" 用。
// 2026-08-10 使用者提供：avatar 57d5790b…、中文女聲 voice e96f2834…。
const INSTITUTION_AVATAR = { id: "57d5790b64e34472a932d6c7d0b4f64b", gender: "female" };
const INSTITUTION_HEYGEN_VOICE_ID = "e96f2834052f404c9c3725b4fd6ee55a";

// 焦點股日報：同一個模子（固定主播、HeyGen 文字驅動、125% 加速），只在 TEMPLATE === "focusstock" 用。
// 2026-08-11 使用者提供：avatar 7765f68a…、中文女聲 voice 65b04eff…。
// 一次跑會出兩支：客製版（Focusstock，藍色版型有開場卡）＋投廣套框版（FocusstockAd，籌碼K線外框＋片尾、無開場）。
const FOCUSSTOCK_AVATAR = { id: "7765f68aaa6a4b658b95f4e5357c21d5", gender: "female" };
const FOCUSSTOCK_HEYGEN_VOICE_ID = "65b04effe83f423dbb1f66317318c37f";

// ── 工具函式 ──────────────────────────────

function log(msg) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}`);
}

function run(cmd) {
  log(`執行：${cmd}`);
  execSync(cmd, { cwd: PROJECT_DIR, stdio: "inherit" });
}

/**
 * 背景執行（不擋主流程）。給「不依賴講者影片」的工作用，最典型的就是圖片 OCR 版面偵測：
 * 它只需要 public/ 裡的圖，跟 HeyGen 生成完全無關，所以可以在等 HeyGen 那 3-5 分鐘時一起跑完。
 * 回傳 Promise，之後用 await 收斂。失敗不丟出（由呼叫端決定要不要當致命錯誤）。
 */
function runBackground(cmd, label) {
  const { exec } = require("child_process");
  log(`背景執行：${cmd}`);
  return new Promise((resolve) => {
    exec(cmd, { cwd: PROJECT_DIR, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      resolve({ ok: !err, label, cmd, stdout: stdout || "", stderr: stderr || "", err });
    });
  });
}

/**
 * 依版型啟動「圖片分析」（OCR 版面偵測）。在呼叫 HeyGen 之前就啟動，好處有二：
 *   ① 省時間：跟 HeyGen 生成平行跑，等影片的空檔就把 OCR 做完。
 *   ② 及早失敗：圖有問題／沒裝 tesseract 會在一開始就知道，不必等 3-5 分鐘、白花 HeyGen 額度。
 * 回傳 Promise 或 null（該版型沒有要分析的圖）。
 */
function startImageAnalysis() {
  // 三大法人：固定版面資訊圖 → 用①②③④編號推區塊帶（供聚焦/高亮效果）
  if (TEMPLATE === "institution") {
    // 資訊圖檔名不挑：使用者常丟 0812.png 這種日期命名。
    // （2026-08-12 踩到：這裡寫死 image.png → 判定沒有圖而略過偵測，
    //   regions 停在舊圖、composition 又找不到檔案 → render 404。）
    const fsx = require("fs");
    const pubDir = resolve(PROJECT_DIR, "public");
    const ASSET = /^(dapan|focusstock|institution)-|^(frame|logo)\.png$|^NotoSans/i;
    const found = fsx.existsSync(pubDir)
      ? fsx
          .readdirSync(pubDir)
          .filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && !ASSET.test(f))
          .sort()
      : [];
    if (found.length === 0) {
      log("ℹ️ public/ 沒有資訊圖，略過版面偵測");
      return null;
    }
    log(`   資訊圖：${found.includes("image.png") ? "image.png" : found[0]}`);
    log("🔎 開始資訊圖版面偵測（與 HeyGen 生成平行進行）");
    return runBackground("npm run analyze:institution", "版面偵測");
  }
  // 其餘版型（大盤小報／焦點股／投廣）：變動版面的 APP 截圖
  //   → 判斷是哪一頁、哪一檔股票，並存下逐字框座標，供之後框數字／局部放大用。
  const fs2 = require("fs");
  const pub = resolve(PROJECT_DIR, "public");
  // 截圖檔名不限（使用者常直接丟手機相機命名的檔），排除套版素材即可
  const TEMPLATE_ASSET = /^(dapan|focusstock|institution)-|^(frame|logo)\.png$|^NotoSans/i;
  const shots = fs2.existsSync(pub)
    ? fs2.readdirSync(pub).filter(
        (f) => /\.(png|jpg|jpeg)$/i.test(f) && !TEMPLATE_ASSET.test(f)
      )
    : [];
  if (shots.length === 0) {
    log("ℹ️ public/ 沒有 image*.png，略過 APP 截圖分析");
    return null;
  }
  log(`🔎 開始 APP 截圖分析（${shots.length} 張，與 HeyGen 生成平行進行）`);
  return runBackground("npm run analyze:app-images", "APP 截圖分析");
}

function parseVoiceReplacements(raw) {
  // 讀取頂部 # 發音替換 區塊（=== 之前）
  const rules = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('===')) break;
    if (line.startsWith('#')) continue;
    const m = line.match(/^(.+?)→(.+)$/);
    if (m) rules.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return rules;
}

function cleanScript(raw) {
  // 套用發音替換（送 HeyGen 前）
  const voiceRules = parseVoiceReplacements(raw);
  // 移除標題區（=== 以前）
  const parts = raw.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? raw);
  // 移除圖片標記 (imageN)...(imageN)、(logo)...(logo)、(shot:名稱)...(shot:名稱)
  // 大小寫不分(i flag),(Logo)、(IMAGE1)、(Shot:...) 都能正確移除
  let cleaned = body.replace(/\(text:[^)]*\)[\s\S]*?\(\/text\)/gi, "").replace(/\([a-z0-9]+\)/gi, "").replace(/\(shot:[^)]*\)/gi, "");
  // 移除括號內文字
  cleaned = cleaned.replace(/[\[{【（][^\]}\]）】]*[\]}\]）】]/g, "");
  // 移除多餘空白與換行
  cleaned = cleaned.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned;
}

function randomAvatar() {
  // 回傳 { id, gender }，gender 用來決定 SOLO_VOICES 配音
  return AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
}

function randomPair() {
  const pairs = getAvatarPairs();
  return pairs[Math.floor(Math.random() * pairs.length)];
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 雙人 path：腳本解析 ─────────────────
// detectMode: 偵測腳本是否含 [A]/[B] 行首標記 → 'dual' 或 'solo'
// 沒有 [A]/[B] → 走現有單人 path（100% 向後相容）
function detectMode(rawScript) {
  const parts = rawScript.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? rawScript);
  return /^[ \t]*\[([AaBb])\]/m.test(body) ? "dual" : "solo";
}

// splitByRole: 把 script.txt 內文依 [A]/[B] 行首標記切段、合併連續同角色段
// 沒標的第一段預設 A；沒標的後續行承襲上一段角色
// 回傳 [{ role: 'A'|'B', text: <已清洗的對話文字> }, ...]
function splitByRole(rawScript, voiceRules) {
  const parts = rawScript.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? rawScript);

  // 套發音替換（保持繁中，跟單人 path 同邏輯）
  let bodyAfterVoice = body;
  for (const rule of voiceRules) {
    bodyAfterVoice = bodyAfterVoice.split(rule.from).join(rule.to);
  }

  const lines = bodyAfterVoice.split("\n");
  let currentRole = "A"; // 預設第一段為 A
  let currentText = "";
  const segments = [];

  function flushSegment() {
    const cleaned = cleanSegmentText(currentText);
    if (cleaned) segments.push({ role: currentRole, text: cleaned });
    currentText = "";
  }

  for (const line of lines) {
    const m = line.match(/^[ \t]*\[([AaBb])\][ \t]*(.*)$/);
    if (m) {
      const newRole = m[1].toUpperCase();
      if (newRole !== currentRole && currentText.trim()) flushSegment();
      currentRole = newRole;
      currentText += (currentText ? " " : "") + m[2];
    } else {
      currentText += (currentText ? " " : "") + line;
    }
  }
  flushSegment();
  return segments;
}

// cleanSegmentText: 單段對話的清洗（跟 cleanScript 同精神，但已切段、只處理單段文字）
function cleanSegmentText(text) {
  let out = text
    .replace(/\(text:[^)]*\)[\s\S]*?\(\/text\)/gi, "")
    .replace(/\([a-z0-9]+\)/gi, "")
    .replace(/\(shot:[^)]*\)/gi, "");
  out = out.replace(/[\[{【（][^\]}\]）】]*[\]}\]）】]/g, "");
  out = out.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return out;
}

// ── MiniMax T2A ───────────────────────────

async function minimaxTTS(text, voiceId = MINIMAX_VOICE_ID) {
  log(`呼叫 MiniMax T2A（${text.length} 字符、model: ${MINIMAX_MODEL}、voice: ${voiceId}）`);
  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${MINIMAX_GROUP_ID}`;
  const payload = {
    model: MINIMAX_MODEL,
    text,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
      // 不送 emotion = MiniMax 預設依文字內容自動挑最自然的情緒（官方文件 default 行為）。
      // 要鎖定單一情緒再加回 emotion: 合法值只有 happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper（無 neutral/auto，送了會回 2013）。
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
    throw new Error("MiniMax T2A 生成失敗");
  }
  // response.data.audio 是 hex-encoded mp3
  return Buffer.from(data.data.audio, "hex");
}

// ── 影片加速 ───────────────────────────────
// 全流程只准加速一次。2026-08-17 之前有兩個加速點（generateHeygenVideo 末尾的 125%
// 與 main() 內的 120%），守門條件對不上，institution／focusstock 被連續加速兩次
// （1.25 × 1.2 ≒ 1.5 倍），講話斷句被壓爛。現在改成共用這個函式 + 模組層旗標把關：
// 就算未來又有人多加一個呼叫點，第二次也會被擋下並印警告，而不是靜默 compounding。
const SPEED_FACTOR = 1.25;
let speedApplied = false;

function speedUpHeygen(heygenPath, whoLabel) {
  if (speedApplied) {
    log(`⚠️ heygen.mp4 這一輪已經加速過了，略過「${whoLabel}」的重複加速（避免 compounding）`);
    return;
  }
  log(`加速影片 ${Math.round(SPEED_FACTOR * 100)}%（保持音調）`);
  const heygenFast = resolve(PROJECT_DIR, "public/heygen_fast.mp4");
  execSync(
    `ffmpeg -y -i "${heygenPath}" -filter_complex "[0:v]setpts=PTS/${SPEED_FACTOR}[v];[0:a]atempo=${SPEED_FACTOR}[a]" -map "[v]" -map "[a]" "${heygenFast}"`,
    { cwd: PROJECT_DIR, stdio: "inherit" }
  );
  require("fs").renameSync(heygenFast, heygenPath);
  speedApplied = true;
  log("加速完成，覆蓋 heygen.mp4");
}

// ── HeyGen API ────────────────────────────

// Avatar IV 手部/身體動作提示（只有 photo avatar 吃）。要微調手勢就改這裡。
const HEYGEN_MOTION_PROMPT = "站姿自然，雙手在胸前或身側做出適度自然的手勢，配合語氣比劃，不要十指交握不動";

// expressiveness：high / medium / low。官方文件說「省略時預設 low」，只有 photo avatar 吃。
// 手不太動時可以試 high（會連帶放大臉部表情幅度）。
const HEYGEN_EXPRESSIVENESS = "medium";

// ── v3 vs v2（2026-08-17）────────────────
// 固定主播三條線（文字驅動）走 POST /v3/videos，理由：
//   ① Avatar IV 是 v3 的「預設引擎」，官方文件現在只寫 v3；我們仍明示 engine.type = avatar_iv
//   ② v3 才有 voice_settings（speed / pitch / locale）——調語速不必再靠 ffmpeg 硬壓
//   ③ 官方明講 <break time="0.3s"/> 標籤適用於 POST /v3/videos 的 script 欄位（唯一支援的標籤，
//      不要包 <speak>，會多唸出音節）。這是修「中文分詞斷錯句」的正解。
//      ⚠️ 但 scripts/script-utils.js 的 cleanBodyWithIndex 目前沒遮罩 <break>，
//         現在直接在 script.txt 寫標籤會漏進字幕。要用得先同步 TTS、字幕清理與索引對齊，並補測試。
//   ④ brand_glossary_id 可以指定專有名詞唸法，且官方保證「只影響合成音訊，字幕仍顯示原文」——
//      比現在的「發音替換」乾淨。要用先 GET /v3/brand-glossaries 拿 id 填進來。
// 出事時加 --heygen-v2 一鍵退回舊的 /v2/videos 路徑。
// ⚠️ 投廣模板與雙人 path 走的是「MiniMax 配音 + audio_asset_id 音訊驅動」，
//    那條路徑完全沒動，仍然是 /v2/videos（既有投廣模板必須保持不變）。
const HEYGEN_V2_FALLBACK = process.argv.includes("--heygen-v2");

// voice_settings（只有 v3 吃）。null = 不送該欄位，用 HeyGen 預設。
//   speed  : 0.5–1.5。這裡設 null 是刻意的 —— 加速統一由 ffmpeg 的 SPEED_FACTOR 處理，
//            兩邊都調會變成又一次 compounding。要改語速請「二選一」。
//   locale : BCP-47，例如 "zh-TW"。填之前先跑 npm run check-voices 確認該 voice 的
//            support_locale 是 true，否則可能被 400 退回。
const HEYGEN_VOICE_SPEED = null;
const HEYGEN_VOICE_LOCALE = null;

// 專有名詞唸法字典（v3 專屬）。先 GET /v3/brand-glossaries 拿 id，填進來就會套用。
const HEYGEN_BRAND_GLOSSARY_ID = null;

let heygenRequestTracer = null;

function requireHeyGenRequestTracer() {
  if (!heygenRequestTracer) {
    throw new Error("HeyGen request trace 尚未初始化，拒絕建立付費 request");
  }
  return heygenRequestTracer;
}

async function heygenUploadAudio(audioBuffer) {
  log(`上傳音檔到 HeyGen（${audioBuffer.length} bytes）`);
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "audio/mpeg",
    },
    body: audioBuffer,
  });
  const data = await res.json();
  // HeyGen 回傳結構通常是 { code: 100, data: { id, name, url } }；asset id 在 data.id
  const assetId = data?.data?.id || data?.data?.asset_id;
  if (!res.ok || !assetId) {
    console.error("HeyGen upload 回應：", JSON.stringify(data, null, 2));
    throw new Error("HeyGen 音檔上傳失敗");
  }
  log(`音檔已上傳：asset_id = ${assetId}`);
  return assetId;
}

async function submitHeyGenCreate({
  endpoint,
  api,
  payload,
  segment = null,
  payloadMetadata = {},
  ledgerRequestId = null,
}) {
  const tracer = requireHeyGenRequestTracer();
  // This is the paid-request dry-run gate: validate/build the complete payload first, then durably
  // record its traceable title before fetch can send anything to HeyGen.
  try {
    return await submitTracedHeyGenCreate({
      fetchImpl: fetch,
      tracer,
      apiKey: HEYGEN_API_KEY,
      endpoint,
      api,
      payload,
      segment,
      payloadMetadata,
      ledgerRequestId,
      onPrepared: ({ title }) => log(`HeyGen Dashboard 名稱：${title}`),
    });
  } catch (error) {
    if (Object.prototype.hasOwnProperty.call(error, "providerResponse")) {
      console.error("HeyGen create 回應：", JSON.stringify(error.providerResponse, null, 2));
    }
    throw error;
  }
}

async function createHeyGenVideo(
  audioAssetId,
  avatarId,
  title,
  segment = null,
  ledgerRequestId = null,
  payloadMetadata = audioDryRunMetadata(),
) {
  log(`呼叫 HeyGen Avatar IV（avatar: ${avatarId}、audio_asset_id: ${audioAssetId}）`);

  // 端點：POST /v2/videos（HeyGen 專用 Avatar IV）。
  // 跟舊的 /v2/video/generate 差別：這裡的 motion_prompt（控制身體/手部動作，僅 photo avatar）
  // 與 expressiveness（注意值要小寫 high）才真正生效 → 手會動。
  // avatar_id 直接吃 talking_photo 的 id；audio_asset_id 走 audio-driven 對嘴（與 script 互斥），沿用 MiniMax 配音。
  const payload = buildAudioDrivenPayload({
    avatarId,
    audioAssetId,
    motionPrompt: HEYGEN_MOTION_PROMPT,
    title,
  });
  return submitHeyGenCreate({
    endpoint: "https://api.heygen.com/v2/videos",
    api: "v2-audio",
    payload,
    segment,
    payloadMetadata,
    ledgerRequestId,
  });
}

// 固定主播三條線專用：不經 MiniMax，直接把腳本文字＋HeyGen 內建語音 voice_id 送給 HeyGen，
// 由 HeyGen 自己 TTS＋對嘴（跟現有 audio_asset_id 音訊驅動路徑互斥，用 script+voice_id 這組欄位）。
// 2026-08-07 使用者要求「大盤小報聲音改用 HeyGen 生，不要用 MiniMax」。
// 2026-08-17 起預設走 v3（見下方 createHeyGenVideoTextDrivenV3）；這支是 --heygen-v2 的退路。
async function createHeyGenVideoTextDrivenV2(scriptText, avatarId, voiceId, title, segment = null) {
  log(`呼叫 HeyGen /v2/videos（avatar: ${avatarId}，voice_id: ${voiceId}，文字驅動、不經 MiniMax）`);

  const payload = buildTextDrivenV2Payload({
    avatarId,
    scriptText,
    voiceId,
    motionPrompt: HEYGEN_MOTION_PROMPT,
    expressiveness: HEYGEN_EXPRESSIVENESS,
    title,
  });
  return submitHeyGenCreate({
    endpoint: "https://api.heygen.com/v2/videos",
    api: "v2-text",
    payload,
    segment,
    payloadMetadata: textDryRunMetadata(scriptText, "v2-text"),
  });
}

// v3 版（預設路徑）。跟 v2 的差別：
//   - 多了必填的 type: "avatar"
//   - engine.type 明示 avatar_iv（省略也是它，寫出來是防日後預設換掉）
//   - 多了 voice_settings（speed / pitch / locale）與 brand_glossary_id
//   - script 欄位吃 <break time="0.3s"/> 標籤
async function createHeyGenVideoTextDrivenV3(scriptText, avatarId, voiceId, title, segment = null) {
  log(`呼叫 HeyGen /v3/videos Avatar IV（avatar: ${avatarId}，voice_id: ${voiceId}，文字驅動、不經 MiniMax）`);

  const payload = buildTextDrivenV3Payload({
    avatarId,
    scriptText,
    voiceId,
    motionPrompt: HEYGEN_MOTION_PROMPT,
    expressiveness: HEYGEN_EXPRESSIVENESS,
    title,
    voiceSpeed: HEYGEN_VOICE_SPEED,
    voiceLocale: HEYGEN_VOICE_LOCALE,
    brandGlossaryId: HEYGEN_BRAND_GLOSSARY_ID,
  });
  return submitHeyGenCreate({
    endpoint: "https://api.heygen.com/v3/videos",
    api: "v3-text",
    payload,
    segment,
    payloadMetadata: textDryRunMetadata(scriptText, "v3-text"),
  });
}

// 輪詢 GET /v3/videos/{video_id}。回應是 VideoDetail：完成時給 video_url / duration /
// subtitle_url，失敗時給 failure_code / failure_message（沒有保證一定有 status 欄位，
// 所以用「有沒有 video_url」當完成判準，status 只拿來顯示）。
async function pollHeyGenStatusV3({ videoId, ledgerRequestId }) {
  log(`等待 HeyGen 完成（v3，video_id: ${videoId}）`);
  const tracer = requireHeyGenRequestTracer();
  try {
    for (let i = 0; i < 90; i++) {
      await sleep(10000); // 每 10 秒查一次

      const res = await fetch(`https://api.heygen.com/v3/videos/${videoId}`, {
        headers: { "X-Api-Key": HEYGEN_API_KEY },
      });
      const data = await res.json().catch(() => null);
      const d = data?.data || data || {};

      if (!res.ok) {
        const error = new Error(`HeyGen 狀態查詢失敗（HTTP ${res.status}）`);
        error.ledgerCode = `http_${res.status}`;
        throw error;
      }

      if (d.failure_code || d.failure_message) {
        const error = new Error(`HeyGen 生成失敗：${d.failure_code || ""} ${d.failure_message || ""}`.trim());
        error.ledgerCode = d.failure_code || "provider_generation_failed";
        console.error("HeyGen 回應：", JSON.stringify(data, null, 2));
        throw error;
      }

      if (d.video_url) {
        console.log("");
        if (d.duration) log(`HeyGen 原始輸出時長：${d.duration} 秒（加速前）`);
        tracer.completed(ledgerRequestId, { durationSec: d.duration, credits: d.credits });
        return d.video_url;
      }

      const status = d.status || d.state || "processing";
      process.stdout.write(`\r  狀態：${status}            `);
    }
    const error = new Error("HeyGen 等待超時（15 分鐘）");
    error.ledgerCode = "poll_timeout";
    throw error;
  } catch (error) {
    tracer.failed(ledgerRequestId, {
      phase: "poll",
      code: error.ledgerCode || "poll_request_failed",
    });
    throw error;
  }
}

// 文字驅動的統一入口：預設 v3，加 --heygen-v2 退回 v2。
// 三個固定主播分支都呼叫這支，避免各自複製一份 create + poll。
async function generateTextDrivenVideo(scriptText, avatarId, voiceId, fallbackTitle, segment = null) {
  const title = requireHeyGenRequestTracer().titleFor(fallbackTitle, segment);
  if (HEYGEN_V2_FALLBACK) {
    log("⚠️ 已指定 --heygen-v2，改走舊的 /v2/videos 路徑");
    const request = await createHeyGenVideoTextDrivenV2(
      scriptText,
      avatarId,
      voiceId,
      title,
      segment,
    );
    return pollHeyGenStatus(request);
  }
  const request = await createHeyGenVideoTextDrivenV3(
    scriptText,
    avatarId,
    voiceId,
    title,
    segment,
  );
  return pollHeyGenStatusV3(request);
}

// v2 的輪詢（音訊驅動 path 與 --heygen-v2 共用，維持原樣不動）
async function pollHeyGenStatus({ videoId, ledgerRequestId }) {
  log(`等待 HeyGen 完成（video_id: ${videoId}）`);
  const tracer = requireHeyGenRequestTracer();

  // 輪詢 /v2/videos 專用的狀態端點：GET /v2/videos/{video_id}（不是舊的 v1/video_status.get）。
  // 回應 schema 防禦式解析：status 與 video_url 都試多個可能位置。
  try {
    for (let i = 0; i < 90; i++) {
      await sleep(10000); // 每 10 秒查一次

      const res = await fetch(
        `https://api.heygen.com/v2/videos/${videoId}`,
        {
          headers: { "X-Api-Key": HEYGEN_API_KEY },
        }
      );

      const data = await res.json();
      const d = data?.data || data;
      const status = d?.status || d?.state;
      const url = d?.video_url || d?.url || d?.output?.video_url;

      if (!res.ok) {
        const error = new Error(`HeyGen 狀態查詢失敗（HTTP ${res.status}）`);
        error.ledgerCode = `http_${res.status}`;
        throw error;
      }

      process.stdout.write(`\r  狀態：${status || "?"}            `);

      if (["completed", "success", "done", "ready"].includes(String(status))) {
        console.log("");
        if (!url) {
          console.error("HeyGen 完成但找不到 video_url：", JSON.stringify(data, null, 2));
          const error = new Error("HeyGen 完成但解析不到下載連結");
          error.ledgerCode = "completed_without_video_url";
          throw error;
        }
        tracer.completed(ledgerRequestId, { durationSec: d?.duration, credits: d?.credits });
        return url;
      }

      if (["failed", "error"].includes(String(status))) {
        const error = new Error(`HeyGen 生成失敗：${JSON.stringify(data)}`);
        error.ledgerCode = d?.error?.code || "provider_generation_failed";
        throw error;
      }
    }
    const error = new Error("HeyGen 等待超時（15 分鐘）");
    error.ledgerCode = "poll_timeout";
    throw error;
  } catch (error) {
    tracer.failed(ledgerRequestId, {
      phase: "poll",
      code: error.ledgerCode || "poll_request_failed",
    });
    throw error;
  }
}

async function downloadVideo(url, destPath) {
  log(`下載影片到 ${destPath}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗：${res.status}`);

  const buffer = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buffer));
  log("下載完成！");
}

// ── 雙人 path 主流程 ──────────────────────
// 平行跑 N 段 MiniMax + N 段 HeyGen + ffmpeg concat → 輸出 outputMp4Path（即 public/heygen.mp4）
// 加速 125% 由 main() 統一處理、跟單人 path 共用
// 段間銜接策略：頭尾不 trim（驗證過、加速 125% 後段尾停頓感自然消化）
async function runDualPath(segments, pair, outputMp4Path) {
  const fs = require("fs");
  const path = require("path");

  log(`\n=== 雙人 path ===`);
  log(`配對：A=${pair.A} / B=${pair.B}`);
  log(`段數：${segments.length}`);
  for (const [i, s] of segments.entries()) {
    log(`  段 ${i + 1} [${s.role}] ${s.text}`);
  }

  const tmpDir = path.resolve(PROJECT_DIR, ".dual-tmp");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Step 1–3。2026-08-17 起預設走 HeyGen 內建語音（文字驅動）：
  // 每段一次 API 呼叫就出影片，不必先 MiniMax 配音再上傳音檔，少兩個步驟也少一組 key。
  // 加 --minimax 退回原本的三步（MiniMax 配音 → upload → 音訊驅動）。
  let segMp4s;

  if (USE_MINIMAX) {
    // Reserve every exact Dashboard title before MiniMax TTS or HeyGen upload can spend anything.
    // The later create must consume this same reservation instead of creating a second ledger row.
    const tracer = requireHeyGenRequestTracer();
    const tracedSegments = segments.map((seg, i) => {
      const traceSegment = { index: i, total: segments.length, role: seg.role };
      const heygenTitle = tracer.titleFor("marketing-auto-dual", traceSegment);
      const providerScript = tradToSimpConverter(seg.text);
      const payloadMetadata = audioDryRunMetadata(providerScript);
      const ledgerRequestId = tracer.prepare({
        api: "v2-audio",
        title: heygenTitle,
        segment: traceSegment,
        payloadMetadata,
      });
      return {
        ...seg,
        traceSegment,
        heygenTitle,
        providerScript,
        payloadMetadata,
        ledgerRequestId,
      };
    });
    // Step 1: MiniMax 配音 + upload HeyGen（平行）
    log("\n--- Step 1: MiniMax 配音 + upload HeyGen（平行） ---");
    const audioAssets = await Promise.all(
      tracedSegments.map(async (seg, i) => {
        const paidStep = {
          tracer,
          ledgerRequestId: seg.ledgerRequestId,
          api: "v2-audio",
          title: seg.heygenTitle,
          segment: seg.traceSegment,
          payloadMetadata: seg.payloadMetadata,
        };
        const mp3 = await runVerifiedPaidStep({
          ...paidStep,
          operationKey: "minimax-tts",
          paidStep: () => minimaxTTS(seg.providerScript, DUAL_VOICES[seg.role]),
        });
        const mp3Path = path.resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp3`);
        fs.writeFileSync(mp3Path, mp3);
        const assetId = await runVerifiedPaidStep({
          ...paidStep,
          operationKey: "heygen-audio-upload",
          paidStep: () => heygenUploadAudio(mp3),
        });
        log(`  段 ${i + 1} [${seg.role}] mp3 + upload OK → ${assetId}`);
        return { ...seg, assetId };
      })
    );

    // Step 2: HeyGen generate（平行）
    log("\n--- Step 2: HeyGen generate 各段（平行） ---");
    const videoIds = await Promise.all(
      audioAssets.map(async (seg, i) => {
        const request = await createHeyGenVideo(
          seg.assetId,
          pair[seg.role],
          seg.heygenTitle,
          seg.traceSegment,
          seg.ledgerRequestId,
          seg.payloadMetadata,
        );
        log(`  段 ${i + 1} [${seg.role}] video_id = ${request.videoId}`);
        return { ...seg, ...request };
      })
    );

    // Step 3: 輪詢 + 下載（平行）
    log("\n--- Step 3: 輪詢 + 下載 各段 mp4（平行） ---");
    segMp4s = await Promise.all(
      videoIds.map(async (seg, i) => {
        const url = await pollHeyGenStatus(seg);
        const mp4Path = path.resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp4`);
        await downloadVideo(url, mp4Path);
        log(`  段 ${i + 1} 下載 OK`);
        return mp4Path;
      })
    );
  } else {
    // Step 1–3 合併：HeyGen 文字驅動，各段平行（繁中直送，不轉簡體）
    log("\n--- Step 1-3: HeyGen 文字驅動生成 + 下載 各段（平行、不經 MiniMax） ---");
    log(`  聲音：A=${HEYGEN_DUAL_VOICES.A} / B=${HEYGEN_DUAL_VOICES.B}`);
    segMp4s = await Promise.all(
      segments.map(async (seg, i) => {
        const segment = { index: i, total: segments.length, role: seg.role };
        const url = await generateTextDrivenVideo(
          seg.text,
          pair[seg.role],
          HEYGEN_DUAL_VOICES[seg.role],
          "marketing-auto-dual",
          segment,
        );
        const mp4Path = path.resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp4`);
        await downloadVideo(url, mp4Path);
        log(`  段 ${i + 1} [${seg.role}] 生成 + 下載 OK`);
        return mp4Path;
      })
    );
  }

  // Step 4: ffmpeg concat（強制重編碼，避免段邊界吃幀；驗證階段確認過）
  log("\n--- Step 4: ffmpeg concat ---");
  const concatListPath = path.resolve(tmpDir, "concat-list.txt");
  fs.writeFileSync(concatListPath, segMp4s.map((p) => `file '${p}'`).join("\n"));
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:v libx264 -c:a aac -pix_fmt yuv420p "${outputMp4Path}"`,
    { cwd: PROJECT_DIR, stdio: "inherit" }
  );
  log(`✅ 雙人 concat 完成 → ${outputMp4Path}`);
}

function scriptSha256(scriptText) {
  return `sha256:${createHash("sha256").update(String(scriptText || "")).digest("hex")}`;
}

function audioDryRunMetadata(scriptText) {
  return {
    mode: "audio-driven",
    aspectRatio: "9:16",
    resolution: "1080p",
    expressiveness: "medium",
    scriptCharacters: Array.from(String(scriptText || "")).length,
    scriptSha256: scriptSha256(scriptText),
    avatarIdPresent: true,
    audioAssetIdSource: "minimax_then_heygen_upload",
    motionPromptPresent: Boolean(HEYGEN_MOTION_PROMPT),
  };
}

function textDryRunMetadata(scriptText, api) {
  return {
    mode: "text-driven",
    aspectRatio: "9:16",
    resolution: "1080p",
    expressiveness: HEYGEN_EXPRESSIVENESS,
    engine: api === "v3-text" ? "avatar_iv" : "v2-default",
    scriptCharacters: Array.from(String(scriptText || "")).length,
    scriptSha256: scriptSha256(scriptText),
    avatarIdPresent: true,
    voiceIdPresent: true,
    motionPromptPresent: Boolean(HEYGEN_MOTION_PROMPT),
    voiceSpeed: api === "v3-text" ? HEYGEN_VOICE_SPEED : null,
    voiceLocalePresent: api === "v3-text" && Boolean(HEYGEN_VOICE_LOCALE),
    brandGlossaryPresent: api === "v3-text" && Boolean(HEYGEN_BRAND_GLOSSARY_ID),
  };
}

function previewAudioRequest(planner, fallbackTitle, segment = null, scriptText = "") {
  const title = planner.titleFor(fallbackTitle, segment);
  return planner.preview({
    api: "v2-audio",
    title,
    segment,
    payloadMetadata: audioDryRunMetadata(scriptText),
  });
}

function previewTextRequest(planner, scriptText, fallbackTitle, segment = null) {
  const api = HEYGEN_V2_FALLBACK ? "v2-text" : "v3-text";
  const title = planner.titleFor(fallbackTitle, segment);
  return planner.preview({
    api,
    title,
    segment,
    payloadMetadata: textDryRunMetadata(scriptText, api),
  });
}

function buildHeyGenDryRunPlan(planner) {
  const scriptPath = resolve(PROJECT_DIR, "public/script.txt");
  if (!existsSync(scriptPath)) throw new Error("找不到 public/script.txt");
  const rawScript = readFileSync(scriptPath, "utf-8");
  const voiceRules = parseVoiceReplacements(rawScript);
  const mode = FIXED_ANCHOR_TEMPLATE ? "solo" : detectMode(rawScript);

  if (mode === "dual") {
    const segments = splitByRole(rawScript, voiceRules);
    if (segments.length === 0) throw new Error("雙人模式但切不出任何段");
    return segments.map((segment, index) => {
      const traceSegment = { index, total: segments.length, role: segment.role };
      return USE_MINIMAX
        ? previewAudioRequest(
          planner,
          "marketing-auto-dual",
          traceSegment,
          tradToSimpConverter(segment.text),
        )
        : previewTextRequest(planner, segment.text, "marketing-auto-dual", traceSegment);
    });
  }

  let cleanedScript = cleanScript(rawScript);
  for (const rule of voiceRules) cleanedScript = cleanedScript.split(rule.from).join(rule.to);
  if (TEMPLATE === "dapan") {
    if (!DAPAN_HEYGEN_VOICE_ID) throw new Error("大盤小報缺少 DAPAN_HEYGEN_VOICE_ID");
    return [previewTextRequest(planner, cleanedScript, "marketing-auto-dapan")];
  }
  if (TEMPLATE === "institution") {
    if (!INSTITUTION_HEYGEN_VOICE_ID) throw new Error("三大法人缺少 INSTITUTION_HEYGEN_VOICE_ID");
    return [previewTextRequest(planner, cleanedScript, "marketing-auto-institution")];
  }
  if (TEMPLATE === "focusstock") {
    if (!FOCUSSTOCK_HEYGEN_VOICE_ID) throw new Error("焦點股日報缺少 FOCUSSTOCK_HEYGEN_VOICE_ID");
    return [previewTextRequest(planner, cleanedScript, "marketing-auto-focusstock")];
  }
  return [
    USE_MINIMAX
      ? previewAudioRequest(planner, "marketing-auto", null, tradToSimpConverter(cleanedScript))
      : previewTextRequest(planner, cleanedScript, "marketing-auto"),
  ];
}

function runHeyGenDryRun() {
  if (SKIP_GENERATE || RENDER_ONLY) {
    throw new Error("--dry-run 不可與 --skip-generate 或 --render-only 混用");
  }
  const planner = createHeyGenRequestPreview({
    projectDir: PROJECT_DIR,
    argv: process.argv.slice(2),
    env: HEYGEN_TRACE_ENV,
  });
  const requests = buildHeyGenDryRunPlan(planner);
  const previewPlan = createHeyGenPreviewPlan(requests);
  console.log(JSON.stringify({
    dryRun: true,
    trace: planner.context,
    ledgerPath: planner.ledgerPath,
    requestCount: requests.length,
    approvalId: previewPlan.approvalId,
    requests,
  }, null, 2));
}

// ── 主流程 ────────────────────────────────

async function main() {
  // Dry-run 在 workspace lock、owner marker、key validation、staging mutation、child process 與任何
  // provider env/dotenv、MiniMax/HeyGen function 之前完成。付費路徑也只使用同一份啟動時
  // trace 快照；.env 僅能補 provider secrets，不能在 dry-run 後改寫 identity/title。
  // Dry-run 只讀 identity/script，ledger path
  // 僅供預覽，不建立 DATA_DIR、ledger、lock 或 reservation。
  if (DRY_RUN) {
    runHeyGenDryRun();
    return;
  }
  let paidPreviewApproval = null;
  if (!SKIP_GENERATE && !RENDER_ONLY) {
    const previewPlanner = createHeyGenRequestPreview({
      projectDir: PROJECT_DIR,
      argv: process.argv.slice(2),
      env: HEYGEN_TRACE_ENV,
    });
    const previewRequests = buildHeyGenDryRunPlan(previewPlanner);
    paidPreviewApproval = authorizeHeyGenPreviewPlan({
      requests: previewRequests,
      context: previewPlanner.context,
      providedApprovalId: PROVIDED_PREVIEW_APPROVAL,
    });
  }
  loadProviderEnvironment();
  // 0. 防止重複執行
  const lockFile = resolve(PROJECT_DIR, ".run.lock");
  const ownerFile = resolve(PROJECT_DIR, ".run.owner.json");
  const startedAt = new Date().toISOString();
  const workspaceRunToken = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(HEYGEN_TRACE_ENV.WORKSPACE_RUN_TOKEN || '') ? HEYGEN_TRACE_ENV.WORKSPACE_RUN_TOKEN : null;
  const ownership = { pid: process.pid, startedAt, token: workspaceRunToken };
  let lockFd;
  try {
    // 'wx' is the actual mutex. existsSync -> writeFileSync lets two simultaneous runners both win.
    lockFd = openSync(lockFile, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.error("❌ 偵測到腳本已在執行中！請等待完成再跑。");
    console.error("   請先確認 lock 記錄的 PID 已停止；未知舊 lock 需人工檢查，勿直接強制刪除。");
    process.exit(1);
  }
  process.on("exit", () => { try { require("fs").unlinkSync(lockFile); } catch(e) {} });
  try { writeFileSync(lockFd, JSON.stringify(ownership)); }
  finally { closeSync(lockFd); }
  // lock 會在 exit 時刪除；owner marker 則保留到下一個 run.js 取得工作區時覆寫。
  // server 重啟後藉由 job-specific token 判斷 public/ 目前究竟屬於哪一支工作。
  writeFileSync(ownerFile, JSON.stringify(ownership));
  // 被終止（關終端機=SIGHUP、Ctrl+C=SIGINT、kill=SIGTERM）時也清 .run.lock。
  // 注意：這不會讓生成繼續——關視窗 run.js 一樣會死、新 heygen.mp4 不會下載；
  // 只是死得乾淨、不留 lock 卡住下一次執行。
  for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.error(`\n⚠️ 收到 ${sig}（終端機被關/手動中斷），本次生成中止，清理 .run.lock`);
      process.exit(1); // 觸發上面的 exit handler → 刪 lock
    });
  }

  // --render-only：前台已經把配圖計畫確認過了，直接出片。
  // 不重跑 HeyGen／加速／轉字幕／OCR —— 那些的產物都還在 public/ 與 src/*.generated.json。
  if (RENDER_ONLY) {
    log("▶️  --render-only：沿用現有 public/ 與配圖計畫，直接 render");
    renderTemplate();
    return;
  }

  // 0. 檢查環境（--skip-generate 不會呼叫 HeyGen/MiniMax，不需要這些 key）
  if (!SKIP_GENERATE) {
    if (!HEYGEN_API_KEY) {
      console.error("❌ 缺少 HEYGEN_API_KEY（請填到 .env）");
      process.exit(1);
    }
    // MiniMax 只在 --minimax 時才需要。預設全部走 HeyGen 內建語音（2026-08-17 起）。
    if (USE_MINIMAX && (!MINIMAX_API_KEY || !MINIMAX_GROUP_ID)) {
      console.error("❌ 指定了 --minimax，但缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID（請填到 .env）");
      process.exit(1);
    }
  }

  const scriptPath = resolve(PROJECT_DIR, "public/script.txt");
  if (!existsSync(scriptPath)) {
    console.error("❌ 找不到 public/script.txt");
    process.exit(1);
  }
  if (!SKIP_GENERATE) {
    // Managed runs resolve the exact Project/Revision/Run through the job-specific workspace token.
    // Direct CLI runs require an explicit Project/Run or EXP/Revision identity. Any ambiguity fails
    // before the first paid create request.
    heygenRequestTracer = createHeyGenRequestTracer({
      projectDir: PROJECT_DIR,
      argv: process.argv.slice(2),
      env: HEYGEN_TRACE_ENV,
      previewApproval: paidPreviewApproval,
    });
    log(`HeyGen trace：${JSON.stringify(heygenRequestTracer.context)}`);
    log(`HeyGen ledger：${heygenRequestTracer.ledgerPath}`);
  }

  const templateLabel =
    TEMPLATE === "dapan" ? "📰 大盤小報"
    : TEMPLATE === "institution" ? "🏦 三大法人"
    : TEMPLATE === "focusstock" ? "🔍 焦點股日報"
    : "🎬 預設（起漲K線／籌碼K線投廣模板）";
  log(`版型：${templateLabel}${SKIP_GENERATE ? "（跳過生成，用現有 public/heygen.mp4）" : ""}`);

  // 先清掉 public/ 裡「非當前版型」的殘留素材，維持精簡（源頭都在 assets/，可再複製回來）
  cleanStaleStaging(PROJECT_DIR, TEMPLATE);

  // 固定主播版型：先把套版素材（intro-frame.jpg / header-overlay.png / bgm.wav）複製進 public/
  if (TEMPLATE === "default" && BRAND) {
    log(`複製投廣品牌素材：${BRAND}`);
    execFileSync(process.execPath, ["scripts/use-brand.js", BRAND], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
    });
  } else if (TEMPLATE === "dapan") {
    log("複製大盤小報套版素材");
    run("npm run use-dapan-assets");
  } else if (TEMPLATE === "institution") {
    log("複製三大法人套版素材");
    run("npm run use-institution-assets");
  } else if (TEMPLATE === "focusstock") {
    log("複製焦點股日報套版素材（客製版）");
    run("npm run use-focusstock-assets");
    if (WITH_AD) {
      log("複製籌碼K線投廣素材（外框／片尾／BGM）");
      run("npm run use-focusstock-ad-assets");
    }
  }

  const heygenPath = resolve(PROJECT_DIR, "public/heygen.mp4");

  // 圖片 OCR 版面偵測：不需要講者影片，先啟動，跟 HeyGen 生成平行跑（省下等待時間、
  // 且圖有問題時馬上就知道，不會等到影片生完才發現）。稍後在需要它的步驟前 await。
  const imageAnalysis = startImageAnalysis();

  if (SKIP_GENERATE) {
    // ── 跳過生成：直接用現有 public/heygen.mp4，不呼叫 HeyGen/MiniMax ──
    if (!existsSync(heygenPath)) {
      console.error("❌ --skip-generate 但找不到 public/heygen.mp4，請先手動放好影片檔");
      process.exit(1);
    }
    log("✅ 找到現有 public/heygen.mp4，跳過 HeyGen/MiniMax 生成");
  } else {
    await generateHeygenVideo(heygenPath);
  }

  // 自動備份：在「加速之前」先存檔，這樣原始速度的影片永遠救得回來。
  // （2026-08-12 踩到：備份排在加速之後，重跑兩次就把 72.5 秒的原檔洗成 50.4 秒且無法還原。）
  try {
    backupJob(PROJECT_DIR, TEMPLATE);
  } catch (e) {
    log("⚠️ 自動備份失敗（不影響出片）：" + e.message);
  }

  // 固定主播版型（大盤小報／三大法人／焦點股日報）加速 125%（保持音調）── 使用者定案：無論影片來源
  // （HeyGen 現生 or --skip-generate 手動放）都要套用。
  // 這是固定主播三條線「唯一」的加速點，generateHeygenVideo() 末尾那段已用 !FIXED_ANCHOR_TEMPLATE 擋掉。
  // 2026-08-17：原本這裡是 120%、而 generateHeygenVideo() 只擋 dapan，導致 institution／focusstock
  // 被連續加速兩次（1.25 × 1.2 ≒ 1.5 倍），講話斷句被壓爛。現統一成單次 125%。
  if (FIXED_ANCHOR_TEMPLATE && NO_SPEED) {
    log("⏩ 已指定 --no-speed，跳過 125% 加速（保留原始速度）");
  } else if (FIXED_ANCHOR_TEMPLATE) {
    speedUpHeygen(heygenPath, "固定主播版型");
  }

  // 收斂平行進行的圖片分析（通常在等 HeyGen 時就跑完了，這裡多半是立刻返回）
  if (imageAnalysis) {
    const r = await imageAnalysis;
    if (r.ok) {
      const tail = r.stdout.trim().split("\n").slice(-6).join("\n");
      log("✅ 版面偵測完成（與生成平行）：\n" + tail);
    } else {
      log("⚠️ 版面偵測失敗，沿用既有 regions（影片照樣出）。");
      log("   若要聚焦/高亮對位正確，Mac 請先安裝一次：brew install tesseract tesseract-lang");
    }
  }

  // 6. 跑 Remotion 後製（transcribe / correct-subtitles 兩版型共用；parse-script / 配圖 / render 各自版本）
  log("開始 Remotion 後製");
  run("npm run transcribe");
  run("npm run correct-subtitles");
  prepareShots();

  if (STOP_BEFORE_RENDER) {
    log("⏸  已指定 --stop-before-render：配圖計畫算好了，這裡停下不 render。");
    log("   前台會把計畫拿去給人看，確認後再用 --render-only 接著跑。");
    return;
  }
  renderTemplate();
}

/**
 * 解析腳本 ＋ 算配圖／聚焦計畫（會寫出 *-shots.generated.json 或 focus 設定）。
 * 抽出來是為了讓「算計畫」與「render」可以分兩次執行——前台要在中間插入人工確認關卡。
 * ⚠️ 手寫標記優先的規則不變：(shot:) / (imageN) / (focus:) 標到的段落自動一律不碰。
 */
function prepareShots() {
  if (TEMPLATE === "dapan") {
    run("npm run parse-script:dapan");
    try {
      run("npm run auto-shot:dapan");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  } else if (TEMPLATE === "institution") {
    run("npm run parse-script:institution");
    // 自動聚焦：不用在 script.txt 標注，程式比對「旁白數字 ↔ 圖上數字」自己決定
    // 哪一句要聚焦哪一區、框哪一格。手寫的 (focus:) 標記優先，自動只補其餘句子。
    try {
      run("npm run auto-focus");
    } catch (e) {
      log("⚠️ 自動聚焦失敗（不影響出片，只是這支不會有聚焦效果）：" + e.message);
    }
  } else if (TEMPLATE === "focusstock") {
    run("npm run parse-script:focusstock");
    try {
      run("npm run auto-shot");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  } else {
    run("npm run parse-script");
    try {
      run("npm run auto-shot:default");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  }
}

/** 只做 render。--render-only 會直接跳到這裡，沿用現有的 public/ 與 *.generated.json。 */
function renderTemplate() {
  if (TEMPLATE === "dapan") {
    // 同一份 heygen/字幕/腳本出兩支：直式先出，橫式後出（2026-08-10 使用者拍板）
    run("npm run render:dapan");
    log("✅ 直式完成！out/output-dapan.mp4");
    run("npm run render:dapan-landscape");
    log("✅ 完成！直式 out/output-dapan.mp4、橫式 out/output-dapan-landscape.mp4");
  } else if (TEMPLATE === "institution") {
    run("npm run render:institution");
    log("✅ 完成！輸出影片在 out/output-institution.mp4");
  } else if (TEMPLATE === "focusstock") {
    // 同一份 heygen／字幕／腳本出兩支（2026-08-11 使用者定案）：
    //   客製版 = 藍色版型＋開場卡；投廣版 = 籌碼K線外框＋片尾、無開場卡。
    run("npm run render:focusstock");
    if (WITH_AD) {
      run("npm run render:focusstock-ad");
      log("✅ 完成！客製版 out/output-focusstock.mp4、投廣版 out/output-focusstock-ad.mp4");
    } else {
      log("✅ 完成！out/output-focusstock.mp4（只出客製版；要投廣版請加 --with-ad）");
    }
  } else {
    run("npm run render");
    log("✅ 完成！輸出影片在 out/output.mp4");
  }
}

/**
 * 呼叫 HeyGen/MiniMax 生成 heygen.mp4（含單人/雙人偵測、125% 加速）。
 * 只在 !SKIP_GENERATE 時呼叫，抽出來讓 main() 的兩條路（生成 / 跳過生成）分岔更清楚。
 */
async function generateHeygenVideo(heygenPath) {
  const scriptPath = resolve(PROJECT_DIR, "public/script.txt");
  // 1. 讀取腳本 + 偵測單人/雙人模式（大盤小報固定單人，不偵測）
  log("讀取 script.txt");
  const rawScript = readFileSync(scriptPath, "utf-8");
  const voiceRules = parseVoiceReplacements(rawScript);
  const mode = FIXED_ANCHOR_TEMPLATE ? "solo" : detectMode(rawScript);
  log(`偵測模式：${mode === "dual" ? "🎭 雙人對話（含 [A]/[B] 標記）" : "🎤 單人講話"}`);

  if (mode === "dual") {
    // ── 雙人 path：切段 + N × MiniMax + N × HeyGen + ffmpeg concat ──
    const segments = splitByRole(rawScript, voiceRules);
    if (segments.length === 0) {
      console.error("❌ 雙人模式但切不出任何段。請檢查 script.txt 的 [A]/[B] 標記");
      process.exit(1);
    }
    const pair = randomPair();
    log("⏳ 雙人模式：N 段平行跑，請勿重複執行此腳本...");
    log("   預計等待 3-5 分鐘，請耐心等候 ☕");
    await runDualPath(segments, pair, heygenPath);
  } else if (TEMPLATE === "dapan") {
    // ── 大盤小報單人 path：HeyGen 內建語音直接生，不經 MiniMax ──
    if (!DAPAN_HEYGEN_VOICE_ID) {
      console.error("❌ 大盤小報要用 HeyGen 內建語音，但 DAPAN_HEYGEN_VOICE_ID 還是空值。");
      console.error("   去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v2/voices 找一個中文女聲 voice_id，填進 run.js 的 DAPAN_HEYGEN_VOICE_ID 常數。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁，直接送 HeyGen，不轉簡體、不經 MiniMax）：\n  ${cleanedScript}`);

    log(`固定 avatar（大盤小報）：${DAPAN_AVATAR.id}`);

    log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
    log("   預計等待 3-5 分鐘，請耐心等候 ☕");
    const videoUrl = await generateTextDrivenVideo(cleanedScript, DAPAN_AVATAR.id, DAPAN_HEYGEN_VOICE_ID, "marketing-auto-dapan");
    await downloadVideo(videoUrl, heygenPath);
  } else if (TEMPLATE === "institution") {
    // ── 三大法人單人 path：跟大盤小報同一套（HeyGen 內建語音、文字驅動、不經 MiniMax）──
    if (!INSTITUTION_HEYGEN_VOICE_ID) {
      console.error("❌ 三大法人要用 HeyGen 內建語音，但 INSTITUTION_HEYGEN_VOICE_ID 還是空值。");
      console.error("   去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v2/voices 找一個中文女聲 voice_id，填進 run.js 的 INSTITUTION_HEYGEN_VOICE_ID 常數。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁，直接送 HeyGen，不轉簡體、不經 MiniMax）：\n  ${cleanedScript}`);

    log(`固定 avatar（三大法人）：${INSTITUTION_AVATAR.id}`);

    log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
    log("   預計等待 3-5 分鐘，請耐心等候 ☕");
    const videoUrl = await generateTextDrivenVideo(cleanedScript, INSTITUTION_AVATAR.id, INSTITUTION_HEYGEN_VOICE_ID, "marketing-auto-institution");
    await downloadVideo(videoUrl, heygenPath);
  } else if (TEMPLATE === "focusstock") {
    // ── 焦點股日報單人 path：同大盤小報／三大法人（HeyGen 內建語音、文字驅動、不經 MiniMax）──
    if (!FOCUSSTOCK_HEYGEN_VOICE_ID) {
      console.error("❌ 焦點股日報要用 HeyGen 內建語音，但 FOCUSSTOCK_HEYGEN_VOICE_ID 還是空值。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁，直接送 HeyGen，不轉簡體、不經 MiniMax）：\n  ${cleanedScript}`);
    log(`固定 avatar（焦點股日報）：${FOCUSSTOCK_AVATAR.id}`);
    log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
    log("   預計等待 3-5 分鐘，請耐心等候 ☕");
    const videoUrl = await generateTextDrivenVideo(cleanedScript, FOCUSSTOCK_AVATAR.id, FOCUSSTOCK_HEYGEN_VOICE_ID, "marketing-auto-focusstock");
    await downloadVideo(videoUrl, heygenPath);
  } else {
    // ── 單人 path（投廣模板）──
    // 2026-08-17 起預設走 HeyGen 內建語音（文字驅動），跟固定主播三條線同一條路。
    // 加 --minimax 可退回原本的「MiniMax 配音 + HeyGen 音訊驅動」。
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }

    const avatar = randomAvatar();

    if (USE_MINIMAX) {
      // Reserve the exact create identity before MiniMax TTS or HeyGen upload can spend anything.
      const tracer = requireHeyGenRequestTracer();
      const heygenTitle = tracer.titleFor("marketing-auto");
      const simpScript = tradToSimpConverter(cleanedScript);
      const payloadMetadata = audioDryRunMetadata(simpScript);
      const ledgerRequestId = tracer.prepare({
        api: "v2-audio",
        title: heygenTitle,
        payloadMetadata,
      });
      log(`清洗後腳本（繁）：\n  ${cleanedScript}`);
      log(`簡體版（給 MiniMax）：\n  ${simpScript}`);
      log(`抽到 avatar：${avatar.id}（${avatar.gender === "male" ? "男" : "女"}）`);

      const paidStep = {
        tracer,
        ledgerRequestId,
        api: "v2-audio",
        title: heygenTitle,
        payloadMetadata,
      };
      const audioBuffer = await runVerifiedPaidStep({
        ...paidStep,
        operationKey: "minimax-tts",
        paidStep: () => minimaxTTS(simpScript, SOLO_VOICES[avatar.gender]),
      });
      const minimaxAudioPath = resolve(PROJECT_DIR, "public/minimax.mp3");
      writeFileSync(minimaxAudioPath, audioBuffer);
      log(`音檔備份 → ${minimaxAudioPath}`);

      const audioAssetId = await runVerifiedPaidStep({
        ...paidStep,
        operationKey: "heygen-audio-upload",
        paidStep: () => heygenUploadAudio(audioBuffer),
      });

      log("⏳ 正在呼叫 HeyGen，請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      const request = await createHeyGenVideo(
        audioAssetId,
        avatar.id,
        heygenTitle,
        null,
        ledgerRequestId,
        payloadMetadata,
      );
      const videoUrl = await pollHeyGenStatus(request);
      await downloadVideo(videoUrl, heygenPath);
    } else {
      log(`清洗後腳本（繁，直接送 HeyGen，不轉簡體、不經 MiniMax）：\n  ${cleanedScript}`);
      // 跟 MiniMax 時代一樣：抽到的 avatar 性別決定配音，只是 voice 換成 HeyGen 的。
      const heygenVoiceId = HEYGEN_SOLO_VOICES[avatar.gender];
      log(`抽到 avatar：${avatar.id}（${avatar.gender === "male" ? "男" : "女"}）→ HeyGen voice ${heygenVoiceId}`);

      log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      const videoUrl = await generateTextDrivenVideo(
        cleanedScript,
        avatar.id,
        heygenVoiceId,
        "marketing-auto"
      );
      await downloadVideo(videoUrl, heygenPath);
    }
  }

  // 加速 heygen.mp4 125%（保持音調）── 既有投廣模板（default）專用
  // 固定主播三條線（dapan／institution／focusstock）在 main() 內統一加速，這裡一律擋掉，
  // 避免同一支影片被加速兩次。2026-08-17 修正：原本只擋 dapan，institution／focusstock 漏網。
  if (!FIXED_ANCHOR_TEMPLATE && NO_SPEED) {
    log("⏩ 已指定 --no-speed，跳過 125% 加速（保留原始速度）");
  } else if (!FIXED_ANCHOR_TEMPLATE) {
    speedUpHeygen(heygenPath, "投廣模板");
  }
}

main().catch((err) => {
  console.error("\n❌ 錯誤：", err.message);
  process.exit(1);
});
