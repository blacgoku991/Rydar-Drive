import {
  DRIVER_STATUS_META, IDENTITY_KIND_LABELS, TRUST_LEVEL_META, VEHICLE_CATEGORY_META, formatDate, formatPercent, formatPhone, formatPrice,
  formatRelative, formatRideDate, formatTime, shortAddress,
  type DocumentType, type DriverStatus, type FraudReport, type IdentityKind, type TrustLevel, type VehicleCategory,
} from "@rydar/shared";
import { ArrowLeft, Car, Globe2, Link2, MapPin, MessageCircle, ShieldBan, ShieldCheck, UserPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DriverControls } from "@/components/drivers/driver-controls";
import { DriverDocuments } from "@/components/drivers/driver-documents";
import { DriverEarningsCard } from "@/components/drivers/driver-earnings";
import { DriverMap } from "@/components/drivers/driver-map";
import { DOCUMENT_COLUMNS, buildDocumentView, fileKind, type DocumentRow, type DocumentView } from "@/components/drivers/documents";
import { computeDriverEarnings, earningsWindow, type EarningRide } from "@/components/drivers/earnings";
import { PageBody, StatCard } from "@/components/layout/page-header";
import { ApplicationActions } from "@/components/network/applications";
import { BanDriverButton, LiftBanButton, TrustLevelControl } from "@/components/network/driver-safety";
import { IDENTITY_ORDER, REPORT_STATUS_FOR_ORG } from "@/components/network/labels";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { PresenceBadge, RideStatusBadge } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { LiveDriver } from "@/lib/queries/live";

export const metadata: Metadata = { title: "Chauffeur" };
export const dynamic = "force-dynamic";

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

