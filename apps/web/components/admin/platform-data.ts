import "server-only";
import { DISPATCH_MODEL_META, type DispatchModel, type DriverPresence, type OrgRole, type OrgStatus, type Tone } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import type { AdminTodo } from "./admin-todo";
import {
  BUSY_PRESENCES, ONLINE_PRESENCES, orgCode, orgColor,
  type AdminLiveDriver, type AdminLiveOffer, type AdminLiveOrg, type AdminLiveRide, type AdminLiveSnapshot,
} from "./live-types";

// Lectures « plateforme » du super admin avec SA session (RLS : private.is_super_admin() ouvre la
// lecture de organizations, organization_users, users, drivers, vehicles, driver_locations et rides).
// Aucune clé service : un compte qui perd le rôle super admin ne lit plus rien.

/** Taille de page = max_rows par défaut de PostgREST / Supabase (supabase/config.toml). */
const PAGE = 1000;
type PageResult = { data: unknown[] | null; error: { message: string } | null };

/** Lit toutes les lignes d'une requête par pages de 1 000 (ordre stable exigé). */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PageResult>, cap = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
/** Paquets de 100 identifiants (filtre `in` dans l'URL). */
function chunk(ids: string[], size = 100) {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  status: OrgStatus;
  dispatch_model: DispatchModel | null;
  private_fleet: boolean | null;
  brand_color: string | null;
};

/** Organisation non archivée, avec le drapeau Flotte Privée (effectifs, tableau « Clients » de la vue d'ensemble). */
type LoadedOrg = AdminLiveOrg & { private_fleet: boolean };

async function loadOrgs(supabase: SupabaseClient): Promise<LoadedOrg[]> {
  const rows = await fetchAll<OrgRow>((from, to) =>
    supabase
      .from("organizations")
      .select("id, name, slug, city, status, dispatch_model, private_fleet, brand_color")
      .neq("status", "archived")
      .order("name")
      .order("id")
      .range(from, to),
  );
  return rows.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    city: o.city,
    status: o.status,
    dispatch_model: o.dispatch_model ?? "fleet",
    private_fleet: o.private_fleet === true,
    color: orgColor(o.id, o.brand_color),
    code: orgCode(o.name),
  }));
}

// ----------------------------------------------------------------------------- carte en direct

// Supervision technique du dispatch (accord de traitement, art. 4) : ni nom, ni téléphone, ni véhicule, ni vitesse
// des chauffeurs, ni adresse ni client des courses — numéro de fiche, organisation, présence, position, cap, catégorie.
const RIDE_FIELDS =
  "id, organization_id, number, status, type, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_at, vehicle_category, passengers, driver_id, dispatch_wave";

