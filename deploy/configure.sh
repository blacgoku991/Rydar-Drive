#!/usr/bin/env bash
# Assistant de configuration de Rydar Drive (deploy/.env), à lancer dans un terminal, en root :
#   sudo bash deploy/configure.sh
# Les clés et mots de passe se tapent ou se collent ici, sans affichage : jamais dans un chat ni un e-mail.
# Relançable à tout moment (Entrée garde la valeur actuelle). Ensuite : sudo bash deploy/install.sh
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
[ "$(id -u)" = 0 ] || { echo "À lancer en root : sudo bash deploy/configure.sh"; exit 1; }
[ -t 0 ] || { echo "✗ À lancer dans un terminal, au clavier : sudo bash deploy/configure.sh"; exit 1; }
[ -f "$ENV_FILE" ] || cp "$ROOT/deploy/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

# put CLÉ VALEUR : remplace la ligne CLÉ=… (ou l'ajoute), sans interpréter la valeur
put() {
  KEY="$1" VAL="$2" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
    index($0, k "=") == 1 && !done { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$TMP/env"
  cat "$TMP/env" > "$ENV_FILE"
}

# ask CLÉ "Question" [secret] → $answer (Entrée : valeur actuelle)
ask() {
  local key="$1" label="$2" secret="${3:-}" current hint="" input=""
  current="$(get "$key")"
  if [ -n "$current" ]; then
    if [ -n "$secret" ]; then hint=" [déjà renseigné, Entrée pour garder]"; else hint=" [$current]"; fi
  fi
  if [ -n "$secret" ]; then
    read -r -s -p "$label$hint : " input
    echo
  else
    read -r -p "$label$hint : " input
  fi
  input="$(printf '%s' "$input" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  answer="${input:-$current}"
}

urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

# Rôle d'une ancienne clé JWT de Supabase (anon / service_role), vide pour les nouvelles clés
jwt_role() {
  local p
  p="$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')"
  while [ $((${#p} % 4)) -ne 0 ]; do p="$p="; done
  printf '%s' "$p" | base64 -d 2>/dev/null | grep -o '"role" *: *"[a-z_]*"' | sed -E 's/.*"([a-z_]*)"$/\1/' || true
}

# En-têtes d'authentification : les nouvelles clés (sb_…) vont seules dans apikey (la passerelle Supabase en
# déduit le rôle) ; les anciennes clés JWT vont aussi dans Authorization
auth_headers() {
  printf 'apikey: %s\n' "$1"
  case "$1" in sb_*) ;; *) printf 'Authorization: Bearer %s\n' "$1" ;; esac
}

# Code HTTP d'un appel à l'API Supabase ; la clé passe par un fichier, jamais par la ligne de commande
http_status() {
  auth_headers "$2" > "$TMP/h"
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @"$TMP/h" "$1" || true
}

echo "Configuration de Rydar Drive — Entrée garde la valeur entre crochets."
echo "Les clés et mots de passe ne s'affichent pas pendant la saisie : c'est normal."
echo

# ------------------------------------------------------------------ Domaine
while :; do
  ask DOMAIN "Nom de domaine (ex. rydardrive.fr)"
  d="$(printf '%s' "$answer" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"
  if [[ "$d" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then put DOMAIN "$d"; break; fi
  echo "  ✗ domaine invalide (ex. rydardrive.fr, sans https:// ni www)"
done
while :; do
  ask ACME_EMAIL "E-mail de contact (certificats HTTPS)"
  if [[ "$answer" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then put ACME_EMAIL "$answer"; break; fi
  echo "  ✗ e-mail invalide"
done

# ------------------------------------------------------------------ Supabase
echo
echo "Supabase → Project Settings → API Keys (et l'URL du projet, https://xxxx.supabase.co)."
while :; do
  ask NEXT_PUBLIC_SUPABASE_URL "URL du projet Supabase"
  url="${answer%/}"
  if [[ "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    [[ "$url" =~ ^https://.*\.supabase\.co$ ]] || echo "  ⚠ adresse inhabituelle (attendu : https://xxxx.supabase.co)"
    put NEXT_PUBLIC_SUPABASE_URL "$url"
    break
  fi
  echo "  ✗ URL invalide (ex. https://abcdefgh.supabase.co)"
done

while :; do
  ask NEXT_PUBLIC_SUPABASE_ANON_KEY "Clé publishable (sb_publishable_…) ou anon" secret
  key="$answer"
  if [[ "$key" == sb_secret_* ]] || [ "$(jwt_role "$key")" = service_role ]; then
    echo "  ✗ c'est la clé SECRÈTE : ici, la clé publishable (ou anon)"; continue
  fi
  if [[ "$key" != sb_publishable_* && "$key" != eyJ* ]]; then
    echo "  ✗ clé non reconnue (commence par sb_publishable_ ou eyJ)"; continue
  fi
  code="$(http_status "$url/auth/v1/settings" "$key")"
  case "$code" in
    200) echo "  ✓ clé publishable acceptée par Supabase" ;;
    401 | 403) echo "  ✗ clé refusée par Supabase (projet différent ?)"; continue ;;
    *) echo "  ⚠ vérification impossible (réponse $code) : on continue" ;;
  esac
  put NEXT_PUBLIC_SUPABASE_ANON_KEY "$key"
  break
done

while :; do
  ask SUPABASE_SERVICE_ROLE_KEY "Clé secret (sb_secret_…) ou service_role" secret
  key="$answer"
  if [[ "$key" == sb_publishable_* ]] || [ "$(jwt_role "$key")" = anon ]; then
    echo "  ✗ c'est la clé publique : ici, la clé secret (ou service_role)"; continue
  fi
  if [[ "$key" != sb_secret_* && "$key" != eyJ* ]]; then
    echo "  ✗ clé non reconnue (commence par sb_secret_ ou eyJ)"; continue
  fi
  code="$(http_status "$url/auth/v1/admin/users?per_page=1" "$key")"
  case "$code" in
    200) echo "  ✓ clé secrète acceptée par Supabase" ;;
    401 | 403) echo "  ✗ clé refusée par Supabase (projet différent ?)"; continue ;;
    *) echo "  ⚠ vérification impossible (réponse $code) : on continue" ;;
  esac
  put SUPABASE_SERVICE_ROLE_KEY "$key"
  break
done

# ------------------------------------------------------------------ Base de données
echo
echo "Base : Supabase → bouton « Connect » → « Session pooler » (port 5432) → copiez la chaîne telle quelle."
while :; do
  ask DATABASE_URL "Chaîne de connexion (postgresql://…)" secret
  db="$answer"
  if ! [[ "$db" =~ ^postgres(ql)?:// ]]; then
    echo "  ✗ la chaîne doit commencer par postgresql://"; continue
  fi
  if [[ "$db" =~ @db\.[a-z0-9]+\.supabase\.co ]]; then
    echo "  ✗ c'est la connexion directe (IPv6, injoignable depuis Docker) : prenez « Session pooler »"; continue
  fi
  if [[ "$db" == *"[YOUR-PASSWORD]"* ]] || ! [[ "$db" =~ ^postgres(ql)?://[^:/@]+:[^@]+@ ]]; then
    read -r -s -p "Mot de passe de la base (choisi à la création du projet) : " pw
    echo
    [ -n "$pw" ] || { echo "  ✗ mot de passe vide"; continue; }
    enc="$(urlencode "$pw")"
    if [[ "$db" == *"[YOUR-PASSWORD]"* ]]; then
      db="${db//"[YOUR-PASSWORD]"/"$enc"}"
    else
      db="$(printf '%s' "$db" | sed -E "s#^(postgres(ql)?://[^:/@]+)@#\\1:$enc@#")"
    fi
  fi
  if [[ "$db" == *:6543/* ]]; then
    db="${db/:6543\//:5432/}"
    echo "  → port 6543 (mode transaction) remplacé par 5432 (mode session, nécessaire au worker)"
  fi
  if [[ "$db" != *sslmode=* ]]; then
    if [[ "$db" == *\?* ]]; then db="$db&sslmode=no-verify"; else db="$db?sslmode=no-verify"; fi
  fi
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    echo "  vérification de la connexion (1re fois : téléchargement du client PostgreSQL)…"
    printf 'PGURL=%s\n' "${db/sslmode=no-verify/sslmode=require}" > "$TMP/pg.env"
    if docker run --rm --network host --env-file "$TMP/pg.env" postgres:17-alpine \
        sh -c 'psql "$PGURL" -Atc "select 1"' >/dev/null 2>"$TMP/pg.err"; then
      echo "  ✓ connexion à la base réussie"
    else
      echo "  ✗ connexion impossible : $(tail -1 "$TMP/pg.err")"
      rm -f "$TMP/pg.env"
      continue
    fi
    rm -f "$TMP/pg.env"
  else
    echo "  (Docker pas encore installé : la connexion sera vérifiée pendant l'installation)"
  fi
  put DATABASE_URL "$db"
  break
done

# ------------------------------------------------------------------ Facultatif
echo
ask EXPO_ACCESS_TOKEN "Jeton Expo pour les notifications push (facultatif, Entrée pour passer)" secret
put EXPO_ACCESS_TOKEN "$answer"

# Poivre des clés API : généré une seule fois, ne jamais le changer ensuite
[ -n "$(get API_KEY_PEPPER)" ] || put API_KEY_PEPPER "$(openssl rand -hex 32)"

echo
echo "✓ Configuration enregistrée dans $ENV_FILE (lisible par root uniquement)."
echo "  Domaine : $(get DOMAIN) · Supabase : $(get NEXT_PUBLIC_SUPABASE_URL)"
echo "  Suite : sudo bash deploy/install.sh"
