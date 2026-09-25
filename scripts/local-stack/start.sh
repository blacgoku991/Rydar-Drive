#!/usr/bin/env bash
# Démarre GoTrue (54332), PostgREST (54331) et la passerelle (54321, avec le relais Realtime) en arrière-plan.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${LOCAL_STACK_BIN:-$ROOT/.local-stack}"
DB="${DB_NAME:-rydar}"
PGHOST="${PGHOST:-127.0.0.1}"
LOGS="$BIN/logs"; mkdir -p "$LOGS"
SECRET="$(node -e "import('$ROOT/scripts/local-stack/keys.mjs').then(m=>console.log(m.JWT_SECRET))")"

pkill -f "$BIN/auth serve" 2>/dev/null || true
pkill -f "$BIN/postgrest" 2>/dev/null || true
pkill -f "local-stack/gateway.mjs" 2>/dev/null || true

(cd "$BIN" && GOTRUE_DB_DRIVER=postgres GOTRUE_DB_MIGRATIONS_PATH="$BIN/migrations" \
  DATABASE_URL="postgres://supabase_auth_admin:auth-local-password@$PGHOST:5432/$DB?search_path=auth" \
  GOTRUE_API_HOST=127.0.0.1 PORT=54332 API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 \
  GOTRUE_SITE_URL=http://localhost:3000 GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**" \
  GOTRUE_JWT_SECRET="$SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated \
  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role \
  GOTRUE_DISABLE_SIGNUP=true GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true \
  GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_LOG_LEVEL=warn \
  setsid nohup "$BIN/auth" serve </dev/null >"$LOGS/auth.log" 2>&1 &)

cat >"$BIN/postgrest.conf" <<CONF
db-uri = "postgres://authenticator:authenticator@$PGHOST:5432/$DB"
db-schemas = "public"
db-anon-role = "anon"
db-extra-search-path = "public, extensions"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = 54331
db-pool = 20
CONF
setsid nohup "$BIN/postgrest" "$BIN/postgrest.conf" </dev/null >"$LOGS/postgrest.log" 2>&1 &
DB_NAME="$DB" setsid nohup node "$ROOT/scripts/local-stack/gateway.mjs" </dev/null >"$LOGS/gateway.log" 2>&1 &
sleep 2
echo "✓ stack locale : http://127.0.0.1:54321  (logs : $LOGS)"
node "$ROOT/scripts/local-stack/keys.mjs"
