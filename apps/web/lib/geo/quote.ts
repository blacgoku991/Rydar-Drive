import "server-only";
import { DEFAULT_DISPATCH_RADII_M, estimatePrice, haversine, isCategoryCompatible, matchFixedFare, type LatLng, type PricingRule, type VehicleCategory } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { approachTimes, computeRoute, type Route } from "@/lib/geo/routing";

export type NearbyDriver = {
  id: string;
  name: string;
  vehicle: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  etaS: number;
};

export type Quote = {
  route: (Omit<Route, "coordinates"> & { coordinates: Route["coordinates"] }) | null;
  priceCents: number | null;
  /** Estimation au compteur (même si un forfait s'applique) */
  meteredCents: number | null;
  pricingRule: string | null;
  fixedFare: { label: string; price_cents: number } | null;
  nearby: { total: number; firstRadiusM: number; withinFirstRadius: number; drivers: NearbyDriver[] };
};

/**
 * Devis d'une course (dashboard) : itinéraire réel, prix selon la grille de
 * l'organisation, chauffeurs disponibles et compatibles avec leur temps d'approche.
 * `db` est le client de l'utilisateur : la RLS limite tout à son organisation.
 */
export async function quoteRide(
  db: SupabaseClient<any, any, any>,
  orgId: string,
  input: {
    pickup: LatLng;
    dropoff?: LatLng | null;
    category: VehicleCategory;
    pickupAt?: Date;
    timezone?: string;
    passengers?: number;
    pickupAddress?: string;
    dropoffAddress?: string;
  },
): Promise<Quote> {
  const [route, rules, settings, fleet] = await Promise.all([
    input.dropoff ? computeRoute(input.pickup, input.dropoff) : Promise.resolve(null),
    db.from("pricing_rules").select("*").eq("organization_id", orgId).eq("is_active", true),
    db.from("organization_settings").select("allow_category_upgrade, location_max_age_seconds, dispatch_radii_m").eq("organization_id", orgId).maybeSingle(),
    db
      .from("drivers")
      .select("id, first_name, last_name, presence, vehicle:vehicles(brand, model, category, seats), location:driver_locations(lat, lng, updated_at)")
      .eq("organization_id", orgId)
      .eq("status", "active")
      .eq("presence", "available"),
  ]);

  const rule = ((rules.data ?? []) as (PricingRule & { name: string })[]).find((r) => r.vehicle_category === input.category) ?? null;
  const meteredCents = rule && route ? estimatePrice(rule, route.distanceM, route.durationS, input.pickupAt ?? new Date(), input.timezone) : null;
  const fixedFare = rule && input.pickupAddress && input.dropoffAddress ? matchFixedFare(rule, input.pickupAddress, input.dropoffAddress) : null;
  const priceCents = fixedFare?.price_cents ?? meteredCents;

  const allowUpgrade = settings.data?.allow_category_upgrade ?? true;
  const maxAgeMs = (settings.data?.location_max_age_seconds ?? 180) * 1000;
  const radii = (settings.data?.dispatch_radii_m as number[] | undefined) ?? [...DEFAULT_DISPATCH_RADII_M];
  const maxRadius = Math.max(...radii);
  const now = Date.now();
  const candidates = ((fleet.data ?? []) as any[])
    .map((d) => {
      const loc = Array.isArray(d.location) ? d.location[0] : d.location;
      const v = Array.isArray(d.vehicle) ? d.vehicle[0] : d.vehicle;
      return { d, loc, v };
    })
    .filter(({ loc, v }) =>
      loc && v &&
      now - new Date(loc.updated_at).getTime() <= maxAgeMs &&
      isCategoryCompatible(input.category, v.category, allowUpgrade) &&
      (v.seats ?? 0) >= (input.passengers ?? 1),
    )
    .map(({ d, loc, v }) => ({
      id: d.id as string,
      name: `${d.first_name} ${String(d.last_name ?? "").charAt(0)}.`,
      vehicle: v ? `${v.brand ?? ""} ${v.model}`.trim() : null,
      lat: loc.lat as number,
      lng: loc.lng as number,
      distanceM: haversine(loc, input.pickup),
    }))
    .filter((c) => c.distanceM <= maxRadius)
    .sort((a, b) => a.distanceM - b.distanceM);

  const top = candidates.slice(0, 6);
  const legs = await approachTimes(top, input.pickup);
  const drivers = top
    .map((c, i) => ({ ...c, distanceM: Math.round(c.distanceM), etaS: legs[i]?.durationS ?? 0 }))
    .sort((a, b) => a.etaS - b.etaS);

  return {
    route,
    priceCents,
    meteredCents,
    pricingRule: fixedFare ? `forfait ${fixedFare.label}` : (rule?.name ?? null),
    fixedFare,
    nearby: { total: candidates.length, firstRadiusM: radii[0]!, withinFirstRadius: candidates.filter((c) => c.distanceM <= radii[0]!).length, drivers },
  };
}
