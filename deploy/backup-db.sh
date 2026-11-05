#!/usr/bin/env bash
# Daily SMALL backup of the live site: the database (a consistent kvrocks snapshot) and the settings (.env of the site and of the bridge, the compose files,
# kvrocks.conf, and the bridge's table "WhatsApp message -> site message number"). NOT the media (channel_data, several GB) and NOT the WhatsApp session.
# The big backup with the media is deploy/backup.sh. Cron (installed by hand on the live server, see /etc/cron.d/thechannel-backup):
#   30 3 * * * root /opt/thechannel/deploy/backup-db.sh >> /var/log/thechannel-backup.log 2>&1
# The files are written under a temporary name and renamed when they are whole, so that a copy running at the same time never takes half a file.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_DIR="${BRIDGE_DIR:-/opt/bridge}"
DEST="${BACKUP_DIR:-/var/backups/thechannel}"
KEEP_DAYS="${KEEP_DAYS:-7}"
TS="$(date +%Y-%m-%d_%H%M)"
COMPOSE=(docker compose -f "$APP_DIR/docker-compose.prod.yml")

mkdir -p "$DEST"
chmod 700 "$DEST"   # the settings contain secrets
cd "$APP_DIR"

# 1. The database: ask kvrocks for a snapshot, wait until it is written, then archive it.
before="$("${COMPOSE[@]}" exec -T redis redis-cli -s /data/kvrocks.sock LASTSAVE | tr -dc 0-9)"
"${COMPOSE[@]}" exec -T redis redis-cli -s /data/kvrocks.sock BGSAVE >/dev/null
for _ in $(seq 1 120); do
    now="$("${COMPOSE[@]}" exec -T redis redis-cli -s /data/kvrocks.sock LASTSAVE | tr -dc 0-9)"
    [ "$now" != "$before" ] && break
    sleep 1
done
if [ "$now" = "$before" ]; then echo "$(date '+%F %T') backup FAILED: kvrocks did not finish the snapshot" >&2; exit 1; fi
"${COMPOSE[@]}" exec -T redis tar czf - -C /var/lib/kvrocks backup > "$DEST/db-$TS.tgz.part"
tar tzf "$DEST/db-$TS.tgz.part" >/dev/null   # the archive is readable
mv "$DEST/db-$TS.tgz.part" "$DEST/db-$TS.tgz"

# 2. The settings (only what exists).
files=()
for f in "$APP_DIR/.env" "$APP_DIR"/docker-compose*.yml "$APP_DIR/kvrocks.conf" "$BRIDGE_DIR/.env" "$BRIDGE_DIR/docker-compose.yml" "$BRIDGE_DIR/media/wa-site-ids.json"; do
    [ -e "$f" ] && files+=("${f#/}")
done
tar czf "$DEST/config-$TS.tgz.part" -C / "${files[@]}"
mv "$DEST/config-$TS.tgz.part" "$DEST/config-$TS.tgz"
chmod 600 "$DEST"/db-"$TS".tgz "$DEST"/config-"$TS".tgz

# 3. Rotation
find "$DEST" \( -name 'db-*.tgz' -o -name 'config-*.tgz' -o -name '*.part' \) -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%F %T') backup ok: $(du -sh "$DEST/db-$TS.tgz" | cut -f1) db, $(du -sh "$DEST/config-$TS.tgz" | cut -f1) config -> $DEST"
