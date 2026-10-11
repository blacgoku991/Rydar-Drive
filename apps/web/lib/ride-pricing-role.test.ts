import { beforeEach, describe, expect, it, vi } from "vitest";

// Centrale : prix, commission et paiement d'une course qui a un règlement corrigés par le propriétaire et les
// administrateurs seulement (audit p5, base : private.rides_centrale_split, 20260924007900). Vraie action
// updateRidePricing, Supabase simulé : un dispatcher est refusé AVANT toute écriture, avec un message clair.

type Op = { table: string; action: string; values?: unknown };

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  settled: true,
  ctx: null as any,
}));

function fakeDb() {
  return {
    from(table: string) {
      const op: Op = { table, action: "select" };
      const reply = () => {
        h.ops.push(op);
        if (table === "rides" && op.action === "select") {
          return Promise.resolve({
            data: { price_cents: 5900, commission_cents: 1400, commission_manual: true, payment_method: "cash" },
            error: null,
          });
        }
        if (table === "ride_settlements") return Promise.resolve({ data: h.settled ? { id: "s1" } : null, error: null });
        return Promise.resolve({ data: null, error: null });
      };
      const b: any = {
        select: () => b,
        update: (v: unknown) => ((op.action = "update"), (op.values = v), b),
        eq: () => b,
        maybeSingle: () => reply(),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => reply().then(ok, ko),
      };
      return b;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/geocode", () => ({ geocodeOne: async () => null }));
vi.mock("@/lib/geo/routing", () => ({ rideRouteColumns: async () => ({}) }));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));

const { updateRidePricing } = await import("../app/dashboard/rides/actions");

const RIDE = "33333333-3333-4333-8333-333333333333";
const ctxFor = (role: string) => ({
  supabase: fakeDb(),
  user: { id: "u-1" },
  org: { id: "11111111-1111-4111-8111-111111111111", dispatch_model: "centrale", private_fleet: false },
  role,
});
const INPUT = { priceCents: 5900, commissionCents: 0, paymentMethod: "online" as const };

beforeEach(() => {
  h.ops.length = 0;
  h.settled = true;
});

describe("updateRidePricing : course réglée", () => {
  it("dispatcher : refusé avant toute écriture, message clair", async () => {
    h.ctx = ctxFor("dispatcher");
    const res = await updateRidePricing(RIDE, INPUT);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("propriétaire et les administrateurs") });
    expect(h.ops.filter((o) => o.action === "update")).toEqual([]);
  });

  it("administrateur : correction envoyée ; dispatcher sans règlement (avant la fin de course) : aussi", async () => {
    h.ctx = ctxFor("admin");
    expect(await updateRidePricing(RIDE, INPUT)).toEqual({ ok: true, changed: true });
    expect(h.ops.filter((o) => o.table === "rides" && o.action === "update")).toHaveLength(1);

    h.ops.length = 0;
    h.settled = false;
    h.ctx = ctxFor("dispatcher");
    expect(await updateRidePricing(RIDE, INPUT)).toEqual({ ok: true, changed: true });
    expect(h.ops.filter((o) => o.table === "rides" && o.action === "update")).toHaveLength(1);
  });
});
