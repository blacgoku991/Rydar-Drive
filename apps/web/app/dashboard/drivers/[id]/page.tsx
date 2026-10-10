import {
  DRIVER_STATUS_META, IDENTITY_KIND_LABELS, TRUST_LEVEL_META, VEHICLE_CATEGORY_META, formatDate, formatNumber, formatPercent, formatPhone, formatPrice,
  formatRelative, formatRideDate, formatTime, shortAddress,
  type DispatchModel, type DocumentType, type DriverStatus, type FraudReport, type IdentityKind, type TrustLevel, type VehicleCategory,
} from "@rydar/shared";
import { Car, Globe2, Link2, MapPin, MessageCircle, ShieldBan, ShieldCheck, UserPlus, UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DriverControls } from "@/components/drivers/driver-controls";
import { DriverDocuments } from "@/components/drivers/driver-documents";
import { DriverEarningsCard } from "@/components/drivers/driver-earnings";
import { DriverMap } from "@/components/drivers/driver-map";
import { DOCUMENT_COLUMNS, buildDocumentView, fileKind, type DocumentRow, type DocumentView } from "@/components/drivers/documents";
import { computeDriverEarnings, earningsWindow, type EarningRide } from "@/components/drivers/earnings";
import { ShowMoreList } from "@/components/drivers/show-more-list";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { ApplicationActions } from "@/components/network/applications";
import { BanDriverButton, LiftBanButton, TrustLevelControl } from "@/components/network/driver-safety";
import { IDENTITY_ORDER, REPORT_STATUS_FOR_ORG } from "@/components/network/labels";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { PresenceBadge, RideStatusBadge } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { DesktopTable, ListCard, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { privateFleetPage } from "@/lib/private-fleet";
import { cn } from "@/lib/utils";
import { orgWords, plural } from "@/lib/wording";
import type { LiveDriver } from "@/lib/queries/live";

export const metadata: Metadata = { title: "Chauffeur" };
export const dynamic = "force-dynamic";

const NB = " ";
/** Historique : 10 courses sur téléphone, puis « Afficher les 25 courses » ; le tableau du grand écran montre tout. */
const HISTORY_PHONE = 10;

/** URL signée d'un fichier du bucket privé driver-documents (null si le stockage n'est pas disponible). */
async function signedUrl(supabase: Awaited<ReturnType<typeof requireOrg>>["supabase"], path: string): Promise<string | null> {
  try {
    const res = await Promise.race([
      supabase.storage.from("driver-documents").createSignedUrl(path, 600),
      new Promise<null>((r) => setTimeout(() => r(null), 2500)),
    ]);
    return res && !res.error ? (res.data?.signedUrl ?? null) : null;
  } catch {
    return null;
  }
}

function Spec({ label, children, num }: { label: string; children: React.ReactNode; num?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-fg-muted">{label}</p>
      <p className={cn("[overflow-wrap:anywhere]", num && "num")}>{children}</p>
    </div>
  );
}

export default async function DriverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrg();
  // Flotte Privée : fiche du propriétaire dans « Mon profil chauffeur » (ni statut, ni bannissement, ni mot de passe)
  privateFleetPage(ctx, { redirect: "/dashboard/profil" });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: d } = await ctx.supabase
    .from("drivers")
    .select(
      "*, vehicle:vehicles(brand, model, color, plate, category, seats, luggage_capacity), location:driver_locations(lat, lng, heading, speed_mps, updated_at, battery_level), reviewer:users!drivers_application_reviewed_by_fkey(full_name, email), banner:users!drivers_banned_by_fkey(full_name, email)",
    )
    .eq("id", id)
    .eq("organization_id", ctx.org.id)
    .maybeSingle();
  if (!d) notFound();
  const tz = ctx.org.timezone;
  const since = earningsWindow(tz).since;
  const canManage = isAdminRole(ctx.role);
  const model: DispatchModel = ctx.org.dispatch_model === "centrale" ? "centrale" : "fleet";
  const centrale = model === "centrale";
  const w = orgWords(model);
  const none = Promise.resolve({ data: [] as never[] });
  const [{ data: stats }, { data: rides }, { data: docs }, { data: trail }, { data: done }, { data: settings }, { data: bannedIds }, { data: reports }] = await Promise.all([
    ctx.supabase.rpc("driver_stats", { p_driver: id, p_days: 30 }),
    ctx.supabase
      .from("rides")
      .select("id, number, status, pickup_at, pickup_address, dropoff_address, price_cents")
      .eq("organization_id", ctx.org.id)
      .eq("driver_id", id)
      .order("pickup_at", { ascending: false })
      .limit(25),
    ctx.supabase.from("driver_documents").select(DOCUMENT_COLUMNS).eq("organization_id", ctx.org.id).eq("driver_id", id),
    // Trajet des 3 dernières heures (historique échantillonné)
    ctx.supabase
      .from("driver_location_history")
      .select("lat, lng, recorded_at")
      .eq("driver_id", id)
      .gte("recorded_at", new Date(Date.now() - 3 * 3600_000).toISOString())
      .order("recorded_at", { ascending: true })
      .limit(1500),
    // Chiffre d'affaires : courses terminées depuis le début de la semaine / du mois / 14 jours
    ctx.supabase
      .from("rides")
      .select("price_cents, completed_at, pickup_at, payment_method")
      .eq("organization_id", ctx.org.id)
      .eq("driver_id", id)
      .eq("status", "COMPLETED")
      .or(`completed_at.gte."${since}",and(completed_at.is.null,pickup_at.gte."${since}")`)
      .limit(5000),
    ctx.supabase
      .from("organization_settings")
      .select("driver_commission_percent, new_driver_max_price_cents, trust_after_rides")
      .eq("organization_id", ctx.org.id)
      .maybeSingle(),
    // Identités bannies et signalements : lisibles par owner / admin uniquement (RLS)
    canManage && d.banned_at
      ? ctx.supabase.from("banned_identities").select("id, kind, hint").eq("organization_id", ctx.org.id).eq("scope", "org").eq("driver_id", id).is("lifted_at", null)
      : none,
    canManage ? ctx.supabase.from("fraud_reports").select("id, status, created_at").eq("driver_id", id).order("created_at", { ascending: false }).limit(1) : none,
  ]);
  const vehicle = Array.isArray(d.vehicle) ? d.vehicle[0] : d.vehicle;
  const location = Array.isArray(d.location) ? d.location[0] : d.location;
  const live: LiveDriver = { ...d, vehicle, location } as LiveDriver;
  const s = stats as any;
  const commission = settings?.driver_commission_percent != null ? Number(settings.driver_commission_percent) : null;
  const earnings = computeDriverEarnings((done ?? []) as EarningRide[], tz, commission);
  const docView = buildDocumentView((docs ?? []) as unknown as DocumentRow[], tz);
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const reviewer = one(d.reviewer as { full_name: string | null; email: string } | null);
  const banner = one(d.banner as { full_name: string | null; email: string } | null);
  const banned = !!d.banned_at;
  // Compte supprimé par le chauffeur (004000) : fiche anonyme gardée pour les courses et règlements, non modifiable
  const deleted = !!d.deleted_at;
  const platformBan = d.ban_scope === "platform";
  const pendingApplication = d.application_status === "pending" && !banned;
  const candidate = d.application_status === "pending" || d.application_status === "rejected";
  const trust = (d.trust_level ?? "trusted") as TrustLevel;
  const status = d.status as DriverStatus;
  const identities = ((bannedIds ?? []) as { id: string; kind: IdentityKind; hint: string | null }[]).sort(
    (a, b) => IDENTITY_ORDER.indexOf(a.kind) - IDENTITY_ORDER.indexOf(b.kind),
  );
  const report = ((reports ?? []) as Pick<FraudReport, "id" | "status" | "created_at">[])[0] ?? null;
  const name = `${d.first_name} ${d.last_name}`;
  const documents: DocumentView[] = await Promise.all(
    docView.items.map(async (doc) => ({
      ...doc,
      kind: fileKind(doc.file_path),
      url: doc.file_path ? await signedUrl(ctx.supabase, doc.file_path) : null,
    })),
  );
  const history = (rides ?? []) as { id: string; number: number; status: string; pickup_at: string; pickup_address: string; dropoff_address: string; price_cents: number | null }[];
  const offers = Number(s?.offers?.offers ?? 0);
  // Colonnes de la carte « Sécurité » : confiance (centrale), inscription, bannissement (propriétaire et administrateur)
  const securityColumns = (centrale ? 1 : 0) + 1 + (canManage ? 1 : 0);

  return (
    <>
      <LiveRefresh driverId={d.id} events={["driver.updated"]} pollMs={15000} />
      <PageHeader
        back={{ href: "/dashboard/drivers", label: "Chauffeurs" }}
        title={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <Avatar name={name} src={d.photo_url} size={40} />
            <span>
              {name} <span className="num text-[15px] font-normal text-fg-muted">#{d.number}</span>
            </span>
          </span>
        }
        badges={
          <>
            {deleted ? (
              <Badge tone="neutral">Compte supprimé</Badge>
            ) : (
              <>
                <PresenceBadge presence={d.presence} />
                {/* Statut du compte seulement s'il n'est pas actif */}
                {status !== "active" && <Badge tone={DRIVER_STATUS_META[status].tone}>{DRIVER_STATUS_META[status].label}</Badge>}
              </>
            )}
            {banned && (
              <Badge tone="red">
                <ShieldBan aria-hidden className="size-3" /> Banni
              </Badge>
            )}
            {pendingApplication && <Badge tone="amber">Candidature en attente</Badge>}
            {centrale && !banned && !pendingApplication && !deleted && (
              <Badge tone={TRUST_LEVEL_META[trust].tone} dot={false}>
                {TRUST_LEVEL_META[trust].label}
              </Badge>
            )}
          </>
        }
        meta={deleted ? undefined : `${formatPhone(d.phone)} · ${d.email ?? "sans e-mail"}`}
        actions={
          // Compte supprimé : ni message, ni modification, ni document, ni changement de statut
          deleted ? undefined : (
            <>
              <Button variant="primary" asChild>
                <Link href={`/dashboard/messages?driver=${d.id}`} prefetch={false}>
                  <MessageCircle /> Message
                </Link>
              </Button>
              {/* Banni : levée d'abord ; candidat : validation par la candidature (pas d'activation directe) */}
              <DriverControls driver={{ ...d, vehicle }} canManage={canManage && !banned && !candidate} />
            </>
          )
        }
      />

      {/* overflow-x-clip : l'infobulle du graphique de gains (dernière barre) ne doit pas créer de défilement horizontal sur mobile */}
      <PageBody className="space-y-4 overflow-x-clip sm:space-y-6">
        {deleted && (
          <Callout role={null} icon={<UserX />} title={`Chauffeur supprimé${NB}: fiche anonyme conservée pour la comptabilité`}>
            Compte supprimé à la demande du chauffeur le {formatDate(d.deleted_at, tz)}. Ses courses et règlements passés restent consultables&nbsp;; la fiche ne
            peut plus être modifiée.
          </Callout>
        )}
        {banned && (
          <Callout
            tone="danger"
            role={null}
            icon={platformBan ? <Globe2 /> : <ShieldBan />}
            title={
              <>
                Banni le {formatDate(d.banned_at, tz)} à {formatTime(d.banned_at, tz)}
                {d.ban_reason ? <span className="font-normal text-fg-muted"> — motif&nbsp;: {d.ban_reason}</span> : null}
              </>
            }
            action={canManage && !platformBan ? <LiftBanButton driverId={d.id} driverName={name} model={model} /> : undefined}
          >
            <p>
              {platformBan
                ? `Banni par la plateforme Rydar${NB}: ses identités sont refusées par toutes les flottes et centrales de Rydar Drive. Contactez le support Rydar pour toute contestation.`
                : `Décision ${w.ofYour}${banner ? ` (${banner.full_name ?? banner.email})` : ""}${NB}: accès coupé, identités refusées à toute nouvelle inscription.`}
            </p>
            {identities.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Identités refusées">
                {identities.map((i) => (
                  <li key={i.id} className="inline-flex items-center gap-1.5 rounded-md border border-red/20 bg-ink-900/40 px-2 py-1 text-[12px]">
                    <span className="text-fg-muted">{IDENTITY_KIND_LABELS[i.kind]}</span>
                    <span className="num font-medium text-fg">{i.hint ?? "••••"}</span>
                  </li>
                ))}
              </ul>
            )}
            {report && (
              <p className="mt-2 text-[12.5px]">
                Signalement Rydar{NB}: <span className="text-fg">{REPORT_STATUS_FOR_ORG[report.status].label}</span>
              </p>
            )}
          </Callout>
        )}
        {pendingApplication && (
          <Callout
            tone="warning"
            role={null}
            icon={<UserPlus />}
            title={
              <>
                Candidature en attente
                {d.applied_at ? <span className="font-normal text-fg-muted"> — reçue {formatRelative(d.applied_at)}</span> : null}
              </>
            }
            action={
              canManage ? (
                <div className="flex flex-wrap gap-2">
                  <ApplicationActions
                    candidate={{ id: d.id, first_name: d.first_name, last_name: d.last_name, missing: docView.missing as DocumentType[] }}
                    newDriverMaxPriceCents={settings?.new_driver_max_price_cents ?? null}
                    trustAfterRides={settings?.trust_after_rides ?? null}
                    model={model}
                  />
                </div>
              ) : undefined
            }
          >
            Inscrit par votre lien d&apos;inscription. Vérifiez ses documents ci-dessous puis validez-le pour qu&apos;il reçoive vos courses.
          </Callout>
        )}

        {/* Quatre chiffres au plus (§ 3.3), couleur neutre */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/* Sur 30 jours (sauf le total) ; sous-titres courts : une ligne chacun sur téléphone (annulées : seulement s'il y en a) */}
          <StatCard
            label="Courses terminées (30 j)"
            value={formatNumber(s?.rides?.completed ?? 0)}
            sub={`${formatNumber(s?.rides?.completed_all_time ?? 0)} au total${s?.rides?.cancelled ? ` · ${plural(s.rides.cancelled, "annulée")}` : ""}`}
          />
          <StatCard label="Chiffre d'affaires (30 j)" value={formatPrice(s?.rides?.revenue_cents ?? 0)} sub="courses terminées" />
          <StatCard label="Taux d'acceptation" value={formatPercent(s?.offers?.acceptance_rate)} sub={plural(offers, "course proposée", "courses proposées")} />
          <StatCard
            label="Réponse moyenne"
            value={s?.offers?.avg_response_ms != null ? `${formatNumber(s.offers.avg_response_ms / 1000, 1)}${NB}s` : "—"}
            sub="pour accepter"
          />
        </div>

        <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1fr_1.2fr]">
          <Card className="flex flex-col overflow-hidden">
            <CardHeader
              title="Position et trajet des 3 dernières heures"
              icon={<MapPin />}
              description={
                location
                  ? `Mise à jour ${formatRelative(location.updated_at)}${location.battery_level != null ? ` · batterie ${Math.round(location.battery_level * 100)}${NB}%` : ""}`
                  : deleted
                    ? "Compte supprimé"
                    : "Jamais connecté"
              }
            />
            <div className="relative min-h-[240px] flex-1 sm:min-h-[340px]">
              {location ? (
                <DriverMap driver={live} trail={((trail ?? []) as { lat: number; lng: number }[]).map((p) => [p.lng, p.lat] as [number, number])} />
              ) : deleted ? (
                <EmptyState icon={<MapPin />} title="Aucune position" description="Positions et trajets effacés avec le compte." />
              ) : (
                <EmptyState icon={<MapPin />} title="Pas encore de position" description="La position apparaît dès que le chauffeur se met en ligne dans l'application." />
              )}
            </div>
          </Card>
          <div className="grid gap-4 sm:gap-6">
            <Card>
              <CardHeader title="Véhicule" icon={<Car />} />
              <CardBody className="grid grid-cols-2 gap-4 text-[13.5px] sm:grid-cols-3">
                <Spec label="Modèle">{vehicle ? `${vehicle.brand ? `${vehicle.brand} ` : ""}${vehicle.model}` : "—"}</Spec>
                <Spec label="Plaque" num>{vehicle?.plate ?? "—"}</Spec>
                <Spec label="Couleur">{vehicle?.color ?? "—"}</Spec>
                <Spec label="Catégorie">{vehicle ? VEHICLE_CATEGORY_META[vehicle.category as VehicleCategory]?.label : "—"}</Spec>
                <Spec label="Places" num>{vehicle?.seats ?? "—"}</Spec>
                <Spec label="Bagages" num>{vehicle?.luggage_capacity ?? "—"}</Spec>
              </CardBody>
            </Card>
            <DriverEarningsCard data={earnings} firstName={d.first_name} model={model} canManage={canManage} />
          </div>
        </div>

        {/* Compte supprimé : justificatifs effacés, rien à demander ni à valider */}
        {!deleted && (
          <DriverDocuments
            driverId={d.id}
            firstName={d.first_name}
            items={documents}
            missing={docView.missing}
            canReview={["owner", "admin", "dispatcher"].includes(ctx.role)}
            canAdd
          />
        )}

        <Card className="overflow-hidden">
          <CardHeader title="Historique des courses" description={history.length ? `${plural(history.length, "course attribuée", "courses attribuées")}, les plus récentes d'abord.` : undefined} />
          {!history.length ? (
            <EmptyState size="compact" title="Aucune course pour l'instant." description="Les courses qu'il accepte apparaîtront ici." />
          ) : (
            <>
              {/* Téléphone : 10 courses, puis « Afficher les 25 courses » */}
              <ShowMoreList initial={HISTORY_PHONE} moreLabel={`Afficher les ${history.length} courses`}>
                {history.map((r) => (
                  <ListCard
                    key={r.id}
                    href={`/dashboard/rides/${r.id}`}
                    aria-label={`Course ${r.number}, ${formatRideDate(r.pickup_at, tz)}`}
                    title={
                      <span className="tabular-nums">
                        #{r.number} · {formatRideDate(r.pickup_at, tz)}
                      </span>
                    }
                    status={<RideStatusBadge status={r.status} />}
                    lines={[
                      // Le trajet se tronque, jamais le prix
                      <span className="flex min-w-0 items-baseline gap-1">
                        <span className="min-w-0 truncate" title={`${r.pickup_address} → ${r.dropoff_address}`}>
                          {shortAddress(r.pickup_address)} → {shortAddress(r.dropoff_address)}
                        </span>
                        <span className="shrink-0 whitespace-nowrap">
                          · <span className="num font-medium text-fg">{formatPrice(r.price_cents)}</span>
                        </span>
                      </span>,
                    ]}
                  />
                ))}
              </ShowMoreList>
              <DesktopTable>
                <Table>
                  <THead>
                    <tr>
                      <TH>Course</TH>
                      <TH>Date</TH>
                      <TH>Trajet</TH>
                      <TH className="text-right">Prix</TH>
                      <TH>Statut</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {history.map((r) => (
                      <TR key={r.id} className="relative">
                        <TD>
                          <Link href={`/dashboard/rides/${r.id}`} prefetch={false} className="absolute inset-0" aria-label={`Course ${r.number}`} />
                          <span className="num font-semibold">#{r.number}</span>
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-fg-muted">{formatRideDate(r.pickup_at, tz)}</TD>
                        <TD className="max-w-[360px] truncate text-[13px]" title={`${r.pickup_address} → ${r.dropoff_address}`}>
                          {shortAddress(r.pickup_address)} → {shortAddress(r.dropoff_address)}
                        </TD>
                        <TD className="num whitespace-nowrap text-right font-semibold">{formatPrice(r.price_cents)}</TD>
                        <TD>
                          <RideStatusBadge status={r.status} />
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </DesktopTable>
            </>
          )}
        </Card>

        {/* En bas de page : confiance (centrale), inscription, bannissement (propriétaire et administrateur seulement) */}
        <Card>
          <CardHeader
            title={centrale ? "Confiance & sécurité" : "Sécurité"}
            icon={<ShieldCheck />}
            description={
              centrale
                ? canManage
                  ? "Niveau de confiance dans votre réseau, inscription et bannissement définitif."
                  : "Niveau de confiance dans votre réseau et inscription."
                : canManage
                  ? "Inscription du compte et bannissement définitif."
                  : "Inscription du compte."
            }
          />
          <div
            className={cn(
              "grid divide-y divide-line md:divide-x md:divide-y-0",
              securityColumns === 3 ? "md:grid-cols-3" : securityColumns === 2 ? "md:grid-cols-2" : "md:grid-cols-1",
            )}
          >
            {centrale && (
              <div className="space-y-2.5 p-5">
                <p className="text-[12.5px] font-medium text-fg-muted">Niveau de confiance</p>
                <TrustLevelControl
                  driverId={d.id}
                  value={trust}
                  canManage={canManage}
                  lockedReason={deleted ? `Chauffeur supprimé${NB}: niveau figé.` : banned ? `Chauffeur banni${NB}: niveau figé.` : null}
                />
                {trust === "new" && (settings?.new_driver_max_price_cents != null || settings?.trust_after_rides) ? (
                  <p className="text-[12px] text-fg-muted">
                    {settings?.new_driver_max_price_cents != null && (
                      <>
                        Plafond actuel&nbsp;: <span className="num text-fg">{formatPrice(settings.new_driver_max_price_cents)}</span>.{" "}
                      </>
                    )}
                    {settings?.trust_after_rides ? <>Confirmé automatiquement après {settings.trust_after_rides} courses réglées.</> : null}
                  </p>
                ) : null}
              </div>
            )}
            <div className="space-y-2 p-5 text-[13px]">
              <p className="text-[12.5px] font-medium text-fg-muted">Inscription</p>
              {d.joined_via === "join_link" ? (
                <p className="flex items-start gap-2">
                  <Link2 aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                  <span>Inscrit par le lien d&apos;inscription{d.applied_at ? <> le <span className="num">{formatDate(d.applied_at, tz)}</span></> : null}</span>
                </p>
              ) : (
                <p className="text-fg-muted">Créé depuis le tableau de bord{d.created_at ? <> le <span className="num">{formatDate(d.created_at, tz)}</span></> : null}.</p>
              )}
              {d.application_status === "approved" && (
                <p className="text-[12.5px] text-fg-muted">
                  Candidature validée{d.application_reviewed_at ? ` le ${formatDate(d.application_reviewed_at, tz)}` : ""}
                  {reviewer ? ` par ${reviewer.full_name ?? reviewer.email}` : d.application_reviewed_at && !d.application_reviewed_by ? " (validation automatique)" : ""}.
                </p>
              )}
              {d.application_status === "rejected" && (
                <p className="text-[12.5px] text-red">
                  Candidature refusée{d.application_reviewed_at ? ` le ${formatDate(d.application_reviewed_at, tz)}` : ""}
                  {d.application_note ? ` — ${d.application_note}` : ""}.
                </p>
              )}
              {d.application_message && (
                <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[12.5px] leading-relaxed text-fg">«&nbsp;{d.application_message}&nbsp;»</p>
              )}
            </div>
            {canManage && (
              <div className="space-y-2.5 p-5">
                <p className="text-[12.5px] font-medium text-fg-muted">Bannissement définitif</p>
                {banned ? (
                  <p className="text-[13px] text-red">Banni le {formatDate(d.banned_at, tz)}{platformBan ? " par la plateforme Rydar" : ""}.</p>
                ) : deleted ? (
                  <p className="text-[12.5px] text-fg-muted">Compte supprimé{NB}: identité effacée, bannissement impossible.</p>
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-fg-muted">
                      {centrale ? "Arnaque, commissions jamais réglées, faux documents" : "Fraude, faux documents"}
                      {NB}: ses identifiants connus seront refusés à toute nouvelle inscription dans {w.your}.
                    </p>
                    <BanDriverButton driverId={d.id} driverName={name} plate={vehicle?.plate ?? null} model={model} />
                  </>
                )}
              </div>
            )}
          </div>
        </Card>
      </PageBody>
    </>
  );
}
