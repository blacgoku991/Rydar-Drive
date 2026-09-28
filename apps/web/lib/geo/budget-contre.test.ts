import { beforeEach, describe, expect, it, vi } from "vitest";

// Contre-audit « web_api » (web_public#3) : budget quotidien des fournisseurs géo payants — sous-plafonds par IP (/64),
// par mini-site, pour l'ensemble des anonymes, par centrale et par utilisateur, pour qu'un seul consommateur ne fasse
// pas passer toutes les centrales en estimation à vol d'oiseau ; repli OSRM de l'exploitant s'il est configuré.
// Vraies routes /api/book/[slug]/quote, /api/route, /api/geocode et vrais modules lib/geo, réseau et Redis simulés.

const h = vi.hoisted(() => ({
  urls: [] as string[],
  routing: "google",
  geocoder: "google",
  osrmUrl: "https://router.project-osrm.org",
  ip: "203.0.113.10",
  sub: null as string | null,
  org: "org-a",
  counts: new Map<string, number>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": h.ip }) }));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ geocoder: h.geocoder, googleMapsKey: "gk", mapboxToken: "", geocoderUrl: "", routing: h.routing, osrmUrl: h.osrmUrl }),
}));
vi.mock("@/lib/rate-limit", () => {
  const check = (c: { key: string; limit: number; windowSec: number }) => {
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
      if (url.includes("/route/v1/driving/")) return { code: "Ok", routes: [{ distance: 5100, duration: 610, geometry: enc([[2.35, 48.85], [2.36, 48.86]]) }] };
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
vi.mock("@/lib/geo/routing", async () => await import("./routing"));
vi.mock("@/lib/geo/anchor", () => ({ orgAnchor: async () => null, coordinateProblem: () => null }));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => ({ org: { id: h.org }, user: { id: `user-${h.org}` } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: "org-site", status: "active", timezone: "Europe/Paris", booking: { enabled: true, show_price_estimate: false, vehicle_categories: ["standard"] } },
          error: null,
        }),
      };
      return q;
    },
  }),
}));

const { POST: bookQuote } = await import("../../app/api/book/[slug]/quote/route");
const { POST: dashboardRoute } = await import("../../app/api/route/route");
const { GET: geocodeRoute } = await import("../../app/api/geocode/route");

let n = 0;
/** Point de destination distinct à chaque appel (pas de cache d'itinéraire). */
const next = () => ({ lat: 48.9 + (n += 1) * 0.001, lng: 2.4 });
const from = { lat: 48.85, lng: 2.35 };

async function quote(ip: string) {
  h.ip = ip;
  const res = await bookQuote(
    new Request("https://b.test/api/book/centrale/quote", {
      method: "POST",
      body: JSON.stringify({ pickup: { ...from, address: "Départ" }, dropoff: { ...next(), address: "Arrivée" }, category: "standard" }),
    }),
    { params: Promise.resolve({ slug: "centrale" }) },
  );
  return (await res.json()) as { approximate: boolean };
}

async function dashboard(org: string) {
  h.org = org;
  const res = await dashboardRoute(new Request("https://app.test/api/route", { method: "POST", body: JSON.stringify({ from, to: next() }) }));
  return (await res.json()) as { approximate: boolean };
}

const googleCalls = () => h.urls.filter((u) => u.includes("routes.googleapis.com")).length;

beforeEach(() => {
  h.urls = [];
  h.counts.clear();
  h.routing = "google";
  h.geocoder = "google";
  h.osrmUrl = "https://router.project-osrm.org";
  h.sub = null;
  process.env.GEO_DAILY_BUDGET = "100"; // parts : 2 par IP, 10 par mini-site, 30 anonymes, 30 par centrale
});

describe("itinéraires payants : un seul consommateur n'épuise pas le budget de tous", () => {
  it("devis anonymes depuis 40 préfixes /64 : chacun sa part, les anonymes 30 % au plus ; les centrales gardent l'itinéraire réel", async () => {
    for (let p = 0; p < 40; p += 1) {
      for (let i = 0; i < 25; i += 1) await quote(`2001:db8:${p.toString(16)}:1::${i + 1}`);
    }
    expect(googleCalls()).toBeLessThanOrEqual(30);
    expect((await dashboard("org-b")).approximate).toBe(false);
    expect((await dashboard("org-c")).approximate).toBe(false);
  });

  it("une IP /64 : 2 % du budget, puis estimation (le devis reste servi)", async () => {
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await quote(`2001:db8:77:1::${i + 1}`));
    expect(results.map((r) => r.approximate)).toEqual([false, false, true, true, true, true]);
    // Autre visiteur : sa propre part
    expect((await quote("198.51.100.7")).approximate).toBe(false);
  });

  it("une centrale (tableau de bord) : 30 % du budget, les autres centrales ne sont pas touchées", async () => {
    const a = [];
    for (let i = 0; i < 60; i += 1) a.push((await dashboard("org-a")).approximate);
    expect(a.filter((x) => !x)).toHaveLength(30);
    expect(a.slice(30).every(Boolean)).toBe(true);
    expect((await dashboard("org-b")).approximate).toBe(false);
  });

  it("budget global (100 %) toujours appliqué en dernier ressort", async () => {
    for (const org of ["o1", "o2", "o3", "o4"]) for (let i = 0; i < 30; i += 1) await dashboard(org);
    expect(googleCalls()).toBe(100);
  });
});

describe("repli propre au-delà du budget", () => {
  it("OSRM de l'exploitant configuré : itinéraire routier OSRM (pas une estimation)", async () => {
    h.osrmUrl = "http://osrm:5000";
    for (let i = 0; i < 30; i += 1) await dashboard("org-a");
    const res = await dashboard("org-a");
    expect(res.approximate).toBe(false);
    expect(h.urls.at(-1)).toMatch(/^http:\/\/osrm:5000\/route\/v1\/driving\//);
  });

  it("serveur public de démonstration OSRM : jamais utilisé en repli, estimation", async () => {
    for (let i = 0; i < 30; i += 1) await dashboard("org-a");
    const before = h.urls.length;
    expect((await dashboard("org-a")).approximate).toBe(true);
    expect(h.urls.length).toBe(before);
  });
});

describe("adresses (Google) : parts par IP et par utilisateur, repli Géoplateforme", () => {
  it("visiteur anonyme : 2 % puis Géoplateforme ; un utilisateur connecté garde Google", async () => {
    h.ip = "203.0.113.99";
    for (let i = 0; i < 4; i += 1) await geocodeRoute(new Request(`https://b.test/api/geocode?q=rue%20anonyme%20${i}`));
    const google = h.urls.filter((u) => u.includes("maps.googleapis.com")).length;
    expect(google).toBe(2);
    expect(h.urls.at(-1)).toContain("data.geopf.fr");
    h.sub = "55555555-5555-4555-8555-555555555555";
    await geocodeRoute(new Request("https://b.test/api/geocode?q=rue%20connectee"));
    expect(h.urls.at(-1)).toContain("maps.googleapis.com");
  });
});
