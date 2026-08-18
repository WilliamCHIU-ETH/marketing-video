# marketing-video modernization

這是從 `/Users/chiu/Downloads/marketing-video 2` 的現行 filesystem source 建立的隔離候選專案。第一個 milestone 只驗證「乾淨安裝、localhost UI/API、免付費 fixture job、唯讀清理計畫」；不證明 HeyGen 生成、成片品質或 production readiness。

## Quick start

```bash
nvm install
nvm use
npm ci
npm run doctor
npm run smoke
npm run dev:server
```

開啟 [http://localhost:4000](http://localhost:4000)。預設只監聽 `127.0.0.1`，不對區網開放。

### 安全邊界

- `npm run smoke` 會用 repo 外的臨時 `DATA_DIR`、停用 worker、清空 provider keys，並以 side-effect guard 阻擋／記錄 child process 與 outbound network 嘗試。
- 正常執行資料預設放在 `runtime-data/`，不放入 Git。
- 大型品牌素材不進 Git；本 workspace 的 ignored `assets` symlink 指向 `../data/assets/`。只有 localhost／smoke 時不需要素材包。
- 啟動 server 預設不清理舊 job；只有顯式設定 `AUTO_PRUNE_ON_START=1` 才會在啟動時 prune。
- 非 localhost 模式目前沒有完整認證，server 會預設拒絕啟動。
- `.env` 與 `.google-creds.json` 不可進 Git，本專案候選版也不包含這些檔案。

完整 render 若需要本機素材包，workspace 結構應為：

```text
marketing-video/
├── app/                 # Git repository
│   └── assets -> ../data/assets
└── data/
    ├── assets/          # 品牌素材、BGM、outro；不進 Git
    ├── cases/
    ├── history/
    ├── outputs/
    └── runtime/
```

### 核心指令

```bash
npm run doctor                         # localhost 與完整 pipeline preflight
npm run doctor:full                    # 完整出片鏈任一 blocker 都回傳非 0
npm run smoke                          # 免 provider、隔離 fixture job
npm run cleanup:plan -- --root=/path   # 唯讀清理計畫，絕不刪檔
npm run dev:server                     # localhost 使用者前台，port 4000
npm start                              # Remotion Studio，不是使用者前台
```

更完整的操作與驗收見 [`docs/operator-runbook.md`](docs/operator-runbook.md) 與 [`docs/milestone-01.md`](docs/milestone-01.md)。

---

## 舊版 Remotion 手動操作參考

```bash
cd /Users/chiu/Developer/marketing-video/app

npm ci                     # 第一次或 lockfile 改變後

npm run transcribe         # ① 從 heygen.mp4 抽字幕 + 偵測秒數
npm run correct-subtitles  # ② 用 script.txt 修字幕錯字
npm run parse-script       # ③ 解析 (imageN) 標記 → 疊圖時間
npm start                  # ④ 預覽（瀏覽器 localhost:3000）
npm run render             # ⑤ 輸出 out/output.mp4
```

---

## 2. 下一支影片

把 `public/` 裡的素材整批換掉、改 `script.txt`，**重複跑步驟 ① ~ ⑤** 即可。

---

## 3. 丟檔案到 `public/`

| 檔名 | 必填 | 說明 |
|---|---|---|
| `heygen.mp4` | ✅ | HeyGen 主影片 |
| `bgm.wav` | ✅ | 背景音樂 |
| `script.txt` | ✅ | 腳本（含 `(imageN)` 標記） |
| `NotoSansTC-Regular.ttf` | ✅ | 字幕字體 |
| `frame.png` | 選 | 靜態品牌外框（1080×1920 RGBA，中央透明） |
| `outro.mp4` | 選 | 結尾影片 |
| `title.png` | 選 | 標題圖，疊在最上層、靠右上 |
| `image1.png` ~ `imageN.png` | 選 | 對應 `(imageN)` 的截圖 |

> ⚠️ **frame.png 必須含 alpha**（RGBA，中央透明）。從剪輯軟體匯出的動畫 `.mov` 抽 1 幀：

```bash
cd /Users/chiu/Developer/marketing-video/app/public

ffmpeg -y -i frame.mov -vf "format=rgba" -frames:v 1 frame.png

# 驗證
ffprobe -v error -show_entries stream=pix_fmt -of default=noprint_wrappers=1 frame.png
# 預期：pix_fmt=rgba
```

如果要恢復「動畫外框」版本（理論上更炫但實作有坑），把 `src/MarketingVideo.tsx` 內 `Img` 換回 `OffthreadVideo`、檔名改 `frame.webm`，並用 `libvpx-vp9 -pix_fmt yuva420p` 轉檔。實測 ffmpeg 從 ProRes 4444 轉 webm 經常**靜默 drop alpha**，建議優先使用靜態 PNG。

`script.txt` 範例：

```
[標題]
（這部分不會被讀，純放心情筆記）

[內文]
這是會被讀的部分。
就像這次(image1)南亞科4月營收暴增7倍，
新聞一出來大家都想衝(image1)，
(image2)法說當天出現空翻多(image2)。
```

規則：`(imageN)` 同編號**前後成對**包住要顯示截圖的台詞段落。

---

## 4. `(imageN)` 完整語法

選項可任意組合，**用逗號分隔**（不是冒號）。只要寫在開頭標記就好，結尾用 `(imageN)` 即可。

```
(imageN[:opt1,opt2,...])要顯示圖的台詞段落(imageN)
```

### 位置（垂直）

| 寫法 | 效果 |
|------|------|
| _省略_ | center（預設，置中） |
| `top` | 上方（距頂 220px） |
| `top=N` | 上方，距頂 **N px** |
| `bottom` | 下方（距底 420px） |
| `bottom=N` | 下方，距底 **N px** |
| `center` | 置中（同預設） |

### 大小（寬度）

| 寫法 | 寬度 |
|------|------|
| _省略_ | 970（畫面寬 - 110，兩邊各 55 邊距） |
| `small` | 540（50%） |
| `medium` | 810（75%） |
| `full` | 1080（100%，貼滿邊） |
| `w=N` | **N px**（自訂寬度，高度依比例） |
| `h=N` | 高度 **N px**（注意：可能變形） |
| `w=N,h=N` | 完全鎖定寬高（可能拉伸） |

### 旗標

| 寫法 | 效果 |
|------|------|
| `pip` | 講者縮到右上角圓框、繼續講話；圖片成主視覺 |
| `noblur` | 此圖期間，主畫面講者**不打霧**（保持清晰） |

### 常見組合範例

```
(image1)經典段落(image1)
   → 預設：置中、寬 970、講者打霧

(image1:top=334)上方位置(image1)
   → 上方，距頂 334px

(image1:bottom=586,w=290,h=290)右下小圖(image1)
   → 下方距底 586，固定 290×290

(image1:pip,top=334)PIP 模式(image1)
   → 講者進圓框，圖在上方距頂 334

(image1:noblur)清晰背景(image1)
   → 圖出現但講者不模糊

(image1:pip,top=334,noblur)PIP 不打霧(image1)
   → PIP + 圖在上方 + 主畫面保持清晰
```

### 進階：自動橋接

兩張**都是 PIP** 且**間隔 < 2.5 秒**會自動：
- PIP 圓框**連續顯示**（不中間跳回大畫面）
- 前一張圖**延伸到下一張開始**（無縫銜接）

---

## 5. 想微調

| 想改 | 改哪 |
|---|---|
| 字幕字級 / 字色 / 背景 | `src/Subtitles.tsx` 內 `SubtitleLine` 的 `style` |
| 字幕位置 | `src/Subtitles.tsx` 的 `paddingTop` |
| 字幕斷句敏感度 | `src/Subtitles.tsx` 的 `GAP_THRESHOLD` |
| 換字體 | 丟新 ttf 到 `public/`，在 `src/fonts.ts` 加 `loadFont({...})` |
| BGM 音量 | `src/timeline.ts` 的 `BGM.volume`（0~1） |
| 講者上下位置 | `src/MarketingVideo.tsx` 的 `translateY(0px)` |
| 模糊強度 | `src/MarketingVideo.tsx` 的 `BLUR_MAX` |
| PIP 大小 / 位置 | `src/MarketingVideo.tsx` 的 `PIP_SIZE`、`PIP_TOP`、`PIP_RIGHT` |
| PIP 橋接門檻 | `src/MarketingVideo.tsx` 的 `PIP_BRIDGE_SEC` |

---

## 6. 首次安裝（只跑一次）

```bash
brew install ffmpeg pipx node@22
pipx install openai-whisper
pipx ensurepath
# 裝完關掉終端機重開

cd /Users/chiu/Developer/marketing-video/app
nvm install
nvm use
npm ci
```
