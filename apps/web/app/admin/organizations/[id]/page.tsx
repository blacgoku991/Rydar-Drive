import {
  DISPATCH_MODEL_META, ORG_STATUS_META, PRESENCE_META, formatCompactPrice, formatNumber, formatRelative,
  type DispatchModel, type DriverPresence, type OrgStatus,
} from "@rydar/shared";
import { ArrowLeft, ExternalLink, Layers } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrganizationPlanForm, OrganizationStatusActions } from "@/components/admin/admin-widgets";
import { DispatchModelForm } from "@/components/admin/dispatch-model";
import { OrganizationAccessCard, type AccessMember } from "@/components/admin/organization-access";
import { PageBody, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Rattacheur" };
export const dynamic = "force-dynamic";

export default async function OrganizationAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const session = await requireSuperAdmin();
  const db = session.supabase;
  const { data: org } = await db.from("organizations").select("*").eq("id", id).maybeSingle();
  if (!org) notFound();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [kpis, plans, subscription, drivers, errors, notifications, members, keys, applications, banned] = await Promise.all([
    db.rpc("org_kpis", { p_org: id }),
    db.from("plans").select("id, name, limits").order("sort_order"),
    db.from("subscriptions").select("*").eq("organization_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("drivers").select("id, first_name, last_name, number, presence, status, location:driver_locations(updated_at)").eq("organization_id", id).neq("presence", "offline").order("number"),
    db.from("ride_events").select("id, level, message, created_at").eq("organization_id", id).in("level", ["warning", "error"]).gte("created_at", since).order("id", { ascending: false }).limit(20),
    db.from("notifications").select("id, type, title, status, last_error, created_at").eq("organization_id", id).order("created_at", { ascending: false }).limit(12),
    db.from("organization_users").select("id, role, status, created_at, user:users!organization_users_user_id_fkey(full_name, email)").eq("organization_id", id),
    db.from("api_keys").select("id", { count: "exact", head: true }).eq("organization_id", id).is("revoked_at", null),
    db.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", id).eq("application_status", "pending"),
    db.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", id).not("banned_at", "is", null),
  ]);
  const k = (kpis.data ?? {}) as any;
  const status = org.status as OrgStatus;
  const model = (org.dispatch_model ?? "fleet") as DispatchModel;
  const accessMembers = ((members.data ?? []) as any[]).map(
    (m) => ({ ...m, user: Array.isArray(m.user) ? (m.user[0] ?? null) : m.user }) as AccessMember,
  );
  const joinUrl = org.join_code ? `${env.appUrl}/rejoindre/${org.join_code}` : null;

  return (
    <>
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-6 lg:px-10">
          <div className="min-w-0">
            <Link href="/admin/organizations" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg"><ArrowLeft className="size-3.5" /> Rattacheurs</Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-[26px] font-semibold tracking-tight">{org.name}</h1>
              <Badge tone={ORG_STATUS_META[status].tone}>{ORG_STATUS_META[status].label}</Badge>
              <Badge tone={model === "centrale" ? "violet" : "neutral"} dot={false}>{DISPATCH_MODEL_META[model].short}</Badge>
            </div>
            <p className="mt-1.5 text-[13px] text-fg-muted [overflow-wrap:anywhere]">{org.slug} · {org.email} · {org.city ?? "—"}{org.suspended_reason ? ` · motif : ${org.suspended_reason}` : ""}</p>
          </div>
          <div className="flex gap-2"><OrganizationStatusActions orgId={id} status={status} /></div>
        </div>
      </div>
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <StatCard label="Chauffeurs" value={formatNumber(k.drivers_total)} sub={`${k.drivers_online ?? 0} en ligne`} tone="brand" />
          <StatCard label="Courses auj." value={formatNumber(k.rides_today)} sub={`${k.rides_week ?? 0} cette semaine`} />
          <StatCard label="CA auj." value={formatCompactPrice(k.revenue_today_cents)} />
          <StatCard label="En cours" value={formatNumber(k.in_progress)} tone="cyan" />
          <StatCard label="Sans chauffeur" value={formatNumber(k.no_driver_today)} tone={k.no_driver_today ? "red" : undefined} sub="aujourd'hui" />
          <StatCard label="Clés API" value={formatNumber(keys.count ?? 0)} sub="actives" />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[1.15fr_1fr]">
          <Card>
            <CardHeader
              title="Modèle d'exploitation"
              icon={<Layers />}
              description="Choisi par Rydar pour ce compte : flotte classique ou centrale à commission (réseau de chauffeurs indépendants)."
            />
            <CardBody className="space-y-5">
              <DispatchModelForm
                orgId={id}
                model={model}
                feePercent={Number(org.platform_fee_percent ?? 0)}
                feeFixedCents={Number(org.platform_fee_fixed_cents ?? 0)}
                joinEnabled={!!org.join_enabled}
              />
              {model === "centrale" && (
                <div className="grid gap-3 rounded-xl border border-line bg-white/[0.015] p-4 text-[12.5px] sm:grid-cols-3">
                  <div>
                    <p className="text-fg-subtle">Lien d&apos;inscription</p>
                    <p className="mt-0.5 font-medium text-fg">
                      {org.join_enabled ? (org.join_auto_approve ? "Actif · validation auto" : "Actif · validation manuelle") : org.join_code ? "Coupé" : "Jamais créé"}
                    </p>
                    {joinUrl && org.join_enabled && (
                      <a href={joinUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-brand hover:underline">
                        <span className="truncate">/rejoindre/{org.join_code}</span> <ExternalLink className="size-3 shrink-0" />
                      </a>
                    )}
                  </div>
                  <div>
                    <p className="text-fg-subtle">Candidatures en attente</p>
                    <p className="num mt-0.5 text-[15px] font-semibold text-fg">{formatNumber(applications.count ?? 0)}</p>
                  </div>
                  <div>
                    <p className="text-fg-subtle">Chauffeurs bannis</p>
                    <p className="num mt-0.5 text-[15px] font-semibold text-fg">{formatNumber(banned.count ?? 0)}</p>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
          <OrganizationAccessCard orgId={id} orgName={org.name} members={accessMembers} />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title="Offre & limites" description={subscription.data ? `Abonnement ${subscription.data.status}` : "Sans abonnement Stripe"} />
            <CardBody><OrganizationPlanForm orgId={id} plans={(plans.data ?? []) as any} planId={org.plan_id} override={org.limits_override ?? {}} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Chauffeurs connectés" description={`${drivers.data?.length ?? 0} en ligne`} />
            <div className="max-h-[420px] divide-y divide-line overflow-y-auto">
              {(drivers.data ?? []).map((d: any) => (
                <div key={d.id} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                  <span>{d.first_name} {d.last_name} <span className="num text-fg-subtle">#{d.number}</span></span>
                  <Badge tone={PRESENCE_META[d.presence as DriverPresence].tone}>{PRESENCE_META[d.presence as DriverPresence].label}</Badge>
                </div>
              ))}
              {!drivers.data?.length && <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucun chauffeur en ligne.</p>}
            </div>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title="Erreurs de dispatch" description="7 derniers jours" />
            <div className="max-h-[320px] divide-y divide-line overflow-y-auto">
              {(errors.data ?? []).map((e: any) => (
                <div key={e.id} className="px-5 py-2.5">
                  <p className={`text-[12.5px] ${e.level === "error" ? "text-red" : "text-amber"}`}>{e.message}</p>
                  <p className="text-[11.5px] text-fg-subtle">{formatRelative(e.created_at)}</p>
                </div>
              ))}
              {!errors.data?.length && <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucune erreur.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Notifications" description="Dernières notifications push" />
            <div className="max-h-[320px] divide-y divide-line overflow-y-auto">
              {(notifications.data ?? []).map((n: any) => (
                <div key={n.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <span className="min-w-0"><span className="block truncate text-[12.5px]">{n.title}</span><span className="block truncate text-[11.5px] text-fg-subtle">{n.last_error ?? n.type} · {formatRelative(n.created_at)}</span></span>
                  <Badge tone={n.status === "sent" ? "green" : n.status === "failed" ? "red" : n.status === "queued" ? "amber" : "neutral"}>{n.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
