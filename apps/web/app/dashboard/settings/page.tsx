import { bookingOperatorGaps, type OrgSettings, type VehicleCategory } from "@rydar/shared";
import { HandCoins, Landmark, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { feeTermsText } from "@/components/platform-fees/org-platform-format";
import { platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { BillingPanel, type BillingInvoice, type BillingPlan, type BillingSubscription, type BillingUsage } from "@/components/settings/billing-panel";
import { DispatchSettingsForm } from "@/components/settings/dispatch-settings-form";
import { OrganizationForm, type OrganizationRow } from "@/components/settings/organization-form";
import { PricingEditor } from "@/components/settings/pricing-editor";
import type { StoredRule } from "@/components/settings/pricing-rows";
import { PrivateBookingSettingsForm, type PrivateBookingSettingsRow } from "@/components/settings/private-booking-settings";
import { TeamPanel, type TeamMember } from "@/components/settings/team-panel";
import { CentraleSettingsForm, type CentraleSettingsRow } from "@/components/settlements/centrale-settings-form";
import { ReminderSettings } from "@/components/settlements/reminder-settings";
import { Callout } from "@/components/ui/callout";
import { FilterTabs } from "@/components/ui/filter-tabs";
import type { WhatsAppRow } from "@/components/whatsapp/whatsapp-card";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { serverEnv } from "@/lib/env";
import { isPrivateFleet } from "@/lib/private-fleet";
import { createAdminClient } from "@/lib/supabase/admin";
import { upperFirst } from "@/lib/wording";

export const metadata: Metadata = { title: "Réglages" };
export const dynamic = "force-dynamic";

const NB = " ";

/**
 * Onglets (docs/REFONTE-PANELS.md § 5.6, lot R10) : du plus simple au plus technique, « Organisation » ouvert par défaut
 * pour tous (adresse sans onglet ou onglet inconnu). « Commission & encaissement » : mode centrale ; « Abonnement » :
 * propriétaire et administrateurs (offres, factures et consommation leur sont réservées). Clés d'adresse inchangées.
 */
const TABS = [
  { key: "org", label: "Organisation" },
  { key: "pricing", label: "Tarifs" },
  { key: "dispatch", label: "Dispatch" },
  { key: "centrale", label: "Commission & encaissement" },
  { key: "team", label: "Équipe" },
  { key: "billing", label: "Abonnement" },
] as const;

/**
 * Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : « Coordonnées », « Tarifs », « Délais et rappels », « Abonnement » (clés
 * org, pricing, bookings, billing) ; Dispatch, Commission et encaissement, Équipe retirés (et leurs actions refusées) ;
 * onglet inconnu → « Coordonnées ».
 */
const PRIVATE_TABS = [
  { key: "org", label: "Coordonnées" },
  { key: "pricing", label: "Tarifs" },
  { key: "bookings", label: "Délais et rappels" },
  { key: "billing", label: "Abonnement" },
] as const;

const CENTRALE_COLUMNS =
  "driver_commission_percent, driver_commission_fixed_cents, settlement_grace_hours, settlement_credit_limit_cents, block_unpaid, new_driver_max_price_cents, trust_after_rides, settlement_methods, settlement_link, settlement_instructions, settlement_payee_name, settlement_iban, settlement_bic, reminder_channels";

/** « a, b et c » */
const joinFr = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} et ${parts.at(-1)}`);

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; checkout?: string }> }) {
  const ctx = await requireOrg();
  const { tab: t, checkout } = await searchParams;
  const centrale = ctx.org.dispatch_model === "centrale";
  const privateFleet = isPrivateFleet(ctx.org);
  const admin = isAdminRole(ctx.role);
  const tabs: readonly { key: string; label: string }[] = (privateFleet ? PRIVATE_TABS : TABS).filter(
    (x) => (x.key !== "centrale" || centrale) && (x.key !== "billing" || admin),
  );
  const tab = tabs.some((x) => x.key === t) ? t! : "org";
  const orgId = ctx.org.id;

  // Pastilles « À compléter » (administrateurs) : identité de l'entreprise incomplète (même règle que la mise en ligne
  // du mini-site), aucun tarif. Lectures seules, lancées en même temps que celles de l'onglet ; illisible : pas de pastille
  const todo = admin
    ? Promise.all([
        ctx.supabase.from("organizations").select("legal_name, siret, address, postal_code, city, vtc_registration").eq("id", orgId).maybeSingle(),
        ctx.supabase.from("pricing_rules").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("is_active", true),
      ]).then(([identity, pricing]) => ({
        org: !identity.error && !!identity.data && bookingOperatorGaps(identity.data as never).length > 0,
        pricing: !pricing.error && pricing.count === 0,
      }))
    : Promise.resolve({ org: false, pricing: false });

  let content: React.ReactNode = null;
  if (tab === "bookings") {
    // Flotte Privée seulement (onglet absent ailleurs) : délais de confirmation et de réponse, rappels, paiement
    const { data } = await ctx.supabase
      .from("organization_settings")
      .select("scheduled_dispatch_lead_minutes, offer_timeout_seconds, reminder_offsets_minutes, default_payment_method")
      .eq("organization_id", orgId)
      .single();
    content = <PrivateBookingSettingsForm settings={data as PrivateBookingSettingsRow} readOnly={!admin} />;
  } else if (tab === "dispatch") {
    const { data } = await ctx.supabase.from("organization_settings").select("*").eq("organization_id", orgId).single();
    content = (
      <DispatchSettingsForm
        settings={data as OrgSettings}
        readOnly={!admin}
        commissionNote={
          centrale ? (
            <Callout tone="neutral" role={null} icon={<HandCoins />} title="Commission chauffeur">
              Votre commission, le délai de règlement et le lien de paiement se règlent dans{" "}
              <Link href="/dashboard/settings?tab=centrale" prefetch={false} className="font-medium text-fg underline underline-offset-2 hover:text-brand">
                Commission &amp; encaissement
              </Link>
              .
            </Callout>
          ) : undefined
        }
      />
    );
  } else if (tab === "centrale") {
    const [{ data: settings }, { data: org }, { data: whatsapp }] = await Promise.all([
      ctx.supabase.from("organization_settings").select(CENTRALE_COLUMNS).eq("organization_id", orgId).single(),
      ctx.supabase.from("organizations").select("name, legal_name, currency, platform_fee_percent, platform_fee_fixed_cents").eq("id", orgId).single(),
      // RLS : owner / admin seulement (le jeton d'accès n'est jamais lisible)
      ctx.supabase
        .from("org_whatsapp")
        .select("phone_number_id, display_phone, verified_name, template, language, enabled, sent_count, last_sent_at, last_error, last_error_at")
        .eq("organization_id", orgId)
        .maybeSingle(),
    ]);
    const o = (org ?? {}) as { name?: string; legal_name?: string | null; currency?: string; platform_fee_percent?: number; platform_fee_fixed_cents?: number };
    const channels = (settings as { reminder_channels?: ("app" | "whatsapp")[] } | null)?.reminder_channels ?? ["app"];
    content = (
      <CentraleSettingsForm
        settings={settings as CentraleSettingsRow}
        platformFee={{ percent: Number(o.platform_fee_percent ?? 0), fixed_cents: Number(o.platform_fee_fixed_cents ?? 0) }}
        orgName={o.name ?? ctx.org.name}
        legalName={o.legal_name ?? null}
        currency={o.currency ?? "EUR"}
        readOnly={!admin}
        reminders={admin ? <ReminderSettings channels={channels} whatsapp={(whatsapp ?? null) as WhatsAppRow | null} readOnly={!admin} /> : null}
      />
    );
  } else if (tab === "pricing") {
    const [{ data }, vehicle] = await Promise.all([
      ctx.supabase.from("pricing_rules").select("*").eq("organization_id", orgId).eq("is_active", true),
      // Flotte Privée : catégorie du véhicule du chauffeur, mise en tête de la grille
      privateFleet && ctx.driverId
        ? ctx.supabase.from("drivers").select("vehicle:vehicles(category)").eq("id", ctx.driverId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const v = (vehicle.data as { vehicle?: { category?: string } | { category?: string }[] | null } | null)?.vehicle;
    const category = ((Array.isArray(v) ? v[0] : v)?.category ?? null) as VehicleCategory | null;
    content = (
      <PricingEditor
        rules={(data ?? []) as StoredRule[]}
        readOnly={!admin}
        privateFleet={privateFleet}
        vehicleCategory={category}
        timezone={ctx.org.timezone}
      />
    );
  } else if (tab === "team") {
    const { data } = await ctx.supabase
      .from("organization_users")
      .select("id, user_id, role, status, created_at, user:users!organization_users_user_id_fkey(full_name, email)")
      .eq("organization_id", orgId)
      .order("created_at");
    const members = (data ?? []).map((m: any) => ({ ...m, user: Array.isArray(m.user) ? m.user[0] : m.user }));
    // Invitation en attente : profil non lisible (RLS users_select) ; seule l'adresse saisie par la centrale est affichée
    const invited = members.filter((m) => m.status === "invited" && !m.user).map((m) => m.user_id as string);
    if (invited.length) {
      const { data: emails } = await createAdminClient().from("users").select("id, email").in("id", invited);
      const byId = new Map(((emails ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email]));
      for (const m of members) if (m.status === "invited" && !m.user) m.user = { full_name: null, email: byId.get(m.user_id) ?? "" };
    }
    content = <TeamPanel members={members as TeamMember[]} isOwner={ctx.role === "owner"} canInvite={admin} />;
  } else if (tab === "billing") {
    const [{ data: plans }, { data: usage }, { data: subscription }, { data: invoices }, sitesOn, fees] = await Promise.all([
      // Flotte Privée : seulement l'offre attribuée par l'équipe Rydar, même non publique (illisible par la RLS des
      // offres : lue en service role, la seule de l'organisation) ; jamais les offres publiques (Checkout verrouillé)
      privateFleet
        ? ctx.org.plan_id
          ? createAdminClient().from("plans").select("*").eq("id", ctx.org.plan_id).eq("is_active", true)
          : Promise.resolve({ data: [] })
        : ctx.supabase.from("plans").select("*").eq("is_active", true).eq("is_public", true).order("sort_order"),
      ctx.supabase.rpc("org_usage", { p_org: orgId }),
      ctx.supabase.from("subscriptions").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ctx.supabase.from("invoices").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(12),
      // Interrupteur plateforme des mini-sites : coupé = mini-site signalé indisponible quelle que soit l'offre
      bookingSitesEnabled(),
      // Flotte : frais Rydar par course en plus de l'abonnement (owner / admin : renvoi vers « Frais Rydar »)
      !centrale && admin
        ? ctx.supabase.from("organizations").select("platform_fee_percent, platform_fee_fixed_cents, currency").eq("id", orgId).single()
        : Promise.resolve(null),
    ]);
    const fee = (fees?.data ?? null) as { platform_fee_percent: number; platform_fee_fixed_cents: number; currency: string } | null;
    const perRide = !!fee && (Number(fee.platform_fee_percent) > 0 || Number(fee.platform_fee_fixed_cents) > 0);
    content = (
      <div className="space-y-6">
        {perRide && fee && (
          <Callout tone="neutral" role={null} icon={<Landmark />} title="Frais Rydar par course">
            En plus de l&apos;abonnement{NB}:{" "}
            {feeTermsText({ fee_percent: Number(fee.platform_fee_percent), fee_fixed_cents: Number(fee.platform_fee_fixed_cents), currency: fee.currency || "EUR" })}.
            Solde, échéance et paiements dans{" "}
            <Link href={platformFeesPaths("fleet").page} prefetch={false} className="font-medium text-fg underline underline-offset-2 hover:text-brand">
              Frais Rydar
            </Link>
            .
          </Callout>
        )}
        <BillingPanel
          plans={(plans ?? []) as BillingPlan[]}
          currentPlanId={ctx.org.plan_id}
          usage={(usage ?? null) as BillingUsage}
          subscription={(subscription ?? null) as BillingSubscription | null}
          invoices={(invoices ?? []) as BillingInvoice[]}
          isOwner={ctx.role === "owner"}
          bookingSitesEnabled={sitesOn}
          privateFleet={privateFleet}
          onlinePayment={!!serverEnv().stripeSecretKey}
          checkoutSuccess={checkout === "success"}
          timezone={ctx.org.timezone}
        />
      </div>
    );
  } else {
    const { data } = await ctx.supabase.from("organizations").select("name, legal_name, siret, email, phone, address, city, postal_code, vtc_registration").eq("id", orgId).single();
    content = <OrganizationForm org={data as OrganizationRow} readOnly={!admin} privateFleet={privateFleet} />;
  }

  const needs = await todo;
  const pill = (
    <span className="rounded-full bg-amber/[0.12] px-1.5 text-[12px] font-medium leading-5 text-amber">À compléter</span>
  );
  const parts = privateFleet
    ? ["vos coordonnées", "vos tarifs", "vos délais de réponse"]
    : ["votre entreprise", "vos tarifs", "la recherche des chauffeurs", ...(centrale ? ["votre commission"] : []), "votre équipe"];
  if (admin) parts.push("votre abonnement");

  return (
    <>
      <PageHeader title="Réglages" description={`${upperFirst(joinFr(parts))}.`}>
        <FilterTabs
          label="Rubriques des réglages"
          variant="rubriques"
          wrap
          items={tabs.map((x) => ({
            href: `/dashboard/settings?tab=${x.key}`,
            active: tab === x.key,
            label: (x.key === "org" && needs.org) || (x.key === "pricing" && needs.pricing) ? (
              <>
                {x.label}
                {pill}
              </>
            ) : (
              x.label
            ),
          }))}
        />
      </PageHeader>
      <PageBody>
        {!admin && (
          <Callout tone="neutral" role={null} icon={<Lock />} className="mb-5">
            Lecture seule{NB}: seuls le propriétaire et les administrateurs peuvent modifier ces réglages.
          </Callout>
        )}
        {content}
      </PageBody>
    </>
  );
}
