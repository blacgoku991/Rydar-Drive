import {
  DRIVER_STATUS_META, OFFER_STATUS_META, PAYMENT_METHOD_LABELS, RIDE_SOURCE_LABELS, VEHICLE_CATEGORY_META, canAssign, canCancel, canRedispatch,
  formatDistance, formatDuration, formatNumber, formatPhone, formatPrice, formatTime, networkCancelBlocked,
  type DriverStatus, type OfferStatus, type OrgNetworkRide, type PaymentMethod, type RideSource, type RideStatus, type VehicleCategory,
} from "@rydar/shared";
import { ArrowLeftRight, BellRing, Car, Clock, Luggage, MessageSquareText, Phone, Plane, Radar, Users, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { assignableDrivers } from "@/components/rides/assignable";
import { RideAlertList, type RideAlertRow } from "@/components/rides/ride-alert-list";
import { FlightChip, FlightDetails, PickupTime } from "@/components/rides/flight-info";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { RideActions } from "@/components/rides/ride-actions";
import { RideMap } from "@/components/rides/ride-map";
import { RideProgress } from "@/components/rides/ride-progress";
import { RideTimeline, type TimelineEvent } from "@/components/rides/ride-timeline";
import { RideStatusBadge, RideTypeTag } from "@/components/rides/status";
import { RideNetworkCard } from "@/components/network-share/ride-network-card";
import { networkLockMessage, partnerOrgOf, partnerTag, proposedToNetwork, rideTouchesNetwork } from "@/components/network-share/ride-network";
import { RideMoneyCard, type RideMoneyRide, type SettlementRow } from "@/components/settlements/ride-money";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { PrivateBookingDetail } from "@/components/private-fleet/booking-detail";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { cn } from "@/lib/utils";
import type { LiveDriver, LiveOffer, LiveRide } from "@/lib/queries/live";
import { plural } from "@/lib/wording";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await requireOrg();
  return { title: isPrivateFleet(ctx.org) ? "Réservation" : "Course" };
}

const DRIVER_COLUMNS =
  "id, number, first_name, last_name, phone, photo_url, presence, status, current_ride_id, online_since, vehicle:vehicles(brand, model, plate, color, category, seats), location:driver_locations(lat, lng, heading, speed_mps, updated_at)";
