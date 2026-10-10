import { beforeEach, describe, expect, it, vi } from "vitest";

// getOrgContext (routes du tableau de bord) : même organisation que requireOrg, et la fiche chauffeur du compte n'est
// transmise que si elle appartient à CETTE organisation (recette Flotte Privée, L7 : elle était transmise telle quelle).

type Membership = { org: { id: string; status: string }; role: string };

const h = vi.hoisted(() => ({
  session: null as null | { memberships: Membership[]; profile: { last_active_org_id: string | null }; driverId: string | null; driverOrgId: string | null },
  cookies: {} as Record<string, string>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (h.cookies[k] ? { value: h.cookies[k] } : undefined) }) }));
vi.mock("@/lib/org-view", async () => await import("./org-view"));
vi.mock("@/lib/auth", () => ({
  ORG_COOKIE: "rd_org",
  getSession: async () => h.session,
  pickMembership: (ms: Membership[], wanted: string | null | undefined) =>
    ms.find((m) => m.org.id === wanted) ?? ms.find((m) => m.org.status === "active") ?? ms[0],
}));

import { getOrgContext } from "./org-context";

const ORG_A = "aaaaaaaa-0000-4000-a000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-a000-000000000002";

beforeEach(() => {
  h.cookies = {};
  h.session = {
    memberships: [
      { org: { id: ORG_A, status: "active" }, role: "owner" },
      { org: { id: ORG_B, status: "active" }, role: "admin" },
    ],
    profile: { last_active_org_id: null },
    // Fiche chauffeur du compte dans l'organisation A (Flotte Privée : la fiche du propriétaire)
    driverId: "driver-a",
    driverOrgId: ORG_A,
  };
});

describe("getOrgContext : fiche chauffeur de l'organisation affichée seulement", () => {
  it("organisation de la fiche : transmise", async () => {
    h.cookies = { rd_org: ORG_A, rd_view: ORG_A };
    const ctx = await getOrgContext();
    expect(ctx?.org.id).toBe(ORG_A);
    expect(ctx?.driverId).toBe("driver-a");
  });

  it("autre organisation du compte : null (jamais la fiche d'une autre organisation)", async () => {
    h.cookies = { rd_org: ORG_B, rd_view: ORG_B };
    const ctx = await getOrgContext();
    expect(ctx?.org.id).toBe(ORG_B);
    expect(ctx?.driverId).toBeNull();
  });

  it("organisation affichée différente de celle résolue : refus (inchangé)", async () => {
    h.cookies = { rd_org: ORG_A, rd_view: ORG_B };
    expect(await getOrgContext()).toBeNull();
  });
});
