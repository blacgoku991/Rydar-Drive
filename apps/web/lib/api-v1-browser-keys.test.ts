import { API_SCOPES, BROWSER_KEY_SCOPES, apiKeyCreateSchema } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// API v1, clé « navigateur » d'un site (Flotte Privée, § 11) : portée contrôlée par BROWSER_KEY_SCOPES, limites par IP
// (création 6 / 10 min et 20 / jour, devis 30 / min et 600 / jour), par téléphone (3 / h) et par organisation (60
// réservations / h, comme le mini-site), débit de la clé compté à part pour les devis et pour les réservations, 429 +
// Retry-After lisible par le site (CORS) ; clés serveur inchangées. Vraie enveloppe handle()/authenticate() et vraies
// routes ; limiteur à fenêtres fixes simulé (elapse = temps écoulé), Supabase service role simulé.

const PEPPER = "test-pepper-0123456789abcdef";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "99999999-9999-4999-8999-999999999999";
const ORIGIN = "https://www.chauffeur-prive.test";

type Row = Record<string, any>;
type Check = { key: string; limit: number; windowSec: number };

const h = vi.hoisted(() => ({
  keys: new Map<string, { row: Record<string, any>; hash: string }>(),
  rides: [] as Record<string, any>[],
  logs: [] as Record<string, any>[],
  counts: new Map<string, number>(),
  /** Durée de la fenêtre de chaque compteur (s) */
  windows: new Map<string, number>(),
  checks: [] as { key: string; limit: number; windowSec: number }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.test" },
  serverEnv: () => ({ apiKeyPepper: "test-pepper-0123456789abcdef" }),
}));
vi.mock("@/lib/rate-limit", () => {
  const check = (c: Check) => {
    h.checks.push(c);
    h.windows.set(c.key, c.windowSec);
    const n = (h.counts.get(c.key) ?? 0) + 1;
    h.counts.set(c.key, n);
    return { ok: n <= c.limit, remaining: Math.max(0, c.limit - n), resetAt: Date.now() + c.windowSec * 1000, limit: c.limit };
  };
  return {
    rateLimit: async (key: string, limit: number, windowSec: number) => check({ key, limit, windowSec }),
    rateLimitAll: async (checks: Check[]) => {
      let last = { ok: true, remaining: 0, resetAt: 0, limit: 0 };
      for (const c of checks) {
        last = check(c);
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
vi.mock("@/lib/geocode", () => ({ geocodeOne: async () => null }));
vi.mock("@/lib/geo/anchor", () => ({ orgAnchor: async () => null, coordinateProblem: () => null }));
vi.mock("@/lib/geo/routing", () => ({
  rideRouteColumns: async () => ({ estimated_distance_m: 4_200, estimated_duration_s: 900, route_polyline: null, route_provider: "estimate" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      let op = "select";
      let payload: Row | null = null;
      const filters: [string, unknown][] = [];
      const filter = (c: string) => filters.find(([f]) => f === c)?.[1];
      const result = (): { data: unknown; error: unknown } => {
        if (table === "api_keys" && op === "select") {
          return { data: [...h.keys.values()].find((k) => k.row.prefix === filter("prefix"))?.row ?? null, error: null };
        }
        if (table === "api_key_secrets") {
          const k = [...h.keys.values()].find((x) => x.row.id === filter("api_key_id"));
          return { data: k ? { key_hash: k.hash } : null, error: null };
        }
        if (table === "api_logs" && op === "insert") h.logs.push(payload!);
        if (table === "rides" && op === "insert") {
          const ride = { id: `ride-${h.rides.length + 1}`, number: 1000 + h.rides.length, status: "OFFERED", driver: null, ...payload };
          h.rides.push(ride);
          return { data: { id: ride.id }, error: null };
        }
        if (table === "rides") return { data: h.rides.find((r) => r.id === filter("id")) ?? null, error: null };
        return { data: null, error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((op = "insert"), (payload = p), b),
        update: (p: Row) => ((op = "update"), (payload = p), b),
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
      };
      return b;
    },
  }),
}));

const { generateApiKey, hashApiKey } = await import("./api-keys");
const { SITE_KEY_RATE } = await import("../components/admin/private-fleet-state");
const { authenticate, BROWSER_IP_LIMITS, BROWSER_ORG_CREATE_LIMIT, BROWSER_PHONE_LIMIT, BROWSER_RATE_BUCKETS } = await import("./api/v1");
const { GET: ping } = await import("../app/api/v1/ping/route");
const { POST: quote } = await import("../app/api/v1/quotes/route");
const { POST: createRide } = await import("../app/api/v1/rides/route");

/** Clé en base (préfixe + hash) ; renvoie la clé en clair et son identifiant. */
function addKey(name: string, opts: { org?: string; scopes?: string[]; origins?: string[]; limit?: number } = {}) {
  const k = generateApiKey("live");
  const id = `${name}-0000-4000-8000-000000000000`.slice(0, 36);
  h.keys.set(name, {
    hash: hashApiKey(k.key, PEPPER),
    row: {
      id,
      prefix: k.prefix,
      organization_id: opts.org ?? ORG_A,
      scopes: opts.scopes ?? [...BROWSER_KEY_SCOPES],
      rate_limit_per_minute: opts.limit ?? 10_000,
      allowed_origins: opts.origins ?? [ORIGIN],
      expires_at: null,
      revoked_at: null,
      organization: { status: "active", timezone: "Europe/Paris", currency: "EUR", plan_id: null, limits_override: {}, plan: null },
    },
  });
  return { key: k.key, id };
}

function request(path: string, init: { key: string; method?: string; ip?: string; origin?: string | null; body?: unknown }) {
  const headers = new Headers({ "x-forwarded-for": init.ip ?? "203.0.113.10", "content-type": "application/json", authorization: `Bearer ${init.key}` });
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.set("origin", origin);
  return new Request(`https://app.test/api/v1${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const TRIP = {
  pickup: { address: "Gare de Lyon, 75012 Paris", lat: 48.8443, lng: 2.3743 },
  dropoff: { address: "Opéra Garnier, 75009 Paris", lat: 48.8719, lng: 2.3316 },
};
let phoneSeq = 0;
const nextPhone = () => `+3361234${String((phoneSeq += 1)).padStart(4, "0")}`;
const booking = (phone = nextPhone()) => ({ ...TRIP, customer: { name: "Claire Martin", phone } });

const book = (key: string, opts: { ip?: string; phone?: string; origin?: string | null } = {}) =>
  createRide(request("/rides", { key, ip: opts.ip, origin: opts.origin, body: booking(opts.phone) }));
const ask = (key: string, ip?: string) => quote(request("/quotes", { key, ip, body: TRIP }));

/** Temps écoulé : les compteurs dont la fenêtre dure au plus `sec` secondes repartent de zéro. */
function elapse(sec: number) {
  for (const [key, w] of h.windows) if (w <= sec) h.counts.delete(key);
}

/** Envoie n requêtes et renvoie leurs statuts. */
async function statuses(n: number, send: (i: number) => Promise<Response>) {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push((await send(i)).status);
  return out;
}

beforeEach(() => {
  h.keys.clear();
  h.rides = [];
  h.logs = [];
  h.counts.clear();
  h.windows.clear();
  h.checks = [];
});

describe("portée d'une clé « navigateur » : BROWSER_KEY_SCOPES", () => {
  it("chaque portée de l'API : permise à une clé navigateur si et seulement si BROWSER_KEY_SCOPES la contient", async () => {
    const browser = addKey("a0a0a0a0", { scopes: [...API_SCOPES] });
    const server = addKey("b0b0b0b0", { scopes: [...API_SCOPES], origins: [] });
    // Même refus qu'à la création de la clé (apiKeyCreateSchema)
    const parsed = apiKeyCreateSchema.safeParse({ name: "Site", scopes: ["rides:read"], allowedOrigins: [ORIGIN] });
    const message = parsed.success ? "" : parsed.error.issues[0]!.message;
    expect(message).toContain("navigateur");
    for (const scope of API_SCOPES) {
      const allowed = (BROWSER_KEY_SCOPES as readonly string[]).includes(scope);
      const run = authenticate(request("/ping", { key: browser.key }), scope);
      if (allowed) await expect(run).resolves.toMatchObject({ browser: true, allowedOrigin: ORIGIN });
      else await expect(run).rejects.toMatchObject({ status: 403, code: "INSUFFICIENT_SCOPE", message });
      await expect(authenticate(request("/ping", { key: server.key, origin: null }), scope)).resolves.toMatchObject({ browser: false, allowedOrigin: null });
    }
    expect(BROWSER_KEY_SCOPES).toEqual(["rides:create", "rides:quote"]);
  });

  it("routes : devis 200 et réservation 201 avec CORS ; lecture refusée sans CORS ; clé sans rides:quote (ancienne) → devis 403", async () => {
    const site = addKey("a1a1a1a1", { scopes: ["rides:create", "rides:quote", "rides:read"] });
    const q = await ask(site.key);
    expect(q.status).toBe(200);
    expect(q.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const r = await book(site.key);
    expect(r.status).toBe(201);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const read = await ping(request("/ping", { key: site.key, method: "GET" }));
    expect(read.status).toBe(403);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    const old = addKey("a2a2a2a2", { scopes: ["rides:create"] });
    const refused = await ask(old.key);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toBe("Permission requise : rides:quote.");
  });

  it("origine absente ou non listée : refusée sans CORS, avant toute limite par IP", async () => {
    const site = addKey("a3a3a3a3");
    const none = await book(site.key, { origin: null });
    expect(none.status).toBe(403);
    expect((await none.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    const evil = await quote(request("/quotes", { key: site.key, origin: "https://evil.test", body: TRIP }));
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect(h.checks.some((c) => c.key.startsWith("api:ip:"))).toBe(false);
  });
});

describe("limites par IP des clés « navigateur » (mêmes plafonds que le mini-site)", () => {
  it("valeurs : création 6 / 10 min et 20 / jour, devis 30 / min et 600 / jour, téléphone 3 / h, organisation 60 / h", () => {
    expect(BROWSER_IP_LIMITS["rides:create"].map(({ limit, windowSec }) => [limit, windowSec])).toEqual([[6, 600], [20, 86_400]]);
    expect(BROWSER_IP_LIMITS["rides:quote"].map(({ limit, windowSec }) => [limit, windowSec])).toEqual([[30, 60], [600, 86_400]]);
    expect(BROWSER_PHONE_LIMIT).toEqual({ limit: 3, windowSec: 3_600 });
    // Mini-site : booking:org:<id>, 60 par heure (app/book/[slug]/actions.ts)
    expect(BROWSER_ORG_CREATE_LIMIT).toEqual({ limit: 60, windowSec: 3_600 });
    // Débit de la clé : devis et réservations sur des compteurs distincts
    expect(new Set(Object.values(BROWSER_RATE_BUCKETS)).size).toBe(Object.keys(BROWSER_RATE_BUCKETS).length);
    // Clé navigateur d'un site (super admin) : débit minimal = au moins 10 adresses IP à pleine cadence de devis
    const quotePerIp = BROWSER_IP_LIMITS["rides:quote"].find((l) => l.windowSec === 60)!.limit;
    expect(SITE_KEY_RATE.browser.min).toBeGreaterThanOrEqual(10 * quotePerIp);
    expect(SITE_KEY_RATE.browser.default).toBeGreaterThan(SITE_KEY_RATE.browser.min);
  });

  it("création : 60 par heure pour l'organisation, toutes adresses et tous numéros confondus ; autre organisation non concernée", async () => {
    const site = addKey("e1e1e1e1");
    // 10 adresses × 6 réservations, chaque fois un numéro nouveau : dans toutes les limites par IP et par téléphone
    const sent: number[] = [];
    for (let n = 1; n <= 10; n += 1) sent.push(...(await statuses(6, () => book(site.key, { ip: `198.51.100.${n}` }))));
    expect(sent.every((s) => s === 201)).toBe(true);
    expect(h.rides).toHaveLength(60);
    // 61e, depuis une adresse et avec un numéro jamais vus : refusée pour l'organisation, rien n'est créé
    const res = await book(site.key, { ip: "203.0.113.200" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatchObject({ code: "RATE_LIMITED", message: "Trop de réservations reçues par ce site en une heure : réessayez plus tard." });
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(h.rides).toHaveLength(60);
    expect(h.checks.filter((c) => c.key === `api:org:${ORG_A}:create`).every((c) => c.limit === 60 && c.windowSec === 3_600)).toBe(true);
    // Toutes les clés navigateur de l'organisation partagent le plafond ; une autre organisation garde le sien
    const second = addKey("e2e2e2e2");
    expect((await book(second.key, { ip: "203.0.113.201" })).status).toBe(429);
    const other = addKey("e3e3e3e3", { org: ORG_B });
    expect((await book(other.key, { ip: "203.0.113.202" })).status).toBe(201);
    // Fenêtre suivante : de nouveau acceptée
    elapse(3_600);
    expect((await book(site.key, { ip: "203.0.113.203" })).status).toBe(201);
  });

  it("création : le téléphone d'abord (comme le mini-site) — une réservation refusée pour son numéro ne consomme pas le plafond de l'organisation", async () => {
    const site = addKey("e4e4e4e4");
    const phone = "+33612345999";
    expect(await statuses(5, (i) => book(site.key, { phone, ip: `198.51.100.${i + 1}` }))).toEqual([201, 201, 201, 429, 429]);
    expect(h.counts.get(`api:org:${ORG_A}:create`)).toBe(3);
  });

  it("débit de la clé compté par portée : des devis en rafale (dans leurs limites par IP) ne privent jamais les réservations", async () => {
    // Ancien défaut des clés du site : 60 par minute (constat de la revue : deux adresses à 30 devis suffisaient)
    const site = addKey("e5e5e5e5", { limit: 60 });
    for (const ip of ["198.51.100.1", "198.51.100.2"]) expect((await statuses(30, () => ask(site.key, ip))).every((s) => s === 200)).toBe(true);
    // Devis du site : débit des devis épuisé pour la minute (429 de la clé, CORS compris)
    const quoteOver = await ask(site.key, "198.51.100.3");
    expect(quoteOver.status).toBe(429);
    expect((await quoteOver.json()).error.message).toBe("Trop de requêtes pour cette clé.");
    // Réservation d'un autre visiteur : son propre compteur, acceptée
    const res = await book(site.key, { ip: "203.0.113.77" });
    expect(res.status).toBe(201);
    expect(h.rides).toHaveLength(1);
    expect(h.counts.get(`api:${site.id}${BROWSER_RATE_BUCKETS["rides:quote"]}`)).toBe(61);
    expect(h.counts.get(`api:${site.id}${BROWSER_RATE_BUCKETS["rides:create"]}`)).toBe(1);
  });

  it("création : 6 par 10 min et par IP, puis 429 + Retry-After lisible par le site ; le débit de la clé n'est pas consommé", async () => {
    const site = addKey("c1c1c1c1");
    expect(await statuses(6, () => book(site.key))).toEqual([201, 201, 201, 201, 201, 201]);
    const keyCount = h.counts.get(`api:${site.id}`);
    const res = await book(site.key);
    expect(res.status).toBe(429);
    const { error } = await res.json();
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toBe("Trop de demandes depuis cette adresse : réessayez plus tard.");
    expect(res.headers.get("retry-after")).toBe("600");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-expose-headers")).toContain("Retry-After");
    expect(h.counts.get(`api:${site.id}`)).toBe(keyCount);
    expect(h.rides).toHaveLength(6);
    // Refus rattaché à la centrale et à la clé dans le journal
    expect(h.logs.at(-1)).toMatchObject({ organization_id: ORG_A, api_key_id: site.id, status_code: 429, error_code: "RATE_LIMITED" });
    // Autre adresse : non concernée
    expect((await book(site.key, { ip: "198.51.100.7" })).status).toBe(201);
  });

  it("création : 20 par jour et par IP, même en étalant les envois", async () => {
    const site = addKey("c2c2c2c2");
    const sent: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      sent.push(...(await statuses(round < 3 ? 6 : 3, () => book(site.key))));
      elapse(600);
    }
    expect(sent.filter((s) => s === 201)).toHaveLength(20);
    expect(sent.at(-1)).toBe(429);
    const res = await book(site.key);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("86400");
    expect(h.rides).toHaveLength(20);
  });

  it("création : 3 par heure pour un même téléphone client, quelle que soit l'adresse IP", async () => {
    const site = addKey("c3c3c3c3");
    const phone = "+33612340000";
    expect(await statuses(3, (i) => book(site.key, { phone, ip: `198.51.100.${i + 1}` }))).toEqual([201, 201, 201]);
    const res = await book(site.key, { phone, ip: "198.51.100.50" });
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toBe("Trop de réservations pour ce numéro de téléphone : réessayez plus tard.");
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    // Format différent du même numéro : normalisé, toujours refusé
    expect((await book(site.key, { phone: "06 12 34 00 00", ip: "198.51.100.51" })).status).toBe(429);
    expect((await book(site.key, { ip: "198.51.100.52" })).status).toBe(201);
    elapse(3_600);
    expect((await book(site.key, { phone, ip: "198.51.100.53" })).status).toBe(201);
    expect(h.rides).toHaveLength(5);
  });

  it("devis : 30 par minute et 600 par jour et par IP, sans course créée", async () => {
    const site = addKey("c4c4c4c4");
    const first = await statuses(31, () => ask(site.key));
    expect(first.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(first[30]).toBe(429);
    const over = await ask(site.key);
    expect(over.headers.get("retry-after")).toBe("60");
    let accepted = 30;
    for (let minute = 1; minute < 25 && accepted < 600; minute += 1) {
      elapse(60);
      accepted += (await statuses(30, () => ask(site.key))).filter((s) => s === 200).length;
    }
    expect(accepted).toBe(600);
    elapse(60);
    const day = await ask(site.key);
    expect(day.status).toBe(429);
    expect(day.headers.get("retry-after")).toBe("86400");
    // Les devis ne comptent pas dans les créations, et inversement
    expect((await book(site.key)).status).toBe(201);
    expect(h.rides).toHaveLength(1);
  });

  it("IPv6 groupée par /64 ; limites propres à chaque organisation", async () => {
    const siteA = addKey("c5c5c5c5");
    const siteB = addKey("c6c6c6c6", { org: ORG_B });
    expect(await statuses(6, (i) => book(siteA.key, { ip: `2001:db8:7:7::${i + 1}` }))).toEqual([201, 201, 201, 201, 201, 201]);
    expect((await book(siteA.key, { ip: "2001:db8:7:7:abcd::1" })).status).toBe(429);
    expect((await book(siteA.key, { ip: "2001:db8:7:8::1" })).status).toBe(201);
    // Même visiteur sur le site d'une autre organisation : non plafonné par le premier
    expect((await book(siteB.key, { ip: "2001:db8:7:7::99" })).status).toBe(201);
  });
});

describe("clés serveur : inchangées", () => {
  it("ni limite par IP ni par téléphone : seul le débit de la clé", async () => {
    const server = addKey("d1d1d1d1", { scopes: ["rides:create", "rides:quote"], origins: [], limit: 1_000 });
    const phone = "+33612349999";
    const sent = await statuses(25, () => createRide(request("/rides", { key: server.key, origin: null, body: booking(phone) })));
    expect(sent.every((s) => s === 201)).toBe(true);
    expect((await statuses(40, () => quote(request("/quotes", { key: server.key, origin: null, body: TRIP })))).every((s) => s === 200)).toBe(true);
    expect(h.checks.every((c) => c.key === `api:${server.id}`)).toBe(true);
  });

  it("débit de la clé dépassé : 429 sans CORS pour une clé serveur, avec CORS pour une clé navigateur", async () => {
    const server = addKey("d2d2d2d2", { scopes: ["rides:quote"], origins: [], limit: 1 });
    expect((await quote(request("/quotes", { key: server.key, origin: null, body: TRIP }))).status).toBe(200);
    const s = await quote(request("/quotes", { key: server.key, origin: ORIGIN, body: TRIP }));
    expect(s.status).toBe(429);
    expect(s.headers.get("access-control-allow-origin")).toBeNull();
    const browser = addKey("d3d3d3d3", { limit: 1 });
    expect((await ask(browser.key)).status).toBe(200);
    const b = await ask(browser.key);
    expect(b.status).toBe(429);
    expect((await b.json()).error.message).toBe("Trop de requêtes pour cette clé.");
    expect(b.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});
