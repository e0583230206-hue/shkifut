#!/usr/bin/env bash
# Full leak check (every frame) in the moderation image. Media: tests/media/*.mp4 (not in git).
#   LEVEL=strict MODEL_PROFILE=auto bash moderation/tests/run_leak_check.sh [video ...]
# On the server (image built by docker-compose.prod.yml):
#   IMAGE=thechannel-moderation LEVEL=strict bash moderation/tests/run_leak_check.sh protest.mp4
# Runs detached (a full check takes 5-25 minutes); results stream to tests/media/leak_<level>_<profile>.log
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
p() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
videos=("$@")
[ ${#videos[@]} -eq 0 ] && videos=(short.mp4 protest.mp4 long.mp4)
args=""; for v in "${videos[@]}"; do args="$args /media/$v"; done
LEVEL="${LEVEL:-strict}"; PROFILE="${MODEL_PROFILE:-auto}"
NAME="leak-check-$LEVEL-$PROFILE"
LOG="leak_${LEVEL}_${PROFILE}.log"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --cpus 2 --memory 1g -u 0 -e LEVEL="$LEVEL" -e MODEL_PROFILE="$PROFILE" \
  -v "$(p "$PWD/moderation_models"):/models:ro" -v "$(p "$PWD/moderation/tests"):/t:ro" -v "$(p "$PWD/tests/media"):/media" \
  "${IMAGE:-thechannel-local-moderation}" \
  sh -c "python -u /t/leak_check.py $args 2>&1 | grep --line-buffered -v '^20[0-9][0-9]-' > /media/$LOG" >/dev/null
echo "started $NAME -> tests/media/$LOG  (follow: tail -f tests/media/$LOG; done when 'TOTAL REAL LEAKS' appears)"
