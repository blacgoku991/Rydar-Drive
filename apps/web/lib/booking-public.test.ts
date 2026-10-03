import { estimatePrice, estimateRoute, type PricingRule } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mini-site public (audit « public ») : vraie action submitBooking et vraie route de devis, avec un Supabase
// service role, un géocodeur et un routage simulés. Limites (IP /64, jour, téléphone, centrale), pot de miel,
// zone desservie, coordonnées incohérentes avec l'adresse, fuseau de la centrale.

const ORG = "11111111-1111-4111-8111-111111111111";
type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  ip: "203.0.113.10",
  org: null as Row | null,
  rule: null as Row | null,
  anchor: null as { lat: number; lng: number } | null,
  geocoded: null as { lat: number; lng: number } | null,
  inserts: [] as Row[],
  counts: new Map<string, number>(),
  limits: [] as { key: string; limit: number; windowSec: number }[],
  /** Interrupteur plateforme des mini-sites (platform_settings, migration 20260924006200) */
  bookingSites: true,
  /** Tables lues par l'action ou la route (aucune quand les mini-sites sont coupés) */
  reads: [] as string[],
}));

vi.mock("@/lib/booking-sites", () => ({ bookingSitesEnabled: async () => h.bookingSites }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": h.ip }) }));
vi.mock("@/lib/request", async () => await import("./request"));
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
vi.mock("@/lib/geo/cache", async () => await import("./geo/cache"));
vi.mock("@/lib/booking-price", async () => await import("./booking-price"));
vi.mock("@/lib/geo/anchor", async () => ({ ...(await import("./geo/anchor")), orgAnchor: async () => h.anchor }));
vi.mock("@/lib/geocode", () => ({ geocodeOne: async () => (h.geocoded ? { ...h.geocoded, label: "x", address: "x", kind: "address" } : null) }));
vi.mock("@/lib/geo/routing", async () => {
  const { estimateRoute } = await import("@rydar/shared");
  return {
    computeRoute: async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => ({
      ...estimateRoute(from, to), coordinates: [], polyline: "", provider: "estimate", approximate: true,
    }),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      h.reads.push(table);
      let op = "select";
      let payload: Row | null = null;
      const result = () => {
        if (table === "organizations") return { data: h.org, error: null };
        if (table === "pricing_rules") return { data: h.rule, error: null };
        if (table === "rides" && op === "insert") {
          h.inserts.push(payload!);
          return { data: { number: h.inserts.length }, error: null };
        }
        return { data: [], error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((op = "insert"), (payload = p), b),
        eq: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => result(),
        single: async () => result(),
      };
      return b;
    },
  }),
}));

const { submitBooking } = await import("../app/book/[slug]/actions");
const { POST: quote } = await import("../app/api/book/[slug]/quote/route");

const PARIS_GARE_DE_LYON = { address: "Gare de Lyon, 75012 Paris", lat: 48.8443, lng: 2.3743 };
const PARIS_OPERA = { address: "Opéra Garnier, 75009 Paris", lat: 48.8719, lng: 2.3316 };
const NICE_AIRPORT = { lat: 43.6584, lng: 7.2159 };
const RULE: PricingRule & { fixed_fares: [] } = {
  vehicle_category: "standard", base_fare_cents: 800, per_km_cents: 180, per_minute_cents: 40, minimum_fare_cents: 2500,
  night_surcharge_percent: 20, night_start: "22:00", night_end: "06:00", fixed_fares: [],
};

let phoneSeq = 0;
function booking(over: Row = {}) {
  phoneSeq += 1;
  return {
    pickup: PARIS_GARE_DE_LYON,
    dropoff: PARIS_OPERA,
    when: "now",
    customerName: "Jean Client",
    customerPhone: `+3361234${String(phoneSeq).padStart(4, "0")}`,
    passengers: 1,
    luggage: 0,
    vehicleCategory: "standard",
    consent: true,
    website: "",
    ...over,
  } as never;
}

