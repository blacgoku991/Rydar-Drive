import "server-only";
// Super admin — fiche d'une organisation (docs/FLOTTE-PRIVEE.md § 8.3) : carte « Flotte Privée » en tête (chauffeur =
// propriétaire, état de sa fiche, application utilisée, invitation acceptée, CGV et accord de traitement, offre et accès
// à l'API, référence du contrat, site du client avec ses clés et ses dernières réservations, fiche recréée, changement
// d'offre de service) ; organisation standard : « Passer en Flotte Privée » avec les conditions, à titre indicatif (la
// RPC fait foi). Lectures du super admin par la RLS ; compte Auth du propriétaire et conditions par le service role.
import {
  ORG_LEGAL_VERSION, PRESENCE_META, RIDE_STATUS_META, formatDate, formatPrice, formatRelative, formatRideDate, legalDateLabel,
  type AdminPlatformFeeSchedule, type DriverPresence, type NetworkMembership, type PrivateFleetBlocker, type RideStatus, type VehicleCategory,
} from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Globe, ShieldCheck, Sparkles } from "lucide-react";
import type { OrgTermsStatus } from "@/components/admin/dispatch-model";
import {
  PackConversionButtons, RecreateDriverButton, ResendAccessButton, SiteKeysPanel, type DriverPrefill, type PlanOption, type SiteKeyRow,
} from "@/components/admin/private-fleet";
import { apiAccessOf, effectiveLimits, ownerDriverState, privateFleetBlockersPreview, siteKeyKind, splitFullName } from "@/components/admin/private-fleet-state";
import { frSpaces } from "@/components/platform-fees/org-platform-format";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

type Db = SupabaseClient<any, any, any>;

/** Organisation lue par la fiche (service role, select *). */
export type CardOrg = {
  id: string;
  name: string;
  status: string;
  dispatch_model: string | null;
  plan_id: string | null;
  limits_override: Record<string, unknown> | null;
  platform_fee_percent: number | string | null;
  platform_fee_fixed_cents: number | null;
};

type MemberUser = { full_name: string | null; email: string };
/** Adhésion lue par la fiche (compte compris : objet, ou tableau selon la relation PostgREST). */
export type CardMember = { user_id: string; role: string; status: string; user: MemberUser | MemberUser[] | null };

const memberUser = (m: CardMember | null): MemberUser | null => (Array.isArray(m?.user) ? (m.user[0] ?? null) : (m?.user ?? null));

export type CardPlan = { id: string; name: string; limits: Record<string, unknown> | null; is_active: boolean };

type Common = {
  db: Db;
  org: CardOrg;
  members: CardMember[];
  plans: CardPlan[];
  schedule: AdminPlatformFeeSchedule | null;
  today: string;
  timeZone: string;
};

const OPEN_STATUSES = ["SEARCHING_DRIVER", "OFFERED"];

