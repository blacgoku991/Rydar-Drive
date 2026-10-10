import "server-only";
import { randomUUID } from "node:crypto";
import { BROWSER_KEY_SCOPES, TENANT_FIELDS } from "@rydar/shared";
import { NextResponse } from "next/server";
import { extractApiKey, hashApiKey, parseApiKey, safeEqualHex } from "@/lib/api-keys";
import { serverEnv } from "@/lib/env";
import { rateLimit, rateLimitAll } from "@/lib/rate-limit";
import { ipBucket, ipFromHeaders } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

export type ApiContext = {
  requestId: string;
  startedAt: number;
  orgId: string;
  orgTimezone: string;
  /** Devise de l'organisation (celle de ses courses, private.before_ride_insert) */
  orgCurrency: string;
  keyId: string;
  scopes: string[];
  origin: string | null;
  allowedOrigin: string | null;
  ip: string | null;
  rate: { limit: number; remaining: number; resetAt: number };
  /**
   * Clé « navigateur » (origines autorisées) : portées BROWSER_KEY_SCOPES seulement (création de courses et devis),
   * prix et paiement fixés par la centrale, limites par IP (BROWSER_IP_LIMITS), par téléphone (BROWSER_PHONE_LIMIT) et
   * par organisation (BROWSER_ORG_CREATE_LIMIT), débit de la clé compté par portée (BROWSER_RATE_BUCKETS)
   */
  browser: boolean;
};

export class ApiError extends Error {
  /**
   * Clé identifiée (hash valide) avant l'erreur : la requête refusée apparaît dans le journal de la centrale.
   * allowedOrigin : origine d'une clé « navigateur » déjà vérifiée, la réponse d'erreur porte les en-têtes CORS.
   */
  ctx?: { orgId: string; keyId: string; allowedOrigin?: string | null };
  constructor(public status: number, public code: string, message: string, public details?: unknown, public headers?: Record<string, string>) {
    super(message);
  }
}

type BrowserScope = (typeof BROWSER_KEY_SCOPES)[number];
type WindowLimit = { id: string; limit: number; windowSec: number };

/**
 * Clé « navigateur » (publique : réservations factices et sonneries en rafale possibles) : limites par adresse IP
 * (IPv6 groupée par /64), compteurs propres à chaque organisation, vérifiées AVANT le débit de la clé (un visiteur
 * refusé ne consomme pas le débit partagé par tous les visiteurs du site). Mêmes plafonds que le mini-site
 * (app/book/[slug]/actions.ts et son devis app/api/book/[slug]/quote). Clé serveur : son seul débit. Une portée ajoutée
 * à BROWSER_KEY_SCOPES sans ses limites ne compile pas.
 */
export const BROWSER_IP_LIMITS: Record<BrowserScope, readonly WindowLimit[]> = {
  "rides:create": [
    { id: "create", limit: 6, windowSec: 600 },
    { id: "create:day", limit: 20, windowSec: 86_400 },
  ],
  "rides:quote": [
    { id: "quote", limit: 30, windowSec: 60 },
    { id: "quote:day", limit: 600, windowSec: 86_400 },
  ],
};

/**
 * Débit d'une clé « navigateur » (rate_limit_per_minute) compté PAR PORTÉE : les devis (plusieurs par réservation,
 * jusqu'à 30 par minute et par adresse) ont leur propre compteur et ne privent jamais les réservations du débit de la
 * clé. Clé serveur : un seul compteur, inchangé.
 */
export const BROWSER_RATE_BUCKETS: Record<BrowserScope, string> = { "rides:create": "", "rides:quote": ":quote" };

/** Clé « navigateur » : réservations par téléphone du client (même plafond que le mini-site, booking:phone). */
export const BROWSER_PHONE_LIMIT = { limit: 3, windowSec: 3_600 } as const;

/**
 * Clé « navigateur » : réservations par organisation, toutes adresses IP, tous numéros et toutes ses clés navigateur
 * confondus (même plafond que le mini-site, booking:org) : des adresses et des numéros renouvelés ne dépassent jamais
 * 60 réservations par heure (offres au chauffeur, quota mensuel de l'offre).
 */
export const BROWSER_ORG_CREATE_LIMIT = { limit: 60, windowSec: 3_600 } as const;

