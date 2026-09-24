#!/usr/bin/env bash
# Base locale Rydar Drive sur PostgreSQL + PostGIS (sans Docker).
#   bash scripts/db-local.sh            → crée la base si absente et applique les migrations
#   bash scripts/db-local.sh --reset    → recrée la base
#   bash scripts/db-local.sh --seed     → charge aussi supabase/seed.sql
# Variables : DB_NAME (rydar), PGHOST (127.0.0.1), PGUSER (postgres), PGPASSWORD (postgres)
set -euo pipefail
cd "$(dirname "$0")/.."
DB_NAME="${DB_NAME:-rydar}"
export PGHOST="${PGHOST:-127.0.0.1}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
RESET=0; SEED=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --seed) SEED=1 ;;
  esac
done
if [[ $RESET == 1 ]]; then
  psql -qc "drop database if exists \"$DB_NAME\" with (force);"
fi
if ! psql -tAc "select 1 from pg_database where datname = '$DB_NAME'" | grep -q 1; then
  psql -qc "create database \"$DB_NAME\";"
  RESET=1
fi
if [[ $RESET == 1 ]]; then
  # Si le schéma auth existe déjà (GoTrue), les stubs n'écrasent rien.
  psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f scripts/sql/local-supabase-stubs.sql >/dev/null 2>&1
  for f in supabase/migrations/*.sql; do
    echo "→ $(basename "$f")"
    psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  done
fi
if [[ $SEED == 1 ]]; then
  echo "→ seed.sql"
  psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql
fi
echo "✓ base $DB_NAME prête"
