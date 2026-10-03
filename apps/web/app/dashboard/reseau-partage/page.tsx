import {
  NETWORK_TERMS_VERSION,
  type DispatchModel, type NetworkDriverExclusion, type NetworkMembership, type NetworkPartnerNames, type OrgNetworkActivity,
  type OrgNetworkDriver, type OrgNetworkGiven, type OrgNetworkReceived, type OrgNetworkSummary, type SettlementMethod,
} from "@rydar/shared";
import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { GivenView } from "@/components/network-share/given-view";
import {
  NETWORK_LIST_MAX, NETWORK_SHARE_TABS, networkShareHref, parseNetworkShareParams, recentMonths, type NetworkShareSearchParams,
} from "@/components/network-share/paths";
import { ReadinessPanel } from "@/components/network-share/readiness-panel";
import { orgReadinessView } from "@/components/network-share/readiness";
import { showReceivedTab } from "@/components/network-share/received";
import { ReceivedView } from "@/components/network-share/received-view";
import { SettingsView, type NetworkPaymentRow } from "@/components/network-share/settings-view";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { sharedNetworkEnabled } from "@/lib/shared-network";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Réseau partagé" };
export const dynamic = "force-dynamic";

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * « Réseau partagé » (flottes et centrales, spec §12.1) : trois sous-onglets — Courses confiées (A), Courses reçues (B),
 * Réglages. Absent (404) tant que l'interrupteur plateforme est coupé. Tout membre lit (dispatcher : lecture seule +
 * « Relancer ») ; contrat d'URL : components/network-share/paths.ts.
 */