/** Refus d'une portée hors BROWSER_KEY_SCOPES : même texte que la création de la clé (apiKeyCreateSchema). */
const BROWSER_SCOPE_MESSAGE =
  "Clé utilisée depuis le navigateur (origines autorisées) : seules la création de courses et les devis sont permis.";

const isBrowserScope = (scope: string): scope is BrowserScope => (BROWSER_KEY_SCOPES as readonly string[]).includes(scope);

/** En-têtes lisibles par le JavaScript du site (CORS) : Retry-After d'un 429, identifiant de requête pour le support. */
const EXPOSED_HEADERS = "Retry-After, X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset";

/**
 * Limite par IP (IPv6 groupée par /64) des requêtes NON authentifiées (clé absente, inconnue ou invalide) : au-delà de
 * 20 par minute, 429 et plus rien n'est journalisé. Une clé serveur valide n'a que SA limite (rate_limit_per_minute),
 * jamais celle de l'IP : un serveur réglé à 1 000/min ou un intégrateur qui sert plusieurs centrales depuis une même
 * adresse n'est pas plafonné (une clé « navigateur », publique, a en plus BROWSER_IP_LIMITS). Une requête sans clé bien
 * formée est refusée sans aucune requête SQL.
 */
const AUTH_FAILURES_PER_MINUTE = 20;
/** Refus d'une clé identifiée (origine non listée, clé révoquée ou expirée, débit de la clé…) journalisés par clé et par
 *  minute : au-delà, même réponse mais plus d'écriture (la clé « navigateur » est publique, le journal reste lisible). */
const KEY_FAILURES_LOGGED_PER_MINUTE = 20;

/** Centrale sans offre (plan_id null) : tout est autorisé — même règle que private.org_limits (migration 002800). */
const NO_PLAN_LIMITS = { api_access: true, booking_site: true, custom_domain: true, advanced_stats: true };

const retryAfter = (resetAt: number) => ({ "Retry-After": String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) });

function clientIpOf(req: Request) {
  return ipFromHeaders(req.headers);
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

export function preflight(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*" } });
}

/**
 * Authentifie la clé API : préfixe → hash HMAC (temps constant) → révocation/expiration → tenant actif → scope → offre
 * → clé « navigateur » : portée (BROWSER_KEY_SCOPES), origine, limites par IP → débit de la clé (clé « navigateur » :
 * compteur de la portée, BROWSER_RATE_BUCKETS).
 */
export async function authenticate(req: Request, scope: string): Promise<ApiContext> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const origin = req.headers.get("origin");
  const ip = clientIpOf(req);
  const parsed = parseApiKey(extractApiKey(req.headers));
  if (!parsed) throw new ApiError(401, "INVALID_API_KEY", "Clé API absente ou mal formée (Authorization: Bearer rdk_live_…).");

  const admin = createAdminClient();
  const { data: key } = await admin
    .from("api_keys")
    .select("id, organization_id, scopes, rate_limit_per_minute, allowed_origins, expires_at, revoked_at, organization:organizations(status, timezone, currency, plan_id, limits_override, plan:plans(limits))")
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
  // Clé identifiée : toute erreur suivante est rattachée à la centrale et à la clé (journal api_logs) ; origine d'une
  // clé « navigateur » déjà vérifiée : la réponse d'erreur porte les en-têtes CORS
  const fail = (e: ApiError, allowedOrigin: string | null = null) =>
    Object.assign(e, { ctx: { orgId: k.organization_id as string, keyId: k.id as string, allowedOrigin } });
  if (k.revoked_at) throw fail(new ApiError(401, "API_KEY_REVOKED", "Cette clé API a été révoquée."));
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) throw fail(new ApiError(401, "API_KEY_EXPIRED", "Cette clé API a expiré."));
  if (!org || org.status !== "active") throw fail(new ApiError(403, "ORGANIZATION_INACTIVE", "Organisation suspendue ou archivée."));
  if (!(k.scopes as string[]).includes(scope)) throw fail(new ApiError(403, "INSUFFICIENT_SCOPE", `Permission requise : ${scope}.`));

  const plan = Array.isArray(org.plan) ? org.plan[0] : org.plan;
  const limits = { ...(org.plan_id == null ? NO_PLAN_LIMITS : (plan?.limits ?? {})), ...(org.limits_override ?? {}) };
  if (!limits.api_access) throw fail(new ApiError(403, "PLAN_FEATURE_API", "L'API n'est pas incluse dans l'offre de cette organisation."));

  // Clé « navigateur » : lisible par tout visiteur du site → portées BROWSER_KEY_SCOPES seulement (création de courses
  // et devis), depuis une origine listée, avec des limites par IP
  const allowedOrigins = (k.allowed_origins ?? []) as string[];
  const browser = allowedOrigins.length > 0;
  let allowedOrigin: string | null = null;
  let rateKey = `api:${k.id}`;
  if (browser) {
    if (!isBrowserScope(scope)) throw fail(new ApiError(403, "INSUFFICIENT_SCOPE", BROWSER_SCOPE_MESSAGE));
    if (!origin || !allowedOrigins.includes(origin)) {
      throw fail(new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origine non autorisée pour cette clé."));
    }
    allowedOrigin = origin;
    const bucket = ipBucket(ip);
    const byIp = await rateLimitAll(
      BROWSER_IP_LIMITS[scope].map((l) => ({ key: `api:ip:${l.id}:${k.organization_id}:${bucket}`, limit: l.limit, windowSec: l.windowSec })),
    );
    if (!byIp.ok) {
      throw fail(
        new ApiError(429, "RATE_LIMITED", "Trop de demandes depuis cette adresse : réessayez plus tard.", undefined, retryAfter(byIp.resetAt)),
        allowedOrigin,
      );
    }
    rateKey += BROWSER_RATE_BUCKETS[scope];
  }

  const rl = await rateLimit(rateKey, k.rate_limit_per_minute, 60);
  const rate = { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt };
  if (!rl.ok) throw fail(new ApiError(429, "RATE_LIMITED", "Trop de requêtes pour cette clé.", undefined, retryAfter(rl.resetAt)), allowedOrigin);
  return {
    requestId, startedAt, origin, allowedOrigin, ip,
    orgId: k.organization_id, orgTimezone: org.timezone ?? "Europe/Paris", orgCurrency: org.currency || "EUR",
    keyId: k.id, scopes: k.scopes, rate, browser,
  };
}

