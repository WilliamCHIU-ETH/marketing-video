#!/usr/bin/env bash
# 從 HeyGen 影片自動產生字幕 JSON
#
# 用法：./scripts/transcribe.sh
# 前置需求（Mac）：
#   brew install ffmpeg whisper-cpp
#   npm run setup:whisper

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT="$ROOT/public/heygen.mp4"
OUTRO="$ROOT/public/outro.mp4"
TMP_DIR="$ROOT/.cache"
WHISPER_DIR="$TMP_DIR/whisper"
TMP_AUDIO="$TMP_DIR/heygen.wav"
RAW_PREFIX="$WHISPER_DIR/heygen.whispercpp"
RAW_JSON="$RAW_PREFIX.json"
OUTPUT_DIR="$ROOT/src"
OUTPUT_JSON="$OUTPUT_DIR/subtitles.json"
BACKUP_JSON="$OUTPUT_DIR/subtitles.original.json"
META_JSON="$OUTPUT_DIR/video-meta.json"
WHISPER_MODEL_PATH="${WHISPER_MODEL_PATH:-$WHISPER_DIR/ggml-base-q5_1.bin}"
WHISPER_THREADS="${WHISPER_THREADS:-4}"
WHISPER_DEVICE="${WHISPER_DEVICE:-cpu}"

case "$WHISPER_MODEL_PATH" in
  /*) ;;
  *) WHISPER_MODEL_PATH="$ROOT/$WHISPER_MODEL_PATH" ;;
esac

if [ ! -f "$INPUT" ]; then
  echo "❌ 找不到 $INPUT — 請先把 HeyGen 影片放到 public/heygen.mp4"
  exit 1
fi

# 檢查必要的指令
missing=()
command -v ffmpeg  >/dev/null 2>&1 || missing+=("ffmpeg (brew install ffmpeg)")
command -v ffprobe >/dev/null 2>&1 || missing+=("ffprobe (brew install ffmpeg)")
command -v whisper-cli >/dev/null 2>&1 || missing+=("whisper-cli (brew install whisper-cpp)")

if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ 缺少以下工具，請先安裝："
  for m in "${missing[@]}"; do echo "   - $m"; done
  echo ""
  echo "裝完後請『關掉終端機重開』讓 PATH 生效，再執行此腳本"
  exit 1
fi

if [ ! -f "$WHISPER_MODEL_PATH" ]; then
  echo "❌ 找不到 Whisper 模型：$WHISPER_MODEL_PATH"
  echo "   請先執行 npm run setup:whisper，或設定 WHISPER_MODEL_PATH"
  exit 1
fi

if ! [[ "$WHISPER_THREADS" =~ ^[1-9][0-9]*$ ]]; then
  echo "❌ WHISPER_THREADS 必須是正整數，目前為：$WHISPER_THREADS"
  exit 1
fi

case "$WHISPER_DEVICE" in
  cpu) DEVICE_ARGS=(-ng) ;;
  auto) DEVICE_ARGS=() ;;
  *)
    echo "❌ WHISPER_DEVICE 僅支援 cpu 或 auto，目前為：$WHISPER_DEVICE"
    exit 1
    ;;
esac

mkdir -p "$TMP_DIR" "$WHISPER_DIR"

echo "▶ 1/4 用 ffprobe 偵測影片時長..."
HEYGEN_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT")
HEYGEN_ROUNDED=$(printf "%.2f" "$HEYGEN_DURATION")

# 結尾影片是選配；若存在就偵測秒數，沒放就當 0
if [ -f "$OUTRO" ]; then
  OUTRO_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTRO")
  OUTRO_ROUNDED=$(printf "%.2f" "$OUTRO_DURATION")
  echo "   → 偵測到 heygen.mp4 $HEYGEN_ROUNDED 秒、outro.mp4 $OUTRO_ROUNDED 秒"
else
  OUTRO_ROUNDED="0"
  echo "   → 偵測到 heygen.mp4 $HEYGEN_ROUNDED 秒（無 outro.mp4，跳過）"
fi

cat > "$META_JSON" <<EOF
{
  "heygenDurationSec": $HEYGEN_ROUNDED,
  "outroDurationSec": $OUTRO_ROUNDED,
  "_note": "此檔由 npm run transcribe 自動寫入；手動編輯會在下次 transcribe 時被覆蓋"
}
EOF
echo "   → 已寫入 src/video-meta.json"

echo "▶ 2/4 用 ffmpeg 從影片抽出音檔..."
ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_AUDIO" -loglevel error

echo "▶ 3/4 跑 whisper.cpp（中文，token timestamps）..."
# 不傳完整正式腳本作 prompt；文字校正由下一步 correct-subtitles 做事後順序對齊。
whisper-cli \
  "${DEVICE_ARGS[@]}" \
  -t "$WHISPER_THREADS" \
  -m "$WHISPER_MODEL_PATH" \
  -f "$TMP_AUDIO" \
  -l zh \
  -ml 1 \
  -ojf \
  -of "$RAW_PREFIX" \
  -np

echo "▶ 4/4 透過 adapter 整理成既有字幕格式..."
node "$ROOT/scripts/normalize-whispercpp.js" \
  --input "$RAW_JSON" \
  --output "$OUTPUT_JSON" \
  --duration "$HEYGEN_DURATION" \
  --model "$WHISPER_MODEL_PATH"
# 同步覆寫 raw 備份，讓 correct-subtitles 出包時可還原到本次新的 Whisper 輸出
# （否則舊版備份會卡住，重 transcribe 也救不回來）
cp "$OUTPUT_JSON" "$BACKUP_JSON"

echo ""
echo "✅ 完成！"
TOTAL=$(python3 -c "print(f'{$HEYGEN_ROUNDED + $OUTRO_ROUNDED:.2f}')" 2>/dev/null || echo "$HEYGEN_ROUNDED+$OUTRO_ROUNDED")
echo "   時長  → $META_JSON (heygen $HEYGEN_ROUNDED + outro $OUTRO_ROUNDED = $TOTAL 秒)"
echo "   字幕  → $OUTPUT_JSON"
echo "   ASR raw → $RAW_JSON"
echo "   現在打開 Remotion Studio 就能看到字幕 + 正確時長"
