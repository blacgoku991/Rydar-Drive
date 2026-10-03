#!/usr/bin/env bash
# Applique supabase/migrations/*.sql sur la base Supabase, dans l'ordre, une seule fois chacune.
# Chaque fichier est appliqué ET enregistré dans une même transaction : en cas d'erreur, rien n'est
# appliqué pour ce fichier (on corrige, on relance). Même registre que la CLI Supabase
# (supabase_migrations.schema_migrations) : « supabase db push » reste utilisable ensuite.
# Client psql lancé dans un conteneur : rien à installer sur le VPS.
#   bash deploy/migrate.sh
# Ne charge JAMAIS supabase/seed.sql (comptes de démonstration).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Une migration = un numéro (registre par numéro) : de deux fichiers de même numéro, le second serait sauté sans erreur
DUPLICATES="$(for f in "$ROOT"/supabase/migrations/*.sql; do b="$(basename "$f" .sql)"; echo "${b%%_*}"; done | sort | uniq -d)"
if [ -n "$DUPLICATES" ]; then
  echo "✗ numéro de migration en double : $(echo "$DUPLICATES" | tr '\n' ' ')— rien n'a été appliqué."
  echo "  Une des deux migrations doit être renumérotée dans le dépôt (jamais sur le serveur), puis relancez."
  exit 1
fi
ENV_FILE="$ROOT/deploy/.env"
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE introuvable (lancez d'abord deploy/install.sh)"; exit 1; }
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || { echo "✗ DATABASE_URL manquant dans $ENV_FILE"; exit 1; }
# Certificat du serveur vérifié (verify-full, racine deploy/supabase-ca.crt) sauf repli DATABASE_SSLMODE=no-verify
SSLMODE="$(grep -E '^DATABASE_SSLMODE=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
SSLMODE="${SSLMODE//[[:space:]\"\']/}"
SSLMODE="${SSLMODE:-verify-full}"
# shellcheck source=pg-url.sh
. "$ROOT/deploy/pg-url.sh"
pg_prepare "$DATABASE_URL" "$SSLMODE" || exit 1
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# psql 17 : compatible avec les bases Supabase en Postgres 15 et 17. Mot de passe par l'environnement (PGPASSWORD),
# jamais dans une ligne de commande.
psql() {
  docker run --rm -i --network host -e PGURL -e PGPASSWORD "${PG_MOUNT[@]}" \
    -v "$ROOT/supabase/migrations:/migrations:ro" postgres:17-alpine \
    sh -c 'psql "$PGURL" -X -v ON_ERROR_STOP=1 -q "$@"' psql "$@"
}

if ! psql -tAc "select 1" >/dev/null 2>"$TMP/err"; then
  cat "$TMP/err"
  if [ "$SSLMODE" = verify-full ] && pg_tls_error "$TMP/err"; then
    echo "✗ certificat du serveur de la base NON vérifié avec deploy/supabase-ca.crt (racine Supabase 2021)."
    echo "  Rien n'a été modifié : ni la base, ni les services déjà en place."
    echo "  Contrôle : docs/DEPLOYMENT.md, « Connexion chiffrée à la base ». Repli (ancien mode, chiffré SANS"
    echo "  vérification du certificat) : une seule ligne DATABASE_SSLMODE=no-verify dans $ENV_FILE"
    echo "  (ou sudo bash deploy/configure.sh), puis relancez : sudo bash deploy/install.sh"
  else
    echo "✗ connexion à la base impossible : vérifiez DATABASE_URL dans $ENV_FILE"
    echo "  (Supabase → Connect → Session pooler, port 5432, mot de passe de la base)"
  fi
  exit 1
fi

psql -c "set client_min_messages = warning;
         create schema if not exists supabase_migrations;
         create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
done_versions="$(psql -tAc "select version from supabase_migrations.schema_migrations")"

applied=0
for file in "$ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$file" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  if grep -qx "$version" <<<"$done_versions"; then
    continue
  fi
  echo "→ $base"
  if ! psql -1 -o /dev/null -c "set local client_min_messages = warning" -f "/migrations/$base.sql" \
      -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')"; then
    echo "✗ migration $base en échec : annulée entièrement, la base n'a pas été modifiée par ce fichier."
    echo "  Corrigez la cause ci-dessus, puis relancez : sudo bash deploy/install.sh"
    exit 1
  fi
  applied=$((applied + 1))
done
echo "✓ base à jour ($applied migration(s) appliquée(s))"
