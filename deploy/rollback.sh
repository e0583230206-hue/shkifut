#!/usr/bin/env bash
# Roll the backend back to an image that is ALREADY on this server.
#
#   rollback.sh <tag>            dry run: shows what would change, changes nothing (the default)
#   rollback.sh <tag> --apply    changes the running backend
#
# What it does, and what it refuses:
#   - refuses a tag that is not an image on this server, and refuses "latest" (that is the current version);
#   - does nothing if the requested image is already the running one;
#   - keeps the CURRENT latest under a new tag "before-rollback-<UTC time>" first, so the way back always exists;
#   - recreates ONLY the backend container (no volumes, no other services, no data, nothing is deleted);
#   - checks that the site answers; if it does not, it returns to the kept image by itself and reports it;
#   - appends one line to the deploy log for every change.
#
# Environment (defaults are the live server):
#   COMPOSE_DIR     /opt/thechannel
#   COMPOSE_FILES   "-f docker-compose.prod.yml -f docker-compose.bridge-net.yml"
#   REPO            thechannel-backend
#   SERVICE         backend
#   HEALTH_URL      http://127.0.0.1:8090/
#   DEPLOY_LOG      /var/log/thechannel-deploys.log
set -euo pipefail

TAG="${1:-}"
MODE="${2:-}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/thechannel}"
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.prod.yml -f docker-compose.bridge-net.yml}"
REPO="${REPO:-thechannel-backend}"
SERVICE="${SERVICE:-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8090/}"
DEPLOY_LOG="${DEPLOY_LOG:-/var/log/thechannel-deploys.log}"

if [[ -z "$TAG" ]]; then echo "usage: $0 <tag> [--apply]"; exit 2; fi
if [[ ! "$TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then echo "REFUSING: the tag has characters that are not allowed"; exit 2; fi
if [[ "$TAG" == "latest" ]]; then echo "REFUSING: 'latest' is the current version; choose an older tag"; exit 2; fi
if [[ -n "$MODE" && "$MODE" != "--apply" ]]; then echo "REFUSING: the second argument must be --apply or nothing"; exit 2; fi

cd "$COMPOSE_DIR"
dc() { docker compose $COMPOSE_FILES "$@"; }   # the word splitting of COMPOSE_FILES is intended

target_id="$(docker image inspect "$REPO:$TAG" --format '{{.Id}}' 2>/dev/null)" \
  || { echo "REFUSING: the image $REPO:$TAG does not exist on this server. Nothing was changed."; exit 1; }
latest_id="$(docker image inspect "$REPO:latest" --format '{{.Id}}' 2>/dev/null || echo none)"
cid="$(dc ps -q "$SERVICE" 2>/dev/null || true)"
running_id="$( [[ -n "$cid" ]] && docker inspect "$cid" --format '{{.Image}}' 2>/dev/null || echo none)"

if [[ "$running_id" == "$target_id" ]]; then
  echo "nothing to do: $REPO:$TAG is already the running image ($target_id)"
  exit 0
fi

keep="before-rollback-$(date -u +%Y%m%d%H%M%S)"
echo "plan:"
echo "  running now : $running_id"
echo "  latest tag  : $latest_id"
echo "  target      : $REPO:$TAG = $target_id"
echo "  kept as     : $REPO:$keep (the current latest, so the way back exists)"
echo "  recreated   : service '$SERVICE' only; no volume, no other service is touched"

if [[ "$MODE" != "--apply" ]]; then
  echo "dry run: nothing was changed. To apply: $0 $TAG --apply"
  exit 0
fi

docker tag "$REPO:latest" "$REPO:$keep"
docker tag "$REPO:$TAG" "$REPO:latest"
dc up -d --no-build --no-deps "$SERVICE"

is_healthy() {
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 5 "$HEALTH_URL"; then return 0; fi
    sleep 2
  done
  return 1
}

if is_healthy; then
  echo "OK: $REPO:$TAG is running and answers at $HEALTH_URL"
  echo "$(date -u +%FT%TZ) ROLLBACK service=$SERVICE to $REPO:$TAG (previous latest $latest_id kept as $REPO:$keep)" >> "$DEPLOY_LOG"
  exit 0
fi

echo "NOT HEALTHY after the change: returning to the kept image $REPO:$keep"
docker tag "$REPO:$keep" "$REPO:latest"
dc up -d --no-build --no-deps "$SERVICE"
if is_healthy; then
  echo "back on the previous image and healthy. Nothing was deleted."
else
  echo "the previous image also does not answer: read the container logs now"
fi
echo "$(date -u +%FT%TZ) ROLLBACK FAILED to $REPO:$TAG; reverted to $REPO:$keep" >> "$DEPLOY_LOG"
exit 1
