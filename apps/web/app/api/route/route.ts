import { NextResponse } from "next/server";
import { z } from "zod";
import { computeRoute } from "@/lib/geo/routing";
import { getOrgContext } from "@/lib/org-context";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** Itinéraire routier (approche chauffeur → départ, aperçu) pour le dashboard. */
export async function POST(request: Request) {
  const ctx = await getOrgContext();
  if (!ctx) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  const limit = await rateLimit(`route:${ctx.user.id}`, 120, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
  const parsed = z.object({ from: point, to: point }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 422 });
  const r = await computeRoute(parsed.data.from, parsed.data.to);
  return NextResponse.json(
    { distanceM: r.distanceM, durationS: r.durationS, polyline: r.polyline, approximate: r.approximate },
    { headers: { "cache-control": "no-store" } },
  );
}
