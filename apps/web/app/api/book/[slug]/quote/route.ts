import { estimatePrice, matchFixedFare, vehicleCategorySchema, type PricingRule } from "@rydar/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { computeRoute } from "@/lib/geo/routing";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const place = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), address: z.string().max(300) });
const schema = z.object({ pickup: place, dropoff: place, category: vehicleCategorySchema, pickupAt: z.iso.datetime({ offset: true }).optional() });

/**
 * Devis public du mini-site (aucun compte) : itinéraire réel + prix indicatif
 * (forfait reconnu, sinon grille) si l'organisation l'affiche. Aucune donnée interne.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const limit = await rateLimit(`bookquote:${await clientIp()}`, 60, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requête invalide" }, { status: 422 });
  const v = parsed.data;

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id, status, timezone, booking:booking_sites(enabled, show_price_estimate, vehicle_categories)")
    .eq("slug", slug.slice(0, 80))
    .maybeSingle();
  const site = org ? ((Array.isArray((org as any).booking) ? (org as any).booking[0] : (org as any).booking) as { enabled: boolean; show_price_estimate: boolean; vehicle_categories: string[] } | null) : null;
  if (!org || (org as any).status !== "active" || !site?.enabled) return NextResponse.json({ error: "Indisponible" }, { status: 404 });

  const route = await computeRoute(v.pickup, v.dropoff, { timeoutMs: 2500 });
  let priceCents: number | null = null;
  let fixedFare: string | null = null;
  if (site.show_price_estimate && site.vehicle_categories.includes(v.category)) {
    const { data: rule } = await admin
      .from("pricing_rules")
      .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
      .eq("organization_id", (org as any).id)
      .eq("vehicle_category", v.category)
      .eq("is_active", true)
      .maybeSingle();
    if (rule) {
      const fixed = matchFixedFare(rule as PricingRule, v.pickup.address, v.dropoff.address);
      fixedFare = fixed?.label ?? null;
      priceCents = fixed?.price_cents ?? estimatePrice(rule as PricingRule, route.distanceM, route.durationS, v.pickupAt ? new Date(v.pickupAt) : new Date(), (org as any).timezone ?? "Europe/Paris");
    }
  }
  return NextResponse.json(
    { distanceM: route.distanceM, durationS: route.durationS, polyline: route.polyline, approximate: route.approximate, priceCents, fixedFare },
    { headers: { "cache-control": "no-store" } },
  );
}
