#!/usr/bin/env node
// Routeur de dev compatible OSRM v5 (services route / table / nearest), Node 22 sans dépendance.
//
//   PORT=5001 node scripts/dev-geo/router.mjs
//
// Graphe : .dev-geo/graph.{json,bin} (build_graph.py, données Overture Maps).
// Accrochage au point le plus proche d'une arête carrossable (grille), A* (heuristique
// distance à vol d'oiseau / vitesse max du graphe → admissible), pénalité par feu tricolore.
// Réponses au format OSRM v5 (code, routes, legs, waypoints ; erreurs HTTP 400).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GRAPH_DIR = process.env.GRAPH_DIR ?? path.join(ROOT, ".dev-geo");
const PORT = Number(process.env.PORT ?? 5001);
const HOST = process.env.HOST ?? "0.0.0.0";
const SIGNAL_PENALTY = Number(process.env.SIGNAL_PENALTY ?? 10); // s par feu tricolore franchi
const MAX_SNAP_M = Number(process.env.MAX_SNAP_M ?? 3000); // au-delà : NoSegment
const MAX_TABLE = 100;
const R = 6371008.8;
const RAD = Math.PI / 180;

// ------------------------------------------------------------------------------------
// Chargement du graphe
// ------------------------------------------------------------------------------------
const t0 = Date.now();
const header = JSON.parse(fs.readFileSync(path.join(GRAPH_DIR, "graph.json"), "utf8"));
const raw = fs.readFileSync(path.join(GRAPH_DIR, "graph.bin"));
const ab = new ArrayBuffer(raw.length);
new Uint8Array(ab).set(raw);
const TYPED = { float64: Float64Array, float32: Float32Array, int32: Int32Array, uint8: Uint8Array };
const A = (name) => {
  const a = header.arrays[name];
  return new TYPED[a.dtype](ab, a.offset, a.length);
};
const nodeLon = A("nodeLon"), nodeLat = A("nodeLat"), nodeSignal = A("nodeSignal");
const edgeU = A("edgeU"), edgeV = A("edgeV"), edgeLen = A("edgeLen"), edgeDur = A("edgeDur");
const edgeFlags = A("edgeFlags"), edgeName = A("edgeName"), geomOff = A("geomOff");
const gLon = A("geomLon"), gLat = A("geomLat");
const NAMES = header.names;
const N = header.nodes, E = header.edges;

// Graphe orienté en CSR : arc = (edge, sens) ; sens 0 = géométrie, 1 = inverse
const deg = new Int32Array(N + 1);
for (let e = 0; e < E; e++) {
  if (edgeFlags[e] & 1) deg[edgeU[e] + 1]++;
  if (edgeFlags[e] & 2) deg[edgeV[e] + 1]++;
}
for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
const first = deg;
const nArcs = first[N];
const arcTo = new Int32Array(nArcs), arcRef = new Int32Array(nArcs), arcCost = new Float64Array(nArcs);
{
  const fill = first.slice(0, N);
  const sig = (n) => (nodeSignal[n] ? SIGNAL_PENALTY : 0);
  for (let e = 0; e < E; e++) {
    if (edgeFlags[e] & 1) {
      const i = fill[edgeU[e]]++;
      arcTo[i] = edgeV[e]; arcRef[i] = e * 2; arcCost[i] = edgeDur[e] + sig(edgeV[e]);
    }
    if (edgeFlags[e] & 2) {
      const i = fill[edgeV[e]]++;
      arcTo[i] = edgeU[e]; arcRef[i] = e * 2 + 1; arcCost[i] = edgeDur[e] + sig(edgeU[e]);
    }
  }
}
let maxSpeed = 1;
for (let e = 0; e < E; e++) if (edgeDur[e] > 0) maxSpeed = Math.max(maxSpeed, edgeLen[e] / edgeDur[e]);

