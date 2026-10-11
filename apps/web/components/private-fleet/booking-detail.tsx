// Flotte Privée, fiche d'une réservation (/dashboard/rides/[id], docs/FLOTTE-PRIVEE.md § 7.3) : actions « Je la
// prends », « Refuser », « Annuler la réservation », « Fixer le prix » (sans prix) ou « Modifier le prix » ; jamais
// « Attribuer à… », « Relancer » ni « Retirer » ; ni bloc réseau partagé ni règlement chauffeur ; chronologie limitée à
// la catégorie « timeline » (étapes dispatch.private_* comprises). Composant serveur.
import {
  PAYMENT_METHOD_LABELS, VEHICLE_CATEGORY_META, formatDistance, formatDuration, formatPhone, formatPrice,
  type PaymentMethod, type RideStatus, type VehicleCategory,
} from "@rydar/shared";
import { Car, Clock, Luggage, MessageSquareText, Phone, Plane, Radar, Users, Wallet } from "lucide-react";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { BookingActions } from "@/components/private-fleet/booking-actions";
import { bookingKind, bookingKindMeta, PRIVATE_SOURCE_LABELS, responseDeadline } from "@/components/private-fleet/booking-meta";
import { EditPriceButton } from "@/components/private-fleet/edit-price";
import { OFFER_EMBED, toBooking, type BookingRow } from "@/components/private-fleet/queue";
import { FlightChip, FlightDetails, PickupTime } from "@/components/rides/flight-info";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { RideMap } from "@/components/rides/ride-map";
import { RideProgress } from "@/components/rides/ride-progress";
import { RideTimeline, type TimelineEvent } from "@/components/rides/ride-timeline";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { requireOrg } from "@/lib/auth";
import type { LiveRide } from "@/lib/queries/live";
import { cn } from "@/lib/utils";

type OrgCtx = Awaited<ReturnType<typeof requireOrg>>;

const CLOSED = new Set(["COMPLETED", "CANCELLED"]);
const NB = "\u00a0";

