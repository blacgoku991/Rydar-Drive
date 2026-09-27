import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { audit } from "@/lib/audit";
import { serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  trialing: "trialing", active: "active", past_due: "past_due", canceled: "canceled",
  incomplete: "incomplete", incomplete_expired: "canceled", unpaid: "unpaid", paused: "paused",
};

/** Statuts Stripe où l'abonnement ne donne plus droit à son offre (résilié, impayé, suspendu) ; past_due = délai de grâce. */
const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

/** Un événement Stripe fait quelques Ko : au-delà, refus AVANT de lire le corps en entier (signature non encore vérifiée). */
const MAX_BODY_BYTES = 512 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corps brut (octets signés par Stripe), lu en flux avec un compteur ; null s'il dépasse max octets (même en chunked). */
async function readBody(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Erreur Supabase = échec du webhook (500) : Stripe renverra l'événement, rien n'est perdu. */
function must<T extends { error: { message: string } | null }>(res: T, what: string): T {
  if (res.error) throw new Error(`${what} : ${res.error.message}`);
  return res;
}

/** Objet Stripe relu à jour (l'ordre de livraison des événements n'est pas garanti) ; null s'il n'existe plus. */
async function fresh<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "resource_missing") return null;
    throw error;
  }
}

const customerId = (c: string | { id: string } | null | undefined) => (typeof c === "string" ? c : c?.id ?? null);

/** Webhook Stripe : abonnements, offres et factures (signature vérifiée). */
export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = serverEnv().stripeWebhookSecret;
  if (!stripe || !secret) return NextResponse.json({ error: "Stripe non configuré" }, { status: 503 });
  const payload = await readBody(req, MAX_BODY_BYTES);
  if (!payload) return NextResponse.json({ error: "Corps trop volumineux" }, { status: 413 });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, req.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return NextResponse.json({ error: "Signature invalide" }, { status: 400 });
  }
  try {
    await handleEvent(stripe, event);
  } catch (error) {
    console.error("[stripe] événement non traité", event.type, event.id, error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Traitement impossible, nouvel essai attendu" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}

async function handleEvent(stripe: Stripe, event: Stripe.Event) {
  const admin = createAdminClient();

  async function orgFromCustomer(customer: string | null, metadata?: Stripe.Metadata | null): Promise<string | null> {
    if (metadata?.organization_id) return metadata.organization_id;
    if (!customer) return null;
    const { data } = must(await admin.from("organizations").select("id").eq("stripe_customer_id", customer).maybeSingle(), "centrale");
    return (data as any)?.id ?? null;
  }

  /**
   * Abonnement terminé (résilié, impayé, suspendu) : la centrale perd l'offre payée. Repli = l'offre qu'elle avait avant
   * le paiement (previous_plan_id, posé par /api/billing/checkout), jamais « sans offre » (= aucune limite) ; à défaut,
   * l'offre est conservée et le super admin est alerté (journal d'audit, filtre « Sécurité »).
   */
  async function endPlan(orgId: string, planId: string, sub: Stripe.Subscription) {
    const { data: org } = must(await admin.from("organizations").select("plan_id").eq("id", orgId).maybeSingle(), "centrale");
    // Offre déjà changée (super admin, autre abonnement, événement déjà traité) : rien à faire
    if ((org as any)?.plan_id !== planId) return;
    const previous = sub.metadata?.previous_plan_id;
    let fallback: string | null = null;
    if (previous && UUID_RE.test(previous) && previous !== planId) {
      const { data } = must(await admin.from("plans").select("id").eq("id", previous).eq("is_active", true).maybeSingle(), "offre de repli");
      fallback = (data as any)?.id ?? null;
    }
    const metadata = { subscription: sub.id, status: sub.status, plan: planId, fallback };
    if (fallback) {
      must(await admin.from("organizations").update({ plan_id: fallback } as never).eq("id", orgId).eq("plan_id", planId), "rétrogradation");
      await audit({ organizationId: orgId, actorType: "system", action: "billing.plan_downgraded", entityType: "organizations", entityId: orgId, severity: "warning", metadata });
    } else {
      await audit({ organizationId: orgId, actorType: "system", action: "billing.subscription_ended", entityType: "organizations", entityId: orgId, severity: "critical", metadata });
    }
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = await fresh(() => stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id));
      if (!sub) break;
      const customer = customerId(sub.customer);
      const orgId = await orgFromCustomer(customer, sub.metadata);
      if (!orgId) break;
      const item = sub.items.data[0];
      const priceId = item?.price.id;
      const { data: plan } = priceId
        ? must(
            await admin
              .from("plans")
              .select("id")
              .or(`stripe_price_monthly_id.eq.${priceId},stripe_price_yearly_id.eq.${priceId}`)
              .limit(1)
              .maybeSingle(),
            "offre",
          )
        : { data: null };
      const planId: string | null = (plan as any)?.id ?? null;
      const periodStart = (item as any)?.current_period_start ?? (sub as any).current_period_start;
      const periodEnd = (item as any)?.current_period_end ?? (sub as any).current_period_end;
      must(
        await admin.from("subscriptions").upsert(
          {
            organization_id: orgId,
            plan_id: planId,
            status: STATUS[sub.status] ?? "incomplete",
            billing_interval: item?.price.recurring?.interval === "year" ? "year" : "month",
            stripe_subscription_id: sub.id,
            stripe_customer_id: customer,
            current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
            current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            cancel_at_period_end: sub.cancel_at_period_end,
            canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
            trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          } as never,
          { onConflict: "stripe_subscription_id" },
        ),
        "abonnement",
      );
      if (planId && ["active", "trialing"].includes(sub.status)) {
        must(await admin.from("organizations").update({ plan_id: planId } as never).eq("id", orgId), "offre de la centrale");
      } else if (planId && ENDED_STATUSES.has(sub.status)) {
        await endPlan(orgId, planId, sub);
      }
      break;
    }
    case "invoice.finalized":
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoiceId = (event.data.object as Stripe.Invoice).id;
      const inv = invoiceId ? await fresh(() => stripe.invoices.retrieve(invoiceId)) : null;
      if (!inv) break;
      const orgId = await orgFromCustomer(customerId(inv.customer), inv.metadata);
      if (!orgId) break;
      // Relue à jour : un « échec » ou une « finalisation » livrés après le paiement ne font pas régresser la facture
      const status = event.type === "invoice.payment_failed" && inv.status === "open" ? "payment_failed" : (inv.status ?? "draft");
      must(
        await admin.from("invoices").upsert(
          {
            organization_id: orgId,
            stripe_invoice_id: inv.id,
            number: inv.number,
            status,
            amount_due_cents: inv.amount_due,
            amount_paid_cents: inv.amount_paid,
            currency: inv.currency.toUpperCase(),
            hosted_invoice_url: inv.hosted_invoice_url,
            pdf_url: inv.invoice_pdf,
            period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
            period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
          } as never,
          { onConflict: "stripe_invoice_id" },
        ),
        "facture",
      );
      break;
    }
  }
}