beforeEach(() => {
  h.ip = "203.0.113.10";
  h.org = {
    id: ORG,
    status: "active",
    timezone: "Europe/Paris",
    settings: { default_payment_method: "cash" },
    booking: {
      enabled: true, show_price_estimate: true, vehicle_categories: ["standard"], phone: "01 23 45 67 89", email: "contact@centrale-b.example",
      legal_mentions: "Centrale B SAS, Paris. Paiement : espèces ou carte à bord. Annulation gratuite. Médiateur : CM2C.",
    },
  };
  h.rule = { ...RULE };
  h.anchor = { lat: 48.86, lng: 2.35 };
  h.geocoded = null;
  h.inserts = [];
  h.counts.clear();
  h.limits = [];
  h.bookingSites = true;
  h.reads = [];
});

describe("mini-sites coupés par la plateforme (super admin)", () => {
  it("réservation refusée : ni lecture de la centrale ni course créée (la base refuse aussi : BOOKING_SITES_DISABLED)", async () => {
    h.bookingSites = false;
    const res = await submitBooking("centrale-b", booking());
    expect(res).toEqual({ ok: false, error: "Réservation en ligne indisponible." });
    expect(h.inserts).toHaveLength(0);
    expect(h.reads).toEqual([]);
    // Limites par IP comptées avant (une rafale reste freinée), plafonds du téléphone et de la centrale intacts
    expect(h.limits.map((l) => l.key)).toEqual(["booking:ip:203.0.113.10", "booking:ipday:203.0.113.10"]);
  });

  it("devis refusé (404) : aucun itinéraire ni tarif lus", async () => {
    h.bookingSites = false;
    const res = await quote(
      new Request("https://b.test/api/book/centrale-b/quote", {
        method: "POST",
        body: JSON.stringify({ pickup: PARIS_GARE_DE_LYON, dropoff: PARIS_OPERA, category: "standard" }),
      }),
      { params: Promise.resolve({ slug: "centrale-b" }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Indisponible" });
    expect(h.reads).toEqual([]);
  });
});

describe("submitBooking : limites et pot de miel", () => {
  it("IP, IP/jour, téléphone puis centrale (60/h), dans cet ordre", async () => {
    const res = await submitBooking("centrale-b", booking({ customerPhone: "06 12 34 56 78" }));
    expect(res.ok).toBe(true);
    expect(h.limits.map((l) => [l.key, l.limit, l.windowSec])).toEqual([
      ["booking:ip:203.0.113.10", 6, 600],
      ["booking:ipday:203.0.113.10", 20, 86_400],
      ["booking:phone:+33612345678", 3, 3600],
      [`booking:org:${ORG}`, 60, 3600],
    ]);
  });

  it("adresses IPv6 d'un même /64 : une seule limite (6 demandes / 10 min)", async () => {
    const results = [];
    for (let i = 1; i <= 7; i += 1) {
      h.ip = `2001:db8:85a3:12::${i.toString(16)}`;
      results.push(await submitBooking("centrale-b", booking()));
    }
    expect(results.slice(0, 6).every((r) => r.ok)).toBe(true);
    expect(results[6]).toMatchObject({ ok: false, error: expect.stringMatching(/Trop de demandes/) });
    expect(h.inserts).toHaveLength(6);
  });

  it("plafond par centrale atteint : aucune course créée", async () => {
    h.counts.set(`booking:org:${ORG}`, 60);
    const res = await submitBooking("centrale-b", booking());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Trop de demandes/) });
    expect(h.inserts).toHaveLength(0);
  });

  it("même téléphone : 3 demandes par heure", async () => {
    const phone = "+33699999999";
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      h.ip = `198.51.100.${i + 1}`;
      results.push(await submitBooking("centrale-b", booking({ customerPhone: phone })));
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  });

  it("pot de miel rempli : réponse « ok » factice, rien de créé, plafond de la centrale intact", async () => {
    const res = await submitBooking("centrale-b", booking({ website: "http://spam.example" }));
    expect(res).toEqual({ ok: true, number: 0 });
    expect(h.inserts).toHaveLength(0);
    expect(h.counts.has(`booking:org:${ORG}`)).toBe(false);
  });
});

