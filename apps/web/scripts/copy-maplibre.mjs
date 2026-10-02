// Copie le worker MapLibre (ESM) dans /public : chargé via setWorkerUrl().
// Chemin versionné (public/vendor/maplibre/<version>/) : servi avec un cache navigateur d'un an (next.config.ts), une
// nouvelle version de MapLibre change l'adresse (jamais de worker périmé). use-maplibre.ts lit la même version
// (lib.getVersion()).
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.css"));
const { version } = require("maplibre-gl/package.json");
const root = join(process.cwd(), "public/vendor/maplibre");
const out = join(root, version);
// Anciennes copies (autres versions, ancien chemin sans version) : retirées
rmSync(root, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, f), join(out, f));
console.log(`maplibre worker → public/vendor/maplibre/${version}`);
