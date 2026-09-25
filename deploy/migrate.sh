#!/usr/bin/env bash
# Applique supabase/migrations/*.sql sur la base Supabase, dans l'ordre, une seule fois chacune.
# Même registre que la CLI Supabase (supabase_migrations.schema_migrations) : « supabase db push »
# reste utilisable ensuite. Client psql lancé dans un conteneur : rien à installer sur le VPS.
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

psql() {
  docker run --rm -i --network host -e PGURL="$PGURL" \
    -v "$ROOT/supabase/migrations:/migrations:ro" postgres:16-alpine \
    sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -q "$@"' psql "$@"
}

psql -c "create schema if not exists supabase_migrations;
         create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"

applied=0
for file in "$ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$file" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  if [ "$(psql -tAc "select 1 from supabase_migrations.schema_migrations where version = '$version'")" = "1" ]; then
    continue
  fi
  echo "→ $base"
  psql -f "/migrations/$base.sql"
  psql -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')"
  applied=$((applied + 1))
done
echo "✓ base à jour ($applied migration(s) appliquée(s))"
