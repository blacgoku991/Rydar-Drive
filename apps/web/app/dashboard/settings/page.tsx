import type { OrgSettings } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { BillingPanel } from "@/components/settings/billing-panel";
import { DispatchSettingsForm, OrganizationForm, PricingEditor, TeamPanel } from "@/components/settings/settings-forms";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Réglages" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "dispatch", label: "Dispatch" },
  { key: "org", label: "Organisation" },
  { key: "pricing", label: "Tarifs" },
  { key: "team", label: "Équipe" },
  { key: "billing", label: "Abonnement" },
] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireOrg();
  const { tab: t } = await searchParams;
  const tab = TABS.some((x) => x.key === t) ? t! : "dispatch";
  const admin = isAdminRole(ctx.role);
  const orgId = ctx.org.id;

  let content: React.ReactNode = null;
  if (tab === "dispatch") {
    const { data } = await ctx.supabase.from("organization_settings").select("*").eq("organization_id", orgId).single();
    content = <DispatchSettingsForm settings={data as OrgSettings} readOnly={!admin} />;
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
      <PageHeader eyebrow="Organisation" title="Réglages" description="Moteur de dispatch, identité, tarifs, équipe et abonnement.">
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {TABS.map((x) => (
            <Link
              key={x.key}
              href={`/dashboard/settings?tab=${x.key}`}
              className={cn("border-b-2 px-3 pb-3 pt-1 text-[13px] font-medium", tab === x.key ? "border-brand text-fg" : "border-transparent text-fg-muted hover:text-fg")}
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
