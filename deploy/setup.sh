#!/usr/bin/env bash
# Instala ou atualiza o app numa VPS Ubuntu/Debian. Rode como root:
#   curl -fsSL https://raw.githubusercontent.com/leonquenix/vouncher-system/main/deploy/setup.sh | bash -s -- festa.seudominio.com.br
# Sem domínio, o Caddy serve em http://IP-da-VPS (bom pra testar; a câmera só funciona com domínio + HTTPS).
# Rodar de novo com outro domínio só troca o Caddyfile; o banco em /opt/festa/data é preservado.
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/leonquenix/vouncher-system.git"
APP=/opt/festa

[ "$(id -u)" -eq 0 ] || { echo "Rode como root (sudo -i)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Pacotes básicos"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Código"
id festa >/dev/null 2>&1 || useradd -r -m -d "$APP" -s /usr/sbin/nologin festa
if [ -d "$APP/.git" ]; then
  git -C "$APP" pull --ff-only
else
  rm -rf "$APP.tmp" && git clone "$REPO" "$APP.tmp"
  cp -a "$APP.tmp/." "$APP/" && rm -rf "$APP.tmp"
fi
git config --global --add safe.directory "$APP"
cd "$APP"
npm install --omit=dev

if [ ! -f .env ]; then
  PW=$(openssl rand -base64 12 | tr -d '/+=')
  sed "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$PW/" .env.example > .env
  echo "$PW" > /root/festa-admin-senha.txt && chmod 600 /root/festa-admin-senha.txt
fi
chown -R festa:festa "$APP"

echo "==> Serviço"
cp deploy/festa.service /etc/systemd/system/festa.service
systemctl daemon-reload
systemctl enable festa
systemctl restart festa

echo "==> Caddyfile"
SITE="${DOMAIN:-:80}"
printf '%s {\n    reverse_proxy localhost:3000\n}\n' "$SITE" > /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

IP=$(curl -fsS4 https://ifconfig.me || hostname -I | awk '{print $1}')
echo
echo "Pronto."
echo "  App:   ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$IP}"
echo "  Admin: login 'admin', senha em /root/festa-admin-senha.txt (só vale se o banco era novo)"
[ -n "$DOMAIN" ] && echo "  O DNS de $DOMAIN precisa apontar (registro A) para $IP; o Caddy tira o certificado assim que apontar."
