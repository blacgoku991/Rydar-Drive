#!/usr/bin/env bash
# Crée le compte Super Admin (ou donne ce rôle à un compte existant), dans un terminal, en root :
#   sudo bash deploy/create-admin.sh
# Le mot de passe se tape ici, sans affichage. Passe par l'API Supabase avec la clé secrète de deploy/.env.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
[ "$(id -u)" = 0 ] || { echo "À lancer en root : sudo bash deploy/create-admin.sh"; exit 1; }
[ -t 0 ] || { echo "✗ À lancer dans un terminal, au clavier : sudo bash deploy/create-admin.sh"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "✗ Configurez d'abord : sudo bash deploy/configure.sh"; exit 1; }

value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
URL="$(value NEXT_PUBLIC_SUPABASE_URL)"
URL="${URL%/}"
KEY="$(value SUPABASE_SERVICE_ROLE_KEY)"
DOMAIN="$(value DOMAIN)"
[ -n "$URL" ] && [ -n "$KEY" ] || { echo "✗ Supabase non configuré : sudo bash deploy/configure.sh"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Nouvelle clé (sb_secret_…) : apikey seul, la passerelle Supabase en déduit le rôle ; ancienne clé JWT : aussi en Authorization
{
  printf 'apikey: %s\nContent-Type: application/json\n' "$KEY"
  case "$KEY" in sb_*) ;; *) printf 'Authorization: Bearer %s\n' "$KEY" ;; esac
} > "$TMP/h"

# api MÉTHODE CHEMIN [fichier JSON] [en-tête] → affiche le code HTTP, corps de la réponse dans $TMP/out
api() {
  local args=(-s -o "$TMP/out" -w '%{http_code}' --max-time 15 -X "$1" -H @"$TMP/h")
  [ -z "${3:-}" ] || args+=(--data-binary @"$3")
  [ -z "${4:-}" ] || args+=(-H "$4")
  curl "${args[@]}" "$URL$2" || true
}

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
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

while :; do
  read -r -p "E-mail du Super Admin : " EMAIL
  EMAIL="$(printf '%s' "$EMAIL" | tr 'A-Z' 'a-z' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] && break
  echo "  ✗ e-mail invalide"
done
read -r -p "Prénom et nom : " NAME
while :; do
  read -r -s -p "Mot de passe (12 caractères minimum, ne s'affiche pas) : " PASS
  echo
  [ "${#PASS}" -ge 12 ] || { echo "  ✗ trop court"; continue; }
  read -r -s -p "Confirmez le mot de passe : " PASS2
  echo
  [ "$PASS" = "$PASS2" ] && break
  echo "  ✗ les deux saisies diffèrent"
done

echo "→ compte (Supabase Auth)"
printf '{"email":%s,"password":%s,"email_confirm":true,"user_metadata":{"full_name":%s}}' \
  "$(json_str "$EMAIL")" "$(json_str "$PASS")" "$(json_str "$NAME")" > "$TMP/user.json"
code="$(api POST /auth/v1/admin/users "$TMP/user.json")"
rm -f "$TMP/user.json"
case "$code" in
  200 | 201) echo "  ✓ compte créé" ;;
  422)
    if grep -q -i -E "already|exists" "$TMP/out"; then
      echo "  compte déjà existant : son mot de passe n'est pas modifié"
    else
      echo "✗ refusé par Supabase : $(cat "$TMP/out")"; exit 1
    fi
    ;;
  401 | 403) echo "✗ clé secrète refusée : relancez sudo bash deploy/configure.sh"; exit 1 ;;
  000) echo "✗ Supabase injoignable ($URL)"; exit 1 ;;
  *) echo "✗ erreur $code : $(cat "$TMP/out")"; exit 1 ;;
esac

echo "→ rôle Super Admin"
printf '{"is_super_admin":true}' > "$TMP/flag.json"
code="$(api PATCH "/rest/v1/users?email=eq.$(urlencode "$EMAIL")" "$TMP/flag.json" "Prefer: return=representation")"
if [ "$code" != 200 ] || ! grep -q '"is_super_admin" *: *true' "$TMP/out"; then
  echo "✗ rôle non attribué (réponse $code) : $(cat "$TMP/out")"
  echo "  Les migrations sont-elles appliquées ? sudo bash deploy/install.sh"
  exit 1
fi
echo "✓ Super Admin prêt : connectez-vous sur https://$DOMAIN/login avec $EMAIL"
