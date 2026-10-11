import { ERROR_MESSAGES, PRIVATE_BOOKING_LEAD_CHOICES } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutPlanAllowed } from "../app/api/billing/checkout/plan-access";

// Flotte Privée — espace web du client (lot L3, docs/FLOTTE-PRIVEE.md § 7) : détection et gardes (lib/private-fleet.ts),
// Checkout verrouillé sur l'offre attribuée (§ 7.6, app/api/billing/checkout/plan-access.ts), et vraies actions serveur
// avec Supabase simulé : création de chauffeur et invitation refusées AVANT toute création de compte Auth, « Je la
// prends » (driver_take_ride, jamais assign_ride), « Refuser » (decline_ride_offer), « Attribuer à… » et « Relancer »
// refusés, réglages « Réservations ».

type Op = { client: string; table: string; action: string; values?: unknown; filters: Record<string, unknown> };
type Reply = { data?: unknown; error?: unknown; count?: number } | undefined;

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  handle: (() => undefined) as (op: Op) => Reply,
  auth: [] as string[],
  lookups: [] as string[],
  ctx: null as any,
  stripeSessions: [] as unknown[],
}));

function fakeDb(name: string) {
  const reply = (op: Op) => {
    h.ops.push(op);
    const r = h.handle(op) ?? {};
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
  };
  return {
    from(table: string) {
      const op: Op = { client: name, table, action: "select", filters: {} };
      const b: any = {
        select: () => b,
        insert: (v: unknown) => ((op.action = "insert"), (op.values = v), b),
        update: (v: unknown) => ((op.action = "update"), (op.values = v), b),
        delete: () => ((op.action = "delete"), b),
        eq: (c: string, v: unknown) => ((op.filters[c] = v), b),
        in: (c: string, v: unknown) => ((op.filters[`${c}[]`] = v), b),
        not: () => b,
        is: () => b,
        neq: () => b,
        ilike: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: () => reply(op),
        single: () => reply(op),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => reply(op).then(ok, ko),
      };
      return b;
    },
    rpc: (fn: string, args: unknown) => reply({ client: name, table: `rpc:${fn}`, action: "rpc", values: args, filters: {} }),
    auth: {
      admin: {
        createUser: async () => (h.auth.push("createUser"), { data: { user: { id: "u-new" } }, error: null }),
        inviteUserByEmail: async () => (h.auth.push("inviteUserByEmail"), { data: { user: { id: "u-new" } }, error: null }),
        deleteUser: async () => (h.auth.push("deleteUser"), { data: {}, error: null }),
        updateUserById: async () => (h.auth.push("updateUserById"), { data: {}, error: null }),
      },
    },
  };
}
const admin = fakeDb("admin");
const user = fakeDb("user");

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/env", () => ({
  env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon", appUrl: "https://app.rydar.test", rootDomain: "rydar.test" },
  serverEnv: () => ({ apiKeyPepper: "pepper" }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/auth", () => ({ isAdminRole: (r: string) => r === "owner" || r === "admin" }));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/member-invite", () => ({
  findUserIdByEmail: async (email: string) => (h.lookups.push(email), null),
  sendMemberInvitationEmail: async () => true,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimitAll: async () => ({ ok: true, remaining: 1, resetAt: 0, limit: 1 }) }));
vi.mock("@/lib/whatsapp", () => ({ saveWhatsApp: async () => ({ ok: true }), removeWhatsApp: async () => ({ ok: true }), testWhatsApp: async () => ({ ok: true }) }));
vi.mock("@/components/settlements/settings-schema", async () => await import("../components/settlements/settings-schema"));
vi.mock("@/lib/geocode", () => ({ geocodeOne: async () => null }));
vi.mock("@/lib/geo/routing", () => ({ rideRouteColumns: async () => ({}) }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: { create: async (p: unknown) => (h.stripeSessions.push(p), { url: "https://checkout.stripe.test/s" }) } },
  }),
}));

