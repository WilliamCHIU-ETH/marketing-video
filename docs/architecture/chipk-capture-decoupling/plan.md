# Marketing Video × ChipK Capture 解耦計畫

Status: `IMPLEMENTED — PROVIDER v0.2.0 RELEASED AND PINNED`

Last verified: `2026-08-21 Asia/Taipei`

這份文件只鎖定跨 repository 的邊界、遷移順序與完成條件。Capture 的操作方法、route catalog、Simulator 規則與 JSON schema 細節由 Capture repo 自己維護。

## 1. Decision

Marketing Video 是能獨立完成影片的核心產品；ChipK Simulator Capture 是獨立、可選安裝、可替換的素材 provider。

```text
Marketing Video = 影片工作流、素材編排與交付
ChipK Capture   = 可拔除的 Simulator 素材取得工具

沒有 Capture：Marketing Video 仍可使用既有素材完成 E2E
接上 Capture：Marketing Video 可要求 fresh PNG 或 raw recording
```

只保留兩個 repositories：

1. `/Users/chiu/Developer/marketing-video/app`：Marketing Video repo。
2. `/Users/chiu/Developer/marketing-video/chipk-simulator-capture`：self-contained Capture repo。

本輪不拆第三個 core repo，不建立 HTTP service、daemon、plugin marketplace 或通用多 App DSL。

本批工作分類為 Product Support／Engineering Maintenance，不是 Product Core。交付只鎖三個 runtime gates：真實 standalone screenshot、真實 connected screenshot 到 Project Asset／Revision／timeline reference，以及 provider absent／disabled regression。Raw MP4 自動進 timeline、額外 contract hardening、catalog governance、scanner／敏感 taxonomy 擴充與舊 source cleanup 全部 On Hold，另案處理。

## 2. Ownership

### Marketing Video 擁有

- Project → Revision → Run 影片工作流。
- 從腳本與 shot planning 定義素材需求。
- `MaterialAcquisitionPort` 與 optional-provider policy。
- `ChipKCaptureCliAdapter`；只做 child process／JSON 轉譯，不 import Capture source。
- caller-owned job-scoped acquisition directory，以及回傳素材的路徑、hash、MIME 與媒體規格驗證。
- 將通過驗證的素材 ingest 為 Project Asset。
- fallback、Zoom、HyperFrames、字幕、品牌、正式剪輯與交付 QA。

Marketing Video 不直接操作 `simctl`、OCR、Deep Link 或 Simulator gestures。

### ChipK Capture 擁有

- Capture CLI 與 versioned JSON contract。
- ChipK Capture skill、route catalog、stock directory 與 route ranking。
- Simulator／App preflight、session evidence、導航與 readiness checks。
- Screenshot、raw recording、actions／manifest 與 acquisition evidence。
- 自己的 unit、contract 與 Simulator E2E tests。

Capture 不認識 Marketing Video 的 Project、Revision、Remotion、HyperFrames、HeyGen、fallback 或 final delivery，也不 import 或寫入 Marketing Video source。

## 3. Port / Adapter Contract

```text
Marketing Video
  → MaterialAcquisitionPort
  → ChipKCaptureCliAdapter
  → child process + JSON
  → chipk-capture CLI
  → Simulator
```

- Port 與 fallback policy 屬於 Marketing Video；CLI protocol 屬於 Capture repo。
- Marketing Video 只依賴相容的 contract version，不依賴 Capture 內部 controller。
- 兩邊不共用 source import、symlink、Git submodule 或寫死的機器絕對路徑。
- 本機以 ignored `CHIPK_CAPTURE_BIN` 指向已驗證的 versioned checkout；PATH 仍是 fallback，
  但 Provider ID、contract 與 tool version 必須符合 App-owned lock。
- Request 至少包含 contract version、request ID、operation、route／參數及 caller-owned output directory。
- Result 至少包含 request ID、status、typed error、relative artifact paths、hash、媒體規格與 acquisition evidence。
- Capture 只能寫 caller 提供的 job-scoped directory；Marketing Video 驗證後才 ingest。

