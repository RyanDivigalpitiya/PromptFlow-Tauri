#!/bin/zsh
# Headless smoke test: launch the release app against a throwaway store, poll for
# the process + window, then quit it. Exits non-zero if the app never comes up.
cd "$(dirname "$0")/.."
APP="src-tauri/target/release/bundle/macos/PromptFlow.app/Contents/MacOS/promptflow-tauri"
[ -x "$APP" ] || { echo "verify: build first (scripts/build.sh)" >&2; exit 1; }
STORE="$(mktemp -d)/verify.sqlite"
PROMPTFLOW_STORE="$STORE" "$APP" &
PID=$!
for i in $(seq 1 30); do
  if swift scripts/winid.swift promptflow-tauri >/dev/null 2>&1; then
    echo "verify: window up (pid $PID)"
    kill $PID
    exit 0
  fi
  sleep 1
done
echo "verify: app never showed a window" >&2
kill $PID 2>/dev/null
exit 1