const pf = await import("./private-fleet");
const drivers = await import("../app/dashboard/drivers/actions");
const settings = await import("../app/dashboard/settings/actions");
const rides = await import("../app/dashboard/rides/actions");
const checkout = await import("../app/api/billing/checkout/route");

const ORG = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";
const RIDE = "33333333-3333-4333-8333-333333333333";
const PLAN_PUBLIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAN_ASSIGNED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ctxFor = (privateFleet: boolean, role = "owner") => ({
  supabase: user,
  user: { id: "u-owner" },
  profile: { email: "owner@example.test" },
  org: { id: ORG, name: "Taxi Karim", private_fleet: privateFleet, dispatch_model: "fleet", timezone: "Europe/Paris", plan_id: null },
  role,
});

beforeEach(() => {
  h.ops.length = 0;
  h.auth.length = 0;
  h.lookups.length = 0;
  h.stripeSessions.length = 0;
  h.handle = () => undefined;
  h.ctx = ctxFor(true);
});

describe("détection et gardes (lib/private-fleet.ts)", () => {
  it("isPrivateFleet : drapeau vrai seulement (absent, nul ou illisible : organisation standard)", () => {
    expect(pf.isPrivateFleet({ private_fleet: true })).toBe(true);
    for (const org of [{ private_fleet: false }, { private_fleet: null }, {}, null, undefined]) expect(pf.isPrivateFleet(org)).toBe(false);
  });

  it("refuseInPrivateFleet : réponse d'erreur PRIVATE_FLEET_RESTRICTED en Flotte Privée, null sinon", () => {
    expect(pf.refuseInPrivateFleet({ org: { private_fleet: true } })).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED });
    expect(ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED).toBe("Fonction non incluse dans la Flotte Privée.");
    expect(pf.refuseInPrivateFleet({ org: { private_fleet: false } })).toBeNull();
    expect(pf.refuseInPrivateFleet(null)).toBeNull();
  });

  it("privateFleetPage : 404 ou redirection en Flotte Privée, rien pour une organisation standard", () => {
    expect(() => pf.privateFleetPage({ org: { private_fleet: true } }, "notFound")).toThrow("NOT_FOUND");
    expect(() => pf.privateFleetPage({ org: { private_fleet: true } }, { redirect: "/dashboard/profil" })).toThrow("REDIRECT /dashboard/profil");
    expect(() => pf.privateFleetPage({ org: { private_fleet: false } }, "notFound")).not.toThrow();
    expect(() => pf.privateFleetPage({ org: { private_fleet: false } }, { redirect: "/dashboard" })).not.toThrow();
  });

});

describe("checkoutPlanAllowed (§ 7.6)", () => {
  const pub = { id: PLAN_PUBLIC, is_public: true };
  const assigned = { id: PLAN_ASSIGNED, is_public: false };
  it("Flotte Privée : seulement l'offre attribuée, même non publique ; jamais une offre publique", () => {
    expect(checkoutPlanAllowed({ privateFleet: true, plan: assigned, orgPlanId: PLAN_ASSIGNED })).toBe(true);
    expect(checkoutPlanAllowed({ privateFleet: true, plan: pub, orgPlanId: PLAN_ASSIGNED })).toBe(false);
    expect(checkoutPlanAllowed({ privateFleet: true, plan: pub, orgPlanId: null })).toBe(false);
    expect(checkoutPlanAllowed({ privateFleet: true, plan: { ...pub, id: PLAN_ASSIGNED }, orgPlanId: PLAN_ASSIGNED })).toBe(true);
  });
  it("organisation standard : offre publique, ou l'offre négociée attribuée (règle inchangée)", () => {
    expect(checkoutPlanAllowed({ privateFleet: false, plan: pub, orgPlanId: null })).toBe(true);
    expect(checkoutPlanAllowed({ privateFleet: false, plan: assigned, orgPlanId: PLAN_ASSIGNED })).toBe(true);
    expect(checkoutPlanAllowed({ privateFleet: false, plan: assigned, orgPlanId: PLAN_PUBLIC })).toBe(false);
  });
  it("offre introuvable ou inactive : jamais", () => {
    expect(checkoutPlanAllowed({ privateFleet: false, plan: null, orgPlanId: PLAN_PUBLIC })).toBe(false);
    expect(checkoutPlanAllowed({ privateFleet: true, plan: undefined, orgPlanId: PLAN_ASSIGNED })).toBe(false);
  });
});