export default async function NetworkSharePage({ searchParams }: { searchParams: Promise<NetworkShareSearchParams> }) {
  const ctx = await requireOrg();
  if (!(await sharedNetworkEnabled())) notFound();
  const params = parseNetworkShareParams(await searchParams);
  const orgId = ctx.org.id;
  const canManage = isAdminRole(ctx.role);
  const tz = ctx.org.timezone || "Europe/Paris";
  const model: DispatchModel = ctx.org.dispatch_model === "centrale" ? "centrale" : "fleet";
  const db = ctx.supabase;
  const serverNow = Date.now();

  const [summaryRes, membershipRes, partnersRes, exclusionsRes] = await Promise.all([
    db.rpc("org_network_summary", { p_org: orgId }),
    db.from("network_memberships").select("*").eq("organization_id", orgId).maybeSingle(),
    db.rpc("network_partner_names", { p_org: orgId }),
    db.from("network_exclusions").select("excluded_org_id").eq("organization_id", orgId),
  ]);
  const summary = (summaryRes.error ? null : summaryRes.data) as OrgNetworkSummary | null;
  const membership = (membershipRes.data ?? null) as NetworkMembership | null;
  const partners = Object.entries((partnersRes.error ? {} : (partnersRes.data ?? {})) as NetworkPartnerNames)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const excludedPartners = ((exclusionsRes.data ?? []) as { excluded_org_id: string }[]).map((r) => r.excluded_org_id);
  const readiness = summary?.readiness ?? null;
  const currency = summary?.currency || "EUR";

  // « Courses reçues » : masqué si la réception est coupée et sans historique
  const shareIn = !!membership?.share_in;
  let totalReceived: number | null = summary?.received.total_rides ?? null;
  if (totalReceived == null && !shareIn && !summary?.received.in_progress && !summary?.received.month_rides) {
    const probe = await db.rpc("org_network_received", { p_org: orgId, p_filter: "all", p_partner: null, p_month: null, p_limit: 1, p_before: null });
    totalReceived = ((probe.error ? null : probe.data) as OrgNetworkReceived | null)?.items.length ?? 0;
  }
  const receivedVisible = showReceivedTab({
    shareIn,
    inProgress: summary?.received.in_progress ?? 0,
    monthRides: summary?.received.month_rides ?? 0,
    totalRides: totalReceived,
  });
  const tabs = NETWORK_SHARE_TABS.filter((t) => t.key !== "recues" || receivedVisible);
  const tab = tabs.some((t) => t.key === params.tab) ? params.tab : "confiees";
  const months = recentMonths(new Date(serverNow), tz, 12);

  let content: React.ReactNode;
  if (tab === "confiees") {
    const res = await db.rpc("org_network_given", {
      p_org: orgId, p_filter: params.given, p_partner: params.partner, p_month: params.month, p_limit: params.limit, p_before: null,
    });
    const data = (res.error ? null : res.data) as OrgNetworkGiven | null;
    const items = data?.items ?? [];
    content = (
      <GivenView
        summary={summary?.given ?? null}
        currency={currency}
        items={items}
        filter={params.given}
        partner={params.partner}
        month={params.month}
        limit={params.limit}
        hasMore={items.length >= params.limit && params.limit < NETWORK_LIST_MAX && data?.next_before !== null}
        partners={partners}
        excludedPartners={excludedPartners}
        months={months}
        canManage={canManage}
        orgName={ctx.org.name}
        timeZone={tz}
        serverNow={serverNow}
        failed={!!res.error}
      />
    );
  } else if (tab === "recues") {
    const [res, activity] = await Promise.all([
      db.rpc("org_network_received", {
        p_org: orgId, p_filter: params.received, p_partner: params.partner, p_month: params.month, p_limit: params.limit, p_before: null,
      }),
      db.rpc("org_network_activity", { p_org: orgId }),
    ]);
    const data = (res.error ? null : res.data) as OrgNetworkReceived | null;
    const items = data?.items ?? [];
    content = (
      <ReceivedView
        received={summary?.received ?? null}
        activity={(activity.error ? null : activity.data) as OrgNetworkActivity | null}
        items={items}
        filter={params.received}
        partner={params.partner}
        month={params.month}
        limit={params.limit}
        hasMore={items.length >= params.limit && params.limit < NETWORK_LIST_MAX && data?.next_before !== null}
        partners={partners}
        months={months}
        shareIn={shareIn}
        timeZone={tz}
        serverNow={serverNow}
        failed={!!res.error}
      />
    );
  } else {
    const [orgRes, settingsRes, driversRes, driverExclusionsRes, acceptorRes] = await Promise.all([
      db.from("organizations").select("name, legal_name, currency, platform_fee_percent, platform_fee_fixed_cents").eq("id", orgId).maybeSingle(),
      db
        .from("organization_settings")
        .select(
          "driver_commission_percent, driver_commission_fixed_cents, settlement_grace_hours, settlement_methods, settlement_link, settlement_instructions, settlement_payee_name, settlement_iban, settlement_bic, dispatch_radii_m, offer_timeout_seconds",
        )
        .eq("organization_id", orgId)
        .maybeSingle(),
      canManage ? db.rpc("org_network_drivers", { p_org: orgId }) : Promise.resolve(null),
      canManage ? db.rpc("org_network_driver_exclusions", { p_org: orgId }) : Promise.resolve(null),
      membership?.terms_accepted_by
        ? db
            .from("organization_users")
            .select("user:users!organization_users_user_id_fkey(full_name, email)")
            .eq("organization_id", orgId)
            .eq("user_id", membership.terms_accepted_by)
            .maybeSingle()
        : Promise.resolve(null),
    ]);
    const org = (orgRes.data ?? {}) as { name?: string; legal_name?: string | null; currency?: string; platform_fee_percent?: number; platform_fee_fixed_cents?: number };
    const s = (settingsRes.data ?? null) as
      | (NetworkPaymentRow & {
          driver_commission_percent: number | null;
          driver_commission_fixed_cents: number | null;
          settlement_grace_hours: number | null;
          dispatch_radii_m: number[] | null;
          offer_timeout_seconds: number | null;
        })
      | null;
    const acceptor = one((acceptorRes?.data as { user: { full_name: string | null; email: string } | { full_name: string | null; email: string }[] | null } | null)?.user);
    content = (
      <SettingsView
        model={model}
        canManage={canManage}
        orgName={org.name ?? ctx.org.name}
        legalName={org.legal_name ?? null}
        currency={org.currency || currency}
        timeZone={tz}
        readiness={readiness}
        membership={membership}
        rates={{
          dispatch_model: model,
          platform_fee_percent: org.platform_fee_percent ?? 0,
          platform_fee_fixed_cents: org.platform_fee_fixed_cents ?? 0,
          driver_commission_percent: s?.driver_commission_percent ?? null,
          driver_commission_fixed_cents: s?.driver_commission_fixed_cents ?? null,
        }}
        dispatch={{ radii: s?.dispatch_radii_m ?? null, offerTimeoutSeconds: s?.offer_timeout_seconds ?? null, graceHours: s?.settlement_grace_hours ?? null }}
        payment={
          s
            ? {
                settlement_methods: (s.settlement_methods ?? null) as SettlementMethod[] | null,
                settlement_link: s.settlement_link,
                settlement_instructions: s.settlement_instructions,
                settlement_payee_name: s.settlement_payee_name,
                settlement_iban: s.settlement_iban,
                settlement_bic: s.settlement_bic,
              }
            : null
        }
        drivers={driversRes && !driversRes.error ? ((driversRes.data ?? []) as OrgNetworkDriver[]) : null}
        driversFailed={!!driversRes?.error}
        partners={partners}
        excludedPartners={excludedPartners}
        driverExclusions={driverExclusionsRes && !driverExclusionsRes.error ? ((driverExclusionsRes.data ?? []) as NetworkDriverExclusion[]) : null}
        termsAcceptedBy={acceptor ? acceptor.full_name || acceptor.email : null}
        termsVersion={readiness?.terms.version ?? NETWORK_TERMS_VERSION}
      />
    );
  }

  const view = readiness ? orgReadinessView(readiness, model, tz) : null;
  return (
    <>
      <PageHeader
        eyebrow="Opérations"
        title="Réseau partagé"
        description="Vos chauffeurs d'abord. Si aucun n'accepte, la course est proposée aux chauffeurs des organisations partenaires."
      >
        {view && <ReadinessPanel view={view} canManage={canManage} />}
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Sous-onglets du réseau partagé">
          {tabs.map((t) => {
            const badge = t.key === "confiees" ? (summary?.badge ?? 0) : 0;
            return (
              <Link
                key={t.key}
                href={networkShareHref({ tab: t.key })}
                prefetch={false}
                aria-current={tab === t.key ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-3 pt-1 text-[13px] font-medium",
                  tab === t.key ? "border-violet text-fg" : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {t.label}
                {badge > 0 && <span className="mono rounded-md bg-amber/15 px-1.5 text-[11px] leading-[18px] text-amber">{badge}</span>}
              </Link>
            );
          })}
        </nav>
      </PageHeader>
      <PageBody>
        {!summary && (
          <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-4 py-2.5 text-[12.5px] text-fg-muted">
            <CircleAlert className="size-4 shrink-0 text-amber" /> État du réseau partagé momentanément indisponible&nbsp;: réessayez dans un instant.
          </p>
        )}
        {content}
      </PageBody>
    </>
  );
}
