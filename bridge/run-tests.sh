#!/usr/bin/env bash
# Chat sender unit tests + bridge integration scenarios (simulated WAHA / site / Google; nothing leaves the machine).
set -u
cd "$(dirname "$0")/.."
node --test bridge/chat-sender.test.mjs bridge/notify-guard.test.mjs bridge/message-filter.test.mjs bridge/reply-quote.test.mjs bridge/capture.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"
B="$PWD/bridge"; command -v cygpath >/dev/null 2>&1 && B="$(cygpath -m "$B")"
export MSYS_NO_PATHCONV=1
fail=0
for s in media-enabled media-disabled text-only chat-fails auth-fails other-group duplicate edit-events command-noise reply capture capture-expired notify notify-off; do
  out=$(docker run --rm -v "$B:/app:ro" -e SCENARIO=$s node:22-alpine node /app/bridge.integration.cjs 2>&1) || fail=1
  echo "$out" | grep -E "^(PASS|FAIL)" | sed "s/^/[$s] /"
done
echo "integration: $([ $fail = 0 ] && echo ALL PASSED || echo FAILED)"; exit $fail