describe("Checkout Stripe d'une Flotte Privée", () => {
  const PLANS = [
    { id: PLAN_PUBLIC, code: "pro", is_public: true, stripe_price_monthly_id: "price_pro", stripe_price_yearly_id: null },
    { id: PLAN_ASSIGNED, code: "flotte_privee_karim", is_public: false, stripe_price_monthly_id: "price_fp", stripe_price_yearly_id: null },
  ];
  const run = (planCode: string, org: Record<string, unknown>) => {
    h.handle = (op) => {
      if (op.table === "plans") return { data: PLANS.find((p) => p.code === op.filters.code) ?? null };
      if (op.table === "organizations" && op.action === "select") return { data: { id: ORG, name: "Taxi Karim", email: null, stripe_customer_id: "cus_1", ...org } };
      if (op.table === "subscriptions") return { data: [] };
      if (op.table === "legal_acceptances") return { data: [{ version: "x" }] };
      return undefined;
    };
    return checkout.POST(new Request("https://app.rydar.test/api/billing/checkout", { method: "POST", body: JSON.stringify({ planCode, interval: "month" }) }));
  };

  it("offre publique refusée (422), offre attribuée acceptée", async () => {
    const org = { private_fleet: true, plan_id: PLAN_ASSIGNED };
    expect((await run("pro", org)).status).toBe(422);
    expect(h.stripeSessions).toHaveLength(0);
    const res = await run("flotte_privee_karim", org);
    expect(res.status).toBe(200);
    expect(h.stripeSessions).toHaveLength(1);
  });

  it("sans offre attribuée : aucune offre payable en ligne", async () => {
    expect((await run("pro", { private_fleet: true, plan_id: null })).status).toBe(422);
    expect(h.stripeSessions).toHaveLength(0);
  });

  it("organisation standard : l'offre publique reste payable (non-régression)", async () => {
    expect((await run("pro", { private_fleet: false, plan_id: null })).status).toBe(200);
  });
});

describe("actions refusées AVANT toute création de compte Auth", () => {
  it("createDriver : PRIVATE_FLEET_RESTRICTED, aucun appel Auth ni écriture", async () => {
    const res = await drivers.createDriver({
      firstName: "Karim", lastName: "B.", phone: "0612345678", email: "chauffeur2@example.test", status: "active", access: "invite",
      vehicle: { model: "Classe E", plate: "AB-123-CD", category: "business", seats: 4, luggageCapacity: 3 },
    } as never);
    expect(res).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED });
    expect(h.auth).toEqual([]);
    expect(h.ops).toEqual([]);
  });

  it("inviteMember : PRIVATE_FLEET_RESTRICTED, ni recherche de compte, ni invitation, ni adhésion", async () => {
    const res = await settings.inviteMember({ fullName: "Associé", email: "associe@example.test", role: "admin" });
    expect(res).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED });
    expect(h.lookups).toEqual([]);
    expect(h.auth).toEqual([]);
    expect(h.ops).toEqual([]);
  });

  it("organisation standard : la création de chauffeur passe toujours par le compte Auth (non-régression)", async () => {
    h.ctx = ctxFor(false);
    h.handle = (op) => (op.action === "insert" ? { data: { id: op.table === "vehicles" ? "v1" : "d1" } } : undefined);
    const res = await drivers.createDriver({
      firstName: "Karim", lastName: "Benali", phone: "0612345678", email: "karim@example.test", status: "active", access: "invite",
      vehicle: { model: "Classe E", plate: "AB-123-CD", category: "business", seats: 4, luggageCapacity: 3 },
    } as never);
    expect(res).toEqual({ ok: true, id: "d1" });
    expect(h.auth).toEqual(["inviteUserByEmail"]);
  });

  it("autres actions du § 7.4 : refusées sans écriture (statut, mot de passe, équipe, relance, réglages)", async () => {
    const results = await Promise.all([
      drivers.setDriverStatus(RIDE, { status: "suspended", reason: "test" }),
      drivers.resetDriverPassword(RIDE, "motdepasse-123"),
      settings.updateMember(RIDE, { role: "admin" }),
      settings.resendMemberInvitation(RIDE),
      settings.updateDispatchSettings({} as never),
      rides.redispatchRide(RIDE),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED });
    const relaunch = await rides.relaunchRide(RIDE, null);
    expect(relaunch).toMatchObject({ ok: false, code: "ERROR", error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED });
    expect(h.ops.filter((o) => o.action !== "select")).toEqual([]);
    expect(h.auth).toEqual([]);
  });
});

