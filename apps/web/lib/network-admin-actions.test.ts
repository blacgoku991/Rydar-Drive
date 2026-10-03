import { beforeEach, describe, expect, it, vi } from "vitest";

// Super admin — /admin/reseau : vraies actions serveur (app/admin/reseau/actions.ts), Supabase simulé. Toujours
// requireSuperAdmin() puis RPC svc_* du service role avec p_actor = l'utilisateur (revérifié en base, audit en base).

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  superAdmin: true,
  rpcCalls: [] as { fn: string; args: Row }[],
  rpcReply: {} as Record<string, { data?: unknown; error?: { code?: string; message?: string } | null }>,
  revalidated: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string, type?: string) => void h.revalidated.push(type ? `${p} (${type})` : p) }));
vi.mock("@/lib/auth", () => ({
  requireSuperAdmin: async () => {
    if (!h.superAdmin) throw new Error("NEXT_REDIRECT");
    return { user: { id: "admin-1" } };
  },
}));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/components/network-share/admin", async () => await import("../components/network-share/admin"));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    async rpc(fn: string, args: Row) {
      h.rpcCalls.push({ fn, args });
      const r = h.rpcReply[fn] ?? {};
      return { data: r.data ?? null, error: r.error ?? null };
    },
  }),
}));

const A = await import("../app/admin/reseau/actions");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  h.superAdmin = true;
  h.rpcCalls = [];
  h.revalidated = [];
  h.rpcReply = {
    svc_set_shared_network_enabled: { data: { ok: true, enabled: true, changed: true, closed_offers: 0 } },
    svc_network_approve: { data: { ok: true, code: "APPROVED" } },
    svc_network_suspend: { data: { ok: true, code: "SUSPENDED", closed_offers: 2, released_rides: 1 } },
  };
});

describe("super admin seulement", () => {
  it("sans le rôle : aucune écriture (requireSuperAdmin redirige)", async () => {
    h.superAdmin = false;
    await expect(A.setSharedNetworkEnabled(true)).rejects.toThrow("NEXT_REDIRECT");
    await expect(A.reviewNetworkOrg({ orgId: ORG, approved: true })).rejects.toThrow("NEXT_REDIRECT");
    await expect(A.suspendNetworkOrg({ orgId: ORG, suspended: true, reason: "Versements en retard" })).rejects.toThrow("NEXT_REDIRECT");
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("interrupteur de la plateforme", () => {
  it("ouverture : svc_set_shared_network_enabled avec l'auteur, tableaux de bord relus", async () => {
    expect(await A.setSharedNetworkEnabled(true)).toMatchObject({ ok: true, enabled: true });
    expect(h.rpcCalls).toEqual([{ fn: "svc_set_shared_network_enabled", args: { p_actor: "admin-1", p_enabled: true } }]);
    expect(h.revalidated).toEqual(["/admin/reseau", "/dashboard (layout)"]);
  });

  it("fermeture : offres en attente retirées annoncées, courses acceptées au bout", async () => {
    h.rpcReply.svc_set_shared_network_enabled = { data: { ok: true, enabled: false, changed: true, closed_offers: 3 } };
    expect(await A.setSharedNetworkEnabled(false)).toEqual({
      ok: true,
      enabled: false,
      closedOffers: 3,
      message: "Réseau partagé fermé · 3 offres en attente retirées. Les courses déjà acceptées vont à leur terme.",
    });
  });

  it("valeur invalide refusée sans appel", async () => {
    expect(await A.setSharedNetworkEnabled("oui" as never)).toEqual({ ok: false, error: "Valeur invalide." });
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("validation des organisations", () => {
  it("valider avec dérogation « frais à 0 »", async () => {
    expect(await A.reviewNetworkOrg({ orgId: ORG, approved: true, feeWaiver: true })).toMatchObject({ ok: true });
    expect(h.rpcCalls).toEqual([
      { fn: "svc_network_approve", args: { p_actor: "admin-1", p_org: ORG, p_approved: true, p_fee_waiver: true, p_reason: null } },
    ]);
    expect(h.revalidated).toEqual(["/admin/reseau", `/admin/organizations/${ORG}`]);
  });

  it("refuser : motif obligatoire (5 caractères au moins), jamais de dérogation", async () => {
    const res = await A.reviewNetworkOrg({ orgId: ORG, approved: false, reason: "non" });
    expect(res).toMatchObject({ ok: false, fieldErrors: { reason: "5 caractères au minimum" } });
    expect(h.rpcCalls).toEqual([]);
    h.rpcReply.svc_network_approve = { data: { ok: true, code: "REFUSED" } };
    expect(await A.reviewNetworkOrg({ orgId: ORG, approved: false, reason: " n° VTC introuvable au registre " })).toMatchObject({ ok: true });
    expect(h.rpcCalls[0]!.args).toEqual({ p_actor: "admin-1", p_org: ORG, p_approved: false, p_fee_waiver: false, p_reason: "n° VTC introuvable au registre" });
  });

  it("fiche incomplète : champs à compléter nommés", async () => {
    h.rpcReply.svc_network_approve = { data: { ok: false, code: "IDENTITY_INCOMPLETE", missing: ["siret", "vtc_registration"] } };
    expect(await A.reviewNetworkOrg({ orgId: ORG, approved: true })).toEqual({
      ok: false,
      error: "Fiche de l'organisation incomplète : SIRET, n° d'inscription au registre VTC. Elle doit la compléter dans ses réglages.",
    });
  });

  it("organisation invalide refusée sans appel", async () => {
    expect(await A.reviewNetworkOrg({ orgId: "x", approved: true })).toMatchObject({ ok: false });
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("suspension", () => {
  it("suspendre : manquement motivé, courses non commencées remises en recherche", async () => {
    expect(await A.suspendNetworkOrg({ orgId: ORG, suspended: true, reason: "Versements aux partenaires en retard" })).toEqual({
      ok: true,
      message: "Participation suspendue · 1 course non commencée remise en recherche.",
    });
    expect(h.rpcCalls).toEqual([
      { fn: "svc_network_suspend", args: { p_actor: "admin-1", p_org: ORG, p_suspended: true, p_reason: "Versements aux partenaires en retard" } },
    ]);
  });

  it("suspendre sans motif : refusé sans appel ; rétablir : motif facultatif", async () => {
    expect(await A.suspendNetworkOrg({ orgId: ORG, suspended: true, reason: "" })).toMatchObject({ ok: false, fieldErrors: { reason: "5 caractères au minimum" } });
    expect(h.rpcCalls).toEqual([]);
    h.rpcReply.svc_network_suspend = { data: { ok: true, code: "RESTORED" } };
    expect(await A.suspendNetworkOrg({ orgId: ORG, suspended: false })).toEqual({ ok: true, message: "Participation rétablie." });
    expect(h.rpcCalls[0]!.args).toEqual({ p_actor: "admin-1", p_org: ORG, p_suspended: false, p_reason: null });
  });

  it("erreur de la base : message lisible", async () => {
    h.rpcReply.svc_network_suspend = { error: { code: "42501", message: "FORBIDDEN" } };
    expect(await A.suspendNetworkOrg({ orgId: ORG, suspended: true, reason: "Manquement à la convention" })).toEqual({ ok: false, error: "Accès refusé." });
  });
});
