import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { getLiveSnapshot } from "./live";

vi.mock("server-only", () => ({}));

type Call = [method: string, ...args: any[]];
type Result = { data: unknown; error: { message: string } | null };
type Handler = (calls: Call[]) => Result;

/** Faux client supabase-js : chaque requête enregistre ses appels, `await` la résout via le gestionnaire de la table. */
function fakeClient(tables: Record<string, Handler>, rpc?: (fn: string, args: Record<string, unknown>) => Result): SupabaseClient {
  const query = (table: string) => {
    const calls: Call[] = [];
    const builder: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then")
            return (resolve: (r: Result) => void, reject: (e: unknown) => void) => {
              try {
                resolve((tables[table] ?? (() => ({ data: [], error: null })))(calls));
              } catch (e) {
                reject(e);
              }
            };
          return (...args: any[]) => {
            calls.push([prop, ...args]);
            return builder;
          };
        },
      },
    );
    return builder;
  };
  return {
    from: query,
    rpc: async (fn: string, args: Record<string, unknown>) => (rpc ? rpc(fn, args) : { data: null, error: null }),
  } as unknown as SupabaseClient;
}

const arg = (calls: Call[], method: string) => calls.find((c) => c[0] === method);

function ride(id: string, status = "SEARCHING_DRIVER") {
  return { id, status, pickup_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T07:00:00Z" };
}

/** Table ride_offers simulée : filtre `in("ride_id")`, `range()` et max_rows = 1 000 comme PostgREST. */
function offersTable(all: { id: string; ride_id: string }[]) {
  const seen: { ids: string[]; from: number; to: number }[] = [];
  const handler: Handler = (calls) => {
    const ids = arg(calls, "in")![2] as string[];
    const range = arg(calls, "range");
    const from = range ? (range[1] as number) : 0;
    const to = range ? (range[2] as number) : Number.MAX_SAFE_INTEGER;
    seen.push({ ids, from, to });
    const rows = all.filter((o) => ids.includes(o.ride_id)).sort((a, b) => a.id.localeCompare(b.id));
    return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
  };
  return { handler, seen };
}

const pad = (n: number) => String(n).padStart(6, "0");

describe("getLiveSnapshot", () => {
  it("lecture en échec (délai dépassé) : lève au lieu de renvoyer un instantané vide", async () => {
    const client = fakeClient({
      drivers: () => ({ data: [{ id: "d1" }], error: null }),
      rides: (calls) =>
        arg(calls, "not") ? { data: null, error: { message: "canceling statement due to statement timeout" } } : { data: [], error: null },
    });
    await expect(getLiveSnapshot(client, "org")).rejects.toThrow(/courses actives/);
  });

  it("offres flotte au-delà de 1 000 : toutes renvoyées (pages de 1 000, ordre stable)", async () => {
    const offers = [
      ...Array.from({ length: 1500 }, (_, i) => ({ id: `a-${pad(i)}`, ride_id: "r1" })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `b-${pad(i)}`, ride_id: "r2" })),
    ];
    const table = offersTable(offers);
    const client = fakeClient({
      rides: (calls) => (arg(calls, "not") ? { data: [ride("r1"), ride("r2", "OFFERED"), ride("r3", "ACCEPTED")], error: null } : { data: [], error: null }),
      ride_offers: table.handler,
    });
    const snap = await getLiveSnapshot(client, "org");
    expect(snap.offers).toHaveLength(1530);
    expect(new Set(snap.offers.map((o) => o.id)).size).toBe(1530);
    expect(table.seen.map((s) => [s.from, s.to])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(table.seen[0]!.ids).toEqual(["r1", "r2"]);
  });

  it("beaucoup de courses en recherche : identifiants par paquets de 100", async () => {
    const rides = Array.from({ length: 250 }, (_, i) => ride(`r${pad(i)}`));
    const table = offersTable(rides.map((r) => ({ id: `o-${r.id}`, ride_id: r.id })));
    const client = fakeClient({
      rides: (calls) => (arg(calls, "not") ? { data: rides, error: null } : { data: [], error: null }),
      ride_offers: table.handler,
    });
    const snap = await getLiveSnapshot(client, "org");
    expect(snap.offers).toHaveLength(250);
    expect(table.seen.map((s) => s.ids.length).sort((a, b) => a - b)).toEqual([50, 100, 100]);
  });

  it("tracés : seulement ceux des courses client à bord (les autres sont chargés à la demande)", async () => {
    const selects: string[] = [];
    const client = fakeClient({
      rides: (calls) => {
        const select = String(arg(calls, "select")?.[1] ?? "");
        selects.push(select);
        if (select === "id, route_polyline") return { data: [{ id: "r2", route_polyline: "abc" }], error: null };
        return arg(calls, "not")
          ? { data: [ride("r1", "ACCEPTED"), ride("r2", "PASSENGER_ONBOARD"), ride("r3", "IN_PROGRESS")], error: null }
          : { data: [], error: null };
      },
    });
    const snap = await getLiveSnapshot(client, "org");
    const byId = Object.fromEntries(snap.rides.map((r) => [r.id, r]));
    expect("route_polyline" in byId.r1!).toBe(false);
    expect(byId.r2!.route_polyline).toBe("abc");
    expect(byId.r3!.route_polyline).toBeNull();
    // Les listes de courses ne lisent jamais la colonne du tracé
    expect(selects.filter((s) => s !== "id, route_polyline").every((s) => !s.includes("route_polyline"))).toBe(true);
  });

  it("erreur sur les offres : lève aussi", async () => {
    const client = fakeClient({
      rides: (calls) => (arg(calls, "not") ? { data: [ride("r1")], error: null } : { data: [], error: null }),
      ride_offers: () => ({ data: null, error: { message: "fetch failed" } }),
    });
    await expect(getLiveSnapshot(client, "org")).rejects.toThrow(/offres/);
  });
});

