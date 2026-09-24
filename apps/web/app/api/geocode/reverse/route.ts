import { NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/geocode";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

/** Adresse d'un point (clic sur la carte, « ma position »). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "Coordonnées invalides" }, { status: 422 });
  }
  const limit = await rateLimit(`geocode:${await clientIp()}`, 90, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });
  const place = await reverseGeocode(lat, lng);
  return NextResponse.json({ place }, { headers: { "cache-control": "private, max-age=300" } });
}
