#!/usr/bin/env bash
# Phone push for the deck through ntfy. Run from Git Bash on the PC.
#
# Your own ntfy server on a Linux box you can ssh to, with Docker and Caddy:
#   NTFY_HOST=ntfy.example.com NTFY_SSH=user@203.0.113.10 bash ntfy/install.sh
#
# Only the PC's half (any ntfy server, the public ntfy.sh included):
#   NTFY_URL=https://ntfy.sh bash ntfy/install.sh --pc-only
#
# What it does: makes a topic name once and keeps it in ~/.claude-deck/ntfy.json
# with the server's URL and the deck's https address (where a tapped push
# lands; found from `tailscale serve status`, or set DECK_URL). For your own
# server it then copies this folder to ~/ntfy on the box, starts the
# container, and adds a Caddy block for NTFY_HOST (validated, backed up,
# reloaded, or put back). The DNS record for NTFY_HOST is yours to add: an A
# record to the box.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${CLAUDE_DECK_HOME:-$HOME/.claude-deck}"
CONF="$DATA/ntfy.json"
PC_ONLY=""
[ "${1:-}" = "--pc-only" ] && PC_ONLY=1

if [ -n "${NTFY_URL:-}" ]; then
  BASE_URL="${NTFY_URL%/}"
elif [ -n "${NTFY_HOST:-}" ]; then
  BASE_URL="https://$NTFY_HOST"
else
  echo "Set NTFY_HOST (your own server) or NTFY_URL (any ntfy server). See the top of this file." >&2
  exit 1
fi

mkdir -p "$DATA"
if [ -f "$CONF" ]; then
  TOPIC="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).topic)" "$CONF")"
else
  TOPIC="deck-$(node -e "console.log(require('crypto').randomBytes(10).toString('hex'))")"
fi
DECK_URL="${DECK_URL:-$(tailscale serve status 2>/dev/null | grep -oE 'https://[A-Za-z0-9.-]+\.ts\.net' | head -1 || true)}"
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({ url: process.argv[2], topic: process.argv[3], deckUrl: process.argv[4] }, null, 2) + '\n')" "$CONF" "$BASE_URL" "$TOPIC" "$DECK_URL"
echo "PC: $CONF holds the server, the topic and the deck address."
[ -z "$DECK_URL" ] && echo "No deck https address found, so a tapped push opens nothing. Set DECK_URL and run this again."
if [ -n "$PC_ONLY" ]; then
  echo "Stopping there. On the phone: the ntfy app, subscribe to the topic shown on the deck's Keys screen."
  exit 0
fi

: "${NTFY_HOST:?NTFY_HOST is needed to set up your own server}"
: "${NTFY_SSH:?NTFY_SSH is needed: user@host of the box that runs ntfy}"
SSH=(ssh -o BatchMode=yes "$NTFY_SSH")

TMP="$(mktemp -d)"
sed -e "s#__BASE_URL__#$BASE_URL#" -e "s#__TOPIC__#$TOPIC#" "$HERE/server.yml.template" > "$TMP/server.yml"
cp "$HERE/compose.yml" "$TMP/compose.yml"
"${SSH[@]}" 'mkdir -p ~/ntfy/cache ~/ntfy/auth'
scp -q "$TMP/compose.yml" "$TMP/server.yml" "$NTFY_SSH:~/ntfy/"
rm -rf "$TMP"

"${SSH[@]}" 'bash -s' -- "$NTFY_HOST" <<'REMOTE'
set -euo pipefail
host="$1"
cd ~/ntfy
mv -f compose.yml docker-compose.yml
sudo docker compose up -d --force-recreate --quiet-pull 2>&1 | tail -1
caddyfile=/etc/caddy/Caddyfile
if ! sudo grep -qE "^$host[ ,{]" "$caddyfile"; then
  sudo cp "$caddyfile" "$caddyfile.bak-ntfy"
  printf '\n%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:2586\n}\n' "$host" | sudo tee -a "$caddyfile" >/dev/null
  if sudo caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1; then
    sudo systemctl reload caddy
    echo "Caddy now serves $host (backup: $caddyfile.bak-ntfy)."
  else
    sudo cp "$caddyfile.bak-ntfy" "$caddyfile"
    echo "Caddy rejected the new block, so it was put back. Nothing else changed." >&2
    exit 1
  fi
else
  echo "Caddy already serves $host."
fi
sleep 3
if wget -q -O - http://127.0.0.1:2586/v1/health | grep -q '"healthy":true'; then echo "ntfy answers on the box."; else echo "ntfy is not healthy yet: sudo docker logs deck-ntfy" >&2; fi
REMOTE

if curl -fsS -m 15 "$BASE_URL/v1/health" >/dev/null 2>&1; then
  echo "$BASE_URL answers. On the phone: the ntfy app, Subscribe to topic, server $BASE_URL, the topic on the deck's Keys screen."
else
  echo "$BASE_URL does not answer yet. Add an A record for $NTFY_HOST pointing at the box; Caddy fetches the certificate once the name resolves."
fi
