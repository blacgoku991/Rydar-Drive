#!/usr/bin/env bash
# Stack Supabase locale SANS Docker : PostgreSQL+PostGIS, GoTrue (auth), PostgREST.
# Usage : bash scripts/local-stack/setup.sh   (recrée la base "rydar" + seed)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${LOCAL_STACK_BIN:-$ROOT/.local-stack}"
DB="${DB_NAME:-rydar}"
export PGHOST="${PGHOST:-127.0.0.1}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
AUTH_VERSION="${AUTH_VERSION:-2.180.0}"
POSTGREST_VERSION="${POSTGREST_VERSION:-12.2.12}"

mkdir -p "$BIN"
if [[ ! -x "$BIN/auth" ]]; then
  echo "→ téléchargement Supabase Auth v$AUTH_VERSION"
  curl -sSL "https://github.com/supabase/auth/releases/download/v$AUTH_VERSION/auth-v$AUTH_VERSION-x86.tar.gz" | tar -xz -C "$BIN"
fi
if [[ ! -x "$BIN/postgrest" ]]; then
  echo "→ téléchargement PostgREST v$POSTGREST_VERSION"
  curl -sSL "https://github.com/PostgREST/postgrest/releases/download/v$POSTGREST_VERSION/postgrest-v$POSTGREST_VERSION-linux-static-x86-64.tar.xz" | tar -xJ -C "$BIN"
fi

psql -qc "drop database if exists \"$DB\" with (force);" -c "create database \"$DB\";"
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login noinherit createrole password 'auth-local-password';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
create schema if not exists auth authorization supabase_auth_admin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter role supabase_auth_admin set search_path = auth;
SQL
psql -d "$DB" -qc "grant create on database \"$DB\" to supabase_auth_admin;" 2>/dev/null || true

echo "→ migrations GoTrue"
(cd "$BIN" && GOTRUE_DB_DRIVER=postgres GOTRUE_DB_MIGRATIONS_PATH="$BIN/migrations" \
  DATABASE_URL="postgres://supabase_auth_admin:auth-local-password@$PGHOST:5432/$DB?search_path=auth" \
  GOTRUE_JWT_SECRET=x API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 GOTRUE_SITE_URL=http://localhost:3000 \
  ./auth migrate >/dev/null 2>&1)

echo "→ stubs + migrations Rydar + seed"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/scripts/sql/local-supabase-stubs.sql" >/dev/null 2>&1
for f in "$ROOT"/supabase/migrations/*.sql; do psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null; done
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/seed.sql"
echo "✓ base $DB prête — lancez : bash scripts/local-stack/start.sh"
