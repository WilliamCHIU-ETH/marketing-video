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
| `CHIPK_CAPTURE_BIN` | 選用的 ChipK Capture `0.3.1` executable 絕對路徑；只開放 contract v1，v2 live 仍關閉 | 否 |
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

目前 runtime lock 的 Provider ID 是 `chipk-simulator-capture`，tool version 是 `0.3.1`，
但能力必須分 contract 判斷：

- contract v1 的 screenshot／record 使用 `0.3.1`，通過既有 policy 與 artifact validation 後可用；晨報 CTA 實機擷取屬此路徑。
- contract v2 的 ready-to-place 仍須精確選取 `contractCapabilities` v2 entry、presentation profile 與 `stockIds: ["3441"]`，但 `readyToPlaceLiveEnabled: false` 明確關閉所有 live prepared-video acquisition。Synthetic conformance 不受影響。

lock 的 release 欄位是 tag `v0.3.1`、commit `null`、status
`pending-provider-attestation`，不得解讀為 release identity 已驗證。Provider CLI 對
Marketing Video 只揭露 `capabilities` 與 `acquire` 兩個命令，不揭露 release commit；
Marketing Video 也不進 provider repo 取 Git metadata。只有 Provider owner 或 release CI
交付含 tag、commit、binary digest 的不可變 release manifest 後，status 才可改為 `released`。

Provider `0.3.1` 確實廣告 `runReadiness.vipSession=verified_before_mutation`，但這不會打開
v2 live。App 會先以 `readyToPlaceLiveEnabled` 做 contract-specific gate；目前的 `false` 使
`mode=live` prepared-video 在 Provider acquire 前以
`provider_ready_to_place_live_disabled` fail closed。不得用 Provider readiness、版本相符或
profile 存在作為開啟理由，也不得降級成 screenshot／raw recording。

### 確認 v2 live 仍被關閉

從 repo root 執行以下唯讀檢查與 Provider-free 測試；不要送真實 live job 來測 gate：

```bash
node - <<'NODE'
const lock = require('./config/chipk-capture-provider.lock.json');
if (lock.readyToPlaceLiveEnabled !== false) process.exit(1);
console.log('readyToPlaceLiveEnabled=false');
NODE
npm run test:material-provider
```

第一段必須輸出 `readyToPlaceLiveEnabled=false`。測試必須證明：即使 `0.3.1` capabilities
廣告 VIP session readiness，v2 live 仍回
`provider_ready_to_place_live_disabled`，且 Provider acquire 呼叫次數是 0。欄位缺少或
不是布林 `true` 時也必須 fail closed；只有正式 cutover 把它設成 `true` 後，流程才可繼續
接受既有 VIP session readiness gate。

### 緊急退回 0.3.0

1. 先停止 server 與 worker，避免同時存在兩套 consumer lock。
2. 將 `config/chipk-capture-provider.lock.json` 的 `toolVersion` 改回 `0.3.0`，並把 release 一起改回：

   ```json
   {
     "tag": "v0.3.0",
     "commit": "586fbe7414ab0c25d78ae6e462887fe72030e0a7",
     "status": "released"
   }
   ```

3. 保持 `readyToPlaceLiveEnabled: false`，並讓 `CHIPK_CAPTURE_BIN` 與 lock 一起切回相符的 `0.3.0` executable；不得用環境變數繞過版本檢查。
4. 重跑 `npm run test:material-provider`、`npm run doctor` 與 `npm run smoke`，通過後才重啟服務；版本化文件要與 rollback commit 一起更新。

rollback 會同步撤回 `0.3.1` 的 contract v1 CTA 實機擷取能力；退回後必須把 CTA live capture
視為不可用並明確回報，不得讓 `0.3.1` binary 對著 `0.3.0` lock 執行，也不得以生成圖冒充。
contract v2 live 前後都維持關閉。

### CTA 擷取的兩個入口：人用 npm，agent 直呼 node

同一支 command 有兩種呼叫方式，**用途不同，不要混用**。

人（operator、手動除錯）：

```bash
npm run material -- capture-cta --project <absolute-project-path> --stock-id <stock-id> --json
```

保留這條是為了可發現性——`npm run` 列得出來。

Agent（Capture subagent、任何程式化呼叫）一律直呼：

```bash
node /Users/chiu/Developer/marketing-video/app/scripts/material.js \
  capture-cta --project <absolute-project-path> --stock-id <stock-id> --json
```

**理由是 stdout 的所有權。** 這個介面的契約是「stdout 是可解析的 JSON」，而 npm 從未承諾
stdout 乾淨：`--silent` 只壓住當前這一版的 lifecycle banner，未來 npm 改版、使用者的
`loglevel` 設定、或任何 lifecycle hook 都能重新注入非 JSON，靜默弄壞每一個呼叫端。
直呼 node 讓 stdout 完全由 Marketing 的 command 擁有。這不繞過 Port／Adapter，只繞過 npm。

直呼不依賴 cwd：`scripts/material.js` 的 require 是檔案相對的，從任何目錄執行結果相同。

#### exit code 與輸出的對應（呼叫端必須分開處理）

| exit | 意義 | stdout | stderr |
|---|---|---|---|
| 0 | 成功 | 單一 JSON，`status: completed` | 空 |
| 1 | 執行期失敗 | 單一 JSON，`status: failed` | 空 |
| 3 | 需要人工處理 | 單一 JSON，`status: human_action_required` | 空 |
| 2 | **參數錯誤** | **空** | 純文字錯誤訊息 ＋ usage |

exit 2 是唯一沒有 JSON 的情況。呼叫端不可以只做 `JSON.parse(stdout)` 就當成功失敗判斷，
要先看 exit code；exit 2 時去讀 stderr。

### Agent 路由：v2 live 目前不可用

目前 `readyToPlaceLiveEnabled: false`。使用者只描述「把 ChipK 的某個手機畫面放進影片」
時，Agent 必須明確回報 v2 live 尚未開放，不得建立或送出 live prepared-video request，
也不得 fallback 成 raw、screenshot 或既有圖片。正式 v2 cutover 審查通過並把 flag 設為
`true` 後，預設才是形成 `require-capture` 的 ready-to-place intent，而不是只取 raw
recording 或先存成一般 B-Roll；Provider／profile／hash／placement 任一條件不成立仍須停止。

第一個規劃中的垂直切片是 Focusstock workflow 的「聯一光 3441 主力頁」。以下 JSON 是
v2 live cutover 未來解除後的正式 shape（標題與講稿仍由當次影片提供），不是目前可執行的
操作；即使 Provider 是 `0.3.1`，flag 為 false 時也不得送出：

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

上述 JSON 在 `readyToPlaceLiveEnabled: false` 時不得 POST 或 submit。以下建立、送出、
placement 與 playback 步驟只適用於 flag 經正式 cutover 改為 `true` 之後。

cutover 後，`POST /api/jobs` 只建立 `status: "draft"` 的 Project／Revision／Run，不會自行開始。
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