Policy 維持三種：`disable-capture` 不探測 provider；`prefer-capture` 失敗時標示 evidence limitation 並 fallback；`require-capture` 失敗時不得假裝取得 fresh material。

## 4. Source-only Repository Policy

Capture remote 是 source repository，不是素材庫或執行證據庫。本機 checkout 可在 repo-local `.runtime/` 保存產物，但該目錄完整 ignored，不進 Git history。

只有同時符合以下條件的內容才進 Git：

- clean clone 為了理解、建置、測試或操作穩定行為而需要；
- 內容可 review、可重現，屬於 source、schema、規則、文件、測試或 sanitized deterministic fixture；
- 不包含特定 run、裝置、帳號、session、時間點或使用者畫面的狀態；
- 適合長期留在 private remote history。

符合任一以下條件的內容只進 `.runtime/` 或其他 ignored path：

- 由 capture、record、OCR、test、build 或 Simulator 執行產生；
- 是 screenshot、recording、PDF、manifest、actions sidecar、log、cache、temporary file 或 build output；
- 含有或可能含有 credential、session、帳號狀態、產品畫面或本地機器資訊；
- 可由 source、規則或外部 runtime 重新產生。

遇到未預期的新類型時，先放 ignored runtime、繼續開發；只有 clean clone 確實需要且完成 sanitization review 後，才提升為 versioned source。不要為了先列完所有副檔名阻塞 migration。

Sibling repo 的 `AGENTS.md` 必須保存上述判斷準則；`.gitignore` 必須忽略 `.runtime/` 與常見生成物；source-only check 必須檢查 tracked paths，避免 ignored 檔被強制加入或既有產物留在 history。

## 5. Current State

- Marketing Video 與 Capture 的解耦實作已分別合併至兩個 repository 的 `main`；Capture 的
  唯一 versioned source 位於 sibling repo，App 只保留 Port、Adapter、policy、ingest 與
  consumer tests。
- Provider release `v0.2.0` 指向 commit
  `87c033bed59fd53242b1679bc71b39fb20a11832`；App 以 Provider ID、contract v1 與 tool
  version `0.2.0` 作 runtime lock，並另記 immutable tag／commit provenance。
- 非 Simulator 的 cross-repo conformance gate 已直接串接 sibling test driver 的 production
  CLI／contract／runtime seam，驗到 App path／hash／MIME validation 與 Project Asset ingest；
  普通 App tests／smoke 仍完全 provider-free。
- Standalone 真實 screenshot 已通過：provider `0.2.0` 由指定 Simulator 產出 PNG／manifest，hash、完整 decode、route／content evidence 與 ignored runtime 邊界均驗證完成。
- Connected 真實 screenshot 已通過：`require-capture` 經 production Adapter 驗 path／hash／MIME 後 ingest 為 Project Asset，Job／Revision 保存 `fresh_capture` 與 asset reference，實際 parser／timeline consumer 引用同一 `shot1.png`。
- Provider absent／no-intent、`disable`、`prefer`、`require` regression、typecheck 與完整 provider-free smoke 已通過。
- Pixel-level final Remotion render 尚未驗證；本輪 synthetic MP4 只證明 durable Run／Revision output transition，不作畫面已進成片的證據。

## 6. Migration

### A. Inventory and freeze

1. 記錄 `app` 內 Capture source、tests 與必要 non-secret fixtures 的清單、hash 和測試結果。
2. 只帶入 source 與已核准的 sanitized fixtures；secret、runtime session 與正式素材不得進 Git。
3. 建立正式 self-contained sibling clone，不使用 linked worktree 作長期 repo。
4. 在 sibling 建立 `AGENTS.md`、repo-local `.runtime/`、`.gitignore` 與 source-only check。
5. 完成初始 copy 後凍結 `app` Capture source；後續 Capture 修改只寫 sibling repo。

