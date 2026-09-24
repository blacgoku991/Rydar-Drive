import { handle, preflight } from "@/lib/api/v1";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: Request) {
  return handle(req, "rides:read", async (ctx) => ({
    status: 200,
    body: { ok: true, organization_id: ctx.orgId, scopes: ctx.scopes, request_id: ctx.requestId },
  }));
}