/**
 * Clé « navigateur » : réservations par téléphone du client (BROWSER_PHONE_LIMIT) PUIS par organisation
 * (BROWSER_ORG_CREATE_LIMIT), dans cet ordre comme le mini-site : une réservation refusée pour son numéro ne consomme
 * pas le plafond de l'organisation. 429 + Retry-After au-delà. Clé serveur : ni l'un ni l'autre (son seul débit).
 */
export async function limitBrowserBooking(ctx: ApiContext, phone: string) {
  if (!ctx.browser) return;
  const byPhone = await rateLimit(`api:phone:${ctx.orgId}:${phone}`, BROWSER_PHONE_LIMIT.limit, BROWSER_PHONE_LIMIT.windowSec);
  if (!byPhone.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Trop de réservations pour ce numéro de téléphone : réessayez plus tard.", undefined, retryAfter(byPhone.resetAt));
  }
  const byOrg = await rateLimit(`api:org:${ctx.orgId}:create`, BROWSER_ORG_CREATE_LIMIT.limit, BROWSER_ORG_CREATE_LIMIT.windowSec);
  if (!byOrg.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Trop de réservations reçues par ce site en une heure : réessayez plus tard.", undefined, retryAfter(byOrg.resetAt));
  }
}

/**
 * Le tenant vient EXCLUSIVEMENT de la clé API : un champ d'organisation dans le corps est refusé (403) et tracé dans
 * l'audit (path : route concernée, absent pour POST /rides).
 */
export async function rejectTenantFields(ctx: ApiContext, body: unknown, path?: string) {
  if (!body || typeof body !== "object" || !TENANT_FIELDS.some((f) => f in (body as Record<string, unknown>))) return;
  await createAdminClient().from("audit_logs").insert({
    organization_id: ctx.orgId, actor_type: "api", action: "security.tenant_field_rejected", entity_type: "api_keys",
    entity_id: ctx.keyId, severity: "warning", ip: ctx.ip, metadata: path ? { request_id: ctx.requestId, path } : { request_id: ctx.requestId },
  } as never);
  throw new ApiError(403, "FORBIDDEN_TENANT_FIELD", "organization_id ne peut pas être fourni : la clé API détermine l'organisation.");
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
    h["Access-Control-Expose-Headers"] = EXPOSED_HEADERS;
    h["Vary"] = "Origin";
  }
  return h;
}

