// Copie le worker MapLibre dans public/ (aperçu web de l'app chauffeur).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = join(root, "public");
if (!existsSync(out)) mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, f), join(out, f));
console.log("maplibre worker → public/");
