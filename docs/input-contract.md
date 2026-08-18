# 輸入檔案與腳本標記

這份文件描述 legacy／manual Remotion path 使用的輸入契約。localhost job workflow 仍應以當前 job state 與 operator runbook 為準。

## `public/` 輸入檔案

| 檔名 | 必填 | 說明 |
|---|---|---|
| `heygen.mp4` | 是 | HeyGen 人物影片；使用 `--skip-generate` 時由外部提供 |
| `bgm.wav` | 是 | 背景音樂 |
| `script.txt` | 是 | 腳本，包含配圖標記 |
| `NotoSansTC-Regular.ttf` | 是 | 字幕字型 |
| `NotoSansTC-Bold.ttf` | 建議 | 粗體字幕字型 |
| `frame.png` | 選用 | 1080×1920 RGBA 品牌外框，中央透明 |
| `outro.mp4` | 選用 | 結尾影片 |
| `title.png` | 選用 | 疊在畫面右上方的標題圖 |
| `image1.png`～`imageN.png` | 選用 | 對應腳本中的 `(imageN)` 標記 |

大型輸入與品牌素材不得進 Git。workspace 內的來源素材放在 `../data/assets/`，再透過 ignored 的 `assets` symlink 使用。

## 腳本基本格式

```text
[標題]
這裡可以保存標題或備註。

[內文]
這是會被讀取的內文。
這次(image1)南亞科營收成長(image1)，
(image2)法說當天又出現新的變化(image2)。
```

`(imageN)` 必須使用相同編號前後成對，包住希望顯示該圖片的台詞區段。

## `(imageN)` 語法

```text
(imageN[:opt1,opt2,...])要顯示圖片的台詞(imageN)
```

選項以逗號分隔，只寫在開頭標記；結尾維持 `(imageN)`。

### 位置

| 寫法 | 效果 |
|---|---|
| 省略或 `center` | 置中 |
| `top` | 距頂 220 px |
| `top=N` | 距頂 N px |
| `bottom` | 距底 420 px |
| `bottom=N` | 距底 N px |

### 尺寸

| 寫法 | 效果 |
|---|---|
| 省略 | 寬 970 px |
| `small` | 寬 540 px |
| `medium` | 寬 810 px |
| `full` | 寬 1080 px |
| `w=N` | 自訂寬度，高度依比例 |
| `h=N` | 自訂高度，可能變形 |
| `w=N,h=N` | 固定寬高，可能拉伸 |

### 旗標

| 寫法 | 效果 |
|---|---|
| `pip` | 講者縮到右上角圓框，圖片成為主視覺 |
| `noblur` | 圖片出現期間不模糊人物影片 |

### 範例

```text
(image1)預設置中圖片(image1)
(image1:top=334)圖片放在指定上方位置(image1)
(image1:bottom=586,w=290,h=290)固定尺寸的小圖(image1)
(image1:pip,top=334)人物進入 PIP、圖片放上方(image1)
(image1:pip,top=334,noblur)PIP 且背景不模糊(image1)
```

兩個連續區段都使用 `pip` 且間隔小於 2.5 秒時，人物圓框會持續顯示，前一張圖片也會延伸到下一張開始。

## `frame.png` Alpha 檢查

`frame.png` 必須是 RGBA 且中央透明。從 `.mov` 擷取時可使用：

```bash
ffmpeg -y -i frame.mov -vf "format=rgba" -frames:v 1 frame.png
ffprobe -v error -show_entries stream=pix_fmt -of default=noprint_wrappers=1 frame.png
```

預期 `pix_fmt=rgba`。ProRes 4444 轉 VP9 WebM 曾出現靜默丟失 alpha 的情況，預設優先使用靜態 PNG。
