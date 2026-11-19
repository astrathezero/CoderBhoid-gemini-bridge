#!/usr/bin/env bash
# Connects Android phone over USB via ADB reverse to forward port 8000

set -e

echo "=== Phone System 1 ADB Reverse Bridge ==="

if ! command -v adb &>/dev/null; then
  if [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
    export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
  elif [ -x "$HOME/Android/Sdk/platform-tools/adb" ]; then
    export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
  elif [ -x "/usr/local/bin/adb" ]; then
    export PATH="/usr/local/bin:$PATH"
  else
    echo "Error: adb command not found. Please install android-platform-tools (e.g. brew install android-platform-tools or apt install adb)."
    exit 1
  fi
fi

DEVICES=$(adb devices | grep -v "List of devices" | grep "device$" || true)

if [ -z "$DEVICES" ]; then
  echo "No authorized Android device found via USB."
  echo "Checklist:"
  echo "1. Connect phone with USB cable."
  echo "2. Enable Developer Options and USB Debugging on your phone."
  echo "3. Accept the USB debugging authorization prompt on your phone screen."
  exit 1
fi

echo "Found connected Android device:"
echo "$DEVICES"

echo "Configuring reverse socket: laptop localhost:8000 -> phone localhost:8000..."
adb reverse tcp:8000 tcp:8000

echo "Pinging phone System 1 endpoint..."
HEALTH_CHECK=$(curl -s -m 2 http://localhost:8000/health 2>/dev/null || true)

if [ -n "$HEALTH_CHECK" ]; then
  echo "Phone System 1 is LIVE and reachable at http://localhost:8000!"
  echo "Response: $HEALTH_CHECK"
else
  echo "Notice: Port forwarded, but phone server is not running yet."
  echo "Run this inside Termux on your phone:"
  echo "  node ~/phone-bridge/phone_laya_server.js"
fi
