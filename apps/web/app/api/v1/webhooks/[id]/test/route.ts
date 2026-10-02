import { fieldErrors } from "@rydar/shared";
import { z } from "zod";
import { ApiError, handle, readJson } from "@/lib/api/v1";
import { UUID_RE, webhookRpc } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

const emptyBody = z.strictObject({});

/** POST /api/v1/webhooks/{id}/test — met en file un événement « ping » (data = {}) : 202 + identifiant de l'envoi. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "webhooks:manage", async (ctx) => {
    if (!UUID_RE.test(id)) throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook introuvable.");
    const parsed = emptyBody.safeParse(await readJson(req, 1_024));
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR", "Aucun paramètre attendu.", fieldErrors(parsed.error));
    const res = await webhookRpc("svc_webhook_ping", ctx.orgId, { type: "api", id: ctx.keyId }, { p_id: id });
    if (!res.ok) throw new ApiError(res.status, res.code, res.message);
    return { status: 202, body: { data: { delivery_id: res.data.delivery_id } } };
  });
}