/** Instantané de la carte en direct : chauffeurs en ligne de toutes les organisations + courses utiles. */
export async function getPlatformLive(supabase: SupabaseClient): Promise<AdminLiveSnapshot> {
  const horizon = new Date(Date.now() + 2 * 3600_000).toISOString();
  const [orgs, driverRows, waiting] = await Promise.all([
    loadOrgs(supabase),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("drivers")
        .select(
          "id, organization_id, number, presence, current_ride_id, online_since, " +
            "vehicle:vehicles(category), location:driver_locations(lat, lng, heading, accuracy_m, updated_at)",
        )
        .eq("status", "active")
        .neq("presence", "offline")
        .order("id")
        .range(from, to),
    ),
    // Courses en attente de chauffeur dont le départ approche (les planifiées lointaines encombreraient la carte)
    supabase.from("rides").select(RIDE_FIELDS).in("status", ["SEARCHING_DRIVER", "OFFERED"]).lte("pickup_at", horizon).order("pickup_at").limit(500),
  ]);
  if (waiting.error) throw new Error(waiting.error.message);

  const orgIds = new Set(orgs.map((o) => o.id));
  const drivers = driverRows
    .map((d) => ({ ...d, vehicle: one(d.vehicle as AdminLiveDriver["vehicle"]), location: one(d.location as AdminLiveDriver["location"]) }) as AdminLiveDriver)
    .filter((d) => orgIds.has(d.organization_id));

  // Offres en attente des chauffeurs sollicités (par paquets : l'URL reste courte)
  const offered = drivers.filter((d) => d.presence === "offered").map((d) => d.id);
  const offerRes = await Promise.all(
    chunk(offered).map((ids) => supabase.from("ride_offers").select("driver_id, ride_id, expires_at").eq("status", "pending").in("driver_id", ids)),
  );
  const offers: AdminLiveOffer[] = [];
  for (const res of offerRes) {
    if (res.error) throw new Error(res.error.message);
    offers.push(...((res.data ?? []) as AdminLiveOffer[]));
  }

  // Courses en cours et courses proposées des chauffeurs affichés (hors courses en attente déjà lues)
  const rides = new Map<string, AdminLiveRide>();
  for (const r of (waiting.data ?? []) as AdminLiveRide[]) if (orgIds.has(r.organization_id)) rides.set(r.id, r);
  const missing = [...new Set([...drivers.map((d) => d.current_ride_id), ...offers.map((o) => o.ride_id)])].filter(
    (id): id is string => !!id && !rides.has(id),
  );
  const extra = await Promise.all(chunk(missing).map((ids) => supabase.from("rides").select(RIDE_FIELDS).in("id", ids)));
  for (const res of extra) {
    if (res.error) throw new Error(res.error.message);
    for (const r of (res.data ?? []) as AdminLiveRide[]) rides.set(r.id, r);
  }

  // Instantané inchangé pour la carte : organisations sans le drapeau Flotte Privée (lu pour la vue d'ensemble)
  const liveOrgs: AdminLiveOrg[] = orgs.map(({ private_fleet: _privateFleet, ...o }) => o);
  return { orgs: liveOrgs, drivers, rides: [...rides.values()], offers, serverTime: new Date().toISOString() };
}

/** Tracé d'une course (affiché quand on sélectionne le chauffeur ou l'épingle). */
export async function getRideRoute(supabase: SupabaseClient, rideId: string) {
  const { data, error } = await supabase.from("rides").select("id, route_polyline").eq("id", rideId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; route_polyline: string | null } | null;
}

// ----------------------------------------------------------------------------- effectifs

export type OrgHeadcount = LoadedOrg & {
  members: number;
  drivers_active: number;
  drivers_online: number;
  drivers_busy: number;
  applications: number;
  banned: number;
};

export type PlatformHeadcount = {
  /** Clients non archivés : flottes (hors Flotte Privée), centrales à commission, Flotte Privée */
  orgs: { total: number; fleet: number; centrale: number; privateFleet: number; active: number; suspended: number };
  drivers: {
    active: number;
    online: number;
    busy: number;
    applications: number;
    banned: number;
    suspended: number;
    byPresence: Record<(typeof ONLINE_PRESENCES)[number], number>;
  };
  members: { active: number; invited: number; byRole: Record<OrgRole, number> };
  superAdmins: number;
  perOrg: OrgHeadcount[];
};

type DriverCountRow = { organization_id: string; status: string; presence: DriverPresence; application_status: string | null; banned_at: string | null };
type MemberRow = { organization_id: string; role: OrgRole; status: "active" | "invited" | "disabled" };