// Grille d'accrochage : segments (point de géométrie k → k+1) des arêtes « snappables »
const CELL = 0.004;
const cellKey = (ix, iy) => (ix + 50000) * 100000 + (iy + 25000);
const cells = new Map();
let segEdge, segK;
{
  const counts = new Map();
  const visit = (cb) => {
    for (let e = 0; e < E; e++) {
      if (!(edgeFlags[e] & 4)) continue;
      for (let k = geomOff[e]; k < geomOff[e + 1] - 1; k++) {
        const x0 = Math.floor(Math.min(gLon[k], gLon[k + 1]) / CELL), x1 = Math.floor(Math.max(gLon[k], gLon[k + 1]) / CELL);
        const y0 = Math.floor(Math.min(gLat[k], gLat[k + 1]) / CELL), y1 = Math.floor(Math.max(gLat[k], gLat[k + 1]) / CELL);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cb(cellKey(x, y), e, k);
      }
    }
  };
  visit((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  let total = 0;
  for (const [key, c] of counts) { cells.set(key, [total, 0]); total += c; }
  segEdge = new Int32Array(total);
  segK = new Int32Array(total);
  visit((key, e, k) => {
    const c = cells.get(key);
    const i = c[0] + c[1]++;
    segEdge[i] = e; segK[i] = k;
  });
}

function hav(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const edgeGeoLenCache = new Map();
function edgeGeoLen(e) {
  let l = edgeGeoLenCache.get(e);
  if (l === undefined) {
    l = 0;
    for (let k = geomOff[e]; k < geomOff[e + 1] - 1; k++) l += hav(gLon[k], gLat[k], gLon[k + 1], gLat[k + 1]);
    if (edgeGeoLenCache.size > 200000) edgeGeoLenCache.clear();
    edgeGeoLenCache.set(e, l);
  }
  return l;
}

/** Point d'arête carrossable le plus proche (projection locale équirectangulaire). */
function snap(lon, lat) {
  const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
  const ix = Math.floor(lon / CELL), iy = Math.floor(lat / CELL);
  const cellMin = CELL * Math.min(kx, ky);
  let best = null, bestD2 = Infinity;
  const maxR = Math.ceil(MAX_SNAP_M / cellMin) + 1;
  for (let r = 0; r <= maxR; r++) {
    for (let x = ix - r; x <= ix + r; x++) {
      for (let y = iy - r; y <= iy + r; y++) {
        if (Math.max(Math.abs(x - ix), Math.abs(y - iy)) !== r) continue;
        const c = cells.get(cellKey(x, y));
        if (!c) continue;
        for (let i = c[0]; i < c[0] + c[1]; i++) {
          const k = segK[i];
          const ax = (gLon[k] - lon) * kx, ay = (gLat[k] - lat) * ky;
          const bx = (gLon[k + 1] - lon) * kx, by = (gLat[k + 1] - lat) * ky;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + t * dx, py = ay + t * dy, d2 = px * px + py * py;
          if (d2 < bestD2) { bestD2 = d2; best = { edge: segEdge[i], k, t }; }
        }
      }
    }
    if (best && Math.sqrt(bestD2) <= r * cellMin) break;
  }
  if (!best || Math.sqrt(bestD2) > MAX_SNAP_M) return null;
  const { edge: e, k, t } = best;
  const sLon = gLon[k] + t * (gLon[k + 1] - gLon[k]), sLat = gLat[k] + t * (gLat[k + 1] - gLat[k]);
  let off = 0;
  for (let j = geomOff[e]; j < k; j++) off += hav(gLon[j], gLat[j], gLon[j + 1], gLat[j + 1]);
  off += hav(gLon[k], gLat[k], sLon, sLat);
  const L = edgeGeoLen(e) || 1;
  return { edge: e, k, lon: sLon, lat: sLat, frac: Math.min(1, Math.max(0, off / L)), dist: Math.sqrt(bestD2), input: [lon, lat] };
}

// ------------------------------------------------------------------------------------
// Recherche de chemin
// ------------------------------------------------------------------------------------
const gScore = new Float64Array(N), gDist = new Float64Array(N), parent = new Int32Array(N);
const stamp = new Uint32Array(N);
let gen = 0;

class Heap {
  constructor() { this.k = new Float64Array(1 << 16); this.v = new Int32Array(1 << 16); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0], topKey = K[0];
    const key = K[--this.n], val = V[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c]; V[i] = V[c]; i = c;
    }
    K[i] = key; V[i] = val;
    this.lastKey = topKey;
    return top;
  }
}
const heap = new Heap();

const sig = (n) => (nodeSignal[n] ? SIGNAL_PENALTY : 0);

/** Départs possibles depuis un point accroché : [{node, cost, dist, dir}] */
function sourceExits(s) {
  const e = s.edge, out = [];
  const L = edgeLen[e];
  if (edgeFlags[e] & 1) out.push({ node: edgeV[e], cost: (1 - s.frac) * edgeDur[e] + sig(edgeV[e]), dist: (1 - s.frac) * L, dir: 0 });
  if (edgeFlags[e] & 2) out.push({ node: edgeU[e], cost: s.frac * edgeDur[e] + sig(edgeU[e]), dist: s.frac * L, dir: 1 });
  return out;
}
/** Arrivées possibles sur un point accroché : [{node, cost, dist, dir}] (dir = sens de parcours de l'arête) */
function targetEntries(s) {
  const e = s.edge, out = [];
  const L = edgeLen[e];
  if (edgeFlags[e] & 1) out.push({ node: edgeU[e], cost: s.frac * edgeDur[e], dist: s.frac * L, dir: 0 });
  if (edgeFlags[e] & 2) out.push({ node: edgeV[e], cost: (1 - s.frac) * edgeDur[e], dist: (1 - s.frac) * L, dir: 1 });
  return out;
}
/** Trajet direct sur la même arête (si le sens le permet). */
function sameEdge(s, t) {
  if (s.edge !== t.edge) return null;
  const e = s.edge;
  if (edgeFlags[e] & 1 && t.frac >= s.frac) return { cost: (t.frac - s.frac) * edgeDur[e], dist: (t.frac - s.frac) * edgeLen[e], dir: 0 };
  if (edgeFlags[e] & 2 && t.frac <= s.frac) return { cost: (s.frac - t.frac) * edgeDur[e], dist: (s.frac - t.frac) * edgeLen[e], dir: 1 };
  return null;
}

function initSearch(src) {
  gen++;
  heap.n = 0;
  const exits = sourceExits(src);
  for (const x of exits) {
    if (stamp[x.node] === gen && gScore[x.node] <= x.cost) continue;
    stamp[x.node] = gen; gScore[x.node] = x.cost; gDist[x.node] = x.dist; parent[x.node] = -(x.dir + 2); // -2 / -3
  }
  return exits;
}

/** A* point → point. Retourne {cost, dist, arcs[], srcDir, dstDir, direct} ou null. */
function astar(src, dst) {
  const direct = sameEdge(src, dst);
  let best = direct ? direct.cost : Infinity, bestEntry = null;
  const entries = targetEntries(dst);
  const exits = initSearch(src);
  const tx = dst.lon, ty = dst.lat;
  const h = (n) => hav(nodeLon[n], nodeLat[n], tx, ty) / maxSpeed;
  for (const x of exits) if (gScore[x.node] === x.cost) heap.push(x.cost + h(x.node), x.node);
  while (heap.n) {
    const u = heap.pop();
    const f = heap.lastKey;
    if (f >= best) break;
    const gu = gScore[u];
    if (f > gu + h(u) + 1e-9) continue; // entrée périmée
    for (const en of entries) {
      if (en.node === u && gu + en.cost < best) { best = gu + en.cost; bestEntry = en; }
    }
    for (let i = first[u]; i < first[u + 1]; i++) {
      const v = arcTo[i];
      const g = gu + arcCost[i];
      if (stamp[v] !== gen || g < gScore[v]) {
        stamp[v] = gen; gScore[v] = g; parent[v] = i; gDist[v] = gDist[u] + edgeLen[arcRef[i] >> 1];
        heap.push(g + h(v), v);
      }
    }
  }
  if (best === Infinity) return null;
  if (!bestEntry) return { cost: direct.cost, dist: direct.dist, direct };
  const arcs = [];
  let n = bestEntry.node;
  while (parent[n] >= 0) {
    const a = parent[n], e = arcRef[a] >> 1;
    arcs.push(a);
    n = arcRef[a] & 1 ? edgeV[e] : edgeU[e]; // nœud de départ de l'arc
  }
  arcs.reverse();
  const srcDir = -parent[n] - 2;
  const exit = exits.find((x) => x.dir === srcDir);
  return { cost: best, dist: exit.dist + sumArcLen(arcs) + bestEntry.dist, arcs, srcDir, dstDir: bestEntry.dir };
}
function sumArcLen(arcs) {
  let d = 0;
  for (const a of arcs) d += edgeLen[arcRef[a] >> 1];
  return d;
}

/** Dijkstra 1 → n pour /table. Retourne [{cost, dist}|null] */
function oneToMany(src, dsts) {
  const res = dsts.map((d) => {
    const direct = sameEdge(src, d);
    return direct ? { cost: direct.cost, dist: direct.dist } : null;
  });
  const entries = dsts.map((d) => targetEntries(d));
  const byNode = new Map();
  entries.forEach((list, j) => list.forEach((en) => {
    if (!byNode.has(en.node)) byNode.set(en.node, []);
    byNode.get(en.node).push([j, en]);
  }));
  const exits = initSearch(src);
  for (const x of exits) if (gScore[x.node] === x.cost) heap.push(x.cost, x.node);
  let remaining = byNode.size;
  while (heap.n && remaining > 0) {
    const u = heap.pop();
    const gu = heap.lastKey;
    if (gu > gScore[u] + 1e-9) continue;
    const hits = byNode.get(u);
    if (hits) {
      remaining--;
      for (const [j, en] of hits) {
        const c = gu + en.cost;
        if (!res[j] || c < res[j].cost) res[j] = { cost: c, dist: gDist[u] + en.dist };
      }
    }
    for (let i = first[u]; i < first[u + 1]; i++) {
      const v = arcTo[i];
      const g = gu + arcCost[i];
      if (stamp[v] !== gen || g < gScore[v]) {
        stamp[v] = gen; gScore[v] = g; parent[v] = i; gDist[v] = gDist[u] + edgeLen[arcRef[i] >> 1];
        heap.push(g, v);
      }
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------
// Géométrie, encodage, étapes
// ------------------------------------------------------------------------------------
function edgePoints(e, reverse) {
  const pts = [];
  for (let k = geomOff[e]; k < geomOff[e + 1]; k++) pts.push([gLon[k], gLat[k], e]);
  return reverse ? pts.reverse() : pts;
}

/** Coordonnées du trajet (avec l'arête de chaque point pour annotations/étapes). */
function legCoords(src, dst, r) {
  const out = [];
  const push = (p) => {
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p);
  };
  if (r.direct) {
    const e = src.edge;
    push([src.lon, src.lat, e]);
    const pts = edgePoints(e, false);
    const base = geomOff[e];
    if (r.direct.dir === 0) for (let k = src.k + 1; k <= dst.k; k++) push(pts[k - base]);
    else for (let k = src.k; k > dst.k; k--) push(pts[k - base]);
    push([dst.lon, dst.lat, e]);
    return out;
  }
  // départ : du point accroché jusqu'au bout de l'arête dans le sens de sortie
  {
    const e = src.edge, base = geomOff[e], pts = edgePoints(e, false);
    push([src.lon, src.lat, e]);
    if (r.srcDir === 0) for (let k = src.k + 1; k < geomOff[e + 1]; k++) push(pts[k - base]);
    else for (let k = src.k; k >= base; k--) push(pts[k - base]);
  }
  for (const a of r.arcs) for (const p of edgePoints(arcRef[a] >> 1, (arcRef[a] & 1) === 1)) push(p);
  {
    const e = dst.edge, base = geomOff[e], pts = edgePoints(e, false);
    if (r.dstDir === 0) for (let k = base; k <= dst.k; k++) push(pts[k - base]);
    else for (let k = geomOff[e + 1] - 1; k > dst.k; k--) push(pts[k - base]);
    push([dst.lon, dst.lat, e]);
  }
  return out;
}

function encodePolyline(coords, precision) {
  const f = 10 ** precision;
  let out = "", pLat = 0, pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * f), lo = Math.round(lon * f);
    out += enc(la - pLat) + enc(lo - pLon);
    pLat = la; pLon = lo;
  }
  return out;
}

function simplify(coords, tolM) {
  if (coords.length <= 2) return coords;
  const kx = 111320 * Math.cos(coords[0][1] * RAD), ky = 110540;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = coords[a][0] * kx, ay = coords[a][1] * ky, bx = coords[b][0] * kx, by = coords[b][1] * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][0] * kx, py = coords[i][1] * ky;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tolM) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}

