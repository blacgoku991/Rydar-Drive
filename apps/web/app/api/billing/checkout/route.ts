import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/org-context";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

const body = z.object({ planCode: z.string().regex(/^[a-z0-9_]+$/), interval: z.enum(["month", "year"]).default("month") });

/** Crée une session Stripe Checkout pour souscrire / changer d'offre. */
export async function POST(req: Request) {
  const ctx = await getOrgContext();
  if (!ctx || ctx.role !== "owner") return NextResponse.json({ error: "Réservé au propriétaire du compte." }, { status: 403 });
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: "Paiement en ligne non configuré : contactez l'équipe Rydar." }, { status: 503 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Offre invalide." }, { status: 422 });

  const admin = createAdminClient();
  const [{ data: plan }, { data: org }] = await Promise.all([
    admin.from("plans").select("id, code, stripe_price_monthly_id, stripe_price_yearly_id").eq("code", parsed.data.planCode).eq("is_active", true).maybeSingle(),
    admin.from("organizations").select("id, name, email, stripe_customer_id").eq("id", ctx.org.id).single(),
  ]);
  const priceId = parsed.data.interval === "year" ? (plan as any)?.stripe_price_yearly_id : (plan as any)?.stripe_price_monthly_id;
  if (!plan || !priceId) return NextResponse.json({ error: "Offre non disponible au paiement en ligne." }, { status: 422 });

  let customer = (org as any).stripe_customer_id as string | null;
  if (!customer) {
    const c = await stripe.customers.create({ name: (org as any).name, email: (org as any).email ?? ctx.profile.email, metadata: { organization_id: ctx.org.id } });
    customer = c.id;
    await admin.from("organizations").update({ stripe_customer_id: customer } as never).eq("id", ctx.org.id);
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    subscription_data: { metadata: { organization_id: ctx.org.id, plan_code: (plan as any).code } },
    metadata: { organization_id: ctx.org.id, plan_code: (plan as any).code },
    success_url: `${env.appUrl}/dashboard/settings?tab=billing&checkout=success`,
    cancel_url: `${env.appUrl}/dashboard/settings?tab=billing`,
  });
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "billing.checkout_started", metadata: { plan: (plan as any).code } });
  return NextResponse.json({ url: session.url });
}
