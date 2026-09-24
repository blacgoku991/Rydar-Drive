import { TENANT_FIELDS, apiRideCreateSchema, estimateRoute, fieldErrors, zonedTimeToUtc } from "@rydar/shared";
import { ApiError, PUBLIC_RIDE_SELECT, handle, preflight, publicRide, readJson } from "@/lib/api/v1";
import { env } from "@/lib/env";
import { geocodeOne } from "@/lib/geocode";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** POST /api/v1/rides — crée une course pour l'organisation de la clé et lance le dispatch. */
export async function POST(req: Request) {
  return handle(req, "rides:create", async (ctx) => {
    const body = await readJson(req);
    // Le tenant vient EXCLUSIVEMENT de la clé API.
    if (body && typeof body === "object" && TENANT_FIELDS.some((f) => f in (body as Record<string, unknown>))) {
      const admin = createAdminClient();
      await admin.from("audit_logs").insert({
        organization_id: ctx.orgId, actor_type: "api", action: "security.tenant_field_rejected", entity_type: "api_keys",
        entity_id: ctx.keyId, severity: "warning", ip: ctx.ip, metadata: { request_id: ctx.requestId },
      } as never);
      throw new ApiError(403, "FORBIDDEN_TENANT_FIELD", "organization_id ne peut pas être fourni : la clé API détermine l'organisation.");
    }
    const parsed = apiRideCreateSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR", "Données de réservation invalides.", fieldErrors(parsed.error));
    const v = parsed.data;

    // Géocodage si les coordonnées ne sont pas fournies
    let pickup = { address: v.pickup.address, lat: v.pickup.lat, lng: v.pickup.lng };
    if (pickup.lat == null || pickup.lng == null) {
      const g = await geocodeOne(pickup.address);
      if (!g) throw new ApiError(422, "PICKUP_NOT_GEOCODED", "Adresse de départ introuvable : fournissez pickup.lat et pickup.lng.");
      pickup = { address: pickup.address, lat: g.lat, lng: g.lng };
    }
    let dropoff = { address: v.dropoff.address, lat: v.dropoff.lat ?? null, lng: v.dropoff.lng ?? null };
    if (dropoff.lat == null || dropoff.lng == null) {
      const g = await geocodeOne(dropoff.address).catch(() => null);
      if (g) dropoff = { address: dropoff.address, lat: g.lat, lng: g.lng };
    }

    const pickupAt = v.pickup_at ? new Date(v.pickup_at) : v.date && v.time ? zonedTimeToUtc(v.date, v.time, ctx.orgTimezone) : new Date();
    const route = dropoff.lat != null && dropoff.lng != null ? estimateRoute({ lat: pickup.lat!, lng: pickup.lng! }, { lat: dropoff.lat, lng: dropoff.lng }) : null;
    const idempotencyKey = req.headers.get("idempotency-key")?.slice(0, 100) || null;

    const admin = createAdminClient();
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
        price_cents: v.price_cents ?? null,
        payment_method: v.payment_method,
        comment: v.comment ?? null,
        flight_number: v.flight_number ?? null,
        external_reference: v.external_reference ?? null,
        estimated_distance_m: route?.distanceM ?? null,
        estimated_duration_s: route?.durationS ?? null,
      } as never)
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505" && idempotencyKey) {
        const { data: existing } = await admin.from("rides").select(PUBLIC_RIDE_SELECT).eq("organization_id", ctx.orgId).eq("idempotency_key", idempotencyKey).single();
        return { status: 200, body: { data: publicRide(existing, env.appUrl), idempotent_replay: true }, rideId: (existing as any)?.id };
      }
      const code = /([A-Z_]{5,}):/.exec(error.message)?.[1];
      if (code?.startsWith("PLAN_LIMIT")) throw new ApiError(402, code, "Limite de l'offre atteinte.");
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