function geometryOut(coords, fmt) {
  const c = [];
  for (const p of coords) {
    const q = [round(p[0], 6), round(p[1], 6)], l = c[c.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) c.push(q);
  }
  if (c.length === 1) c.push(c[0]); // une LineString a au moins 2 points (comme OSRM à l'arrivée)
  if (fmt === "geojson") return { type: "LineString", coordinates: c };
  return encodePolyline(c, fmt === "polyline6" ? 6 : 5);
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function bearing(a, b) {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return Math.round(((Math.atan2(y, x) / RAD) + 360) % 360);
}
function modifier(before, after) {
  const d = (after - before + 540) % 360 - 180;
  if (Math.abs(d) < 20) return "straight";
  if (d >= 20 && d < 60) return "slight right";
  if (d >= 60 && d < 140) return "right";
  if (d >= 140) return "sharp right";
  if (d <= -20 && d > -60) return "slight left";
  if (d <= -60 && d > -140) return "left";
  return "sharp left";
}

/** Étapes simplifiées : départ, changement de nom de voie, arrivée. */
function buildSteps(coords, leg, fmt) {
  const nameOf = (e) => NAMES[edgeName[e]] ?? "";
  const groups = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const e = coords[i + 1][2], name = nameOf(e);
    const d = hav(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    const g = groups[groups.length - 1];
    if (g && g.name === name) { g.end = i + 1; g.dist += d; }
    else groups.push({ name, start: i, end: i + 1, dist: d });
  }
  const total = groups.reduce((s, g) => s + g.dist, 0) || 1;
  const steps = groups.map((g, gi) => {
    const pts = coords.slice(g.start, g.end + 1);
    const bAfter = bearing(pts[0], pts[1] ?? pts[0]);
    const bBefore = gi === 0 ? 0 : bearing(coords[g.start - 1], coords[g.start]);
    const type = gi === 0 ? "depart" : "turn";
    const mod = gi === 0 ? undefined : modifier(bBefore, bAfter);
    const dur = (leg.duration * g.dist) / total;
    return {
      geometry: geometryOut(pts, fmt),
      maneuver: { bearing_after: bAfter, bearing_before: bBefore, location: [round(pts[0][0], 6), round(pts[0][1], 6)], type: mod === "straight" ? "new name" : type, ...(mod ? { modifier: mod } : {}) },
      mode: "driving",
      driving_side: "right",
      name: g.name,
      intersections: [{ out: 0, entry: [true], bearings: [bAfter], location: [round(pts[0][0], 6), round(pts[0][1], 6)] }],
      weight: round(dur, 1),
      duration: round(dur, 1),
      distance: round(g.dist, 1),
    };
  });
  const last = coords[coords.length - 1];
  const bb = coords.length > 1 ? bearing(coords[coords.length - 2], last) : 0;
  steps.push({
    geometry: geometryOut([last, last], fmt),
    maneuver: { bearing_after: 0, bearing_before: bb, location: [round(last[0], 6), round(last[1], 6)], type: "arrive" },
    mode: "driving", driving_side: "right", name: steps.length ? steps[steps.length - 1].name : "",
    intersections: [{ in: 0, entry: [true], bearings: [(bb + 180) % 360], location: [round(last[0], 6), round(last[1], 6)] }],
    weight: 0, duration: 0, distance: 0,
  });
  const byName = new Map();
  for (const g of groups) if (g.name) byName.set(g.name, (byName.get(g.name) ?? 0) + g.dist);
  const summary = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n).join(", ");
  return { steps, summary };
}

