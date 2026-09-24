import "server-only";
import { decodePolyline, encodePolyline, estimateRoute, haversine, simplifyLine, type Coord, type LatLng } from "@rydar/shared";
import { serverEnv } from "@/lib/env";
import { fetchJson, lruCache } from "@/lib/geo/cache";

// -----------------------------------------------------------------------------
// Itinéraires — fournisseurs interchangeables (ROUTING_PROVIDER) :
//   osrm   : OSRM (OSRM_URL — auto-hébergé recommandé en production)
//   mapbox : Directions API « driving-traffic » (MAPBOX_TOKEN)
//   google : Routes API v2, trafic en temps réel (GOOGLE_MAPS_API_KEY)
//   none   : estimation à vol d'oiseau uniquement
// Toute erreur / dépassement de délai → estimation (approximate: true) : la
// création de course n'est jamais bloquée par le routage.
// -----------------------------------------------------------------------------

export type Route = {
  distanceM: number;
  durationS: number;
  /** Tracé simplifié [lng, lat][] */
  coordinates: Coord[];
  /** Même tracé encodé (polyline précision 5) — stocké sur la course */
  polyline: string;
  provider: string;
  approximate: boolean;
};

export type Leg = { distanceM: number; durationS: number; approximate: boolean };

const routeCache = lruCache<Route>(1000, 15 * 60_000);
const key = (p: LatLng) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;

function finalize(coords: Coord[], distanceM: number, durationS: number, provider: string, approximate = false): Route {
  const simplified = simplifyLine(coords, 6);
  return {
    distanceM: Math.round(distanceM),
    durationS: Math.round(durationS),
    coordinates: simplified,
    polyline: encodePolyline(simplified),
    provider,
    approximate,
  };
}

function estimate(from: LatLng, to: LatLng): Route {
  const e = estimateRoute(from, to);
  return finalize([[from.lng, from.lat], [to.lng, to.lat]], e.distanceM, e.durationS, "estimate", true);
}

async function osrm(from: LatLng, to: LatLng, base: string, timeoutMs: number): Promise<Route> {
  const url = `${base.replace(/\/$/, "")}/route/v1/driving/${key(from)};${key(to)}?overview=full&geometries=polyline&steps=false`;
  const data = await fetchJson(url, { timeoutMs });
  const r = data?.routes?.[0];
  if (data?.code !== "Ok" || !r) throw new Error(`OSRM ${data?.code}`);
  return finalize(decodePolyline(r.geometry), r.distance, r.duration, "osrm");
}

async function mapbox(from: LatLng, to: LatLng, token: string, timeoutMs: number): Promise<Route> {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${key(from)};${key(to)}?geometries=polyline&overview=full&access_token=${token}`;
  const data = await fetchJson(url, { timeoutMs });
  const r = data?.routes?.[0];
  if (!r) throw new Error("Mapbox: aucun itinéraire");
  return finalize(decodePolyline(r.geometry), r.distance, r.duration, "mapbox");
}

async function google(from: LatLng, to: LatLng, apiKey: string, timeoutMs: number): Promise<Route> {
  const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const data = await fetchJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    timeoutMs,
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({ origin: wp(from), destination: wp(to), travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", languageCode: "fr-FR" }),
  });
  const r = data?.routes?.[0];
  if (!r) throw new Error("Google: aucun itinéraire");
  return finalize(decodePolyline(r.polyline.encodedPolyline), r.distanceMeters, Number.parseInt(String(r.duration), 10), "google");
}

/** Itinéraire routier entre deux points (avec cache et repli). */
export async function computeRoute(from: LatLng, to: LatLng, opts: { timeoutMs?: number } = {}): Promise<Route> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  if (haversine(from, to) < 30) return estimate(from, to);
  const k = `${key(from)}>${key(to)}`;
  const cached = routeCache.get(k);
  if (cached) return cached;
  const env = serverEnv();
  try {
    let route: Route;
    if (env.routing === "mapbox" && env.mapboxToken) route = await mapbox(from, to, env.mapboxToken, timeoutMs);
    else if (env.routing === "google" && env.googleMapsKey) route = await google(from, to, env.googleMapsKey, timeoutMs);
    else if (env.routing === "none") return estimate(from, to);
    else route = await osrm(from, to, env.osrmUrl, timeoutMs);
    routeCache.set(k, route);
    return route;
  } catch (error) {
    console.warn("[routing] repli estimation :", (error as Error).message);
    return estimate(from, to);
  }
}

/**
 * Temps d'approche de plusieurs chauffeurs vers un point (matrice N×1).
 * OSRM /table si disponible, sinon estimation par chauffeur.
 */
export async function approachTimes(sources: LatLng[], to: LatLng, opts: { timeoutMs?: number } = {}): Promise<Leg[]> {
  if (!sources.length) return [];
  const fallback = () => sources.map((s) => ({ ...estimateRoute(s, to), approximate: true }));
  const env = serverEnv();
  try {
    if (env.routing === "osrm") {
      const coords = [...sources, to].map(key).join(";");
      const dest = sources.length;
      const url = `${env.osrmUrl.replace(/\/$/, "")}/table/v1/driving/${coords}?sources=${sources.map((_, i) => i).join(";")}&destinations=${dest}&annotations=duration,distance`;
      const data = await fetchJson(url, { timeoutMs: opts.timeoutMs ?? 2500 });
      if (data?.code !== "Ok") throw new Error(`OSRM table ${data?.code}`);
      return sources.map((s, i) => {
        const d = data.durations?.[i]?.[0];
        const m = data.distances?.[i]?.[0];
        return typeof d === "number" ? { durationS: Math.round(d), distanceM: Math.round(m ?? haversine(s, to) * 1.3), approximate: false } : { ...estimateRoute(s, to), approximate: true };
      });
    }
    if (env.routing === "mapbox" && env.mapboxToken && sources.length <= 24) {
      const coords = [...sources, to].map(key).join(";");
      const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic/${coords}?sources=${sources.map((_, i) => i).join(";")}&destinations=${sources.length}&annotations=duration,distance&access_token=${env.mapboxToken}`;
      const data = await fetchJson(url, { timeoutMs: opts.timeoutMs ?? 2500 });
      return sources.map((s, i) => ({ durationS: Math.round(data.durations[i][0]), distanceM: Math.round(data.distances[i][0]), approximate: false }));
    }
  } catch (error) {
    console.warn("[routing] matrice : repli estimation :", (error as Error).message);
  }
  return fallback();
}

/** Colonnes d'itinéraire à enregistrer sur une course (null si pas de destination géolocalisée). */
export async function rideRouteColumns(pickup: LatLng, dropoff: { lat?: number | null; lng?: number | null } | null) {
  if (!dropoff || dropoff.lat == null || dropoff.lng == null) {
    return { estimated_distance_m: null, estimated_duration_s: null, route_polyline: null, route_provider: null };
  }
  const r = await computeRoute(pickup, { lat: dropoff.lat, lng: dropoff.lng }, { timeoutMs: 2500 });
  return { estimated_distance_m: r.distanceM, estimated_duration_s: r.durationS, route_polyline: r.polyline, route_provider: r.provider };
}
