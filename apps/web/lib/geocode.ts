import "server-only";
import { serverEnv } from "@/lib/env";
import { lruCache, fetchJson } from "@/lib/geo/cache";
import { matchFavorites, type Place } from "@/lib/places";

// -----------------------------------------------------------------------------
// Géocodage — fournisseurs interchangeables (variable GEOCODER_PROVIDER) :
//   geopf  : Géoplateforme IGN (défaut, gratuit, France) — format BAN
//   ban    : API Adresse (BAN) ou tout service compatible (GEOCODER_URL)
//   google : Geocoding API (GOOGLE_MAPS_API_KEY)
//   mapbox : Search Box / Geocoding v6 (MAPBOX_TOKEN)
// Repli automatique sur la BAN si le fournisseur principal échoue.
// -----------------------------------------------------------------------------

type Near = { lat: number; lng: number } | undefined;

const first = <T,>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);

const POI_KIND: Record<string, Place["kind"]> = {
  airport: "airport",
  aerodrome: "airport",
  aéroport: "airport",
  station: "station",
  train_station: "station",
  gare: "station",
};

/** Feature au format BAN (api-adresse / geopf search) → Place. */
function fromBanFeature(f: any): Place | null {
  const [lng, lat] = f?.geometry?.coordinates ?? [];
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const p = f.properties ?? {};
  const type: string = p._type === "poi" ? "poi" : (p.type ?? "");
  const postcode = first<string>(p.postcode);
  const city = first<string>(p.city);
  const name = first<string>(p.name) ?? p.toponym;
  const label: string = p.label ?? [name, postcode, city].filter(Boolean).join(" ");
  const categories = ([] as unknown[]).concat(p.category ?? []).filter((c): c is string => typeof c === "string");
  let kind: Place["kind"] = "address";
  if (type === "municipality" || type === "locality") kind = "city";
  if (type === "poi") kind = categories.map((c) => POI_KIND[c.toLowerCase()]).find(Boolean) ?? "poi";
  return { label: type === "poi" && name ? name : label, address: label, lat, lng, kind };
}

async function ban(q: string, near: Near, base: string): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: "7", autocomplete: "1" });
  if (near) params.set("lat", String(near.lat)), params.set("lon", String(near.lng));
  const data = await fetchJson(`${base.replace(/\/$/, "")}/search/?${params}`);
  return ((data?.features ?? []) as any[]).map(fromBanFeature).filter((p): p is Place => !!p);
}

async function geopf(q: string, near: Near, base: string): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: "7", autocomplete: "1", index: "address,poi" });
  if (near) params.set("lat", String(near.lat)), params.set("lon", String(near.lng));
  const data = await fetchJson(`${base.replace(/\/$/, "")}/search?${params}`);
  return ((data?.features ?? []) as any[]).map(fromBanFeature).filter((p): p is Place => !!p);
}

async function google(q: string, key: string): Promise<Place[]> {
  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&language=fr&region=fr&key=${key}`,
  );
  return ((data?.results ?? []) as any[]).slice(0, 7).map((r) => ({
    label: r.formatted_address,
    address: r.formatted_address,
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    kind: (r.types?.includes("airport") ? "airport" : r.types?.includes("train_station") ? "station" : "address") as Place["kind"],
  }));
}

async function mapbox(q: string, near: Near, token: string): Promise<Place[]> {
  const prox = near ? `&proximity=${near.lng},${near.lat}` : "";
  const data = await fetchJson(
    `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&language=fr&limit=7&autocomplete=true${prox}&access_token=${token}`,
  );
  return ((data?.features ?? []) as any[]).map((f) => ({
    label: f.properties.full_address ?? f.properties.name,
    address: f.properties.full_address ?? f.properties.name,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    kind: (f.properties.poi_category?.includes?.("airport") ? "airport" : "address") as Place["kind"],
  }));
}

const searchCache = lruCache<Place[]>(800, 30 * 60_000);

/** Autocomplétion : lieux favoris (instantané) + fournisseur configuré (avec repli BAN). */
export async function searchPlaces(q: string, near?: Near): Promise<Place[]> {
  const query = q.trim().replace(/\s+/g, " ").slice(0, 120);
  if (query.length < 2) return [];
  const key = `${query.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const favorites = matchFavorites(query);
  const env = serverEnv();
  let remote: Place[] = [];
  try {
    if (env.geocoder === "google" && env.googleMapsKey) remote = await google(query, env.googleMapsKey);
    else if (env.geocoder === "mapbox" && env.mapboxToken) remote = await mapbox(query, near, env.mapboxToken);
    else if (env.geocoder === "ban") remote = await ban(query, near, env.geocoderUrl || "https://api-adresse.data.gouv.fr");
    else remote = await geopf(query, near, env.geocoderUrl || "https://data.geopf.fr/geocodage");
  } catch {
    remote = await ban(query, near, "https://api-adresse.data.gouv.fr").catch(() => []);
  }
  const seen = new Set(favorites.map((f) => f.address.toLowerCase()));
  const results = [...favorites, ...remote.filter((r) => !seen.has(r.address.toLowerCase()))].slice(0, 8);
  if (remote.length) searchCache.set(key, results);
  return results;
}

/** Géocodage « meilleur résultat » (API publique quand lat/lng absents). */
export async function geocodeOne(address: string, near?: Near): Promise<Place | null> {
  const results = await searchPlaces(address, near);
  return results[0] ?? null;
}

const reverseCache = lruCache<Place | null>(500, 60 * 60_000);

/** Adresse la plus proche d'un point (clic sur la carte, position GPS). */
export async function reverseGeocode(lat: number, lng: number): Promise<Place | null> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = reverseCache.get(key);
  if (cached !== undefined) return cached;
  const env = serverEnv();
  let place: Place | null = null;
  try {
    if (env.geocoder === "google" && env.googleMapsKey) {
      const data = await fetchJson(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=fr&key=${env.googleMapsKey}`);
      const r = data?.results?.[0];
      if (r) place = { label: r.formatted_address, address: r.formatted_address, lat, lng, kind: "address" };
    } else if (env.geocoder === "mapbox" && env.mapboxToken) {
      const data = await fetchJson(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&language=fr&limit=1&access_token=${env.mapboxToken}`);
      const f = data?.features?.[0];
      if (f) place = { label: f.properties.full_address, address: f.properties.full_address, lat, lng, kind: "address" };
    } else {
      const base = (env.geocoderUrl || (env.geocoder === "ban" ? "https://api-adresse.data.gouv.fr" : "https://data.geopf.fr/geocodage")).replace(/\/$/, "");
      const path = env.geocoder === "ban" ? "/reverse/" : "/reverse";
      const data = await fetchJson(`${base}${path}?lat=${lat}&lon=${lng}&limit=1`);
      const f = data?.features?.[0];
      place = f ? fromBanFeature(f) : null;
    }
  } catch {
    place = null;
  }
  reverseCache.set(key, place);
  return place;
}
