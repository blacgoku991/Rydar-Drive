import type { OrgSettings } from "@rydar/shared";
import { HandCoins } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { BillingPanel } from "@/components/settings/billing-panel";
import { DispatchSettingsForm, OrganizationForm, PricingEditor, TeamPanel } from "@/components/settings/settings-forms";
import { CentraleSettingsForm, type CentraleSettingsRow } from "@/components/settlements/centrale-settings-form";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Réglages" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "dispatch", label: "Dispatch" },
  // Mode centrale uniquement
  { key: "centrale", label: "Commission & encaissement" },
  { key: "org", label: "Organisation" },
  { key: "pricing", label: "Tarifs" },
  { key: "team", label: "Équipe" },
  { key: "billing", label: "Abonnement" },
] as const;

const CENTRALE_COLUMNS =
  "driver_commission_percent, driver_commission_fixed_cents, settlement_grace_hours, settlement_credit_limit_cents, block_unpaid, new_driver_max_price_cents, trust_after_rides, settlement_methods, settlement_link, settlement_instructions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireOrg();
  const { tab: t } = await searchParams;
  const centrale = ctx.org.dispatch_model === "centrale";
  const tabs = TABS.filter((x) => x.key !== "centrale" || centrale);
  const tab = tabs.some((x) => x.key === t) ? t! : "dispatch";
  const admin = isAdminRole(ctx.role);
  const orgId = ctx.org.id;

  let content: React.ReactNode = null;
  if (tab === "dispatch") {
    const { data } = await ctx.supabase.from("organization_settings").select("*").eq("organization_id", orgId).single();
    content = (
      <DispatchSettingsForm
        settings={data as OrgSettings}
        readOnly={!admin}
        commissionNote={
          centrale ? (
            <Link
              href="/dashboard/settings?tab=centrale"
              className="surface flex items-center gap-3 rounded-xl px-5 py-4 transition-colors hover:border-line-strong hover:bg-ink-700"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-muted">
                <HandCoins className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold tracking-tight">Commission chauffeur</span>
                <span className="block text-[12.5px] text-fg-muted">Mode centrale : commission, délai de règlement et lien de paiement se règlent dans « Commission & encaissement ».</span>
              </span>
              <span className="shrink-0 text-[13px] text-brand">Ouvrir →</span>
            </Link>
          ) : undefined
        }
      />
    );
  } else if (tab === "centrale") {
    const [{ data: settings }, { data: org }] = await Promise.all([
      ctx.supabase.from("organization_settings").select(CENTRALE_COLUMNS).eq("organization_id", orgId).single(),
      ctx.supabase.from("organizations").select("name, currency, platform_fee_percent, platform_fee_fixed_cents").eq("id", orgId).single(),
    ]);
    const o = (org ?? {}) as { name?: string; currency?: string; platform_fee_percent?: number; platform_fee_fixed_cents?: number };
    content = (
      <CentraleSettingsForm
        settings={settings as CentraleSettingsRow}
        platformFee={{ percent: Number(o.platform_fee_percent ?? 0), fixed_cents: Number(o.platform_fee_fixed_cents ?? 0) }}
        orgName={o.name ?? ctx.org.name}
        currency={o.currency ?? "EUR"}
        readOnly={!admin}
      />
    );
  } else if (tab === "org") {
    const { data } = await ctx.supabase.from("organizations").select("name, legal_name, siret, email, phone, address, city, postal_code").eq("id", orgId).single();
    content = <OrganizationForm org={data} readOnly={!admin} />;
  } else if (tab === "pricing") {
    const { data } = await ctx.supabase.from("pricing_rules").select("*").eq("organization_id", orgId).eq("is_active", true);
    content = <PricingEditor rules={data ?? []} readOnly={!admin} />;
  } else if (tab === "team") {
    const { data } = await ctx.supabase
      .from("organization_users")
      .select("id, role, status, created_at, user:users!organization_users_user_id_fkey(full_name, email)")
      .eq("organization_id", orgId)
      .order("created_at");
    content = <TeamPanel members={(data ?? []).map((m: any) => ({ ...m, user: Array.isArray(m.user) ? m.user[0] : m.user }))} isOwner={ctx.role === "owner"} canInvite={admin} />;
  } else {
    const [{ data: plans }, { data: usage }, { data: subscription }, { data: invoices }] = await Promise.all([
      ctx.supabase.from("plans").select("*").eq("is_active", true).eq("is_public", true).order("sort_order"),
      ctx.supabase.rpc("org_usage", { p_org: orgId }),
      ctx.supabase.from("subscriptions").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ctx.supabase.from("invoices").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(12),
    ]);
    content = <BillingPanel plans={plans ?? []} currentPlanId={ctx.org.plan_id} usage={usage} subscription={subscription} invoices={invoices ?? []} isOwner={ctx.role === "owner"} />;
  }

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Réglages"
        description={centrale ? "Moteur de dispatch, commission et encaissement, identité, tarifs, équipe et abonnement." : "Moteur de dispatch, identité, tarifs, équipe et abonnement."}
      >
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {tabs.map((x) => (
            <Link
              key={x.key}
              href={`/dashboard/settings?tab=${x.key}`}
              className={cn("shrink-0 whitespace-nowrap border-b-2 px-3 pb-3 pt-1 text-[13px] font-medium", tab === x.key ? "border-brand text-fg" : "border-transparent text-fg-muted hover:text-fg")}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </PageHeader>
      <PageBody>
        {!admin && <p className="mb-4 rounded-lg border border-line bg-white/[0.02] px-4 py-2.5 text-[12.5px] text-fg-muted">Lecture seule : seuls les administrateurs peuvent modifier ces réglages.</p>}
        {content}
      </PageBody>
    </>
  );
}