export default async function DriverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrg();
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
  const centrale = ctx.org.dispatch_model === "centrale";
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
  const platformBan = d.ban_scope === "platform";
  const pendingApplication = d.application_status === "pending" && !banned;
  const candidate = d.application_status === "pending" || d.application_status === "rejected";
  const trust = (d.trust_level ?? "trusted") as TrustLevel;
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

  return (
    <>
      <LiveRefresh events={["driver.updated"]} pollMs={15000} />
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-6 lg:px-10">
          <div>
            <Link href="/dashboard/drivers" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg">
              <ArrowLeft className="size-3.5" /> Chauffeurs
            </Link>
            <div className="flex items-center gap-4">
              <Avatar name={`${d.first_name} ${d.last_name}`} src={d.photo_url} size={56} />
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[26px] font-semibold tracking-tight">{d.first_name} {d.last_name}</h1>
                  <span className="num text-[14px] text-fg-subtle">#{d.number}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <PresenceBadge presence={d.presence} />
                  <Badge tone={DRIVER_STATUS_META[d.status as DriverStatus].tone}>{DRIVER_STATUS_META[d.status as DriverStatus].label}</Badge>
                  {banned && <Badge tone="red"><ShieldBan className="size-3" /> Banni</Badge>}
                  {pendingApplication && <Badge tone="amber" pulse>Candidature en attente</Badge>}
                  {centrale && !banned && !pendingApplication && <Badge tone={TRUST_LEVEL_META[trust].tone} dot={false}>{TRUST_LEVEL_META[trust].label}</Badge>}
                  <span className="text-[12.5px] text-fg-subtle">{formatPhone(d.phone)} · {d.email}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" asChild>
              <Link href={`/dashboard/messages?driver=${d.id}`}>
                <MessageCircle /> Message
              </Link>
            </Button>
            {/* Banni : levée d'abord ; candidat : validation par la candidature (pas d'activation directe) */}
            <DriverControls driver={{ ...d, vehicle }} canManage={canManage && !banned && !candidate} />
          </div>
        </div>
      </div>

      {/* overflow-x-clip : l'infobulle du graphique de gains (dernière barre) ne doit pas créer de défilement horizontal sur mobile */}
      <PageBody className="space-y-6 overflow-x-clip">
        {banned && (
          <section aria-label="Bannissement" className="flex flex-col gap-4 rounded-xl border border-red/30 bg-red/[0.07] px-5 py-4 md:flex-row md:items-start">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-red/30 bg-red/10 text-red">
              {platformBan ? <Globe2 className="size-5" /> : <ShieldBan className="size-5" />}
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-[15px] font-semibold text-red">
                Banni le {formatDate(d.banned_at, tz)} à {formatTime(d.banned_at, tz)}
                {d.ban_reason ? <span className="font-normal text-fg"> — motif : {d.ban_reason}</span> : null}
              </p>
              <p className="text-[12.5px] text-fg-muted">
                {platformBan
                  ? "Banni par la plateforme Rydar : ses identités sont refusées dans toutes les centrales. Contactez le support Rydar pour toute contestation."
                  : `Décision de votre centrale${banner ? ` (${banner.full_name ?? banner.email})` : ""} : accès coupé, identités refusées à toute nouvelle inscription.`}
              </p>
              {identities.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Identités refusées">
                  {identities.map((i) => (
                    <li key={i.id} className="inline-flex items-center gap-1.5 rounded-md border border-red/20 bg-ink-900/40 px-2 py-1 text-[11.5px]">
                      <span className="text-fg-subtle">{IDENTITY_KIND_LABELS[i.kind]}</span>
                      <span className="num font-medium text-fg">{i.hint ?? "••••"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {report && <p className="text-[12px] text-fg-subtle">Signalement Rydar : <span className="text-fg-muted">{REPORT_STATUS_FOR_ORG[report.status].label}</span></p>}
            </div>
            {canManage && !platformBan && (
              <div className="shrink-0">
                <LiftBanButton driverId={d.id} driverName={name} />
              </div>
            )}
          </section>
        )}
        {pendingApplication && (
          <section aria-label="Candidature" className="flex flex-col gap-4 rounded-xl border border-amber/30 bg-amber/[0.06] px-5 py-4 md:flex-row md:items-center">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-amber/30 bg-amber/10 text-amber">
              <UserPlus className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14.5px] font-semibold">Candidature en attente{d.applied_at ? <span className="font-normal text-fg-muted"> — reçue {formatRelative(d.applied_at)}</span> : null}</p>
              <p className="mt-0.5 text-[12.5px] text-fg-muted">
                Inscrit par votre lien d&apos;inscription. Vérifiez ses documents ci-dessous puis validez-le pour qu&apos;il reçoive vos courses.
              </p>
            </div>
            {canManage && (
              <div className="flex shrink-0 flex-wrap gap-2">
                <ApplicationActions
                  candidate={{ id: d.id, first_name: d.first_name, last_name: d.last_name, missing: docView.missing as DocumentType[] }}
                  newDriverMaxPriceCents={settings?.new_driver_max_price_cents ?? null}
                  trustAfterRides={settings?.trust_after_rides ?? null}
                />
              </div>
            )}
          </section>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Taux d'acceptation" value={formatPercent(s?.offers?.acceptance_rate)} sub={`${s?.offers?.offers ?? 0} offres · 30 j`} tone="brand" />
          <StatCard label="Courses terminées" value={s?.rides?.completed ?? 0} sub={`${s?.rides?.completed_all_time ?? 0} au total`} />
          <StatCard label="Annulées" value={s?.rides?.cancelled ?? 0} sub="30 derniers jours" />
          <StatCard label="CA généré" value={formatPrice(s?.rides?.revenue_cents ?? 0)} sub="30 derniers jours" tone="cyan" />
          <StatCard label="Réponse moyenne" value={s?.offers?.avg_response_ms != null ? `${(s.offers.avg_response_ms / 1000).toFixed(1)} s` : "—"} sub="pour accepter" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
          <Card className="flex flex-col overflow-hidden">
            <CardHeader title="Position et trajet des 3 dernières heures" icon={<MapPin />} description={location ? `Mise à jour ${formatRelative(location.updated_at)}${location.battery_level != null ? ` · batterie ${Math.round(location.battery_level * 100)} %` : ""}` : "Jamais connecté"} />
            <div className="relative min-h-[340px] flex-1">{location ? <DriverMap driver={live} trail={((trail ?? []) as { lat: number; lng: number }[]).map((p) => [p.lng, p.lat] as [number, number])} /> : <EmptyState icon={<MapPin />} title="Pas encore de position" description="La position apparaît dès que le chauffeur passe EN LIGNE." />}</div>
          </Card>
          <div className="grid gap-6">
            <Card>
              <CardHeader title="Véhicule" icon={<Car />} />
              <CardBody className="grid grid-cols-2 gap-4 text-[13.5px] sm:grid-cols-3">
                <div><p className="text-[11.5px] text-fg-subtle">Modèle</p><p>{vehicle ? `${vehicle.brand ?? ""} ${vehicle.model}` : "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Plaque</p><p className="num">{vehicle?.plate ?? "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Couleur</p><p>{vehicle?.color ?? "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Catégorie</p><p>{vehicle ? VEHICLE_CATEGORY_META[vehicle.category as VehicleCategory]?.label : "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Places</p><p className="num">{vehicle?.seats ?? "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Bagages</p><p className="num">{vehicle?.luggage_capacity ?? "—"}</p></div>
              </CardBody>
            </Card>
            <DriverEarningsCard data={earnings} firstName={d.first_name} />
          </div>
        </div>

        <Card>
          <CardHeader
            title={centrale ? "Confiance & sécurité" : "Sécurité"}
            icon={<ShieldCheck />}
            description={centrale ? "Niveau de confiance dans votre réseau, inscription et bannissement définitif." : "Inscription du compte et bannissement définitif."}
          />
          <div className={cn("grid divide-y divide-line md:divide-x md:divide-y-0", centrale ? "md:grid-cols-3" : "md:grid-cols-2")}>
            {centrale && (
              <div className="space-y-2.5 p-5">
                <p className="text-[12.5px] font-medium text-fg-muted">Niveau de confiance</p>
                <TrustLevelControl driverId={d.id} value={trust} canManage={canManage} lockedReason={banned ? "Chauffeur banni : niveau figé." : null} />
                {trust === "new" && (settings?.new_driver_max_price_cents != null || settings?.trust_after_rides) ? (
                  <p className="text-[12px] text-fg-subtle">
                    {settings?.new_driver_max_price_cents != null && <>Plafond actuel : <span className="num text-fg-muted">{formatPrice(settings.new_driver_max_price_cents)}</span>. </>}
                    {settings?.trust_after_rides ? <>Confirmé automatiquement après {settings.trust_after_rides} courses réglées.</> : null}
                  </p>
                ) : null}
              </div>
            )}
            <div className="space-y-2 p-5 text-[13px]">
              <p className="text-[12.5px] font-medium text-fg-muted">Inscription</p>
              {d.joined_via === "join_link" ? (
                <p className="flex items-start gap-2">
                  <Link2 className="mt-0.5 size-4 shrink-0 text-brand" />
                  <span>Inscrit par le lien d&apos;inscription{d.applied_at ? <> le <span className="num">{formatDate(d.applied_at, tz)}</span></> : null}</span>
                </p>
              ) : (
                <p className="text-fg-muted">Compte créé depuis le tableau de bord{d.created_at ? <> le <span className="num">{formatDate(d.created_at, tz)}</span></> : null}.</p>
              )}
              {d.application_status === "approved" && (
                <p className="text-[12.5px] text-fg-muted">
                  Candidature validée{d.application_reviewed_at ? ` le ${formatDate(d.application_reviewed_at, tz)}` : ""}
                  {reviewer ? ` par ${reviewer.full_name ?? reviewer.email}` : d.application_reviewed_at && !d.application_reviewed_by ? " (validation automatique)" : ""}.
                </p>
              )}
              {d.application_status === "rejected" && (
                <p className="text-[12.5px] text-red/90">
                  Candidature refusée{d.application_reviewed_at ? ` le ${formatDate(d.application_reviewed_at, tz)}` : ""}
                  {d.application_note ? ` — ${d.application_note}` : ""}.
                </p>
              )}
              {d.application_message && (
                <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[12.5px] leading-relaxed text-fg">« {d.application_message} »</p>
              )}
            </div>
            <div className="space-y-2.5 p-5">
              <p className="text-[12.5px] font-medium text-fg-muted">Bannissement définitif</p>
              {banned ? (
                <p className="text-[13px] text-red">Banni le {formatDate(d.banned_at, tz)}{platformBan ? " par la plateforme Rydar" : ""}.</p>
              ) : (
                <>
                  <p className="text-[12.5px] leading-relaxed text-fg-subtle">
                    Arnaque, commissions jamais réglées, faux documents : il ne pourra plus revenir, même avec un nouveau compte ou un autre numéro.
                  </p>
                  {canManage ? (
                    <BanDriverButton driverId={d.id} driverName={name} plate={vehicle?.plate ?? null} />
                  ) : (
                    <p className="text-[11.5px] text-fg-subtle">Réservé aux administrateurs.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </Card>

        <DriverDocuments
          driverId={d.id}
          firstName={d.first_name}
          items={documents}
          missing={docView.missing}
          canReview={["owner", "admin", "dispatcher"].includes(ctx.role)}
        />

        <Card className="overflow-hidden">
          <CardHeader title="Historique des courses" description="25 dernières courses attribuées." />
          {!rides?.length ? (
            <EmptyState title="Aucune course" description="Les courses acceptées apparaîtront ici." />
          ) : (
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
                {rides.map((r: any) => (
                  <TR key={r.id} className="relative">
                    <TD><Link href={`/dashboard/rides/${r.id}`} className="absolute inset-0" aria-label={`Course ${r.number}`} /><span className="num font-semibold">#{r.number}</span></TD>
                    <TD className="text-[13px] text-fg-muted">{formatRideDate(r.pickup_at, tz)}</TD>
                    <TD className="max-w-[360px] truncate text-[13px]">{shortAddress(r.pickup_address)} → {shortAddress(r.dropoff_address)}</TD>
                    <TD className="num text-right font-semibold">{formatPrice(r.price_cents)}</TD>
                    <TD><RideStatusBadge status={r.status} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  );
}
