#!/usr/bin/env node
// Géocodeur de dev compatible API Adresse (BAN, api-adresse.data.gouv.fr / data.geopf.fr/geocodage).
//
//   PORT=5002 node scripts/dev-geo/geocoder.mjs
//
// Endpoints :
//   GET /search/?q=…&limit=5&autocomplete=1[&lat=&lon=][&type=][&postcode=][&citycode=]
//   GET /reverse/?lat=…&lon=…[&type=][&limit=]
//   GET /completion/?text=…&type=StreetAddress,PositionOfInterest&maximumResponses=6   (format Géoplateforme)
//   (aliases /geocodage/search, /geocodage/reverse, /geocodage/completion)
//   GET /health → {"ok":true}
// Index : .dev-geo/geocoder/{docs.json,addr.bin} (build_geocoder.py, données Overture Maps).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = process.env.GEOCODER_DIR ?? path.join(ROOT, ".dev-geo/geocoder");
const PORT = Number(process.env.PORT ?? 5002);
const HOST = process.env.HOST ?? "0.0.0.0";
const RAD = Math.PI / 180;

// ------------------------------------------------------------------------------------
// Normalisation / tokens
// ------------------------------------------------------------------------------------
const STOP = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "et", "en", "sur", "sous", "the", "of", "s"]);
const ABBR = {
  av: "avenue", ave: "avenue", avn: "avenue", bd: "boulevard", bld: "boulevard", blvd: "boulevard", boul: "boulevard",
  bvd: "boulevard", pl: "place", plc: "place", r: "rue", st: "saint", ste: "sainte", fg: "faubourg", fbg: "faubourg",
  faub: "faubourg", ch: "chemin", chem: "chemin", che: "chemin", imp: "impasse", all: "allee", rte: "route", sq: "square",
  qu: "quai", qua: "quai", crs: "cours", prom: "promenade", esp: "esplanade", res: "residence", pte: "porte",
  gal: "general", gen: "general", mal: "marechal", mar: "marechal", pdt: "president", pres: "president",
  lt: "lieutenant", cdt: "commandant", dr: "docteur", pr: "professeur", hop: "hopital", aero: "aeroport",
  aerop: "aeroport", mt: "mont", airport: "aeroport", aeroports: "aeroport",
};
const STREET_TYPES = new Set(["rue", "avenue", "boulevard", "place", "allee", "chemin", "impasse", "route", "quai", "cours",
  "square", "passage", "villa", "cite", "sentier", "voie", "promenade", "esplanade", "rond", "point", "parvis", "port",
  "hameau", "residence", "lotissement", "sente", "ruelle", "galerie", "carrefour", "clos", "domaine", "montee", "traverse"]);
// mots génériques de type de lieu : demi-poids dans la couverture du nom (comme les types de voie)
const TYPE_WORDS = new Set(["gare", "metro", "station", "aeroport", "hotel", "musee", "hopital", "stade", "parc", "jardin",
  "theatre", "cinema", "mairie", "universite", "ecole", "centre", "commercial", "clinique", "rer"]);
const CATEGORY_WORDS = {
  airport: ["aeroport", "airport", "aerogare"], station: ["gare", "train"], metro: ["metro", "station"], hotel: ["hotel"],
  museum: ["musee", "museum"], landmark: ["monument"], stadium: ["stade"], hospital: ["hopital", "clinique"],
  university: ["universite", "faculte", "ecole"], park: ["parc", "jardin"], cemetery: ["cimetiere"], theatre: ["theatre", "salle"],
  shopping: ["centre", "commercial", "magasin"], embassy: ["ambassade"], townhall: ["mairie"], convention_centre: ["salon", "congres", "expo"],
  cinema: ["cinema"], casino: ["casino"], attraction: [], venue: ["salle"],
};

