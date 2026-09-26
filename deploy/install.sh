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
  if ! curl -fsSL https://get.docker.com | sh; then
    # Version d'Ubuntu trop récente pour le dépôt Docker : paquets Ubuntu
    echo "  dépôt Docker indisponible : paquets Ubuntu"
    rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose-v2 docker-buildx >/dev/null
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || { echo "✗ « docker compose » introuvable : installez le paquet docker-compose-plugin"; exit 1; }

echo "→ pare-feu : SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
# Port SSH réellement configuré, s'il n'est pas 22 : ne jamais se couper l'accès au serveur
for port in $(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u); do
  ufw allow "$port/tcp" >/dev/null
done
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
  if [ -t 0 ]; then
    # Dans un terminal : questions posées directement (clés saisies sans affichage)
    bash "$ROOT/deploy/configure.sh"
  else
    cp "$ROOT/deploy/.env.example" "$ENV_FILE"
    sed -i "s/^API_KEY_PEPPER=.*/API_KEY_PEPPER=$(openssl rand -hex 32)/" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo
    echo "✓ Fichier $ENV_FILE créé."
    echo "  Renseignez-le dans un terminal (clés saisies sans affichage) : sudo bash $ROOT/deploy/configure.sh"
    echo "  puis relancez : sudo bash $ROOT/deploy/install.sh"
    exit 0
  fi
fi

value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
missing=0
for v in DOMAIN ACME_EMAIL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY DATABASE_URL API_KEY_PEPPER; do
  if [ -z "$(value "$v")" ]; then echo "✗ $v manquant dans $ENV_FILE"; missing=1; fi
done
[ "$missing" = 0 ] || { echo "  → complétez dans un terminal : sudo bash $ROOT/deploy/configure.sh"; exit 1; }
DOMAIN="$(value DOMAIN)"

# DNS : le certificat HTTPS n'est délivré que si le domaine pointe vers ce serveur (simple avertissement,
# Caddy réessaie tout seul une fois le DNS à jour)
server_ip="$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
dns_ip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 {print $1}' || true)"
if [ -z "$dns_ip" ]; then
  echo "⚠ $DOMAIN ne pointe encore vers aucune adresse : ajoutez les enregistrements A (deploy/README.md, étape 1)."
elif [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; then
  echo "⚠ $DOMAIN pointe vers $dns_ip et non vers ce serveur ($server_ip) : corrigez le DNS ou attendez sa propagation."
fi
if getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '{print $1}' | grep -qv '^::ffff:'; then
  echo "⚠ $DOMAIN a aussi une adresse IPv6 (AAAA) : supprimez-la chez le registraire si ce n'est pas celle du serveur."
fi

echo "→ migrations de la base (Supabase)"
bash "$ROOT/deploy/migrate.sh"

echo "→ construction et démarrage (plusieurs minutes la première fois)"
cd "$ROOT/deploy"
docker compose up -d --build --remove-orphans
# Caddyfile monté en volume : relu à chaque mise à jour (sinon ses changements attendraient un redémarrage)
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || docker compose restart caddy >/dev/null
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
