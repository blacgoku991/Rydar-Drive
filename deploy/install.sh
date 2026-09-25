#!/usr/bin/env bash
# Installation et mises à jour de Rydar Drive sur un VPS Ubuntu (24.04 ou 26.04 LTS), en root :
#   sudo bash deploy/install.sh
# 1er passage : Docker, pare-feu, swap, puis création de deploy/.env à compléter.
# Passages suivants (après chaque « git pull ») : migrations de la base, construction, redémarrage.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
[ "$(id -u)" = 0 ] || { echo "À lancer en root : sudo bash deploy/install.sh"; exit 1; }

if ! command -v docker >/dev/null || ! command -v ufw >/dev/null; then
  echo "→ paquets système"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git ufw openssl >/dev/null
fi
if ! command -v docker >/dev/null; then
  echo "→ installation de Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

echo "→ pare-feu : SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

# 2 Go de swap : construction du site confortable même avec d'autres services sur la machine
if ! swapon --show | grep -q .; then
  echo "→ swap de 2 Go"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/deploy/.env.example" "$ENV_FILE"
  sed -i "s/^API_KEY_PEPPER=.*/API_KEY_PEPPER=$(openssl rand -hex 32)/" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo
  echo "✓ Fichier $ENV_FILE créé."
  echo "  Complétez-le (domaine, Supabase…) : nano $ENV_FILE"
  echo "  puis relancez : sudo bash deploy/install.sh"
  exit 0
fi

value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
missing=0
for v in DOMAIN ACME_EMAIL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY DATABASE_URL API_KEY_PEPPER; do
  if [ -z "$(value "$v")" ]; then echo "✗ $v manquant dans $ENV_FILE"; missing=1; fi
done
[ "$missing" = 0 ] || exit 1
DOMAIN="$(value DOMAIN)"

echo "→ migrations de la base (Supabase)"
bash "$ROOT/deploy/migrate.sh"

echo "→ construction et démarrage (plusieurs minutes la première fois)"
cd "$ROOT/deploy"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps

echo "→ vérification"
for _ in $(seq 1 30); do
  if docker compose exec -T web wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "✓ Rydar Drive tourne : https://$DOMAIN  (santé : https://$DOMAIN/api/health)"
    exit 0
  fi
  sleep 2
done
echo "✗ le site ne répond pas encore : cd $ROOT/deploy && docker compose logs --tail 100 web"
exit 1
