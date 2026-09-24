#!/usr/bin/env node
// Génère les tuiles vectorielles MVT (schéma OpenMapTiles) à partir de .dev-geo/layers/*.ndjson.
//
//   node --max-old-space-size=12000 scripts/dev-geo/tiles.mjs
//
// Sortie : apps/web/public/dev-map/tiles/{z}/{x}/{y}.pbf (non compressé, extent 4096)
//          apps/web/public/dev-map/tiles.json (TileJSON 3)
// Dépendances (hors workspace pnpm) : geojson-vt + vt-pbf installés dans .dev-geo/node.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(ROOT, ".dev-geo/node/package.json"));
const geojsonvt = require("geojson-vt");
const vtpbf = require("vt-pbf");

const LAYER_DIR = path.join(ROOT, ".dev-geo/layers");
const OUT_DIR = path.join(ROOT, "apps/web/public/dev-map");
const TILE_DIR = path.join(OUT_DIR, "tiles");
const BASE_URL = process.env.DEV_MAP_BASE_URL ?? "http://localhost:3000/dev-map";
const MINZOOM = 5;
const MAXZOOM = 15;

// Zones (identiques à extract.py) : tuiles z5–15 ; France entière z5–8 (libellés de villes seulement)
const REGIONS = {
  paris: [2.1, 48.68, 2.65, 49.06],
  nice: [7.1, 43.62, 7.4, 43.78],
};
const FRANCE = [-5.5, 41.2, 9.8, 51.2];

// Tranches de zoom : une feature n'est indexée que dans la tranche de son _minzoom,
// pour ne pas simplifier/découper des rues mineures aux petits zooms.
const BANDS = [
  [0, 9],
  [10, 12],
  [13, 13],
  [14, 15],
];

