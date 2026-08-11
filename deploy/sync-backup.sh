#!/bin/bash
# Nightly backup of the sync hub's database, run at 03:30 by
# com.ryandiv.promptflow-sync-backup.
#
# `VACUUM INTO`, never a raw file copy: the database runs in WAL mode, so `cp` of the
# .sqlite alone captures a torn image missing everything still in the -wal file.
# VACUUM INTO takes a read transaction and writes a consistent, already-compacted copy
# while the hub keeps serving.
#
# `$HOME`, never `~`, inside the quoted SQL: launchd's cwd is `/` and SQLite does not
# expand tildes — a `~` here writes a file literally named `~` in the root directory.
set -euo pipefail

DIR="$HOME/PromptFlow-Sync"
DB="$DIR/sync.sqlite"
BACKUPS="$DIR/backups"
KEEP=14

if [ ! -f "$DB" ]; then
  echo "$(date -u +%FT%TZ) no database at $DB — nothing to back up"
  exit 0
fi

mkdir -p "$BACKUPS"
OUT="$BACKUPS/sync-$(date +%F).sqlite"
rm -f "$OUT"
sqlite3 "$DB" "VACUUM INTO '$OUT'"
echo "$(date -u +%FT%TZ) wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Prune to the last $KEEP dated backups. Names sort lexicographically because the date
# is ISO — no `ls -t` (whose output cannot be parsed safely) and no `find -delete`
# sweeping anything outside this directory.
cd "$BACKUPS"
COUNT=$(ls -1 sync-*.sqlite 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1 sync-*.sqlite | head -n "$((COUNT - KEEP))" | while read -r old; do
    echo "$(date -u +%FT%TZ) pruning $old"
    rm -f -- "$old"
  done
fi

# Log-size floor, in case the newsyslog rule was never installed (it needs one sudo, in
# the same session as the cloudflared install). launchd never rotates StandardOutPath
# itself, and an unbounded log on shared hardware is somebody else's outage.
for LOG in /opt/homebrew/var/log/promptflow-sync.log /opt/homebrew/var/log/promptflow-sync-backup.log; do
  if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 10485760 ]; then
    # COPY-truncate, never move: the running process holds an open fd at an offset, and
    # renaming the file would leave it writing to an unlinked inode forever.
    cp "$LOG" "$LOG.1"
    : > "$LOG"
    echo "$(date -u +%FT%TZ) rotated $LOG (>10MB)"
  fi
done
