import "server-only";
import { estimatePrice, haversine, matchFixedFare, type PricingRule, type VehicleCategory } from "@rydar/shared";
import { geocodeOne } from "@/lib/geocode";
import type { GeoConsumer } from "@/lib/geo/budget";
import type { createAdminClient } from "@/lib/supabase/admin";

/** Destination géocodée à plus de cette distance des coordonnées reçues : prix laissé à la centrale. */
const DROPOFF_MISMATCH_M = 2_000;

type Place = { lat: number; lng: number; address: string };

/**
 * Prix d'une course du mini-site (centimes, TTC) : forfait reconnu, sinon grille de la centrale. MÊME calcul pour le
 * devis affiché (/api/book/[slug]/quote) et pour la réservation (submitBooking) : le client ne s'engage que sur un prix
 * affiché, que le serveur retrouve à l'identique (sinon PRICE_CHANGED). Prix au compteur calculé sur des coordonnées
 * fournies par le navigateur : si l'adresse de destination géocodée est loin du point tarifé, aucun prix (la centrale
 * le fixe), jamais un prix calculé sur un faux point.
 */
export async function bookingSitePrice(
  admin: ReturnType<typeof createAdminClient>,
  opts: {
    orgId: string;
    timeZone: string;
    category: VehicleCategory;
    pickup: Place;
    dropoff: Place;
    route: { distanceM: number; durationS: number };
    pickupAt: Date;
    consumer?: GeoConsumer | null;
  },
): Promise<{ priceCents: number | null; fixedFare: string | null }> {
  const { data: rule } = await admin
    .from("pricing_rules")
    .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
    .eq("organization_id", opts.orgId)
    .eq("vehicle_category", opts.category)
    .eq("is_active", true)
    .maybeSingle();
  if (!rule) return { priceCents: null, fixedFare: null };
  const fixed = matchFixedFare(rule as PricingRule, opts.pickup.address, opts.dropoff.address);
  if (fixed) return { priceCents: fixed.price_cents, fixedFare: fixed.label };
  const price = estimatePrice(rule as PricingRule, opts.route.distanceM, opts.route.durationS, opts.pickupAt, opts.timeZone);
  if (price == null) return { priceCents: null, fixedFare: null };
  const g = await geocodeOne(opts.dropoff.address, opts.pickup, { precise: false, consumer: opts.consumer }).catch(() => null);
  if (g && haversine(g, opts.dropoff) > DROPOFF_MISMATCH_M) return { priceCents: null, fixedFare: null };
  return { priceCents: price, fixedFare: null };
}
