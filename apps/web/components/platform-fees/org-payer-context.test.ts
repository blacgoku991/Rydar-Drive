import { beforeEach, describe, expect, it, vi } from "vitest";

// Frais plateforme côté centrale : « J'ai payé », le retrait d'une déclaration et l'export du relevé visent la centrale
// que le tableau de bord affiche (même choix que requireOrg / getOrgContext : cookie → dernière utilisée → première
// ACTIVE), jamais une autre centrale du compte (contre-audit web_comptes#0).

const h = vi.hoisted(() => ({ cookie: null as string | null, view: null as string | null, session: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = name === "rd_org" ? h.cookie : name === "rd_view" ? h.view : null;
      return v ? { value: v } : undefined;
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/jwt", async () => await import("../../lib/supabase/jwt"));
vi.mock("@/lib/org-view", async () => await import("../../lib/org-view"));
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
  h.view = null;
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

  it("action (« J'ai payé ») : refusée si la centrale résolue n'est pas celle affichée (accès retiré page ouverte)", async () => {
    // Centrale A affichée (rd_org = rd_view = A), puis accès à A retiré : la session ne la contient plus, pickMembership
    // se rabat sur B. La page peut l'afficher, mais une écriture ne part jamais au nom de B (audit p5, onglets-2).
    h.session = session(A, [{ role: "admin", org: org(B, "active", "Bravo") }]);
    h.cookie = A;
    h.view = A;
    expect(await getPayerContext({ action: true })).toBeNull();
    expect(await getPayerContext()).toMatchObject({ org: { id: B } });
    // Centrale affichée = centrale résolue : accepté ; cookie absent (scripts, ancien onglet) : comportement antérieur
    h.view = B;
    expect(await getPayerContext({ action: true })).toMatchObject({ org: { id: B }, canPay: true });
    h.view = null;
    expect(await getPayerContext({ action: true })).toMatchObject({ org: { id: B } });
  });
});
