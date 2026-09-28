import { beforeEach, describe, expect, it, vi } from "vitest";

// Budget quotidien global des fournisseurs géo payants et limites des routes anonymes /api/geocode
// (audit « public ») : vrais modules lib/geocode.ts, lib/geo/routing.ts et vraies routes, réseau simulé.

const h = vi.hoisted(() => ({
  urls: [] as string[],
  geocoder: "google",
  routing: "google",
  ip: "203.0.113.10",
  sub: null as string | null,
  counts: new Map<string, number>(),
  limits: [] as { key: string; limit: number; windowSec: number }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": h.ip }) }));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ geocoder: h.geocoder, googleMapsKey: "gk", mapboxToken: "", geocoderUrl: "", routing: h.routing, osrmUrl: "https://osrm.test" }),
}));
vi.mock("@/lib/rate-limit", () => {
  const check = (c: { key: string; limit: number; windowSec: number }) => {
    h.limits.push(c);
    const n = (h.counts.get(c.key) ?? 0) + 1;
    h.counts.set(c.key, n);
    return { ok: n <= c.limit, remaining: Math.max(0, c.limit - n), resetAt: Date.now() + c.windowSec * 1000, limit: c.limit };
  };
  return {
    rateLimit: async (key: string, limit: number, windowSec: number) => check({ key, limit, windowSec }),
    rateLimitAll: async (checks: { key: string; limit: number; windowSec: number }[]) => {
      let last = { ok: true, remaining: 0, resetAt: 0, limit: 0 };
      for (const c of checks) {
        last = check(c);
        if (!last.ok) return last;
      }
      return last;
    },
  };
});
vi.mock("@/lib/geo/cache", async () => {
  const real = await import("./cache");
  const { encodePolyline: enc } = await import("@rydar/shared");
  return {
    lruCache: real.lruCache,
    fetchJson: async (url: string) => {
      h.urls.push(url);
      if (url.includes("routes.googleapis.com")) return { routes: [{ distanceMeters: 5000, duration: "600s", polyline: { encodedPolyline: enc([[2.35, 48.85], [2.36, 48.86]]) } }] };
      if (url.includes("maps.googleapis.com")) return { results: [{ formatted_address: "1 Rue Google, 75001 Paris", geometry: { location: { lat: 48.86, lng: 2.34 } }, types: [] }] };
      return { features: [{ geometry: { coordinates: [2.34, 48.86] }, properties: { label: "1 Rue Publique 75001 Paris", type: "housenumber", score: 0.9 } }] };
    },
  };
});
vi.mock("@/lib/places", async () => await import("../places"));
vi.mock("@/lib/request", async () => await import("../request"));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: h.sub ? { claims: { sub: h.sub } } : null, error: null }) } }),
}));
vi.mock("@/lib/geocode", async () => await import("../geocode"));
vi.mock("@/lib/geo/budget", async () => await import("./budget"));

const { searchPlaces, reverseGeocode } = await import("../geocode");
const { computeRoute } = await import("./routing");
const { GET: geocodeRoute } = await import("../../app/api/geocode/route");
const { GET: reverseRoute } = await import("../../app/api/geocode/reverse/route");

beforeEach(() => {
  h.urls = [];
  h.counts.clear();
  h.limits = [];
  h.geocoder = "google";
  h.routing = "google";
  h.ip = "203.0.113.10";
  h.sub = null;
  process.env.GEO_DAILY_BUDGET = "2";
});

describe("budget quotidien global des fournisseurs payants", () => {
  it("géocodage Google : au-delà du budget, repli sur la Géoplateforme (gratuite)", async () => {
    await searchPlaces("rue un");
    await searchPlaces("rue deux");
    const third = await searchPlaces("rue trois");
    expect(h.urls.filter((u) => u.includes("maps.googleapis.com"))).toHaveLength(2);
    expect(h.urls.at(-1)).toContain("data.geopf.fr/geocodage/search");
    expect(third[0]?.address).toBe("1 Rue Publique 75001 Paris");
    // Même compteur pour l'adresse d'un point : Géoplateforme aussi
    await reverseGeocode(48.8, 2.3);
    expect(h.urls.at(-1)).toContain("data.geopf.fr/geocodage/reverse");
  });

  it("itinéraires Google : au-delà du budget, estimation à vol d'oiseau", async () => {
    const from = { lat: 48.85, lng: 2.35 };
    const a = await computeRoute(from, { lat: 48.86, lng: 2.36 });
    const b = await computeRoute(from, { lat: 48.87, lng: 2.37 });
    const c = await computeRoute(from, { lat: 48.88, lng: 2.38 });
    expect([a.provider, b.provider, c.provider]).toEqual(["google", "google", "estimate"]);
    expect(h.urls.filter((u) => u.includes("routes.googleapis.com"))).toHaveLength(2);
  });

  it("fournisseur gratuit (Géoplateforme) : aucun budget consommé", async () => {
    h.geocoder = "geopf";
    for (const q of ["rue a1", "rue a2", "rue a3"]) await searchPlaces(q);
    expect(h.urls.every((u) => u.includes("data.geopf.fr"))).toBe(true);
    expect(h.limits.some((l) => l.key.startsWith("geobudget:"))).toBe(false);
  });
});

describe("routes /api/geocode : limites par IP (/64) ou par utilisateur connecté", () => {
  it("anonyme : par IP groupée, à la minute et au jour", async () => {
    h.geocoder = "geopf";
    h.ip = "2001:db8:1:2::5";
    const res = await geocodeRoute(new Request("https://b.test/api/geocode?q=rue%20x"));
    expect(res.status).toBe(200);
    expect(h.limits.map((l) => [l.key, l.limit, l.windowSec])).toEqual([
      ["geocode:2001:0db8:0001:0002::/64", 60, 60],
      ["geocode:day:2001:0db8:0001:0002::/64", 1500, 86_400],
    ]);
  });

  it("anonyme : au-delà de la limite journalière, 429 sans appel fournisseur", async () => {
    h.counts.set("geocode:day:203.0.113.10", 1500);
    const res = await reverseRoute(new Request("https://b.test/api/geocode/reverse?lat=48.8&lng=2.3"));
    expect(res.status).toBe(429);
    expect(h.urls).toHaveLength(0);
  });

  it("dispatcher connecté : compté par utilisateur, pas par l'IP du bureau", async () => {
    h.geocoder = "geopf";
    h.sub = "55555555-5555-4555-8555-555555555555";
    h.counts.set("geocode:day:203.0.113.10", 1500);
    const res = await geocodeRoute(new Request("https://b.test/api/geocode?q=rue%20y"));
    expect(res.status).toBe(200);
    expect(h.limits.map((l) => l.key)).toEqual([`geocode:u:${h.sub}`, `geocode:day:u:${h.sub}`]);
  });
});