const LAYER_DESCRIPTIONS = {
  water: "Surfaces d'eau (class: ocean, lake, river, pond, swimming_pool)",
  waterway: "Cours d'eau linéaires (class: river, canal, stream, ditch, drain)",
  water_name: "Libellés d'eau (class: sea, bay, lake)",
  landcover: "Couverture du sol (class: wood, grass, farmland, sand, wetland, rock)",
  landuse: "Usage du sol (class: residential, industrial, commercial, cemetery, hospital, school…)",
  park: "Parcs et espaces protégés (polygones + points de libellé)",
  transportation: "Réseau (class: motorway…minor, service, track, path, rail, transit ; brunnel, ramp, oneway)",
  transportation_name: "Noms/numéros de voies (name, ref, class)",
  building: "Bâtiments (z14+, centres de Paris et Nice ; render_height)",
  place: "Libellés de lieux (class: city, town, village, suburb, quarter, neighbourhood, hamlet ; rank)",
  aeroway: "Aéroports (class: aerodrome, runway, taxiway, apron, helipad)",
  aerodrome_label: "Libellés d'aéroports (name, iata, icao)",
  poi: "Points d'intérêt notables (gares, aéroports, monuments…)",
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function tilesFor(bbox, z, margin = 0.005) {
  const out = [];
  const x0 = lon2x(bbox[0] - margin, z), x1 = lon2x(bbox[2] + margin, z);
  const y0 = lat2y(bbox[3] + margin, z), y1 = lat2y(bbox[1] - margin, z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}

async function readLayer(file) {
  const bands = BANDS.map(() => []);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    const mz = f.properties._minzoom ?? 0;
    const b = BANDS.findIndex(([a, c]) => mz >= a && mz <= c);
    bands[b === -1 ? BANDS.length - 1 : b].push(f);
  }
  return bands;
}

function stripTags(tags) {
  const o = {};
  for (const k in tags) if (k[0] !== "_") o[k] = tags[k];
  return o;
}

async function main() {
  const t0 = Date.now();
  const layerFiles = fs
    .readdirSync(LAYER_DIR)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.replace(/\.ndjson$/, ""))
    .sort();

  // Index geojson-vt par (couche, tranche)
  const indexes = {}; // layer -> [{band, index}]
  const fields = {}; // layer -> {attr: type}
  for (const layer of layerFiles) {
    const bands = await readLayer(path.join(LAYER_DIR, `${layer}.ndjson`));
    fields[layer] = {};
    indexes[layer] = [];
    for (let b = 0; b < BANDS.length; b++) {
      const feats = bands[b];
      if (!feats.length) continue;
      for (const f of feats.slice(0, 5000))
        for (const [k, v] of Object.entries(f.properties))
          if (k[0] !== "_") fields[layer][k] = typeof v === "number" ? "Number" : "String";
      const index = geojsonvt(
        { type: "FeatureCollection", features: feats },
        { maxZoom: MAXZOOM, indexMaxZoom: 4, indexMaxPoints: 100000, tolerance: 3, extent: 4096, buffer: 64 },
      );
      indexes[layer].push({ band: BANDS[b], index });
      bands[b] = null;
    }
    log(`index ${layer} prêt (${((process.memoryUsage().rss / 1e9) | 0) || "<1"} Go RSS)`);
  }

  // Liste des tuiles à produire
  const wanted = new Map();
  for (let z = MINZOOM; z <= MAXZOOM; z++) {
    for (const bbox of Object.values(REGIONS)) for (const t of tilesFor(bbox, z)) wanted.set(t.join("/"), t);
    if (z <= 8) for (const t of tilesFor(FRANCE, z, 0)) wanted.set(t.join("/"), t);
  }
  const list = [...wanted.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  log(`${list.length} tuiles à générer`);

  fs.rmSync(TILE_DIR, { recursive: true, force: true });
  let bytes = 0, empty = 0, n = 0;
  const perZoom = {};
  for (const [z, x, y] of list) {
    const layers = {};
    for (const layer of layerFiles) {
      const feats = [];
      for (const { band, index } of indexes[layer]) {
        if (band[0] > z) continue;
        const tile = index.getTile(z, x, y);
        if (!tile) continue;
        for (const f of tile.features) {
          const t = f.tags;
          if ((t._minzoom ?? 0) > z || (t._maxzoom ?? 99) < z) continue;
          feats.push({ type: f.type, geometry: f.geometry, tags: stripTags(t), id: f.id });
        }
      }
      if (feats.length) layers[layer] = { features: feats };
    }
    const buf = Object.keys(layers).length ? Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2, extent: 4096 })) : Buffer.alloc(0);
    if (!buf.length) empty++;
    const dir = path.join(TILE_DIR, String(z), String(x));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${y}.pbf`), buf);
    bytes += buf.length;
    perZoom[z] = (perZoom[z] ?? 0) + 1;
    if (++n % 500 === 0) log(`  ${n}/${list.length} tuiles, ${(bytes / 1e6).toFixed(0)} Mo`);
  }

  const bounds = [
    Math.min(...Object.values(REGIONS).map((b) => b[0])),
    Math.min(...Object.values(REGIONS).map((b) => b[1])),
    Math.max(...Object.values(REGIONS).map((b) => b[2])),
    Math.max(...Object.values(REGIONS).map((b) => b[3])),
  ];
  const tilejson = {
    tilejson: "3.0.0",
    name: "Rydar dev tiles (Overture Maps)",
    description: "Tuiles de dev au schéma OpenMapTiles, générées depuis Overture Maps (Paris & Nice).",
    version: "1.0.0",
    attribution: "© OpenStreetMap contributors, Overture Maps Foundation",
    scheme: "xyz",
    tiles: [`${BASE_URL}/tiles/{z}/{x}/{y}.pbf`],
    minzoom: MINZOOM,
    maxzoom: MAXZOOM,
    bounds,
    center: [2.3316, 48.872, 12],
    vector_layers: layerFiles.map((id) => ({
      id,
      description: LAYER_DESCRIPTIONS[id] ?? "",
      minzoom: MINZOOM,
      maxzoom: MAXZOOM,
      fields: Object.fromEntries(Object.keys(fields[id]).sort().map((k) => [k, fields[id][k]])),
    })),
  };
  fs.writeFileSync(path.join(OUT_DIR, "tiles.json"), JSON.stringify(tilejson, null, 2));
  log(`terminé : ${list.length} tuiles (${empty} vides), ${(bytes / 1e6).toFixed(1)} Mo, ${((Date.now() - t0) / 1000) | 0}s`);
  log("par zoom :", JSON.stringify(perZoom));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