function norm(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const tokens = (s) => {
  const t = norm(s);
  return t ? t.split(" ").map((x) => ABBR[x] ?? x) : [];
};

// ------------------------------------------------------------------------------------
// Lambert-93 (EPSG:2154) pour les propriétés x / y BAN
// ------------------------------------------------------------------------------------
const toL93 = (() => {
  const a = 6378137, e = 0.0818191910428158;
  const φ0 = 46.5 * RAD, φ1 = 49 * RAD, φ2 = 44 * RAD, λ0 = 3 * RAD, x0 = 700000, y0 = 6600000;
  const m = (φ) => Math.cos(φ) / Math.sqrt(1 - e * e * Math.sin(φ) ** 2);
  const t = (φ) => Math.tan(Math.PI / 4 - φ / 2) / ((1 - e * Math.sin(φ)) / (1 + e * Math.sin(φ))) ** (e / 2);
  const n = (Math.log(m(φ1)) - Math.log(m(φ2))) / (Math.log(t(φ1)) - Math.log(t(φ2)));
  const F = m(φ1) / (n * t(φ1) ** n);
  const ρ0 = a * F * t(φ0) ** n;
  return (lon, lat) => {
    const ρ = a * F * t(lat * RAD) ** n, θ = n * (lon * RAD - λ0);
    return [Math.round((x0 + ρ * Math.sin(θ)) * 100) / 100, Math.round((y0 + ρ0 - ρ * Math.cos(θ)) * 100) / 100];
  };
})();

// ------------------------------------------------------------------------------------
// Chargement de l'index
// ------------------------------------------------------------------------------------
const t0 = Date.now();
const data = JSON.parse(fs.readFileSync(path.join(DIR, "docs.json"), "utf8"));
const docs = data.docs;
const NUMBERS = data.numbers.split("|");
const POSTCODES = data.meta.postcodes;
const nAddr = NUMBERS.length;
const addrBuf = fs.readFileSync(path.join(DIR, "addr.bin"));
const addrAb = new ArrayBuffer(addrBuf.length);
new Uint8Array(addrAb).set(addrBuf);
const aLon = new Float64Array(addrAb, 0, nAddr), aLat = new Float64Array(addrAb, nAddr * 8, nAddr);
const aPc = new Uint16Array(addrAb, nAddr * 16, nAddr);
const addrStreet = new Int32Array(nAddr);
const muniByCode = new Map();

const postings = new Map(); // token -> number[] (converted to Int32Array)
for (let i = 0; i < docs.length; i++) {
  const d = docs[i];
  d.nameToks = tokens(d.name);
  d.aliasToks = (d.alias ?? []).map(tokens);
  const ctx = [...tokens(d.city), d.pc];
  if (d.cc?.startsWith("751")) ctx.push("paris");
  if (d.t === "poi") ctx.push(...(CATEGORY_WORDS[d.cat] ?? []));
  d.ctxToks = ctx;
  d.all = [...new Set([...d.nameToks, ...d.aliasToks.flat(), ...ctx])];
  for (const t of d.all) {
    let p = postings.get(t);
    if (!p) postings.set(t, (p = []));
    p.push(i);
  }
  if (d.t === "street") for (let j = d.a0; j < d.a0 + d.an; j++) addrStreet[j] = i;
  if (d.t === "municipality") muniByCode.set(d.cc, i);
}
for (const [k, v] of postings) postings.set(k, Int32Array.from(v));
const TOKENS = [...postings.keys()].sort();
const docStamp = new Int32Array(docs.length);
const docCount = new Uint8Array(docs.length);
let stampGen = 0;

// Grille des adresses (reverse)
const CELL = 0.002;
const cellKey = (x, y) => (x + 100000) * 200000 + (y + 50000);
const grid = new Map();
for (let i = 0; i < nAddr; i++) {
  const k = cellKey(Math.floor(aLon[i] / CELL), Math.floor(aLat[i] / CELL));
  let c = grid.get(k);
  if (!c) grid.set(k, (c = []));
  c.push(i);
}

function hav(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ------------------------------------------------------------------------------------
// Recherche
// ------------------------------------------------------------------------------------
function prefixRange(p) {
  let lo = 0, hi = TOKENS.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (TOKENS[m] < p) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < TOKENS.length && TOKENS[i].startsWith(p); i++) out.push(TOKENS[i]);
  return out;
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const HN_RE = /^(\d{1,4})(bis|ter|quater|quinquies|[a-z])?$/;
const MAX_SCORED = 3000;

function parseQuery(q, autocomplete) {
  const raw = norm(q).split(" ").filter(Boolean);
  const trailing = /\s$/.test(q);
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i];
    if (HN_RE.test(t) && ["bis", "ter", "quater"].includes(raw[i + 1])) { t += raw[i + 1]; i++; }
    items.push({ t, last: false });
  }
  if (items.length && autocomplete && !trailing) items[items.length - 1].last = true;
  for (const it of items) {
    const m = it.t.match(HN_RE);
    it.num = !!m;
    it.stop = STOP.has(it.t);
    const alts = new Set([it.t]);
    if (ABBR[it.t]) alts.add(ABBR[it.t]);
    if (m && !m[2]) { alts.add(`${it.t}e`); alts.add(`${it.t}eme`); alts.add(`${it.t}er`); }
    it.alts = [...alts];
  }
  return items;
}

