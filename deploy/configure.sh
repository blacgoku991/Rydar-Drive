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
# shellcheck source=pg-url.sh
. "$ROOT/deploy/pg-url.sh"

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

# Connexion de test à la base (psql en conteneur) : URL sans mot de passe et PGPASSWORD dans un fichier --env-file,
# jamais dans une ligne de commande ; erreur dans $TMP/pg.err
db_check() {
  local rc=0
  pg_prepare "$1" "$2" 2>"$TMP/pg.err" || return 1
  { printf 'PGURL=%s\n' "$PGURL"; [ -z "${PGPASSWORD:-}" ] || printf 'PGPASSWORD=%s\n' "$PGPASSWORD"; } > "$TMP/pg.env"
  unset PGPASSWORD
  docker run --rm --network host --env-file "$TMP/pg.env" "${PG_MOUNT[@]}" postgres:17-alpine \
    sh -c 'psql "$PGURL" -Atc "select 1"' >/dev/null 2>"$TMP/pg.err" || rc=1
  rm -f "$TMP/pg.env"
  return "$rc"
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
    [[ "$url" =~ ^https://.*\.supabase\.co$ ]] \
      || echo "  ⚠ adresse hors supabase.co : normal pour un Supabase auto-hébergé, sinon attendu https://xxxx.supabase.co"
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
echo "  (Supabase auto-hébergé sur ce serveur : postgresql://postgres:MOT_DE_PASSE@127.0.0.1:5432/postgres)"
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
    elif [[ "$db" =~ ^(postgres(ql)?://[^:/@]+)@(.*)$ ]]; then
      # Substitution interne au shell : le mot de passe n'apparaît dans aucune ligne de commande
      db="${BASH_REMATCH[1]}:$enc@${BASH_REMATCH[3]}"
    fi
  fi
  if [[ "$db" == *:6543/* ]]; then
    db="${db/:6543\//:5432/}"
    echo "  → port 6543 (mode transaction) remplacé par 5432 (mode session, nécessaire au worker)"
  fi
  # Chaîne toujours chiffrée ; le mode réel du worker et des migrations est DATABASE_SSLMODE (qui remplace ce sslmode)
  if [[ "$db" != *sslmode=* ]]; then
    if [[ "$db" == *\?* ]]; then db="$db&sslmode=no-verify"; else db="$db?sslmode=no-verify"; fi
  fi
  if command -v docker >/dev/null && docker info >/dev/null 2>&1 && pg_local_host "$db"; then
    # Supabase auto-hébergé (base sur ce serveur ou sur un réseau privé) : connexion locale, sans chiffrement.
    # Jamais pour une base distante (pg_local_host, même règle que le worker)
    mode=disable
    echo "  vérification de la connexion (1re fois : téléchargement du client PostgreSQL)…"
    if ! db_check "$db" "$mode"; then
      echo "  ✗ connexion impossible : $(tail -1 "$TMP/pg.err")"
      continue
    fi
    echo "  ✓ connexion à la base locale réussie (non chiffrée, sur ce serveur : DATABASE_SSLMODE=disable)"
    put DATABASE_SSLMODE "$mode"
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    # Chiffrement : certificat du serveur vérifié (verify-full, racine deploy/supabase-ca.crt) sauf repli no-verify
    mode="$(get DATABASE_SSLMODE)"
    case "${mode:-verify-full}" in
      verify-full | no-verify) mode="${mode:-verify-full}" ;;
      # Réglage d'une ancienne base locale : une base distante est toujours chiffrée
      disable) mode=verify-full ;;
      *) echo "  ⚠ DATABASE_SSLMODE « $mode » inconnu : verify-full"; mode=verify-full ;;
    esac
    echo "  vérification de la connexion (1re fois : téléchargement du client PostgreSQL)…"
    if db_check "$db" "$mode"; then
      if [ "$mode" = verify-full ]; then echo "  ✓ connexion à la base réussie (certificat du serveur vérifié)"
      else echo "  ✓ connexion à la base réussie (certificat du serveur NON vérifié : DATABASE_SSLMODE=$mode)"; fi
    elif [ "$mode" = verify-full ] && pg_tls_error "$TMP/pg.err"; then
      echo "  ✗ certificat du serveur non vérifié avec deploy/supabase-ca.crt : $(tail -1 "$TMP/pg.err")"
      echo "    Contrôle : docs/DEPLOYMENT.md, « Connexion chiffrée à la base ». Repli possible : connexion chiffrée"
      echo "    SANS vérification du certificat (ancien mode), exposée à une interception sur le réseau."
      read -r -p "  Utiliser ce repli (DATABASE_SSLMODE=no-verify) ? [o/N] " yn
      case "$yn" in [oO]*) ;; *) continue ;; esac
      mode=no-verify
      if ! db_check "$db" "$mode"; then
        echo "  ✗ connexion impossible : $(tail -1 "$TMP/pg.err")"
        continue
      fi
      echo "  ✓ connexion à la base réussie (certificat du serveur NON vérifié : DATABASE_SSLMODE=no-verify)"
    else
      echo "  ✗ connexion impossible : $(tail -1 "$TMP/pg.err")"
      continue
    fi
    put DATABASE_SSLMODE "$mode"
  else
    echo "  (Docker pas encore installé : la connexion sera vérifiée pendant l'installation)"
    # Base locale (Supabase auto-hébergé) : sans chiffrement ; base distante : réglage actuel (verify-full par défaut)
    if pg_local_host "$db"; then put DATABASE_SSLMODE disable
    elif [ "$(get DATABASE_SSLMODE)" = disable ]; then put DATABASE_SSLMODE verify-full; fi
  fi
  put DATABASE_URL "$db"
  break
done

# ------------------------------------------------------------------ Facultatif
echo
ask EXPO_ACCESS_TOKEN "Jeton Expo pour les notifications push (recommandé en production, Entrée pour passer)" secret
put EXPO_ACCESS_TOKEN "$answer"

echo
echo "Éditeur de l'application — pages légales (mentions légales, CGU, CGV, confidentialité, cookies, accord de"
echo "traitement, suppression de compte ; exigées par l'App Store et Google Play)."
echo "  L'identité légale complète (raison sociale, forme, capital, RCS, TVA, directeur de la publication, contacts,"
echo "  hébergeurs) se saisit après l'installation, par le Super Admin, dans /admin/legal : elle a priorité."
echo "  Les trois valeurs ci-dessous ne servent que de repli tant que /admin/legal n'est pas rempli."
ask LEGAL_NAME "Société éditrice (ex. Rydar SAS)"
put LEGAL_NAME "$answer"
while :; do
  ask LEGAL_EMAIL "E-mail de contact (support, données personnelles, signalement de contenus, suppression de compte)"
  if [ -z "$answer" ] || printf '%s' "$answer" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then break; fi
  echo "  ✗ Adresse e-mail invalide (forme attendue : nom@domaine.fr)"
done
put LEGAL_EMAIL "$answer"
ask LEGAL_ADDRESS "Adresse du siège (facultatif)"
put LEGAL_ADDRESS "$answer"
if [ -z "$(get LEGAL_NAME)" ] || [ -z "$(get LEGAL_EMAIL)" ]; then
  echo "  ⚠ Éditeur ou e-mail vide : remplissez /admin/legal avant l'ouverture au public et l'envoi aux stores."
fi

echo
echo "Formulaire de contact du site (facultatif, Entrée pour passer) : chaque demande arrive dans /admin/contacts et"
echo "par e-mail, envoyé par le serveur mail de ce VPS (127.0.0.1:25). Détails : docs/DEPLOYMENT.md,"
echo "« E-mails : formulaire de contact »."
# Adresse simple, mêmes règles que la file d'e-mails (public.email_outbox) et le mailer : ni espace, ni séparateur ou
# syntaxe d'en-tête (, ; : < > ( ) [ ] " \). Sinon chaque demande de contact serait refusée à l'enregistrement.
mail_re='[^][@<>(),;:"\[:space:]]+@[^][@<>(),;:"\[:space:]]+\.[^][@<>(),;:"\[:space:]]+'
while :; do
  ask CONTACT_NOTIFY_EMAIL "E-mail qui reçoit les demandes de contact (vide = e-mail des mentions légales)"
  if [ -z "$answer" ] || printf '%s' "$answer" | grep -Eq "^${mail_re}\$"; then break; fi
  echo "  ✗ Adresse e-mail invalide (forme attendue : nom@domaine.fr)"
done
put CONTACT_NOTIFY_EMAIL "$answer"
while :; do
  ask MAIL_FROM "Adresse d'expédition des e-mails (vide = noreply@$(get DOMAIN))"
  if [ -z "$answer" ] \
    || printf '%s' "$answer" | grep -Eq "^${mail_re}\$" \
    || printf '%s' "$answer" | grep -Eq "^[^@<>\"\\[:cntrl:]]+ <${mail_re}>\$"; then
    break
  fi
  echo "  ✗ Adresse invalide (forme attendue : noreply@domaine.fr, ou « Rydar Drive <noreply@domaine.fr> »)"
done
put MAIL_FROM "$answer"

# Serveur mail local (SMTP_HOST vide ou boucle locale) : contrôle non bloquant, les e-mails attendent en file sinon
smtp_host="$(get SMTP_HOST)"
smtp_port="$(get SMTP_PORT)"
smtp_port="${smtp_port:-25}"
case "${smtp_host:-127.0.0.1}" in
  127.0.0.1 | localhost | ::1)
    if ! command -v ss >/dev/null; then
      echo "  (ss introuvable : écoute du serveur mail sur le port $smtp_port non vérifiée)"
    elif ss -ltnH 2>/dev/null | awk '{print $4}' \
      | grep -Eq "^(127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]|\[::ffff:127\.0\.0\.1\]):$smtp_port\$"; then
      echo "  ✓ un serveur mail écoute sur 127.0.0.1:$smtp_port"
    else
      echo "  ⚠ aucun serveur mail n'écoute sur 127.0.0.1:$smtp_port : les e-mails du formulaire de contact resteront"
      echo "    en file (les demandes s'affichent quand même dans /admin/contacts). Installez Postfix, en écoute locale"
      echo "    seulement : deploy/CLAUDE-VPS.md, étape 5 « E-mails du formulaire de contact »."
    fi
    ;;
  *) echo "  Relais SMTP externe configuré (SMTP_HOST=$smtp_host, réglage avancé) : pas de contrôle local." ;;
esac

echo
echo "Application chauffeur publiée (facultatif, Entrée pour passer)"
ask IOS_APP_URL "Lien App Store"
put IOS_APP_URL "$answer"
ask APPLE_APP_IDS "Identifiant Apple de l'app pour les liens /rejoindre (TEAMID.app.rydar.driver)"
put APPLE_APP_IDS "$answer"
ask ANDROID_APP_URL "Lien Google Play"
put ANDROID_APP_URL "$answer"
ask ANDROID_CERT_SHA256 "Empreinte SHA-256 du certificat de signature Google Play (liens /rejoindre)"
put ANDROID_CERT_SHA256 "$answer"

# Poivre des clés API : généré une seule fois, ne jamais le changer ensuite
[ -n "$(get API_KEY_PEPPER)" ] || put API_KEY_PEPPER "$(openssl rand -hex 32)"

echo
echo "✓ Configuration enregistrée dans $ENV_FILE (lisible par root uniquement)."
echo "  Domaine : $(get DOMAIN) · Supabase : $(get NEXT_PUBLIC_SUPABASE_URL)"
echo "  Suite : sudo bash deploy/install.sh"
