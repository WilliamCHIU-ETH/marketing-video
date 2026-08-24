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
| `CHIPK_CAPTURE_BIN` | 選用的 ChipK Capture `0.3.0` executable 絕對路徑 | 否 |
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

這個 gate 會在同一次執行保留 v1 screenshot 驗證，並讓 v2 prepared-video 的固定五項
artifact 實際通過 App 的 bytes／hash／media validator、Run staging、placement compile、
Project Asset／Revision selection 與 timeline-ready evidence。任何 raw fallback 都會使 gate
失敗；synthetic driver 必須交付可實際解碼的無音軌 H264 MP4，不接受只宣告 media metadata。

目前 runtime lock 是 Provider ID `chipk-simulator-capture`、tool version `0.3.0`。舊的
screenshot／record 仍使用 contract v1；ready-to-place 使用 contract v2，並必須從
`contractCapabilities` 的 v2 entry 精確選到已支援的 presentation profile 與
`stockIds: ["3441"]`。正式 Provider release 為 annotated `v0.3.0`，解參照後固定指向
`586fbe7414ab0c25d78ae6e462887fe72030e0a7`；CLI runtime 只驗可觀測的
ID／contract／tool version，不宣稱能在執行時驗證 Git metadata。

v0.3.0 尚未廣告 `runReadiness.vipSession=verified_before_mutation`。因此目前只允許
capabilities／preflight／synthetic conformance；`mode=live` prepared-video 會在呼叫 Provider
acquire 前以 `provider_live_readiness_unverified` fail closed。不得把 active
`CHIPK_CAPTURE_BIN` 指向此版本執行 live acquire，也不得降級成 screenshot／raw recording。

### Agent 預設：把 ChipK 手機畫面放進影片

使用者只描述「把 ChipK 的某個手機畫面放進影片」時，Agent 預設要形成
ready-to-place intent，不是只擷圖、只取 raw recording，也不是先存成一般
B-Roll 再人工剪輯。這條路徑一律 `require-capture`；Provider／profile／hash／placement
任一條件不成立就停止，不 fallback 成 raw 或既有圖片。

第一個已支援的垂直切片是 Focusstock workflow 的「聯一光 3441 主力頁」。
以下是 live cutover gate 未來解除後的正式 shape（標題與講稿仍由當次影片提供）；目前
v0.3.0 不得送出此 live acquisition：

```json
{
  "template": "focusstock",
  "withAd": false,
  "title": "聯一光主力觀察",
  "body": "今天看聯一光的主力動向，接著說明籌碼變化。",
  "voice": "",
  "owner": "當次操作者",
  "workflowMode": "manual-assets",
  "controlPolicy": "auto",
  "materialAcquisition": {
    "policy": "require-capture",
    "operation": "prepared-video",
    "mode": "live",
    "route": "chipk.stock.main-force",
    "stock": { "id": "3441", "name": "聯一光" },
    "presentation": {
      "profileId": "chipk.stock-main-force-portrait.v1"
    },
    "placement": {
      "layoutId": "focusstock-phone-portrait.v1",
      "anchor": { "phrase": "聯一光的主力動向" }
    }
  }
}
```

`POST /api/jobs` 只建立 `status: "draft"` 的 Project／Revision／Run，不會自行開始。
Agent 必須從 response 讀出 `job.id`，再完成第二個 request：

```http
POST /api/jobs/<response.job.id>/submit
Content-Type: application/json

{}
```

第二步成功後 response 的 `job.status` 必須是 `queued`，且有 `submittedAt`；若沒有呼叫
`submit`，這支工作會一直是 draft，Capture、placement 與 render pipeline 都不會執行。
`withAd: true` 不在第一個垂直切片內，建立 job 時會直接拒絕。

Agent 預設要從本次 `body` 選一段只出現一次、可由人讀回確認的原文放進
`anchor.phrase`。Server 會用字幕流程共用的 script cleaner，將這段原文解析成 cleaned
script body 的 `startCharIdx`；找不到或出現超過一次都會在建立 job 時停止。不要自行用
API `body` 的 raw string index，因為標點、空白、標記與發音替換都會改變 cleaned index。

只有使用者明確指定成片時間時，才把 placement 改成 `startSec`：

```json
{
  "layoutId": "focusstock-phone-portrait.v1",
  "startSec": 12.5
}
```