/** Tokens de l'index correspondant à un élément de requête → Map(token → poids). */
function itemTokens(it) {
  const w = new Map();
  const set = (tok, v) => { if ((w.get(tok) ?? 0) < v) w.set(tok, v); };
  for (const a of it.alts) {
    if (postings.has(a)) set(a, 1);
    const allowPrefix = it.last ? a.length >= 1 : a.length >= 3 && !it.num;
    if (allowPrefix) {
      const r = prefixRange(a);
      if (r.length <= 4000) for (const tok of r) if (tok !== a) set(tok, (it.last ? 0.75 : 0.5) + 0.2 * (a.length / tok.length));
    }
  }
  if (!w.size && !it.num && it.t.length >= 4) {
    const max = it.t.length >= 8 ? 2 : 1;
    for (const tok of TOKENS) {
      if (Math.abs(tok.length - it.t.length) > max || tok[0] !== it.t[0]) continue;
      const cmp = it.last && tok.length > it.t.length ? tok.slice(0, it.t.length) : tok;
      if (lev(it.t, cmp, max) <= max) set(tok, 0.55);
    }
  }
  return w;
}

function startsWith(d, textItems) {
  const q = textItems.filter((it) => !it.stop);
  if (!q.length) return false;
  const core = d.nameToks.filter((t) => !STOP.has(t));
  const test = (c) => c.length >= q.length && q.every((it, k) => (it.w.get(c[k]) ?? 0) >= (it.last ? 0.75 : 1));
  if (test(core)) return true;
  // sans le type de voie / de lieu en tête (« Avenue des Champs-Élysées », « Métro Châtelet »)
  const typed = d.t === "street" ? STREET_TYPES : d.t === "poi" ? TYPE_WORDS : null;
  return !!typed && core.length > 1 && typed.has(core[0]) && test(core.slice(1));
}

function hnMatch(d, hn) {
  const m = hn.match(HN_RE);
  const base = m[1], suf = m[2] ?? "";
  let baseIdx = -1;
  for (let j = d.a0; j < d.a0 + d.an; j++) {
    const n = NUMBERS[j].replace(" ", "").toLowerCase();
    if (n === base + suf) return { idx: j, exact: true };
    if (baseIdx < 0 && n === base) baseIdx = j;
  }
  return baseIdx >= 0 ? { idx: baseIdx, exact: false } : null;
}

