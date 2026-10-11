#!/usr/bin/env bash
# Daily backup of TheChannel: database (kvrocks consistent snapshot), uploaded media, logs and .env.
# Installed as a cron job by deploy/install.sh. Keeps the last $KEEP_DAYS days.
#   sudo ./deploy/backup.sh            # run now
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-/var/backups/thechannel}"
KEEP_DAYS="${KEEP_DAYS:-7}"
TS="$(date +%Y-%m-%d_%H%M)"
COMPOSE=(docker compose -f "${COMPOSE_FILE_PATH:-$APP_DIR/docker-compose.prod.yml}")

mkdir -p "$DEST"
chmod 700 "$DEST"   # backups contain .env (secrets)
cd "$APP_DIR"

# 1. Database: ask kvrocks for a consistent snapshot, wait until it is written, then archive it.
before="$("${COMPOSE[@]}" exec -T redis redis-cli -s /data/kvrocks.sock LASTSAVE | tr -dc 0-9)"
"${COMPOSE[@]}" exec -T redis redis-cli -s /data/kvrocks.sock BGSAVE >/dev/null
for _ in $(seq 1 120); do
    now="$("${COMPOSE[@]}" exec -T redis redis-cli -s /data/kvrocks.sock LASTSAVE | tr -dc 0-9)"
    [ "$now" != "$before" ] && break
    sleep 1
done
"${COMPOSE[@]}" exec -T redis tar czf - -C /var/lib/kvrocks backup > "$DEST/db-$TS.tgz"

# 2. Media, logs and configuration (the blurred versions are regenerated, so they are not backed up).
tar czf "$DEST/files-$TS.tgz" channel_data logs .env

# 3. Rotation
find "$DEST" -name '*.tgz' -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%F %T') backup ok: $(du -sh "$DEST/db-$TS.tgz" | cut -f1) db, $(du -sh "$DEST/files-$TS.tgz" | cut -f1) files -> $DEST"
