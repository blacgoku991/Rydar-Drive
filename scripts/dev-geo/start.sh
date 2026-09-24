#!/usr/bin/env bash
# Démarre (ou redémarre) le routeur OSRM-like et le géocodeur BAN-like de dev, détachés.
#
#   bash scripts/dev-geo/start.sh          # démarre / redémarre
#   bash scripts/dev-geo/start.sh stop     # arrête
#
# Ports : ROUTER_PORT (5001), GEOCODER_PORT (5002). Journaux : .dev-geo/{router,geocoder}.log
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV="$ROOT/.dev-geo"
ROUTER_PORT="${ROUTER_PORT:-5001}"
GEOCODER_PORT="${GEOCODER_PORT:-5002}"

# PID du processus qui écoute sur un port (lsof, sinon fuser)
pid_on() {
  if command -v lsof >/dev/null; then lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null; then fuser "$1/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

stop_port() {
  local pids
  pids="$(pid_on "$1")"
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 30); do [ -z "$(pid_on "$1")" ] && break; sleep 0.2; done
  fi
}

wait_health() {
  local url="$1" name="$2"
  for _ in $(seq 1 100); do
    if curl -sf "$url" >/dev/null 2>&1; then echo "  ✓ $name prêt : ${url%/health}"; return 0; fi
    sleep 0.3
  done
  echo "  ✗ $name ne répond pas ($url) — voir $DEV/$name.log" >&2
  return 1
}

stop_port "$ROUTER_PORT"
stop_port "$GEOCODER_PORT"
[ "${1:-}" = "stop" ] && { echo "arrêtés"; exit 0; }

for f in "$DEV/graph.bin" "$DEV/geocoder/docs.json"; do
  [ -f "$f" ] || { echo "Fichier manquant : $f — lancer d'abord : bash scripts/dev-geo/build.sh" >&2; exit 1; }
done

cd "$ROOT"
PORT="$ROUTER_PORT" setsid nohup node scripts/dev-geo/router.mjs > "$DEV/router.log" 2>&1 < /dev/null &
PORT="$GEOCODER_PORT" setsid nohup node scripts/dev-geo/geocoder.mjs > "$DEV/geocoder.log" 2>&1 < /dev/null &

wait_health "http://localhost:$ROUTER_PORT/health" router
wait_health "http://localhost:$GEOCODER_PORT/health" geocoder

cat <<EOF

Stack géo de dev prête :
  Tuiles (servies par Next) : http://localhost:3000/dev-map/tiles.json  (style de test : /dev-map/style-test.json)
  Routeur OSRM v5           : http://localhost:$ROUTER_PORT/route/v1/driving/2.3743,48.8443;2.571,49.0047?overview=full&geometries=geojson
  Géocodeur BAN             : http://localhost:$GEOCODER_PORT/search/?q=gare%20de%20lyon&limit=5&autocomplete=1
EOF
