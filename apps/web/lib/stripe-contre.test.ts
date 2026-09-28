import { beforeEach, describe, expect, it, vi } from "vitest";

// Contre-audit « web_api » (sql3#1) : webhook Stripe — un événement tardif, en double ou réessayé d'un ANCIEN abonnement
// ne rétrograde jamais une centrale dont l'abonnement courant (vivant, relié à une offre) est un autre.
// Vraie route /api/stripe/webhook, Stripe et Supabase (service role) simulés.

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  /** État à jour côté Stripe (retrieve / list) */
  subs: new Map<string, Row>(),
  db: {} as Record<string, Row[]>,
  fail: null as null | { table: string; op: string },
  audits: [] as Row[],
  lists: 0,
}));

vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.rydar.app", rootDomain: "rydar.app" },
  serverEnv: () => ({ stripeWebhookSecret: "whsec_test", stripeSecretKey: "sk_test" }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (e: Row) => void h.audits.push(e) }));
vi.mock("@/lib/stripe", () => {
  const stripe = {
    webhooks: { constructEvent: (payload: string | Uint8Array) => JSON.parse(Buffer.from(payload as never).toString("utf8")) },
    subscriptions: {
      retrieve: async (id: string) => {
        const s = h.subs.get(id);
        if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
        return structuredClone(s);
      },
      // Sans statut : tous les abonnements non résiliés du client (comportement de l'API Stripe)
      list: async (params: { customer: string }) => {
        h.lists += 1;
        return { data: [...h.subs.values()].filter((s) => s.customer === params.customer && s.status !== "canceled").map((s) => structuredClone(s)) };
      },
    },
    invoices: { retrieve: async () => Promise.reject(Object.assign(new Error("No such invoice"), { code: "resource_missing" })) },
  };
  return { getStripe: () => stripe };
});

/** Supabase (service role) en mémoire : select/eq/neq/not/in/or/limit, update, upsert (onConflict), échecs simulés. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "upsert" = "select";
  let values: Row = {};
  let conflict = "";
  let max = Infinity;
  const run = async (mode: "many" | "maybe" | "single") => {
    if (h.fail && h.fail.table === table && h.fail.op === op) {
      h.fail = null;
      return { data: null, error: { message: "TypeError: fetch failed" } };
    }
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
    // SQL : « col <> v » est faux pour NULL
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] != null && r[c] !== v), q),
    not: (c: string, operator: string, v: unknown) => (filters.push((r) => (operator === "is" && v === null ? r[c] != null : r[c] !== v)), q),
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

const ORG = "11111111-1111-4111-8111-111111111111";
const P0 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sub = (id: string, status: string, previous: string | null = P0, price = "price_pro_m"): Row => ({
  id,
  customer: "cus_1",
  status,
  metadata: { organization_id: ORG, plan_code: "pro", ...(previous ? { previous_plan_id: previous } : {}) },
  items: { data: [{ price: { id: price, recurring: { interval: "month" } }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
  cancel_at_period_end: false,
  canceled_at: null,
  trial_end: null,
});
let n = 0;
const deliver = (type: string, id: string) =>
  webhook.POST(
    new Request("https://app.rydar.app/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig-ok" },
      body: JSON.stringify({ id: `evt_${(n += 1)}`, type, data: { object: { id } } }),
    }),
  );
const org = () => h.db.organizations!.find((o) => o.id === ORG)!;

beforeEach(() => {
  h.subs.clear();
  h.fail = null;
  h.audits = [];
  h.lists = 0;
  h.db = {
    organizations: [{ id: ORG, name: "Centrale A", plan_id: P0, stripe_customer_id: "cus_1" }],
    plans: [
      { id: P0, code: "p0", is_active: true, stripe_price_monthly_id: null, stripe_price_yearly_id: null },
      { id: PRO, code: "pro", is_active: true, stripe_price_monthly_id: "price_pro_m", stripe_price_yearly_id: null },
    ],
    subscriptions: [],
    invoices: [],
  };
});

describe("webhook Stripe : un ancien abonnement ne rétrograde pas l'abonnement courant", () => {
  it("rétrogradation en échec (500), nouvel abonnement B, puis réessai de la fin de A : l'offre de B reste", async () => {
    h.subs.set("sub_A", sub("sub_A", "active"));
    expect((await deliver("customer.subscription.created", "sub_A")).status).toBe(200);
    expect(org().plan_id).toBe(PRO);
    h.subs.get("sub_A")!.status = "canceled";
    h.fail = { table: "organizations", op: "update" }; // panne transitoire pendant la rétrogradation
    expect((await deliver("customer.subscription.deleted", "sub_A")).status).toBe(500);
    h.subs.set("sub_B", sub("sub_B", "active", PRO)); // Checkout : previous_plan_id = offre actuelle
    expect((await deliver("customer.subscription.created", "sub_B")).status).toBe(200);
    expect((await deliver("customer.subscription.deleted", "sub_A")).status).toBe(200); // réessai Stripe
    expect(org().plan_id).toBe(PRO);
    expect(h.audits.filter((a) => a.action === "billing.plan_downgraded")).toEqual([]);
  });

  it("événement de A livré en retard ou en double après l'activation de B (sans panne) : aucune rétrogradation", async () => {
    h.subs.set("sub_A", sub("sub_A", "canceled"));
    h.db.subscriptions!.push({ organization_id: ORG, stripe_subscription_id: "sub_A", status: "canceled", plan_id: PRO });
    h.subs.set("sub_B", sub("sub_B", "active", PRO));
    await deliver("customer.subscription.created", "sub_B");
    expect(org().plan_id).toBe(PRO);
    expect((await deliver("customer.subscription.updated", "sub_A")).status).toBe(200);
    expect(org().plan_id).toBe(PRO);
  });

  it("B déjà actif chez Stripe mais son webhook pas encore traité : la fin de A ne rétrograde pas (mini-site préservé)", async () => {
    org().plan_id = PRO;
    h.subs.set("sub_A", sub("sub_A", "canceled"));
    h.subs.set("sub_B", sub("sub_B", "active", PRO));
    expect((await deliver("customer.subscription.deleted", "sub_A")).status).toBe(200);
    expect(org().plan_id).toBe(PRO);
    expect(h.lists).toBe(1);
  });

  it("autre abonnement vivant mais sans offre reliée (prix inconnu) : la fin de A rétrograde bien", async () => {
    org().plan_id = PRO;
    h.subs.set("sub_A", sub("sub_A", "canceled"));
    h.subs.set("sub_X", sub("sub_X", "active", null, "price_inconnu"));
    await deliver("customer.subscription.deleted", "sub_A");
    expect(org().plan_id).toBe(P0);
  });

  it("aucun autre abonnement : rétrogradation vers l'offre d'avant le paiement (inchangé)", async () => {
    org().plan_id = PRO;
    h.subs.set("sub_A", sub("sub_A", "canceled"));
    await deliver("customer.subscription.deleted", "sub_A");
    expect(org().plan_id).toBe(P0);
    expect(h.audits).toEqual([expect.objectContaining({ action: "billing.plan_downgraded" })]);
  });
});
