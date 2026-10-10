import "server-only";
import { zonedTimeToUtc, type VehicleCategory } from "@rydar/shared";
import { ApiError, type ApiContext } from "@/lib/api/v1";
import { bookingSitePrice } from "@/lib/booking-price";
import { geocodeOne } from "@/lib/geocode";
import { coordinateProblem, orgAnchor } from "@/lib/geo/anchor";
import type { GeoConsumer } from "@/lib/geo/budget";
import { ipBucket } from "@/lib/request";
import type { createAdminClient } from "@/lib/supabase/admin";

// -----------------------------------------------------------------------------
// Trajet et prix d'une demande de l'API v1, COMMUNS au devis (POST /api/v1/quotes) et à la réservation
// (POST /api/v1/rides) : mêmes points, même heure, même itinéraire (rideRouteColumns, mis en cache) et même calcul de
// prix (bookingSitePrice) → le prix d'un devis est retrouvé à l'identique à la réservation (expected_price_cents),
// sinon 409 PRICE_CHANGED.
// -----------------------------------------------------------------------------

type PlaceInput = { address: string; lat?: number; lng?: number };

export type TripPlaces = {
  pickup: { address: string; lat: number; lng: number };
  /** Destination : coordonnées absentes si l'adresse n'a pas pu être géocodée (la course reste acceptée) */
  dropoff: { address: string; lat: number | null; lng: number | null };
};

/** Colonnes d'itinéraire d'une course (rideRouteColumns) : null sans coordonnées de destination. */
type TripRoute = { estimated_distance_m: number | null; estimated_duration_s: number | null };

/**
 * Budget des fournisseurs géo payants : part de l'organisation (clé serveur) ; clé « navigateur » (appelée par les
 * visiteurs du site) : part du visiteur (IP /64), du site de l'organisation et de l'ensemble des anonymes.
 */
export function geoConsumer(ctx: ApiContext): GeoConsumer {
  return ctx.browser ? { kind: "visitor", ip: ipBucket(ctx.ip), org: ctx.orgId } : { kind: "org", org: ctx.orgId };
}

/** Heure de prise en charge : pickup_at (ISO avec fuseau), sinon date + time dans le fuseau de l'organisation, sinon maintenant. */
export function apiPickupAt(v: { pickup_at?: string | null; date?: string; time?: string }, timeZone: string): Date {
  if (v.pickup_at) return new Date(v.pickup_at);
  if (v.date && v.time) return zonedTimeToUtc(v.date, v.time, timeZone);
  return new Date();
}

/**
 * Départ et destination : coordonnées fournies contrôlées (422 INVALID_COORDINATES) ; absentes : géocodage, avec
 * priorité à la zone d'activité de l'organisation pour le départ (introuvable : 422 PICKUP_NOT_GEOCODED) et au départ
 * pour la destination (introuvable : course sans coordonnées de destination, sans itinéraire).
 */
export async function resolvePlaces(ctx: ApiContext, v: { pickup: PlaceInput; dropoff: PlaceInput }, consumer: GeoConsumer): Promise<TripPlaces> {
  const anchor = await orgAnchor(ctx.orgId).catch(() => null);
  let pickup: TripPlaces["pickup"];
  if (v.pickup.lat == null || v.pickup.lng == null) {
    const g = await geocodeOne(v.pickup.address, anchor ?? undefined, { consumer }).catch(() => null);
    if (!g) throw new ApiError(422, "PICKUP_NOT_GEOCODED", "Adresse de départ introuvable ou imprécise : précisez le numéro et la ville, ou fournissez pickup.lat et pickup.lng.");
    pickup = { address: v.pickup.address, lat: g.lat, lng: g.lng };
  } else {
    pickup = { address: v.pickup.address, lat: v.pickup.lat, lng: v.pickup.lng };
    const problem = coordinateProblem(pickup, anchor);
    if (problem) throw new ApiError(422, "INVALID_COORDINATES", `pickup : ${problem}`, { "pickup.lat": problem });
  }
  let dropoff: TripPlaces["dropoff"] = { address: v.dropoff.address, lat: v.dropoff.lat ?? null, lng: v.dropoff.lng ?? null };
  if (dropoff.lat == null || dropoff.lng == null) {
    const g = await geocodeOne(dropoff.address, { lat: pickup.lat, lng: pickup.lng }, { precise: false, consumer }).catch(() => null);
    if (g) dropoff = { address: dropoff.address, lat: g.lat, lng: g.lng };
  } else {
    const problem = coordinateProblem({ lat: dropoff.lat, lng: dropoff.lng }, { lat: pickup.lat, lng: pickup.lng }, 1_500_000);
    if (problem) throw new ApiError(422, "INVALID_COORDINATES", `dropoff : ${problem}`, { "dropoff.lat": problem });
  }
  return { pickup, dropoff };
}

/**
 * Prix garanti au client (centimes, TTC) : forfait reconnu, sinon grille de l'organisation pour la catégorie
 * (lib/booking-price.ts). null : aucune grille active pour la catégorie, destination sans itinéraire (hors forfait), ou
 * adresse de destination géocodée loin des coordonnées fournies. Seul calcul du devis et du contrôle de
 * expected_price_cents.
 */
export function sitePrice(
  admin: ReturnType<typeof createAdminClient>,
  ctx: ApiContext,
  opts: { places: TripPlaces; route: TripRoute; category: VehicleCategory; pickupAt: Date; consumer: GeoConsumer },
) {
  const { places, route } = opts;
  return bookingSitePrice(admin, {
    orgId: ctx.orgId,
    timeZone: ctx.orgTimezone,
    category: opts.category,
    pickup: places.pickup,
    dropoff: places.dropoff,
    route: route.estimated_distance_m != null ? { distanceM: route.estimated_distance_m, durationS: route.estimated_duration_s ?? 0 } : null,
    pickupAt: opts.pickupAt,
    consumer: opts.consumer,
  });
}
