// Géométrie légère (sans dépendance) : distances, estimations, emprises.

export type LatLng = { lat: number; lng: number };

const R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Distance orthodromique en mètres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Estimation route à partir de la distance à vol d'oiseau (facteur de détour
 * urbain ~1,35 ; vitesse moyenne 28 km/h en ville, 55 km/h au-delà de 15 km).
 * Utilisée quand aucun fournisseur d'itinéraire n'est configuré.
 */
export function estimateRoute(a: LatLng, b: LatLng): { distanceM: number; durationS: number } {
  const crow = haversine(a, b);
  const distanceM = Math.round(crow * 1.35);
  const km = distanceM / 1000;
  const speedKmh = km < 15 ? 28 : km < 40 ? 45 : 60;
  return { distanceM, durationS: Math.round((km / speedKmh) * 3600) + 180 };
}

export function bounds(points: LatLng[]): [[number, number], [number, number]] | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!valid.length) return null;
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of valid) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

/** Cercle (polygone GeoJSON) de rayon r mètres — pour visualiser les vagues de dispatch. */
export function circlePolygon(center: LatLng, radiusM: number, steps = 96): [number, number][] {
  const coords: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(toRad(center.lat)));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push([center.lng + dLng * Math.cos(t), center.lat + dLat * Math.sin(t)]);
  }
  return coords;
}

/** Cap (0–360°) de a vers b. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ---------------------------------------------------------------------------
// Itinéraires : polyline encodée (format Google / OSRM), simplification, parcours
// Coordonnées au format GeoJSON [lng, lat].
// ---------------------------------------------------------------------------
export type Coord = [number, number];

/** Encode une ligne [lng, lat][] en polyline (précision 5 par défaut, comme OSRM/Google). */
export function encodePolyline(coords: Coord[], precision = 5): string {
  const f = 10 ** precision;
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * f);
    const iLng = Math.round(lng * f);
    out += enc(iLat - pLat) + enc(iLng - pLng);
    pLat = iLat;
    pLng = iLng;
  }
  return out;
}

/** Décode une polyline en [lng, lat][]. */
export function decodePolyline(str: string, precision = 5): Coord[] {
  const f = 10 ** precision;
  const coords: Coord[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i <= str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    coords.push([lng / f, lat / f]);
  }
  return coords;
}

const toLatLng = ([lng, lat]: Coord): LatLng => ({ lat, lng });

/** Longueur d'une ligne (m). */
export function lineLength(coords: Coord[]): number {
  let d = 0;
  for (let k = 1; k < coords.length; k++) d += haversine(toLatLng(coords[k - 1]!), toLatLng(coords[k]!));
  return d;
}

/** Simplification Douglas-Peucker (tolérance en mètres) — allège les tracés stockés. */
export function simplifyLine(coords: Coord[], toleranceM = 8): Coord[] {
  if (coords.length <= 2) return coords;
  const kx = 111_320 * Math.cos(toRad(coords[0]![1]));
  const ky = 110_540;
  const xy = coords.map(([lng, lat]) => [lng * kx, lat * ky] as const);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = xy[a]!;
    const [bx, by] = xy[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let max = -1;
    let idx = -1;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = xy[k]!;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 > max) {
        max = d2;
        idx = k;
      }
    }
    if (max > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, k) => keep[k]);
}

/** Point situé à `distanceM` du début de la ligne (+ cap), pour animer un trajet. */
export function pointAlong(coords: Coord[], distanceM: number): { point: Coord; heading: number; done: boolean } {
  if (coords.length === 0) return { point: [0, 0], heading: 0, done: true };
  let rest = Math.max(0, distanceM);
  for (let k = 1; k < coords.length; k++) {
    const a = coords[k - 1]!;
    const b = coords[k]!;
    const seg = haversine(toLatLng(a), toLatLng(b));
    if (rest <= seg && seg > 0) {
      const t = rest / seg;
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(toLatLng(a), toLatLng(b)), done: false };
    }
    rest -= seg;
  }
  const last = coords[coords.length - 1]!;
  const prev = coords[coords.length - 2] ?? last;
  return { point: last, heading: bearing(toLatLng(prev), toLatLng(last)), done: true };
}
