import { dateTimeFormat, estimatePrice, estimateRoute, zonedTimeToUtc, type PricingRule } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// API v1, site d'un client (Flotte Privée, § 11) : devis POST /api/v1/quotes et prix attendu (expected_price_cents) de
// POST /api/v1/rides. Vraies routes, vraie enveloppe handle()/authenticate(), vrais lib/api/trip.ts et
// lib/booking-price.ts (même calcul que le mini-site) ; Supabase service role, géocodeur et itinéraire simulés.

const PEPPER = "test-pepper-0123456789abcdef";
const ORG = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://www.chauffeur-prive.test";
const TZ = "Europe/Paris";

type Row = Record<string, any>;
type Call = { table: string; op: "select" | "insert" | "update"; payload: Row | null; filters: [string, unknown][] };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  keys: new Map<string, { row: Record<string, any>; hash: string }>(),
  rides: [] as Record<string, any>[],
  /** Grille active de l'organisation (une catégorie) ; null = aucune grille */
  rule: null as Record<string, any> | null,
  /** Adresse → point renvoyé par le géocodeur (absent : introuvable) */
  places: new Map<string, { lat: number; lng: number }>(),
  geocoded: [] as string[],
  routes: 0,
  anchor: { lat: 48.8566, lng: 2.3522 } as { lat: number; lng: number } | null,
  counts: new Map<string, number>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.test" },
  serverEnv: () => ({ apiKeyPepper: "test-pepper-0123456789abcdef" }),
}));
vi.mock("@/lib/rate-limit", () => {
  const check = (key: string, limit: number, windowSec: number) => {
    const n = (h.counts.get(key) ?? 0) + 1;
    h.counts.set(key, n);
    return { ok: n <= limit, remaining: Math.max(0, limit - n), resetAt: Date.now() + windowSec * 1000, limit };
  };
  return {
    rateLimit: async (key: string, limit: number, windowSec: number) => check(key, limit, windowSec),
    rateLimitAll: async (checks: { key: string; limit: number; windowSec: number }[]) => {
      let last = { ok: true, remaining: 0, resetAt: 0, limit: 0 };
      for (const c of checks) {
        last = check(c.key, c.limit, c.windowSec);
        if (!last.ok) return last;
      }
      return last;
    },
  };
});
vi.mock("@/lib/api-keys", async () => await import("./api-keys"));
vi.mock("@/lib/api/v1", async () => await import("./api/v1"));
vi.mock("@/lib/api/trip", async () => await import("./api/trip"));
vi.mock("@/lib/booking-price", async () => await import("./booking-price"));
vi.mock("@/lib/request", async () => await import("./request"));
vi.mock("@/lib/geo/cache", async () => await import("./geo/cache"));
// Zone desservie réelle (coordinateProblem), point d'activité de l'organisation simulé
vi.mock("@/lib/geo/anchor", async () => ({ ...(await import("./geo/anchor")), orgAnchor: async () => h.anchor }));
vi.mock("@/lib/geocode", () => ({
  geocodeOne: async (address: string) => {
    h.geocoded.push(address);
    const p = h.places.get(address);
    return p ? { ...p, label: address, address, kind: "address" } : null;
  },
}));
vi.mock("@/lib/geo/routing", async () => {
  const { estimateRoute: route } = await import("@rydar/shared");
  return {
    rideRouteColumns: async (from: { lat: number; lng: number }, to: { lat: number | null; lng: number | null }) => {
      h.routes += 1;
      if (to.lat == null || to.lng == null) return { estimated_distance_m: null, estimated_duration_s: null, route_polyline: null, route_provider: null };
      const r = route(from, { lat: to.lat, lng: to.lng });
      return { estimated_distance_m: r.distanceM, estimated_duration_s: r.durationS, route_polyline: "", route_provider: "estimate" };
    },
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Call = { table, op: "select", payload: null, filters: [] };
      const filter = (c: string) => q.filters.find(([f]) => f === c)?.[1];
      const result = (): { data: unknown; error: unknown } => {
        h.calls.push(q);
        if (table === "api_keys" && q.op === "select") {
          return { data: [...h.keys.values()].find((k) => k.row.prefix === filter("prefix"))?.row ?? null, error: null };
        }
        if (table === "api_key_secrets") {
          const k = [...h.keys.values()].find((x) => x.row.id === filter("api_key_id"));
          return { data: k ? { key_hash: k.hash } : null, error: null };
        }
        if (table === "pricing_rules") {
          const ok = h.rule && filter("organization_id") === ORG && filter("vehicle_category") === h.rule.vehicle_category && filter("is_active") === true;
          return { data: ok ? h.rule : null, error: null };
        }
        if (table === "rides" && q.op === "insert") {
          const p = q.payload!;
          if (p.idempotency_key && h.rides.some((r) => r.organization_id === p.organization_id && r.idempotency_key === p.idempotency_key)) {
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "rides_organization_id_idempotency_key_key"' } };
          }
          const ride = { id: `ride-${h.rides.length + 1}`, number: 1000 + h.rides.length, status: "OFFERED", currency: "EUR", driver: null, ...p };
          h.rides.push(ride);
          return { data: { id: ride.id }, error: null };
        }
        if (table === "rides") {
          const found = h.rides.filter((r) => q.filters.every(([c, v]) => r[c] === v));
          return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { code: "PGRST116", message: "0 rows" } };
        }
        return { data: null, error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((q.op = "insert"), (q.payload = p), b),
        update: (p: Row) => ((q.op = "update"), (q.payload = p), b),
        eq: (c: string, v: unknown) => (q.filters.push([c, v]), b),
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

const { generateApiKey, hashApiKey } = await import("./api-keys");
const { POST: quote } = await import("../app/api/v1/quotes/route");
const { POST: createRide } = await import("../app/api/v1/rides/route");

/** Clé en base (préfixe + hash) ; renvoie la clé en clair. */
function addKey(name: string, opts: { scopes?: string[]; origins?: string[] } = {}) {
  const k = generateApiKey("live");
  const id = `${name}-0000-4000-8000-000000000000`.slice(0, 36);
  h.keys.set(name, {
    hash: hashApiKey(k.key, PEPPER),
    row: {
      id,
      prefix: k.prefix,
      organization_id: ORG,
      scopes: opts.scopes ?? ["rides:create", "rides:quote"],
      rate_limit_per_minute: 1000,
      allowed_origins: opts.origins ?? [],
      expires_at: null,
      revoked_at: null,
      organization: { status: "active", timezone: TZ, currency: "EUR", plan_id: null, limits_override: {}, plan: null },
    },
  });
  return { key: k.key, id };
}

function post(path: string, body: unknown, init: { key: string; origin?: string; idem?: string; ip?: string }) {
  const headers = new Headers({ "x-forwarded-for": init.ip ?? "203.0.113.10", "content-type": "application/json", authorization: `Bearer ${init.key}` });
  if (init.origin) headers.set("origin", init.origin);
  if (init.idem) headers.set("idempotency-key", init.idem);
  return new Request(`https://app.test/api/v1${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const GARE_DE_LYON = { address: "Gare de Lyon, 75012 Paris", lat: 48.8443, lng: 2.3743 };
const OPERA = { address: "Opéra Garnier, 75009 Paris", lat: 48.8719, lng: 2.3316 };
const RULE: PricingRule = {
  vehicle_category: "standard", base_fare_cents: 800, per_km_cents: 180, per_minute_cents: 40, minimum_fare_cents: 2500,
  night_surcharge_percent: 20, night_start: "22:00", night_end: "06:00", fixed_fares: [],
};

/** Jour de demain dans le fuseau de l'organisation (AAAA-MM-JJ). */
const tomorrow = () => dateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86_400_000));

let phoneSeq = 0;
/** Réservation du site : même trajet que le devis, téléphone distinct à chaque appel. */
function booking(trip: Row, extra: Row = {}) {
  phoneSeq += 1;
  return { ...trip, customer: { name: "Claire Martin", phone: `+3361234${String(phoneSeq).padStart(4, "0")}` }, ...extra };
}

const inserts = () => h.calls.filter((c) => c.table === "rides" && c.op === "insert");

beforeEach(() => {
  h.calls = [];
  h.keys.clear();
  h.rides = [];
  h.rule = { ...RULE };
  h.places.clear();
  h.geocoded = [];
  h.routes = 0;
  h.anchor = { lat: 48.8566, lng: 2.3522 };
  h.counts.clear();
});

describe("POST /api/v1/quotes : le prix du devis est celui de la réservation", () => {
  it("compteur : devis (clé navigateur) puis réservation au prix attendu → même prix enregistré, aucune course pour le devis", async () => {
    const site = addKey("a1a1a1a1", { origins: [ORIGIN] });
    const trip = { pickup: GARE_DE_LYON, dropoff: OPERA, vehicle_category: "standard", passengers: 2 };
    const res = await quote(post("/quotes", trip, { key: site.key, origin: ORIGIN }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const { data } = await res.json();
    const r = estimateRoute(GARE_DE_LYON, OPERA);
    const expected = estimatePrice(RULE, r.distanceM, r.durationS, new Date(data.pickup_at), TZ);
    expect(data).toEqual({
      price_cents: expected, currency: "EUR", fixed_fare: false, estimated_distance_m: r.distanceM, estimated_duration_s: r.durationS,
      vehicle_category: "standard", pickup_at: data.pickup_at,
    });
    expect(Math.abs(new Date(data.pickup_at).getTime() - Date.now())).toBeLessThan(5_000);
    expect(inserts()).toHaveLength(0);

    const created = await createRide(post("/rides", booking(trip, { expected_price_cents: data.price_cents }), { key: site.key, origin: ORIGIN }));
    expect(created.status).toBe(201);
    expect((await created.json()).data.price_cents).toBe(expected);
    expect(inserts()).toHaveLength(1);
    expect(h.rides[0]).toMatchObject({ price_cents: expected, payment_method: "card", source: "api" });
  });

  it("forfait reconnu par les adresses : fixed_fare vrai, même sans coordonnées de destination", async () => {
    h.rule = { ...RULE, fixed_fares: [{ label: "Paris ↔ Orly", price_cents: 4_500 }] };
    const site = addKey("a2a2a2a2", { origins: [ORIGIN] });
    const trip = { pickup: GARE_DE_LYON, dropoff: { address: "Aéroport d'Orly, 94390 Orly" } };
    const { data } = await (await quote(post("/quotes", trip, { key: site.key, origin: ORIGIN }))).json();
    expect(data).toMatchObject({ price_cents: 4_500, fixed_fare: true, estimated_distance_m: null, estimated_duration_s: null });

    const created = await createRide(post("/rides", booking(trip, { expected_price_cents: 4_500 }), { key: site.key, origin: ORIGIN }));
    expect(created.status).toBe(201);
    expect(h.rides[0]).toMatchObject({ price_cents: 4_500, dropoff_lat: null, dropoff_lng: null });
  });

  it("heure de nuit saisie dans le fuseau de l'organisation (date + time) : devis et réservation au même prix majoré", async () => {
    const site = addKey("a3a3a3a3", { origins: [ORIGIN] });
    const day = tomorrow();
    const night = { pickup: GARE_DE_LYON, dropoff: OPERA, date: day, time: "23:30" };
    const { data } = await (await quote(post("/quotes", night, { key: site.key, origin: ORIGIN }))).json();
    const at = zonedTimeToUtc(day, "23:30", TZ);
    const r = estimateRoute(GARE_DE_LYON, OPERA);
    expect(data.pickup_at).toBe(at.toISOString());
    expect(data.price_cents).toBe(estimatePrice(RULE, r.distanceM, r.durationS, at, TZ));
    const { data: daytime } = await (await quote(post("/quotes", { ...night, time: "10:00" }, { key: site.key, origin: ORIGIN }))).json();
    expect(data.price_cents).toBeGreaterThan(daytime.price_cents);

    const created = await createRide(post("/rides", booking(night, { expected_price_cents: data.price_cents }), { key: site.key, origin: ORIGIN }));
    expect(created.status).toBe(201);
    expect(h.rides[0]).toMatchObject({ price_cents: data.price_cents, pickup_at: at.toISOString() });
  });

  it("destination géocodée loin des coordonnées reçues : aucun prix garanti (null), jamais un prix calculé sur un faux point", async () => {
    h.places.set(OPERA.address, { lat: 43.6584, lng: 7.2159 });
    const site = addKey("a4a4a4a4", { origins: [ORIGIN] });
    const { data } = await (await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA }, { key: site.key, origin: ORIGIN }))).json();
    expect(data.price_cents).toBeNull();
    expect(data.fixed_fare).toBe(false);
  });

  it("sans grille active pour la catégorie : prix null", async () => {
    const site = addKey("a5a5a5a5", { origins: [ORIGIN] });
    const { data } = await (await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA, vehicle_category: "van" }, { key: site.key, origin: ORIGIN }))).json();
    expect(data).toMatchObject({ price_cents: null, vehicle_category: "van" });
  });
});

describe("POST /api/v1/rides : expected_price_cents", () => {
  // Demain 10:00 (heure de l'organisation) : prix de jour quelle que soit l'heure d'exécution du test
  const day = tomorrow();
  const trip = { pickup: GARE_DE_LYON, dropoff: OPERA, date: day, time: "10:00" };
  const r = estimateRoute(GARE_DE_LYON, OPERA);
  const dayPrice = () => estimatePrice(RULE, r.distanceM, r.durationS, zonedTimeToUtc(day, "10:00", TZ), TZ);

  it("prix différent → 409 PRICE_CHANGED avec le nouveau prix, rien de créé ; le nouveau prix est ensuite accepté", async () => {
    const site = addKey("b1b1b1b1", { origins: [ORIGIN] });
    const res = await createRide(post("/rides", booking(trip, { expected_price_cents: dayPrice() - 100 }), { key: site.key, origin: ORIGIN }));
    expect(res.status).toBe(409);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const { error } = await res.json();
    expect(error.code).toBe("PRICE_CHANGED");
    expect(error.details).toEqual({ price_cents: dayPrice() });
    expect(inserts()).toHaveLength(0);

    const again = await createRide(post("/rides", booking(trip, { expected_price_cents: error.details.price_cents }), { key: site.key, origin: ORIGIN }));
    expect(again.status).toBe(201);
    expect(h.rides[0]!.price_cents).toBe(dayPrice());
  });

  it("grille désactivée depuis le devis → 409 avec price_cents null ; sans prix attendu : demande sans prix (inchangé)", async () => {
    const site = addKey("b2b2b2b2", { origins: [ORIGIN] });
    const { data } = await (await quote(post("/quotes", trip, { key: site.key, origin: ORIGIN }))).json();
    h.rule = null;
    const res = await createRide(post("/rides", booking(trip, { expected_price_cents: data.price_cents }), { key: site.key, origin: ORIGIN }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "PRICE_CHANGED", details: { price_cents: null } });
    expect(inserts()).toHaveLength(0);

    const request = await createRide(post("/rides", booking(trip), { key: site.key, origin: ORIGIN }));
    expect(request.status).toBe(201);
    expect(h.rides[0]!.price_cents).toBeNull();
  });

  it("absent : comportement inchangé (clé serveur : prix fourni gardé ; sinon grille au compteur, sans contrôle de la destination)", async () => {
    const server = addKey("b3b3b3b3", { scopes: ["rides:create"] });
    expect((await createRide(post("/rides", booking(trip, { price_cents: 9_900, payment_method: "cash" }), { key: server.key }))).status).toBe(201);
    expect(h.rides[0]).toMatchObject({ price_cents: 9_900, payment_method: "cash" });
    // Destination géocodée loin des coordonnées : le devis n'a pas de prix, la réservation sans prix attendu garde la grille
    h.places.set(OPERA.address, { lat: 43.6584, lng: 7.2159 });
    expect((await createRide(post("/rides", booking(trip), { key: server.key }))).status).toBe(201);
    expect(h.rides[1]!.price_cents).toBe(dayPrice());
    const browser = addKey("b4b4b4b4", { origins: [ORIGIN] });
    expect((await createRide(post("/rides", booking(trip, { price_cents: 100 }), { key: browser.key, origin: ORIGIN }))).status).toBe(201);
    expect(h.rides[2]).toMatchObject({ price_cents: dayPrice(), payment_method: "card" });
  });

  it("clé serveur : price_cents différent du prix attendu → 422, rien de créé ; identique → accepté", async () => {
    const server = addKey("b5b5b5b5", { scopes: ["rides:create"] });
    const res = await createRide(post("/rides", booking(trip, { price_cents: 5_000, expected_price_cents: dayPrice() }), { key: server.key }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "VALIDATION_ERROR", details: { expected_price_cents: [expect.any(String)] } });
    expect(inserts()).toHaveLength(0);
    const same = await createRide(post("/rides", booking(trip, { price_cents: dayPrice(), expected_price_cents: dayPrice() }), { key: server.key }));
    expect(same.status).toBe(201);
    expect(h.rides[0]!.price_cents).toBe(dayPrice());
  });

  it("renvoi (Idempotency-Key) après un changement de prix : la course créée est renvoyée, jamais PRICE_CHANGED", async () => {
    const site = addKey("b6b6b6b6", { origins: [ORIGIN] });
    const body = booking(trip, { expected_price_cents: dayPrice() });
    expect((await createRide(post("/rides", body, { key: site.key, origin: ORIGIN, idem: "visiteur-42" }))).status).toBe(201);
    h.rule = { ...RULE, per_km_cents: 400 };
    h.geocoded = [];
    const again = await createRide(post("/rides", body, { key: site.key, origin: ORIGIN, idem: "visiteur-42" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ data: { id: h.rides[0]!.id, number: h.rides[0]!.number, status: "OFFERED" }, idempotent_replay: true });
    expect(h.rides).toHaveLength(1);
    // Reconnu avant tout calcul : ni géocodage, ni itinéraire
    expect(h.geocoded).toEqual([]);
  });
});

describe("POST /api/v1/quotes : contrôles", () => {
  it("date passée ou au-delà de 400 jours → 422 (mêmes bornes que la base), avant tout géocodage", async () => {
    const site = addKey("c1c1c1c1", { origins: [ORIGIN] });
    const past = await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA, pickup_at: new Date(Date.now() - 3_600_000).toISOString() }, { key: site.key, origin: ORIGIN }));
    expect(past.status).toBe(422);
    expect((await past.json()).error.code).toBe("PICKUP_IN_PAST");
    const far = await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA, pickup_at: new Date(Date.now() + 401 * 86_400_000).toISOString() }, { key: site.key, origin: ORIGIN }));
    expect((await far.json()).error.code).toBe("PICKUP_TOO_FAR");
    expect(h.geocoded).toEqual([]);
    expect(h.routes).toBe(0);
  });

  it("champ d'organisation → 403 tracé ; champ inconnu → 422 ; départ introuvable → 422 PICKUP_NOT_GEOCODED ; point aberrant → 422", async () => {
    const site = addKey("c2c2c2c2", { origins: [ORIGIN] });
    const tenant = await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA, organization_id: ORG }, { key: site.key, origin: ORIGIN }));
    expect(tenant.status).toBe(403);
    expect((await tenant.json()).error.code).toBe("FORBIDDEN_TENANT_FIELD");
    expect(h.calls.find((c) => c.table === "audit_logs")?.payload).toMatchObject({ action: "security.tenant_field_rejected", metadata: { path: "/api/v1/quotes" } });

    const unknown = await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA, price_cents: 100 }, { key: site.key, origin: ORIGIN }));
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error.code).toBe("VALIDATION_ERROR");

    const lost = await quote(post("/quotes", { pickup: { address: "Rue inconnue" }, dropoff: OPERA }, { key: site.key, origin: ORIGIN }));
    expect(lost.status).toBe(422);
    expect((await lost.json()).error.code).toBe("PICKUP_NOT_GEOCODED");

    const swapped = await quote(post("/quotes", { pickup: { ...GARE_DE_LYON, lat: GARE_DE_LYON.lng, lng: GARE_DE_LYON.lat }, dropoff: OPERA }, { key: site.key, origin: ORIGIN }));
    expect(swapped.status).toBe(422);
    expect((await swapped.json()).error.code).toBe("INVALID_COORDINATES");
    expect(inserts()).toHaveLength(0);
  });

  it("départ sans coordonnées géocodé près de l'activité de l'organisation ; devis journalisé sans course", async () => {
    h.places.set("10 rue de Lyon, 75012 Paris", { lat: 48.8462, lng: 2.3712 });
    const server = addKey("c3c3c3c3", { scopes: ["rides:quote"] });
    const res = await quote(post("/quotes", { pickup: { address: "10 rue de Lyon, 75012 Paris" }, dropoff: OPERA }, { key: server.key }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await res.json()).data.price_cents).toBeGreaterThan(0);
    const log = h.calls.find((c) => c.table === "api_logs")?.payload;
    expect(log).toMatchObject({ organization_id: ORG, path: "/api/v1/quotes", status_code: 200, ride_id: null });
    expect(inserts()).toHaveLength(0);
  });

  it("clé sans la portée rides:quote → 403 INSUFFICIENT_SCOPE", async () => {
    const createOnly = addKey("c4c4c4c4", { scopes: ["rides:create"] });
    const res = await quote(post("/quotes", { pickup: GARE_DE_LYON, dropoff: OPERA }, { key: createOnly.key }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ code: "INSUFFICIENT_SCOPE", message: "Permission requise : rides:quote." });
  });
});
