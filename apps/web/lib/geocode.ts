import "server-only";
import { serverEnv } from "@/lib/env";
import { matchFavorites, type Place } from "@/lib/places";

const TIMEOUT = 3500;

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  return res.json();
}

async function geopf(q: string): Promise<Place[]> {
  // Géoplateforme IGN (gratuit, France) — autocomplétion adresses + POI
  const url = `https://data.geopf.fr/geocodage/completion/?text=${encodeURIComponent(q)}&type=StreetAddress,PositionOfInterest&maximumResponses=6`;
  const data = await fetchJson(url);
  return ((data?.results ?? []) as any[])
    .filter((r) => typeof r.x === "number" && typeof r.y === "number")
    .map((r) => ({
      label: r.fulltext as string,
      address: r.fulltext as string,
      lat: r.y as number,
      lng: r.x as number,
      kind: (r.kind === "PositionOfInterest" || r.poiType ? "poi" : "address") as Place["kind"],
    }));
}

async function ban(q: string): Promise<Place[]> {
  const data = await fetchJson(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`);
  return ((data?.features ?? []) as any[]).map((f) => ({
    label: f.properties.label,
    address: f.properties.label,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    kind: (f.properties.type === "municipality" ? "city" : "address") as Place["kind"],
  }));
}

async function google(q: string, key: string): Promise<Place[]> {
  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&language=fr&region=fr&key=${key}`,
  );
  return ((data?.results ?? []) as any[]).slice(0, 6).map((r) => ({
    label: r.formatted_address,
    address: r.formatted_address,
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    kind: (r.types?.includes("airport") ? "airport" : r.types?.includes("train_station") ? "station" : "address") as Place["kind"],
  }));
}

async function mapbox(q: string, token: string): Promise<Place[]> {
  const data = await fetchJson(
    `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&language=fr&limit=6&autocomplete=true&access_token=${token}`,
  );
  return ((data?.features ?? []) as any[]).map((f) => ({
    label: f.properties.full_address ?? f.properties.name,
    address: f.properties.full_address ?? f.properties.name,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    kind: "address" as const,
  }));
}

/** Autocomplétion : lieux favoris (instantané) + fournisseur configuré (avec repli). */
export async function searchPlaces(q: string): Promise<Place[]> {
  const query = q.trim().slice(0, 120);
  if (query.length < 2) return [];
  const favorites = matchFavorites(query);
  const env = serverEnv();
  let remote: Place[] = [];
  try {
    if (env.geocoder === "google" && env.googleMapsKey) remote = await google(query, env.googleMapsKey);
    else if (env.geocoder === "mapbox" && env.mapboxToken) remote = await mapbox(query, env.mapboxToken);
    else remote = await geopf(query);
  } catch {
    remote = await ban(query).catch(() => []);
  }
  const seen = new Set(favorites.map((f) => f.address));
  return [...favorites, ...remote.filter((r) => !seen.has(r.address))].slice(0, 8);
}

/** Géocodage « meilleur résultat » (API publique quand lat/lng absents). */
export async function geocodeOne(address: string): Promise<Place | null> {
  const results = await searchPlaces(address);
  return results[0] ?? null;
}
