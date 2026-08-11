#!/bin/bash
# Ask the production hub how it is doing, THROUGH the tunnel — so a green answer proves
# the whole chain (DNS, Cloudflare edge, Access, the tunnel connector, the LaunchAgent,
# the database), not just that a process is alive on the mini.
#
#   scripts/sync-status.sh          # /v1/health
#   scripts/sync-status.sh --raw    # unformatted JSON
#
# Credentials come from this Mac's login Keychain — never from a file in the repo:
#   pf-sync-access-client-secret   (pre-staged; the first read may prompt for approval)
#   pf-sync-bearer                 (added by scripts/sync-deploy.sh --install)
set -euo pipefail

URL="${PF_SYNC_URL:-https://pf-sync.ryan-div.com}"
# Not a secret — it is the Access service token's public half, pinned server-side as the
# JWT's common_name.
CLIENT_ID="${PF_SYNC_CLIENT_ID:-00e0de7f97b61a6ae9ab945972a09298.access}"

kc() {
  security find-generic-password -s "$1" -w 2>/dev/null || {
    echo "missing Keychain item '$1' on this Mac." >&2
    echo "  add it with: security add-generic-password -U -s $1 -a \"\$USER\" -w" >&2
    exit 1
  }
}

SECRET=$(kc pf-sync-access-client-secret)
BEARER=$(kc pf-sync-bearer)

response=$(curl -s -w '\n%{http_code}' -m 20 \
  -H "CF-Access-Client-Id: $CLIENT_ID" \
  -H "CF-Access-Client-Secret: $SECRET" \
  -H "Authorization: Bearer $BEARER" \
  "$URL/v1/health")
code=$(printf '%s' "$response" | tail -n1)
body=$(printf '%s' "$response" | sed '$d')

if [ "${1:-}" = "--raw" ]; then
  printf '%s\n' "$body"
  exit 0
fi

case "$code" in
  200) ;;
  401) echo "401 — the app bearer token is wrong. Access let you in; PromptFlow did not."; exit 1 ;;
  403) echo "403 — Cloudflare Access refused. Check the service-token pair (it expires yearly)."; exit 1 ;;
  502|503) echo "$code — Access passed but no origin answered. The hub is down or the tunnel lost it:"
           echo "  scripts/sync-deploy.sh --status"; exit 1 ;;
  000) echo "no response at all — DNS or network. Is $URL reachable?"; exit 1 ;;
  *)   echo "$code"; printf '%s\n' "$body"; exit 1 ;;
esac

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$body" | jq -r '
    "hub            \(.liveNodes) live nodes, \(.tombstones) tombstones",
    "oplog          latest seq \(.latestSeq)",
    "uptime         \(.uptime / 3600 | floor)h \((.uptime % 3600) / 60 | floor)m",
    "protocol       v\(.protocolVersion)",
    "",
    "devices:",
    (.perDevice[] |
      "  \(.deviceId)"
      + "  last push "  + (if .lastPushAt  then (.lastPushAt/1000 | strflocaltime("%Y-%m-%d %H:%M")) else "never" end)
      + "  pulled to " + (if .lastPullSeq then (.lastPullSeq|tostring) else "never" end))
  '
else
  printf '%s\n' "$body"
  echo
  echo "(install jq for a readable summary: brew install jq)"
fi