/**
 * Journalise la requête (api_logs) + dernière utilisation de la clé (seulement si elle s'est authentifiée :
 * jamais pour une clé révoquée, expirée ou refusée). Ne bloque jamais la réponse.
 */
async function logRequest(
  req: Request,
  ctx: Partial<ApiContext> & { requestId: string; startedAt: number },
  status: number,
  errorCode?: string,
  rideId?: string,
  touchKey = true,
) {
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
    if (ctx.keyId && touchKey) await admin.from("api_keys").update({ last_used_at: new Date().toISOString(), last_used_ip: ctx.ip ?? null } as never).eq("id", ctx.keyId);
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
    // 204 : aucun corps (Response refuse un corps JSON avec ce statut)
    if (res.status === 204) return new NextResponse(null, { status: 204, headers: baseHeaders(ctx) });
    return NextResponse.json(res.body, { status: res.status, headers: baseHeaders(ctx) });
  } catch (error) {
    let e =
      error instanceof ApiError
        ? error
        : (console.error("[api] erreur interne", error), new ApiError(500, "INTERNAL_ERROR", "Erreur interne. Réessayez."));
    const c = ctx ?? { ...fallback, ...(e.ctx ?? {}) };
    let log = true;
    if (!ctx && !e.ctx) {
      // Requête non authentifiée (sans clé, clé inconnue ou invalide) : limite par IP, au-delà 429 sans écriture
      const failures = await rateLimit(`api:fail:${ipBucket(clientIpOf(req))}`, AUTH_FAILURES_PER_MINUTE, 60);
      log = failures.ok;
      if (!failures.ok) {
        e = new ApiError(429, "RATE_LIMITED", "Trop d'échecs d'authentification. Réessayez dans une minute.", undefined, retryAfter(failures.resetAt));
      }
    } else if (!ctx && e.ctx) {
      // Clé identifiée mais refusée : réponse inchangée, journal borné par clé
      log = (await rateLimit(`api:fail:key:${e.ctx.keyId}`, KEY_FAILURES_LOGGED_PER_MINUTE, 60)).ok;
    }
    if (log) await logRequest(req, c, e.status, e.code, undefined, !!ctx);
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details, request_id: c.requestId } },
      { status: e.status, headers: { ...baseHeaders(c), ...(e.headers ?? {}) } },
    );
  }
}

/**
 * Corps JSON borné AVANT d'être mis en mémoire : Content-Length annoncé trop grand refusé d'emblée, lecture du flux
 * coupée au premier dépassement (une clé navigateur est publique : des corps de plusieurs centaines de Mo satureraient
 * sinon la mémoire du serveur web, /api/v1 échappant au proxy et à son tampon).
 */
export async function readJson(req: Request, maxBytes = 32_768): Promise<unknown> {
  const tooLarge = () => new ApiError(413, "PAYLOAD_TOO_LARGE", "Corps de requête trop volumineux.");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  if (req.body) {
    const reader = req.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Corps JSON invalide.");
  }
}

/** Représentation publique d'une course (aucun champ interne) : partagée avec les webhooks du worker (@rydar/shared). */
export { publicRide } from "@rydar/shared";

/**
 * Colonnes lues pour publicRide ; private.claim_webhook_deliveries construit la même ligne en SQL (mêmes noms).
 * « driver » : colonne calculée public.ride_public_driver (20260924007000, EXECUTE service role : client admin
 * seulement), même objet que les webhooks — chauffeur de l'organisation : prénom et véhicule ; chauffeur partenaire
 * du réseau partagé : prénom, véhicule figé à l'acceptation, exploitant (« operator »), null 24 h après la fin.
 */
export const PUBLIC_RIDE_SELECT =
  "id, number, type, status, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pickup_at, passengers, luggage, vehicle_category, price_cents, currency, payment_method, flight_number, external_reference, estimated_distance_m, estimated_duration_s, route_polyline, created_at, accepted_at, driver_arrived_at, started_at, completed_at, cancelled_at, driver:ride_public_driver";

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
