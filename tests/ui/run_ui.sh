#!/usr/bin/env bash
# Runs tests/ui/ui_check.mjs in headless Chromium against the local stack (docker-compose.local.yml).
# Needs the images "local-chromium" (alpine + chromium + Hebrew fonts) and node:24-alpine.
# Temporarily enables test ads (embed code every 2 messages) and restores the settings afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
NET=thechannel-local_default
HERE="$(pwd)/tests/ui"
command -v cygpath >/dev/null 2>&1 && HERE="$(cygpath -m "$HERE")"

if ! docker image inspect local-chromium >/dev/null 2>&1; then
  printf 'FROM alpine:3.20\nRUN apk add --no-cache chromium font-noto font-noto-hebrew\n' | docker build -q -t local-chromium - >/dev/null
fi

# settings: save (unless a previous unfinished run left a backup - that one holds the real original),
# enable test ads, restore on exit and delete the backup only after a successful restore.
BACKUP=tests/ui/.settings_backup.json
python -I - "$BACKUP" <<'EOF'
import http.cookiejar, json, os, sys, urllib.request
backup = sys.argv[1]
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op.open("http://localhost:8080/auth/dev-login").read()
if os.path.exists(backup):
    orig = json.load(open(backup, encoding="utf-8"))
else:
    orig = json.loads(op.open("http://localhost:8080/api/admin/settings/get").read() or b"[]") or []
    json.dump(orig, open(backup, "w", encoding="utf-8"), ensure_ascii=False)
test = [s for s in orig if not s["key"].startswith(("ads_", "ad-iframe"))] + [
    {"key": "ads_embed_code", "value": "<div style='font:16px sans-serif'>פרסומת לבדיקה</div>"},
    {"key": "ads_feed_every", "value": 2}]
op.open(urllib.request.Request("http://localhost:8080/api/admin/settings/set", data=json.dumps(test).encode(),
                               headers={"Content-Type": "application/json"})).read()
EOF
restore() {
  python -I - "$BACKUP" <<'EOF' && rm -f "$BACKUP"
import http.cookiejar, json, sys, urllib.request
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op.open("http://localhost:8080/auth/dev-login").read()
orig = open(sys.argv[1], encoding="utf-8").read()
op.open(urllib.request.Request("http://localhost:8080/api/admin/settings/set", data=orig.encode(),
                               headers={"Content-Type": "application/json"})).read()
assert (json.loads(op.open("http://localhost:8080/api/admin/settings/get").read() or b"[]") or []) == json.loads(orig)
EOF
  docker rm -f ui-chromium >/dev/null 2>&1 || true
}
trap 'restore; trap - EXIT' EXIT INT TERM

MSG_ID="$(curl -s 'http://localhost:8080/api/messages?offset=0&limit=1' | python -I -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if d else "")')"

docker rm -f ui-chromium >/dev/null 2>&1 || true
# Docker's default /dev/shm (64MB) is too small for Chromium at desktop size: pages freeze with
# ERR_INSUFFICIENT_RESOURCES. Give it room and keep shared memory off /dev/shm.
docker run -d --name ui-chromium --shm-size=1g --network "$NET" local-chromium chromium-browser --headless --no-sandbox \
  --disable-dev-shm-usage --disable-gpu --lang=he --remote-debugging-port=9222 --remote-allow-origins='*' about:blank >/dev/null
sleep 3
docker run --rm --network container:ui-chromium -e MSG_ID="$MSG_ID" -v "$HERE:/t:ro" node:24-alpine \
  node /t/ui_check.mjs
