#!/usr/bin/env bash
# Sets up (or updates) ADVENT on the Hetzner box. Run as root ON THE BOX after deploy/push.sh has shipped the code:
#   bash /opt/advent/deploy/hetzner.sh
# Idempotent. Never touches keys/ or .env (JJ copies those by hand). Installs Caddy for TLS on API_HOST.
set -euo pipefail
APP=/opt/advent
API_HOST=${API_HOST:-api.advent.lol}

id -u advent >/dev/null 2>&1 || useradd -r -m -d $APP -s /usr/sbin/nologin advent
mkdir -p $APP/{draws,state,posts,keys}
chown -R advent:advent $APP
chmod 700 $APP/keys; chmod 600 $APP/keys/*.json 2>/dev/null || true
[ -f $APP/.env ] || { cp $APP/.env.example $APP/.env; echo "NOTE: $APP/.env created from .env.example; fill it"; }
chown advent:advent $APP/.env; chmod 600 $APP/.env

echo "== node deps"
node -v
( cd $APP/keeper && sudo -u advent npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2 )

echo "== systemd"
cp $APP/deploy/advent-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable advent-api advent-keeper advent-poster >/dev/null
systemctl restart advent-api
# the keeper and poster need MINT in .env; they just restart-loop quietly until it's there
systemctl restart advent-keeper advent-poster || true

echo "== caddy (TLS for $API_HOST -> :8787)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudflare.com/public/apt/pubkey' >/dev/null 2>&1 || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update >/dev/null && apt-get install -y caddy >/dev/null
fi
cat > /etc/caddy/Caddyfile <<CADDY
$API_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl enable caddy >/dev/null; systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "== status"
sleep 2
systemctl --no-pager --lines=0 status advent-api caddy | grep -E "●|Active"
curl -s -m 5 http://127.0.0.1:8787/pot | head -c 300; echo
echo "DNS: $API_HOST must be an A record to this box ($(curl -s -m 5 -4 ifconfig.me || hostname -I | awk '{print $1}')) for Caddy to get its certificate."
