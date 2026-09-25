#!/usr/bin/env bash
# Itinéraires auto-hébergés (OSRM, sans coût par requête) : télécharge et prépare une région
# OpenStreetMap dans deploy/osrm/. Île-de-France par défaut (quelques minutes, ~2 Go de RAM) ;
# la France entière demande 16 Go de RAM ou plus pendant la préparation.
#   bash deploy/osrm-prepare.sh                          # Île-de-France
#   REGION=europe/france/provence-alpes-cote-d-azur bash deploy/osrm-prepare.sh
# Puis dans deploy/.env : OSRM_URL=http://osrm:5000, et : cd deploy && docker compose --profile osrm up -d
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${REGION:-europe/france/ile-de-france}"
DATA="$ROOT/deploy/osrm"
IMAGE="ghcr.io/project-osrm/osrm-backend:latest"
mkdir -p "$DATA"
cd "$DATA"

echo "→ téléchargement de $REGION"
curl -fL --progress-bar -o region.osm.pbf "https://download.geofabrik.de/$REGION-latest.osm.pbf"

echo "→ préparation (profil voiture)"
docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-partition /data/region.osrm
docker run --rm -t -v "$DATA:/data" "$IMAGE" osrm-customize /data/region.osrm
rm -f region.osm.pbf

echo "✓ Itinéraires prêts. Dans deploy/.env : OSRM_URL=http://osrm:5000"
echo "  puis : cd $ROOT/deploy && docker compose --profile osrm up -d && docker compose up -d web worker"
