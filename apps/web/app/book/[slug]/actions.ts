"use server";
import { bookingRequestSchema, bookingSitePublishable, fieldErrors, formatPrice, PAYMENT_METHODS, type BookingRequest, type PaymentMethod } from "@rydar/shared";
import { z } from "zod";
import { bookingSitePrice } from "@/lib/booking-price";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { coordinateProblem, orgAnchor } from "@/lib/geo/anchor";
import { computeRoute } from "@/lib/geo/routing";
import { rateLimitAll } from "@/lib/rate-limit";
import { clientIp, ipBucket } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

type Result =
  | { ok: true; number: number }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }
  /** Prix recalculé différent du prix affiché : le client voit le nouveau prix (null : plus de prix en ligne) avant de confirmer */
  | { ok: false; code: "PRICE_CHANGED"; error: string; priceCents: number | null };

const TOO_MANY = "Trop de demandes. Réessayez dans quelques minutes ou appelez-nous.";
const UNAVAILABLE = "Réservation en ligne indisponible.";
/** Réservation au plus 400 jours à l'avance (trigger rides_before_insert : PICKUP_TOO_FAR). */
const MAX_ADVANCE_MS = 400 * 86_400_000;

/**
 * Réservation publique (aucun compte client) → course source « booking_site » → dispatch. Prix : celui qui a été
 * affiché au client et qu'il s'est engagé à payer (expectedPriceCents, « Réserver avec obligation de paiement »),
 * enregistré seulement s'il est identique au calcul du serveur (sinon PRICE_CHANGED) ; sans prix affiché, demande
 * sans prix (price_cents null), que la centrale confirme au client. Moyen de paiement : celui de la centrale (réglages).
 */
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
    .select(
      "id, status, timezone, settings:organization_settings(default_payment_method), booking:booking_sites(enabled, vehicle_categories, show_price_estimate, legal_mentions, phone, email)",
    )
    .eq("slug", slug)
    .maybeSingle();
  const one = <T,>(x: unknown) => (Array.isArray(x) ? x[0] : x) as T | null;
  const site = org
    ? one<{ enabled: boolean; vehicle_categories: string[]; show_price_estimate: boolean; legal_mentions: string | null; phone: string | null; email: string | null }>(
        (org as any).booking,
      )
    : null;
  if (!org || (org as any).status !== "active" || !site?.enabled) return { ok: false, error: UNAVAILABLE };
  // Mini-site publié avant la règle, sans les informations dues aux clients (conditions, téléphone, e-mail) : pas de
  // commande en ligne (C. conso. L111-1, L221-5, L221-14) ; la centrale complète ses réglages
  if (!bookingSitePublishable(site)) return { ok: false, error: `${UNAVAILABLE} Appelez la centrale pour réserver.` };
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
  // Même calcul que le devis affiché (lib/booking-price.ts) ; aucun prix si la centrale ne l'affiche pas
  const computed = site.show_price_estimate
    ? (
        await bookingSitePrice(admin, {
          orgId: (org as any).id,
          timeZone: (org as any).timezone || "Europe/Paris",
          category: v.vehicleCategory,
          pickup: v.pickup,
          dropoff: v.dropoff,
          route,
          pickupAt,
          consumer,
        })
      ).priceCents
    : null;
  let price: number | null = null;
  if (v.expectedPriceCents != null) {
    // Le client s'est engagé sur le prix affiché : enregistré tel quel s'il est confirmé, sinon nouveau prix montré
    if (computed !== v.expectedPriceCents) {
      return {
        ok: false,
        code: "PRICE_CHANGED",
        priceCents: computed,
        error:
          computed == null
            ? "Le prix ne peut plus être confirmé en ligne. Envoyez votre demande\u00a0: la centrale vous confirmera le prix avant la course."
            : `Le prix a changé\u00a0: ${formatPrice(computed)} TTC. Vérifiez-le avant de réserver.`,
      };
    }
    price = computed;
  }
  const settings = one<{ default_payment_method: string | null }>((org as any).settings);
  const payment = (PAYMENT_METHODS as readonly string[]).includes(settings?.default_payment_method ?? "")
    ? (settings!.default_payment_method as PaymentMethod)
    : "card";
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
      payment_method: payment,
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
