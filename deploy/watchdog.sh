#!/usr/bin/env bash
# Health watchdog (cron, every 5 minutes): alerts the private Google Chat space when the site, the moderation service,
# the WhatsApp bridge or the WhatsApp session stops working, and again when it recovers. One message per change.
#   WATCHDOG_DRY=1 deploy/watchdog.sh     # print what it would send, send nothing
set -uo pipefail
STATE=/var/lib/thechannel-watchdog
mkdir -p "$STATE"
BRIDGE_ENV=/opt/bridge/.env
envv() { grep -E "^$1=" "$BRIDGE_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'\r"; }
WEBHOOK="$(envv GCHAT_WEBHOOK)"
KEY="$(envv WAHA_API_KEY)"

notify() { # $1 text
    if [ "${WATCHDOG_DRY:-}" = 1 ] || [ -z "$WEBHOOK" ]; then echo "ALERT: $1"; return; fi
    python3 - "$WEBHOOK" "$1" <<'PY' >/dev/null 2>&1
import json, sys, urllib.request
req = urllib.request.Request(sys.argv[1], json.dumps({"text": sys.argv[2]}).encode(), {"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=15).read()
PY
}

check() { # $1 name, $2 label, rest: command that succeeds when healthy
    local name="$1" label="$2"; shift 2
    local f="$STATE/$name"
    if "$@" >/dev/null 2>&1; then
        if [ -e "$f" ]; then rm -f "$f"; notify "✅ חזר לפעול: $label"; fi
    else
        if [ ! -e "$f" ]; then date +%s > "$f"; notify "⚠️ תקלה בדמו: $label לא פועל. (בדיקה אוטומטית כל 5 דקות)"; fi
    fi
}

running() { [ "$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null)" = running ]; }
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
waha_working() { curl -fs -m 10 -H "X-Api-Key: $KEY" http://127.0.0.1:3456/api/sessions/default | grep -q '"status" *: *"WORKING"'; }

check site        "האתר (שרת האתר)"            curl -fs -m 10 -o /dev/null http://127.0.0.1:8090/login
check moderation  "שירות הטשטוש"               healthy thechannel-moderation-1
check redis       "מסד הנתונים"                healthy thechannel-redis-1
check bridge      "הגשר לוואטסאפ"              running bridge-bridge-1
check waha        "WAHA (תהליך וואטסאפ)"       running bridge-waha-1
check wasession   "חיבור וואטסאפ (נדרש סריקה מחדש?)" waha_working

# The dr@ authorisation for Chat: a refresh that fails means the bridge can no longer post originals (renew with bridge/chat_oauth.py).
chat_auth() { docker exec -i bridge-bridge-1 node -e "$(cat /opt/thechannel/deploy/chat_token_check.js)"; }
check chatauth    "הרשאת dr@ לשליחה ל-Chat (נדרש להריץ מחדש bridge/chat_oauth.py)" chat_auth
