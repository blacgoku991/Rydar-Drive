import "server-only";
import type { DispatchModel, DriverPresence, OrgRole, OrgStatus } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
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

type OrgRow = { id: string; name: string; slug: string; city: string | null; status: OrgStatus; dispatch_model: DispatchModel | null; brand_color: string | null };

async function loadOrgs(supabase: SupabaseClient): Promise<AdminLiveOrg[]> {
  const rows = await fetchAll<OrgRow>((from, to) =>
    supabase.from("organizations").select("id, name, slug, city, status, dispatch_model, brand_color").neq("status", "archived").order("name").order("id").range(from, to),
  );
  return rows.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    city: o.city,
    status: o.status,
    dispatch_model: o.dispatch_model ?? "fleet",
    color: orgColor(o.id, o.brand_color),
    code: orgCode(o.name),
  }));
}

// ----------------------------------------------------------------------------- carte en direct

const RIDE_FIELDS =
  "id, organization_id, number, status, type, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pickup_at, vehicle_category, passengers, driver_id, dispatch_wave";

/** Instantané de la carte en direct : chauffeurs en ligne de toutes les organisations + courses utiles. */
export async function getPlatformLive(supabase: SupabaseClient): Promise<AdminLiveSnapshot> {
  const horizon = new Date(Date.now() + 2 * 3600_000).toISOString();
  const [orgs, driverRows, waiting] = await Promise.all([
    loadOrgs(supabase),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("drivers")
        .select(
          "id, organization_id, number, first_name, last_name, phone, presence, current_ride_id, online_since, " +
            "vehicle:vehicles(brand, model, plate, color, category), location:driver_locations(lat, lng, heading, speed_mps, accuracy_m, updated_at)",
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

  return { orgs, drivers, rides: [...rides.values()], offers, serverTime: new Date().toISOString() };
}

/** Tracé d'une course (affiché quand on sélectionne le chauffeur ou l'épingle). */
export async function getRideRoute(supabase: SupabaseClient, rideId: string) {
  const { data, error } = await supabase.from("rides").select("id, route_polyline").eq("id", rideId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; route_polyline: string | null } | null;
}

// ----------------------------------------------------------------------------- effectifs

export type OrgHeadcount = AdminLiveOrg & {
  members: number;
  drivers_active: number;
  drivers_online: number;
  drivers_busy: number;
  applications: number;
  banned: number;
  rides_today: number;
};

export type PlatformHeadcount = {
  orgs: { total: number; fleet: number; centrale: number; active: number; suspended: number };
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
export async function getPlatformHeadcount(supabase: SupabaseClient, ridesToday: Record<string, number> = {}): Promise<PlatformHeadcount> {
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
    orgs.map((o) => [
      o.id,
      { ...o, members: 0, drivers_active: 0, drivers_online: 0, drivers_busy: 0, applications: 0, banned: 0, rides_today: Number(ridesToday[o.id] ?? 0) },
    ]),
  );
  const totals: PlatformHeadcount = {
    orgs: {
      total: orgs.length,
      fleet: orgs.filter((o) => o.dispatch_model !== "centrale").length,
      centrale: orgs.filter((o) => o.dispatch_model === "centrale").length,
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
    (a, b) => b.drivers_online - a.drivers_online || b.drivers_active - a.drivers_active || b.rides_today - a.rides_today || a.name.localeCompare(b.name, "fr"),
  );
  return totals;
}