describe("submitBooking : prix et zone", () => {
  it("départ hors de la zone de la centrale (Tokyo) : refusé", async () => {
    const tokyo = { address: "Shibuya, Tokyo", lat: 35.658, lng: 139.7016 };
    const res = await submitBooking("centrale-b", booking({ pickup: tokyo, dropoff: { ...tokyo, lat: 35.66 } }));
    expect(res).toMatchObject({ ok: false, fieldErrors: { pickup: "Hors de la zone desservie" } });
    expect(h.inserts).toHaveLength(0);
  });

  // Revue de conformité (L221-14) : seul un prix AFFICHÉ engage le client ; le serveur l'enregistre s'il retrouve le
  // même, sinon il refuse et renvoie le nouveau prix ; sans prix affiché, la demande part sans prix.
  const gridPrice = (from = PARIS_GARE_DE_LYON, to = PARIS_OPERA, at = new Date(), tz = "Europe/Paris") => {
    const route = estimateRoute(from, to);
    return estimatePrice(RULE, route.distanceM, route.durationS, at, tz)!;
  };

  it("coordonnées de destination sans rapport avec l'adresse (Nice à 13 m du départ) : aucun prix en ligne (PRICE_CHANGED, null)", async () => {
    h.geocoded = NICE_AIRPORT;
    const fake = { address: "Aéroport de Nice Côte d'Azur, 06200 Nice", lat: 48.8444, lng: 2.3744 };
    const res = await submitBooking("centrale-b", booking({ dropoff: fake, expectedPriceCents: 2500 }));
    expect(res).toMatchObject({ ok: false, code: "PRICE_CHANGED", priceCents: null });
    expect(h.inserts).toHaveLength(0);
    // Sans prix affiché : simple demande, sans prix
    const req = await submitBooking("centrale-b", booking({ dropoff: fake }));
    expect(req.ok).toBe(true);
    expect(h.inserts[0]).toMatchObject({ dropoff_address: fake.address, price_cents: null });
  });

  it("prix affiché identique au calcul du serveur : enregistré tel quel, moyen de paiement de la centrale", async () => {
    h.geocoded = { lat: PARIS_OPERA.lat + 0.001, lng: PARIS_OPERA.lng };
    const expected = gridPrice();
    const res = await submitBooking("centrale-b", booking({ expectedPriceCents: expected }));
    expect(res.ok).toBe(true);
    expect(h.inserts[0]).toMatchObject({ price_cents: expected, payment_method: "cash" });
    expect(expected).toBeGreaterThanOrEqual(RULE.minimum_fare_cents);
  });

  it("prix affiché différent (devis périmé ou falsifié) : refus PRICE_CHANGED avec le nouveau prix, rien de créé", async () => {
    const expected = gridPrice();
    const res = await submitBooking("centrale-b", booking({ expectedPriceCents: expected - 500 }));
    expect(res).toMatchObject({ ok: false, code: "PRICE_CHANGED", priceCents: expected, error: expect.stringMatching(/Le prix a changé/) });
    expect(h.inserts).toHaveLength(0);
  });

  it("aucun prix affiché (grille masquée ou devis absent) : demande enregistrée SANS prix, jamais un prix que le client n'a pas vu", async () => {
    const res = await submitBooking("centrale-b", booking());
    expect(res.ok).toBe(true);
    expect(h.inserts[0]!.price_cents).toBeNull();
    h.org = { ...h.org!, booking: { ...h.org!.booking, show_price_estimate: false } };
    const masked = await submitBooking("centrale-b", booking({ expectedPriceCents: gridPrice() }));
    expect(masked).toMatchObject({ ok: false, code: "PRICE_CHANGED", priceCents: null });
  });

  it("mini-site publié sans conditions, téléphone ou e-mail : réservation en ligne refusée", async () => {
    h.org = { ...h.org!, booking: { ...h.org!.booking, legal_mentions: "" } };
    const res = await submitBooking("centrale-b", booking());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/^Réservation en ligne indisponible\. Appelez la centrale/) });
    expect(h.inserts).toHaveLength(0);
  });

  it("majoration de nuit calculée dans le fuseau de la centrale (La Réunion), comme le devis", async () => {
    h.org = { ...h.org, timezone: "Indian/Reunion" };
    h.anchor = { lat: -20.9, lng: 55.45 };
    const stDenis = { address: "Saint-Denis, 97400 La Réunion", lat: -20.8821, lng: 55.4507 };
    const stPierre = { address: "Saint-Pierre, 97410 La Réunion", lat: -21.3393, lng: 55.4781 };
    const pickupAt = new Date(Date.now() + 2 * 86_400_000);
    pickupAt.setUTCHours(19, 0, 0, 0); // 23:00 à La Réunion, 21:00 (été) ou 20:00 (hiver) à Paris
    const route = estimateRoute(stDenis, stPierre);
    const reunion = estimatePrice(RULE, route.distanceM, route.durationS, pickupAt, "Indian/Reunion")!;
    const res = await submitBooking("centrale-b", booking({ pickup: stDenis, dropoff: stPierre, when: "scheduled", pickupAt, expectedPriceCents: reunion }));
    expect(res.ok).toBe(true);
    expect(h.inserts[0]!.price_cents).toBe(reunion);
    expect(h.inserts[0]!.price_cents).not.toBe(estimatePrice(RULE, route.distanceM, route.durationS, pickupAt, "Europe/Paris"));
  });
});

