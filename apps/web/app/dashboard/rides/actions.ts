"use server";
import { estimatePrice, fieldErrors, matchFixedFare, rideFormSchema, type PricingRule, type RideFormInput, type RpcResult } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/errors";
import { geocodeOne } from "@/lib/geocode";
import { rideRouteColumns } from "@/lib/geo/routing";
import { getOrgContext } from "@/lib/org-context";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function createRide(input: RideFormInput): Promise<Result<{ id: string; number: number }>> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const parsed = rideFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs du formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const pickupAt = v.when === "now" ? new Date() : v.pickupAt!;
  // Destination tapée sans choisir de suggestion (« Sur place », « À définir »…) : placée seulement si le
  // résultat est sans ambiguïté, et jamais tarifée au compteur sur un point que personne n'a vu
  let dropoff = { ...v.dropoff };
  let guessedDropoff = false;
  if ((dropoff.lat == null || dropoff.lng == null) && dropoff.address.trim()) {
    const g = await geocodeOne(dropoff.address, { lat: v.pickup.lat, lng: v.pickup.lng }, { precise: false, minScore: 0.7 }).catch(() => null);
    if (g) (dropoff = { ...dropoff, lat: g.lat, lng: g.lng }), (guessedDropoff = true);
  }
  const route = await rideRouteColumns({ lat: v.pickup.lat, lng: v.pickup.lng }, dropoff);
  // Prix non saisi : grille de l'organisation (forfait reconnu, sinon compteur), comme l'API
  let priceCents = v.priceCents ?? null;
  if (priceCents == null) {
    const { data: rule } = await ctx.supabase
      .from("pricing_rules")
      .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
      .eq("organization_id", ctx.org.id)
      .eq("vehicle_category", v.vehicleCategory)
      .eq("is_active", true)
      .maybeSingle();
    if (rule) {
      const fixed = matchFixedFare(rule as PricingRule, v.pickup.address, dropoff.address);
      priceCents = fixed?.price_cents ?? (route.estimated_distance_m != null && !guessedDropoff ? estimatePrice(rule as PricingRule, route.estimated_distance_m, route.estimated_duration_s ?? 0, pickupAt, ctx.org.timezone ?? "Europe/Paris") : null);
    }
  }

  const { data, error } = await ctx.supabase
    .from("rides")
    .insert({
      organization_id: ctx.org.id,
      pickup_address: v.pickup.address,
      pickup_lat: v.pickup.lat,
      pickup_lng: v.pickup.lng,
      dropoff_address: dropoff.address,
      dropoff_lat: dropoff.lat ?? null,
      dropoff_lng: dropoff.lng ?? null,
      pickup_at: pickupAt.toISOString(),
      customer_name: v.customerName,
      customer_phone: v.customerPhone,
      customer_email: v.customerEmail ?? null,
      passengers: v.passengers,
      luggage: v.luggage,
      vehicle_category: v.vehicleCategory,
      price_cents: priceCents,
      payment_method: v.paymentMethod,
      comment: v.comment ?? null,
      flight_number: v.flightNumber ?? null,
      ...route,
    })
    .select("id, number")
    .single();
  if (error || !data) return { ok: false, error: actionError(error, "Impossible de créer la course.") };
  revalidatePath("/dashboard/rides");
  return { ok: true, id: data.id as string, number: data.number as number };
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) return { ok: false, error: actionError(error) };
  const res = data as RpcResult;
  if (!res?.ok) return { ok: false, error: res?.message ?? "Action impossible." };
  revalidatePath("/dashboard/rides");
  return { ok: true };
}

export async function cancelRide(rideId: string, reason?: string) {
  return rpc("cancel_ride", { p_ride_id: rideId, p_reason: reason ?? null });
}

export async function assignRide(rideId: string, driverId: string) {
  return rpc("assign_ride", { p_ride_id: rideId, p_driver_id: driverId });
}

export async function redispatchRide(rideId: string) {
  return rpc("redispatch_ride", { p_ride_id: rideId });
}

// ---------------------------------------------------------------- alertes de suivi (migration 002200)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RelaunchResult =
  | { ok: true; code: "RELAUNCHED" | "UNASSIGNED"; message: string }
  | { ok: false; code: "DRIVER_CHANGED" | "RIDE_NOT_REASSIGNABLE" | "RIDE_NOT_FOUND" | "ERROR"; error: string };

/**
 * « Relancer » : retire la course au chauffeur affiché par l'alerte (p_expected_driver) et relance la recherche
 * (il n'est plus sollicité pour cette course). Dispatch automatique désactivé → UNASSIGNED (à attribuer à la main).
 */
export async function relaunchRide(rideId: string, expectedDriverId: string | null, reason?: string): Promise<RelaunchResult> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, code: "ERROR", error: "Accès refusé." };
  if (!UUID.test(rideId) || (expectedDriverId && !UUID.test(expectedDriverId))) return { ok: false, code: "RIDE_NOT_FOUND", error: "Course introuvable." };
  const { data, error } = await ctx.supabase.rpc("reassign_ride", {
    p_ride_id: rideId,
    p_reason: reason?.trim() || null,
    p_expected_driver: expectedDriverId,
  });
  if (error) return { ok: false, code: "ERROR", error: actionError(error) };
  const res = data as { ok: boolean; code: string; message?: string };
  revalidatePath("/dashboard/rides");
  if (res?.ok && (res.code === "RELAUNCHED" || res.code === "UNASSIGNED")) return { ok: true, code: res.code, message: res.message ?? "" };
  const code = (["DRIVER_CHANGED", "RIDE_NOT_REASSIGNABLE", "RIDE_NOT_FOUND"] as const).find((c) => c === res?.code) ?? "ERROR";
  return { ok: false, code, error: res?.message ?? "Action impossible." };
}

/** « Garder » : l'alerte est mise en sourdine 15 min (pas de nouvelle alerte du même type entre-temps). */
export async function acknowledgeRideAlert(alertId: string): Promise<Result<{ message: string }>> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  if (!UUID.test(alertId)) return { ok: false, error: "Alerte introuvable." };
  const { data, error } = await ctx.supabase.rpc("acknowledge_ride_alert", { p_alert_id: alertId });
  if (error) return { ok: false, error: actionError(error) };
  const res = data as { ok: boolean; code: string; message?: string };
  if (!res?.ok) return { ok: false, error: res?.message ?? "Alerte déjà traitée." };
  return { ok: true, message: res.message ?? "Alerte mise en sourdine 15 min." };
}
