import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/org-context";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST() {
  const ctx = await getOrgContext();
  if (!ctx || ctx.role !== "owner") return NextResponse.json({ error: "Réservé au propriétaire du compte." }, { status: 403 });
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: "Paiement en ligne non configuré." }, { status: 503 });
  const { data: org } = await createAdminClient().from("organizations").select("stripe_customer_id").eq("id", ctx.org.id).single();
  const customer = (org as any)?.stripe_customer_id;
  if (!customer) return NextResponse.json({ error: "Aucun abonnement Stripe." }, { status: 404 });
  const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${env.appUrl}/dashboard/settings?tab=billing` });
  return NextResponse.json({ url: session.url });
}
