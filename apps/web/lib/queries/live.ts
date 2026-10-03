import "server-only";
import type {
  FleetReportType, FlightMode, FlightStatus, NetworkPartnerNames, OrgKpis, OrgNetworkActivity, RideAlertData, RideAlertKind, RideAlertResolution,
  RideAlertSeverity, RideAlertStatus,
} from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export type LiveDriver = {
  id: string;
  number: number;
  first_name: string;
  last_name: string;
  phone: string;
  photo_url: string | null;
  presence: "offline" | "available" | "offered" | "en_route" | "arrived" | "on_trip";
  status: string;
  current_ride_id: string | null;
  online_since: string | null;
  vehicle: { brand: string | null; model: string; plate: string; color: string | null; category: string; seats: number } | null;
  location: { lat: number; lng: number; heading: number | null; speed_mps: number | null; updated_at: string } | null;
  /**
   * Réseau partagé, organisation du chauffeur (B) : course partenaire en cours pour l'organisation `network_giver`
   * (« En course partenaire (Taxi A) ») — position jamais montrée ni gardée pendant ce temps (Q5).
   */
  network_giver?: string | null;
};

export type LiveRide = {
  id: string;
  number: number;
  type: "instant" | "scheduled";
  status: string;
  source: string;
  dispatch_mode: string | null;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_at: string;
  customer_name: string;
  customer_phone?: string;
  passengers: number;
  luggage?: number;
  vehicle_category: string;
  price_cents: number | null;
  driver_id: string | null;
  dispatch_wave: number;
  dispatch_radius_m: number | null;
  next_dispatch_at: string | null;
  flight_number?: string | null;
  estimated_distance_m?: number | null;
  estimated_duration_s?: number | null;
  route_polyline?: string | null;
  payment_method?: string | null;
  accepted_at?: string | null;
  created_at: string;
  updated_at: string;
  // Suivi de vol (migration 002100) — aussi diffusés par « ride.updated »
  flight_mode?: FlightMode | null;
  flight_status?: FlightStatus | null;
  flight_scheduled_arrival?: string | null;
  flight_estimated_arrival?: string | null;
  flight_actual_arrival?: string | null;
  flight_delay_minutes?: number | null;
  flight_terminal?: string | null;
  flight_origin?: string | null;
  flight_checked_at?: string | null;
  /** Heure demandée par le client, conservée au premier décalage automatique (sinon null). */
  pickup_at_original?: string | null;
  /**
   * Réseau partagé (20260924006700), organisation qui confie la course (A) : organisation du chauffeur (instantané ;
   * une autre que la sienne = chauffeur partenaire) et proposition au réseau en cours. Diffusion « ride.updated » d'une
   * course tenue par un partenaire : driver_id masqué (null), network: true.
   */
  driver_org_id?: string | null;
  network_at?: string | null;
  network?: boolean;
  network_execution_id?: string | null;
};

export type LiveOffer = {
  id: string;
  ride_id: string;
  driver_id: string;
  status: string;
  mode: string;
  wave: number;
  distance_m: number | null;
  expires_at: string | null;
};

/** Alerte de suivi non résolue (ride_alerts, statut open ou acknowledged). */
export type LiveAlert = {
  id: string;
  ride_id: string;
  driver_id: string | null;
  kind: RideAlertKind;
  severity: RideAlertSeverity;
  message: string;
  data: Partial<RideAlertData>;
  status: RideAlertStatus;
  resolution: RideAlertResolution | null;
  muted_until: string | null;
  created_at: string;
  updated_at: string;
};

/** Signalement actif de la flotte (chat_messages avec report_type, non expiré). */
export type LiveReport = {
  id: string;
  report_type: FleetReportType;
  body: string;
  lat: number;
  lng: number;
  expires_at: string;
  confirmations: number;
  dismissals: number;
  author_name: string;
  author_type: "user" | "driver" | "system";
  author_driver_id: string | null;
  created_at: string;
};

export type LiveSnapshot = {
  drivers: LiveDriver[];
  rides: LiveRide[];
  offers: LiveOffer[];
  alerts: LiveAlert[];
  reports: LiveReport[];
  kpis: OrgKpis | null;
  serverTime: string;
  /** Réseau partagé : noms validés des organisations partenaires (« Réseau · Flotte B »), lus seulement si utiles */
  partners?: Record<string, string>;
};

// (une seule chaîne littérale : supabase-js en déduit le type des lignes)
// Sans route_polyline (jusqu'à 20 000 caractères par course) : la carte ne trace le parcours que de la course
// sélectionnée (chargé à la demande, GET /api/dashboard/rides/[id]?route=1) ou des courses client à bord (ci-dessous).
const RIDE_FIELDS =
  "id, number, type, status, source, dispatch_mode, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pickup_at, customer_name, customer_phone, passengers, luggage, vehicle_category, price_cents, driver_id, dispatch_wave, dispatch_radius_m, next_dispatch_at, flight_number, estimated_distance_m, estimated_duration_s, payment_method, accepted_at, created_at, updated_at, flight_mode, flight_status, flight_scheduled_arrival, flight_estimated_arrival, flight_actual_arrival, flight_delay_minutes, flight_terminal, flight_origin, flight_checked_at, pickup_at_original, driver_org_id, network_at";
