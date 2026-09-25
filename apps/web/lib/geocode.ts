import "server-only";
import { serverEnv } from "@/lib/env";
import { lruCache, fetchJson } from "@/lib/geo/cache";
import { exactFavorite, matchFavorites, type Place } from "@/lib/places";

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
  const score = typeof p.score === "number" ? p.score : undefined;
  return { label: type === "poi" && name ? name : label, address: label, lat, lng, kind, score, postcode, precision: type || undefined };
}

async function ban(q: string, near: Near, base: string, autocomplete = true): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: "7", autocomplete: autocomplete ? "1" : "0" });
  if (near) params.set("lat", String(near.lat)), params.set("lon", String(near.lng));
  const data = await fetchJson(`${base.replace(/\/$/, "")}/search/?${params}`);
  return ((data?.features ?? []) as any[]).map(fromBanFeature).filter((p): p is Place => !!p);
}

async function geopf(q: string, near: Near, base: string, autocomplete = true): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: "7", autocomplete: autocomplete ? "1" : "0", index: "address,poi" });
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
    kind: (r.types?.includes("airport") ? "airport" : r.types?.includes("train_station") ? "station" : r.types?.includes("locality") ? "city" : "address") as Place["kind"],
    score: r.partial_match ? 0.4 : undefined,
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
    kind: (f.properties.poi_category?.includes?.("airport") ? "airport" : ["place", "locality", "region"].includes(f.properties.feature_type) ? "city" : "address") as Place["kind"],
    score: { exact: 1, high: 0.9, medium: 0.6, low: 0.3 }[f.properties.match_code?.confidence as string],
  }));
}

const searchCache = lruCache<Place[]>(800, 30 * 60_000);

/** Fournisseur configuré (repli BAN publique en cas d'erreur). */
async function remoteSearch(query: string, near: Near, autocomplete: boolean): Promise<Place[]> {
  const env = serverEnv();
  try {
    if (env.geocoder === "google" && env.googleMapsKey) return await google(query, env.googleMapsKey);
    if (env.geocoder === "mapbox" && env.mapboxToken) return await mapbox(query, near, env.mapboxToken);
    if (env.geocoder === "ban") return await ban(query, near, env.geocoderUrl || "https://api-adresse.data.gouv.fr", autocomplete);
    return await geopf(query, near, env.geocoderUrl || "https://data.geopf.fr/geocodage", autocomplete);
  } catch {
    return ban(query, near, "https://api-adresse.data.gouv.fr", autocomplete).catch(() => []);
  }
}

/** Autocomplétion : lieux favoris proches (instantané) + fournisseur configuré (avec repli BAN). */
export async function searchPlaces(q: string, near?: Near): Promise<Place[]> {
  const query = q.trim().replace(/\s+/g, " ").slice(0, 120);
  if (query.length < 2) return [];
  const key = `${query.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const favorites = matchFavorites(query, 4, near);
  const remote = await remoteSearch(query, near, true);
  const seen = new Set(favorites.map((f) => f.address.toLowerCase()));
  const results = [...favorites, ...remote.filter((r) => !seen.has(r.address.toLowerCase()))].slice(0, 8);
  if (remote.length) searchCache.set(key, results);
  return results;
}

const MIN_SCORE = 0.5;
const POSTCODE = /\b(\d{5})\b/;
const HOUSENUMBER = /(^|,\s*)\d{1,4}\s?(bis|ter|[a-d])?\s+\D/i;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const STOP = new Set(["les", "des", "une", "sur", "aux", "rue", "avenue", "place", "boulevard"]);

/** Lieu nommé (hôtel, restaurant…) : tous ses mots significatifs doivent figurer dans la saisie
 *  (« Paris, France » ne doit pas devenir l'hôtel « Paris France Hotel », ni « Sur place » la Concorde). */
function poiMatchesInput(p: Place, input: string): boolean {
  const words = new Set(fold(input).split(/[^a-z0-9]+/));
  return fold(p.label)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .every((w) => words.has(w));
}

/** Résultat assez sûr pour placer une course sans validation humaine. */
function confident(p: Place | undefined, input: string, precise: boolean, minScore = MIN_SCORE): p is Place {
  if (!p) return false;
  if (p.score != null && p.score < minScore) return false;
  if (precise && p.kind === "city") return false;
  if (p.kind === "poi" && !poiMatchesInput(p, input)) return false;
  // « 25 avenue X » : un résultat au niveau de la rue placerait le client au milieu de l'avenue
  if (precise && p.precision === "street" && HOUSENUMBER.test(input)) return false;
  const wanted = POSTCODE.exec(input)?.[1];
  if (wanted && p.postcode && p.postcode !== wanted) return false;
  return true;
}

/**
 * Géocodage « meilleur résultat » pour l'API publique et les saisies non choisies dans la liste.
 * Pas de favoris devant les résultats réels, pas d'autocomplétion, seuil de confiance,
 * et second essai sans le nom du lieu (« Hôtel X, 25 avenue … » → « 25 avenue … »).
 * Renvoie null si l'adresse est introuvable ou ambiguë : l'appelant répond 422.
 */
export async function geocodeOne(address: string, near?: Near, opts: { precise?: boolean; minScore?: number } = {}): Promise<Place | null> {
  const input = address.trim().replace(/\s+/g, " ").slice(0, 250);
  if (input.length < 3) return null;
  const precise = opts.precise ?? true;
  const attempts = [input];
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && !/\d/.test(parts[0]!)) attempts.push(parts.slice(1).join(", "));
  for (const q of attempts) {
    const best = (await remoteSearch(q, near, false))[0];
    if (confident(best, input, precise, opts.minScore)) return best;
  }
  return exactFavorite(input);
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
