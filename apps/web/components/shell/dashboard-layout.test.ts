import { ORG_LEGAL_VERSION, PRIVATE_FLEET_OPEN_STATUSES } from "@rydar/shared";
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
  /** Conditions acceptées (CGV de l'organisation et CGU de la personne) ; faux : rien d'accepté (écran des CGV) */
  accepted: false,
  /** À la place de `accepted` : versions des CGV acceptées au nom de l'organisation (antérieure : bandeau de mise à jour) */
  orgVersions: null as string[] | null,
  /** À la place de `accepted` : documents acceptés à titre personnel (CGU, politique de confidentialité) */
  userDocuments: null as string[] | null,
  /** Réseau partagé (networkAccess) : null = interrupteur coupé et jamais membre */
  network: null as unknown,
  /** Courses sans chauffeur récentes (organisation standard) */
  noDriver: 2,
  /** Visite guidée : ligne de user_tours lue par la mise en page */
  tour: { data: null, error: null } as { data: unknown; error: unknown },
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
  if (read.table === "legal_acceptances") {
    // CGV au nom de l'organisation (« version ») ; CGU et politique de confidentialité à titre personnel (« document »)
    if (read.columns === "version") {
      const versions = h.orgVersions ?? (h.accepted ? [ORG_LEGAL_VERSION] : []);
      return { data: versions.map((version) => ({ version })), count: null, error: null };
    }
    const documents = h.userDocuments ?? (h.accepted ? ["cgu", "privacy"] : []);
    return { data: documents.map((document) => ({ document })), count: null, error: null };
  }
  // Compte brut des courses sans chauffeur (organisation standard)
  if (read.table === "rides" && read.head) return { data: null, count: h.noDriver, error: null };
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
      maybeSingle: async () => (table === "user_tours" ? h.tour : { data: null, error: null }),
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
vi.mock("@/lib/shared-network", () => ({ networkAccess: async () => (h.calls.push("networkAccess"), h.network) }));
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
  h.accepted = false;
  h.orgVersions = null;
  h.userDocuments = null;
  h.network = null;
  h.noDriver = 2;
  h.tour = { data: null, error: null };
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