`startSec`／anchor 解出的秒數以 `focusstock-main-v1` 主段為基準。成片前面固定有 1 秒
intro；timeline evidence 會另外保存 composition-resolved 的 start/end frame 與秒數，UI
顯示的是成片時間，避免下游把主段秒數誤當成整支成片秒數。

Capture 交付的 MP4 內部已完成手機內的焦點、縮放、強調與 hold。Marketing Video
只決定 scene container 和 timeline placement；整支 clip 必須從第 0 frame 播放一次、
1x、muted、`objectFit: contain`，不 crop／trim／loop／變速／改手機內部運鏡。
建立下一個 Revision 時，上一版的 `prepared-phone-video` 不會作為一般 B-Roll 沿用；
下一版若仍需要手機畫面，Agent 必須重新送出 ready-to-place intent 與本版 placement。

同一個 ready-to-place Run 可以在建立時用 `reuseAssetIds` 選取該 Project 已有的圖片。
每張圖片都必須由 `focusstock-shots.generated.json` 透過同一份字幕字元時間軸解出 placement；
系統會以 renderer 相同的 2 秒規則合併連續同圖 runs，再用 renderer 實際採用的 half-open
frame interval 將與 prepared 區間相交的整個 run 標成 `suppressed_by_prepared`，其餘標成
`rendered`。任一圖片未被引用、
來源不屬於選取素材、char index 無法解時，整個 Run 停止。ready-to-place 草稿建立後不接受
追加圖片或影片；一般影片 B-Roll 尚未接上可驗證的 Focusstock placement，因此也不能與這條
路徑同時選用。

ready-to-place 若沿用或上傳既有講者 MP4，系統會固定 `skipGenerate=true` 與 `noSpeed=true`，
避免重新付費生成或把已完成的 Project Asset 再次轉速成另一份 bytes；本輪新生成的講者不受此限制。

## 歷史資料盤點

```bash
npm run cleanup:plan -- --root='/Users/chiu/Downloads/marketing-video 2'
```

這個命令只有讀取能力，不提供 apply 或 force。若回傳 exit code 2，JSON 會是 `complete=false`、`safeToApply=false`，代表資料完整性異常，任何清理都必須停止。沒有 archive digest 證據的 terminal job payload 也只會列為 manual。

## 已知邊界

- 新建立的影片使用 `Project → Revision → Run`；既有 Job 不會自動 migration，也不會被搬移或刪除。
- Project Asset 分成圖片、一般 B-Roll 影片、講者影片與 `prepared-phone-video`。後者只有在 placement 編譯完成後才會被 Revision 選中，不與一般可剪輯 B-Roll 混用。相同內容與角色依 SHA-256 去重，Run 暫時副本被清理後仍保留 Project 素材。
- 成功的 Project Run 只有在每份正式 output 都能從 Project `outputs/` 驗證存在且 size 相符後，才會立即清除 `input/`、`state/`、`thumbs/` 與 `out/`。ready-to-place Run 還必須驗證 Project clip、placement 與 Render evidence，才會移除 acquisition 內重複的 prepared MP4／screenshot；三份 JSON sidecar 與 provider evidence 保留為小型 audit record，並在 job metadata 標記 `sidecars_only`。failed／cancelled acquisition 只在一般 retention 到期後清除。小型 `job.json`／`log.txt` 暫時保留；active、review、detached、failed 或缺少 durable output 的 Run 不走立即清理路徑。
- 前端若在素材上傳或送出前失敗，會回收剛建立的 draft Revision；全新影片會連同空 Project 一起回收，既有 Project 則保留先前版本與既有素材，不讓重試直接跳號。
- 一般 B-Roll 保存於 Project 仍不等於已進 timeline；只有通過 v2 plan／hash／placement／render-input gate 的 `prepared-phone-video` 可宣稱本 Revision 已配置使用。

- `npm start` 是 Remotion Studio，不是 localhost 使用者前台。
- 完整 pipeline 仍需要 `ffmpeg`、`ffprobe`、`whisper-cli`、已校驗的 base-q5_1 模型與 `tesseract`。
- 原專案兩個 `.ttf` 實際是 HTML，候選 repo 刻意不納入；正式 render 前要補回有效且授權清楚的 Noto Sans TC 字型。
- LAN 認證尚未完成；不可把目前版本直接開到 `0.0.0.0`。
- `public/` 與部分 `src/*.generated.json` 仍是共用 mutable workspace；這是下一階段解耦範圍。
