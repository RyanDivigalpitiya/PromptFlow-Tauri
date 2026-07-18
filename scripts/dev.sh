#!/bin/zsh
# Run the dev app against an ISOLATED throwaway store (never the real one).
# Usage: scripts/dev.sh [store.sqlite]
cd "$(dirname "$0")/.."
STORE="${1:-/tmp/promptflow-tauri-dev.sqlite}"
PROMPTFLOW_STORE="$STORE" npm run tauri dev