function waypoint(s) {
  return { hint: "", distance: round(hav(s.input[0], s.input[1], s.lon, s.lat), 6), name: NAMES[edgeName[s.edge]] ?? "", location: [round(s.lon, 6), round(s.lat, 6)] };
}

// ------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------
class OsrmError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseCoords(str) {
  const parts = str.split(";");
  return parts.map((p, i) => {
    const m = p.split(",");
    const lon = Number(m[0]), lat = Number(m[1]);
    if (m.length !== 2 || !Number.isFinite(lon) || !Number.isFinite(lat) || m[0] === "" || m[1] === "")
      throw new OsrmError("InvalidUrl", `URL string malformed close to position ${i}: "${p}"`);
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new OsrmError("InvalidValue", `Invalid coordinate value at position ${i}.`);
    return [lon, lat];
  });
}

function snapAll(coords) {
  return coords.map((c, i) => {
    const s = snap(c[0], c[1]);
    if (!s) throw new OsrmError("NoSegment", `Could not find a matching segment for coordinate ${i}`);
    return s;
  });
}

function parseIndexList(v, n, what) {
  if (v === null || v === undefined || v === "all") return [...Array(n).keys()];
  const out = v.split(";").map(Number);
  if (out.some((x) => !Number.isInteger(x) || x < 0 || x >= n)) throw new OsrmError("InvalidOptions", `${what} indices must be less than or equal to the number of coordinates`);
  return out;
}

