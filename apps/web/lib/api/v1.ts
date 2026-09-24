import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { extractApiKey, hashApiKey, parseApiKey, safeEqualHex } from "@/lib/api-keys";
import { serverEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type ApiContext = {
  requestId: string;
  startedAt: number;
  orgId: string;
  orgTimezone: string;
  keyId: string;
  scopes: string[];
  origin: string | null;
  allowedOrigin: string | null;
  ip: string | null;
  rate: { limit: number; remaining: number; resetAt: number };
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public headers?: Record<string, string>) {
    super(message);
  }
}

function clientIpOf(req: Request) {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

export function preflight(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*" } });
}

/** Authentifie la clé API : préfixe → hash HMAC (temps constant) → révocation/expiration → tenant actif → scope → débit. */
export async function authenticate(req: Request, scope: string): Promise<ApiContext> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const origin = req.headers.get("origin");
  const parsed = parseApiKey(extractApiKey(req.headers));
  if (!parsed) throw new ApiError(401, "INVALID_API_KEY", "Clé API absente ou mal formée (Authorization: Bearer rdk_live_…).");

  const admin = createAdminClient();
  const { data: key } = await admin
    .from("api_keys")
    .select("id, organization_id, scopes, rate_limit_per_minute, allowed_origins, expires_at, revoked_at, organization:organizations(status, timezone, limits_override, plan:plans(limits))")
    .eq("prefix", parsed.prefix)
    .maybeSingle();
  const { data: secret } = key
    ? await admin.from("api_key_secrets").select("key_hash").eq("api_key_id", (key as any).id).maybeSingle()
    : { data: null };
  const expected = (secret as any)?.key_hash as string | undefined;
  const actual = hashApiKey(parsed.key, serverEnv().apiKeyPepper);
  if (!key || !expected || !safeEqualHex(expected, actual)) {
    throw new ApiError(401, "INVALID_API_KEY", "Clé API invalide.");
  }
  const k = key as any;
  const org = Array.isArray(k.organization) ? k.organization[0] : k.organization;
  if (k.revoked_at) throw new ApiError(401, "API_KEY_REVOKED", "Cette clé API a été révoquée.");
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) throw new ApiError(401, "API_KEY_EXPIRED", "Cette clé API a expiré.");
  if (!org || org.status !== "active") throw new ApiError(403, "ORGANIZATION_INACTIVE", "Organisation suspendue ou archivée.");
  if (!(k.scopes as string[]).includes(scope)) throw new ApiError(403, "INSUFFICIENT_SCOPE", `Permission requise : ${scope}.`);

  const plan = Array.isArray(org.plan) ? org.plan[0] : org.plan;
  const limits = { ...(plan?.limits ?? {}), ...(org.limits_override ?? {}) };
  if (!limits.api_access) throw new ApiError(403, "PLAN_FEATURE_API", "L'API n'est pas incluse dans l'offre de cette organisation.");

  const rl = await rateLimit(`api:${k.id}`, k.rate_limit_per_minute, 60);
  const rate = { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt };
  if (!rl.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Trop de requêtes pour cette clé.", undefined, {
      "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
    });
  }
  const allowedOrigin = origin && (k.allowed_origins as string[]).includes(origin) ? origin : null;
  return {
    requestId, startedAt, origin, allowedOrigin, ip: clientIpOf(req),
    orgId: k.organization_id, orgTimezone: org.timezone ?? "Europe/Paris", keyId: k.id, scopes: k.scopes, rate,
  };
}

function baseHeaders(ctx: Partial<ApiContext> & { requestId: string }) {
  const h: Record<string, string> = { "X-Request-Id": ctx.requestId, "Cache-Control": "no-store" };
  if (ctx.rate) {
    h["X-RateLimit-Limit"] = String(ctx.rate.limit);
    h["X-RateLimit-Remaining"] = String(ctx.rate.remaining);
    h["X-RateLimit-Reset"] = String(Math.ceil(ctx.rate.resetAt / 1000));
  }
  if (ctx.allowedOrigin) {
    h["Access-Control-Allow-Origin"] = ctx.allowedOrigin;
    h["Vary"] = "Origin";
  }
  return h;
}

/** Journalise la requête (api_logs) + dernière utilisation de la clé. Ne bloque jamais la réponse. */
async function logRequest(req: Request, ctx: Partial<ApiContext> & { requestId: string; startedAt: number }, status: number, errorCode?: string, rideId?: string) {
  try {
    const admin = createAdminClient();
    const url = new URL(req.url);
    await admin.from("api_logs").insert({
      organization_id: ctx.orgId ?? null,
      api_key_id: ctx.keyId ?? null,
      request_id: ctx.requestId,
      method: req.method,
      path: url.pathname,
      status_code: status,
      ip: ctx.ip ?? clientIpOf(req),
      user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      latency_ms: Date.now() - ctx.startedAt,
      error_code: errorCode ?? null,
      ride_id: rideId ?? null,
    } as never);
    if (ctx.keyId) await admin.from("api_keys").update({ last_used_at: new Date().toISOString(), last_used_ip: ctx.ip ?? null } as never).eq("id", ctx.keyId);
  } catch (e) {
    console.error("[api] log failed", e);
  }
}