/** Offres proposées au changement d'offre : actives, plus l'offre actuelle même retirée. */
function planOptions(plans: CardPlan[], current: string | null): PlanOption[] {
  return plans
    .filter((p) => p.is_active || p.id === current)
    .map((p) => ({ id: p.id, name: p.name, api: apiAccessOf(effectiveLimits({ planId: p.id, planLimits: p.limits, override: null, privateFleet: false })) }));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 text-[12.5px]">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const relative = (iso: string | null | undefined, now: Date) => (iso ? formatRelative(iso, now) : null);

// -----------------------------------------------------------------------------
// Flotte Privée
// -----------------------------------------------------------------------------
export async function PrivateFleetCard({ db, org, members, plans, schedule, today, timeZone, terms }: Common & { terms: OrgTermsStatus | null }) {
  const now = new Date();
  const owner = members.find((m) => m.role === "owner" && m.status === "active") ?? members.find((m) => m.role === "owner") ?? null;
  const [drivers, vehicles, keys, rides, history, openRides, account] = await Promise.all([
    db
      .from("drivers")
      .select("id, number, first_name, last_name, phone, vtc_card_number, status, presence, deleted_at, owner_driver, user_id, last_seen_at, vehicle_id, created_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false }),
    // Véhicule actif le plus récent (préremplissage de la fiche recréée) : celui d'une fiche supprimée est anonymisé et
    // désactivé, ou supprimé (private.delete_driver_account)
    db
      .from("vehicles")
      .select("id, brand, model, color, plate, category, seats, luggage_capacity")
      .eq("organization_id", org.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("api_keys")
      .select("id, name, prefix, last4, allowed_origins, rate_limit_per_minute, created_at, last_used_at, expires_at, revoked_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false }),
    db
      .from("rides")
      .select("id, number, status, pickup_at, created_at, price_cents, currency")
      .eq("organization_id", org.id)
      .eq("source", "api")
      .order("created_at", { ascending: false })
      .limit(5),
    // Création (référence du contrat) et entrées par changement d'offre de service (note d'accord) : journal écrit en base
    db
      .from("audit_logs")
      .select("action, created_at, metadata")
      .eq("organization_id", org.id)
      .in("action", ["organization.private_fleet_created", "organization.private_fleet_enabled"])
      .order("created_at", { ascending: false })
      .limit(10),
    db.from("rides").select("id", { count: "exact", head: true }).eq("organization_id", org.id).in("status", OPEN_STATUSES),
    owner
      ? createAdminClient()
          .auth.admin.getUserById(owner.user_id)
          .then(
            (r) => r.data.user ?? null,
            () => null,
          )
      : Promise.resolve(null),
  ]);

  type DriverRow = {
    id: string; number: number; first_name: string; last_name: string; phone: string; vtc_card_number: string | null; status: string;
    presence: DriverPresence; deleted_at: string | null; owner_driver: boolean; user_id: string | null; last_seen_at: string | null;
  };
  const rows = (drivers.data ?? []) as DriverRow[];
  // Fiche du gérant : la fiche non supprimée (une seule possible), sinon la dernière supprimée
  const driver = rows.find((d) => d.deleted_at == null) ?? rows[0] ?? null;
  const state = ownerDriverState(driver);
  const alive = rows.some((d) => d.deleted_at == null);
  const vehicle = vehicles.data as {
    brand: string | null; model: string; color: string | null; plate: string; category: VehicleCategory; seats: number; luggage_capacity: number;
  } | null;
  const ownerUser = memberUser(owner);
  const names = splitFullName(ownerUser?.full_name ?? "");
  const prefill: DriverPrefill = {
    ownerFirstName: names.firstName || undefined,
    ownerLastName: names.lastName || undefined,
    vehicle: vehicle
      ? {
          brand: vehicle.brand ?? undefined,
          model: vehicle.model,
          color: vehicle.color ?? undefined,
          plate: vehicle.plate,
          category: vehicle.category,
          seats: vehicle.seats,
          luggageCapacity: vehicle.luggage_capacity,
        }
      : undefined,
  };

  const plan = plans.find((p) => p.id === org.plan_id) ?? null;
  const limits = effectiveLimits({ planId: org.plan_id, planLimits: plan?.limits, override: org.limits_override, privateFleet: true });
  const api = apiAccessOf(limits);
  const termsAccepted = terms?.state === "accepted";
  type AuditRow = { action: string; created_at: string; metadata: Record<string, unknown> | null };
  const journal = (history.data ?? []) as AuditRow[];
  const creation = journal.find((a) => a.action === "organization.private_fleet_created") ?? null;
  // Dernière entrée par changement d'offre de service, si elle suit la création (retour en Flotte Privée)
  const entry = journal.find((a) => a.action === "organization.private_fleet_enabled" && (!creation || a.created_at > creation.created_at)) ?? null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);

  const keyRows: SiteKeyRow[] = ((keys.data ?? []) as {
    id: string; name: string; prefix: string; last4: string; allowed_origins: string[] | null; rate_limit_per_minute: number; created_at: string;
    last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
  }[]).map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    last4: k.last4,
    kind: siteKeyKind(k.allowed_origins),
    origins: k.allowed_origins ?? [],
    rateLimitPerMinute: k.rate_limit_per_minute,
    lastUsedLabel: k.last_used_at ? `utilisée ${formatRelative(k.last_used_at, now)}` : "jamais utilisée",
    createdLabel: `créée le ${formatDate(k.created_at, timeZone)}`,
    state: k.revoked_at ? "revoked" : k.expires_at && Date.parse(k.expires_at) < now.getTime() ? "expired" : "active",
    revokedLabel: k.revoked_at ? `révoquée le ${formatDate(k.revoked_at, timeZone)}` : null,
  }));
  const keyBlocked =
    org.status !== "active"
      ? "Organisation suspendue ou archivée : aucune clé ne peut être créée."
      : !termsAccepted
        ? `CGV et accord de traitement du ${legalDateLabel(ORG_LEGAL_VERSION)} pas encore acceptés par le client (espace web) : la clé du site se crée après leur acceptation.`
        : !api
          ? "Offre sans accès à l'API : changez d'abord l'offre (« Offre & limites »)."
          : null;
  const apiRides = (rides.data ?? []) as {
    id: string; number: number; status: RideStatus; pickup_at: string; created_at: string; price_cents: number | null; currency: string | null;
  }[];

  return (
    <Card className="border-brand/25">
      <CardHeader
        icon={<Sparkles className="text-brand" />}
        title="Flotte Privée"
        description={frSpaces("Un chauffeur indépendant : une seule fiche (la sienne, sur son compte), les réservations de son site rien que pour lui.")}
        action={
          <PackConversionButtons
            orgId={org.id}
            targets={["fleet", "centrale"]}
            plans={planOptions(plans, org.plan_id)}
            planId={org.plan_id}
            feePercent={Number(org.platform_fee_percent ?? 0)}
            feeFixedCents={Number(org.platform_fee_fixed_cents ?? 0)}
            schedule={schedule}
            today={today}
            timeZone={timeZone}
            openRides={openRides.count ?? 0}
          />
        }
      />
      <CardBody className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <dl className="divide-y divide-line">
            <Row label="Chauffeur (propriétaire)">
              {driver && driver.deleted_at == null ? `${driver.first_name} ${driver.last_name}` : (ownerUser?.full_name ?? "—")}
              {ownerUser?.email ? <span className="block text-fg-muted">{ownerUser.email}</span> : null}
            </Row>
            <Row label="Fiche chauffeur">
              <Badge tone={state.tone}>{state.label}</Badge>
              {!state.receives && <span className="mt-1 block text-red">Les réservations du site ne lui sont pas proposées.</span>}
            </Row>
            <Row label="Application">
              {driver && driver.deleted_at == null
                ? driver.presence !== "offline"
                  ? PRESENCE_META[driver.presence].label
                  : driver.last_seen_at
                    ? `Dernière activité ${relative(driver.last_seen_at, now)}`
                    : "Jamais utilisée"
                : "—"}
            </Row>
            <Row label="Invitation">
              {account?.last_sign_in_at
                ? `Acceptée · dernière connexion ${relative(account.last_sign_in_at, now)}`
                : owner
                  ? `Pas encore acceptée${account?.invited_at ? ` · envoyée le ${formatDate(account.invited_at, timeZone)}` : ""}`
                  : "Aucun propriétaire actif"}
            </Row>
            <Row label="CGV et accord de traitement">
              {termsAccepted ? (
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck aria-hidden className="size-3.5 text-green" />
                  Version du {legalDateLabel(ORG_LEGAL_VERSION)} acceptée{terms?.acceptedAt ? ` le ${formatDate(terms.acceptedAt, timeZone)}` : ""}
                </span>
              ) : (
                <span className="text-amber">
                  {terms ? `Version du ${legalDateLabel(ORG_LEGAL_VERSION)} pas encore acceptée` : "Acceptation illisible pour le moment"}
                </span>
              )}
            </Row>
            <Row label="Offre">
              {plan?.name ?? "Sans offre"} · API{" "}
              <span className={api ? "text-fg" : "text-red"}>{api ? "incluse" : frSpaces("non incluse : le site ne peut pas réserver")}</span>
            </Row>
            <Row label="Contrat signé">
              {creation ? `${text(creation.metadata?.contract_ref) ?? "—"} · création le ${formatDate(creation.created_at, timeZone)}` : "—"}
            </Row>
            {entry && (
              <Row label="Entrée en Flotte Privée">
                {formatDate(entry.created_at, timeZone)}
                {text(entry.metadata?.note) ? <span className="block text-fg-muted">{frSpaces(`« ${text(entry.metadata?.note)} »`)}</span> : null}
              </Row>
            )}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {!alive && owner?.status === "active" && <RecreateDriverButton orgId={org.id} prefill={prefill} />}
            {owner?.status === "active" && account && !account.last_sign_in_at && <ResendAccessButton orgId={org.id} />}
          </div>
          {!alive && owner?.status !== "active" && (
            <p className="mt-2 text-[12px] text-fg-muted">Aucun propriétaire actif : la fiche sera recréée après l&apos;activation de son accès.</p>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Globe aria-hidden className="size-4 text-fg-muted" /> Site du client
            </h3>
            <SiteKeysPanel orgId={org.id} keys={keyRows} blockedReason={keyBlocked} apiBase={`${env.appUrl}/api/v1`} />
          </div>
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-fg-muted">Dernières réservations du site</p>
            {apiRides.length === 0 ? (
              <p className="text-[12.5px] text-fg-muted">Aucune réservation reçue par l&apos;API.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {apiRides.map((r) => {
                  const meta = RIDE_STATUS_META[r.status];
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[12.5px]">
                      <span className="min-w-0">
                        <span className="num text-fg">#{r.number}</span>{" "}
                        <span className="text-fg-muted">
                          · {formatRideDate(r.pickup_at, timeZone, now)}
                          {r.price_cents != null ? ` · ${formatPrice(r.price_cents, r.currency ?? "EUR")}` : ""}
                        </span>
                      </span>
                      <Badge tone={meta?.tone ?? "neutral"}>{meta?.label ?? r.status}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Organisation standard : passage en Flotte Privée
// -----------------------------------------------------------------------------
export async function PrivateFleetEntryCard({
  db,
  org,
  members,
  plans,
  schedule,
  today,
  timeZone,
  network,
}: Common & { network: Pick<NetworkMembership, "share_out" | "share_in" | "requested_at" | "approved_at" | "refused_reason"> | null }) {
  // Conditions indicatives (private.private_fleet_blockers fait foi) : lectures en service role, après requireSuperAdmin
  const admin = createAdminClient();
  const [drivers, shares, executions, openRides] = await Promise.all([
    admin.from("drivers").select("user_id, status, application_status, deleted_at").eq("organization_id", org.id),
    admin.from("ride_network_shares").select("ride_id", { count: "exact", head: true }).eq("organization_id", org.id).in("status", ["open", "accepted"]),
    admin.from("ride_network_executions").select("id", { count: "exact", head: true }).eq("executor_org_id", org.id).is("ended_at", null),
    db.from("rides").select("id", { count: "exact", head: true }).eq("organization_id", org.id).in("status", OPEN_STATUSES),
  ]);
  const readable = !drivers.error && !shares.error && !executions.error;
  const blockers: PrivateFleetBlocker[] = readable
    ? privateFleetBlockersPreview({
        dispatchModel: org.dispatch_model,
        members: members.map((m) => ({ user_id: m.user_id, role: m.role, status: m.status })),
        drivers: (drivers.data ?? []) as { user_id: string | null; status: string; application_status: string | null; deleted_at: string | null }[],
        network,
        openShares: shares.count ?? 0,
        runningExecutions: executions.count ?? 0,
      })
    : [];
  const plan = plans.find((p) => p.id === org.plan_id) ?? null;
  const api = apiAccessOf(effectiveLimits({ planId: org.plan_id, planLimits: plan?.limits, override: org.limits_override, privateFleet: true }));
  const missing = blockers.length + (api ? 0 : 1);

  return (
    <Card>
      <CardHeader
        icon={<Sparkles />}
        title="Flotte Privée"
        description={frSpaces("Pack d'un chauffeur indépendant : une seule fiche (la sienne), réservations de son site « à confirmer ».")}
        action={
          !readable ? (
            <Badge tone="neutral">Conditions illisibles</Badge>
          ) : missing ? (
            <Badge tone="amber">{`${missing} condition${missing > 1 ? "s" : ""} manquante${missing > 1 ? "s" : ""}`}</Badge>
          ) : (
            <Badge tone="green">Conditions remplies</Badge>
          )
        }
      />
      <CardBody className="space-y-3">
        <p className="text-[12.5px] text-fg-muted">
          {frSpaces(
            "Conditions affichées à titre indicatif : la base fait foi au moment du passage (un seul membre, une seule fiche sur le compte du propriétaire, aucune candidature, aucun réseau partagé, modèle flotte).",
          )}
        </p>
        <PackConversionButtons
          orgId={org.id}
          targets={["private_fleet"]}
          plans={planOptions(plans, org.plan_id)}
          planId={org.plan_id}
          feePercent={Number(org.platform_fee_percent ?? 0)}
          feeFixedCents={Number(org.platform_fee_fixed_cents ?? 0)}
          schedule={schedule}
          today={today}
          timeZone={timeZone}
          openRides={openRides.count ?? 0}
          blockers={blockers}
          apiAccess={api}
        />
      </CardBody>
    </Card>
  );
}
