import { apiRideCancelSchema } from "@rydar/shared";
import { ApiError, PUBLIC_RIDE_SELECT, handle, notFoundOrForbidden, preflight, publicRide, readJson } from "@/lib/api/v1";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "rides:cancel", async (ctx) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "RIDE_NOT_FOUND", "Course introuvable.");
    const parsed = apiRideCancelSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError(422, "VALIDATION_ERROR", "Motif invalide.");
    const admin = createAdminClient();
    const { data: own } = await admin.from("rides").select("id").eq("id", id).eq("organization_id", ctx.orgId).maybeSingle();
    if (!own) await notFoundOrForbidden(ctx, id);
    const { data, error } = await admin.rpc("svc_cancel_ride", { p_org: ctx.orgId, p_ride_id: id, p_reason: parsed.data.reason ?? null, p_actor: "api" });
    if (error) throw new ApiError(error.code === "42501" ? 403 : 500, error.code === "42501" ? "FORBIDDEN_TENANT" : "CANCEL_FAILED", "Annulation impossible.");
    const res = data as { ok: boolean; code: string; message?: string };
    if (!res.ok) throw new ApiError(409, res.code, res.message ?? "Annulation impossible.");
    const { data: ride } = await admin.from("rides").select(PUBLIC_RIDE_SELECT).eq("id", id).single();
    return { status: 200, body: { data: publicRide(ride, env.appUrl) }, rideId: id };
  });
}