/** Effectifs de la plateforme (organisations, chauffeurs, membres, super admins) et par organisation. */
export async function getPlatformHeadcount(supabase: SupabaseClient): Promise<PlatformHeadcount> {
  const [orgs, drivers, members, admins] = await Promise.all([
    loadOrgs(supabase),
    fetchAll<DriverCountRow>((from, to) =>
      supabase.from("drivers").select("organization_id, status, presence, application_status, banned_at").order("id").range(from, to),
    ),
    fetchAll<MemberRow>((from, to) => supabase.from("organization_users").select("organization_id, role, status").order("id").range(from, to)),
    supabase.from("users").select("id", { count: "exact", head: true }).eq("is_super_admin", true),
  ]);
  if (admins.error) throw new Error(admins.error.message);

  const per = new Map<string, OrgHeadcount>(
    orgs.map((o) => [o.id, { ...o, members: 0, drivers_active: 0, drivers_online: 0, drivers_busy: 0, applications: 0, banned: 0 }]),
  );
  const totals: PlatformHeadcount = {
    orgs: {
      total: orgs.length,
      fleet: orgs.filter((o) => clientKind(o) === "fleet").length,
      centrale: orgs.filter((o) => clientKind(o) === "centrale").length,
      privateFleet: orgs.filter((o) => clientKind(o) === "private").length,
      active: orgs.filter((o) => o.status === "active").length,
      suspended: orgs.filter((o) => o.status === "suspended").length,
    },
    drivers: {
      active: 0, online: 0, busy: 0, applications: 0, banned: 0, suspended: 0,
      byPresence: { available: 0, offered: 0, en_route: 0, arrived: 0, on_trip: 0 },
    },
    members: { active: 0, invited: 0, byRole: { owner: 0, admin: 0, dispatcher: 0 } },
    superAdmins: admins.count ?? 0,
    perOrg: [],
  };

  for (const d of drivers) {
    const o = per.get(d.organization_id);
    if (!o) continue; // organisation archivée
    if (d.application_status === "pending") {
      o.applications++;
      totals.drivers.applications++;
    }
    if (d.banned_at) {
      o.banned++;
      totals.drivers.banned++;
    } else if (d.status === "suspended") totals.drivers.suspended++;
    if (d.status !== "active") continue;
    o.drivers_active++;
    totals.drivers.active++;
    if (d.presence === "offline") continue;
    o.drivers_online++;
    totals.drivers.online++;
    if (d.presence in totals.drivers.byPresence) totals.drivers.byPresence[d.presence as keyof PlatformHeadcount["drivers"]["byPresence"]]++;
    if (BUSY_PRESENCES.has(d.presence)) {
      o.drivers_busy++;
      totals.drivers.busy++;
    }
  }
  for (const m of members) {
    const o = per.get(m.organization_id);
    if (!o) continue;
    if (m.status === "invited") totals.members.invited++;
    if (m.status !== "active") continue;
    o.members++;
    totals.members.active++;
    totals.members.byRole[m.role] = (totals.members.byRole[m.role] ?? 0) + 1;
  }

  totals.perOrg = [...per.values()].sort(
    (a, b) => b.drivers_online - a.drivers_online || b.drivers_active - a.drivers_active || a.name.localeCompare(b.name, "fr"),
  );
  return totals;
}

// ----------------------------------------------------------------------------- « À traiter » (vue d'ensemble, menu)

/** Compteur exact, ou null si la lecture a échoué (jamais un faux 0). */
const countOf = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));

/**
 * Compteurs de « À traiter » (vue d'ensemble) et des pastilles du menu (layout) : UNE fonction, sous cache() de React
 * (le layout et la page la lisent dans le même rendu avec le même client : une seule série de lectures). Lecture du
 * super admin via RLS : signalements de fraude à examiner ; paiements de frais Rydar déclarés à confirmer ; baisses de
 * frais à décider ; suppressions de compte en échec ou en retard (compteurs de admin_account_deletions, une seule ligne
 * lue) ; nouvelles demandes du formulaire de contact ; réseau partagé : organisations à valider (demande ou validation
 * perdue, un sens toujours demandé). Lecture en échec : null.
 */
export const getAdminTodo = cache(async (supabase: SupabaseClient): Promise<AdminTodo> => {
  const [reports, payments, reductions, deletions, contacts, network] = await Promise.all([
    supabase.from("fraud_reports").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("platform_payments").select("id", { count: "exact", head: true }).eq("status", "declared"),
    supabase.from("platform_fee_entries").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.rpc("admin_account_deletions", { p_limit: 1 }),
    supabase.from("contact_requests").select("id", { count: "exact", head: true }).eq("status", "new"),
    supabase
      .from("network_memberships")
      .select("organization_id", { count: "exact", head: true })
      .not("requested_at", "is", null)
      .is("approved_at", null)
      .is("refused_reason", null)
      .or("share_out.eq.true,share_in.eq.true"),
  ]);
  const d = (deletions.data ?? null) as { failed?: number; stalled?: number } | null;
  return {
    openReports: countOf(reports),
    declaredPayments: countOf(payments),
    pendingReductions: countOf(reductions),
    failedDeletions: deletions.error ? null : Number(d?.failed ?? 0) + Number(d?.stalled ?? 0),
    newContacts: countOf(contacts),
    networkToReview: countOf(network),
  };
});

