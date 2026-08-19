#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$ROOT/.cache/whisper"
MODEL_PATH="${WHISPER_MODEL_PATH:-$MODEL_DIR/ggml-base-q5_1.bin}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
EXPECTED_SHA256="${WHISPER_MODEL_SHA256:-422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898}"

case "$MODEL_PATH" in
  /*) ;;
  *) MODEL_PATH="$ROOT/$MODEL_PATH" ;;
esac

command -v curl >/dev/null 2>&1 || { echo "❌ 找不到 curl"; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "❌ 找不到 shasum"; exit 1; }

mkdir -p "$(dirname "$MODEL_PATH")"

current_sha=""
if [ -f "$MODEL_PATH" ]; then
  current_sha="$(shasum -a 256 "$MODEL_PATH" | awk '{print $1}')"
fi

if [ "$current_sha" = "$EXPECTED_SHA256" ]; then
  echo "✅ Whisper 模型已安裝且校驗通過：$MODEL_PATH"
  exit 0
fi

tmp_file="$(mktemp "${MODEL_PATH}.download.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

echo "▶ 下載 whisper.cpp base-q5_1 模型（約 57 MB）..."
curl -L --fail --output "$tmp_file" "$MODEL_URL"
downloaded_sha="$(shasum -a 256 "$tmp_file" | awk '{print $1}')"
if [ "$downloaded_sha" != "$EXPECTED_SHA256" ]; then
  echo "❌ 模型 SHA-256 不符：預期 $EXPECTED_SHA256，實際 $downloaded_sha"
  exit 1
fi

mv "$tmp_file" "$MODEL_PATH"
trap - EXIT
echo "✅ Whisper 模型已安裝且校驗通過：$MODEL_PATH"
