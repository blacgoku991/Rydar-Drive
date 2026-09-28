import { beforeEach, describe, expect, it, vi } from "vitest";

// Contre-audit « web_api » : API publique v1 — rejeu Idempotency-Key limité à la clé qui a créé la course
// (réponse minimale pour une clé « navigateur »), journal des échecs d'une clé identifiée borné par clé, limite
// par IP réservée aux requêtes non authentifiées ou en échec (une clé valide n'a que sa propre limite).
// Vraie enveloppe handle()/authenticate() et vraie route POST /api/v1/rides, Supabase service role simulé
// (table rides en mémoire avec la contrainte unique (organization_id, idempotency_key)).

const PEPPER = "test-pepper-0123456789abcdef";
const ORG = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, any>;
type Call = { table: string; op: "select" | "insert" | "update"; payload?: Row; filters: [string, unknown][] };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  keys: new Map<string, { row: Row; hash: string }>(),
  rides: [] as Row[],
  counts: new Map<string, number>(),
  /** Consommateur du budget géo passé au calcul d'itinéraire */
  geoConsumers: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.test" },
  serverEnv: () => ({ apiKeyPepper: "test-pepper-0123456789abcdef" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string, limit: number, windowSec: number) => {
    const n = (h.counts.get(key) ?? 0) + 1;
    h.counts.set(key, n);
    return { ok: n <= limit, remaining: Math.max(0, limit - n), resetAt: Date.now() + windowSec * 1000, limit };
  },
}));
vi.mock("@/lib/api-keys", async () => await import("../api-keys"));
vi.mock("@/lib/api/v1", async () => await import("./v1"));
vi.mock("@/lib/request", async () => await import("../request"));
vi.mock("@/lib/geocode", () => ({ geocodeOne: async () => null }));
vi.mock("@/lib/geo/anchor", () => ({ orgAnchor: async () => null, coordinateProblem: () => null }));
vi.mock("@/lib/geo/routing", () => ({
  rideRouteColumns: async (_from: unknown, _to: unknown, consumer: unknown) => {
    h.geoConsumers.push(consumer);
    return { estimated_distance_m: 12_000, estimated_duration_s: 1_200, route_polyline: null, route_provider: "estimate" };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const match = (r: Row) => call.filters.every(([c, v]) => r[c] === v);
      const result = (): { data: unknown; error: unknown } => {
        if (call.op === "select") h.calls.push(call);
        if (table === "api_keys" && call.op === "select") {
          const prefix = call.filters.find(([c]) => c === "prefix")?.[1];
          return { data: [...h.keys.values()].find((k) => k.row.prefix === prefix)?.row ?? null, error: null };
        }
        if (table === "api_key_secrets") {
          const id = call.filters.find(([c]) => c === "api_key_id")?.[1];
          const k = [...h.keys.values()].find((x) => x.row.id === id);
          return { data: k ? { key_hash: k.hash } : null, error: null };
        }
        if (table === "rides" && call.op === "insert") {
          const p = call.payload!;
          if (p.idempotency_key && h.rides.some((r) => r.organization_id === p.organization_id && r.idempotency_key === p.idempotency_key)) {
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "rides_organization_id_idempotency_key_key"' } };
          }
          const ride = { id: `ride-${h.rides.length + 1}`, number: 1000 + h.rides.length, status: "SEARCHING_DRIVER", driver: null, ...p };
          h.rides.push(ride);
          return { data: { id: ride.id }, error: null };
        }
        if (table === "rides") {
          const found = h.rides.filter(match);
          return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { code: "PGRST116", message: "0 rows" } };
        }
        return { data: null, error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((call.op = "insert"), (call.payload = p), h.calls.push(call), b),
        update: (p: Row) => ((call.op = "update"), (call.payload = p), h.calls.push(call), b),
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        maybeSingle: async () => {
          const r = result();
          return (r.error as any)?.code === "PGRST116" ? { data: null, error: null } : r;
        },
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

const ORIGIN = "https://www.centrale.test";

/** Clé en base (préfixe + hash) ; renvoie la clé en clair. */
function addKey(name: string, opts: { scopes?: string[]; origins?: string[]; limit?: number; revoked?: boolean } = {}) {
  const k = generateApiKey("live");
  const id = `${name}-0000-4000-8000-000000000000`.slice(0, 36);
  h.keys.set(name, {
    hash: hashApiKey(k.key, PEPPER),
    row: {
      id,
      prefix: k.prefix,
      organization_id: ORG,
      scopes: opts.scopes ?? ["rides:create", "rides:read"],
      rate_limit_per_minute: opts.limit ?? 60,
      allowed_origins: opts.origins ?? [],
      expires_at: null,
      revoked_at: opts.revoked ? new Date().toISOString() : null,
      organization: { status: "active", timezone: "Europe/Paris", plan_id: null, limits_override: {}, plan: null },
    },
  });
  return { key: k.key, id };
}

function req(path: string, init: { method?: string; key?: string | null; ip?: string; origin?: string; body?: unknown; idem?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": init.ip ?? "203.0.113.10", "content-type": "application/json" });
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.origin) headers.set("origin", init.origin);
  if (init.idem) headers.set("idempotency-key", init.idem);
  return new Request(`https://app.test/api/v1${path}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}

const body = {
  pickup: { address: "Gare de Lyon, 75012 Paris", lat: 48.8443, lng: 2.3743 },
  dropoff: { address: "Aéroport de Nice", lat: 43.6584, lng: 7.2159 },
  customer: { name: "Jean Client", phone: "+33612345678" },
  vehicle_category: "standard",
};

const logs = () => h.calls.filter((c) => c.table === "api_logs" && c.op === "insert").map((c) => c.payload!);

beforeEach(() => {
  h.calls = [];
  h.keys.clear();
  h.rides = [];
  h.counts.clear();
  h.geoConsumers = [];
});

describe("budget géo payant (web_public#3) : consommateur transmis au calcul d'itinéraire", () => {
  it("clé serveur : part de la centrale ; clé « navigateur » : part du visiteur (IP /64) et du site", async () => {
    const server = addKey("a0a0a0a0", { scopes: ["rides:create"] });
    const browser = addKey("b0b0b0b0", { scopes: ["rides:create"], origins: [ORIGIN] });
    expect((await createRide(req("/rides", { method: "POST", key: server.key, body }))).status).toBe(201);
    expect((await createRide(req("/rides", { method: "POST", key: browser.key, origin: ORIGIN, body, ip: "2001:db8:9:9::42" }))).status).toBe(201);
    expect(h.geoConsumers).toEqual([
      { kind: "org", org: ORG },
      { kind: "visitor", ip: "2001:0db8:0009:0009::/64", org: ORG },
    ]);
  });
});

describe("Idempotency-Key : le rejeu ne renvoie que la course créée par la même clé", () => {
  /** Course existante créée par l'intégration SERVEUR de la centrale, avec un chauffeur attribué. */
  function serverRide(serverKeyId: string) {
    h.rides.push({
      id: "ride-srv", number: 42, status: "ACCEPTED", organization_id: ORG, api_key_id: serverKeyId, idempotency_key: "resa-2026-0412-8842",
      pickup_address: "12 rue Secrète, 75008 Paris", dropoff_address: "Villa privée, Saint-Tropez", customer_name: "VIP",
      driver: { first_name: "Karim", vehicle: { brand: "Mercedes", model: "Classe E", color: "Noir", plate: "AB-123-CD" } },
    });
  }

  it("clé « navigateur » : la clé d'une course d'une autre clé → 409, aucune donnée de la course", async () => {
    const server = addKey("aaaaaaaa", { scopes: ["rides:create", "rides:read"] });
    const browser = addKey("bbbbbbbb", { scopes: ["rides:create"], origins: [ORIGIN] });
    serverRide(server.id);
    const res = await createRide(req("/rides", { method: "POST", key: browser.key, origin: ORIGIN, idem: "resa-2026-0412-8842", body }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(JSON.stringify(json)).not.toMatch(/Secrète|Karim|AB-123-CD|Saint-Tropez/);
    expect(h.rides).toHaveLength(1);
  });

  it("clé serveur sans rides:read : pas de lecture détournée d'une course d'une autre clé", async () => {
    const other = addKey("cccccccc", { scopes: ["rides:create", "rides:read"] });
    const createOnly = addKey("dddddddd", { scopes: ["rides:create"] });
    serverRide(other.id);
    const res = await createRide(req("/rides", { method: "POST", key: createOnly.key, idem: "resa-2026-0412-8842", body }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(/Karim|AB-123-CD/);
  });

  it("même clé serveur : rejeu 200 avec la course complète (comportement documenté inchangé)", async () => {
    const server = addKey("eeeeeeee", { scopes: ["rides:create", "rides:read"] });
    const first = await createRide(req("/rides", { method: "POST", key: server.key, idem: "k-1", body }));
    expect(first.status).toBe(201);
    const again = await createRide(req("/rides", { method: "POST", key: server.key, idem: "k-1", body }));
    const json = await again.json();
    expect(again.status).toBe(200);
    expect(json.idempotent_replay).toBe(true);
    expect(json.data.pickup.address).toBe("Gare de Lyon, 75012 Paris");
    expect(h.rides).toHaveLength(1);
  });

  it("même clé « navigateur » : rejeu 200 réduit à { id, number, status }", async () => {
    const browser = addKey("ffffffff", { scopes: ["rides:create"], origins: [ORIGIN] });
    const first = await createRide(req("/rides", { method: "POST", key: browser.key, origin: ORIGIN, idem: "visiteur-1", body }));
    expect(first.status).toBe(201);
    // Entre-temps, un chauffeur a été attribué : le rejeu (tout visiteur du site peut le tenter) n'en dit rien
    Object.assign(h.rides[0]!, { status: "ACCEPTED", driver: { first_name: "Karim", vehicle: { brand: "Mercedes", model: "Classe E", color: "Noir", plate: "AB-123-CD" } } });
    const again = await createRide(req("/rides", { method: "POST", key: browser.key, origin: ORIGIN, idem: "visiteur-1", body }));
    const json = await again.json();
    expect(again.status).toBe(200);
    expect(json).toEqual({ data: { id: h.rides[0]!.id, number: h.rides[0]!.number, status: "ACCEPTED" }, idempotent_replay: true });
  });
});

describe("journal api_logs : échecs d'une clé identifiée bornés par clé", () => {
  it("clé « navigateur » sans Origin en boucle : réponse inchangée, journal borné", async () => {
    const browser = addKey("abababab", { scopes: ["rides:create"], origins: [ORIGIN] });
    const statuses = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      const res = await createRide(req("/rides", { method: "POST", key: browser.key, body, ip: `203.0.113.${i}` }));
      statuses.add(res.status);
      expect((await res.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    }
    expect([...statuses]).toEqual([403]);
    expect(logs().length).toBeGreaterThan(0);
    expect(logs().length).toBeLessThanOrEqual(30);
    expect(logs().every((l) => l.organization_id === ORG && l.error_code === "ORIGIN_NOT_ALLOWED")).toBe(true);
  });

  it("clé révoquée en boucle : 401 à chaque fois, journal borné", async () => {
    const revoked = addKey("cdcdcdcd", { revoked: true });
    for (let i = 0; i < 100; i += 1) expect((await ping(req("/ping", { key: revoked.key }))).status).toBe(401);
    expect(logs().length).toBeGreaterThan(0);
    expect(logs().length).toBeLessThanOrEqual(30);
  });
});

describe("limite par IP : seulement pour les requêtes non authentifiées ou en échec", () => {
  it("clé valide réglée à 1 000/min depuis une seule IP : jamais plafonnée à 600", async () => {
    const bulk = addKey("efefefef", { limit: 1000 });
    const statuses: number[] = [];
    for (let i = 0; i < 700; i += 1) statuses.push((await ping(req("/ping", { key: bulk.key }))).status);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    // Au-delà de SA limite : 429 de la clé (journalisé pour la centrale)
    h.counts.set(`api:${bulk.id}`, 1000);
    const over = await ping(req("/ping", { key: bulk.key }));
    expect(over.status).toBe(429);
    expect((await over.json()).error.message).toBe("Trop de requêtes pour cette clé.");
  });

  it("plusieurs centrales derrière un même intégrateur (même IP) : chaque clé garde sa limite", async () => {
    const a = addKey("a1a1a1a1", { limit: 500 });
    const b = addKey("b2b2b2b2", { limit: 500 });
    let refused = 0;
    for (let i = 0; i < 400; i += 1) {
      if ((await ping(req("/ping", { key: a.key }))).status !== 200) refused += 1;
      if ((await ping(req("/ping", { key: b.key }))).status !== 200) refused += 1;
    }
    expect(refused).toBe(0);
  });

  it("requêtes sans clé ou clé inconnue : toujours limitées par IP (429 sans journal au-delà)", async () => {
    const unknown = generateApiKey("live").key;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) statuses.push((await ping(req("/ping", { key: i % 2 ? unknown : null, ip: "2001:db8:5:6::1" }))).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    expect(logs()).toHaveLength(20);
    // Une clé valide depuis la même IP n'est pas concernée
    const ok = addKey("c3c3c3c3");
    expect((await ping(req("/ping", { key: ok.key, ip: "2001:db8:5:6::2" }))).status).toBe(200);
  });
});
