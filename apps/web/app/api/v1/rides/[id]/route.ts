import { ApiError, PUBLIC_RIDE_SELECT, handle, notFoundOrForbidden, preflight, publicRide } from "@/lib/api/v1";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "rides:read", async (ctx) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "RIDE_NOT_FOUND", "Course introuvable.");
    const { data } = await createAdminClient().from("rides").select(PUBLIC_RIDE_SELECT).eq("id", id).eq("organization_id", ctx.orgId).maybeSingle();
    if (!data) await notFoundOrForbidden(ctx, id);
    return { status: 200, body: { data: publicRide(data, env.appUrl) }, rideId: id };
  });
}
