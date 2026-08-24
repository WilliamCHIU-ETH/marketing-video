# Localhost operator runbook

## 目的

先證明 UI、API、job storage 與啟動契約可重建；這份 runbook 不會觸發付費影片生成。

## 安裝

```bash
cd /Users/chiu/Developer/marketing-video/app
nvm install
nvm use
brew install ffmpeg whisper-cpp tesseract tesseract-lang
npm ci
npm run setup:whisper
```

目標 runtime 是 Node 22 LTS。`npm ci` 必須以 `package-lock.json` 為唯一 Node.js 依賴來源；FFmpeg、`whisper-cli`、Tesseract 與模型權重屬於主機／runtime dependency，不會出現在 lockfile，改由上述安裝命令與 `doctor:full` 驗證。

## 啟動前檢查

```bash
npm run doctor
npm run smoke
```

- `doctor` 預設只以 localhost startup blocker 決定 exit code。
- `doctor:full` 會把 `whisper-cli`、模型檔與 SHA-256、FFmpeg、Tesseract、npm packages 等完整出片條件納入 gate。
- `smoke` 使用 repo 外的 OS 暫存目錄、`TEST_MODE=1` 與停用 worker；provider keys 會被清空，child process／outbound network 嘗試會被 guard 擋下並使測試失敗。

## 啟動 localhost

```bash
npm run dev:server
```

- UI：<http://localhost:4000>
- Health：<http://localhost:4000/api/health>
- 影片專案：`runtime-data/projects/`（Project、Revision、共用素材與新格式成品）
- Run 工作區：`runtime-data/jobs/`（每次執行隔離，依保留策略清理）
- Legacy archive：`runtime-data/archive/`（舊格式 Job 成品，不自動搬移）
- 大型品牌素材：workspace `data/assets/`，透過 ignored 的 repo-local `assets` symlink 使用

正常 health 至少應包含：

```json
{
  "ok": true,
  "mode": "normal",
  "workerEnabled": true
}
```

按 `Ctrl+C` 關閉 server。

## 環境變數

Server、`doctor` 與 ASR 的 setup／transcribe entrypoints 都會讀取 repo root 的 `.env`；既有 shell／launchd 環境變數優先，不會被 `.env` 覆蓋。需要自訂設定時可複製 `.env.example`，將 `.env` 權限設為 `600`，且不要加入 Git。

| 名稱 | 用途 | localhost 是否必要 |
|---|---|---|
| `HOST` | 預設 `127.0.0.1` | 否 |
| `PORT` | 預設 `4000` | 否 |
| `DATA_DIR` | projects、jobs 與 legacy archive 根目錄 | 否 |
| `DISABLE_WORKER` | 只啟動 UI/API，不執行 queued job | 否 |
| `AUTO_PRUNE_ON_START` | 啟動時套用 retention；預設關閉 | 否 |
| `HEYGEN_API_KEY` | 付費 HeyGen 工作 | 否 |
| `MINIMAX_API_KEY` | MiniMax fallback | 否 |
| `MINIMAX_GROUP_ID` | MiniMax fallback | 否 |
| `OPENAI_API_KEY` | 選用的 AI 生圖／判圖腳本 | 否 |
| `CHIPK_CAPTURE_BIN` | 選用的 ChipK Capture `0.2.1` executable 絕對路徑 | 否 |
| `WHISPER_MODEL_PATH` | 本機 whisper.cpp 模型；預設 `.cache/whisper/ggml-base-q5_1.bin` | 僅 ASR |
| `WHISPER_MODEL_SHA256` | 模型校驗碼；換自訂模型時必須同步設定 | 僅 ASR |
| `WHISPER_THREADS` | CPU thread 數；預設 `4` | 僅 ASR |
| `WHISPER_DEVICE` | `cpu`（可重現預設）或 `auto` | 僅 ASR |

## 選用的 ChipK Capture Provider

只有 job 明確包含 Capture intent 且 policy 不是 `disable-capture` 時，App 才會 probe
Provider。把 machine-local executable 絕對路徑放在 ignored `.env`；不要把 sibling source、
絕對路徑或 Provider 產物加入 App Git：

```bash
CHIPK_CAPTURE_BIN=/absolute/path/to/chipk-simulator-capture/bin/chipk-capture.js
```

跨 repo 相容性驗證使用 Provider 專用的 synthetic conformance executable，不操作
Simulator：

```bash
npm run test:chipk-provider-compat -- \
  --provider-bin /absolute/path/to/chipk-simulator-capture/test/conformance-cli.js
```

目前 runtime lock 是 Provider ID `chipk-simulator-capture`、contract `1`、tool version
`0.2.1`；release candidate identity 是 tag `v0.2.1`、commit
`b19f264aa1576bd6f1a24b2f20dbffef59f7ebb0`。正式 tag 前仍需 release-owner review；CLI runtime 只驗可觀測的 ID／contract／tool
version，不宣稱能驗證 Git metadata。

## 歷史資料盤點

```bash
npm run cleanup:plan -- --root='/Users/chiu/Downloads/marketing-video 2'
```

這個命令只有讀取能力，不提供 apply 或 force。若回傳 exit code 2，JSON 會是 `complete=false`、`safeToApply=false`，代表資料完整性異常，任何清理都必須停止。沒有 archive digest 證據的 terminal job payload 也只會列為 manual。

## 已知邊界

- 新建立的影片使用 `Project → Revision → Run`；既有 Job 不會自動 migration，也不會被搬移或刪除。
- Project Asset 分成圖片、一般 B-Roll 影片與講者影片。前台接受 PNG／JPEG 及 MP4／MOV／M4V／WebM，會驗證實際檔案內容、保存 durable copy 並支援跨 Revision 引用；一般 B-Roll 不會被當成 `heygen.mp4`。相同內容與角色依 SHA-256 去重，Run 暫時副本被清理後仍保留 Project 素材。
- 成功的 Project Run 只有在每份正式 output 都能從 Project `outputs/` 驗證存在且 size 相符後，才會立即清除 `input/`、`state/`、`thumbs/` 與 `out/`。小型 `job.json`／`log.txt` 暫時保留；active、review、detached、failed 或缺少 durable output 的 Run 不走這條立即清理路徑。
- 前端若在素材上傳或送出前失敗，會回收剛建立的 draft Revision；全新影片會連同空 Project 一起回收，既有 Project 則保留先前版本與既有素材，不讓重試直接跳號。
- 目前自動 OCR／素材配置／Remotion 合成仍只消費圖片；B-Roll 已可加入、預覽及沿用，但「保存於 Project」不等於「已自動剪入成片」。

- `npm start` 是 Remotion Studio，不是 localhost 使用者前台。
- 完整 pipeline 仍需要 `ffmpeg`、`ffprobe`、`whisper-cli`、已校驗的 base-q5_1 模型與 `tesseract`。
- 原專案兩個 `.ttf` 實際是 HTML，候選 repo 刻意不納入；正式 render 前要補回有效且授權清楚的 Noto Sans TC 字型。
- LAN 認證尚未完成；不可把目前版本直接開到 `0.0.0.0`。
- `public/` 與部分 `src/*.generated.json` 仍是共用 mutable workspace；這是下一階段解耦範圍。
