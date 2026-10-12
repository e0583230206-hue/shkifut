#!/usr/bin/env bash
# ON THE SERVER (copy the bridge/ files to /tmp/bridge-upload first):
#   bash /tmp/bridge-upload/deploy_to_server.sh <spaces/ID> <sha256 prefix of the tested bridge.js>
# Stages the change next to the live bridge, verifies it, then switches over and restarts ONLY the bridge container.
# Nothing else in /opt/bridge (WAHA, sessions, other settings) is touched. Rollback: copy the three files back from the
# backup folder printed below and run: cd /opt/bridge && docker compose up -d --no-deps bridge
set -euo pipefail
SPACE="$1"; WANT="$2"
UP=/tmp/bridge-upload
B=/opt/bridge
TS=$(date +%Y%m%d-%H%M%S)
BK="$B/backup-chat-$TS"
STAGE="$B/.stage-chat"
mkdir -p "$BK" "$STAGE"
chmod 700 "$BK" "$STAGE"
cp -a "$B/.env" "$B/docker-compose.yml" "$B/bridge.js" "$BK/"
cp -a "$B/.env" "$B/docker-compose.yml" "$B/bridge.js" "$STAGE/"
echo "backup: $BK"

python3 "$UP/patch_bridge.py" "$STAGE" --compose --env "$SPACE"
GOT=$(sha256sum "$STAGE/bridge.js" | cut -c1-${#WANT})
if [ "$GOT" != "$WANT" ]; then
    echo "bridge.js differs from the tested file ($GOT != $WANT) - nothing was changed"
    exit 1
fi
cp "$UP/chat-sender.js" "$STAGE/chat-sender.js"
docker run --rm -v "$STAGE:/t:ro" node:22-alpine sh -c 'node --check /t/bridge.js && node --check /t/chat-sender.js' >/dev/null
( cd "$STAGE" && docker compose -f docker-compose.yml --env-file .env config -q )
echo "staged files verified (same bridge.js as tested, syntax ok, compose valid)"

# switch over
cp "$STAGE/chat-sender.js" "$B/chat-sender.js"
for f in bridge.js docker-compose.yml .env; do
    cp -a "$STAGE/$f" "$B/$f.new"
    mv "$B/$f.new" "$B/$f"
done
cd "$B" && docker compose up -d --no-deps bridge 2>&1 | tail -2
sleep 4
docker logs bridge-bridge-1 --tail 4 2>&1 | cut -c1-160
