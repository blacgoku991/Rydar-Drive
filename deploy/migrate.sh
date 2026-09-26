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
ENV_FILE="$ROOT/deploy/.env"
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE introuvable (lancez d'abord deploy/install.sh)"; exit 1; }
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || { echo "✗ DATABASE_URL manquant dans $ENV_FILE"; exit 1; }
# libpq ne connaît pas « no-verify » (option du pilote Node) : chiffrement sans vérification = require
PGURL="${DATABASE_URL/sslmode=no-verify/sslmode=require}"

# psql 17 : compatible avec les bases Supabase en Postgres 15 et 17
psql() {
  docker run --rm -i --network host -e PGURL="$PGURL" \
    -v "$ROOT/supabase/migrations:/migrations:ro" postgres:17-alpine \
    sh -c 'psql "$PGURL" -X -v ON_ERROR_STOP=1 -q "$@"' psql "$@"
}

if ! psql -tAc "select 1" >/dev/null; then
  echo "✗ connexion à la base impossible : vérifiez DATABASE_URL dans $ENV_FILE"
  echo "  (Supabase → Connect → Session pooler, port 5432, mot de passe de la base, terminée par ?sslmode=no-verify)"
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
