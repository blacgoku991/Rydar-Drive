import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  trialing: "trialing", active: "active", past_due: "past_due", canceled: "canceled",
  incomplete: "incomplete", incomplete_expired: "canceled", unpaid: "unpaid", paused: "paused",
};

/** Webhook Stripe : abonnements, offres et factures (signature vérifiée). */
export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = serverEnv().stripeWebhookSecret;
  if (!stripe || !secret) return NextResponse.json({ error: "Stripe non configuré" }, { status: 503 });
  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, req.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return NextResponse.json({ error: "Signature invalide" }, { status: 400 });
  }
  const admin = createAdminClient();

  async function orgFromCustomer(customer: string | null | undefined, metadata?: Stripe.Metadata | null) {
    if (metadata?.organization_id) return metadata.organization_id;
    if (!customer) return null;
    const { data } = await admin.from("organizations").select("id").eq("stripe_customer_id", customer).maybeSingle();
    return (data as any)?.id ?? null;
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = await orgFromCustomer(sub.customer as string, sub.metadata);
      if (!orgId) break;
      const item = sub.items.data[0];
      const priceId = item?.price.id;
      const { data: plan } = await admin
        .from("plans")
        .select("id")
        .or(`stripe_price_monthly_id.eq.${priceId},stripe_price_yearly_id.eq.${priceId}`)
        .maybeSingle();
      const periodStart = (item as any)?.current_period_start ?? (sub as any).current_period_start;
      const periodEnd = (item as any)?.current_period_end ?? (sub as any).current_period_end;
      await admin.from("subscriptions").upsert(
        {
          organization_id: orgId,
          plan_id: (plan as any)?.id ?? null,
          status: STATUS[sub.status] ?? "incomplete",
          billing_interval: item?.price.recurring?.interval === "year" ? "year" : "month",
          stripe_subscription_id: sub.id,
          stripe_customer_id: sub.customer as string,
          current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
          current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          cancel_at_period_end: sub.cancel_at_period_end,
          canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        } as never,
        { onConflict: "stripe_subscription_id" },
      );
      if ((plan as any)?.id && event.type !== "customer.subscription.deleted" && ["active", "trialing"].includes(sub.status)) {
        await admin.from("organizations").update({ plan_id: (plan as any).id } as never).eq("id", orgId);
      }
      break;
    }
    case "invoice.finalized":
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const orgId = await orgFromCustomer(inv.customer as string, inv.metadata);
      if (!orgId) break;
      await admin.from("invoices").upsert(
        {
          organization_id: orgId,
          stripe_invoice_id: inv.id,
          number: inv.number,
          status: event.type === "invoice.payment_failed" ? "payment_failed" : inv.status,
          amount_due_cents: inv.amount_due,
          amount_paid_cents: inv.amount_paid,
          currency: inv.currency.toUpperCase(),
          hosted_invoice_url: inv.hosted_invoice_url,
          pdf_url: inv.invoice_pdf,
          period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
          period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
        } as never,
        { onConflict: "stripe_invoice_id" },
      );
      break;
    }
  }
  return NextResponse.json({ received: true });
}