describe("getLiveSnapshot — réseau partagé (lu seulement s'il sert)", () => {
  const ORG = "org-a";
  const calls: string[] = [];
  const rpc = (replies: Record<string, Result>) => (fn: string) => {
    calls.push(fn);
    return replies[fn] ?? { data: null, error: null };
  };
  const located = { lat: 48.85, lng: 2.35, heading: null, speed_mps: null, updated_at: "2026-10-01T07:59:00Z" };

  it("organisation qui n'a jamais touché le réseau : aucune lecture réseau, instantané inchangé", async () => {
    calls.length = 0;
    const client = fakeClient(
      {
        drivers: () => ({ data: [{ id: "d1", current_ride_id: "r1", location: located }], error: null }),
        rides: (c) => (arg(c, "not") ? { data: [{ ...ride("r1", "ACCEPTED"), driver_id: "d1", driver_org_id: ORG, network_at: null }], error: null } : { data: [], error: null }),
      },
      rpc({}),
    );
    const snap = await getLiveSnapshot(client, ORG);
    expect(calls).toEqual(["org_kpis"]);
    expect("partners" in snap).toBe(false);
    expect(snap.drivers[0]!.location).toEqual(located);
    expect(snap.drivers[0]!.network_giver).toBeUndefined();
  });

  it("A : course tenue par le chauffeur d'une autre organisation → noms des partenaires (« Réseau · Flotte B »)", async () => {
    calls.length = 0;
    const client = fakeClient(
      { rides: (c) => (arg(c, "not") ? { data: [{ ...ride("r1", "ACCEPTED"), driver_id: "x9", driver_org_id: "org-b" }], error: null } : { data: [], error: null }) },
      rpc({ network_partner_names: { data: { "org-b": "Flotte B" }, error: null } }),
    );
    const snap = await getLiveSnapshot(client, ORG);
    expect(calls.sort()).toEqual(["network_partner_names", "org_kpis"]);
    expect(snap.partners).toEqual({ "org-b": "Flotte B" });
  });

  it("B : chauffeur en course partenaire → « En course partenaire (Taxi A) », jamais de position (Q5)", async () => {
    calls.length = 0;
    const client = fakeClient(
      {
        drivers: () => ({ data: [{ id: "d1", current_ride_id: "ride-de-a", location: located }, { id: "d2", current_ride_id: null, location: located }], error: null }),
        rides: () => ({ data: [], error: null }),
      },
      rpc({
        org_network_activity: {
          data: { on_ride: [{ driver: { id: "d1", number: 12, first_name: "Karim", last_name: "Benali" }, giver: { id: "org-a", name: "Taxi A" }, phase: "DRIVER_EN_ROUTE", since: "2026-10-01T07:50:00Z" }], scheduled: [] },
          error: null,
        },
      }),
    );
    const snap = await getLiveSnapshot(client, "org-b");
    expect(calls.sort()).toEqual(["org_kpis", "org_network_activity"]);
    const byId = Object.fromEntries(snap.drivers.map((d) => [d.id, d]));
    expect(byId.d1).toMatchObject({ network_giver: "Taxi A", location: null });
    expect(byId.d2!.location).toEqual(located);
  });

  it("lecture réseau en échec : l'instantané est servi quand même, sans étiquette", async () => {
    const client = fakeClient(
      {
        drivers: () => ({ data: [{ id: "d1", current_ride_id: "ride-de-a", location: null }], error: null }),
        rides: (c) => (arg(c, "not") ? { data: [{ ...ride("r1", "ACCEPTED"), driver_id: "x9", driver_org_id: "org-b" }], error: null } : { data: [], error: null }),
      },
      () => ({ data: null, error: { message: "function org_network_activity does not exist" } }),
    );
    const snap = await getLiveSnapshot(client, ORG);
    expect(snap.rides).toHaveLength(1);
    expect("partners" in snap).toBe(false);
    expect(snap.drivers[0]!.network_giver).toBeUndefined();
  });
});
