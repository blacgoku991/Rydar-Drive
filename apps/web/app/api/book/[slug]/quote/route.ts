import { estimatePrice, matchFixedFare, vehicleCategorySchema, type PricingRule } from "@rydar/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { coordinateProblem, orgAnchor } from "@/lib/geo/anchor";
import { computeRoute } from "@/lib/geo/routing";
import { rateLimitAll } from "@/lib/rate-limit";
import { clientIp, ipBucket } from "@/lib/request";
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
  // Une réservation réelle = 5 à 20 devis ; chaque devis peut coûter un itinéraire facturé
  const ip = ipBucket(await clientIp());
  const limit = await rateLimitAll([
    { key: `bookquote:${ip}`, limit: 30, windowSec: 60 },
    { key: `bookquote:day:${ip}`, limit: 600, windowSec: 86_400 },
  ]);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });
  // Mini-sites coupés par la plateforme (super admin) : aucun devis
  if (!(await bookingSitesEnabled())) return NextResponse.json({ error: "Indisponible" }, { status: 404 });
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

  // Zone desservie : mêmes règles que l'API v1 (départ près de l'activité de la centrale, trajet ≤ 1 500 km)
  const anchor = await orgAnchor((org as any).id).catch(() => null);
  if (coordinateProblem(v.pickup, anchor) || coordinateProblem(v.dropoff, v.pickup, 1_500_000)) {
    return NextResponse.json({ error: "Trajet hors de la zone desservie" }, { status: 422 });
  }

  // Budget des fournisseurs payants : part du visiteur (IP /64), du mini-site et de l'ensemble des anonymes
  const route = await computeRoute(v.pickup, v.dropoff, { timeoutMs: 2500, consumer: { kind: "visitor", ip, org: (org as any).id } });
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
