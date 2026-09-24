import { NextResponse } from "next/server";
import { searchPlaces } from "@/lib/geocode";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const limit = await rateLimit(`geocode:${await clientIp()}`, 90, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });
  const results = await searchPlaces(q);
  return NextResponse.json({ results }, { headers: { "cache-control": "private, max-age=60" } });
}
