import { beforeEach, describe, expect, it, vi } from "vitest";

// API publique v1 (audit « public ») : centrale sans offre, limitation par IP avant authentification,
// journal des requêtes refusées, clés « navigateur ». Vraie enveloppe handle()/authenticate() et vraie
// route POST /api/v1/rides, avec un Supabase service role simulé.

const PEPPER = "test-pepper-0123456789abcdef";
const ORG = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, any>;
type Call = { table: string; op: "select" | "insert" | "update"; payload?: Row; filters: [string, unknown][] };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  keyRow: null as Row | null,
  keyHash: null as string | null,
  counts: new Map<string, number>(),
  limits: [] as { key: string; limit: number; windowSec: number }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.test" },
  serverEnv: () => ({ apiKeyPepper: "test-pepper-0123456789abcdef" }),
}));
vi.mock("@/lib/rate-limit", () => {
  const check = (key: string, limit: number, windowSec: number) => {
    h.limits.push({ key, limit, windowSec });
    const n = (h.counts.get(key) ?? 0) + 1;
    h.counts.set(key, n);
    return { ok: n <= limit, remaining: Math.max(0, limit - n), resetAt: Date.now() + windowSec * 1000, limit };
  };
  return { rateLimit: async (k: string, l: number, w: number) => check(k, l, w) };
});
vi.mock("@/lib/api-keys", async () => await import("../api-keys"));
vi.mock("@/lib/api/v1", async () => await import("./v1"));
vi.mock("@/lib/request", async () => await import("../request"));
vi.mock("@/lib/geocode", () => ({ geocodeOne: async () => null }));
vi.mock("@/lib/geo/anchor", () => ({ orgAnchor: async () => null, coordinateProblem: () => null }));
vi.mock("@/lib/geo/routing", () => ({
  rideRouteColumns: async () => ({ estimated_distance_m: 12_000, estimated_duration_s: 1_200, route_polyline: null, route_provider: "estimate" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const result = () => {
        if (call.op === "select") h.calls.push(call);
        if (table === "api_keys" && call.op === "select") return { data: h.keyRow, error: null };
        if (table === "api_key_secrets") return { data: h.keyHash ? { key_hash: h.keyHash } : null, error: null };
        if (table === "rides" && call.op === "insert") return { data: { id: "33333333-3333-4333-8333-333333333333" }, error: null };
        if (table === "rides") {
          const inserted = h.calls.find((c) => c.table === "rides" && c.op === "insert")?.payload ?? {};
          return { data: { id: "33333333-3333-4333-8333-333333333333", number: 1, status: "SEARCHING_DRIVER", ...inserted }, error: null };
        }
        return { data: null, error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((call.op = "insert"), (call.payload = p), h.calls.push(call), b),
        update: (p: Row) => ((call.op = "update"), (call.payload = p), h.calls.push(call), b),
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
      };
      return b;
    },
  }),
}));

const { generateApiKey, hashApiKey } = await import("../api-keys");
const { GET: ping } = await import("../../app/api/v1/ping/route");
const { POST: createRide } = await import("../../app/api/v1/rides/route");

let apiKey = "";
function setKey(opts: { planId?: string | null; planLimits?: Row; override?: Row; scopes?: string[]; origins?: string[]; revoked?: boolean } = {}) {
  const k = generateApiKey("live");
  apiKey = k.key;
  h.keyHash = hashApiKey(k.key, PEPPER);
  h.keyRow = {
    id: KEY_ID,
    organization_id: ORG,
    scopes: opts.scopes ?? ["rides:create", "rides:read"],
    rate_limit_per_minute: 60,
    allowed_origins: opts.origins ?? [],
    expires_at: null,
    revoked_at: opts.revoked ? new Date().toISOString() : null,
    organization: {
      status: "active",
      timezone: "Europe/Paris",
      plan_id: opts.planId === undefined ? "44444444-4444-4444-8444-444444444444" : opts.planId,
      limits_override: opts.override ?? {},
      plan: opts.planId === null ? null : { limits: opts.planLimits ?? { api_access: true } },
    },
  };
}