const ON_BOARD_STATUSES = ["PASSENGER_ONBOARD", "IN_PROGRESS"];
export const ALERT_FIELDS = "id, ride_id, driver_id, kind, severity, message, data, status, resolution, muted_until, created_at, updated_at";
const REPORT_FIELDS = "id, report_type, body, lat, lng, expires_at, confirmations, dismissals, author_name, author_type, author_driver_id, created_at";

export async function getKpis(supabase: SupabaseClient, orgId: string): Promise<OrgKpis | null> {
  const { data } = await supabase.rpc("org_kpis", { p_org: orgId });
  return (data as OrgKpis) ?? null;
}

type Read<T> = { data: T | null; error: { message: string } | null };

/**
 * Lecture en échec (délai dépassé, 5xx, coupure : supabase-js renvoie { data: null, error }) → exception. Un instantané
 * partiel vide REMPLACERAIT l'état du command center (liste et carte vidées) : l'appelant garde l'état courant.
 */
function must<T>(res: Read<T>, what: string): T | null {
  if (res.error) throw new Error(`Instantané en direct : lecture « ${what} » impossible (${res.error.message}).`);
  return res.data;
}

/** Taille de page = max_rows par défaut de PostgREST / Supabase (supabase/config.toml) : au-delà, troncature silencieuse. */
const PAGE = 1000;

/**
 * Offres en attente des courses en recherche, SANS troncature : une course proposée à toute la flotte (mode « fleet »)
 * porte une offre par chauffeur (150 chauffeurs × 7 planifiées > 1 000). Paquets de 100 courses (filtre `in` dans
 * l'URL), pages de 1 000 dans un ordre stable.
 */