function Info({ icon, label, children, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-subtle [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-[12px] text-fg-muted">{label}</p>
        <div className="text-[13.5px] text-fg">{children}</div>
      </div>
    </div>
  );
}

export async function PrivateBookingDetail({ ctx, id }: { ctx: OrgCtx; id: string }) {
  const now = Date.now();
  const tz = ctx.org.timezone || "Europe/Paris";
  const [{ data: ride }, events] = await Promise.all([
    ctx.supabase.from("rides").select(`*, ${OFFER_EMBED}`).eq("id", id).eq("organization_id", ctx.org.id).maybeSingle(),
    ctx.supabase
      .from("ride_events")
      .select("id, category, level, type, message, actor_type, data, created_at")
      .eq("ride_id", id)
      .eq("organization_id", ctx.org.id)
      .eq("category", "timeline")
      .order("id"),
  ]);
  if (!ride) notFound();
  const booking = toBooking(ride as unknown as BookingRow, ctx.driverId, now);
  const status = ride.status as RideStatus;
  const meta = bookingKindMeta(bookingKind(booking, now));
  const deadline = booking.state === "to_confirm" ? responseDeadline(booking.offerExpiresAt, tz, now) : null;

  return (
    <>
      <LiveRefresh rideId={id} events={["ride.updated", "ride.event", "offer.updated"]} maxPollMs={CLOSED.has(status) ? 60_000 : 30_000} />
      {/* En-tête de fiche (§ 3.2) : « ← Réservations », état, vol et origine à côté du titre (plus d'étiquette « Planifiée ») */}
      <PageHeader
        back={{ href: "/dashboard/rides", label: "Réservations" }}
        title={`Réservation #${ride.number}`}
        badges={
          <>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {ride.flight_number && <FlightChip ride={ride} timeZone={tz} className="h-[22px] rounded-full px-2" />}
            <Badge tone="neutral" dot={false}>
              {PRIVATE_SOURCE_LABELS[ride.source] ?? ride.source}
            </Badge>
          </>
        }
        meta={
          <>
            <span className="text-fg">
              <PickupTime ride={ride} timeZone={tz} withDate />
            </span>{" "}
            · {ride.customer_name}
            {deadline && <span className="mt-1 block font-medium text-amber">{deadline}</span>}
            {booking.state === "to_check" && (
              <span className="mt-1 block">Catégorie ou nombre de places au-delà de votre véhicule{NB}: vérifiez avant de la prendre.</span>
            )}
          </>
        }
        actions={
          <>
            <BookingActions
              size="md"
              call={false}
              driverId={ctx.driverId}
              booking={{
                id: booking.id,
                number: booking.number,
                status,
                state: booking.state,
                offerId: booking.offerId,
                takeable: booking.takeable,
                customerPhone: booking.customer_phone,
              }}
            />
            {status !== "CANCELLED" && (
              <EditPriceButton rideId={ride.id} number={ride.number} priceCents={ride.price_cents ?? null} paymentMethod={ride.payment_method as PaymentMethod} />
            )}
          </>
        }
      />

      <PageBody className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
        <div className="min-w-0 space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <RideProgress ride={ride} timeZone={tz} />
            </div>
            <div className="relative h-[380px]">
              <RideMap ride={ride as LiveRide} drivers={[]} offers={[]} />
            </div>
            <div className="grid gap-5 border-t border-line p-5 sm:grid-cols-2">
              <div className="flex gap-3">
                <div className="flex flex-col items-center pt-1.5" aria-hidden>
                  <span className="size-2.5 rounded-full bg-brand ring-4 ring-brand/15" />
                  <span className="my-1 w-px flex-1 bg-line-strong" />
                  <span className="size-2.5 rounded-[2px] bg-fg ring-4 ring-white/10" />
                </div>
                <div className="space-y-4">
                  <div>
                    <p className="text-[12px] text-fg-muted">Départ</p>
                    <p className="text-[14px] font-medium">{ride.pickup_address}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-fg-muted">Destination</p>
                    <p className="text-[14px] font-medium">{ride.dropoff_address}</p>
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
                  {/* Séparateur collé au prix (espace insécable) : jamais « · » seul en début de ligne */}
                  {ride.price_cents == null ? (
                    <span className="whitespace-nowrap text-amber">prix à fixer</span>
                  ) : (
                    <span className="num whitespace-nowrap font-semibold">{formatPrice(ride.price_cents, ride.currency ?? "EUR")}</span>
                  )}
                  <span className="text-fg-muted">{"\u00a0·"}</span>{" "}
                  <span className="whitespace-nowrap text-fg-muted">{PAYMENT_METHOD_LABELS[ride.payment_method as PaymentMethod]}</span>
                </Info>
                <Info icon={<Car />} label="Catégorie">{VEHICLE_CATEGORY_META[ride.vehicle_category as VehicleCategory]?.label}</Info>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Client" />
            <CardBody className="grid grid-cols-2 gap-4">
              {/* Téléphone : nom et numéro sur toute la largeur (numéro jamais coupé), passagers et bagages côte à côte */}
              <Info icon={<Users />} label="Nom" className="col-span-2 sm:col-span-1">
                {ride.customer_name}
              </Info>
              <Info icon={<Phone />} label="Téléphone" className="col-span-2 sm:col-span-1">
                <a href={`tel:${ride.customer_phone}`} className="whitespace-nowrap hover:text-brand">
                  {formatPhone(ride.customer_phone)}
                </a>
              </Info>
              <Info icon={<Users />} label="Passagers">{ride.passengers}</Info>
              <Info icon={<Luggage />} label="Bagages">{ride.luggage}</Info>
              {ride.comment && (
                <div className="col-span-2">
                  <Info icon={<MessageSquareText />} label="Commentaire">{ride.comment}</Info>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {ride.flight_number && (
            <Card>
              <CardHeader title="Vol suivi" description={"Horaires mis à jour automatiquement\u00a0; la prise en charge suit l'arrivée."} icon={<Plane />} />
              <CardBody className="pt-1">
                <FlightDetails ride={ride} timeZone={tz} />
              </CardBody>
            </Card>
          )}
          <Card className="h-fit xl:sticky xl:top-6">
            <CardHeader title="Chronologie" description="Chaque étape de la réservation, horodatée à la seconde." icon={<Radar />} />
            <CardBody>
              <RideTimeline events={(events.data ?? []) as TimelineEvent[]} timeZone={tz} technicalView={false} />
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
