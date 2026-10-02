// Copie le worker MapLibre (ESM) dans /public : chargé via setWorkerUrl().
// Chemin versionné (public/vendor/maplibre/<version>/) : servi avec un cache navigateur d'un an (next.config.ts), une
// nouvelle version de MapLibre change l'adresse (jamais de worker périmé). use-maplibre.ts lit la même version
// (lib.getVersion()).
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Ancien chemin sans version (/vendor/maplibre/maplibre-gl-worker.mjs, pages d'avant 10/2026) : un onglet resté ouvert
 * pendant le déploiement charge encore le worker à cette adresse en ouvrant une carte. Gardé tant que MapLibre reste
 * dans cette version (le worker doit être celui de la page), puis plus copié tout seul à la mise à jour suivante.
 */
const LEGACY_PATH_VERSION = "6.11.2";
const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.css"));
const { version } = require("maplibre-gl/package.json");
const root = join(process.cwd(), "public/vendor/maplibre");
const out = join(root, version);
// Anciennes copies (autres versions) : retirées
rmSync(root, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of FILES) copyFileSync(join(dist, f), join(out, f));
if (version === LEGACY_PATH_VERSION) for (const f of FILES) copyFileSync(join(dist, f), join(root, f));
console.log(`maplibre worker → public/vendor/maplibre/${version}${version === LEGACY_PATH_VERSION ? " (+ ancien chemin)" : ""}`);
