import { TENANT_FIELDS, WEBHOOK_FIELD_ERROR_CODES, fieldErrors, webhookUpsertSchema } from "@rydar/shared";
import { ApiError, handle, readJson } from "@/lib/api/v1";
import { createAdminClient } from "@/lib/supabase/admin";
import { WEBHOOK_ENDPOINT_SELECT, webhookRpc } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
// Pas d'OPTIONS/CORS : gestion des webhooks depuis un serveur seulement (une clé « navigateur » est refusée par
// authenticate(), seule la création de courses lui est permise).

const SCOPE = "webhooks:manage";

/** GET /api/v1/webhooks — adresses enregistrées par l'organisation de la clé (jamais les secrets). */
export async function GET(req: Request) {
  return handle(req, SCOPE, async (ctx) => {
    const { data, error } = await createAdminClient()
      .from("webhook_endpoints")
      .select(WEBHOOK_ENDPOINT_SELECT)
      .eq("organization_id", ctx.orgId)
      .order("created_at", { ascending: true });
    if (error) throw new ApiError(500, "QUERY_FAILED", "Lecture impossible.");
    return { status: 200, body: { data: data ?? [] } };
  });
}

/**
 * POST /api/v1/webhooks — enregistre une adresse (même adresse déjà enregistrée : réglages mis à jour et webhook
 * réactivé, secret inchangé sauf s'il est fourni). Le secret généré n'est renvoyé qu'à la création.
 */
export async function POST(req: Request) {
  return handle(req, SCOPE, async (ctx) => {
    const body = await readJson(req, 8_192);
    // Le tenant vient EXCLUSIVEMENT de la clé API (même règle que POST /rides).
    if (body && typeof body === "object" && TENANT_FIELDS.some((f) => f in (body as Record<string, unknown>))) {
      await createAdminClient().from("audit_logs").insert({
        organization_id: ctx.orgId, actor_type: "api", action: "security.tenant_field_rejected", entity_type: "api_keys",
        entity_id: ctx.keyId, severity: "warning", ip: ctx.ip, metadata: { request_id: ctx.requestId, path: "/api/v1/webhooks" },
      } as never);
      throw new ApiError(403, "FORBIDDEN_TENANT_FIELD", "organization_id ne peut pas être fourni : la clé API détermine l'organisation.");
    }
    const parsed = webhookUpsertSchema.safeParse(body);
    if (!parsed.success) {
      // Un seul champ en cause (url, events, secret) : même code que la vérification en base
      const fields = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
      const only = fields.size === 1 ? [...fields][0]! : "";
      const code = WEBHOOK_FIELD_ERROR_CODES[only];
      throw new ApiError(422, code ?? "VALIDATION_ERROR", code ? parsed.error.issues[0]!.message : "Données invalides.", fieldErrors(parsed.error));
    }
    const v = parsed.data;
    const res = await webhookRpc("svc_webhook_upsert", ctx.orgId, { type: "api", id: ctx.keyId }, {
      p_url: v.url,
      p_description: v.description,
      p_events: v.events,
      p_secret: v.secret,
    });
    if (!res.ok) throw new ApiError(res.status, res.code, res.message);
    const created = res.data.created === true;
    return {
      status: created ? 201 : 200,
      body: { data: res.data.endpoint, secret: created ? (res.data.secret ?? null) : null, created },
    };
  });
}
