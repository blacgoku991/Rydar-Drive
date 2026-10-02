import "server-only";
import { ERROR_MESSAGES } from "@rydar/shared";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Appels des RPC svc_webhook_* (service role seul, migrations 20260924006000 et 006100) : chacune revérifie en base
 * que l'adresse ou l'envoi appartient à p_org et inscrit l'action dans audit_logs. Appelants : API v1 (clé de la
 * centrale, acteur « api ») et actions serveur du dashboard (owner / admin contrôlé avant, acteur « user »).
 */
export type WebhookRpc =
  | "svc_webhook_upsert"
  | "svc_webhook_delete"
  | "svc_webhook_set_enabled"
  | "svc_webhook_rotate_secret"
  | "svc_webhook_ping"
  | "svc_webhook_redeliver";

export type WebhookActor = { type: "user" | "api"; id: string };

export type WebhookRpcResult =
  | { ok: true; data: Record<string, any> }
  | { ok: false; code: string; message: string; status: number; retryAfter?: number };

/** Statut HTTP de l'API v1 pour chaque code renvoyé par les RPC. */
const HTTP_STATUS: Record<string, number> = {
  WEBHOOK_INVALID_URL: 422,
  WEBHOOK_INVALID_EVENTS: 422,
  WEBHOOK_INVALID_SECRET: 422,
  VALIDATION_ERROR: 422,
  WEBHOOK_LIMIT: 409,
  WEBHOOK_DISABLED: 409,
  WEBHOOK_TEST_PENDING: 409,
  WEBHOOK_TEST_RATE_LIMITED: 429,
  WEBHOOK_NOT_FOUND: 404,
  WEBHOOK_DELIVERY_NOT_FOUND: 404,
  FORBIDDEN_TENANT: 403,
};

/** Colonnes publiques d'une adresse (jamais le secret, rangé dans webhook_endpoint_secrets). */
export const WEBHOOK_ENDPOINT_SELECT =
  "id, url, description, events, enabled, disabled_reason, created_at, last_success_at, last_failure_at, last_error";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Texte refusé par PostgreSQL (NUL, octets hors UTF-8) : donnée invalide, pas une panne (422, jamais 500). */
const INVALID_TEXT_SQLSTATES = new Set(["22P05", "22021"]);

export async function webhookRpc(fn: WebhookRpc, org: string, actor: WebhookActor, args: Record<string, unknown>): Promise<WebhookRpcResult> {
  const { data, error } = await createAdminClient().rpc(fn, { p_org: org, ...args, p_actor_type: actor.type, p_actor_id: actor.id });
  if (error) {
    if (error.code === "42501") return { ok: false, code: "FORBIDDEN_TENANT", message: "Accès refusé.", status: 403 };
    if (error.code && INVALID_TEXT_SQLSTATES.has(error.code)) {
      return { ok: false, code: "VALIDATION_ERROR", message: "Caractère non autorisé dans les données envoyées.", status: 422 };
    }
    console.error(`[webhooks] ${fn} : ${error.code ?? ""} ${error.message}`);
    return { ok: false, code: "WEBHOOK_OPERATION_FAILED", message: "Opération impossible pour le moment. Réessayez.", status: 500 };
  }
  const res = (data ?? {}) as { ok?: boolean; code?: string; message?: string } & Record<string, unknown>;
  if (res.ok) return { ok: true, data: res };
  const code = res.code || "WEBHOOK_OPERATION_FAILED";
  return {
    ok: false,
    code,
    message: res.message || ERROR_MESSAGES[code] || "Opération impossible.",
    status: HTTP_STATUS[code] ?? 409,
    // Compteur SQL sur la dernière minute glissante : une minute d'attente suffit toujours
    ...(code === "WEBHOOK_TEST_RATE_LIMITED" ? { retryAfter: 60 } : {}),
  };
}

/**
 * Tests (« ping ») et renvois : 10 par minute et par centrale, dashboard et API confondus. Ce compteur (Redis) arrête
 * une rafale avant la base ; svc_webhook_ping et svc_webhook_redeliver gardent le contrôle exact (même plafond, et un
 * seul test en attente par adresse : WEBHOOK_TEST_PENDING).
 */
export const WEBHOOK_TESTS_PER_MINUTE = 10;

export async function webhookTestRpc(
  fn: Extract<WebhookRpc, "svc_webhook_ping" | "svc_webhook_redeliver">,
  org: string,
  actor: WebhookActor,
  args: Record<string, unknown>,
): Promise<WebhookRpcResult> {
  const rl = await rateLimit(`webhook-test:${org}`, WEBHOOK_TESTS_PER_MINUTE, 60);
  if (!rl.ok) {
    return {
      ok: false,
      code: "WEBHOOK_TEST_RATE_LIMITED",
      message: ERROR_MESSAGES.WEBHOOK_TEST_RATE_LIMITED ?? "Trop de tests et de renvois de webhooks : réessayez dans un instant.",
      status: 429,
      retryAfter: Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)),
    };
  }
  return webhookRpc(fn, org, actor, args);
}
