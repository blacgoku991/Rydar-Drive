import { NextResponse } from "next/server";
import { geocodeRequest, searchPlaces } from "@/lib/geocode";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const near = Number.isFinite(lat) && Number.isFinite(lng) && url.searchParams.has("lat") ? { lat, lng } : undefined;
  const { ok, consumer } = await geocodeRequest();
  if (!ok) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });
  const results = await searchPlaces(q, near, consumer);
  return NextResponse.json({ results }, { headers: { "cache-control": "private, max-age=60" } });
}