function search(q, opts) {
  const items = parseQuery(q, opts.autocomplete);
  if (!items.length) return [];
  for (const it of items) it.w = itemTokens(it);
  const textItems = items.filter((it) => !it.num || it.t.length === 5);
  let required = textItems.filter((it) => !it.stop && it.w.size);
  if (!required.length) required = textItems.filter((it) => it.w.size);
  if (!required.length) return [];
  const numItems = items.filter((it) => it.num && it.t.length !== 5);

  // candidats : intersection des postings (tolérance d'un mot manquant si rien)
  const touched = [];
  for (const it of required) {
    const g = ++stampGen;
    for (const tok of it.w.keys()) {
      const p = postings.get(tok);
      for (let k = 0; k < p.length; k++) {
        const di = p[k];
        if (docStamp[di] === g) continue; // déjà compté pour cet élément
        docStamp[di] = g;
        if (docCount[di] === 0) touched.push(di);
        docCount[di]++;
      }
    }
  }
  const R = required.length;
  let cands = touched.filter((di) => docCount[di] >= R);
  let relaxed = false;
  if (!cands.length && R >= 2) { cands = touched.filter((di) => docCount[di] >= R - 1); relaxed = true; }
  for (const di of touched) docCount[di] = 0;
  if (opts.type) cands = cands.filter((di) => docs[di].t === opts.type || (opts.type === "housenumber" && docs[di].t === "street"));
  if (opts.postcode) cands = cands.filter((di) => docs[di].pc === opts.postcode);
  if (opts.citycode) cands = cands.filter((di) => docs[di].cc === opts.citycode);
  // requêtes très larges (« 12 a », « rue ») : on ne note que les candidats les plus importants
  if (cands.length > MAX_SCORED) cands = cands.sort((a, b) => docs[b].imp - docs[a].imp).slice(0, MAX_SCORED);

  const scored = [];
  for (const di of cands) {
    const d = docs[di];
    let tw = 0, ts = 0;
    for (const it of textItems) {
      const wt = it.stop ? 0.25 : 1;
      let m = 0;
      for (const tok of d.all) {
        const v = it.w.get(tok);
        if (v !== undefined) m = Math.max(m, d.ctxToks.includes(tok) && !d.nameToks.includes(tok) ? v * 0.9 : v);
      }
      tw += wt; ts += wt * m;
    }
    const text = tw ? ts / tw : 0;
    let coverage = 0;
    for (const phrase of [d.nameToks, ...d.aliasToks]) {
      let tot = 0, cov = 0;
      for (const tok of phrase) {
        if (STOP.has(tok)) continue;
        const wt = (d.t === "street" && STREET_TYPES.has(tok)) || (d.t === "poi" && TYPE_WORDS.has(tok)) ? 0.5 : 1;
        tot += wt;
        let best = 0;
        for (const it of items) best = Math.max(best, it.w.get(tok) ?? 0);
        cov += wt * best;
      }
      if (tot) coverage = Math.max(coverage, cov / tot);
    }
    let score = 0.5 * text + 0.3 * coverage + 0.2 * d.imp;
    if (relaxed) score -= 0.15;
    // nombres : numéro de rue pour les voies, sinon simple bonus s'ils figurent dans le nom
    let hn = null, numsMatched = true;
    for (const it of numItems) {
      if (it.alts.some((a) => d.all.includes(a))) score += 0.06;
      else {
        numsMatched = false;
        if (!hn && d.t === "street") hn = it.t;
      }
    }
    // commune dont le nom est exactement la requête (« nice », « saint denis »)
    if (d.t === "municipality" && numsMatched && coverage >= 0.999 && d.nameToks.length === textItems.length) score += 0.05;
    // alias exact d'un lieu notable (« cdg », « orly », « roissy ») — sinon : le nom commence par la requête
    // (« boulogne » → Boulogne-Billancourt ; type de voie / de lieu en tête ignoré)
    if (d.t === "poi" && d.aliasToks.some((a) => a.length === textItems.length && a.every((tok, k) => textItems[k].w.get(tok) === 1))) score += 0.14 * d.imp;
    else if (startsWith(d, textItems)) score += d.t === "municipality" ? 0.08 : 0.04;
    score /= 1.2;
    scored.push({ di, score, hn });
  }
  scored.sort((a, b) => b.score - a.score || docs[b.di].imp - docs[a.di].imp);

  const out = [];
  const seen = new Set();
  for (const s of scored.slice(0, 60)) {
    const d = docs[s.di];
    let f;
    if (s.hn && d.t === "street") {
      const m = hnMatch(d, s.hn);
      if (m) f = featureAddress(m.idx, Math.min(1, s.score + (m.exact ? 0.08 : 0.03)));
      else f = featureDoc(d, s.score - 0.04);
    } else f = featureDoc(d, s.score);
    if (opts.type === "housenumber" && f.properties.type !== "housenumber") continue;
    if (seen.has(f.properties.label)) continue;
    seen.add(f.properties.label);
    out.push(f);
  }
  // proximité (lat/lon fournis) : 15 % du score
  if (Number.isFinite(opts.lat) && Number.isFinite(opts.lon)) {
    for (const f of out) {
      const dkm = hav(opts.lon, opts.lat, ...f.geometry.coordinates) / 1000;
      f.properties.score = f.properties.score * 0.85 + 0.15 / (1 + dkm / 5);
    }
  }
  out.sort((a, b) => b.properties.score - a.properties.score || b.properties.importance - a.properties.importance);
  for (const f of out) f.properties.score = Math.round(Math.max(0, Math.min(1, f.properties.score)) * 1e4) / 1e4;
  return out.slice(0, opts.limit);
}

