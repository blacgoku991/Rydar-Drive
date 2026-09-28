#!/usr/bin/env bash
# Crée le compte Super Admin (ou donne ce rôle à un compte existant), dans un terminal, en root :
#   sudo bash deploy/create-admin.sh
# Le mot de passe se tape ici, sans affichage. Passe par l'API Supabase avec la clé secrète de deploy/.env.
# Compte DÉJÀ existant (il a pu être créé par un tiers avec cette adresse, par ex. via un lien d'inscription chauffeur) :
# après confirmation, le mot de passe saisi ici le remplace et TOUTES ses sessions sont fermées AVANT de donner le rôle ;
# un jeton d'accès émis avant la promotion n'en a pas les droits (users.super_admin_since). Seule voie pour donner ce
# rôle : jamais « update public.users set is_super_admin = true » à la main.
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
EXISTING=""
case "$code" in
  200 | 201) echo "  ✓ compte créé" ;;
  422)
    if grep -q -i -E "already|exists" "$TMP/out"; then
      EXISTING=1
    else
      echo "✗ refusé par Supabase : $(cat "$TMP/out")"; exit 1
    fi
    ;;
  401 | 403) echo "✗ clé secrète refusée : relancez sudo bash deploy/configure.sh"; exit 1 ;;
  000) echo "✗ Supabase injoignable ($URL)"; exit 1 ;;
  *) echo "✗ erreur $code : $(cat "$TMP/out")"; exit 1 ;;
esac

if [ -n "$EXISTING" ]; then
  # Compte existant : on en reprend le contrôle (mot de passe saisi ici + toutes les sessions fermées) AVANT le rôle,
  # sinon celui qui l'aurait créé avec cette adresse deviendrait Super Admin avec SON mot de passe.
  echo "  Un compte existe déjà avec $EMAIL."
  read -r -p "  Remplacer son mot de passe par celui saisi et fermer toutes ses sessions ? (oui/non) : " CONFIRM
  [ "$CONFIRM" = "oui" ] || { echo "✗ abandon : aucun changement"; exit 1; }
  code="$(api GET "/rest/v1/users?select=id&email=eq.$(urlencode "$EMAIL")")"
  USER_ID="$(grep -o -E '"id" *: *"[0-9a-f-]{36}"' "$TMP/out" | head -1 | grep -o -E '[0-9a-f-]{36}' || true)"
  if [ "$code" != 200 ] || ! [[ "$USER_ID" =~ ^[0-9a-f-]{36}$ ]]; then
    echo "✗ compte introuvable dans public.users (réponse $code) : les migrations sont-elles appliquées ? sudo bash deploy/install.sh"
    exit 1
  fi

  echo "→ nouveau mot de passe"
  printf '{"password":%s,"email_confirm":true}' "$(json_str "$PASS")" > "$TMP/pw.json"
  code="$(api PUT "/auth/v1/admin/users/$USER_ID" "$TMP/pw.json")"
  rm -f "$TMP/pw.json"
  [ "$code" = 200 ] || { echo "✗ mot de passe non modifié (réponse $code) : $(cat "$TMP/out")"; exit 1; }
  echo "  ✓ mot de passe remplacé"

  echo "→ fermeture de toutes ses sessions"
  DATABASE_URL="$(value DATABASE_URL)"
  [ -n "$DATABASE_URL" ] || { echo "✗ DATABASE_URL manquant dans $ENV_FILE : rôle non attribué (sudo bash deploy/configure.sh)"; exit 1; }
  # Connexion comme deploy/migrate.sh (deploy/pg-url.sh) : certificat du serveur vérifié (DATABASE_SSLMODE, verify-full
  # par défaut) ; mot de passe de la base par l'environnement (PGPASSWORD), jamais dans la ligne de commande de docker
  # (visible par « ps »)
  SSLMODE="$(value DATABASE_SSLMODE)"
  SSLMODE="${SSLMODE//[[:space:]\"\']/}"
  SSLMODE="${SSLMODE:-verify-full}"
  # shellcheck source=pg-url.sh
  . "$ROOT/deploy/pg-url.sh"
  pg_prepare "$DATABASE_URL" "$SSLMODE" || { echo "✗ rôle non attribué"; exit 1; }
  # Client psql dans un conteneur (comme deploy/migrate.sh) ; identifiant vérifié ci-dessus (UUID)
  if ! LEFT="$(docker run --rm -i --network host -e PGURL -e PGPASSWORD "${PG_MOUNT[@]}" postgres:17-alpine \
      sh -c 'psql "$PGURL" -X -v ON_ERROR_STOP=1 -qtA' 2>"$TMP/pg.err" <<SQL
begin;
delete from auth.refresh_tokens where user_id::text = '$USER_ID';
delete from auth.sessions where user_id::text = '$USER_ID';
commit;
select count(*) from auth.sessions where user_id::text = '$USER_ID';
SQL
  )" || [ "$(printf '%s' "$LEFT" | tr -d '[:space:]')" != 0 ]; then
    if [ "$SSLMODE" = verify-full ] && pg_tls_error "$TMP/pg.err"; then
      echo "✗ certificat du serveur de la base NON vérifié avec deploy/supabase-ca.crt : sessions non fermées, rôle non attribué."
      echo "  Contrôle : docs/DEPLOYMENT.md, « Connexion chiffrée à la base » (repli : DATABASE_SSLMODE=no-verify, sudo bash deploy/configure.sh)."
    else
      echo "✗ sessions non fermées : rôle non attribué (vérifiez DATABASE_URL et Docker)"
      [ ! -s "$TMP/pg.err" ] || tail -3 "$TMP/pg.err"
    fi
    exit 1
  fi
  unset PGPASSWORD PGURL
  echo "  ✓ sessions fermées"
fi

# super_admin_since : seuls les jetons émis APRÈS la promotion ont les droits Super Admin (private.is_super_admin) —
# jamais un jeton d'accès encore valable d'un tiers qui aurait créé le compte avec cette adresse. « now » = heure de la
# base au moment de la mise à jour.
echo "→ rôle Super Admin"
printf '{"is_super_admin":true,"super_admin_since":"now"}' > "$TMP/flag.json"
code="$(api PATCH "/rest/v1/users?email=eq.$(urlencode "$EMAIL")" "$TMP/flag.json" "Prefer: return=representation")"
if [ "$code" != 200 ] || ! grep -q '"is_super_admin" *: *true' "$TMP/out" || ! grep -q '"super_admin_since" *: *"' "$TMP/out"; then
  echo "✗ rôle non attribué (réponse $code) : $(cat "$TMP/out")"
  echo "  Les migrations sont-elles appliquées ? sudo bash deploy/install.sh"
  exit 1
fi
echo "✓ Super Admin prêt : connectez-vous sur https://$DOMAIN/login avec $EMAIL"
