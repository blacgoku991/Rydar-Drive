#!/usr/bin/env bash
# Construit la stack géo de dev (tuiles + graphe routier + index géocodeur) depuis Overture Maps.
# Idempotent : les extraits Overture sont mis en cache dans .dev-geo/cache (re-téléchargement
# uniquement si un fichier du cache est supprimé). Usage :
#
#   bash scripts/dev-geo/build.sh            # tout
#   bash scripts/dev-geo/build.sh tiles      # une ou plusieurs étapes : deps extract tiles graph geocoder fonts
#
# Pré-requis : python3 (≥ 3.10) + node 22, accès HTTPS à overturemaps-us-west-2.s3.amazonaws.com,
# registry.npmjs.org, pypi.org et raw.githubusercontent.com (glyphes).
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV="$ROOT/.dev-geo"
HERE="$ROOT/scripts/dev-geo"
PUB="$ROOT/apps/web/public/dev-map"
PY="$DEV/venv/bin/python"
STEPS="${*:-deps extract tiles graph geocoder fonts}"

# Proxy d'entreprise / bac à sable : CA supplémentaire si présent (jamais de désactivation TLS)
if [ -f /root/.ccr/ca-bundle.crt ]; then
  export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-/root/.ccr/ca-bundle.crt}"
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/root/.ccr/ca-bundle.crt}"
  export CURL_CA_BUNDLE="${CURL_CA_BUNDLE:-/root/.ccr/ca-bundle.crt}"
fi

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
has() { [[ " $STEPS " == *" $1 "* ]]; }

mkdir -p "$DEV" "$PUB"

if has deps; then
  log "Dépendances (venv Python + modules Node locaux dans .dev-geo)"
  [ -x "$PY" ] || python3 -m venv "$DEV/venv"
  "$PY" -c "import pyarrow, shapely, requests, numpy, scipy" 2>/dev/null ||
    "$DEV/venv/bin/pip" install -q pyarrow shapely requests numpy scipy
  mkdir -p "$DEV/node"
  [ -f "$DEV/node/package.json" ] || echo '{"name":"rydar-dev-geo-deps","private":true}' > "$DEV/node/package.json"
  [ -d "$DEV/node/node_modules/geojson-vt" ] && [ -d "$DEV/node/node_modules/vt-pbf" ] ||
    npm install --prefix "$DEV/node" --no-audit --no-fund geojson-vt@3 vt-pbf @mapbox/vector-tile pbf@3 >/dev/null
fi

if has extract; then
  log "Extraction Overture (Paris & Nice) → .dev-geo/cache/overture"
  "$PY" "$HERE/extract.py"
fi

if has tiles; then
  log "Couches OpenMapTiles → .dev-geo/layers"
  "$PY" "$HERE/prepare_tiles.py"
  log "Tuiles MVT → apps/web/public/dev-map/tiles"
  node --max-old-space-size=12000 "$HERE/tiles.mjs"
  cp "$HERE/style-test.json" "$PUB/style-test.json"
fi

if has graph; then
  log "Graphe routier → .dev-geo/graph.{bin,json}"
  "$PY" "$HERE/build_graph.py"
fi

if has geocoder; then
  log "Index géocodeur → .dev-geo/geocoder"
  "$PY" "$HERE/build_geocoder.py"
fi

if has fonts; then
  log "Glyphes Noto Sans (protomaps/basemaps-assets) → apps/web/public/dev-map/fonts"
  BASE="https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts"
  for font in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
    mkdir -p "$PUB/fonts/$font"
    for start in $(seq 0 256 65280); do
      range="$start-$((start + 255))"
      out="$PUB/fonts/$font/$range.pbf"
      [ -s "$out" ] && continue
      echo "$BASE/${font// /%20}/$range.pbf|$out"
    done
  done | xargs -P 16 -I{} bash -c 'u="${1%%|*}"; o="${1##*|}"; curl -sfS -o "$o" "$u" 2>/dev/null || rm -f "$o"' _ {}
  echo "glyphes : $(find "$PUB/fonts" -name '*.pbf' | wc -l) fichiers"
fi

log "Terminé"
du -sh "$DEV/cache" "$DEV/layers" "$DEV/graph.bin" "$DEV/geocoder" "$PUB/tiles" "$PUB/fonts" 2>/dev/null || true