// ------------------------------------------------------------------------------------
// Features (format BAN)
// ------------------------------------------------------------------------------------
function district(cc) {
  if (!cc?.startsWith("751")) return undefined;
  const n = Number(cc.slice(3));
  return `Paris ${n}${n === 1 ? "er" : "e"} Arrondissement`;
}

function props(o) {
  // ordre des clés proche de l'API Adresse ; les undefined sont retirés par JSON.stringify
  return {
    label: o.label, score: o.score, housenumber: o.housenumber, id: o.id, name: o.name, postcode: o.postcode,
    citycode: o.citycode, x: o.x, y: o.y, city: o.city, district: o.district, context: o.context, type: o.type,
    importance: o.importance, street: o.street, category: o.category, distance: o.distance,
  };
}

function featureDoc(d, score) {
  const [x, y] = toL93(d.lon, d.lat);
  const label = d.t === "municipality" ? d.name : `${d.name} ${d.pc} ${d.city}`;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [d.lon, d.lat] },
    properties: props({
      label, score, id: d.id, name: d.name, postcode: d.pc, citycode: d.cc, x, y, city: d.city,
      district: d.t === "municipality" ? undefined : district(d.cc), context: d.ctx, type: d.t,
      importance: d.imp, street: d.t === "street" ? d.name : undefined, category: d.cat,
    }),
  };
}

function featureAddress(j, score, distance) {
  const d = docs[addrStreet[j]];
  const num = NUMBERS[j], pc = POSTCODES[aPc[j]] || d.pc;
  const lon = Math.round(aLon[j] * 1e6) / 1e6, lat = Math.round(aLat[j] * 1e6) / 1e6;
  const [x, y] = toL93(lon, lat);
  const m = num.match(/^(\d+)\s*(\w*)$/);
  const id = `${d.id}_${String(m ? m[1] : num).padStart(5, "0")}${m && m[2] ? `_${m[2].toLowerCase()}` : ""}`;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: props({
      label: `${num} ${d.name} ${pc} ${d.city}`, score, housenumber: num, id, name: `${num} ${d.name}`, postcode: pc,
      citycode: d.cc, x, y, city: d.city, district: district(d.cc), context: d.ctx, type: "housenumber",
      importance: d.imp, street: d.name, distance,
    }),
  };
}