function handleRoute(coordsStr, q) {
  const coords = parseCoords(coordsStr);
  if (coords.length < 2) throw new OsrmError("InvalidOptions", "Number of coordinates needs to be at least two.");
  const overview = q.get("overview") ?? "simplified";
  const fmt = q.get("geometries") ?? "polyline";
  if (!["polyline", "polyline6", "geojson"].includes(fmt)) throw new OsrmError("InvalidOptions", "geometries must be one of polyline, polyline6, geojson");
  if (!["simplified", "full", "false"].includes(overview)) throw new OsrmError("InvalidOptions", "overview must be one of simplified, full, false");
  const wantSteps = q.get("steps") === "true";
  const ann = q.get("annotations");
  const annList = ann === "true" ? ["duration", "distance", "speed"] : ann && ann !== "false" ? ann.split(",") : [];
  const snaps = snapAll(coords);
  const legs = [];
  let all = [];
  let dist = 0, dur = 0;
  for (let i = 0; i < snaps.length - 1; i++) {
    const r = astar(snaps[i], snaps[i + 1]);
    if (!r) throw new OsrmError("NoRoute", "Impossible route between points");
    const c = legCoords(snaps[i], snaps[i + 1], r);
    const leg = { distance: round(r.dist, 1), duration: round(r.cost, 1), weight: round(r.cost, 1), summary: "", steps: [] };
    if (wantSteps) Object.assign(leg, (({ steps, summary }) => ({ steps, summary }))(buildSteps(c, leg, fmt)));
    if (annList.length) {
      const a = {};
      const segD = [], segT = [];
      for (let j = 0; j < c.length - 1; j++) {
        const d = hav(c[j][0], c[j][1], c[j + 1][0], c[j + 1][1]), e = c[j + 1][2];
        segD.push(round(d, 1));
        segT.push(round(edgeLen[e] > 0 ? (d * edgeDur[e]) / edgeLen[e] : 0, 1));
      }
      if (annList.includes("distance")) a.distance = segD;
      if (annList.includes("duration")) a.duration = segT;
      if (annList.includes("speed")) a.speed = segD.map((d, j) => (segT[j] ? round(d / segT[j], 1) : 0));
      if (annList.includes("nodes")) a.nodes = [];
      leg.annotation = a;
    }
    legs.push(leg);
    all = all.length ? all.concat(c.slice(1)) : c;
    dist += r.dist; dur += r.cost;
  }
  const route = { distance: round(dist, 1), duration: round(dur, 1), weight: round(dur, 1), weight_name: "duration", legs };
  if (overview !== "false") {
    let geo = all;
    if (overview === "simplified") {
      const lons = all.map((p) => p[0]), lats = all.map((p) => p[1]);
      const diag = hav(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
      geo = simplify(all, Math.min(100, Math.max(3, diag / 2000)));
    }
    route.geometry = geometryOut(geo, fmt);
  }
  // ordre des clés comme OSRM : geometry, legs, weight_name, weight, duration, distance
  const ordered = {};
  if (route.geometry !== undefined) ordered.geometry = route.geometry;
  Object.assign(ordered, { legs: route.legs, weight_name: "duration", weight: route.weight, duration: route.duration, distance: route.distance });
  return { code: "Ok", routes: [ordered], waypoints: snaps.map(waypoint) };
}

function handleTable(coordsStr, q) {
  const coords = parseCoords(coordsStr);
  if (coords.length > MAX_TABLE) throw new OsrmError("TooBig", "Too many table coordinates");
  const sources = parseIndexList(q.get("sources"), coords.length, "Source");
  const dests = parseIndexList(q.get("destinations"), coords.length, "Destination");
  const ann = (q.get("annotations") ?? "duration").split(",");
  const snaps = snapAll(coords);
  const durations = [], distances = [];
  for (const si of sources) {
    const res = oneToMany(snaps[si], dests.map((d) => snaps[d]));
    durations.push(res.map((r, j) => (dests[j] === si ? 0 : r ? round(r.cost, 1) : null)));
    distances.push(res.map((r, j) => (dests[j] === si ? 0 : r ? round(r.dist, 1) : null)));
  }
  const out = { code: "Ok" };
  if (ann.includes("duration")) out.durations = durations;
  if (ann.includes("distance")) out.distances = distances;
  out.destinations = dests.map((d) => waypoint(snaps[d]));
  out.sources = sources.map((s) => waypoint(snaps[s]));
  return out;
}

function handleNearest(coordsStr, q) {
  const coords = parseCoords(coordsStr);
  if (coords.length !== 1) throw new OsrmError("InvalidOptions", "Number of coordinates needs to be one.");
  const [s] = snapAll(coords);
  return { code: "Ok", waypoints: [{ nodes: [edgeU[s.edge], edgeV[s.edge]], ...waypoint(s) }].slice(0, Number(q.get("number") ?? 1)) };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=UTF-8", ...CORS });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/health" || u.pathname === "/health/") return send(200, { ok: true });
  const m = u.pathname.match(/^\/(route|table|nearest|match|trip|tile)\/v1\/([^/]+)\/(.+?)(\.json)?$/);
  try {
    if (!m) {
      const svc = u.pathname.split("/")[1];
      if (svc && !["route", "table", "nearest"].includes(svc)) throw new OsrmError("InvalidService", `Service ${svc} not found!`);
      throw new OsrmError("InvalidUrl", `URL string malformed close to position 1: "${u.pathname}"`);
    }
    const [, service, , coords] = m;
    const t = process.hrtime.bigint();
    let body;
    if (service === "route") body = handleRoute(decodeURIComponent(coords), u.searchParams);
    else if (service === "table") body = handleTable(decodeURIComponent(coords), u.searchParams);
    else if (service === "nearest") body = handleNearest(decodeURIComponent(coords), u.searchParams);
    else throw new OsrmError("NotImplemented", `Service ${service} is not implemented in the dev router`);
    res.setHeader("X-Response-Time-Ms", String(Number(process.hrtime.bigint() - t) / 1e6));
    send(200, body);
  } catch (e) {
    if (e instanceof OsrmError) return send(400, { code: e.code, message: e.message });
    console.error(e);
    send(500, { code: "InternalError", message: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[router] ${N} nœuds, ${E} arêtes, ${nArcs} arcs, vitesse max ${(maxSpeed * 3.6).toFixed(0)} km/h — prêt en ${Date.now() - t0} ms sur http://localhost:${PORT}`);
});
