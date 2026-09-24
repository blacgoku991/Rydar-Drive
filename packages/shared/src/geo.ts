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