function reverse(lon, lat, opts) {
  const ix = Math.floor(lon / CELL), iy = Math.floor(lat / CELL);
  const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
  const found = [];
  for (let r = 0; r <= 25; r++) {
    for (let x = ix - r; x <= ix + r; x++)
      for (let y = iy - r; y <= iy + r; y++) {
        if (Math.max(Math.abs(x - ix), Math.abs(y - iy)) !== r) continue;
        for (const i of grid.get(cellKey(x, y)) ?? []) found.push([Math.hypot((aLon[i] - lon) * kx, (aLat[i] - lat) * ky), i]);
      }
    if (found.length >= opts.limit * 4 && r >= 1) break;
  }
  found.sort((a, b) => a[0] - b[0]);
  const out = [];
  const seen = new Set();
  for (const [dist, i] of found) {
    let f;
    if (opts.type === "street" || opts.type === "municipality") {
      const d = opts.type === "street" ? docs[addrStreet[i]] : docs[muniByCode.get(docs[addrStreet[i]].cc)];
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      f = featureDoc(d, 1);
      f.properties.distance = Math.round(dist);
    } else f = featureAddress(i, 1, Math.round(dist));
    f.properties.score = Math.round(Math.max(0, 1 - dist / 1000) * 1e4) / 1e4;
    out.push(f);
    if (out.length >= opts.limit) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
const ATTRIBUTION = { attribution: "BAN (via Overture Maps)", licence: "ETALAB-2.0" };

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname.replace(/^\/geocodage/, "").replace(/\/+$/, "") || "/";
  const qp = u.searchParams;
  const t = process.hrtime.bigint();
  try {
    if (p === "/health") return send(200, { ok: true });
    if (p === "/search") {
      const q = (qp.get("q") ?? "").trim();
      if (q.length < 3 || q.length > 200 || !/^[\p{L}\p{N}]/u.test(q))
        return send(400, { code: 400, detail: ["q: must contain between 3 and 200 chars and start with a number or a letter"], message: "Failed parsing query" });
      const limit = Math.min(50, Math.max(1, Number(qp.get("limit") ?? 5) || 5));
      const opts = {
        limit, autocomplete: qp.get("autocomplete") !== "0",
        lat: qp.has("lat") && qp.get("lat") !== "" ? Number(qp.get("lat")) : NaN,
        lon: qp.has("lon") && qp.get("lon") !== "" ? Number(qp.get("lon")) : NaN,
        type: qp.get("type") || undefined, postcode: qp.get("postcode") || undefined, citycode: qp.get("citycode") || undefined,
      };
      const features = search(q, opts);
      res.setHeader("X-Response-Time-Ms", String(Number(process.hrtime.bigint() - t) / 1e6));
      const filters = Object.fromEntries(["type", "postcode", "citycode"].filter((k) => opts[k]).map((k) => [k, opts[k]]));
      return send(200, { type: "FeatureCollection", version: "draft", features, ...ATTRIBUTION, query: q, ...(Object.keys(filters).length ? { filters } : {}), limit });
    }
    if (p === "/reverse") {
      const lat = Number(qp.get("lat")), lon = Number(qp.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        return send(400, { code: 400, message: "Failed parsing query", detail: ["lat/lon: invalid coordinates"] });
      const limit = Math.min(50, Math.max(1, Number(qp.get("limit") ?? 1) || 1));
      const features = reverse(lon, lat, { limit, type: qp.get("type") || undefined });
      return send(200, { type: "FeatureCollection", version: "draft", features, ...ATTRIBUTION, query: `${lon} ${lat}`, limit });
    }
    if (p === "/completion") {
      // Format Géoplateforme (data.geopf.fr/geocodage/completion)
      const text = (qp.get("text") ?? "").trim();
      if (text.length < 3) return send(400, { status: "Bad Request", error: "text must contain at least 3 chars" });
      const types = (qp.get("type") ?? "StreetAddress,PositionOfInterest").split(",");
      const max = Math.min(15, Math.max(1, Number(qp.get("maximumResponses") ?? 10) || 10));
      const feats = search(text, { limit: 40, autocomplete: true, lat: NaN, lon: NaN });
      const results = [];
      for (const f of feats) {
        const pr = f.properties, poi = pr.type === "poi";
        if (!types.includes(poi ? "PositionOfInterest" : "StreetAddress")) continue;
        const fulltext = pr.type === "municipality" ? `${pr.name}, ${pr.postcode}` : `${pr.name}, ${pr.postcode} ${pr.city}`;
        results.push({
          country: poi ? "PositionOfInterest" : "StreetAddress", city: pr.city, x: f.geometry.coordinates[0], y: f.geometry.coordinates[1],
          zipcode: pr.postcode, street: pr.street ?? "", kind: poi ? pr.category : pr.type, fulltext, metropole: true,
          classification: poi ? 1 : 7, ...(poi ? { names: [pr.name], poiType: [pr.category] } : {}),
        });
        if (results.length >= max) break;
      }
      return send(200, { status: "OK", results });
    }
    send(404, { code: 404, message: "Not found" });
  } catch (e) {
    console.error(e);
    send(500, { code: 500, message: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  const c = data.meta.count;
  console.log(`[geocoder] ${docs.length} documents (${c.street} voies, ${c.municipality} communes, ${c.locality} lieux-dits, ${c.poi} POI), ${nAddr} adresses, ${TOKENS.length} tokens — prêt en ${Date.now() - t0} ms sur http://localhost:${PORT}`);
});
