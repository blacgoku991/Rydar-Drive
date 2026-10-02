import { fieldErrors } from "@rydar/shared";
import { z } from "zod";
import { ApiError, handle, readJson } from "@/lib/api/v1";
import { UUID_RE, webhookTestRpc } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

const emptyBody = z.strictObject({});

/**
 * POST /api/v1/webhooks/{id}/test — met en file un événement « ping » (data = {}) : 202 + identifiant de l'envoi.
 * 409 WEBHOOK_TEST_PENDING : un test de cette adresse attend encore son envoi ; 429 WEBHOOK_TEST_RATE_LIMITED
 * (+ Retry-After) : plus de 10 tests et renvois en une minute pour la centrale, toutes clés et dashboard confondus.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "webhooks:manage", async (ctx) => {
    if (!UUID_RE.test(id)) throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook introuvable.");
    const parsed = emptyBody.safeParse(await readJson(req, 1_024));
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR", "Aucun paramètre attendu.", fieldErrors(parsed.error));
    const res = await webhookTestRpc("svc_webhook_ping", ctx.orgId, { type: "api", id: ctx.keyId }, { p_id: id });
    if (!res.ok) {
      throw new ApiError(res.status, res.code, res.message, undefined, res.retryAfter ? { "Retry-After": String(res.retryAfter) } : undefined);
    }
    return { status: 202, body: { data: { delivery_id: res.data.delivery_id } } };
  });
}
