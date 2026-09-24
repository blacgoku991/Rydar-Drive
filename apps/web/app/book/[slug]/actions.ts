"use server";
import { bookingRequestSchema, estimatePrice, fieldErrors, type BookingRequest, type PricingRule } from "@rydar/shared";
import { z } from "zod";
import { computeRoute } from "@/lib/geo/routing";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true; number: number } | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Réservation publique (aucun compte client) → course source « booking_site » → dispatch. */
export async function submitBooking(slug: string, input: z.input<typeof bookingRequestSchema>): Promise<Result> {
  const ip = await clientIp();
  const limit = await rateLimit(`booking:${ip}`, 6, 600);
  if (!limit.ok) return { ok: false, error: "Trop de demandes. Réessayez dans quelques minutes ou appelez-nous." };

  const parsed = bookingRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Merci de vérifier le formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v: BookingRequest = parsed.data;
  if (v.website) return { ok: true, number: 0 }; // robot : on ne crée rien

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id, status, booking:booking_sites(enabled, vehicle_categories)")
    .eq("slug", slug)
    .maybeSingle();
  const site = org && ((Array.isArray((org as any).booking) ? (org as any).booking[0] : (org as any).booking) as { enabled: boolean; vehicle_categories: string[] } | null);
  if (!org || (org as any).status !== "active" || !site?.enabled) return { ok: false, error: "Réservation en ligne indisponible." };
  if (!site.vehicle_categories.includes(v.vehicleCategory)) return { ok: false, error: "Catégorie non proposée." };

  const pickupAt = v.when === "now" ? new Date() : v.pickupAt;
  if (!pickupAt || pickupAt.getTime() < Date.now() - 5 * 60_000) return { ok: false, error: "Date de prise en charge invalide.", fieldErrors: { pickupAt: "Date passée" } };
  const route = await computeRoute(v.pickup, v.dropoff, { timeoutMs: 2500 });
  const { data: rule } = await admin
    .from("pricing_rules")
    .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end")
    .eq("organization_id", (org as any).id)
    .eq("vehicle_category", v.vehicleCategory)
    .eq("is_active", true)
    .maybeSingle();
  const price = rule ? estimatePrice(rule as PricingRule, route.distanceM, route.durationS, pickupAt) : null;
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