describe("submitBooking : date de prise en charge", () => {
  it("plus de 400 jours à l'avance : message précis sur le champ, aucune course créée", async () => {
    const pickupAt = new Date(Date.now() + 450 * 86_400_000);
    const res = await submitBooking("centrale-b", booking({ when: "scheduled", pickupAt }));
    expect(res).toMatchObject({ ok: false, error: "Date de prise en charge trop lointaine.", fieldErrors: { pickupAt: "400 jours maximum" } });
    expect(h.inserts).toHaveLength(0);
  });
});

describe("devis du mini-site", () => {
  const call = (body: unknown) =>
    quote(new Request("https://b.test/api/book/centrale-b/quote", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ slug: "centrale-b" }) });

  it("limites par IP (/64) à la minute et au jour", async () => {
    h.ip = "2001:db8:85a3:12::99";
    const res = await call({ pickup: PARIS_GARE_DE_LYON, dropoff: PARIS_OPERA, category: "standard" });
    expect(res.status).toBe(200);
    expect(h.limits.map((l) => [l.key, l.limit, l.windowSec])).toEqual([
      ["bookquote:2001:0db8:85a3:0012::/64", 30, 60],
      ["bookquote:day:2001:0db8:85a3:0012::/64", 600, 86_400],
    ]);
  });

  it("même calcul que la réservation : prix de la grille ; destination incohérente avec ses coordonnées : aucun prix", async () => {
    h.geocoded = { lat: PARIS_OPERA.lat + 0.001, lng: PARIS_OPERA.lng };
    const q = await (await call({ pickup: PARIS_GARE_DE_LYON, dropoff: PARIS_OPERA, category: "standard" })).json();
    const route = estimateRoute(PARIS_GARE_DE_LYON, PARIS_OPERA);
    expect(q.priceCents).toBe(estimatePrice(RULE, route.distanceM, route.durationS, new Date(), "Europe/Paris"));
    h.geocoded = NICE_AIRPORT;
    const fake = { address: "Aéroport de Nice Côte d'Azur, 06200 Nice", lat: 48.8444, lng: 2.3744 };
    const q2 = await (await call({ pickup: PARIS_GARE_DE_LYON, dropoff: fake, category: "standard" })).json();
    expect(q2.priceCents).toBeNull();
  });

  it("trajet hors zone : 422, aucun itinéraire calculé", async () => {
    const tokyo = { address: "Shibuya, Tokyo", lat: 35.658, lng: 139.7016 };
    const res = await call({ pickup: tokyo, dropoff: tokyo, category: "standard" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/zone desservie/);
  });
});