Gate：沒有唯一 source 遺漏，沒有 dirty user file、runtime artifact 或 worktree 被移除。

### B. Copy and standalone validation

1. Copy 最新 skill、capture／session／recording runtime、catalog tooling、recipes 與 tests 到 sibling repo。
2. 調整 repo-local paths 與 package entrypoints，不為了解耦重寫已通過的 capture logic。
3. 通過 provider 自己的 unit、contract、catalog 與 recipe tests。
4. 本批只對 screenshot 跑真實 standalone request；輸出只留在 ignored runtime，並驗證 artifact、manifest、hash 與完整 decode。Record runtime 驗收 On Hold。

Gate：Capture 不需要 Marketing Video source 或 runtime 即可產出 verified screenshot bundle；`app` 舊 copy 仍完整保留。

### C. Adapter integration

1. 在 Marketing Video 實作 production CLI adapter，不 source-import provider。
2. 在 `doPrepare()` 清理 shared workspace 前透過 Port 呼叫 provider。
3. 驗證 Result 後 ingest 為 Project Asset，並保存 provider／contract version 與 evidence limitation。
4. 驗證 `disable`、`prefer`、`require` 三種 policy。
5. 最小 connected E2E 使用目前 pipeline 已能消費的 PNG；raw MP4 自動剪入另案驗收。

Gate：Capture 未安裝時 Marketing Video 仍可 E2E；安裝後真實 request → result → ingest → Project Asset／Revision → timeline reference 可追溯。Pixel render 不在本批 claim 內。

### D. Cutover and cleanup

1. 更新 workspace 與 Marketing Video 的 agent routing，改指向 sibling provider。
2. 確認 sibling source 已有可恢復的 commit／remote protection。
3. 舊 source deletion plan、archive 與 cleanup 全部 On Hold；另經明確授權後才處理。

Gate：Capture 的唯一 versioned source 是 sibling repo；Marketing Video 只剩 Port、Adapter、policy、ingest 與 consumer tests。

## 7. Completion Criteria

- Marketing Video 沒有 Capture 仍能完成 provider-free E2E。
- Capture 沒有 Marketing Video 仍能產出 verified artifact bundle。
- Connected flow 可由 request 追到 result、hash、Project Asset、Revision 與實際 timeline reference；pixel render 另案驗收。
- Capture 內部實作改變但 contract 相容時，Marketing Video 不需修改 source。
- Capture 不反向依賴或直寫 Marketing Video。
- Capture remote 只有 source、規則與 sanitized deterministic fixtures；本地生成物只存在 ignored runtime。
- Source-only check 能阻擋 runtime output 被 Git tracked。
- standalone 與 adapter 驗證完成前，`app` 舊來源保持可恢復。

## 8. Irreversible / High-cost Conflict Guards

遇到以下情況立即停止該步驟並保留現狀：

- 即將刪除的位置仍包含唯一 source、未 push commit、dirty file 或唯一 artifact。
- `app` 與 sibling 同時被修改，無法判定 canonical writer。
- 準備把 password、token、cookie、MFA、runtime session、正式素材或未核准內部 snapshot 寫入 Git／remote history。
- Provider 必須 import Marketing Video source，或直寫 `public/`、`src/`、Project store 等共享位置才能運作。
- Adapter integration 破壞 Marketing Video provider-free E2E。
- 要移除 worktree、舊 source 或改寫 remote history，但尚未有 standalone、connected E2E 與可恢復 commit 證據。

真正需要重開 Decision 的情況只有：必須改變 repo 數量、ownership、CLI/JSON 單向依賴，或 Marketing Video 無法在沒有 Capture 時獨立完成 E2E。

## 9. Next Action

兩個 repositories 在同一 migration batch 各開一個完整、互相連結的 PR，讓 provider 與 Marketing Adapter 分別接受 cloud review，然後停止本批工作。不得在本批追加 raw recording、pixel render、額外 hardening、舊 source removal、merge 或 cleanup。
