#!/usr/bin/env node
// Captures de contrôle des tuiles de dev avec Playwright (Chromium SwiftShader).
//
//   node scripts/dev-geo/shots.mjs [style.json] [out-dir]
//
// Sert lui-même (port libre) : MapLibre (node_modules/maplibre-gl/dist), apps/web/public/dev-map,
// et une page HTML minimale. Les URL http://localhost:3000/dev-map du style sont réécrites vers ce
// serveur, donc le serveur Next n'est pas nécessaire. Option ROUTE=1 : trace aussi un itinéraire
// demandé au routeur local (ROUTER_URL, défaut http://localhost:5001).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLE = process.argv[2] ?? path.join(ROOT, "apps/web/public/dev-map/style-test.json");
const OUT = process.argv[3] ?? path.join(ROOT, ".dev-geo/shots");
const MAPLIBRE = path.join(ROOT, "node_modules/maplibre-gl/dist");
const DEVMAP = path.join(ROOT, "apps/web/public/dev-map");
const ROUTER = process.env.ROUTER_URL ?? "http://localhost:5001";

const globalRoot = execSync("npm root -g").toString().trim();
const { chromium } = createRequire(path.join(globalRoot, "playwright", "package.json"))("playwright");

const VIEWS = [
  { name: "paris-z11", center: [2.3316, 48.872], zoom: 11 },
  { name: "paris-z13", center: [2.3316, 48.872], zoom: 13 },
  { name: "paris-z15", center: [2.3316, 48.872], zoom: 15 },
  { name: "nice-z13", center: [7.27, 43.6975], zoom: 13 },
  { name: "paris-z9", center: [2.38, 48.87], zoom: 9 },
  { name: "cdg-z13", center: [2.565, 49.006], zoom: 13 },
  { name: "nice-z15", center: [7.2700, 43.6975], zoom: 15 },
  { name: "france-z6", center: [2.5, 46.5], zoom: 5.5 },
];

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/maplibre/maplibre-gl.css">
<style>html,body,#map{margin:0;height:100%;background:#000}</style></head>
<body><div id="map"></div>
<script type="module">
import * as maplibregl from "/maplibre/maplibre-gl.mjs";
maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
window.__errors = [];
const p = new URLSearchParams(location.search);
const style = JSON.parse((await (await fetch("/style.json")).text()).replaceAll("http://localhost:3000/dev-map", location.origin + "/dev-map"));
const map = new maplibregl.Map({ container: "map", style, center: JSON.parse(p.get("c")), zoom: +p.get("z"), attributionControl: false, fadeDuration: 0 });
map.on("error", (e) => window.__errors.push(String(e.error?.message ?? e.error ?? e)));
if (p.get("route")) {
  const r = await (await fetch(p.get("route"))).json();
  map.on("load", () => {
    map.addSource("route", { type: "geojson", data: { type: "Feature", geometry: r.routes[0].geometry, properties: {} } });
    map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#07080b", "line-width": 8 } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#FF4D4F", "line-width": 4 } });
    const b = r.routes[0].geometry.coordinates.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(r.routes[0].geometry.coordinates[0], r.routes[0].geometry.coordinates[0]));
    map.fitBounds(b, { padding: 60, duration: 0 });
  });
}
window.__map = map;
map.on("idle", () => { window.__idle = true; });
</script></body></html>`;

const MIME = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".pbf": "application/x-protobuf", ".html": "text/html" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const p = decodeURIComponent(u.pathname);
      let file;
      if (p === "/" || p === "/index.html") return res.writeHead(200, { "content-type": "text/html" }).end(HTML);
      if (p === "/style.json") file = STYLE;
      else if (p.startsWith("/maplibre/")) file = path.join(MAPLIBRE, p.slice(10));
      else if (p.startsWith("/dev-map/")) file = path.join(DEVMAP, p.slice(9));
      if (!file || !file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const srv = await serve();
const base = `http://127.0.0.1:${srv.address().port}/`;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
if (process.env.DEBUG) {
  page.on("console", (m) => console.log("console:", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
}
const views = process.env.ROUTE
  ? [{ name: process.env.ROUTE_NAME ?? "route", center: [2.4, 48.9], zoom: 10, route: `${ROUTER}/route/v1/driving/${process.env.ROUTE}?overview=full&geometries=geojson` }]
  : VIEWS.filter((v) => !process.env.ONLY || process.env.ONLY.split(",").includes(v.name));
for (const v of views) {
  const url = `${base}?c=${encodeURIComponent(JSON.stringify(v.center))}&z=${v.zoom}${v.route ? `&route=${encodeURIComponent(v.route)}` : ""}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__idle === true || (window.__map && window.__map.loaded() && window.__map.areTilesLoaded()), null, { timeout: 180000, polling: 500 });
  await page.waitForTimeout(500);
  const file = path.join(OUT, `${v.name}.png`);
  await page.screenshot({ path: file });
  const errors = await page.evaluate(() => window.__errors);
  console.log(`${file}${errors.length ? `  erreurs: ${[...new Set(errors)].slice(0, 5).join(" | ")}` : ""}`);
}
await browser.close();
srv.close();
