import { beforeEach, describe, expect, it, vi } from "vitest";

// Page « Inscriptions » (flotte) / « Réseau » (centrale) : vraies actions serveur de app/dashboard/network/actions.ts,
// Supabase simulé. Flotte : validation toujours « confirmé » (le niveau demandé est ignoré, comme en base) ; centrale :
// niveau choisi ; lien d'inscription réglable dans les deux modèles ; owner / admin seulement.

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  ctx: null as any,
  rpcCalls: [] as { fn: string; args: Row }[],
  rpcReply: {} as Record<string, unknown>,
  audits: [] as Row[],
  unbanned: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: async (entry: Row) => void h.audits.push(entry) }));
vi.mock("@/lib/auth", () => ({ isAdminRole: (role: string) => role === "owner" || role === "admin" }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { updateUserById: async (id: string) => void h.unbanned.push(id) } },
  }),
}));

const { approveApplication, updateJoinLink } = await import("../app/dashboard/network/actions");

const DRIVER = "33333333-3333-4333-8333-333333333333";

function context(model: "fleet" | "centrale", role = "owner") {
  const builder = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: table === "drivers" ? { id: DRIVER, user_id: "u-1", banned_at: null } : null, error: null }),
    };
    return b;
  };
  return {
    org: { id: "org-1", dispatch_model: model },
    role,
    user: { id: "manager-1" },
    supabase: {
      from: builder,
      async rpc(fn: string, args: Row) {
        h.rpcCalls.push({ fn, args });
        return { data: h.rpcReply[fn] ?? null, error: null };
      },
    },
  };
}

beforeEach(() => {
  h.rpcCalls = [];
  h.audits = [];
  h.unbanned = [];
  h.rpcReply = {
    approve_driver_application: { ok: true, code: "APPROVED", message: "Chauffeur validé : il peut recevoir des courses." },
    set_join_link: { ok: true, code: "UPDATED", join_code: "0123456789abcdef", join_enabled: true, join_auto_approve: false, dispatch_model: "fleet" },
  };
});

describe("approveApplication : niveau de confiance selon le modèle", () => {
  it("flotte : « confirmé » même si « nouveau » est demandé (journal compris)", async () => {
    h.ctx = context("fleet");
    expect(await approveApplication(DRIVER, "new")).toEqual({ ok: true, message: "Chauffeur validé : il peut recevoir des courses." });
    expect(h.rpcCalls).toEqual([{ fn: "approve_driver_application", args: { p_driver_id: DRIVER, p_trust_level: "trusted" } }]);
    expect(h.audits[0]).toMatchObject({ action: "driver.application_approved", entityId: DRIVER, metadata: { trust_level: "trusted" } });
    // Compte Auth du chauffeur désormais actif : bannissement Auth hérité levé
    expect(h.unbanned).toEqual(["u-1"]);
  });

  it("centrale : niveau choisi transmis tel quel", async () => {
    h.ctx = context("centrale");
    await approveApplication(DRIVER, "new");
    await approveApplication(DRIVER, "trusted");
    expect(h.rpcCalls.map((c) => c.args.p_trust_level)).toEqual(["new", "trusted"]);
  });

  it("dispatcher : refusé sans appel à la base ; demande invalide refusée", async () => {
    h.ctx = context("fleet", "dispatcher");
    expect(await approveApplication(DRIVER, "trusted")).toMatchObject({ ok: false });
    h.ctx = context("fleet");
    expect(await approveApplication("pas-un-uuid", "trusted")).toEqual({ ok: false, error: "Demande invalide." });
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("updateJoinLink : flotte comme centrale", () => {
  it("flotte : set_join_link appelé (plus de réservation au mode centrale), réglages renvoyés", async () => {
    h.ctx = context("fleet");
    expect(await updateJoinLink({ enabled: true, autoApprove: false })).toEqual({
      ok: true, join_code: "0123456789abcdef", join_enabled: true, join_auto_approve: false,
    });
    expect(h.rpcCalls).toEqual([{ fn: "set_join_link", args: { p_org: "org-1", p_enabled: true, p_regenerate: false, p_auto_approve: false } }]);
  });

  it("dispatcher : refusé", async () => {
    h.ctx = context("fleet", "dispatcher");
    expect(await updateJoinLink({ enabled: true })).toEqual({ ok: false, error: "Réservé aux administrateurs (propriétaire ou admin)." });
    expect(h.rpcCalls).toEqual([]);
  });
});