// Visite guidée (docs/TUTORIEL.md § 4.2, § 5.3, § 6.11) : parcours du membre, progression lue pour l'utilisateur et ce
// parcours seulement, bloquée pendant une acceptation (écran des CGV, bandeau des CGU), différée tant qu'une action
// urgente est affichée (courses sans chauffeur ; Flotte Privée : réservations à traiter).
describe("mise en page du tableau de bord : visite guidée", () => {
  const tourReads = () => h.reads.filter((r) => r.table === "user_tours");
  const layout = async (ctx: ReturnType<typeof ctxFor>) => {
    h.ctx = ctx;
    return ((await DashboardLayout({ children: null })) as any).props.tour;
  };

  it("gérant d'une flotte dont l'organisation n'a jamais accepté les CGV : bloquée ; lecture filtrée par utilisateur et parcours", async () => {
    const tour = await layout(ctxFor(false));
    expect(tour).toEqual({
      key: "fleet",
      saved: null,
      blocked: true,
      urgent: true,
      scope: { userId: "u1", orgId: "org-1", driverId: null },
    });
    expect(tourReads()).toHaveLength(1);
    expect(tourReads()[0]!.columns).toBe("status, step, shown_at");
    expect(tourReads()[0]!.filters).toEqual([["eq", "user_id", "u1"], ["eq", "tour", "fleet"]]);
  });

  it("conditions acceptées, rien d'urgent : ni bloquée ni différée ; progression lue (étape, première ouverture)", async () => {
    h.accepted = true;
    h.noDriver = 0;
    h.tour = { data: { status: "active", step: 3, shown_at: "2026-10-11T08:00:00Z" }, error: null };
    const tour = await layout(ctxFor(false));
    expect(tour).toMatchObject({ key: "fleet", saved: { status: "active", step: 3, shown: true }, blocked: false, urgent: false });
  });

  it("courses sans chauffeur récentes (alerte rouge de « Courses ») : ouverture d'office différée", async () => {
    h.accepted = true;
    expect(await layout(ctxFor(false))).toMatchObject({ blocked: false, urgent: true });
  });

  it("Flotte Privée : parcours « private_fleet », réservations à traiter → différée, fiche du propriétaire dans la portée", async () => {
    h.accepted = true;
    const tour = await layout(ctxFor(true));
    expect(tour).toMatchObject({ key: "private_fleet", blocked: false, urgent: true, scope: { userId: "u1", orgId: "org-1", driverId: DRIVER } });
    expect(tourReads()[0]!.filters).toEqual([["eq", "user_id", "u1"], ["eq", "tour", "private_fleet"]]);
  });

  it("dispatcher : parcours « dispatcher » ; CGU à accepter (bandeau) → bloquée", async () => {
    const dispatcher = { ...ctxFor(false), role: "dispatcher" };
    expect(await layout(dispatcher)).toMatchObject({ key: "dispatcher", blocked: true });
    h.accepted = true;
    h.noDriver = 0;
    expect(await layout(dispatcher)).toMatchObject({ key: "dispatcher", blocked: false, urgent: false });
  });

  it("gérant d'une centrale : parcours « centrale »", async () => {
    h.accepted = true;
    h.noDriver = 0;
    const base = ctxFor(false);
    expect(await layout({ ...base, org: { ...base.org, dispatch_model: "centrale" } })).toMatchObject({ key: "centrale", blocked: false, urgent: false });
  });

  it("lecture de la progression en échec : inconnue (aucune ouverture d'office, menu gardé)", async () => {
    h.accepted = true;
    h.tour = { data: null, error: { code: "PGRST205", message: "user_tours introuvable" } };
    expect((await layout(ctxFor(false))).saved).toBeUndefined();
  });

  it("mise à jour des CGV à accepter (version antérieure acceptée) : bandeau, sans écran d'acceptation ; visite bloquée", async () => {
    h.accepted = true;
    h.noDriver = 0;
    h.orgVersions = ["2026-01-15"];
    expect("2026-01-15" < ORG_LEGAL_VERSION).toBe(true);
    h.ctx = ctxFor(false);
    const el = (await DashboardLayout({ children: null })) as any;
    // La page reste affichée (pas d'OrgTermsGate) avec le bandeau « mise à jour » des CGV
    expect(el.props.children).toBeNull();
    expect(el.props.topBanner.props).toMatchObject({ orgName: "Taxi Karim", updated: true });
    expect(el.props.tour).toMatchObject({ key: "fleet", blocked: true, urgent: false });
  });

  it("nouvelle convention du réseau partagé à accepter (bandeau du gérant) : ouverture d'office différée, jamais bloquée", async () => {
    h.accepted = true;
    h.noDriver = 0;
    h.network = networkOpen("2026-09-01");
    h.ctx = ctxFor(false);
    const el = (await DashboardLayout({ children: null })) as any;
    expect(el.props.topBanner.props).toMatchObject({ version: "2026-10-09", expired: false });
    expect(el.props.tour).toMatchObject({ key: "fleet", blocked: false, urgent: true });
    // Convention en vigueur déjà acceptée : ni bandeau ni urgence
    h.network = networkOpen("2026-10-09");
    expect(await layout(ctxFor(false))).toMatchObject({ blocked: false, urgent: false });
  });

  it("dispatcher, CGU acceptées, CGV de l'organisation jamais acceptées et convention du réseau à accepter : ni bloquée ni différée", async () => {
    h.userDocuments = ["cgu", "privacy"];
    h.orgVersions = [];
    h.noDriver = 0;
    h.network = networkOpen("2026-09-01");
    h.ctx = { ...ctxFor(false), role: "dispatcher" };
    const el = (await DashboardLayout({ children: null })) as any;
    // CGV et convention : affaires du gérant (owner / admin) — jamais lues ni affichées pour le dispatcher
    expect(h.reads.filter((r) => r.table === "legal_acceptances").map((r) => r.columns)).toEqual(["document"]);
    expect(el.props.children).toBeNull();
    expect(el.props.topBanner).toBeNull();
    expect(el.props.tour).toMatchObject({ key: "dispatcher", blocked: false, urgent: false });
  });
});

/**
 * Réseau partagé ouvert (networkAccess) : partage actif, nouvelle convention publiée le 9 octobre ; `accepted` : version
 * acceptée par l'organisation (la précédente, encore valable pendant le délai de grâce, ou la nouvelle).
 */
function networkOpen(accepted: string) {
  return {
    mode: "open",
    summary: {
      currency: "EUR",
      readiness: {
        enabled: true,
        share_out: { active: true, missing: [], warnings: [] },
        share_in: { active: false, missing: ["not_receiving"], warnings: [] },
        terms: { version: "2026-10-09", min_version: "2026-09-01", grace_until: "2099-01-01T00:00:00Z", accepted_version: accepted, accepted_at: null },
        approval: { status: "approved", requested_at: null, approved_at: null, refused_reason: null },
        suspended_reason: null,
      },
      given: {
        searching: 0,
        in_progress: 0,
        to_collect_cents: 0,
        to_confirm_count: 0,
        to_pay_cents: 0,
        to_check_count: 0,
        overdue_cents: 0,
        overdue_count: 0,
        disputed_count: 0,
      },
      received: { in_progress: 0, month_rides: 0 },
      badge: 0,
    },
  };
}