/** Course attribuée pas encore terminée : un chauffeur qui n'est plus actif ne peut plus la faire avancer. */
const DRIVER_STUCK = new Set(["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]);
/** Course close : sans temps réel, le sondage peut s'espacer jusqu'à 60 s ; sinon 30 s au plus. */
const CLOSED = new Set(["COMPLETED", "CANCELLED"]);

/**
 * Information de la fiche : un mot ne se coupe que s'il ne tient pas seul sur sa ligne (break-words : « Famille
 * Nakamura » passe à la ligne entre les mots, jamais « Nakamur / a »). Les adresses, hors Info, gardent leur coupure
 * partout ([overflow-wrap:anywhere]).
 */
function Info({ icon, label, children, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-subtle [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-[12px] text-fg-muted">{label}</p>
        <div className="break-words text-[13.5px] text-fg">{children}</div>
      </div>
    </div>
  );
}

export default async function RidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrg();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  // Flotte Privée : fiche épurée (Je la prends, Refuser, Annuler, Modifier le prix ; ni attribution, ni relance, ni
  // réseau, ni règlement)
  if (isPrivateFleet(ctx.org)) return <PrivateBookingDetail ctx={ctx} id={id} />;

  const centrale = ctx.org.dispatch_model === "centrale";
  // Course et données liées en un seul aller-retour : toutes ne dépendent que de l'id de l'URL (filtrées aussi par
  // centrale, sous RLS) ; rien n'est affiché si la course n'est pas celle de la centrale (notFound ci-dessous)
  const [{ data: ride }, events, offers, drivers, alerts, settlement] = await Promise.all([
    ctx.supabase.from("rides").select("*").eq("id", id).eq("organization_id", ctx.org.id).maybeSingle(),
    ctx.supabase
      .from("ride_events")
      .select("id, category, level, type, message, actor_type, data, created_at")
      .eq("ride_id", id)
      .eq("organization_id", ctx.org.id)
      .order("id"),
    ctx.supabase
      .from("ride_offers")
      .select("id, driver_id, status, mode, wave, radius_m, distance_m, sent_at, responded_at, expires_at, closed_reason")
      .eq("ride_id", id)
      .eq("organization_id", ctx.org.id)
      .order("sent_at"),
    ctx.supabase.from("drivers").select(DRIVER_COLUMNS).eq("organization_id", ctx.org.id).eq("status", "active"),
    // Alertes de suivi (retard, immobile, GPS muet, pas démarrée), les plus récentes d'abord
    ctx.supabase
      .from("ride_alerts")
      .select("id, ride_id, driver_id, kind, severity, message, data, status, resolution, muted_until, created_at, updated_at, resolved_at")
      .eq("ride_id", id)
      .eq("organization_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .limit(12),
    // Mode centrale : règlement de fin de course (commission due / part à verser)
    centrale
      ? ctx.supabase.from("ride_settlements").select("*").eq("ride_id", id).eq("organization_id", ctx.org.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!ride) notFound();
  // Réseau partagé : course tenue par le chauffeur d'une autre organisation, proposée au réseau, ou passée par lui
  // (journal). Jamais lu pour une course qui n'a pas touché le réseau (interrupteur coupé : rien ne change).
  const partnerOrg = partnerOrgOf(ride, ctx.org.id);
  const networkTouched = rideTouchesNetwork(ride, ctx.org.id, ((events.data ?? []) as { type: string }[]).map((e) => e.type));
  const [network, rideDriver] = await Promise.all([
    networkTouched ? ctx.supabase.rpc("org_network_ride", { p_ride: id }) : Promise.resolve(null),
    // Chauffeur de la course même s'il n'est plus actif (suspendu, désactivé) : la liste ci-dessus ne garde que les
    // actifs ; lu seulement dans ce cas (rare). Chauffeur partenaire : fiche illisible ici (bloc « Réseau partagé »)
    ride.driver_id && !partnerOrg && !((drivers.data ?? []) as { id: string }[]).some((d) => d.id === ride.driver_id)
      ? ctx.supabase.from("drivers").select(DRIVER_COLUMNS).eq("id", ride.driver_id).eq("organization_id", ctx.org.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const networkData = (network && !network.error ? (network.data ?? null) : null) as OrgNetworkRide | null;
  const networkFailed = !!network?.error;
  // Course non proposée (sans prix, sans part chauffeur, aucun partenaire proche…) : dernier motif du journal
  const networkSkipped =
    ((events.data ?? []) as { type: string; message: string }[]).findLast((e) => e.type === "dispatch.network_skipped")?.message ?? null;
  const partnerExecution = partnerOrg ? (networkData?.execution ?? null) : null;
  const partnerName = partnerExecution?.partner.name ?? (partnerOrg && networkData?.operator ? networkData.operator.name : null);
  const networkLock = networkLockMessage(ride, ctx.org.id);

  const driverRows = [...((drivers.data ?? []) as any[])];
  if (rideDriver.data && !driverRows.some((d) => d.id === ride.driver_id)) driverRows.push(rideDriver.data);
  const allDrivers = driverRows.map((d) => ({
    ...d,
    vehicle: Array.isArray(d.vehicle) ? d.vehicle[0] ?? null : d.vehicle,
    location: Array.isArray(d.location) ? d.location[0] ?? null : d.location,
  })) as LiveDriver[];
  const byId = new Map(allDrivers.map((d) => [d.id, d]));
  const offerRows = (offers.data ?? []) as any[];
  const involved = new Set<string>([...offerRows.filter((o) => o.status === "pending").map((o) => o.driver_id), ...(ride.driver_id ? [ride.driver_id] : [])]);
  const mapDrivers = allDrivers.filter((d) => involved.has(d.id));
  const driver = ride.driver_id && !partnerOrg ? byId.get(ride.driver_id) : undefined;
  const status = ride.status as RideStatus;
  const driverStuck = !!driver && driver.status !== "active" && DRIVER_STUCK.has(status);
  const tz = ctx.org.timezone;

  // Même liste que le panneau d'En direct : disponibles, occupés, hors ligne (replié), chacun du plus proche au plus loin
  const assignable = assignableDrivers(allDrivers, ride);
  const alertRows = (alerts.data ?? []) as RideAlertRow[];

  return (
    <>
      <LiveRefresh
        rideId={id}
        events={["ride.updated", "ride.event", "offer.updated", "ride.alert", "settlement.updated", "network.updated"]}
        maxPollMs={CLOSED.has(status) ? 60_000 : 30_000}
      />
      <PageHeader
        back={{ href: "/dashboard/rides", label: "Courses" }}
        title={`Course #${ride.number}`}
        badges={
          <>
            <RideStatusBadge status={status} />
            <RideTypeTag type={ride.type} />
            {ride.flight_number && <FlightChip ride={ride} timeZone={tz} className="h-[22px] rounded-full px-2 text-[12px]" />}
            <Badge tone="neutral" dot={false}>
              {RIDE_SOURCE_LABELS[ride.source as RideSource] ?? ride.source}
            </Badge>
            {partnerOrg ? (
              <Badge tone="violet" dot={false}>
                <ArrowLeftRight aria-hidden className="size-3" /> {partnerTag(partnerName)}
              </Badge>
            ) : proposedToNetwork(ride) ? (
              <Badge tone="violet">Proposée au réseau partagé</Badge>
            ) : null}
          </>
        }
        meta={
          <>
            <PickupTime ride={ride} timeZone={tz} withDate /> · {ride.customer_name}
          </>
        }
        actions={
          <RideActions
            rideId={ride.id}
            number={ride.number}
            // Client à bord d'un chauffeur partenaire : annulation refusée par la base (« Clôturer la course » seulement)
            canCancel={canCancel(status) && !networkCancelBlocked(status, !!partnerOrg)}
            canRedispatch={canRedispatch(status) && !ride.driver_id}
            canAssign={canAssign(status) || status === "DRIVER_EN_ROUTE" || status === "DRIVER_ARRIVED"}
            assignLabel={ride.driver_id ? "Réattribuer" : "Attribuer"}
            // Attribution manuelle : vos chauffeurs seulement ; un chauffeur partenaire est prévenu du retrait
            assignDescription={
              partnerOrg
                ? `Le chauffeur partenaire${partnerName ? ` (${partnerName})` : ""} est prévenu que la course lui est retirée ; votre chauffeur reçoit immédiatement une notification.`
                : undefined
            }
            drivers={assignable}
          />
        }
      />

      {/* Grand écran : deux colonnes. En dessous : une seule colonne, rangée par `order` (les deux colonnes sont
          « contents ») : alertes de suivi, trajet, répartition et règlement, vol, puis le reste et la chronologie */}
      <PageBody className="flex flex-col gap-6 xl:grid xl:grid-cols-[1.35fr_1fr] xl:items-start">
        <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-6">
          <Card className="order-2 min-w-0 overflow-hidden xl:order-none">
            <div className="border-b border-line px-5 py-4">
              <RideProgress ride={ride} timeZone={tz} />
            </div>
            <div className="relative h-[280px] sm:h-[360px] xl:h-[420px]">
              <RideMap ride={ride as LiveRide} drivers={mapDrivers} offers={offerRows.filter((o) => o.status === "pending").map((o) => ({ ...o, ride_id: id })) as LiveOffer[]} />
            </div>
            <div className="grid gap-5 border-t border-line p-5 sm:grid-cols-2">
              <div className="flex gap-3">
                <div aria-hidden className="flex flex-col items-center pt-1.5">
                  <span className="size-2.5 rounded-full bg-brand ring-4 ring-brand/15" />
                  <span className="my-1 w-px flex-1 bg-line-strong" />
                  <span className="size-2.5 rounded-[2px] bg-fg ring-4 ring-white/10" />
                </div>
                <div className="min-w-0 space-y-4">
                  <div>
                    <p className="text-[12px] text-fg-muted">Départ</p>
                    <p className="text-[14px] font-medium [overflow-wrap:anywhere]">{ride.pickup_address}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-fg-muted">Destination</p>
                    <p className="text-[14px] font-medium [overflow-wrap:anywhere]">{ride.dropoff_address}</p>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Info icon={<Clock />} label="Prise en charge">
                  <PickupTime ride={ride} timeZone={tz} withDate />
                </Info>
                <Info icon={<Radar />} label="Trajet estimé">
                  {formatDistance(ride.estimated_distance_m)}{"\u00a0·"} {formatDuration(ride.estimated_duration_s)}
                </Info>
                <Info icon={<Wallet />} label="Prix">
                  {/* Prix et séparateur insécables, moyen de paiement d'un bloc : jamais « Carte à / bord » ni « · » en
                      début de ligne */}
                  <span className="num whitespace-nowrap font-semibold">{formatPrice(ride.price_cents)}</span>
                  <span className="text-fg-muted">{"\u00a0·"}</span>{" "}
                  <span className="whitespace-nowrap text-fg-muted">{PAYMENT_METHOD_LABELS[ride.payment_method as PaymentMethod]}</span>
                  {centrale && ride.driver_payout_cents != null && (
                    <span className="block text-[12px] text-fg-muted">
                      dont <span className="mono text-fg">{formatPrice(ride.driver_payout_cents)}</span> pour le chauffeur
                    </span>
                  )}
                </Info>
                <Info icon={<Car />} label="Catégorie">
                  {VEHICLE_CATEGORY_META[ride.vehicle_category as VehicleCategory]?.label}
                </Info>
              </div>
            </div>
          </Card>

          {networkTouched && (
            <div className="order-5 min-w-0 xl:order-none">
              <RideNetworkCard
                ride={{
                  id: ride.id,
                  number: ride.number,
                  type: ride.type,
                  status,
                  pickup_at: ride.pickup_at,
                  completed_at: ride.completed_at ?? null,
                  pickup_address: ride.pickup_address,
                  dropoff_address: ride.dropoff_address,
                  customer_name: ride.customer_name,
                  currency: ride.currency ?? "EUR",
                  driver_id: ride.driver_id ?? null,
                }}
                data={networkData}
                failed={networkFailed}
                skipped={networkSkipped}
                canManage={isAdminRole(ctx.role)}
                timeZone={tz}
                serverNow={Date.now()}
              />
            </div>
          )}

          <div className="order-5 grid min-w-0 gap-6 lg:grid-cols-2 xl:order-none">
            <Card>
              <CardHeader title="Client" />
              {/* Nom et numéro sur toute la largeur de la carte quand elle est étroite (téléphone, et à partir de lg où elle
                  partage la ligne avec « Chauffeur ») ; numéro jamais coupé ; passagers et bagages côte à côte */}
              <CardBody className="grid grid-cols-2 gap-4">
                <Info icon={<Users />} label="Nom" className="col-span-2 sm:col-span-1 lg:col-span-2">
                  {ride.customer_name}
                </Info>
                <Info icon={<Phone />} label="Téléphone" className="col-span-2 sm:col-span-1 lg:col-span-2">
                  <a href={`tel:${ride.customer_phone}`} className="whitespace-nowrap hover:text-brand">
                    {formatPhone(ride.customer_phone)}
                  </a>
                </Info>
                <Info icon={<Users />} label="Passagers">
                  {ride.passengers}
                </Info>
                <Info icon={<Luggage />} label="Bagages">
                  {ride.luggage}
                </Info>
                {/* Vol : carte « Vol suivi » (plus de ligne en double ici) */}
                {ride.comment && (
                  <div className="col-span-2">
                    <Info icon={<MessageSquareText />} label="Note pour le chauffeur">
                      {ride.comment}
                    </Info>
                  </div>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Chauffeur" description={ride.driver_id ? "Attribué à la course" : "Pas encore attribuée"} />
              <CardBody>
                {driver ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={`${driver.first_name} ${driver.last_name}`} size={44} />
                      <div className="min-w-0">
                        <Link href={`/dashboard/drivers/${driver.id}`} prefetch={false} className="text-[15px] font-semibold hover:text-brand">
                          {driver.first_name} {driver.last_name}
                        </Link>
                        <p className="text-[12.5px] text-fg-muted">
                          Chauffeur #{driver.number} · {formatPhone(driver.phone)}
                        </p>
                      </div>
                    </div>
                    {driverStuck && (
                      <Callout tone="danger">
                        Chauffeur {(DRIVER_STATUS_META[driver.status as DriverStatus]?.label ?? "inactif").toLowerCase()}&nbsp;: il ne peut plus faire
                        avancer la course.{" "}
                        {status === "PASSENGER_ONBOARD" || status === "IN_PROGRESS"
                          ? "Réactivez-le pour qu'il la termine, ou annulez-la."
                          : "Réattribuez-la à un autre chauffeur ou réactivez-le."}
                      </Callout>
                    )}
                    {driver.vehicle && (
                      <div className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5 text-[13px]">
                        {driver.vehicle.brand} {driver.vehicle.model} · <span className="num">{driver.vehicle.plate}</span>
                        <span className="text-fg-muted"> · {driver.vehicle.color}</span>
                      </div>
                    )}
                    {ride.accepted_at && ride.dispatch_started_at && (
                      <p className="text-[12.5px] text-fg-muted">
                        Attribuée en{" "}
                        <span className="num text-fg">
                          {formatDuration((new Date(ride.accepted_at).getTime() - new Date(ride.dispatch_started_at).getTime()) / 1000)}
                        </span>{" "}
                        à {formatTime(ride.accepted_at, tz, true)}
                      </p>
                    )}
                  </div>
                ) : partnerOrg ? (
                  <div className="space-y-1.5">
                    <p className="text-[15px] font-semibold">
                      {partnerExecution?.driver_label ?? "Chauffeur partenaire"}
                      {partnerName && <span className="font-normal text-violet"> · {partnerName}</span>}
                    </p>
                    <p className="text-[12.5px] text-fg-muted">
                      Chauffeur d&apos;une organisation partenaire (réseau partagé)&nbsp;: contact, véhicule et contrôles dans le bloc «&nbsp;Réseau partagé&nbsp;».
                    </p>
                  </div>
                ) : (
                  <p className="text-[13px] text-fg-muted">
                    {ride.driver_id
                      ? "Fiche du chauffeur indisponible."
                      : status === "NO_DRIVER_FOUND"
                        ? "Aucun chauffeur n'a accepté. Relancez la recherche ou attribuez la course à un chauffeur."
                        : proposedToNetwork(ride)
                          ? "Aucun de vos chauffeurs n'a accepté : la course est proposée aux chauffeurs partenaires proches. Vos chauffeurs restent prioritaires."
                          : "Recherche en cours : le premier chauffeur qui accepte obtient la course."}
                  </p>
                )}
              </CardBody>
            </Card>
          </div>

          <Card className="order-5 min-w-0 xl:order-none">
            <CardHeader title="Offres envoyées" description="Chauffeurs prévenus, distance au départ et réponse." />
            <div className="divide-y divide-line">
              {offerRows.length === 0 && !networkData?.share?.partners_offered && (
                <p className="px-5 py-6 text-[13px] text-fg-muted">Aucune offre envoyée pour le moment.</p>
              )}
              {offerRows.map((o) => {
                const d = byId.get(o.driver_id);
                const meta = OFFER_STATUS_META[o.status as OfferStatus] ?? { label: o.status, tone: "neutral" as const };
                const response = o.responded_at ? (new Date(o.responded_at).getTime() - new Date(o.sent_at).getTime()) / 1000 : null;
                const answered = response != null && o.status === "accepted" ? `${formatNumber(Math.max(0, response), 1)}\u00a0s` : null;
                const name = d ? `${d.first_name} ${d.last_name}` : "Chauffeur";
                const how = `${o.mode === "fleet" ? "Toute la flotte" : `Vague ${o.wave} · rayon ${formatDistance(o.radius_m)}`} · envoyée ${formatTime(o.sent_at, tz, true)}`;
                return (
                  <div key={o.id} className="flex items-center gap-3 px-5 py-3 sm:gap-4">
                    <Avatar name={d ? name : "?"} size={30} />
                    <div className="min-w-0 flex-1">
                      {/* Téléphone : nom et état, puis le détail sur une seconde ligne (plus de colonnes écrasées) */}
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-[13px] font-medium">{name}</p>
                        <Badge tone={meta.tone} className="shrink-0 sm:hidden">
                          {meta.label}
                        </Badge>
                      </div>
                      <p className="text-[12px] text-fg-muted">
                        {how}
                        <span className="sm:hidden">
                          {" "}
                          · {formatDistance(o.distance_m)}
                          {answered ? ` · réponse en ${answered}` : ""}
                        </span>
                      </p>
                    </div>
                    <span className="num hidden shrink-0 whitespace-nowrap text-right text-[13px] text-fg-muted sm:block">{formatDistance(o.distance_m)}</span>
                    {answered && (
                      <span className="num hidden shrink-0 whitespace-nowrap text-[12px] text-fg-muted sm:block" title="Temps de réponse">
                        {answered}
                      </span>
                    )}
                    <Badge tone={meta.tone} className="hidden shrink-0 sm:inline-flex">
                      {meta.label}
                    </Badge>
                  </div>
                );
              })}
              {/* Réseau partagé : compteur seulement (jamais qui, chez les partenaires, a été sollicité) */}
              {!!networkData?.share?.partners_offered && (
                <div className="flex items-center gap-3 px-5 py-3 sm:gap-4">
                  <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-full bg-violet/10 text-violet">
                    <ArrowLeftRight className="size-3.5" />
                  </span>
                  <p className="min-w-0 flex-1 text-[13px] text-fg-muted">
                    {plural(networkData.share.partners_offered, "chauffeur partenaire sollicité", "chauffeurs partenaires sollicités")} (réseau partagé)
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-6">
          {alertRows.length > 0 && (
            <Card className="order-1 min-w-0 xl:order-none">
              <CardHeader title="Alertes de suivi" description="Retard, immobilité, GPS muet, départ tardif : vous décidez." icon={<BellRing />} />
              <CardBody className="pt-1">
                <RideAlertList alerts={alertRows} rideNumber={ride.number} driverPhone={driver?.phone ?? null} currentDriverId={ride.driver_id} timeZone={tz} />
              </CardBody>
            </Card>
          )}
          {ride.flight_number && (
            <Card className="order-4 min-w-0 xl:order-none">
              <CardHeader title="Vol suivi" description="Horaires mis à jour automatiquement ; la prise en charge suit l'arrivée." icon={<Plane />} />
              <CardBody className="pt-1">
                <FlightDetails ride={ride} timeZone={tz} />
              </CardBody>
            </Card>
          )}
          {centrale && (
            <div className="order-3 min-w-0 xl:order-none">
              <RideMoneyCard
                ride={ride as RideMoneyRide}
                settlement={(settlement.data ?? null) as SettlementRow | null}
                driverName={driver?.first_name ?? null}
                serverNow={Date.now()}
                network={partnerOrg ? { lock: networkLock, terms: partnerExecution?.terms ?? null } : null}
              />
            </div>
          )}
          <Card className="order-6 min-w-0 xl:order-none">
            <CardHeader title="Chronologie" description="Chaque étape de la course, à la seconde." icon={<Radar />} />
            <CardBody>
              <RideTimeline events={(events.data ?? []) as TimelineEvent[]} timeZone={tz} />
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