function req(path: string, init: { method?: string; key?: string | null; ip?: string; origin?: string; body?: unknown } = {}) {
  const headers = new Headers({ "x-forwarded-for": init.ip ?? "203.0.113.10", "content-type": "application/json" });
  const key = init.key === undefined ? apiKey : init.key;
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (init.origin) headers.set("origin", init.origin);
  return new Request(`https://app.test/api/v1${path}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}

const logs = () => h.calls.filter((c) => c.table === "api_logs" && c.op === "insert").map((c) => c.payload!);
const keyTouches = () => h.calls.filter((c) => c.table === "api_keys" && c.op === "update");

beforeEach(() => {
  h.calls = [];
  h.counts.clear();
  h.limits = [];
  setKey();
});

describe("centrale sans offre (plan_id null) : même règle que private.org_limits", () => {
  it("API autorisée sans offre", async () => {
    setKey({ planId: null });
    const res = await ping(req("/ping"));
    expect(res.status).toBe(200);
  });

  it("sans offre + surcharge api_access=false → 403", async () => {
    setKey({ planId: null, override: { api_access: false } });
    const res = await ping(req("/ping"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PLAN_FEATURE_API");
  });

  it("offre sans API → 403, offre avec API → 200", async () => {
    setKey({ planLimits: { api_access: false } });
    expect((await ping(req("/ping"))).status).toBe(403);
    setKey({ planLimits: { api_access: true } });
    expect((await ping(req("/ping"))).status).toBe(200);
  });
});

describe("requêtes anonymes : limitées par IP, journal borné", () => {
  it("au-delà de 20 échecs par minute et par IP : 429 sans ligne api_logs", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) statuses.push((await ping(req("/ping", { key: null }))).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    expect(logs()).toHaveLength(20);
    expect(logs().every((l) => l.organization_id === null)).toBe(true);
  });

  it("échecs limités par IP groupée en /64 ; sans clé bien formée, aucune requête SQL ; une clé valide n'est pas concernée", async () => {
    h.counts.set("api:fail:2001:0db8:0000:0001::/64", 20);
    const res = await ping(req("/ping", { key: null, ip: "2001:db8:0:1::abcd" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(h.calls.filter((c) => c.table === "api_keys" || c.table === "api_logs")).toHaveLength(0);
    // Autre /64 : non concerné
    expect((await ping(req("/ping", { key: null, ip: "2001:db8:0:2::abcd" }))).status).toBe(401);
    // Clé valide depuis le /64 en échec : seulement la limite de la clé (contre-audit web_public#5)
    expect((await ping(req("/ping", { ip: "2001:db8:0:1::beef" }))).status).toBe(200);
  });
});

describe("journal : les refus d'une clé identifiée sont rattachés à la centrale", () => {
  it("429 de la clé : organisation et clé renseignées, dernière utilisation inchangée", async () => {
    h.counts.set(`api:${KEY_ID}`, 60);
    const res = await ping(req("/ping"));
    expect(res.status).toBe(429);
    expect(logs()).toEqual([expect.objectContaining({ organization_id: ORG, api_key_id: KEY_ID, status_code: 429, error_code: "RATE_LIMITED" })]);
    expect(keyTouches()).toHaveLength(0);
  });

  it("clé révoquée : 401 journalisé pour la centrale, last_used_at non mis à jour", async () => {
    setKey({ revoked: true });
    const res = await ping(req("/ping"));
    expect(res.status).toBe(401);
    expect(logs()[0]).toMatchObject({ organization_id: ORG, api_key_id: KEY_ID, error_code: "API_KEY_REVOKED" });
    expect(keyTouches()).toHaveLength(0);
  });

  it("requête acceptée : dernière utilisation mise à jour", async () => {
    expect((await ping(req("/ping"))).status).toBe(200);
    expect(keyTouches()).toHaveLength(1);
  });
});

describe("clé « navigateur » (origines autorisées)", () => {
  const origin = "https://www.centrale-b.test";
  const body = {
    pickup: { address: "Gare de Lyon, 75012 Paris", lat: 48.8443, lng: 2.3743 },
    dropoff: { address: "Aéroport de Nice", lat: 43.6584, lng: 7.2159 },
    customer: { name: "Jean Client", phone: "+33612345678" },
    vehicle_category: "standard",
    price_cents: 0,
    payment_method: "cash",
  };

  it("jamais de lecture des courses, même si la clé porte rides:read", async () => {
    setKey({ origins: [origin], scopes: ["rides:create", "rides:read"] });
    const res = await ping(req("/ping", { origin }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("INSUFFICIENT_SCOPE");
    expect(logs()[0]).toMatchObject({ organization_id: ORG, status_code: 403 });
  });

  it("origine absente ou non listée → 403", async () => {
    setKey({ origins: [origin], scopes: ["rides:create"] });
    const none = await createRide(req("/rides", { method: "POST", body }));
    expect(none.status).toBe(403);
    expect((await none.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    const evil = await createRide(req("/rides", { method: "POST", body, origin: "https://evil.test" }));
    expect(evil.status).toBe(403);
    expect(h.calls.some((c) => c.table === "rides" && c.op === "insert")).toBe(false);
  });

  it("origine listée : course créée, prix et paiement de la requête ignorés", async () => {
    setKey({ origins: [origin], scopes: ["rides:create"] });
    const res = await createRide(req("/rides", { method: "POST", body, origin }));
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    const insert = h.calls.find((c) => c.table === "rides" && c.op === "insert")!.payload!;
    expect(insert.price_cents).toBeNull();
    expect(insert.payment_method).toBe("card");
  });

  it("clé serveur : prix et paiement fournis conservés", async () => {
    setKey({ scopes: ["rides:create"] });
    const res = await createRide(req("/rides", { method: "POST", body }));
    expect(res.status).toBe(201);
    const insert = h.calls.find((c) => c.table === "rides" && c.op === "insert")!.payload!;
    expect(insert.price_cents).toBe(0);
    expect(insert.payment_method).toBe("cash");
  });
});