describe("« Je la prends » (takeBooking)", () => {
  const rpcCalls = () => h.ops.filter((o) => o.action === "rpc").map((o) => o.table);

  it("driver_take_ride avec le client de la session (compte de la fiche), jamais assign_ride", async () => {
    h.handle = (op) => (op.table === "rpc:driver_take_ride" ? { data: { ok: true, code: "ACCEPTED", message: "Course attribuée.", ride_id: RIDE } } : undefined);
    expect(await rides.takeBooking(RIDE)).toEqual({ ok: true, chained: false });
    expect(h.ops).toEqual([{ client: "user", table: "rpc:driver_take_ride", action: "rpc", values: { p_ride_id: RIDE }, filters: {} }]);
    expect(rpcCalls()).not.toContain("rpc:assign_ride");
    expect(h.auth).toEqual([]);
  });

  it("immédiate prise pendant une autre course : enchaînée ; déjà à lui (UNCHANGED) : succès", async () => {
    h.handle = () => ({ data: { ok: true, code: "ACCEPTED", ride_id: RIDE, chained: true } });
    expect(await rides.takeBooking(RIDE)).toEqual({ ok: true, chained: true });
    h.handle = () => ({ data: { ok: true, code: "UNCHANGED", ride_id: RIDE } });
    expect(await rides.takeBooking(RIDE)).toEqual({ ok: true, chained: false });
  });

  it("refus de la base affichés tels quels (6 h dépassées, plus attribuable, introuvable) ; fiche inactive : message clair", async () => {
    for (const [code, message] of [
      ["RIDE_TOO_LATE", "Heure de prise en charge dépassée depuis plus de 6 h."],
      ["RIDE_NOT_ASSIGNABLE", "Cette réservation ne peut plus être prise."],
      ["RIDE_NOT_FOUND", "Course introuvable."],
      ["RIDE_ALREADY_ASSIGNED", "Course déjà attribuée."],
    ]) {
      h.handle = () => ({ data: { ok: false, code, message } });
      expect(await rides.takeBooking(RIDE), code).toEqual({ ok: false, error: message });
    }
    h.handle = () => ({ error: { code: "42501", message: "FORBIDDEN: compte chauffeur inactif ou inconnu" } });
    expect(await rides.takeBooking(RIDE)).toEqual({ ok: false, error: "Votre fiche chauffeur n'est pas active : réservation impossible à prendre." });
    expect(rpcCalls().every((t) => t === "rpc:driver_take_ride")).toBe(true);
  });

  it("identifiant invalide ou organisation standard : aucun appel", async () => {
    expect(await rides.takeBooking("pas-un-uuid")).toEqual({ ok: false, error: "Réservation introuvable : rechargez la page." });
    h.ctx = ctxFor(false);
    expect(await rides.takeBooking(RIDE)).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_ONLY });
    expect(h.ops).toEqual([]);
  });

  it("« Attribuer à… » (assignRide) refusé en Flotte Privée sans appel ; organisation standard : assign_ride (non-régression)", async () => {
    expect(await rides.assignRide(RIDE, OFFER)).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED });
    expect(h.ops).toEqual([]);
    h.ctx = ctxFor(false);
    h.handle = (op) => (op.table === "rpc:assign_ride" ? { data: { ok: true, code: "ASSIGNED", ride_id: RIDE } } : undefined);
    expect(await rides.assignRide(RIDE, OFFER)).toEqual({ ok: true });
    expect(rpcCalls()).toEqual(["rpc:assign_ride"]);
  });
});

