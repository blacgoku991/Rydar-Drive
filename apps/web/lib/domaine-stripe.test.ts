import { beforeEach, describe, expect, it, vi } from "vitest";

// Facturation Stripe : webhook (/api/stripe/webhook) et Checkout (/api/billing/checkout), avec Stripe et Supabase simulés.
// Corps plafonné avant lecture complète, erreurs base → 500 (nouvel essai de Stripe), objets relus à jour (ordre des
// événements), rétrogradation à la fin de l'abonnement, pas de second abonnement, offres non publiques refusées.

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  /** État à jour côté Stripe (ce que renvoie retrieve) */
  subs: new Map<string, Row>(),
  invoices: new Map<string, Row>(),
  db: {} as Record<string, Row[]>,
  /** Écriture Supabase en échec : { table, op } */
  fail: null as null | { table: string; op: string },
  audits: [] as Row[],
  sessions: [] as Row[],
  ctx: null as unknown,
}));

vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.rydar.app", rootDomain: "rydar.app" },
  serverEnv: () => ({ stripeWebhookSecret: "whsec_test", stripeSecretKey: "sk_test" }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (e: Row) => void h.audits.push(e) }));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("@/lib/stripe", () => {
  const missing = (what: string) => Object.assign(new Error(`No such ${what}`), { code: "resource_missing" });
  const stripe = {
    webhooks: {
      constructEvent: (payload: string | Uint8Array, sig: string) => {
        if (sig !== "sig-ok") throw new Error("Signature invalide");
        return JSON.parse(Buffer.from(payload as never).toString("utf8"));
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        const s = h.subs.get(id);
        if (!s) throw missing("subscription");
        return structuredClone(s);
      },
      // Sans statut : abonnements non résiliés du client (fin d'abonnement : autre abonnement vivant ?)
      list: async (params: { customer: string }) => ({
        data: [...h.subs.values()].filter((s) => s.customer === params.customer && s.status !== "canceled").map((s) => structuredClone(s)),
      }),
    },
    invoices: {
      retrieve: async (id: string) => {
        const i = h.invoices.get(id);
        if (!i) throw missing("invoice");
        return structuredClone(i);
      },
    },
    customers: { create: async () => ({ id: "cus_new" }) },
    checkout: {
      sessions: {
        create: async (params: Row) => {
          h.sessions.push(params);
          return { url: "https://checkout.stripe.test/session" };
        },
      },
    },
  };
  return { getStripe: () => stripe };
});

