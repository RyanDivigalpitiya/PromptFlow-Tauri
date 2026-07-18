#!/bin/zsh
# Capture just the PromptFlow (Tauri) window to the given path.
OUT="${1:-/tmp/pf-tauri-shot.png}"
NEEDLE="${2:-promptflow-tauri}"
DIR="$(cd "$(dirname "$0")" && pwd)"
WID="$(swift "$DIR/winid.swift" "$NEEDLE" 2>/dev/null)"
if [ -z "$WID" ]; then
  echo "shot: window not found for '$NEEDLE'" >&2
  exit 1
fi
screencapture -x -o -l"$WID" "$OUT"
echo "$OUT"
