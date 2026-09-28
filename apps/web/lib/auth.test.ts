import { beforeEach, describe, expect, it, vi } from "vitest";

// requireSuperAdmin : même règle que la base (public.session_is_super_admin, migration 20260924005400) — rôle donné à
// un compte existant par deploy/create-admin.sh, jeton émis avant la promotion → pas d'espace Super Admin.

const h = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  rpc: { data: true, error: null } as { data: unknown; error: unknown },
  rpcCalls: [] as string[],
  /** Erreur renvoyée par la lecture des adhésions (organization_users) : base ou API injoignable */
  listError: null as { message: string } | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "sa@rydar.test" } } }) },
    from: (table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: table === "users" ? h.profile : null, error: null }),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve(h.listError ? { data: null, error: h.listError } : { data: [], error: null }).then(ok, ko),
      };
      return b;
    },
    rpc: async (fn: string) => {
      h.rpcCalls.push(fn);
      return h.rpc;
    },
  }),
}));

const { getSession, requireSuperAdmin } = await import("./auth");

beforeEach(() => {
  h.profile = { id: "u1", email: "sa@rydar.test", full_name: "Super Admin", avatar_url: null, is_super_admin: true, last_active_org_id: null };
  h.rpc = { data: true, error: null };
  h.rpcCalls.length = 0;
  h.listError = null;
});

describe("requireSuperAdmin", () => {
  it("rôle et jeton reconnus par la base : accès", async () => {
    const session = await requireSuperAdmin();
    expect(session.user.id).toBe("u1");
    expect(h.rpcCalls).toEqual(["session_is_super_admin"]);
  });

  it("jeton émis avant la promotion (refusé par la base) : jamais l'espace Super Admin (page sans espace, sans boucle)", async () => {
    h.rpc = { data: false, error: null };
    await expect(requireSuperAdmin()).rejects.toThrow("REDIRECT /no-access");
  });

  it("compte sans le rôle : tableau de bord, sans appel", async () => {
    h.profile = { ...h.profile, is_super_admin: false };
    await expect(requireSuperAdmin()).rejects.toThrow("REDIRECT /dashboard");
    expect(h.rpcCalls).toEqual([]);
  });

  it("contrôle impossible : erreur, jamais d'accès", async () => {
    h.rpc = { data: null, error: { message: "délai dépassé" } };
    await expect(requireSuperAdmin()).rejects.toThrow(/Contrôle du rôle Super Admin impossible/);
  });
});

describe("Session : base injoignable", () => {
  it("lecture des adhésions en échec : erreur (page « Réessayer »), jamais « Aucun espace associé »", async () => {
    h.listError = { message: "connexion refusée" };
    await expect(getSession()).rejects.toThrow(/Session illisible/);
  });

  it("lecture réussie et vide : session sans centrale (page sans espace, comportement normal)", async () => {
    const session = await getSession();
    expect(session?.memberships).toEqual([]);
  });
});
