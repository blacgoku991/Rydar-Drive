import {
  OFFER_STATUS_META, PAYMENT_METHOD_LABELS, RIDE_SOURCE_LABELS, VEHICLE_CATEGORY_META, canAssign, canCancel, canRedispatch,
  formatDistance, formatDuration, formatPhone, formatPrice, formatTime, haversine,
  type OfferStatus, type PaymentMethod, type RideSource, type RideStatus, type VehicleCategory,
} from "@rydar/shared";
import { ArrowLeft, BellRing, Car, Clock, Luggage, MessageSquareText, Phone, Plane, Radar, Users, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody } from "@/components/layout/page-header";
import { RideAlertList, type RideAlertRow } from "@/components/rides/ride-alert-list";
import { FlightChip, FlightDetails, PickupTime } from "@/components/rides/flight-info";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { RideActions, type AssignableDriver } from "@/components/rides/ride-actions";
import { RideMap } from "@/components/rides/ride-map";
import { RideProgress } from "@/components/rides/ride-progress";
import { RideTimeline, type TimelineEvent } from "@/components/rides/ride-timeline";
import { RideStatusBadge, RideTypeTag } from "@/components/rides/status";
import { RideMoneyCard, type RideMoneyRide, type SettlementRow } from "@/components/settlements/ride-money";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { LiveDriver, LiveOffer, LiveRide } from "@/lib/queries/live";

export const metadata: Metadata = { title: "Course" };
export const dynamic = "force-dynamic";

function Info({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-subtle [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11.5px] text-fg-subtle">{label}</p>
        <div className="text-[13.5px] text-fg">{children}</div>
      </div>
    </div>
  );
}