async function pendingOffers(supabase: SupabaseClient, rideIds: string[]): Promise<LiveOffer[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < rideIds.length; i += 100) chunks.push(rideIds.slice(i, i + 100));
  const lists = await Promise.all(
    chunks.map(async (ids) => {
      const out: LiveOffer[] = [];
      for (let from = 0; from < 50 * PAGE; from += PAGE) {
        const rows = (must(
          await supabase
            .from("ride_offers")
            .select("id, ride_id, driver_id, status, mode, wave, distance_m, expires_at")
            .in("ride_id", ids)
            .eq("status", "pending")
            .order("id")
            .range(from, from + PAGE - 1),
          "offres",
        ) ?? []) as LiveOffer[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    }),
  );
  return lists.flat();
}

/** Instantané pour le command center (RLS appliquée via la session utilisateur). Lève si une lecture échoue. */
export async function getLiveSnapshot(supabase: SupabaseClient, orgId: string): Promise<LiveSnapshot> {
  const recent = new Date(Date.now() - 30 * 60_000).toISOString();
  const horizon = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const [drivers, active, finished, kpis, alerts, reports, onboardRoutes, stranded] = await Promise.all([
    supabase
      .from("drivers")
      .select(
        "id, number, first_name, last_name, phone, photo_url, presence, status, current_ride_id, online_since, vehicle:vehicles(brand, model, plate, color, category, seats), location:driver_locations(lat, lng, heading, speed_mps, updated_at)",
      )
      .eq("organization_id", orgId)
      .eq("status", "active")
      .order("number"),
    // Courses actives (jamais tronquées par l'historique) …
    supabase
      .from("rides")
      .select(RIDE_FIELDS)
      .eq("organization_id", orgId)
      .lte("pickup_at", horizon)
      .not("status", "in", "(COMPLETED,CANCELLED,NO_DRIVER_FOUND)")
      .order("pickup_at", { ascending: true })
      .limit(400),
    // … et celles terminées il y a peu (affichées en fin de liste)
    supabase
      .from("rides")
      .select(RIDE_FIELDS)
      .eq("organization_id", orgId)
      .in("status", ["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"])
      .gte("updated_at", recent)
      .gte("pickup_at", new Date(Date.now() - 12 * 3600_000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(30),
    getKpis(supabase, orgId),
    // Alertes de suivi non résolues (ouvertes ou en sourdine)
    supabase.from("ride_alerts").select(ALERT_FIELDS).eq("organization_id", orgId).in("status", ["open", "acknowledged"]).order("created_at", { ascending: false }).limit(200),
    // Signalements actifs de la flotte (police, contrôle…)
    supabase
      .from("chat_messages")
      .select(REPORT_FIELDS)
      .eq("organization_id", orgId)
      .eq("channel", "fleet")
      .not("report_type", "is", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(200),
    // Tracés des courses client à bord (dessinés sur la carte sans sélection) ; les autres sont chargés à la demande
    supabase
      .from("rides")
      .select("id, route_polyline")
      .eq("organization_id", orgId)
      .in("status", ON_BOARD_STATUSES)
      .not("route_polyline", "is", null)
      .limit(400),
    // Courses « Sans chauffeur » jamais servies : gardées (onglet Alertes, carte) tant que leur prise en charge n'est pas
    // dépassée de 6 h (comme le compteur du menu), quel que soit leur dernier changement (pas seulement 30 min)
    supabase
      .from("rides")
      .select(RIDE_FIELDS)
      .eq("organization_id", orgId)
      .eq("status", "NO_DRIVER_FOUND")
      .gte("pickup_at", new Date(Date.now() - 6 * 3600_000).toISOString())
      .order("pickup_at", { ascending: true })
      .limit(100),
  ]);

  const seenRides = new Set<string>();
  const rideRows = [
    ...((must(active, "courses actives") ?? []) as LiveRide[]),
    ...((must(finished, "courses terminées") ?? []) as LiveRide[]),
    ...((must(stranded, "courses sans chauffeur") ?? []) as LiveRide[]),
  ].filter((r) => (seenRides.has(r.id) ? false : (seenRides.add(r.id), true)));
  const routes = new Map(((must(onboardRoutes, "tracés") ?? []) as { id: string; route_polyline: string }[]).map((r) => [r.id, r.route_polyline]));
  // Client à bord : tracé connu (null = aucun) ; sinon la clé reste absente (« à charger »)
  for (const r of rideRows) if (ON_BOARD_STATUSES.includes(r.status)) r.route_polyline = routes.get(r.id) ?? null;
  const openIds = rideRows.filter((r) => ["SEARCHING_DRIVER", "OFFERED"].includes(r.status)).map((r) => r.id);
  const driverRows = ((must(drivers, "chauffeurs") ?? []) as any[]).map((d) => ({
    ...d,
    vehicle: Array.isArray(d.vehicle) ? (d.vehicle[0] ?? null) : d.vehicle,
    location: Array.isArray(d.location) ? (d.location[0] ?? null) : d.location,
  })) as LiveDriver[];
  const [offers, network] = await Promise.all([openIds.length ? pendingOffers(supabase, openIds) : Promise.resolve([]), liveNetwork(supabase, orgId, rideRows, driverRows)]);

  return {
    drivers: driverRows,
    rides: rideRows,
    offers,
    alerts: (must(alerts, "alertes") ?? []) as LiveAlert[],
    reports: ((must(reports, "signalements") ?? []) as LiveReport[]).filter((r) => r.lat != null && r.lng != null),
    kpis,
    serverTime: new Date().toISOString(),
    ...(network.partners ? { partners: network.partners } : {}),
  };
}

/**
 * Réseau partagé, lu SEULEMENT s'il sert (jamais pour une organisation qui n'y a pas touché ; échec = rien d'affiché) :
 * - A : course tenue par le chauffeur d'une autre organisation → noms des partenaires (« Réseau · Flotte B ») ;
 * - B : chauffeur dont la course en cours n'est pas l'une des siennes → course partenaire (org_network_activity) :
 *   « En course partenaire (Taxi A) », position retirée (Q5 ; la base la masque déjà).
 */
async function liveNetwork(supabase: SupabaseClient, orgId: string, rides: LiveRide[], drivers: LiveDriver[]): Promise<{ partners: Record<string, string> | null }> {
  const partnerRide = rides.some((r) => r.driver_id && r.driver_org_id && r.driver_org_id !== orgId);
  const own = new Set(rides.map((r) => r.id));
  const foreign = drivers.some((d) => d.current_ride_id && !own.has(d.current_ride_id));
  if (!partnerRide && !foreign) return { partners: null };
  const [names, activity] = await Promise.all([
    partnerRide ? supabase.rpc("network_partner_names", { p_org: orgId }) : Promise.resolve(null),
    foreign ? supabase.rpc("org_network_activity", { p_org: orgId }) : Promise.resolve(null),
  ]);
  const onRide = ((activity && !activity.error ? (activity.data as OrgNetworkActivity | null) : null)?.on_ride ?? []);
  if (onRide.length) {
    const giverOf = new Map(onRide.map((r) => [r.driver.id, r.giver.name]));
    for (const d of drivers) {
      const giver = giverOf.get(d.id);
      if (giver) Object.assign(d, { network_giver: giver, location: null });
    }
  }
  const partners = names && !names.error ? ((names.data ?? null) as NetworkPartnerNames | null) : null;
  return { partners: partners && typeof partners === "object" ? partners : null };
}
