import { beforeEach, describe, expect, it, vi } from "vitest";

// Mise en page du tableau de bord (app/dashboard/layout.tsx), docs/FLOTTE-PRIVEE.md § 7.5 : en Flotte Privée, ni
// messagerie, ni documents à valider, ni compteurs de centrale, ni réseau partagé, ni mini-sites — les pastilles « à
// traiter » et « documents à renouveler » à la place ; alerte « sans chauffeur », CGV / CGU et frais Rydar gardés.
// Organisation standard : lectures inchangées. Vraie mise en page, lectures simulées.

const h = vi.hoisted(() => ({
  ctx: null as any,
  calls: [] as string[],
  tables: [] as string[],
}));

const supabase = {
  from(table: string) {
    h.tables.push(table);
    const b: any = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      in: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: table === "legal_acceptances" ? [] : null, count: 2, error: null }).then(ok),
    };
    return b;
  },
  rpc: async (fn: string) => (h.calls.push(`rpc:${fn}`), { data: true, error: null }),
};

const record = <T,>(name: string, value: T) => async () => (h.calls.push(name), value);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireOrg: async () => h.ctx, isAdminRole: (r: string) => r === "owner" || r === "admin" }));
vi.mock("@/lib/private-fleet", async () => await import("../../lib/private-fleet"));
vi.mock("@/lib/legal", () => ({ LEGAL_VERSION: "2026-10-02", ORG_LEGAL_EFFECTIVE_AT: "2026-11-05" }));
vi.mock("@/lib/booking-sites", () => ({ bookingSitesEnabled: record("bookingSitesEnabled", false) }));
vi.mock("@/lib/queries/pending-documents", () => ({ countPendingDocuments: record("countPendingDocuments", 0) }));
vi.mock("@/lib/shared-network", () => ({ networkAccess: record("networkAccess", null) }));
vi.mock("@/app/dashboard/messages/queries", () => ({ loadChatCounts: record("loadChatCounts", { unread: 0, openReports: 0 }) }));
vi.mock("@/components/settlements/counts", () => ({ fetchCentraleCounts: record("fetchCentraleCounts", null) }));
vi.mock("@/components/private-fleet/queue", () => ({
  countToTreat: record("countToTreat", 4),
  countExpiringDocuments: record("countExpiringDocuments", 1),
}));
vi.mock("@/components/network-share/access", async () => await import("../network-share/access"));
vi.mock("@/components/network-share/nav", async () => await import("../network-share/nav"));
vi.mock("@/components/network-share/readiness", async () => await import("../network-share/readiness"));
vi.mock("@/components/network-share/terms-banner", () => ({ NetworkTermsBanner: () => null }));
vi.mock("@/components/legal/terms-state", async () => await import("../legal/terms-state"));
vi.mock("@/components/legal/terms-banner", () => ({ OrgTermsGate: () => null, TermsBanner: () => null, UserTermsBanner: () => null }));
vi.mock("@/components/shell/dashboard-shell", () => ({ DashboardShell: () => null }));

const { default: DashboardLayout } = await import("../../app/dashboard/layout");

const ctxFor = (privateFleet: boolean) => ({
  supabase,
  user: { id: "u1" },
  profile: { full_name: "Karim B.", email: "karim@example.test", is_super_admin: false },
  org: { id: "org-1", name: "Taxi Karim", status: "active", timezone: "Europe/Paris", plan_id: null, dispatch_model: "fleet", private_fleet: privateFleet },
  role: "owner",
  memberships: [{ role: "owner", org: { id: "org-1", name: "Taxi Karim" } }],
  driverId: privateFleet ? "driver-1" : null,
});

beforeEach(() => {
  h.calls.length = 0;
  h.tables.length = 0;
});

describe("mise en page du tableau de bord", () => {
  it("Flotte Privée : aucune lecture inutile ; pastilles « à traiter » et « documents à renouveler »", async () => {
    h.ctx = ctxFor(true);
    const el = (await DashboardLayout({ children: null })) as any;
    for (const unused of ["loadChatCounts", "countPendingDocuments", "fetchCentraleCounts", "networkAccess", "bookingSitesEnabled"]) {
      expect(h.calls).not.toContain(unused);
    }
    expect(h.calls).toEqual(expect.arrayContaining(["countToTreat", "countExpiringDocuments", "rpc:org_platform_fees_enabled"]));
    // Réglages de centrale jamais lus (modèle flotte)
    expect(h.tables).not.toContain("organization_settings");
    // Gardés : alerte « sans chauffeur », CGV / accord de traitement, CGU
    expect(h.tables.filter((t) => t === "rides").length).toBeGreaterThanOrEqual(1);
    expect(h.tables.filter((t) => t === "legal_acceptances")).toHaveLength(2);
    expect(el.props.privateFleet).toEqual({ driverId: "driver-1", toTreat: 4, expiringDocuments: 1 });
    expect(el.props.alerts).toBe(2);
    expect(el.props.sharedNetwork).toBeNull();
    expect(el.props.bookingSites).toBe(false);
  });

  it("organisation standard : lectures inchangées, aucun compteur Flotte Privée", async () => {
    h.ctx = ctxFor(false);
    const el = (await DashboardLayout({ children: null })) as any;
    expect(h.calls).toEqual(
      expect.arrayContaining(["loadChatCounts", "countPendingDocuments", "fetchCentraleCounts", "networkAccess", "bookingSitesEnabled"]),
    );
    expect(h.calls).not.toContain("countToTreat");
    expect(h.calls).not.toContain("countExpiringDocuments");
    expect(el.props.privateFleet).toBeNull();
  });
});
