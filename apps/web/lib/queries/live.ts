import "server-only";
import type { OrgKpis } from "@rydar/shared";
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

export type LiveSnapshot = {
  drivers: LiveDriver[];
  rides: LiveRide[];
  offers: LiveOffer[];
  kpis: OrgKpis | null;
  serverTime: string;
};

const RIDE_FIELDS =
  "id, number, type, status, source, dispatch_mode, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pickup_at, customer_name, customer_phone, passengers, luggage, vehicle_category, price_cents, driver_id, dispatch_wave, dispatch_radius_m, next_dispatch_at, flight_number, estimated_distance_m, estimated_duration_s, route_polyline, payment_method, accepted_at, created_at, updated_at";

export async function getKpis(supabase: SupabaseClient, orgId: string): Promise<OrgKpis | null> {
  const { data } = await supabase.rpc("org_kpis", { p_org: orgId });
  return (data as OrgKpis) ?? null;
}

/** Instantané pour le command center (RLS appliquée via la session utilisateur). */
export async function getLiveSnapshot(supabase: SupabaseClient, orgId: string): Promise<LiveSnapshot> {
  const recent = new Date(Date.now() - 30 * 60_000).toISOString();
  const horizon = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const [drivers, active, finished, kpis] = await Promise.all([
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
  ]);

  const rideRows = [...((active.data ?? []) as LiveRide[]), ...((finished.data ?? []) as LiveRide[])];
  const openIds = rideRows.filter((r) => ["SEARCHING_DRIVER", "OFFERED"].includes(r.status)).map((r) => r.id);
  const offers = openIds.length
    ? await supabase
        .from("ride_offers")
        .select("id, ride_id, driver_id, status, mode, wave, distance_m, expires_at")
        .in("ride_id", openIds)
        .eq("status", "pending")
    : { data: [] };

  return {
    drivers: ((drivers.data ?? []) as any[]).map((d) => ({
      ...d,
      vehicle: Array.isArray(d.vehicle) ? (d.vehicle[0] ?? null) : d.vehicle,
      location: Array.isArray(d.location) ? (d.location[0] ?? null) : d.location,
    })) as LiveDriver[],
    rides: rideRows,
    offers: (offers.data ?? []) as LiveOffer[],
    kpis,
    serverTime: new Date().toISOString(),
  };
}