/** Enveloppe commune : erreurs typées, en-têtes, journalisation. */
export async function handle(
  req: Request,
  scope: string,
  fn: (ctx: ApiContext) => Promise<{ status: number; body: unknown; rideId?: string }>,
) {
  const fallback = { requestId: randomUUID(), startedAt: Date.now() };
  let ctx: ApiContext | null = null;
  try {
    ctx = await authenticate(req, scope);
    const res = await fn(ctx);
    await logRequest(req, ctx, res.status, undefined, res.rideId);
    return NextResponse.json(res.body, { status: res.status, headers: baseHeaders(ctx) });
  } catch (error) {
    const e =
      error instanceof ApiError
        ? error
        : (console.error("[api] erreur interne", error), new ApiError(500, "INTERNAL_ERROR", "Erreur interne. Réessayez."));
    const c = ctx ?? fallback;
    await logRequest(req, c, e.status, e.code);
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details, request_id: c.requestId } },
      { status: e.status, headers: { ...baseHeaders(c), ...(e.headers ?? {}) } },
    );
  }
}

export async function readJson(req: Request, maxBytes = 32_768): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Corps de requête trop volumineux.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Corps JSON invalide.");
  }
}

/** Représentation publique d'une course (aucun champ interne). */
export function publicRide(r: any, appUrl: string) {
  const d = Array.isArray(r.driver) ? r.driver[0] : r.driver;
  const v = d ? (Array.isArray(d.vehicle) ? d.vehicle[0] : d.vehicle) : null;
  return {
    id: r.id,
    number: r.number,
    type: r.type,
    status: r.status,
    pickup: { address: r.pickup_address, lat: r.pickup_lat, lng: r.pickup_lng },
    dropoff: { address: r.dropoff_address, lat: r.dropoff_lat, lng: r.dropoff_lng },
    pickup_at: r.pickup_at,
    passengers: r.passengers,
    luggage: r.luggage,
    vehicle_category: r.vehicle_category,
    price_cents: r.price_cents,
    currency: r.currency,
    payment_method: r.payment_method,
    flight_number: r.flight_number,
    external_reference: r.external_reference,
    route: r.estimated_distance_m != null ? { distance_m: r.estimated_distance_m, duration_s: r.estimated_duration_s, polyline: r.route_polyline ?? null } : null,
    driver: d ? { first_name: d.first_name, vehicle: v ? { model: `${v.brand ?? ""} ${v.model}`.trim(), color: v.color, plate: v.plate } : null } : null,
    timestamps: {
      created_at: r.created_at,
      accepted_at: r.accepted_at ?? null,
      driver_arrived_at: r.driver_arrived_at ?? null,
      started_at: r.started_at ?? null,
      completed_at: r.completed_at ?? null,
      cancelled_at: r.cancelled_at ?? null,
    },
    links: { self: `${appUrl}/api/v1/rides/${r.id}` },
  };
}

export const PUBLIC_RIDE_SELECT =
  "id, number, type, status, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pickup_at, passengers, luggage, vehicle_category, price_cents, currency, payment_method, flight_number, external_reference, estimated_distance_m, estimated_duration_s, route_polyline, created_at, accepted_at, driver_arrived_at, started_at, completed_at, cancelled_at, driver:drivers!rides_organization_id_driver_id_fkey(first_name, vehicle:vehicles(brand, model, color, plate))";

/** Accès inter-tenant : 403 + trace de sécurité si la ressource existe ailleurs, 404 sinon. */
export async function notFoundOrForbidden(ctx: ApiContext, rideId: string): Promise<never> {
  const admin = createAdminClient();
  const { data } = await admin.from("rides").select("organization_id").eq("id", rideId).maybeSingle();
  if (data && (data as any).organization_id !== ctx.orgId) {
    await admin.from("audit_logs").insert({
      organization_id: ctx.orgId,
      actor_type: "api",
      action: "security.cross_tenant_access",
      entity_type: "rides",
      entity_id: rideId,
      severity: "critical",
      ip: ctx.ip,
      metadata: { api_key_id: ctx.keyId, request_id: ctx.requestId },
    } as never);
    throw new ApiError(403, "FORBIDDEN_TENANT", "Accès refusé : cette course n'appartient pas à votre organisation.");
  }
  throw new ApiError(404, "RIDE_NOT_FOUND", "Course introuvable.");
}