// ----------------------------------------------------------------------------- vue d'ensemble (platform_overview)

/** Client dans platform_overview (organisations non archivées, activité calculée en base). */
export type OverviewOrg = {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  city: string | null;
  plan: string | null;
  /** Chauffeurs actifs, dont en ligne */
  drivers: number;
  drivers_online: number;
  rides_today: number;
  rides_30d: number;
  no_driver_7d: number;
  last_ride_at: string | null;
};

/** Réponse de public.platform_overview() (super admin). */
export type PlatformOverview = {
  totals: {
    drivers: number;
    drivers_online: number;
    rides_today: number;
    rides_month: number;
    active_rides: number;
    gmv_month_cents: number;
    mrr_cents: number;
    no_driver_24h: number;
    dispatch_errors_24h: number;
    notifications_failed_24h: number;
    security_events_7d: number;
  };
  organizations: OverviewOrg[];
  daily: { date: string; rides: number; completed: number }[];
  recent_errors: { id: number; organization_id: string; organization: string; ride_id: string | null; type: string; level: string; message: string; created_at: string }[];
};

/** Ligne du tableau « Clients » de la vue d'ensemble ; null : donnée non lue (« — », jamais 0). */
export type ClientActivityRow = {
  id: string;
  name: string;
  city: string | null;
  slug: string;
  status: OrgStatus;
  /** Type (effectifs) ; null si les effectifs n'ont pas pu être lus */
  kind: ClientKind | null;
  driversActive: number | null;
  driversOnline: number | null;
  /** Candidatures de chauffeurs en attente (effectifs) */
  applications: number | null;
  ridesToday: number | null;
  rides30d: number | null;
  noDriver7d: number | null;
  lastRideAt: string | null;
};

/**
 * Tableau « Clients » de la vue d'ensemble : fusion de l'activité (platform_overview : courses, sans chauffeur,
 * dernière course) et des effectifs (type, chauffeurs actifs et en ligne, candidatures). Une source illisible (null)
 * laisse ses colonnes vides, l'autre reste affichée. Tri : courses du jour, chauffeurs en ligne, courses sur 30 jours,
 * puis nom.
 */
export function clientActivityRows(overview: OverviewOrg[] | null, headcount: OrgHeadcount[] | null): ClientActivityRow[] {
  const activity = new Map((overview ?? []).map((o) => [o.id, o]));
  const people = new Map((headcount ?? []).map((o) => [o.id, o]));
  const ids = [...new Set([...activity.keys(), ...people.keys()])];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const rows = ids.map((id): ClientActivityRow => {
    const a = activity.get(id);
    const p = people.get(id);
    return {
      id,
      name: (p?.name ?? a?.name)!,
      city: p?.city ?? a?.city ?? null,
      slug: (p?.slug ?? a?.slug)!,
      status: (p?.status ?? a?.status)!,
      kind: p ? clientKind(p) : null,
      driversActive: p ? p.drivers_active : num(a?.drivers),
      driversOnline: p ? p.drivers_online : num(a?.drivers_online),
      applications: p ? p.applications : null,
      ridesToday: a ? num(a.rides_today) : null,
      rides30d: a ? num(a.rides_30d) : null,
      noDriver7d: a ? num(a.no_driver_7d) : null,
      lastRideAt: a?.last_ride_at ?? null,
    };
  });
  const n = (v: number | null) => v ?? -1;
  return rows.sort(
    (x, y) =>
      n(y.ridesToday) - n(x.ridesToday) ||
      n(y.driversOnline) - n(x.driversOnline) ||
      n(y.rides30d) - n(x.rides30d) ||
      x.name.localeCompare(y.name, "fr"),
  );
}

// ----------------------------------------------------------------------------- liste des clients

/** Type de client : Flotte, Centrale à commission ou Flotte Privée (une flotte d'un seul chauffeur). */
export type ClientKind = "fleet" | "centrale" | "private";

