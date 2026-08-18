#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 把出片前台裝成 macOS 背景服務。
#
#   為什麼要裝：同事 13:30 要用，你不能每天記得開終端機。
#   裝完之後：Mac 一開機（登入）伺服器就自己起來，關終端機也不會停。
#             服務跑著的時候 Mac 不會進睡眠（caffeinate），
#             不然睡著了同事一樣連不進來。
#
#   安裝：  bash server/install-autostart.sh
#   移除：  bash server/install-autostart.sh --uninstall
#   看狀態：launchctl list | grep marketing-video
#   看記錄：tail -f ~/Library/Logs/marketing-video-studio.log
# ─────────────────────────────────────────────────────────────
set -e

LABEL="com.cmoney.marketing-video-studio"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/Library/Logs/marketing-video-studio.log"

if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ 已移除開機自動啟動"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "❌ 找不到 node。請先確認終端機打 node -v 有反應。"
  exit 1
fi

CAFFEINATE="/usr/bin/caffeinate"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -i：服務活著的時候不讓系統進睡眠 -->
    <string>$CAFFEINATE</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$PROJECT/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <!-- 掛掉自動重開，但最短間隔 10 秒，避免壞掉時瘋狂重啟 -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOST</key><string>${HOST:-127.0.0.1}</string>
    <key>PORT</key><string>${PORT:-4000}</string>
    <key>DATA_DIR</key><string>${DATA_DIR:-$PROJECT/runtime-data}</string>
    <key>ALLOW_INSECURE_LAN</key><string>${ALLOW_INSECURE_LAN:-0}</string>
  </dict>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "查不到")
echo ""
echo "✅ 裝好了，Mac 開機就會自己啟動"
echo ""
echo "   你自己：http://localhost:${PORT:-4000}"
if [ "${HOST:-127.0.0.1}" = "0.0.0.0" ]; then
  echo "   區網連：http://$IP:${PORT:-4000}"
else
  echo "   監聽範圍：${HOST:-127.0.0.1}（僅本機）"
fi
echo ""
echo "   執行記錄：tail -f $LOG"
echo "   移除：    bash server/install-autostart.sh --uninstall"
echo ""
if [ "${HOST:-127.0.0.1}" = "0.0.0.0" ]; then
  echo "⚠️  LAN 模式目前還沒有完整認證，不應在不可信網路上啟用。"
  echo ""
fi