export default async function RidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrg();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const { data: ride } = await ctx.supabase.from("rides").select("*").eq("id", id).eq("organization_id", ctx.org.id).maybeSingle();
  if (!ride) notFound();

  const centrale = ctx.org.dispatch_model === "centrale";
  const [events, offers, drivers, alerts, settlement] = await Promise.all([
    ctx.supabase.from("ride_events").select("id, category, level, type, message, actor_type, data, created_at").eq("ride_id", id).order("id"),
    ctx.supabase
      .from("ride_offers")
      .select("id, driver_id, status, mode, wave, radius_m, distance_m, sent_at, responded_at, expires_at, closed_reason")
      .eq("ride_id", id)
      .order("sent_at"),
    ctx.supabase
      .from("drivers")
      .select("id, number, first_name, last_name, phone, photo_url, presence, status, current_ride_id, online_since, vehicle:vehicles(brand, model, plate, color, category, seats), location:driver_locations(lat, lng, heading, speed_mps, updated_at)")
      .eq("organization_id", ctx.org.id)
      .eq("status", "active"),
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

  const allDrivers = ((drivers.data ?? []) as any[]).map((d) => ({
    ...d,
    vehicle: Array.isArray(d.vehicle) ? d.vehicle[0] ?? null : d.vehicle,
    location: Array.isArray(d.location) ? d.location[0] ?? null : d.location,
  })) as LiveDriver[];
  const byId = new Map(allDrivers.map((d) => [d.id, d]));
  const offerRows = (offers.data ?? []) as any[];
  const involved = new Set<string>([...offerRows.filter((o) => o.status === "pending").map((o) => o.driver_id), ...(ride.driver_id ? [ride.driver_id] : [])]);
  const mapDrivers = allDrivers.filter((d) => involved.has(d.id));
  const driver = ride.driver_id ? byId.get(ride.driver_id) : undefined;
  const status = ride.status as RideStatus;
  const tz = ctx.org.timezone;

  const assignable: AssignableDriver[] = allDrivers
    .filter((d) => d.id !== ride.driver_id)
    .map((d) => ({
      id: d.id,
      name: `${d.first_name} ${d.last_name}`,
      number: d.number,
      presence: d.presence,
      vehicle: d.vehicle ? `${d.vehicle.model} · ${d.vehicle.plate} · ${VEHICLE_CATEGORY_META[d.vehicle.category as VehicleCategory]?.label}` : "Sans véhicule",
      distance_m: d.location ? Math.round(haversine({ lat: d.location.lat, lng: d.location.lng }, { lat: ride.pickup_lat, lng: ride.pickup_lng })) : null,
    }))
    .sort((a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9));

  return (
    <>
      <LiveRefresh rideId={id} events={["ride.updated", "ride.event", "offer.updated", "ride.alert", "settlement.updated"]} />
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-6 lg:px-10">
          <div>
            <Link href="/dashboard/rides" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg">
              <ArrowLeft className="size-3.5" /> Courses
            </Link>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[26px] font-semibold tracking-tight">Course #{ride.number}</h1>
              <RideStatusBadge status={status} />
              <RideTypeTag type={ride.type} />
              {ride.flight_number && <FlightChip ride={ride} timeZone={tz} className="h-[22px] rounded-full px-2 text-[11.5px]" />}
              <Badge tone="neutral" dot={false}>{RIDE_SOURCE_LABELS[ride.source as RideSource]}</Badge>
            </div>
            <p className="mt-2 text-[14px] text-fg-muted">
              <PickupTime ride={ride} timeZone={tz} withDate /> · {ride.customer_name}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <RideActions
              rideId={ride.id}
              number={ride.number}
              canCancel={canCancel(status)}
              canRedispatch={canRedispatch(status) && !ride.driver_id}
              canAssign={canAssign(status) || status === "DRIVER_EN_ROUTE" || status === "DRIVER_ARRIVED"}
              assignLabel={ride.driver_id ? "Réattribuer" : "Attribuer"}
              drivers={assignable}
            />
          </div>
        </div>
      </div>

      {/* Mobile : alertes et vol d'abord ; grand écran : colonne de droite (alertes, vol, puis timeline) */}
      <PageBody className="grid gap-6 xl:grid-cols-[1.35fr_1fr] xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <RideProgress ride={ride} timeZone={tz} />
            </div>
            <div className="relative h-[420px]">
              <RideMap ride={ride as LiveRide} drivers={mapDrivers} offers={offerRows.filter((o) => o.status === "pending").map((o) => ({ ...o, ride_id: id })) as LiveOffer[]} />
            </div>
            <div className="grid gap-5 border-t border-line p-5 sm:grid-cols-2">
              <div className="flex gap-3">
                <div className="flex flex-col items-center pt-1.5">
                  <span className="size-2.5 rounded-full bg-brand ring-4 ring-brand/15" />
                  <span className="my-1 w-px flex-1 bg-line-strong" />
                  <span className="size-2.5 rounded-[2px] bg-fg ring-4 ring-white/10" />
                </div>
                <div className="space-y-4">
                  <div>
                    <p className="text-[11.5px] text-fg-subtle">Départ</p>
                    <p className="text-[14px] font-medium">{ride.pickup_address}</p>
                  </div>
                  <div>
                    <p className="text-[11.5px] text-fg-subtle">Destination</p>
                    <p className="text-[14px] font-medium">{ride.dropoff_address}</p>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Info icon={<Clock />} label="Prise en charge">
                  <PickupTime ride={ride} timeZone={tz} withDate />
                </Info>
                <Info icon={<Radar />} label="Trajet estimé">
                  {formatDistance(ride.estimated_distance_m)} · {formatDuration(ride.estimated_duration_s)}
                </Info>
                <Info icon={<Wallet />} label="Prix">
                  <span className="num font-semibold">{formatPrice(ride.price_cents)}</span>{" "}
                  <span className="text-fg-subtle">· {PAYMENT_METHOD_LABELS[ride.payment_method as PaymentMethod]}</span>
                  {centrale && ride.driver_payout_cents != null && (
                    <span className="block text-[12px] text-fg-subtle">
                      dont <span className="mono text-brand">{formatPrice(ride.driver_payout_cents)}</span> pour le chauffeur
                    </span>
                  )}
                </Info>
                <Info icon={<Car />} label="Catégorie">{VEHICLE_CATEGORY_META[ride.vehicle_category as VehicleCategory]?.label}</Info>
              </div>
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Client" description="Aucun compte client : coordonnées de contact uniquement." />
              <CardBody className="grid grid-cols-2 gap-4">
                <Info icon={<Users />} label="Nom">{ride.customer_name}</Info>
                <Info icon={<Phone />} label="Téléphone">
                  <a href={`tel:${ride.customer_phone}`} className="hover:text-brand">{formatPhone(ride.customer_phone)}</a>
                </Info>
                <Info icon={<Users />} label="Passagers">{ride.passengers}</Info>
                <Info icon={<Luggage />} label="Bagages">{ride.luggage}</Info>
                {ride.flight_number && (
                  <div className="col-span-2">
                    <Info icon={<Plane />} label="Vol">
                      <FlightChip ride={ride} timeZone={tz} className="mt-0.5" />
                    </Info>
                  </div>
                )}
                {ride.comment && (
                  <div className="col-span-2">
                    <Info icon={<MessageSquareText />} label="Commentaire">{ride.comment}</Info>
                  </div>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Chauffeur" description={driver ? "Affecté à la course" : "En attente d'attribution"} />
              <CardBody>
                {driver ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={`${driver.first_name} ${driver.last_name}`} size={44} />
                      <div>
                        <Link href={`/dashboard/drivers/${driver.id}`} className="text-[15px] font-semibold hover:text-brand">
                          {driver.first_name} {driver.last_name}
                        </Link>
                        <p className="text-[12.5px] text-fg-subtle">Chauffeur #{driver.number} · {formatPhone(driver.phone)}</p>
                      </div>
                    </div>
                    {driver.vehicle && (
                      <div className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5 text-[13px]">
                        {driver.vehicle.brand} {driver.vehicle.model} · <span className="num">{driver.vehicle.plate}</span>
                        <span className="text-fg-subtle"> · {driver.vehicle.color}</span>
                      </div>
                    )}
                    {ride.accepted_at && ride.dispatch_started_at && (
                      <p className="text-[12.5px] text-fg-muted">
                        Attribuée en{" "}
                        <span className="num text-brand">
                          {formatDuration((new Date(ride.accepted_at).getTime() - new Date(ride.dispatch_started_at).getTime()) / 1000)}
                        </span>{" "}
                        à {formatTime(ride.accepted_at, tz, true)}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-fg-muted">
                    {status === "NO_DRIVER_FOUND"
                      ? "Aucun chauffeur n'a accepté. Relancez le dispatch ou attribuez manuellement."
                      : "Le dispatch est en cours — le premier chauffeur qui accepte obtient la course."}
                  </p>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Offres envoyées" description="Chauffeurs notifiés, distance au départ et réponse." />
            <div className="divide-y divide-line">
              {offerRows.length === 0 && <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucune offre envoyée pour le moment.</p>}
              {offerRows.map((o) => {
                const d = byId.get(o.driver_id);
                const meta = OFFER_STATUS_META[o.status as OfferStatus];
                const response = o.responded_at ? (new Date(o.responded_at).getTime() - new Date(o.sent_at).getTime()) / 1000 : null;
                return (
                  <div key={o.id} className="flex items-center gap-4 px-5 py-3">
                    <Avatar name={d ? `${d.first_name} ${d.last_name}` : "?"} size={30} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{d ? `${d.first_name} ${d.last_name}` : "Chauffeur"}</p>
                      <p className="text-[12px] text-fg-subtle">
                        {o.mode === "fleet" ? "Offre flotte" : `Vague ${o.wave} · rayon ${formatDistance(o.radius_m)}`} · envoyée {formatTime(o.sent_at, tz, true)}
                      </p>
                    </div>
                    <span className="num w-16 text-right text-[13px] text-fg-muted">{formatDistance(o.distance_m)}</span>
                    <span className="num w-14 text-right text-[12px] text-fg-subtle">{response != null && o.status === "accepted" ? `${response.toFixed(1)} s` : ""}</span>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="order-first min-w-0 space-y-6 empty:hidden xl:order-none xl:col-start-2 xl:row-start-1">
          {(alerts.data ?? []).length > 0 && (
            <Card>
              <CardHeader
                title="Alertes de suivi"
                description="Retard, immobilité, GPS muet, départ tardif : la centrale décide."
                icon={<BellRing />}
              />
              <CardBody className="pt-1">
                <RideAlertList
                  alerts={(alerts.data ?? []) as RideAlertRow[]}
                  rideNumber={ride.number}
                  driverPhone={driver?.phone ?? null}
                  currentDriverId={ride.driver_id}
                  timeZone={tz}
                />
              </CardBody>
            </Card>
          )}
          {ride.flight_number && (
            <Card>
              <CardHeader title="Vol suivi" description="Horaires mis à jour automatiquement ; la prise en charge suit l'arrivée." icon={<Plane />} />
              <CardBody className="pt-1">
                <FlightDetails ride={ride} timeZone={tz} />
              </CardBody>
            </Card>
          )}
          {centrale && (
            <RideMoneyCard
              ride={ride as RideMoneyRide}
              settlement={(settlement.data ?? null) as SettlementRow | null}
              driverName={driver?.first_name ?? null}
              serverNow={Date.now()}
            />
          )}
        </div>
        <Card
          className={cn(
            "h-fit min-w-0 xl:sticky xl:top-6 xl:col-start-2",
            (alerts.data ?? []).length > 0 || ride.flight_number || centrale ? "xl:row-start-2" : "xl:row-span-2 xl:row-start-1",
          )}
        >
          <CardHeader title="Timeline" description="Chaque étape du dispatch, horodatée à la seconde." icon={<Radar />} />
          <CardBody>
            <RideTimeline events={(events.data ?? []) as TimelineEvent[]} timeZone={tz} />
          </CardBody>
        </Card>
      </PageBody>
    </>
  );
}