describe("« Refuser » (declineOffer)", () => {
  it("decline_ride_offer avec le client de la session (même compte que la fiche)", async () => {
    h.handle = (op) => (op.table === "rpc:decline_ride_offer" ? { data: { ok: true, code: "DECLINED" } } : undefined);
    expect(await rides.declineOffer(OFFER)).toEqual({ ok: true });
    expect(h.ops).toEqual([{ client: "user", table: "rpc:decline_ride_offer", action: "rpc", values: { p_offer_id: OFFER }, filters: {} }]);
  });

  it("offre close ou introuvable, fiche inactive : message clair", async () => {
    h.handle = () => ({ data: { ok: false, code: "OFFER_CLOSED", message: "Cette offre n'est plus disponible." } });
    expect(await rides.declineOffer(OFFER)).toEqual({ ok: false, error: "Cette réservation n'attend plus de réponse : rechargez la page." });
    h.handle = () => ({ error: { code: "42501", message: "FORBIDDEN: compte chauffeur inactif ou inconnu" } });
    expect(await rides.declineOffer(OFFER)).toEqual({ ok: false, error: "Votre fiche chauffeur n'est pas active : refus impossible." });
    expect(await rides.declineOffer("pas-un-uuid")).toMatchObject({ ok: false });
  });

  it("organisation standard : réservé à la Flotte Privée (aucun appel)", async () => {
    h.ctx = ctxFor(false);
    expect(await rides.declineOffer(OFFER)).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_ONLY });
    expect(h.ops).toEqual([]);
  });
});

describe("Réglages › Réservations (updatePrivateBookingSettings)", () => {
  const valid = { scheduledDispatchLeadMinutes: 120, offerTimeoutSeconds: 300, reminderOffsetsMinutes: [60, 1440, 60], defaultPaymentMethod: "cash" as const };

  it("enregistre les colonnes ouvertes en écriture (rappels dédoublonnés, du plus tôt au plus tard)", async () => {
    expect(await settings.updatePrivateBookingSettings(valid)).toEqual({ ok: true });
    expect(h.ops).toEqual([
      {
        client: "user",
        table: "organization_settings",
        action: "update",
        values: { scheduled_dispatch_lead_minutes: 120, offer_timeout_seconds: 300, reminder_offsets_minutes: [1440, 60], default_payment_method: "cash" },
        filters: { organization_id: ORG },
      },
    ]);
  });

  it("valeur hors des choix proposés : refus par champ, rien n'est écrit", async () => {
    const res = await settings.updatePrivateBookingSettings({ ...valid, scheduledDispatchLeadMinutes: 45 });
    expect(PRIVATE_BOOKING_LEAD_CHOICES).not.toContain(45);
    expect(res).toMatchObject({ ok: false, fieldErrors: { scheduledDispatchLeadMinutes: "Choisissez un délai proposé" } });
    expect(h.ops).toEqual([]);
  });

  it("organisation standard ou dispatcher : refusé", async () => {
    h.ctx = ctxFor(false);
    expect(await settings.updatePrivateBookingSettings(valid)).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_ONLY });
    h.ctx = ctxFor(true, "dispatcher");
    expect(await settings.updatePrivateBookingSettings(valid)).toEqual({ ok: false, error: "Réservé aux administrateurs." });
    expect(h.ops).toEqual([]);
  });
});
