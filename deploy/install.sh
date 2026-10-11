#!/usr/bin/env bash
# One-command install / update of TheChannel ("שקיפות") on Ubuntu, behind the server's existing nginx.
#
#   sudo ./deploy/install.sh <domain> <email> [--port 8090] [--no-ssl] [--force-nginx]
#   e.g. sudo ./deploy/install.sh 30206.co.il e0583230206@gmail.com
#
# Safe to run again (updates the app). What it does:
#   1. checks / installs Docker (Ubuntu packages) and certbot
#   2. creates .env on first run (random SECRET_KEY, APP_ENV=production, PUBLIC_URL)
#   3. prepares the moderation models (one-time build, ~10 min) and the body model
#   4. builds and starts the containers (backend only on 127.0.0.1:<port>)
#   5. adds ONE nginx site for <domain> (other sites untouched; nginx -t before reload)
#   6. HTTPS with certbot (only when the domain already points to this server)
#   7. daily backup cron job
# Optional environment: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_USERS (used when creating .env).
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"
shift $(( $# >= 2 ? 2 : $# )) || true
PORT=8090; SSL=1; FORCE_NGINX=0
while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --no-ssl) SSL=0; shift ;;
        --force-nginx) FORCE_NGINX=1; shift ;;
        *) echo "unknown option: $1"; exit 2 ;;
    esac
done
if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    sed -n '2,8p' "$0"; exit 2
fi
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
COMPOSE=(docker compose -f docker-compose.prod.yml)
step() { echo; echo "==> $*"; }

step "1/7 Docker and tools"
if ! command -v docker >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2
    systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-v2
command -v python3 >/dev/null 2>&1 || apt-get install -y python3
command -v nginx >/dev/null 2>&1 || { echo "nginx is not installed on this server - expected an existing nginx"; exit 1; }
if [ "$SSL" -eq 1 ] && ! command -v certbot >/dev/null 2>&1; then
    apt-get install -y certbot python3-certbot-nginx
fi

step "2/7 Configuration (.env)"
if [ ! -f .env ]; then
    cat > .env <<EOF
# Created by deploy/install.sh on $(date +%F). Keep secret; it is backed up with the data.
SERVER_PORT=3000
SECRET_KEY=$(openssl rand -hex 32)
REDIS_ADDR=/app/data/kvrocks.sock
REDIS_PROTOCOL=unix
APP_ENV=production
PUBLIC_URL=https://$DOMAIN
APP_PORT=$PORT

GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
ADMIN_USERS=${ADMIN_USERS:-$EMAIL}
EOF
    chmod 600 .env
    echo "created .env"
else
    echo ".env exists - kept as is"
    grep -q '^APP_PORT=' .env && PORT="$(grep '^APP_PORT=' .env | cut -d= -f2)"
fi
grep -q '^GOOGLE_CLIENT_ID=.\+' .env || echo "!! GOOGLE_CLIENT_ID is empty in .env - Google login will not work until it is set (see docs/GOOGLE_OAUTH.md)"
export APP_PORT="$PORT"

step "3/7 Port $PORT"
if ss -ltnH "( sport = :$PORT )" | grep -q . ; then
    if ! "${COMPOSE[@]}" ps --status running -q backend 2>/dev/null | grep -q . ; then
        echo "port 127.0.0.1:$PORT is used by another service - choose another: --port <n>"; exit 1
    fi
fi

step "4/7 Moderation models"
mkdir -p moderation_models channel_data logs
if [ ! -f moderation_models/person.onnx ] || [ ! -f moderation_models/face_det.onnx ]; then
    echo "building the detection models once (several minutes)..."
    docker build -f moderation/Dockerfile.models --output type=local,dest=moderation_models .
fi
if [ ! -f moderation_models/par.bin ]; then
    python3 moderation/fetch_body_model.py || echo "!! body model not installed (blurring still works, with face-only gender)"
fi

step "5/7 Build and start"
"${COMPOSE[@]}" up -d --build
for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/channel/info" >/dev/null 2>&1 && break
    sleep 3
done
curl -fsS "http://127.0.0.1:$PORT/api/channel/info" >/dev/null && echo "app is up on 127.0.0.1:$PORT" || { "${COMPOSE[@]}" logs --tail 50; echo "app did not start"; exit 1; }

step "6/7 nginx site for $DOMAIN"
SITE="/etc/nginx/sites-available/$DOMAIN.conf"
if [ -f "$SITE" ] && [ "$FORCE_NGINX" -eq 0 ]; then
    echo "$SITE exists - kept (use --force-nginx to regenerate)"
else
    [ -f "$SITE" ] && cp "$SITE" "$SITE.bak.$(date +%s)"
    sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" deploy/nginx-site.conf.template > "$SITE"
fi
ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN.conf"
if ! nginx -t; then
    rm -f "/etc/nginx/sites-enabled/$DOMAIN.conf"
    echo "nginx configuration test failed - the new site was disabled, nothing else changed"; exit 1
fi
systemctl reload nginx

step "7/7 HTTPS and backups"
if [ "$SSL" -eq 1 ]; then
    server_ip="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
    dns_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
    if [ "$server_ip" = "$dns_ip" ]; then
        certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --hsts \
            || certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --hsts
    else
        echo "!! $DOMAIN points to '${dns_ip:-nothing}', this server is $server_ip - HTTPS skipped."
        echo "   After updating DNS, run again: sudo ./deploy/install.sh $DOMAIN $EMAIL"
    fi
fi
chmod +x deploy/backup.sh
cat > /etc/cron.d/thechannel <<EOF
# TheChannel daily backup (deploy/backup.sh)
30 3 * * * root $APP_DIR/deploy/backup.sh >> /var/log/thechannel-backup.log 2>&1
EOF

echo
echo "Done. Site: https://$DOMAIN  (admin: log in with Google as one of ADMIN_USERS)"
