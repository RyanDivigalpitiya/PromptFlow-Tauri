#!/bin/bash
# Build the sync hub on THIS Mac and deploy it to the office Mac Mini (`ssh server`).
#
# Build here, ship the binary: the mini has no rust toolchain, and it is the same arch
# and OS as this machine (both arm64 macOS 26).
#
#   scripts/sync-deploy.sh              # build + ship + restart
#   scripts/sync-deploy.sh --install    # first time: also lay down config, plists, backup
#   scripts/sync-deploy.sh --status     # what is running over there right now
#
# THE MINI IS SHARED PRODUCTION HARDWARE. Everything this script touches:
#   ~/PromptFlow-Sync/                                (its own directory)
#   ~/Library/LaunchAgents/com.ryandiv.promptflow-sync*.plist
#   /opt/homebrew/var/log/promptflow-sync*.log
# It NEVER goes near SPARC: ports 9000–9010, Postgres 5432, com.calumix.sparc.*, their
# repo/venv/deploy/.env. If you extend this script, keep it that way.
set -euo pipefail

HOST="${PF_SYNC_HOST:-server}"
REMOTE_DIR="PromptFlow-Sync"
LABEL="com.ryandiv.promptflow-sync"
BACKUP_LABEL="com.ryandiv.promptflow-sync-backup"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }

remote_status() {
  say "hub status on $HOST"
  # shellcheck disable=SC2029
  ssh "$HOST" "
    UID_=\$(id -u)
    echo '--- launchctl ---'
    launchctl print gui/\$UID_/$LABEL 2>/dev/null | grep -E '^[[:space:]]+(state|pid|last exit code) ' || echo '  (not loaded)'
    echo '--- listening ---'
    lsof -nP -iTCP:9273 -sTCP:LISTEN 2>/dev/null || echo '  (nothing on 9273)'
    echo '--- local health ---'
    curl -s -m 5 -o /dev/null -w '  loopback /v1/health -> %{http_code} (401 without a bearer is CORRECT)\n' \
      http://127.0.0.1:9273/v1/health || echo '  (unreachable)'
    echo '--- log tail ---'
    tail -n 15 /opt/homebrew/var/log/promptflow-sync.log 2>/dev/null || echo '  (no log yet)'
  "
}

if [ "${1:-}" = "--status" ]; then
  remote_status
  exit 0
fi

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

say "building promptflow-sync (release)"
cargo build --release -p pf-sync-server --manifest-path "$REPO/Cargo.toml"
BIN="$REPO/target/release/promptflow-sync"
[ -x "$BIN" ] || { echo "no binary at $BIN"; exit 1; }
file "$BIN" | sed 's/^/    /'

say "ensuring $HOST:~/$REMOTE_DIR exists"
ssh "$HOST" "mkdir -p ~/$REMOTE_DIR/backups && mkdir -p /opt/homebrew/var/log"

if [ "$INSTALL" = 1 ]; then
  say "first-time install: config, plists, backup script"

  # Substitute the MINI's own $HOME/$USER, never this machine's.
  REMOTE_HOME=$(ssh "$HOST" 'echo $HOME')
  REMOTE_USER=$(ssh "$HOST" 'echo $USER')
  say "remote HOME=$REMOTE_HOME USER=$REMOTE_USER"

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  for f in com.ryandiv.promptflow-sync.plist com.ryandiv.promptflow-sync-backup.plist \
           promptflow-sync.newsyslog.conf; do
    sed -e "s|__HOME__|$REMOTE_HOME|g" -e "s|__USER__|$REMOTE_USER|g" \
      "$REPO/deploy/$f" > "$TMP/$f"
  done
  cp "$REPO/deploy/sync-backup.sh" "$TMP/sync-backup.sh"

  scp -q "$TMP/sync-backup.sh" "$TMP/promptflow-sync.newsyslog.conf" "$HOST:~/$REMOTE_DIR/"
  scp -q "$TMP/com.ryandiv.promptflow-sync.plist" \
         "$TMP/com.ryandiv.promptflow-sync-backup.plist" "$HOST:~/Library/LaunchAgents/"

  # Config, only if it does not already exist — never clobber a live bearer token.
  if ssh "$HOST" "test -f ~/$REMOTE_DIR/config.toml"; then
    say "config.toml already exists — left untouched"
  else
    say "generating a bearer token and writing config.toml (0600)"
    TOKEN=$(openssl rand -hex 32)
    sed -e "s|REPLACE-ME-WITH-openssl-rand-hex-32|$TOKEN|" "$REPO/deploy/config.example.toml" \
      | ssh "$HOST" "cat > ~/$REMOTE_DIR/config.toml && chmod 600 ~/$REMOTE_DIR/config.toml"
    cat <<EOF

  +-------------------------------------------------------------------------+
  |  BEARER TOKEN - shown ONCE. Put it in three places, then clear the       |
  |  scrollback:                                                            |
  +-------------------------------------------------------------------------+

    $TOKEN

    1. this Mac's login Keychain:
         security add-generic-password -U -s pf-sync-bearer -a "\$USER" -w 'TOKEN'
    2. the iPad's Keychain (typed into the app's sync settings)
    3. your password manager

EOF
  fi
fi

# NEVER scp over the running binary in place: on Apple Silicon, writing to the text
# pages of a mapped executable kills the process outright, and can wedge later execs
# with `Killed: 9` under KeepAlive. Ship beside it, then rename.
say "shipping the binary (to a temp name, then mv - never over a mapped executable)"
scp -q "$BIN" "$HOST:~/$REMOTE_DIR/promptflow-sync.new"
ssh "$HOST" "chmod +x ~/$REMOTE_DIR/promptflow-sync.new && mv ~/$REMOTE_DIR/promptflow-sync.new ~/$REMOTE_DIR/promptflow-sync"

if [ "$INSTALL" = 1 ]; then
  say "bootstrapping the LaunchAgents"
  # shellcheck disable=SC2029
  ssh "$HOST" "
    set -e
    UID_=\$(id -u)
    launchctl bootout gui/\$UID_/$LABEL 2>/dev/null || true
    launchctl bootout gui/\$UID_/$BACKUP_LABEL 2>/dev/null || true
    launchctl bootstrap gui/\$UID_ ~/Library/LaunchAgents/$LABEL.plist
    launchctl bootstrap gui/\$UID_ ~/Library/LaunchAgents/$BACKUP_LABEL.plist
  "
  cat <<EOF

  Two things still need YOUR hands on the mini (each needs a sudo password, which this
  script must never hold):

    1. log rotation - one sudo, ideally in the same session as the cloudflared install:
         ssh $HOST
         sudo install -m 644 -o root -g wheel \\
           ~/$REMOTE_DIR/promptflow-sync.newsyslog.conf \\
           /etc/newsyslog.d/promptflow-sync.conf
       (Skippable: the nightly backup agent copy-truncates at 10MB as a floor.)

    2. the Access 'iss' claim, which was never recorded. Make one authenticated
       request through the tunnel, then:
         ssh $HOST "grep 'NOT pinned' /opt/homebrew/var/log/promptflow-sync.log"
       Put that https://<team>.cloudflareaccess.com value into
       ~/$REMOTE_DIR/config.toml as access_team_domain, then re-run this script.

EOF
else
  say "restarting the hub"
  # shellcheck disable=SC2029
  ssh "$HOST" "launchctl kickstart -k gui/\$(id -u)/$LABEL"
fi

sleep 2
remote_status