/** Supabase (service role) en mémoire : select/eq/not/in/or/limit, update, upsert (onConflict), échecs simulés. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "upsert" = "select";
  let values: Row = {};
  let conflict = "";
  let max = Infinity;
  const run = async (mode: "many" | "maybe" | "single") => {
    if (h.fail && h.fail.table === table && h.fail.op === op) return { data: null, error: { message: "TypeError: fetch failed" } };
    const rows = (h.db[table] ??= []);
    if (op === "upsert") {
      const existing = rows.find((r) => r[conflict] === values[conflict]);
      if (existing) Object.assign(existing, values);
      else rows.push({ ...values });
      return { data: null, error: null };
    }
    const matched = rows.filter((r) => filters.every((f) => f(r))).slice(0, max);
    if (op === "update") {
      for (const r of matched) Object.assign(r, values);
      return { data: null, error: null };
    }
    if (mode === "many") return { data: matched, error: null };
    if (matched.length > 1 || (mode === "single" && !matched.length)) return { data: null, error: { code: "PGRST116", message: "rows" } };
    return { data: matched[0] ?? null, error: null };
  };
  const q: Row = {
    select: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] != null && r[c] !== v), q),
    not: (c: string) => (filters.push((r) => r[c] != null), q),
    in: (c: string, list: unknown[]) => (filters.push((r) => list.includes(r[c])), q),
    or: (expr: string) => {
      const alts = expr.split(",").map((part) => {
        const [c, , ...v] = part.split(".");
        return (r: Row) => r[c!] === v.join(".");
      });
      filters.push((r) => alts.some((f) => f(r)));
      return q;
    },
    limit: (n: number) => ((max = n), q),
    update: (v: Row) => ((op = "update"), (values = v), q),
    upsert: (v: Row, o: { onConflict: string }) => ((op = "upsert"), (values = v), (conflict = o.onConflict), q),
    maybeSingle: () => run("maybe"),
    single: () => run("single"),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run("many").then(res, rej),
  };
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from }) }));

const webhook = await import("../app/api/stripe/webhook/route");
const checkout = await import("../app/api/billing/checkout/route");

const ORG = "11111111-1111-4111-8111-111111111111";
const STARTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUSINESS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const sub = (status: string, over: Row = {}): Row => ({
  id: "sub_1",
  customer: "cus_1",
  status,
  metadata: { organization_id: ORG },
  items: { data: [{ price: { id: "price_business_m", recurring: { interval: "month" } }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
  cancel_at_period_end: false,
  canceled_at: null,
  trial_end: null,
  ...over,
});
const invoice = (status: string, over: Row = {}): Row => ({
  id: "in_1", customer: "cus_1", metadata: {}, number: "F-1", status, amount_due: 39_900, amount_paid: status === "paid" ? 39_900 : 0,
  currency: "eur", hosted_invoice_url: null, invoice_pdf: null, period_start: 1_790_000_000, period_end: 1_792_600_000, ...over,
});
const post = (event: Row, init: { sig?: string } = {}) =>
  webhook.POST(new Request("https://app.rydar.app/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": init.sig ?? "sig-ok" }, body: JSON.stringify(event) }));
const evt = (type: string, object: Row) => ({ id: `evt_${type}`, type, data: { object } });
const org = () => h.db.organizations!.find((o) => o.id === ORG)!;

beforeEach(() => {
  h.subs.clear();
  h.invoices.clear();
  h.fail = null;
  h.audits = [];
  h.sessions = [];
  h.db = {
    organizations: [{ id: ORG, name: "Centrale A", email: "a@test.dev", plan_id: BUSINESS, stripe_customer_id: "cus_1" }],
    plans: [
      { id: STARTER, code: "starter", is_active: true, is_public: true, stripe_price_monthly_id: "price_starter_m", stripe_price_yearly_id: null },
      { id: BUSINESS, code: "business", is_active: true, is_public: true, stripe_price_monthly_id: "price_business_m", stripe_price_yearly_id: null },
      { id: PRIVATE, code: "partenaire", is_active: true, is_public: false, stripe_price_monthly_id: "price_private_m", stripe_price_yearly_id: null },
    ],
    subscriptions: [],
    invoices: [],
  };
  h.ctx = { org: { id: ORG }, role: "owner", user: { id: "u1" }, profile: { email: "owner@test.dev" } };
});

describe("webhook Stripe : taille du corps", () => {
  it("Content-Length au-delà de 512 Ko : 413 avant toute lecture", async () => {
    const res = await webhook.POST(
      new Request("https://app.rydar.app/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "sig-ok", "content-length": String(600 * 1024) },
        body: "x".repeat(10),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("corps en flux (chunked) sans longueur : lecture interrompue dès 512 Ko dépassés", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 160) controller.close(); // 10 Mo
        else controller.enqueue(chunk);
      },
    });
    const res = await webhook.POST(
      new Request("https://app.rydar.app/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "sig-ok" }, body, duplex: "half" } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });

  it("signature invalide : 400 (inchangé)", async () => {
    expect((await post(evt("invoice.paid", invoice("paid")), { sig: "faux" })).status).toBe(400);
  });
});

describe("webhook Stripe : fiabilité", () => {
  it("écriture en base en échec : 500 (Stripe renverra l'événement), jamais « reçu »", async () => {
    h.subs.set("sub_1", sub("active"));
    h.fail = { table: "subscriptions", op: "upsert" };
    const res = await post(evt("customer.subscription.updated", sub("active")));
    expect(res.status).toBe(500);
    h.fail = null;
    expect((await post(evt("customer.subscription.updated", sub("active")))).status).toBe(200);
    expect(h.db.subscriptions).toEqual([expect.objectContaining({ stripe_subscription_id: "sub_1", status: "active", plan_id: BUSINESS })]);
  });

  it("événements dans le désordre : l'abonnement est relu à jour (un « created incomplete » tardif ne régresse pas)", async () => {
    org().plan_id = STARTER;
    h.subs.set("sub_1", sub("active"));
    expect((await post(evt("customer.subscription.created", sub("incomplete")))).status).toBe(200);
    expect(h.db.subscriptions![0]).toMatchObject({ status: "active" });
    expect(org().plan_id).toBe(BUSINESS);
  });

  it("facture payée puis « finalized » livré en retard : reste payée", async () => {
    h.invoices.set("in_1", invoice("paid"));
    await post(evt("invoice.paid", invoice("paid")));
    expect((await post(evt("invoice.finalized", invoice("open")))).status).toBe(200);
    expect(h.db.invoices).toEqual([expect.objectContaining({ stripe_invoice_id: "in_1", status: "paid", amount_paid_cents: 39_900 })]);
    h.invoices.set("in_2", invoice("open", { id: "in_2" }));
    await post(evt("invoice.payment_failed", invoice("open", { id: "in_2" })));
    expect(h.db.invoices!.find((i) => i.stripe_invoice_id === "in_2")).toMatchObject({ status: "payment_failed" });
  });
});

describe("webhook Stripe : fin d'abonnement", () => {
  it("résiliation : retour à l'offre d'avant le paiement (previous_plan_id) + audit", async () => {
    const ended = sub("canceled", { metadata: { organization_id: ORG, previous_plan_id: STARTER } });
    h.subs.set("sub_1", ended);
    expect((await post(evt("customer.subscription.deleted", ended))).status).toBe(200);
    expect(org().plan_id).toBe(STARTER);
    expect(h.audits).toEqual([expect.objectContaining({ action: "billing.plan_downgraded", severity: "warning", organizationId: ORG })]);
  });

  it("impayé (unpaid) : même rétrogradation", async () => {
    const unpaid = sub("unpaid", { metadata: { organization_id: ORG, previous_plan_id: STARTER } });
    h.subs.set("sub_1", unpaid);
    await post(evt("customer.subscription.updated", unpaid));
    expect(org().plan_id).toBe(STARTER);
  });

  it("aucune offre de repli : jamais « sans offre » (illimité), offre conservée et super admin alerté", async () => {
    h.subs.set("sub_1", sub("canceled"));
    await post(evt("customer.subscription.deleted", sub("canceled")));
    expect(org().plan_id).toBe(BUSINESS);
    expect(h.audits).toEqual([expect.objectContaining({ action: "billing.subscription_ended", severity: "critical" })]);
  });

  it("offre déjà changée par le super admin : rien n'est touché", async () => {
    org().plan_id = PRIVATE;
    const ended = sub("canceled", { metadata: { organization_id: ORG, previous_plan_id: STARTER } });
    h.subs.set("sub_1", ended);
    await post(evt("customer.subscription.deleted", ended));
    expect(org().plan_id).toBe(PRIVATE);
    expect(h.audits).toEqual([]);
  });

  it("past_due (délai de grâce) : l'offre reste", async () => {
    const late = sub("past_due", { metadata: { organization_id: ORG, previous_plan_id: STARTER } });
    h.subs.set("sub_1", late);
    await post(evt("customer.subscription.updated", late));
    expect(org().plan_id).toBe(BUSINESS);
  });
});

describe("Checkout Stripe", () => {
  const call = (planCode: string) =>
    checkout.POST(new Request("https://app.rydar.app/api/billing/checkout", { method: "POST", body: JSON.stringify({ planCode, interval: "month" }) }));

  it("abonnement Stripe déjà en cours : 409, aucun second abonnement", async () => {
    h.db.subscriptions!.push({ organization_id: ORG, stripe_subscription_id: "sub_1", status: "active" });
    const res = await call("starter");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Gérer/);
    expect(h.sessions).toHaveLength(0);
  });

  it("abonnement d'essai créé par le super admin (sans Stripe) ou résilié : Checkout autorisé", async () => {
    h.db.subscriptions!.push({ organization_id: ORG, stripe_subscription_id: null, status: "trialing" });
    h.db.subscriptions!.push({ organization_id: ORG, stripe_subscription_id: "sub_old", status: "canceled" });
    const res = await call("starter");
    expect(res.status).toBe(200);
    expect(h.sessions[0]!.subscription_data.metadata).toEqual({ organization_id: ORG, plan_code: "starter", previous_plan_id: BUSINESS });
  });

  it("offre non publique : refusée, sauf celle attribuée à la centrale", async () => {
    expect((await call("partenaire")).status).toBe(422);
    org().plan_id = PRIVATE;
    expect((await call("partenaire")).status).toBe(200);
  });
});
