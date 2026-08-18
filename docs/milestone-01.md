# Milestone 01：可重建 localhost baseline

## Decision Lock

- 決定：建立不含歷史 jobs、backups、成品與 secrets 的候選專案。
- 必要證據：依 lockfile 安裝、localhost UI/API、隔離 fixture job、source workspace 不變、清理只產生 plan。
- 不在本輪證明：HeyGen 付費生成、影片品質、LAN production readiness。
- 停止條件：歷史 job 缺少恢復檔、存在 active writer，或清理候選沒有內容 hash 證據。

## 驗收表

- [x] `npm ci`：依 lockfile 安裝成功。
- [x] `npm ls --depth=0`：依賴樹完整。
- [x] `npm audit --audit-level=high`：掃描當時 0 個已知漏洞。
- [x] Node `22.23.2` 執行 TypeScript `--noEmit`：通過。
- [x] `doctor`：localhost `READY`；完整出片鏈因缺少 `whisper` 與有效 Noto Sans TC 字型為 `BLOCKED`。
- [x] `smoke`：通過。
- [x] UI 回傳 HTTP 200。
- [x] `/api/health` 回傳 `mode=test`、`workerEnabled=false`。
- [x] fixture job 僅寫入暫存 `DATA_DIR`，狀態由 `draft` 進入 `queued` 後不啟動 worker。
- [x] provider keys 清空、worker 停用；side-effect guard 未觀察到 child process 或 outbound network 嘗試。
- [x] 非法 brand、upload 檔名與未 opt-in 的 LAN bind 均被拒絕。
- [x] 重複 submit、submit 後 upload 與無法證明 stale 的 lock 均被拒絕。
- [x] TEST_MODE 拒絕 repo 子路徑與 symlink 回指。
- [x] `public/`、`src/`、`out/`、`backups/`、`runtime-data/` 與 repo `.run.lock` 在 smoke 前後不變。
- [x] 原專案 cleanup plan 完成且零寫入；因資料異常 fail-closed（exit 2）。
- [x] 從本地 baseline commit `0c11b89` 的乾淨 checkout，以 Node `22.23.2` 重跑 `npm ci`、依賴樹、typecheck、doctor 與 smoke：通過。
- [x] 乾淨 checkout 執行正常模式 `npm run dev:server`：首頁 HTTP 200、health `mode=normal`；驗收時以 `DISABLE_WORKER=1` 與 `/tmp` DATA_DIR 避免 provider／正式資料副作用。

## Source snapshot

- Truth source：`/Users/chiu/Downloads/marketing-video 2` 的 2026-08-18 filesystem working tree。
- 刻意排除：`.git`、`.env`、`.google-creds.json`、`node_modules`、`jobs`、`backups`、`out`、`成品`、cache/tmp/frame artifacts。
- 原專案兩個 `.ttf` 經 magic bytes 驗證其實是 HTML，因此也不納入 baseline。
- 缺少支援目錄且不屬 HeyGen 主流程的 `gen-video.js` FAL 實驗線與其專用 dependency 也不納入 baseline。
- 保留：server、run.js、Remotion source、scripts、package lock、docs、固定 assets 與字型。
- 原資料夾目前不會被這個候選專案修改或清理。

## Cleanup evidence

對原專案的唯讀掃描結果：

- 掃描 `1.75 GiB`。
- 只有 `15.1 MiB` 屬於「與成品庫 SHA-256 完全相同」的 eligible 候選。
- `677.9 MiB` 僅列人工判斷，其中約 `495.4 MiB` 是內容完全相同的 backup snapshot。
- 8 個 `review` job 的恢復快照不完整，另有 2 個未封存 fallback output；因此計畫回傳 exit 2，禁止自動 apply。

本 milestone 刻意沒有提供 `cleanup:apply` 或 `--force`。
