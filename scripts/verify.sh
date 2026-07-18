#!/bin/zsh
# Headless smoke test: launch the release app against a throwaway store, poll for
# the process + window, then quit it. Exits non-zero if the app never comes up.
# The window is matched by the launched child's PID (not owner name): the release
# bundle's owner name is "PromptFlow" — same as the user's real app — so a name
# needle would either never match or match the wrong process.
cd "$(dirname "$0")/.."
APP="src-tauri/target/release/bundle/macos/PromptFlow.app/Contents/MacOS/promptflow-tauri"
[ -x "$APP" ] || { echo "verify: build first (scripts/build.sh)" >&2; exit 1; }
STORE="$(mktemp -d)/verify.sqlite"
PROMPTFLOW_STORE="$STORE" "$APP" &
PID=$!
if swift -e '
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
for _ in 0..<30 {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  if list.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }) { exit(0) }
  Thread.sleep(forTimeInterval: 1)
}
exit(1)' "$PID"; then
  echo "verify: window up (pid $PID)"
  kill $PID
  exit 0
fi
echo "verify: app never showed a window" >&2
kill $PID 2>/dev/null
exit 1
