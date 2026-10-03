import {
  DISPATCH_MODEL_META, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, ORG_STATUS_META, PRESENCE_META, formatCompactPrice, formatNumber, formatRelative,
  legalAcceptanceState, localIsoDay, type AdminPlatformAccount, type AdminPlatformFeeSchedule, type DispatchModel, type DriverPresence,
  type NetworkMembership, type OrgStatus,
} from "@rydar/shared";
import { ArrowLeft, ExternalLink, Layers } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrganizationPlanForm, OrganizationStatusActions } from "@/components/admin/admin-widgets";
import { DispatchModelForm, type OrgTermsStatus } from "@/components/admin/dispatch-model";
import { OrgNetworkCard } from "@/components/admin/org-network-card";
import { OrganizationAccessCard, type AccessMember } from "@/components/admin/organization-access";
import { OrgPlatformFeesCard } from "@/components/platform-fees/admin-org-fees-card";
import { PageBody, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { sharedNetworkEnabled } from "@/lib/shared-network";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Rattacheur" };
export const dynamic = "force-dynamic";

/**
 * Connexion des membres : compte Auth verrouillé (ancien bannissement hérité, ou bannissement réel) et fiche chauffeur
 * bannie éventuelle (une seule fiche par compte). Lecture service role, après requireSuperAdmin ; illisible = non signalé.
 */
async function memberLoginLocks(userIds: string[]) {
  const locked = new Set<string>();
  const bans = new Map<string, "org" | "platform">();
  if (!userIds.length) return { locked, bans };
  const admin = createAdminClient();
  const now = Date.now();
  const [accounts, cards] = await Promise.all([
    Promise.all(userIds.map((id) => admin.auth.admin.getUserById(id).then((r) => r.data.user ?? null, () => null))),
    admin.from("drivers").select("user_id, banned_at, ban_scope").in("user_id", userIds),
  ]);
  for (const u of accounts) if (u?.banned_until && Date.parse(u.banned_until) > now) locked.add(u.id);
  for (const d of (cards.data ?? []) as { user_id: string; banned_at: string | null; ban_scope: string | null }[]) {
    if (d.banned_at) bans.set(d.user_id, d.ban_scope === "platform" ? "platform" : "org");
  }
  return { locked, bans };
}

export default async function OrganizationAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const session = await requireSuperAdmin();
  const db = session.supabase;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  // Membres puis état de connexion de leurs comptes (Auth, service role) : enchaînés DANS le Promise.all, en parallèle
  // des autres lectures. Promise.resolve : une seule requête (chaque .then d'une requête PostgREST la relancerait).
  const membersP = Promise.resolve(
    db
      .from("organization_users")
      .select("id, user_id, role, status, created_at, user:users!organization_users_user_id_fkey(full_name, email)")
      .eq("organization_id", id),
  );
  const memberLocksP = membersP.then((r) =>
    memberLoginLocks([...new Set(((r.data ?? []) as { user_id: string | null }[]).map((m) => m.user_id as string).filter(Boolean))]),
  );
  const [
    { data: org }, kpis, plans, subscription, drivers, errors, notifications, members, locks, keys, applications, banned, platform, feeSchedule, acceptances,
    networkOn, networkRow,
  ] = await Promise.all([
    // Colonnes réservées au serveur (motif de suspension, limites, relance Rydar : GRANT par colonne, 20260924004300) :
    // lecture seule par le client admin, après requireSuperAdmin
    createAdminClient().from("organizations").select("*").eq("id", id).maybeSingle(),
    db.rpc("org_kpis", { p_org: id }),
    db.from("plans").select("id, name, limits").order("sort_order"),
    db.from("subscriptions").select("*").eq("organization_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("drivers").select("id, first_name, last_name, number, presence, status, location:driver_locations(updated_at)").eq("organization_id", id).neq("presence", "offline").order("number"),
    db.from("ride_events").select("id, level, message, created_at").eq("organization_id", id).in("level", ["warning", "error"]).gte("created_at", since).order("id", { ascending: false }).limit(20),
    db.from("notifications").select("id, type, title, status, last_error, created_at").eq("organization_id", id).order("created_at", { ascending: false }).limit(12),
    membersP,
    memberLocksP,
    db.from("api_keys").select("id", { count: "exact", head: true }).eq("organization_id", id).is("revoked_at", null),
    db.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", id).eq("application_status", "pending").is("banned_at", null).is("deleted_at", null),
    db.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", id).not("banned_at", "is", null),
    // Frais plateforme dus à Rydar (centrale, flotte avec des frais par course, ou historique)
    db.rpc("admin_platform_account", { p_org: id }),
    // Frais par course (20260924006600) : hausse annoncée, date d'effet au plus tôt (30 jours, entrée en vigueur des CGV
    // non acceptées), acceptation de ORG_LEGAL_VERSION, historique
    db.rpc("admin_platform_fee_schedule", { p_org: id, p_org_legal_version: ORG_LEGAL_VERSION, p_org_legal_effective_on: ORG_LEGAL_EFFECTIVE_AT }),
    // CGV + accord de traitement acceptés au nom de l'organisation (« dpa » : enregistrés ensemble) : version antérieure ?
    db.from("legal_acceptances").select("version").eq("organization_id", id).eq("document", "dpa"),
    // Réseau partagé : interrupteur de la plateforme et participation de l'organisation (RLS super admin)
    sharedNetworkEnabled(),
    db.from("network_memberships").select("*").eq("organization_id", id).maybeSingle(),
  ]);
  if (!org) notFound();
  const k = (kpis.data ?? {}) as any;
  const status = org.status as OrgStatus;
  const model = (org.dispatch_model ?? "fleet") as DispatchModel;
  const memberRows = (members.data ?? []) as any[];
  const accessMembers = memberRows.map(
    ({ user_id, ...m }) =>
      ({
        ...m,
        user: Array.isArray(m.user) ? (m.user[0] ?? null) : m.user,
        loginLocked: locks.locked.has(user_id),
        driverBan: locks.bans.get(user_id) ?? null,
      }) as AccessMember,
  );
  const joinUrl = org.join_code ? `${env.appUrl}/rejoindre/${org.join_code}` : null;
  const timeZone = (org.timezone as string | null) || "Europe/Paris";
  const schedule = (feeSchedule.error ? null : (feeSchedule.data ?? null)) as AdminPlatformFeeSchedule | null;
  // Acceptation de ORG_LEGAL_VERSION : la base fait foi (CGV ET accord de traitement), le registre dit s'il y a une
  // version antérieure acceptée (« mise à jour » à accepter) ou aucune
  const registry = acceptances.error ? null : legalAcceptanceState(((acceptances.data ?? []) as { version: string }[]).map((a) => a.version), ORG_LEGAL_VERSION);
  const accepted = schedule?.terms ? schedule.terms.accepted : registry === "accepted";
  const terms: OrgTermsStatus | null =
    registry == null && !schedule?.terms
      ? null
      : {
          state: accepted ? "accepted" : registry === "updated" ? "updated" : "pending",
          acceptedAt: schedule?.terms?.accepted_at ?? null,
          // Annonce par e-mail de la version (svc_org_terms_notify) : sans elle ni acceptation, pas de hausse annoncée
          notifiedAt: schedule?.terms?.notified_at ?? null,
          notifiedEffectiveOn: schedule?.terms?.notified_effective_on ?? null,
        };
  const platformAccount = ((platform.data ?? null) as AdminPlatformAccount | null)?.account ?? null;
  const showPlatform =
    !!platformAccount &&
    (model === "centrale" ||
      Number(platformAccount.fee_percent) > 0 ||
      platformAccount.fee_fixed_cents > 0 ||
      platformAccount.posted_cents !== 0 ||
      platformAccount.received_cents !== 0 ||
      platformAccount.declared_count > 0);

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
                // Remonté (saisie remise aux valeurs en vigueur) quand le modèle, les taux ou la hausse annoncée changent
                key={`${model}:${org.platform_fee_percent}:${org.platform_fee_fixed_cents}:${schedule?.scheduled?.id ?? ""}`}
                orgId={id}
                model={model}
                feePercent={Number(org.platform_fee_percent ?? 0)}
                feeFixedCents={Number(org.platform_fee_fixed_cents ?? 0)}
                joinEnabled={!!org.join_enabled}
                timeZone={timeZone}
                schedule={schedule}
                terms={terms}
                today={localIsoDay(new Date(), timeZone)}
              />
              {/* Lien d'inscription des chauffeurs : flotte comme centrale (20260924006300) */}
              {(model === "centrale" || org.join_code) && (
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
          <div className="min-w-0 space-y-6">
            <OrganizationAccessCard orgId={id} orgName={org.name} members={accessMembers} />
            {showPlatform && platformAccount && <OrgPlatformFeesCard orgId={id} account={platformAccount} timeZone={org.timezone ?? "Europe/Paris"} />}
            {/* Réseau partagé : réseau ouvert, ou organisation qui y a déjà participé (réglages conservés) */}
            {(networkOn || networkRow.data) && (
              <OrgNetworkCard
                orgId={id}
                membership={(networkRow.error ? null : (networkRow.data ?? null)) as NetworkMembership | null}
                enabled={networkOn}
                timeZone={timeZone}
                currency={org.currency ?? "EUR"}
              />
            )}
          </div>
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
