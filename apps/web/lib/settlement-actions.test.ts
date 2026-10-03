import { beforeEach, describe, expect, it, vi } from "vitest";

// Encaissements (app/dashboard/settlements/actions.ts) : règlements PROPRES seulement. Une ligne du réseau partagé
// (network_driver_org_id non NULL) se traite dans « Réseau partagé » (argent réseau : owner / admin) — refusée avant
// tout appel à confirm_settlements / dispute_settlement / waive_settlement / reopen_settlement, même dans un lot
// mélangé, et dans TOUTES les organisations du membre (aucun filtre sur l'organisation affichée). Supabase simulé.

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  ctx: null as any,
  rpcCalls: [] as { fn: string; args: Row }[],
  /** Lignes réseau visibles (RLS) parmi les identifiants demandés */
  networkIds: new Set<string>(),
  selects: [] as { table: string; ids: string[]; filters: string[] }[],
  selectError: null as { code?: string; message?: string } | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({ isAdminRole: (role: string) => role === "owner" || role === "admin" }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));

const S = await import("../app/dashboard/settlements/actions");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWN = "44444444-4444-4444-8444-444444444444";
const NET = "55555555-5555-4555-8555-555555555555";

function context(role = "dispatcher") {
  return {
    org: { id: ORG, dispatch_model: "centrale", name: "Centrale A" },
    role,
    supabase: {
      async rpc(fn: string, args: Row) {
        h.rpcCalls.push({ fn, args });
        return { data: { ok: true, code: "OK", message: "" }, error: null };
      },
      from(table: string) {
        const q = { table, ids: [] as string[], filters: [] as string[] };
        h.selects.push(q);
        const b: any = {
          select: () => b,
          in(col: string, ids: string[]) {
            q.filters.push(`in:${col}`);
            q.ids = ids;
            return b;
          },
          eq(col: string) {
            q.filters.push(`eq:${col}`);
            return b;
          },
          not(col: string, op: string) {
            q.filters.push(`not:${col}:${op}`);
            return b;
          },
          limit: () => b,
          then: (resolve: (v: unknown) => void) =>
            resolve(h.selectError ? { data: null, error: h.selectError } : { data: q.ids.filter((id) => h.networkIds.has(id)).map((id) => ({ id })), error: null }),
        };
        return b;
      },
    },
  };
}

beforeEach(() => {
  h.ctx = context();
  h.rpcCalls = [];
  h.networkIds = new Set([NET]);
  h.selects = [];
  h.selectError = null;
});

const REFUSED = { ok: false, code: "NETWORK_SETTLEMENT", error: "Règlement du réseau partagé : à traiter dans l'onglet Réseau partagé." };

describe("Encaissements : jamais une ligne du réseau partagé", () => {
  it("dispatcher : « Reçu » et « Pas reçu » sur une ligne réseau refusés sans appel, même dans un lot mélangé", async () => {
    expect(await S.confirmSettlements([NET], "cash")).toEqual(REFUSED);
    expect(await S.confirmSettlements([OWN, NET], null)).toEqual(REFUSED);
    expect(await S.disputeSettlement(NET, "Rien reçu")).toEqual(REFUSED);
    expect(h.rpcCalls).toEqual([]);
    // Aucune restriction à l'organisation affichée : un membre de plusieurs organisations ne contourne pas la garde
    expect(h.selects.every((q) => q.table === "ride_settlements" && !q.filters.includes("eq:organization_id"))).toBe(true);
    expect(h.selects[0]!.filters).toContain("not:network_driver_org_id:is");
  });

  it("owner / admin : « Annuler » et « Rouvrir » sur une ligne réseau refusés (versement réseau : « Contester la course »)", async () => {
    h.ctx = context("owner");
    expect(await S.waiveSettlement(NET, "Geste commercial")).toEqual(REFUSED);
    expect(await S.reopenSettlement(NET)).toEqual(REFUSED);
    expect(h.rpcCalls).toEqual([]);
  });

  it("règlements propres : appel transmis comme avant", async () => {
    expect(await S.confirmSettlements([OWN], "transfer")).toMatchObject({ ok: true });
    expect(await S.disputeSettlement(OWN, "Rien reçu")).toMatchObject({ ok: true });
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(["confirm_settlements", "dispute_settlement"]);
  });

  it("lot de 500 : lu par paquets de 100 (URL bornée)", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await S.confirmSettlements(ids, null)).toMatchObject({ ok: true });
    expect(h.selects.map((q) => q.ids.length)).toEqual([100, 100, 50]);
  });

  it("garde illisible : refus (jamais d'action à l'aveugle)", async () => {
    h.selectError = { code: "XX000", message: "boom" };
    expect(await S.confirmSettlements([OWN], "cash")).toMatchObject({ ok: false, code: "ERROR" });
    expect(h.rpcCalls).toEqual([]);
  });
});
