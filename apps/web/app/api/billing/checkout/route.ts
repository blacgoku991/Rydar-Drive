import { ORG_LEGAL_VERSION } from "@rydar/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/org-context";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

const body = z.object({ planCode: z.string().regex(/^[a-z0-9_]+$/), interval: z.enum(["month", "year"]).default("month") });

/**
 * Crée une session Stripe Checkout pour souscrire / changer d'offre. Prix des offres HORS TAXES (CGV art. 4 : « la TVA au
 * taux en vigueur s'y ajoute ») : TVA calculée et ajoutée par Stripe Tax (automatic_tax), adresse de facturation et
 * numéro de TVA intracommunautaire demandés (mentions de la facture, autoliquidation). Stripe Tax pas activé sur le
 * compte : aucun abonnement sans TVA, message clair (docs/DEPLOYMENT.md § 4).
 */
export async function POST(req: Request) {
  const ctx = await getOrgContext();
  if (!ctx || ctx.role !== "owner") return NextResponse.json({ error: "Réservé au propriétaire du compte." }, { status: 403 });
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: "Paiement en ligne non configuré : contactez l'équipe Rydar." }, { status: 503 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Offre invalide." }, { status: 422 });

  const admin = createAdminClient();
  const [{ data: plan }, { data: org }, { data: live, error: liveError }, { data: terms, error: termsError }] = await Promise.all([
    admin.from("plans").select("id, code, is_public, stripe_price_monthly_id, stripe_price_yearly_id").eq("code", parsed.data.planCode).eq("is_active", true).maybeSingle(),
    admin.from("organizations").select("id, name, email, stripe_customer_id, plan_id").eq("id", ctx.org.id).single(),
    // Abonnement Stripe encore vivant : Checkout en créerait un SECOND (double facturation)
    admin.from("subscriptions").select("id").eq("organization_id", ctx.org.id).not("stripe_subscription_id", "is", null)
      .in("status", ["active", "trialing", "past_due", "unpaid", "paused"]).limit(1),
    // CGV et accord de traitement EN VIGUEUR acceptés au nom de l'organisation avant tout paiement (C. civ. 1119 : des
    // conditions générales non acceptées ne sont pas opposables) ; « dpa » suffit, les deux sont enregistrés ensemble
    admin.from("legal_acceptances").select("version").eq("organization_id", ctx.org.id).eq("document", "dpa")
      .eq("version", ORG_LEGAL_VERSION).limit(1),
  ]);
  if (liveError || termsError) return NextResponse.json({ error: "Abonnement indisponible pour le moment : réessayez." }, { status: 503 });
  if (live?.length) return NextResponse.json({ error: "Vous avez déjà un abonnement : changez d'offre avec le bouton « Gérer »." }, { status: 409 });
  if (!terms?.length) {
    return NextResponse.json(
      {
        error:
          "Acceptez d'abord, au nom de votre organisation, les conditions générales de vente et l'accord de traitement des données (bandeau en haut du tableau de bord).",
      },
      { status: 409 },
    );
  }
  const priceId = parsed.data.interval === "year" ? (plan as any)?.stripe_price_yearly_id : (plan as any)?.stripe_price_monthly_id;
  // Offre non publique (négociée) : seulement celle que le super admin a attribuée à cette centrale
  const allowed = plan && ((plan as any).is_public || (plan as any).id === (org as any)?.plan_id);
  if (!allowed || !priceId) return NextResponse.json({ error: "Offre non disponible au paiement en ligne." }, { status: 422 });

  let customer = (org as any).stripe_customer_id as string | null;
  if (!customer) {
    const c = await stripe.customers.create({ name: (org as any).name, email: (org as any).email ?? ctx.profile.email, metadata: { organization_id: ctx.org.id } });
    customer = c.id;
    await admin.from("organizations").update({ stripe_customer_id: customer } as never).eq("id", ctx.org.id);
  }
  let session: { url: string | null };
  try {
    session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      // TVA ajoutée au prix hors taxes (prix Stripe « TVA non comprise »), selon l'adresse de facturation ; numéro de TVA
      // du client collecté ; client existant : adresse et nom repris de Checkout
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      // previous_plan_id : offre rendue à la centrale si l'abonnement se termine (webhook Stripe, jamais « sans offre »)
      subscription_data: {
        metadata: { organization_id: ctx.org.id, plan_code: (plan as any).code, ...((org as any).plan_id ? { previous_plan_id: (org as any).plan_id } : {}) },
      },
      metadata: { organization_id: ctx.org.id, plan_code: (plan as any).code },
      success_url: `${env.appUrl}/dashboard/settings?tab=billing&checkout=success`,
      cancel_url: `${env.appUrl}/dashboard/settings?tab=billing`,
    });
  } catch (error) {
    // Stripe Tax non activé (adresse d'origine, immatriculation), prix sans comportement fiscal… : jamais d'abonnement
    // sans TVA. Message générique côté client ; détail (sans secret) dans le journal du serveur.
    const e = error as { type?: string; code?: string; message?: string };
    const tax = /tax/i.test(`${e.code ?? ""} ${e.message ?? ""}`);
    console.error("[stripe] Checkout impossible", e.type ?? "", e.code ?? "", tax ? "(TVA)" : "");
    return NextResponse.json(
      { error: tax ? "Calcul de la TVA indisponible pour le paiement en ligne : contactez l'équipe Rydar." : "Paiement en ligne indisponible pour le moment : réessayez." },
      { status: 503 },
    );
  }
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "billing.checkout_started", metadata: { plan: (plan as any).code } });
  return NextResponse.json({ url: session.url });
}
