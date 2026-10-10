import { PRIVATE_FLEET_OPEN_STATUSES } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mise en page du tableau de bord (app/dashboard/layout.tsx), docs/FLOTTE-PRIVEE.md § 7.5 : en Flotte Privée, ni
// messagerie, ni documents à valider, ni compteurs de centrale, ni réseau partagé, ni mini-sites — les pastilles « à
// traiter », « non confirmées » et « documents à renouveler » à la place ; CGV / CGU et frais Rydar gardés.
// Organisation standard : lectures inchangées (dont l'alerte « sans chauffeur »). Vraie mise en page et vraie file des
// réservations (components/private-fleet/queue.ts), lectures simulées.

type Read = { table: string; columns: string; head: boolean; filters: unknown[][] };

const h = vi.hoisted(() => ({
  ctx: null as any,
  calls: [] as string[],
  reads: [] as Read[],
}));

const DRIVER = "driver-1";
const offer = (status: string) => ({ id: `o-${status}`, driver_id: DRIVER, status, sent_at: "2026-10-20T07:00:00Z", expires_at: "2026-10-22T07:00:00Z" });
/** Réservations sans chauffeur lues par la file (statut et offres du chauffeur-propriétaire). */
const QUEUE_ROWS = [
  // À confirmer : offre en attente
  { id: "r-1", status: "OFFERED", driver_id: null, pickup_at: "2026-10-22T08:00:00Z", offers: [offer("pending")] },
  // Refusée par le chauffeur lui-même : NO_DRIVER_FOUND tout de suite (H2), des jours avant la prise en charge
  { id: "r-2", status: "NO_DRIVER_FOUND", driver_id: null, pickup_at: "2026-10-23T08:00:00Z", offers: [offer("declined")] },
  // Non confirmée : échéance passée sans réponse
  { id: "r-3", status: "NO_DRIVER_FOUND", driver_id: null, pickup_at: "2026-10-20T09:00:00Z", offers: [offer("expired")] },
];

function reply(read: Read) {
  if (read.table === "legal_acceptances") return { data: [], count: null, error: null };
  // Compte brut des courses sans chauffeur (organisation standard)
  if (read.table === "rides" && read.head) return { data: null, count: 2, error: null };
  if (read.table === "rides" && read.columns.includes("offers:ride_offers(")) return { data: QUEUE_ROWS, count: null, error: null };
  return { data: null, count: null, error: null };
}

const supabase = {
  from(table: string) {
    const read: Read = { table, columns: "", head: false, filters: [] };
    h.reads.push(read);
    const filter = (op: string) => (...args: unknown[]) => (read.filters.push([op, ...args]), b);
    const b: any = {
      select: (columns: string, opts?: { head?: boolean }) => ((read.columns = columns), (read.head = !!opts?.head), b),
      eq: filter("eq"),
      gt: filter("gt"),
      gte: filter("gte"),
      in: filter("in"),
      is: filter("is"),
      limit: filter("limit"),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(reply(read)).then(ok),
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
vi.mock("@/components/private-fleet/queue", async () => ({
  ...(await import("../private-fleet/queue")),
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
  driverId: privateFleet ? DRIVER : null,
});

/** Lectures des courses : compte brut « sans chauffeur » (head) et file des réservations (offres embarquées). */
const rawCounts = () => h.reads.filter((r) => r.table === "rides" && r.head);
const queueReads = () => h.reads.filter((r) => r.table === "rides" && r.columns.includes("offers:ride_offers("));

beforeEach(() => {
  h.calls.length = 0;
  h.reads.length = 0;
});

describe("mise en page du tableau de bord", () => {
  it("Flotte Privée : aucune lecture inutile ; pastilles « à traiter », « non confirmées » et « documents à renouveler »", async () => {
    h.ctx = ctxFor(true);
    const el = (await DashboardLayout({ children: null })) as any;
    for (const unused of ["loadChatCounts", "countPendingDocuments", "fetchCentraleCounts", "networkAccess", "bookingSitesEnabled"]) {
      expect(h.calls).not.toContain(unused);
    }
    expect(h.calls).toEqual(expect.arrayContaining(["countExpiringDocuments", "rpc:org_platform_fees_enabled"]));
    // Réglages de centrale jamais lus (modèle flotte)
    expect(h.reads.map((r) => r.table)).not.toContain("organization_settings");
    // Gardés : CGV / accord de traitement, CGU
    expect(h.reads.filter((r) => r.table === "legal_acceptances")).toHaveLength(2);
    // Une seule lecture des réservations sans chauffeur (statuts ouverts, offres) pour les deux pastilles
    expect(queueReads()).toHaveLength(1);
    expect(queueReads()[0]!.filters).toEqual(
      expect.arrayContaining([["eq", "organization_id", "org-1"], ["is", "driver_id", null], ["in", "status", [...PRIVATE_FLEET_OPEN_STATUSES]]]),
    );
    expect(el.props.privateFleet).toEqual({ driverId: DRIVER, toTreat: 2, notConfirmed: 1, expiringDocuments: 1 });
    expect(el.props.sharedNetwork).toBeNull();
    expect(el.props.bookingSites).toBe(false);
  });

  it("Flotte Privée : une réservation refusée par le chauffeur n'allume jamais l'alerte rouge (pas de compte brut NO_DRIVER_FOUND)", async () => {
    h.ctx = ctxFor(true);
    const el = (await DashboardLayout({ children: null })) as any;
    // Le compte brut compterait la réservation refusée (r-2) jusqu'à 6 h après sa prise en charge : jamais lu ici
    expect(rawCounts()).toEqual([]);
    expect(el.props.alerts).toBeUndefined();
    // Seule la non confirmée (r-3) ; la refusée n'est ni à traiter ni en alerte
    expect(el.props.privateFleet.notConfirmed).toBe(1);
  });

  it("organisation standard : lectures inchangées (alerte « sans chauffeur »), aucun compteur Flotte Privée", async () => {
    h.ctx = ctxFor(false);
    const el = (await DashboardLayout({ children: null })) as any;
    expect(h.calls).toEqual(
      expect.arrayContaining(["loadChatCounts", "countPendingDocuments", "fetchCentraleCounts", "networkAccess", "bookingSitesEnabled"]),
    );
    expect(h.calls).not.toContain("countExpiringDocuments");
    expect(queueReads()).toEqual([]);
    expect(rawCounts()).toHaveLength(1);
    expect(rawCounts()[0]!.filters).toEqual(expect.arrayContaining([["eq", "organization_id", "org-1"], ["eq", "status", "NO_DRIVER_FOUND"]]));
    expect(el.props.alerts).toBe(2);
    expect(el.props.privateFleet).toBeNull();
  });
});
