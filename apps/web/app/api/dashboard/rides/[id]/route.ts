import { NextResponse } from "next/server";
import { getOrgContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

/**
 * Chronologie d'une course (panneau du command center) ; `?route=1` : son tracé seul (absent de l'instantané en direct,
 * chargé quand la carte doit le dessiner). RLS : organisation courante uniquement.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getOrgContext();
  if (!ctx) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Course introuvable." }, { status: 404 });
  if (new URL(request.url).searchParams.get("route") === "1") {
    const { data, error } = await ctx.supabase.from("rides").select("route_polyline").eq("id", id).eq("organization_id", ctx.org.id).maybeSingle();
    if (error) return NextResponse.json({ error: "Lecture impossible." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Course introuvable." }, { status: 404 });
    return NextResponse.json({ route_polyline: data.route_polyline ?? null }, { headers: { "cache-control": "no-store" } });
  }
  const { data, error } = await ctx.supabase
    .from("ride_events")
    .select("id, category, level, type, message, actor_type, data, created_at")
    .eq("ride_id", id)
    .eq("organization_id", ctx.org.id)
    .neq("category", "system")
    .order("id", { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: "Lecture impossible." }, { status: 500 });
  return NextResponse.json({ events: data ?? [] }, { headers: { "cache-control": "no-store" } });
}
