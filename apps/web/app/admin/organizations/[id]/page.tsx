import {
  ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, ORG_STATUS_META, PRESENCE_META, formatCompactPrice, formatNumber, formatRelative, legalAcceptanceState,
  localIsoDay, type AdminPlatformAccount, type AdminPlatformFeeSchedule, type DispatchModel, type DriverPresence, type NetworkMembership, type OrgRole,
  type OrgStatus,
} from "@rydar/shared";
import { ExternalLink, Gauge, Layers } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrganizationPlanForm, OrganizationStatusActions } from "@/components/admin/admin-widgets";
import { DispatchModelForm, type OrgTermsStatus } from "@/components/admin/dispatch-model";
import { OrgNetworkCard } from "@/components/admin/org-network-card";
import { modelFeesSummary, noticeLate, notificationLine, orgWatchItems, subscriptionLine, type OrgWatchItem, type WatchTone } from "@/components/admin/org-watch";
import { OrganizationAccessCard, type AccessMember } from "@/components/admin/organization-access";
import { CLIENT_KIND_META, clientKind } from "@/components/admin/platform-data";
import {
  PrivateFleetCard, PrivateFleetEntryCard, PrivateFleetExitCard, type CardMember, type CardOrg, type CardPlan,
} from "@/components/admin/private-fleet-card";
import { OrgPlatformFeesCard } from "@/components/platform-fees/admin-org-fees-card";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge, toneDot, toneText } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { NewTabHint } from "@/components/ui/new-tab";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { sharedNetworkEnabled } from "@/lib/shared-network";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";
import { dispatchLevel, plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Fiche client" };
export const dynamic = "force-dynamic";

/** Point de couleur d'une ligne « À surveiller » (§ 3.3 : rouge = retard, ambre = à suivre, gris = information). */
const WATCH_DOT: Record<WatchTone, string> = { danger: toneDot.red, warning: toneDot.amber, neutral: toneDot.neutral };
const SUMMARY_TEXT: Record<WatchTone, string> = { danger: toneText.red, warning: toneText.amber, neutral: "text-fg-muted" };

/**
 * Connexion des membres : compte Auth verrouillé (ancien bannissement hérité, ou bannissement réel), fiche chauffeur
 * bannie éventuelle (une seule fiche par compte) et invitation pas encore acceptée (compte invité qui ne s'est jamais
 * connecté). Lecture service role, après requireSuperAdmin ; illisible = non signalé.
 */
async function memberLoginLocks(userIds: string[]) {
  const locked = new Set<string>();
  const bans = new Map<string, "org" | "platform">();
  const neverSignedIn = new Set<string>();
  if (!userIds.length) return { locked, bans, neverSignedIn };
  const admin = createAdminClient();
  const now = Date.now();
  const [accounts, cards] = await Promise.all([
    Promise.all(userIds.map((id) => admin.auth.admin.getUserById(id).then((r) => r.data.user ?? null, () => null))),
    admin.from("drivers").select("user_id, banned_at, ban_scope").in("user_id", userIds),
  ]);
  for (const u of accounts) {
    if (u?.banned_until && Date.parse(u.banned_until) > now) locked.add(u.id);
    if (u?.invited_at && !u.last_sign_in_at) neverSignedIn.add(u.id);
  }
  for (const d of (cards.data ?? []) as { user_id: string; banned_at: string | null; ban_scope: string | null }[]) {
    if (d.banned_at) bans.set(d.user_id, d.ban_scope === "platform" ? "platform" : "org");
  }
  return { locked, bans, neverSignedIn };
}

/**
 * Fiche d'un client (docs/REFONTE-PANELS.md, R4) : identité et « À surveiller » d'abord, quatre chiffres (deux en Flotte
 * Privée), la carte Flotte Privée, l'accès et l'argent, l'offre ; puis, repliés, le changement d'offre de service et le
 * réseau partagé, l'activité ; les actions graves en bas (« Zone sensible »). Mêmes lectures, mêmes composants, mêmes
 * actions et confirmations qu'avant (la carte « Clés API » et son compteur sont retirés).
 */
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
    { data: org }, kpis, plans, subscription, drivers, errors, notifications, members, locks, applications, banned, platform, feeSchedule, acceptances,
    networkOn, networkRow,
  ] = await Promise.all([
    // Colonnes réservées au serveur (motif de suspension, limites, relance Rydar : GRANT par colonne, 20260924004300) :
    // lecture seule par le client admin, après requireSuperAdmin
    createAdminClient().from("organizations").select("*").eq("id", id).maybeSingle(),
    db.rpc("org_kpis", { p_org: id }),
    db.from("plans").select("id, name, limits, is_active").order("sort_order"),
    db.from("subscriptions").select("*").eq("organization_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("drivers").select("id, first_name, last_name, number, presence, status, location:driver_locations(updated_at)").eq("organization_id", id).neq("presence", "offline").order("number"),
    db.from("ride_events").select("id, level, message, created_at").eq("organization_id", id).in("level", ["warning", "error"]).gte("created_at", since).order("id", { ascending: false }).limit(20),
    db.from("notifications").select("id, type, title, status, last_error, created_at").eq("organization_id", id).order("created_at", { ascending: false }).limit(12),
    membersP,
    memberLocksP,
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
  const status = org.status as OrgStatus;
  const model = (org.dispatch_model ?? "fleet") as DispatchModel;
  // Flotte Privée (docs/FLOTTE-PRIVEE.md § 8.3) : carte en tête, choix du modèle verrouillé, accès et réseau masqués
  const privateFleet = org.private_fleet === true;
  const kind = CLIENT_KIND_META[clientKind(org)];
  const k = (kpis.error ? null : (kpis.data ?? null)) as Record<string, number> | null;
  if (kpis.error) console.error("[admin] fiche client : chiffres", kpis.error.message);
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
  const today = localIsoDay(new Date(), timeZone);
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
  const network = (networkRow.error ? null : (networkRow.data ?? null)) as NetworkMembership | null;
  const showNetwork = !privateFleet && (networkOn || !!networkRow.data);
  const scheduled = schedule?.scheduled ?? null;
  const feePercent = Number(org.platform_fee_percent ?? 0);
  const feeFixedCents = Number(org.platform_fee_fixed_cents ?? 0);
  const currency = (org.currency as string | null) || "EUR";

  // « À surveiller » : invitations pas encore acceptées (adhésion « invitée » ou compte invité jamais connecté)
  const invitations = memberRows
    .filter((m) => m.status === "invited" || (m.status === "active" && locks.neverSignedIn.has(m.user_id)))
    .map((m) => {
      const user = Array.isArray(m.user) ? (m.user[0] ?? null) : m.user;
      return { name: (user?.full_name || user?.email || "—") as string, role: m.role as OrgRole };
    });
  const watch = orgWatchItems({
    orgId: id,
    timeZone,
    termsVersion: ORG_LEGAL_VERSION,
    terms,
    fees: platform.error ? "unreadable" : showPlatform ? platformAccount : null,
    scheduled,
    rates: { percent: feePercent, fixedCents: feeFixedCents, currency },
    invitations,
    applications: privateFleet ? undefined : applications.error ? null : (applications.count ?? 0),
  });
  const watchTone = watch.some((w) => w.tone === "danger") ? "danger" : watch.some((w) => w.tone === "warning") ? "warning" : "neutral";
  const summary = modelFeesSummary({ model, privateFleet, percent: feePercent, fixedCents: feeFixedCents, currency, terms, scheduled, timeZone });
  const lateNotice = !!scheduled && noticeLate(scheduled);
  const online = drivers.error ? null : (drivers.data ?? []);
  const alerts = errors.error ? null : (errors.data ?? []);
  const notes = notifications.error ? null : (notifications.data ?? []);
  const showJoin = !privateFleet && (model === "centrale" || !!org.join_code);

  return (
    <>
      <PageHeader
        back={{ href: "/admin/organizations", label: "Clients" }}
        title={org.name}
        badges={
          <>
            <Badge tone={ORG_STATUS_META[status].tone}>{ORG_STATUS_META[status].label}</Badge>
            <Badge tone={kind.tone} dot={false}>
              {kind.label}
            </Badge>
          </>
        }
        meta={
          <>
            <span>{[org.email, org.city, org.slug].filter(Boolean).join(" · ")}</span>
            {org.suspended_reason && <span className="mt-0.5 block text-fg">Motif{"\u00a0"}: {org.suspended_reason}</span>}
          </>
        }
        actions={status !== "active" ? <OrganizationStatusActions orgId={id} status={status} part="reactivate" /> : undefined}
      />
      <PageBody className="space-y-4 sm:space-y-6">
        {watch.length > 0 && <WatchCallout items={watch} tone={watchTone} />}

        {!k && (
          <Callout tone="warning" title="Chiffres indisponibles">
            Lecture impossible, réessayez dans un instant.
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {!privateFleet && (
            <StatCard
              label="Chauffeurs en ligne"
              value={k ? `${formatNumber(k.drivers_online)}\u00a0/\u00a0${formatNumber(k.drivers_total)}` : "—"}
              sub={k ? "en ligne / actifs" : undefined}
            />
          )}
          <StatCard label="Courses aujourd'hui" value={formatNumber(k?.rides_today)} sub={k ? `${formatNumber(k.rides_week)} cette semaine` : undefined} />
          <StatCard label="Chiffre d'affaires du jour" value={formatCompactPrice(k?.revenue_today_cents)} sub="courses terminées" />
          {!privateFleet && (
            <StatCard
              label="Courses sans chauffeur"
              value={formatNumber(k?.no_driver_today)}
              tone={k?.no_driver_today ? "red" : undefined}
              sub={k ? "aujourd'hui" : undefined}
            />
          )}
        </div>

        {privateFleet && (
          <PrivateFleetCard db={db} org={org as CardOrg} members={memberRows as CardMember[]} plans={(plans.data ?? []) as CardPlan[]} terms={terms} timeZone={timeZone} />
        )}

        {/* Téléphone : Accès, Argent, Offre (ordre du code, qui reste l'ordre de lecture) ; grand écran : Accès puis Offre à
            gauche, Argent à droite. Deux colonnes indépendantes : la 1re rangée suit la hauteur d'« Accès » seule (auto),
            la colonne Argent (sur deux rangées) ne prend sa place que dans la 2e (1fr) — plus de trou sous « Accès » quand
            « Modifier le modèle ou les frais » s'ouvre */}
        <div className={cn("grid items-start gap-4 sm:gap-6 xl:grid-cols-2", !privateFleet && "xl:grid-rows-[auto_1fr]")}>
          {!privateFleet && <OrganizationAccessCard orgId={id} orgName={org.name} members={accessMembers} />}
          <div className={cn("min-w-0 space-y-4 sm:space-y-6", !privateFleet && "xl:row-span-2")}>
            {showPlatform && platformAccount && <OrgPlatformFeesCard orgId={id} account={platformAccount} timeZone={timeZone} />}
            <Card>
              <CardHeader title="Modèle et frais Rydar" icon={<Layers />} />
              <CardBody className="space-y-4">
                <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
                  {summary.map((item) => (
                    <div key={item.label} className="flex min-w-0 gap-1">
                      <dt className="shrink-0 text-fg-muted">
                        {item.label}
                        {"\u00a0"}:
                      </dt>
                      <dd className={cn("min-w-0", item.tone ? SUMMARY_TEXT[item.tone] : "text-fg")}>{item.value}</dd>
                    </div>
                  ))}
                </dl>
                <Disclosure
                  id="modele-et-frais"
                  title="Modifier le modèle ou les frais"
                  forceOpen={lateNotice}
                  className="scroll-mt-6 rounded-xl border border-line px-4"
                  contentClassName="pb-4 pt-1"
                >
                  <DispatchModelForm
                    // Remonté (saisie remise aux valeurs en vigueur) quand le modèle, les taux ou la hausse annoncée changent
                    key={`${model}:${org.platform_fee_percent}:${org.platform_fee_fixed_cents}:${schedule?.scheduled?.id ?? ""}`}
                    orgId={id}
                    model={model}
                    feePercent={feePercent}
                    feeFixedCents={feeFixedCents}
                    joinEnabled={!!org.join_enabled}
                    timeZone={timeZone}
                    schedule={schedule}
                    terms={terms}
                    today={today}
                    modelLocked={privateFleet}
                  />
                </Disclosure>
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader
              title="Offre et limites"
              icon={<Gauge />}
              description={subscription.error ? "Abonnement\u00a0: lecture impossible" : subscriptionLine(subscription.data ?? null, timeZone)}
            />
            <CardBody>
              <OrganizationPlanForm
                orgId={id}
                plans={(plans.data ?? []) as CardPlan[]}
                planId={org.plan_id}
                override={org.limits_override ?? {}}
                privateFleet={privateFleet}
              />
            </CardBody>
          </Card>
        </div>

        {(privateFleet || status !== "archived" || showNetwork) && (
          <Disclosure title="Offre de service et réseau partagé" className="surface rounded-xl px-4 sm:px-5" contentClassName="grid items-start gap-4 pb-4 pt-1 sm:gap-6 xl:grid-cols-2">
            {privateFleet ? (
              <PrivateFleetExitCard db={db} org={org as CardOrg} plans={(plans.data ?? []) as CardPlan[]} schedule={schedule} today={today} timeZone={timeZone} />
            ) : (
              status !== "archived" && (
                <PrivateFleetEntryCard
                  db={db}
                  org={org as CardOrg}
                  members={memberRows as CardMember[]}
                  plans={(plans.data ?? []) as CardPlan[]}
                  schedule={schedule}
                  today={today}
                  timeZone={timeZone}
                  network={network}
                />
              )
            )}
            {/* Réseau partagé : réseau ouvert, ou organisation qui y a déjà participé (réglages conservés) ; jamais en Flotte Privée */}
            {showNetwork && <OrgNetworkCard orgId={id} membership={network} enabled={networkOn} timeZone={timeZone} currency={currency} />}
          </Disclosure>
        )}

        <Disclosure
          title="Activité"
          hint={online ? plural(online.length, "chauffeur en ligne", "chauffeurs en ligne") : undefined}
          className="surface rounded-xl px-4 sm:px-5"
          contentClassName="grid items-start gap-4 pb-4 pt-1 sm:gap-6 xl:grid-cols-2"
        >
          <Card className="overflow-hidden">
            <CardHeader title="Chauffeurs connectés" description={online ? plural(online.length, "chauffeur en ligne", "chauffeurs en ligne") : undefined} />
            {!online ? (
              <Unreadable />
            ) : online.length === 0 ? (
              <EmptyState size="compact" title="Aucun chauffeur en ligne." />
            ) : (
              // Zones défilantes atteignables au clavier (flèches) et nommées (WCAG 2.1.1) : la région est un div qui CONTIENT
              // la liste (jamais <ul role="region"> : la liste disparaîtrait et ses <li> seraient orphelins, WCAG 1.3.1)
              <div className="max-h-[420px] overflow-y-auto" tabIndex={0} role="region" aria-label="Chauffeurs connectés">
                <ul className="divide-y divide-line">
                  {online.map((d: any) => {
                    const presence = PRESENCE_META[d.presence as DriverPresence];
                    return (
                      <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                        <span className="min-w-0 truncate">
                          {d.first_name} {d.last_name} <span className="num text-fg-muted">#{d.number}</span>
                        </span>
                        <Badge tone={presence?.tone ?? "neutral"}>{presence?.label ?? "En ligne"}</Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Alertes du dispatch" description="7 derniers jours" />
            {!alerts ? (
              <Unreadable />
            ) : alerts.length === 0 ? (
              <EmptyState size="compact" title="Aucune alerte." description="Rien à signaler sur les 7 derniers jours." />
            ) : (
              <div className="max-h-[320px] overflow-y-auto" tabIndex={0} role="region" aria-label="Alertes du dispatch">
                <ul className="divide-y divide-line">
                  {alerts.map((e: any) => {
                    const level = dispatchLevel(e.level);
                    return (
                      <li key={e.id} className="flex items-start gap-3 px-5 py-2.5">
                        <span aria-hidden className={cn("mt-[7px] size-2 shrink-0 rounded-full", toneDot[level.tone])} />
                        <div className="min-w-0">
                          <p className="text-[13px] text-fg [overflow-wrap:anywhere]">{e.message}</p>
                          <p className="mt-0.5 text-[12px] text-fg-muted">
                            <span className={toneText[level.tone]}>{level.label}</span> · {formatRelative(e.created_at)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Notifications" description="Dernières notifications envoyées sur les téléphones des chauffeurs." />
            {!notes ? (
              <Unreadable />
            ) : notes.length === 0 ? (
              <EmptyState size="compact" title="Aucune notification." />
            ) : (
              <>
                <div className="max-h-[360px] overflow-y-auto" tabIndex={0} role="region" aria-label="Dernières notifications">
                  <ul className="divide-y divide-line">
                    {notes.map((n: any) => {
                      const line = notificationLine(n);
                      return (
                        <li key={n.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-fg">{n.title}</span>
                            <span className="block text-[12px] text-fg-muted">
                              {formatRelative(n.created_at)}
                              {line.reason ? ` · ${line.reason}` : ""}
                            </span>
                          </span>
                          <Badge tone={line.status.tone}>{line.status.label}</Badge>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <Disclosure
                  title="Codes techniques (pour le support)"
                  className="border-t border-line px-5"
                  summaryClassName="text-[13px] text-fg-muted hover:text-fg"
                  contentClassName="pb-3"
                >
                  <ul className="space-y-1 text-[12px] text-fg-muted">
                    {notes.map((n: any) => (
                      <li key={n.id} className="[overflow-wrap:anywhere]">
                        {formatRelative(n.created_at)} · <span className="mono">{notificationLine(n).code}</span>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              </>
            )}
          </Card>

          {/* Lien d'inscription des chauffeurs : flotte comme centrale (20260924006300) ; fermé en Flotte Privée */}
          {showJoin && (
            <Card>
              <CardHeader title="Lien d'inscription" description="Candidatures des chauffeurs (le client les valide dans son espace)." />
              <CardBody className="grid gap-3 text-[13px] sm:grid-cols-3">
                <div className="min-w-0">
                  <p className="text-fg-muted">État</p>
                  <p className="mt-0.5 font-medium text-fg">
                    {org.join_enabled ? (org.join_auto_approve ? "Actif · validation auto" : "Actif · validation manuelle") : org.join_code ? "Coupé" : "Jamais créé"}
                  </p>
                  {joinUrl && org.join_enabled && (
                    <a href={joinUrl} target="_blank" rel="noreferrer" className="relative mt-0.5 inline-flex max-w-full items-center gap-1 text-brand hover:underline">
                      <span className="truncate">/rejoindre/{org.join_code}</span> <ExternalLink aria-hidden className="size-3 shrink-0" />
                      <NewTabHint />
                    </a>
                  )}
                </div>
                <div>
                  <p className="text-fg-muted">Candidatures en attente</p>
                  <p className="num mt-0.5 text-[15px] font-semibold text-fg">{applications.error ? "—" : formatNumber(applications.count ?? 0)}</p>
                </div>
                <div>
                  <p className="text-fg-muted">Chauffeurs bannis</p>
                  <p className="num mt-0.5 text-[15px] font-semibold text-fg">{banned.error ? "—" : formatNumber(banned.count ?? 0)}</p>
                </div>
              </CardBody>
            </Card>
          )}
        </Disclosure>

        <OrganizationStatusActions orgId={id} status={status} part="sensitive" />
      </PageBody>
    </>
  );
}

/** « À surveiller » : une ligne par sujet, la plus urgente d'abord ; lien vers l'endroit où agir s'il y en a un. */
function WatchCallout({ items, tone }: { items: OrgWatchItem[]; tone: WatchTone }) {
  return (
    <Callout tone={tone} role="status" title="À surveiller">
      <ul className="mt-1 space-y-1.5">
        {items.map((w) => (
          <li key={w.key} className="flex gap-2.5">
            <span aria-hidden className={cn("mt-[8px] size-1.5 shrink-0 rounded-full", WATCH_DOT[w.tone])} />
            <span className="min-w-0 text-fg">
              {w.text}
              {w.link && (
                <>
                  {" "}
                  {w.link.href.startsWith("#") ? (
                    <a href={w.link.href} className="font-medium text-brand underline-offset-2 hover:underline">
                      {w.link.label}
                    </a>
                  ) : (
                    <Link href={w.link.href} prefetch={false} className="font-medium text-brand underline-offset-2 hover:underline">
                      {w.link.label}
                    </Link>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function Unreadable() {
  return <p className="px-5 py-4 text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</p>;
}
