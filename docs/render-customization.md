# Remotion 畫面微調

先修改既有集中設定，不要為相同用途再建立一層重複配置。涉及版型定案值時，先讀 `AGENTS.md` 與對應 composition 內的註解。

| 想調整 | 主要位置 |
|---|---|
| 字幕字級、字色、背景 | `src/Subtitles.tsx` 的 `SubtitleLine` style |
| 字幕位置 | `src/Subtitles.tsx` 的 `paddingTop` |
| 字幕斷句敏感度 | `src/Subtitles.tsx` 的 `GAP_THRESHOLD` |
| 字型 | 將合法來源的字型放到 ignored runtime input，再調整 `src/fonts.ts` |
| BGM 音量 | `src/timeline.ts` 的 `BGM.volume` |
| 講者上下位置 | 對應 composition 的人物影片 transform |
| 模糊強度 | `src/MarketingVideo.tsx` 的 `BLUR_MAX` |
| PIP 大小與位置 | `src/MarketingVideo.tsx` 的 `PIP_SIZE`、`PIP_TOP`、`PIP_RIGHT` |
| PIP 橋接門檻 | `src/MarketingVideo.tsx` 的 `PIP_BRIDGE_SEC` |

## 修改後驗證

```bash
npm run typecheck
npm run smoke
```

畫面相關變更還需要在 Remotion Studio 或實際 render 中人工確認；typecheck 與 smoke 不代表視覺輸出已驗收。
