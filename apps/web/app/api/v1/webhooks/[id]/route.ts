import { ApiError, handle } from "@/lib/api/v1";
import { UUID_RE, webhookRpc } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** DELETE /api/v1/webhooks/{id} — supprime l'adresse (et ses envois en attente) : 204. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "webhooks:manage", async (ctx) => {
    if (!UUID_RE.test(id)) throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook introuvable.");
    const res = await webhookRpc("svc_webhook_delete", ctx.orgId, { type: "api", id: ctx.keyId }, { p_id: id });
    if (!res.ok) throw new ApiError(res.status, res.code, res.message);
    return { status: 204, body: null };
  });
}
