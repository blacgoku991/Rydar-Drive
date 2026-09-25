"use server";
import {
  PAYMENT_METHODS, estimatePrice, extractErrorCode, fieldErrors, matchFixedFare, rideFormSchema, type PaymentMethod, type PricingRule, type RideFormInput,
  type RpcResult,
} from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/errors";
import { geocodeOne } from "@/lib/geocode";
import { rideRouteColumns } from "@/lib/geo/routing";
import { getOrgContext } from "@/lib/org-context";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

// ---------------------------------------------------------------- mode centrale (migration 002600)
/** Erreurs de la répartition du prix (absentes des messages partagés) → message et champ du formulaire. */
const SPLIT_ERRORS: Record<string, { field?: string; message: string }> = {
  PRICE_REQUIRED: { field: "priceCents", message: "Prix obligatoire en mode centrale : le chauffeur voit sa part avant d'accepter." },
  COMMISSION_TOO_HIGH: { field: "commissionCents", message: "La commission et les frais plateforme dépassent le prix de la course." },
  SETTLEMENT_LOCKED: { message: "Règlement déjà déclaré, encaissé ou contesté : le prix, la commission et le paiement sont verrouillés." },
};

function splitError(error: { message?: string } | null | undefined): { ok: false; error: string; fieldErrors?: Record<string, string> } | null {
  const hit = SPLIT_ERRORS[extractErrorCode(error?.message) ?? ""];
  if (!hit) return null;
  return { ok: false, error: hit.message, fieldErrors: hit.field ? { [hit.field]: hit.message } : undefined };
}

/** Commission saisie à la course, en centimes : null = automatique (réglages de la centrale). */
function parseCommission(raw: unknown): number | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : "invalid";
}

export async function createRide(input: RideFormInput & { commissionCents?: number | string | null }): Promise<Result<{ id: string; number: number }>> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const parsed = rideFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs du formulaire.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const centrale = ctx.org.dispatch_model === "centrale";
  const commission = centrale ? parseCommission(input.commissionCents) : null;
  if (commission === "invalid") return { ok: false, error: "Commission invalide.", fieldErrors: { commissionCents: "Montant en euros, 0 ou plus" } };
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
  // Mode centrale : le chauffeur doit voir sa part dans l'offre → pas de course sans prix (la base refuse aussi)
  if (centrale && priceCents == null) return splitError({ message: "PRICE_REQUIRED" })!;

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
      ...(centrale && commission != null ? { commission_cents: commission } : {}),
      ...route,
    })
    .select("id, number")
    .single();
  if (error || !data) return splitError(error) ?? { ok: false, error: actionError(error, "Impossible de créer la course.") };
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

// ---------------------------------------------------------------- prix / commission / paiement (mode centrale)
export type RidePricingInput = { priceCents: number | null; commissionCents: number | null; paymentMethod: PaymentMethod };

/**
 * Corrige le prix, la commission (null = automatique) ou le moyen de paiement d'une course.
 * Seuls les champs modifiés sont envoyés : la base recalcule la répartition et le règlement « à régler »,
 * et refuse (SETTLEMENT_LOCKED) si le règlement est déjà déclaré, encaissé, annulé ou contesté.
 */
export async function updateRidePricing(rideId: string, input: RidePricingInput): Promise<Result<{ changed: boolean }>> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  if (!UUID.test(rideId)) return { ok: false, error: "Course introuvable." };
  const centrale = ctx.org.dispatch_model === "centrale";
  const price = input.priceCents == null ? null : Number(input.priceCents);
  if (price != null && (!Number.isInteger(price) || price < 0 || price > 10_000_000)) {
    return { ok: false, error: "Prix invalide.", fieldErrors: { priceCents: "Montant en euros, 0 ou plus" } };
  }
  const commission = centrale ? parseCommission(input.commissionCents) : null;
  if (commission === "invalid") return { ok: false, error: "Commission invalide.", fieldErrors: { commissionCents: "Montant en euros, 0 ou plus" } };
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)) return { ok: false, error: "Moyen de paiement invalide." };

  const { data: ride } = await ctx.supabase
    .from("rides")
    .select("id, price_cents, commission_cents, commission_manual, payment_method")
    .eq("id", rideId)
    .eq("organization_id", ctx.org.id)
    .maybeSingle();
  if (!ride) return { ok: false, error: "Course introuvable." };
  const cur = ride as { price_cents: number | null; commission_cents: number | null; commission_manual: boolean | null; payment_method: string };

  const patch: Record<string, unknown> = {};
  if (price !== cur.price_cents) patch.price_cents = price;
  if (centrale) {
    const manual = !!cur.commission_manual;
    // Automatique demandé : ne rien envoyer si c'est déjà le cas (le trigger recalcule avec le prix)
    if (commission == null ? manual : !manual || commission !== cur.commission_cents) patch.commission_cents = commission;
  }
  if (input.paymentMethod !== cur.payment_method) patch.payment_method = input.paymentMethod;
  if (!Object.keys(patch).length) return { ok: true, changed: false };

  const { error } = await ctx.supabase.from("rides").update(patch).eq("id", rideId).eq("organization_id", ctx.org.id);
  if (error) return splitError(error) ?? { ok: false, error: actionError(error, "Modification impossible.") };
  revalidatePath("/dashboard/rides");
  revalidatePath(`/dashboard/rides/${rideId}`);
  revalidatePath("/dashboard/settlements");
  return { ok: true, changed: true };
}
