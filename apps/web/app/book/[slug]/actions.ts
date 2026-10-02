"use server";
import { bookingRequestSchema, estimatePrice, fieldErrors, haversine, matchFixedFare, type BookingRequest, type PricingRule } from "@rydar/shared";
import { z } from "zod";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { geocodeOne } from "@/lib/geocode";
import { coordinateProblem, orgAnchor } from "@/lib/geo/anchor";
import { computeRoute } from "@/lib/geo/routing";
import { rateLimitAll } from "@/lib/rate-limit";
import { clientIp, ipBucket } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true; number: number } | { ok: false; error: string; fieldErrors?: Record<string, string> };

const TOO_MANY = "Trop de demandes. Réessayez dans quelques minutes ou appelez-nous.";
const UNAVAILABLE = "Réservation en ligne indisponible.";
/** Destination géocodée à plus de cette distance des coordonnées reçues : prix laissé à la centrale. */
const DROPOFF_MISMATCH_M = 2_000;
/** Réservation au plus 400 jours à l'avance (trigger rides_before_insert : PICKUP_TOO_FAR). */
const MAX_ADVANCE_MS = 400 * 86_400_000;

/** Réservation publique (aucun compte client) → course source « booking_site » → dispatch. */
export async function submitBooking(slug: string, input: z.input<typeof bookingRequestSchema>): Promise<Result> {
  // IP (IPv6 groupée par /64) avant toute requête : 6 demandes / 10 min et 20 / jour
  const ip = ipBucket(await clientIp());
  const byIp = await rateLimitAll([
    { key: `booking:ip:${ip}`, limit: 6, windowSec: 600 },
    { key: `booking:ipday:${ip}`, limit: 20, windowSec: 86_400 },
  ]);
  if (!byIp.ok) return { ok: false, error: TOO_MANY };
  // Mini-sites coupés par la plateforme (la base refuse aussi la course : BOOKING_SITES_DISABLED)
  if (!(await bookingSitesEnabled())) return { ok: false, error: UNAVAILABLE };

  const parsed = bookingRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Merci de vérifier le formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v: BookingRequest = parsed.data;
  if (v.website) return { ok: true, number: 0 }; // robot (pot de miel rempli) : on ne crée rien

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id, status, timezone, booking:booking_sites(enabled, vehicle_categories)")
    .eq("slug", slug)
    .maybeSingle();
  const site = org && ((Array.isArray((org as any).booking) ? (org as any).booking[0] : (org as any).booking) as { enabled: boolean; vehicle_categories: string[] } | null);
  if (!org || (org as any).status !== "active" || !site?.enabled) return { ok: false, error: UNAVAILABLE };
  if (!site.vehicle_categories.includes(v.vehicleCategory)) return { ok: false, error: "Catégorie non proposée." };

  const pickupAt = v.when === "now" ? new Date() : v.pickupAt;
  if (!pickupAt || pickupAt.getTime() < Date.now() - 5 * 60_000) return { ok: false, error: "Date de prise en charge invalide.", fieldErrors: { pickupAt: "Date passée" } };
  // Même borne que la base (PICKUP_TOO_FAR, 400 jours) : message précis plutôt que l'échec générique de l'insertion
  if (pickupAt.getTime() > Date.now() + MAX_ADVANCE_MS) {
    return { ok: false, error: "Date de prise en charge trop lointaine.", fieldErrors: { pickupAt: "400 jours maximum" } };
  }

  // Zone desservie : mêmes règles que l'API v1 (départ près de l'activité de la centrale, trajet ≤ 1 500 km)
  const anchor = await orgAnchor((org as any).id).catch(() => null);
  if (coordinateProblem(v.pickup, anchor)) {
    return { ok: false, error: "Départ hors de la zone desservie. Appelez-nous pour ce trajet.", fieldErrors: { pickup: "Hors de la zone desservie" } };
  }
  if (coordinateProblem(v.dropoff, v.pickup, 1_500_000)) {
    return { ok: false, error: "Destination trop éloignée. Appelez-nous pour ce trajet.", fieldErrors: { dropoff: "Destination trop éloignée" } };
  }

  // Téléphone puis centrale (dans cet ordre : une demande refusée pour son numéro ne consomme pas le plafond
  // de la centrale) ; au-delà, le dashboard et l'API restent disponibles
  const byTarget = await rateLimitAll([
    { key: `booking:phone:${v.customerPhone}`, limit: 3, windowSec: 3600 },
    { key: `booking:org:${(org as any).id}`, limit: 60, windowSec: 3600 },
  ]);
  if (!byTarget.ok) return { ok: false, error: TOO_MANY };

  // Budget des fournisseurs géo payants : compté au visiteur (IP /64) et au mini-site (lib/geo/budget.ts)
  const consumer = { kind: "visitor" as const, ip, org: (org as any).id as string };
  const route = await computeRoute(v.pickup, v.dropoff, { timeoutMs: 2500, consumer });
  const { data: rule } = await admin
    .from("pricing_rules")
    .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
    .eq("organization_id", (org as any).id)
    .eq("vehicle_category", v.vehicleCategory)
    .eq("is_active", true)
    .maybeSingle();
  const fixed = rule ? matchFixedFare(rule as PricingRule, v.pickup.address, v.dropoff.address) : null;
  let price = fixed?.price_cents ?? (rule ? estimatePrice(rule as PricingRule, route.distanceM, route.durationS, pickupAt, (org as any).timezone || "Europe/Paris") : null);
  if (price != null && !fixed) {
    // Prix au compteur calculé sur des coordonnées fournies par le navigateur : la destination affichée au
    // chauffeur doit correspondre au point tarifé, sinon le prix est laissé à la centrale (à confirmer)
    const g = await geocodeOne(v.dropoff.address, v.pickup, { precise: false, consumer }).catch(() => null);
    if (g && haversine(g, v.dropoff) > DROPOFF_MISMATCH_M) price = null;
  }
  const { data, error } = await admin
    .from("rides")
    .insert({
      organization_id: (org as any).id,
      source: "booking_site",
      pickup_address: v.pickup.address,
      pickup_lat: v.pickup.lat,
      pickup_lng: v.pickup.lng,
      dropoff_address: v.dropoff.address,
      dropoff_lat: v.dropoff.lat,
      dropoff_lng: v.dropoff.lng,
      pickup_at: pickupAt.toISOString(),
      customer_name: v.customerName,
      customer_phone: v.customerPhone,
      customer_email: v.customerEmail ?? null,
      passengers: v.passengers,
      luggage: v.luggage,
      vehicle_category: v.vehicleCategory,
      flight_number: v.flightNumber ?? null,
      comment: v.comment ?? null,
      payment_method: "card",
      price_cents: price,
      estimated_distance_m: route.distanceM,
      estimated_duration_s: route.durationS,
      route_polyline: route.polyline,
      route_provider: route.provider,
    } as never)
    .select("number")
    .single();
  if (error || !data) return { ok: false, error: "La réservation n'a pas pu être enregistrée. Appelez-nous directement." };
  return { ok: true, number: (data as any).number };
}
