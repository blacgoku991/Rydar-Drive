import { vehicleCategorySchema } from "@rydar/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { quoteRide } from "@/lib/geo/quote";
import { getOrgContext } from "@/lib/org-context";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const schema = z.object({
  pickup: point,
  dropoff: point.nullish(),
  category: vehicleCategorySchema.default("standard"),
  passengers: z.number().int().min(1).max(20).default(1),
  pickupAt: z.iso.datetime({ offset: true }).optional(),
  pickupAddress: z.string().max(300).optional(),
  dropoffAddress: z.string().max(300).optional(),
});

/** Devis temps réel du formulaire « Nouvelle course » : itinéraire, prix, chauffeurs proches. */
export async function POST(request: Request) {
  const ctx = await getOrgContext();
  if (!ctx) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  const limit = await rateLimit(`quote:${ctx.user.id}`, 120, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 422 });
  const v = parsed.data;
  const quote = await quoteRide(ctx.supabase, ctx.org.id, {
    pickup: v.pickup,
    dropoff: v.dropoff ?? null,
    category: v.category,
    passengers: v.passengers,
    pickupAt: v.pickupAt ? new Date(v.pickupAt) : undefined,
    timezone: ctx.org.timezone ?? "Europe/Paris",
    pickupAddress: v.pickupAddress,
    dropoffAddress: v.dropoffAddress,
  });
  return NextResponse.json(quote, { headers: { "cache-control": "no-store" } });
}
