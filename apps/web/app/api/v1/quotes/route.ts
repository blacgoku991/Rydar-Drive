import { apiQuoteSchema, fieldErrors, type ApiQuote } from "@rydar/shared";
import { ApiError, handle, preflight, readJson, rejectTenantFields } from "@/lib/api/v1";
import { apiPickupAt, geoConsumer, resolvePlaces, sitePrice } from "@/lib/api/trip";
import { rideRouteColumns } from "@/lib/geo/routing";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Mêmes bornes que la base à la création de la course (private.before_ride_insert : PICKUP_IN_PAST, PICKUP_TOO_FAR). */
const PICKUP_PAST_TOLERANCE_MS = 10 * 60_000;
const MAX_ADVANCE_MS = 400 * 86_400_000;

/**
 * POST /api/v1/quotes — devis du site (portée rides:quote, permise à une clé « navigateur ») : géocodage et itinéraire
 * comme POST /rides, prix par bookingSitePrice (lib/api/trip.ts). C'est ce prix que le site affiche avant la commande
 * et renvoie dans expected_price_cents : POST /rides le recalcule à l'identique, sinon 409 PRICE_CHANGED. Aucune course
 * n'est créée.
 */
export async function POST(req: Request) {
  return handle(req, "rides:quote", async (ctx) => {
    const body = await readJson(req, 8_192);
    await rejectTenantFields(ctx, body, "/api/v1/quotes");
    const parsed = apiQuoteSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR", "Données de devis invalides.", fieldErrors(parsed.error));
    const v = parsed.data;

    // Heure contrôlée avant tout géocodage : une réservation à cette heure serait refusée par la base
    const pickupAt = apiPickupAt(v, ctx.orgTimezone);
    if (pickupAt.getTime() < Date.now() - PICKUP_PAST_TOLERANCE_MS) throw new ApiError(422, "PICKUP_IN_PAST", "Date de prise en charge invalide.");
    if (pickupAt.getTime() > Date.now() + MAX_ADVANCE_MS) throw new ApiError(422, "PICKUP_TOO_FAR", "Date de prise en charge invalide.");

    const consumer = geoConsumer(ctx);
    const places = await resolvePlaces(ctx, v, consumer);
    const route = await rideRouteColumns(places.pickup, places.dropoff, consumer);
    const { priceCents, fixedFare } = await sitePrice(createAdminClient(), ctx, { places, route, category: v.vehicle_category, pickupAt, consumer });
    const data: ApiQuote = {
      price_cents: priceCents,
      currency: ctx.orgCurrency,
      fixed_fare: fixedFare != null,
      estimated_distance_m: route.estimated_distance_m,
      estimated_duration_s: route.estimated_duration_s,
      vehicle_category: v.vehicle_category,
      pickup_at: pickupAt.toISOString(),
    };
    return { status: 200, body: { data } };
  });
}
