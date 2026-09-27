import { NextResponse } from "next/server";
import { getKpis, getLiveSnapshot } from "@/lib/queries/live";
import { getOrgContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ctx = await getOrgContext();
  if (!ctx) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  const onlyKpis = new URL(request.url).searchParams.get("kpis") === "1";
  if (onlyKpis) return NextResponse.json({ kpis: await getKpis(ctx.supabase, ctx.org.id) });
  try {
    return NextResponse.json(await getLiveSnapshot(ctx.supabase, ctx.org.id), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // Lecture partielle en échec : pas d'instantané vide (il viderait la liste et la carte) ; le client garde son état
    console.error(error);
    return NextResponse.json({ error: "Synchronisation momentanément impossible." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
