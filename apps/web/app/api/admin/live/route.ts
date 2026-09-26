import { NextResponse } from "next/server";
import { getPlatformLive, getRideRoute } from "@/components/admin/platform-data";
import { getSession } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Carte en direct du super admin : chauffeurs en ligne de toutes les organisations (rafraîchie toutes les 5 s).
 * `?ride=<uuid>` : tracé d'une seule course (sélection sur la carte).
 * Lecture avec la session du super admin (RLS), jamais la clé service.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.profile.is_super_admin) return NextResponse.json({ error: "Accès refusé." }, { status: 403, headers: NO_STORE });
  const limit = await rateLimit(`admin-live:${session.user.id}`, 90, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429, headers: NO_STORE });

  try {
    const rideId = new URL(request.url).searchParams.get("ride");
    if (rideId !== null) {
      if (!UUID.test(rideId)) return NextResponse.json({ error: "Course invalide." }, { status: 422, headers: NO_STORE });
      const ride = await getRideRoute(session.supabase, rideId);
      if (!ride) return NextResponse.json({ error: "Course introuvable." }, { status: 404, headers: NO_STORE });
      return NextResponse.json(ride, { headers: NO_STORE });
    }
    return NextResponse.json(await getPlatformLive(session.supabase), { headers: NO_STORE });
  } catch (err) {
    console.error("[api/admin/live]", err);
    return NextResponse.json({ error: "Lecture impossible." }, { status: 500, headers: NO_STORE });
  }
}
