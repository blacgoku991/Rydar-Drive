import { apiRideCreateSchema, estimatePrice, fieldErrors, matchFixedFare, type PricingRule } from "@rydar/shared";
import { ApiError, PUBLIC_RIDE_SELECT, handle, limitBrowserPhone, preflight, publicRide, readJson, rejectTenantFields, type ApiContext } from "@/lib/api/v1";
import { apiPickupAt, geoConsumer, resolvePlaces, sitePrice } from "@/lib/api/trip";
import { env } from "@/lib/env";
import { rideRouteColumns } from "@/lib/geo/routing";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

type Admin = ReturnType<typeof createAdminClient>;

const idempotencyConflict = () =>
  new ApiError(409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key déjà utilisée pour une autre réservation : envoyez une valeur unique et imprévisible (UUID) par réservation.");

/**
 * Rejeu d'une réservation (Idempotency-Key) : seulement la course créée par CETTE clé (l'unicité porte sur
 * l'organisation : une autre clé, le dashboard ou un visiteur qui devine la valeur ne lisent jamais une autre course,
 * 409 IDEMPOTENCY_KEY_CONFLICT). Clé « navigateur » (lisible par tout visiteur du site) : identifiant, numéro et statut
 * seulement. null : aucune course avec cette valeur.
 */
async function idempotentReplay(admin: Admin, ctx: ApiContext, idempotencyKey: string) {
  const failed = () => new ApiError(500, "RIDE_CREATION_FAILED", "Impossible de créer la course.");
  const { data: found, error } = await admin
    .from("rides")
    .select("id, api_key_id")
    .eq("organization_id", ctx.orgId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw failed();
  if (!found) return null;
  if ((found as any).api_key_id !== ctx.keyId) throw idempotencyConflict();
  const { data: existing, error: replayError } = await admin
    .from("rides")
    .select(ctx.browser ? "id, number, status" : PUBLIC_RIDE_SELECT)
    .eq("id", (found as any).id)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  if (replayError || !existing) throw failed();
  const e = existing as any;
  const data = ctx.browser ? { id: e.id, number: e.number, status: e.status } : publicRide(e, env.appUrl);
  return { status: 200, body: { data, idempotent_replay: true }, rideId: e.id as string };
}

/** POST /api/v1/rides — crée une course pour l'organisation de la clé et lance le dispatch. */
export async function POST(req: Request) {
  return handle(req, "rides:create", async (ctx) => {
    const body = await readJson(req);
    await rejectTenantFields(ctx, body);
    const parsed = apiRideCreateSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR", "Données de réservation invalides.", fieldErrors(parsed.error));
    const v = parsed.data;
    // Prix attendu (devis affiché par le site) : il remplace le prix de la requête, deux prix différents sont ambigus
    if (!ctx.browser && v.expected_price_cents != null && v.price_cents != null && v.price_cents !== v.expected_price_cents) {
      throw new ApiError(422, "VALIDATION_ERROR", "Données de réservation invalides.", {
        expected_price_cents: ["Différent de price_cents : envoyez le prix attendu seul (devis de POST /quotes)."],
      });
    }

    const admin = createAdminClient();
    // Renvoi d'une réservation déjà créée : reconnu avant tout calcul (lieux, itinéraire, prix), il renvoie la course
    // créée même si le prix a changé depuis et ne compte pas dans la limite par téléphone
    const idempotencyKey = req.headers.get("idempotency-key")?.slice(0, 100) || null;
    if (idempotencyKey) {
      const replay = await idempotentReplay(admin, ctx, idempotencyKey);
      if (replay) return replay;
    }

    const consumer = geoConsumer(ctx);
    const places = await resolvePlaces(ctx, v, consumer);
    const { pickup, dropoff } = places;
    await limitBrowserPhone(ctx, v.customer.phone);
    const pickupAt = apiPickupAt(v, ctx.orgTimezone);
    const route = await rideRouteColumns(pickup, dropoff, consumer);

    let priceCents: number | null;
    if (v.expected_price_cents != null) {
      // Prix affiché au client par le site (« Réserver avec obligation de paiement ») : recalculé comme le devis
      // (POST /quotes) et enregistré s'il est identique ; sinon rien n'est créé et le site montre le nouveau prix
      const { priceCents: computed } = await sitePrice(admin, ctx, { places, route, category: v.vehicle_category, pickupAt, consumer });
      if (computed !== v.expected_price_cents) {
        throw new ApiError(
          409,
          "PRICE_CHANGED",
          computed == null
            ? "Le prix ne peut plus être garanti en ligne (details.price_cents vaut null) : envoyez la demande sans prix attendu, le prix sera confirmé au client avant la course."
            : "Le prix a changé : montrez le nouveau prix (details.price_cents) au client avant de réserver.",
          { price_cents: computed },
        );
      }
      priceCents = computed;
    } else {
      // Prix absent : grille de l'organisation (forfait reconnu, sinon compteur). Clé « navigateur » (lisible par
      // tout visiteur) : prix et moyen de paiement jamais pris dans la requête
      priceCents = ctx.browser ? null : (v.price_cents ?? null);
      if (priceCents == null) {
        const { data: rule } = await admin
          .from("pricing_rules")
          .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
          .eq("organization_id", ctx.orgId)
          .eq("vehicle_category", v.vehicle_category)
          .eq("is_active", true)
          .maybeSingle();
        if (rule) {
          const fixed = matchFixedFare(rule as PricingRule, pickup.address, dropoff.address);
          priceCents = fixed?.price_cents ?? (route.estimated_distance_m != null ? estimatePrice(rule as PricingRule, route.estimated_distance_m, route.estimated_duration_s ?? 0, pickupAt, ctx.orgTimezone) : null);
        }
      }
    }
    const { data: created, error } = await admin
      .from("rides")
      .insert({
        organization_id: ctx.orgId,
        source: "api",
        api_key_id: ctx.keyId,
        idempotency_key: idempotencyKey,
        pickup_address: pickup.address,
        pickup_lat: pickup.lat,
        pickup_lng: pickup.lng,
        dropoff_address: dropoff.address,
        dropoff_lat: dropoff.lat,
        dropoff_lng: dropoff.lng,
        pickup_at: pickupAt.toISOString(),
        customer_name: v.customer.name,
        customer_phone: v.customer.phone,
        customer_email: v.customer.email ?? null,
        passengers: v.passengers,
        luggage: v.luggage,
        vehicle_category: v.vehicle_category,
        price_cents: priceCents,
        payment_method: ctx.browser ? "card" : v.payment_method,
        comment: v.comment ?? null,
        flight_number: v.flight_number ?? null,
        external_reference: v.external_reference ?? null,
        ...route,
      } as never)
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505" && idempotencyKey && /idempotency/i.test(error.message)) {
        // Même valeur envoyée deux fois en même temps : la seconde insertion échoue, rejeu de la première
        const replay = await idempotentReplay(admin, ctx, idempotencyKey);
        if (replay) return replay;
        throw idempotencyConflict();
      }
      const code = /([A-Z_]{5,}):/.exec(error.message)?.[1];
      if (code?.startsWith("PLAN_LIMIT")) throw new ApiError(402, code, "Limite de l'offre atteinte.");
      if (code === "PLATFORM_FEES_OVERDUE") throw new ApiError(402, code, "Frais plateforme en retard : création de courses suspendue.");
      if (code === "PICKUP_IN_PAST" || code === "PICKUP_TOO_FAR") throw new ApiError(422, code, "Date de prise en charge invalide.");
      throw new ApiError(500, "RIDE_CREATION_FAILED", "Impossible de créer la course.");
    }
    const { data: ride } = await admin.from("rides").select(PUBLIC_RIDE_SELECT).eq("id", (created as any).id).single();
    return { status: 201, body: { data: publicRide(ride, env.appUrl) }, rideId: (created as any).id };
  });
}

/** GET /api/v1/rides?external_reference=…&status=…&limit=… */
export async function GET(req: Request) {
  return handle(req, "rides:read", async (ctx) => {
    const url = new URL(req.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    let q = createAdminClient().from("rides").select(PUBLIC_RIDE_SELECT).eq("organization_id", ctx.orgId);
    const ext = url.searchParams.get("external_reference");
    if (ext) q = q.eq("external_reference", ext.slice(0, 100));
    const status = url.searchParams.get("status");
    if (status && /^[A-Z_]{4,30}$/.test(status)) q = q.eq("status", status);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
    if (error) throw new ApiError(500, "QUERY_FAILED", "Lecture impossible.");
    return { status: 200, body: { data: (data ?? []).map((r) => publicRide(r, env.appUrl)) } };
  });
}