export function clientKind(o: { dispatch_model?: DispatchModel | string | null; private_fleet?: boolean | null }): ClientKind {
  if (o.private_fleet === true) return "private";
  return o.dispatch_model === "centrale" ? "centrale" : "fleet";
}

/** Badge du type (un seul mot par chose : Flotte, Centrale à commission, Flotte Privée). */
export const CLIENT_KIND_META: Record<ClientKind, { label: string; tone: Tone }> = {
  fleet: { label: DISPATCH_MODEL_META.fleet.label, tone: "neutral" },
  centrale: { label: DISPATCH_MODEL_META.centrale.label, tone: "violet" },
  private: { label: "Flotte Privée", tone: "brand" },
};

/** Client de la liste (/admin/organizations), archivés compris. */
export type ClientListRow = {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  city: string | null;
  email: string | null;
  created_at: string;
  dispatch_model: DispatchModel | null;
  private_fleet: boolean;
  /** Nom de l'offre ; null : sans offre */
  plan: string | null;
};

type ClientListDbRow = Omit<ClientListRow, "plan" | "private_fleet"> & { private_fleet: boolean | null; plan: { name: string } | { name: string }[] | null };

/** Tous les clients, du plus récent au plus ancien : UNE lecture (par pages de 1 000), filtres et recherche en TypeScript. */
export async function getClientList(supabase: SupabaseClient): Promise<ClientListRow[]> {
  const rows = await fetchAll<ClientListDbRow>((from, to) =>
    supabase
      .from("organizations")
      .select("id, name, slug, status, city, email, created_at, dispatch_model, private_fleet, plan:plans(name)")
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to),
  );
  return rows.map((r) => ({ ...r, private_fleet: r.private_fleet === true, plan: one(r.plan)?.name ?? null }));
}

/** Filtres de la liste (?type=, clés d'URL stables : « flotte-privee » existait déjà). « Tous » = somme des trois types. */
export const CLIENT_FILTERS = [
  { key: "tous", label: "Tous" },
  { key: "flottes", label: "Flottes" },
  { key: "centrales", label: "Centrales" },
  { key: "flotte-privee", label: "Flotte Privée" },
  { key: "inactifs", label: "Suspendus et archivés" },
] as const;
export type ClientFilterKey = (typeof CLIENT_FILTERS)[number]["key"];

/** Filtre demandé par l'adresse ; inconnu ou absent : « Tous ». */
export function clientFilterOf(value: string | string[] | undefined): ClientFilterKey {
  const v = Array.isArray(value) ? value[0] : value;
  return CLIENT_FILTERS.find((f) => f.key === v)?.key ?? "tous";
}

export function matchesClientFilter(row: Pick<ClientListRow, "status" | "dispatch_model" | "private_fleet">, filter: ClientFilterKey): boolean {
  switch (filter) {
    case "flottes":
      return clientKind(row) === "fleet";
    case "centrales":
      return clientKind(row) === "centrale";
    case "flotte-privee":
      return clientKind(row) === "private";
    case "inactifs":
      return row.status === "suspended" || row.status === "archived";
    default:
      return true;
  }
}

/** Texte comparable : minuscules, sans accents ni espaces superflus. */
export function foldSearch(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Recherche (?q=) : chaque mot doit se trouver dans le nom, la ville, l'e-mail ou l'identifiant (casse et accents ignorés). */
export function matchesClientSearch(row: Pick<ClientListRow, "name" | "city" | "email" | "slug">, query: string | null | undefined): boolean {
  const words = foldSearch(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = foldSearch([row.name, row.city, row.email, row.slug].filter(Boolean).join(" "));
  return words.every((w) => haystack.includes(w));
}

/** Nombre de clients de chaque filtre (sur les clients qui répondent à la recherche). */
export function clientFilterCounts(rows: Pick<ClientListRow, "status" | "dispatch_model" | "private_fleet">[]): Record<ClientFilterKey, number> {
  const counts = Object.fromEntries(CLIENT_FILTERS.map((f) => [f.key, 0])) as Record<ClientFilterKey, number>;
  for (const row of rows) for (const f of CLIENT_FILTERS) if (matchesClientFilter(row, f.key)) counts[f.key]++;
  return counts;
}
