import { beforeEach, describe, expect, it, vi } from "vitest";

// Frais plateforme côté centrale : « J'ai payé », le retrait d'une déclaration et l'export du relevé visent la centrale
// que le tableau de bord affiche (même choix que requireOrg / getOrgContext : cookie → dernière utilisée → première
// ACTIVE), jamais une autre centrale du compte (contre-audit web_comptes#0).

const h = vi.hoisted(() => ({ cookie: null as string | null, session: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "rd_org" && h.cookie ? { value: h.cookie } : undefined) }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/jwt", async () => await import("../../lib/supabase/jwt"));
vi.mock("@/lib/auth", async () => ({ ...(await import("../../lib/auth")), getSession: async () => h.session }));

const { getPayerContext } = await import("./org-payer-context");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const org = (id: string, status: "active" | "suspended" | "archived", name: string) => ({
  id, name, slug: name.toLowerCase(), status, logo_url: null, timezone: "Europe/Paris", plan_id: null, dispatch_model: "centrale",
});
const session = (lastActive: string | null, memberships: { role: string; org: ReturnType<typeof org> }[]) => ({
  supabase: {},
  user: { id: "u1" },
  profile: { id: "u1", email: "gerant@exemple.fr", full_name: "Gérant", avatar_url: null, is_super_admin: false, last_active_org_id: lastActive },
  memberships,
  isDriver: false,
});

beforeEach(() => {
  h.cookie = null;
  h.session = null;
});

describe("getPayerContext : centrale visée par les frais plateforme", () => {
  it("sans cookie ni dernière centrale : la première centrale ACTIVE (celle du tableau de bord), pas la suspendue listée en premier", async () => {
    h.session = session(null, [
      { role: "dispatcher", org: org(A, "suspended", "Alpha") },
      { role: "admin", org: org(B, "active", "Bravo") },
    ]);
    const ctx = await getPayerContext();
    expect(ctx).toMatchObject({ org: { id: B }, role: "admin", canPay: true });
  });

  it("cookie de la centrale affichée : elle, même suspendue (page /suspended) ; cookie inconnu : première active", async () => {
    h.session = session(B, [
      { role: "owner", org: org(A, "suspended", "Alpha") },
      { role: "dispatcher", org: org(B, "active", "Bravo") },
    ]);
    h.cookie = A;
    expect(await getPayerContext()).toMatchObject({ org: { id: A }, role: "owner", canPay: true });
    h.cookie = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(await getPayerContext()).toMatchObject({ org: { id: B }, role: "dispatcher", canPay: false });
    // Sans cookie : dernière centrale utilisée
    h.cookie = null;
    expect(await getPayerContext()).toMatchObject({ org: { id: B } });
  });

  it("aucune centrale : null", async () => {
    h.session = session(null, []);
    expect(await getPayerContext()).toBeNull();
    h.session = null;
    expect(await getPayerContext()).toBeNull();
  });
});
