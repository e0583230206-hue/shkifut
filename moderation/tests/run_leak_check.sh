#!/usr/bin/env bash
# Full leak check in the moderation image. Media: tests/media/*.mp4 (not in git).
#   LEVEL=strict MODEL_PROFILE=auto bash moderation/tests/run_leak_check.sh [video ...]
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
p() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
videos=("$@")
[ ${#videos[@]} -eq 0 ] && videos=(short.mp4 protest.mp4 long.mp4)
args=(); for v in "${videos[@]}"; do args+=("/media/$v"); done
docker run --rm --cpus 2 --memory 1g -e LEVEL="${LEVEL:-strict}" -e MODEL_PROFILE="${MODEL_PROFILE:-auto}" \
  -v "$(p "$PWD/moderation_models"):/models:ro" -v "$(p "$PWD/moderation/tests"):/t:ro" -v "$(p "$PWD/tests/media"):/media:ro" \
  thechannel-local-moderation python /t/leak_check.py "${args[@]}" 2>&1 | grep -v '^20[0-9][0-9]-'
