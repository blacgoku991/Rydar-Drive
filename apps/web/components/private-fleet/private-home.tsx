// Flotte Privée, Accueil (/dashboard, docs/FLOTTE-PRIVEE.md § 7.3), à la place du centre de commande : état de
// l'application, réservations à traiter (Je la prends, Refuser, Appeler, Fixer le prix ; l'annulation se fait depuis la
// fiche), journée, premiers pas, chiffres du mois, prochaines réservations, état du site, nouvelle réservation prise par
// téléphone. Ordre de lecture (téléphone compris) : « À traiter » puis « Aujourd'hui » avant les chiffres du mois.
// Composant serveur ; actions dans des composants client. Relu en direct (LiveRefresh) à chaque changement de course ou
// d'offre.
import { VEHICLE_CATEGORY_META, dayTitle, formatPrice, formatRideDate, formatTime } from "@rydar/shared";
import { CalendarDays, CheckCircle2, ChevronRight, Circle, Globe, Inbox, Luggage, Users } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { BookingActions } from "@/components/private-fleet/booking-actions";
import { appPresence, bookingKind, bookingKindMeta, bookingPrice, bookingRoute, countLabel, responseDeadline, rideDateAt } from "@/components/private-fleet/booking-meta";
import { EditPriceButton } from "@/components/private-fleet/edit-price";
import type { PrivateHomeData } from "@/components/private-fleet/home-data";
import type { Booking } from "@/components/private-fleet/queue";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { NewRideButton } from "@/components/rides/new-ride-button";
import { Badge, toneDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { upperFirst } from "@/lib/wording";

const NB = " ";

function KindBadge({ booking, now }: { booking: Booking; now: number }) {
  const meta = bookingKindMeta(bookingKind(booking, now));
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** Ligne d'une réservation : heure, numéro, trajet, client, prix ; lien vers sa fiche. */
function BookingLine({ booking, timeZone, now, withDate = true }: { booking: Booking; timeZone: string; now: number; withDate?: boolean }) {
  return (
    <Link href={`/dashboard/rides/${booking.id}`} prefetch={false} className="group flex min-w-0 items-start gap-3 rounded-lg px-1 py-1 hover:bg-white/[0.025]">
      <span className="num w-[86px] shrink-0 pt-0.5 text-[13px] text-fg">
        {withDate ? formatRideDate(booking.pickup_at, timeZone, new Date(now)) : formatTime(booking.pickup_at, timeZone)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-fg group-hover:text-brand" title={`${booking.pickup_address} → ${booking.dropoff_address}`}>
          {bookingRoute(booking)}
        </span>
        <span className="block truncate text-[12px] text-fg-muted">
          #{booking.number} · {booking.customer_name || "Client"} · {bookingPrice(booking.price_cents, booking.currency)}
        </span>
      </span>
      <KindBadge booking={booking} now={now} />
    </Link>
  );
}

function ToTreat({ data, now }: { data: PrivateHomeData; now: number }) {
  const tz = data.timeZone;
  return (
    <Card>
      <CardHeader
        title="À traiter"
        description={`Réservations à confirmer, à vérifier ou non confirmées${NB}: vous seul décidez.`}
        icon={<Inbox />}
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/rides?filter=todo" prefetch={false}>
              Tout voir<span className="sr-only">{`${NB}: réservations à traiter`}</span> <ChevronRight />
            </Link>
          </Button>
        }
      />
      {data.queue === null ? (
        <p className="px-5 py-6 text-[13px] text-red">Réservations à traiter illisibles pour le moment{NB}: rechargez la page.</p>
      ) : data.queue.length === 0 ? (
        <EmptyState size="compact" icon={<CheckCircle2 />} title="Rien à traiter." description="Les nouvelles réservations de votre site apparaissent ici." />
      ) : (
        <ul className="divide-y divide-line">
          {data.queue.slice(0, 8).map((b) => {
            const deadline = b.state === "to_confirm" ? responseDeadline(b.offerExpiresAt, tz, now) : null;
            const category = VEHICLE_CATEGORY_META[b.vehicle_category]?.label;
            return (
              <li key={b.id} className="space-y-3 px-5 py-4">
                {/* État et échéance de réponse d'abord, puis la réservation */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <KindBadge booking={b} now={now} />
                  {deadline && <span className="text-[12.5px] font-medium text-amber">{deadline}</span>}
                  {b.state === "to_check" && <span className="text-[12.5px] text-fg-muted">Catégorie ou places au-delà de votre véhicule</span>}
                </div>
                <Link href={`/dashboard/rides/${b.id}`} prefetch={false} className="group block min-w-0">
                  <p className="text-[14px] font-semibold text-fg group-hover:text-brand">
                    <span className="num">{formatRideDate(b.pickup_at, tz, new Date(now))}</span> · {bookingRoute(b)}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-muted">
                    <span>#{b.number}</span>
                    <span>{b.customer_name || "Client"}</span>
                    <span className="inline-flex items-center gap-1" aria-label={`${b.passengers} passager${b.passengers > 1 ? "s" : ""}`}>
                      <Users aria-hidden className="size-3.5" /> {b.passengers}
                    </span>
                    <span className="inline-flex items-center gap-1" aria-label={`${b.luggage} bagage${b.luggage > 1 ? "s" : ""}`}>
                      <Luggage aria-hidden className="size-3.5" /> {b.luggage}
                    </span>
                    {category && <span>{category}</span>}
                    <span className={cn("num font-medium", b.price_cents == null ? "text-amber" : "text-fg")}>{bookingPrice(b.price_cents, b.currency)}</span>
                  </p>
                </Link>
                {/* « Annuler » reste sur la fiche : ici, les décisions du jour (prendre, refuser, appeler, fixer le prix) */}
                <div className="flex flex-wrap gap-2">
                  <BookingActions
                    driverId={data.driverId}
                    cancel={false}
                    inList
                    booking={{
                      id: b.id,
                      number: b.number,
                      status: b.status,
                      state: b.state,
                      offerId: b.offerId,
                      takeable: b.takeable,
                      customerPhone: b.customer_phone,
                    }}
                  />
                  {b.price_cents == null && (
                    <EditPriceButton rideId={b.id} number={b.number} priceCents={null} paymentMethod={b.payment_method} size="sm" variant="outline" />
                  )}
                </div>
              </li>
            );
          })}
          {data.queue.length > 8 && (
            <li className="px-5 py-3 text-[12.5px] text-fg-muted">
              + {countLabel(data.queue.length - 8, "autre réservation", "autres réservations")} dans{" "}
              <Link href="/dashboard/rides?filter=todo" prefetch={false} className="text-brand hover:underline">
                Réservations
              </Link>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

function RideList({ title, description, rides, empty, data, now, withDate }: {
  title: string;
  description: string;
  rides: Booking[];
  empty: string;
  data: PrivateHomeData;
  now: number;
  withDate: boolean;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} icon={<CalendarDays />} />
      <CardBody className="space-y-1.5">
        {rides.length ? rides.map((b) => <BookingLine key={b.id} booking={b} timeZone={data.timeZone} now={now} withDate={withDate} />) : <p className="text-[13px] text-fg-muted">{empty}</p>}
      </CardBody>
    </Card>
  );
}

/** Carte « Mon site » : état et dernière réservation reçue ; la clé et les détails techniques restent dans « Mon site ». */
function SiteCard({ data, now }: { data: PrivateHomeData; now: number }) {
  const site = data.site;
  return (
    <Card>
      <CardHeader
        title="Mon site"
        icon={<Globe />}
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/site" prefetch={false}>
              Détails<span className="sr-only">{`${NB}: mon site`}</span> <ChevronRight />
            </Link>
          </Button>
        }
      />
      <CardBody className="space-y-2 text-[13px]">
        <p className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", toneDot[site.linked ? "green" : "amber"])} aria-hidden />
          <span className="font-medium text-fg [overflow-wrap:anywhere]">
            {site.linked ? `Votre site${site.host ? ` ${site.host}` : ""} est relié` : "Votre site n'est pas encore relié"}
          </span>
        </p>
        {site.linked ? (
          <p className="text-fg-muted">
            Dernière réservation reçue{NB}:{" "}
            {site.lastBooking ? (
              <Link href={`/dashboard/rides/${site.lastBooking.id}`} prefetch={false} className="text-fg hover:text-brand">
                #{site.lastBooking.number}, {rideDateAt(site.lastBooking.created_at, data.timeZone, now)}
              </Link>
            ) : (
              <span className="text-fg">aucune pour l&apos;instant</span>
            )}
          </p>
        ) : (
          <p className="text-fg-muted">L&apos;équipe Rydar relie votre site à votre espace{NB}: vos réservations arriveront ici et dans l&apos;application.</p>
        )}
      </CardBody>
    </Card>
  );
}

function FirstStepsCard({ data }: { data: PrivateHomeData }) {
  if (!data.firstSteps) return null;
  const done = data.firstSteps.filter((s) => s.done).length;
  return (
    <Card>
      <CardHeader title="Premiers pas" description={`${done}${NB}/${NB}${data.firstSteps.length} étapes terminées`} />
      <ul className="divide-y divide-line">
        {data.firstSteps.map((s) => {
          const body = (
            <>
              {s.done ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-green" /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />}
              <span className="min-w-0 flex-1">
                <span className={cn("block text-[13px] font-medium", s.done ? "text-fg-muted line-through" : "text-fg")}>
                  {s.label}
                  <span className="sr-only">{s.done ? " (fait)" : " (à faire)"}</span>
                </span>
                {!s.done && <span className="block text-[12px] text-fg-muted">{s.hint}</span>}
              </span>
              {!s.done && s.href && <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />}
            </>
          );
          return (
            <li key={s.key}>
              {!s.done && s.href ? (
                <Link href={s.href} prefetch={false} className="flex items-start gap-3 px-5 py-3 hover:bg-white/[0.025]">
                  {body}
                </Link>
              ) : (
                <div className="flex items-start gap-3 px-5 py-3">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Chiffres du mois : quatre au plus, couleur neutre (§ 3.3). */
function MonthFigures({ data }: { data: PrivateHomeData }) {
  const month = data.month;
  return (
    <section aria-labelledby="ce-mois-ci" className="space-y-2">
      <h2 id="ce-mois-ci" className="px-1 text-[13px] font-semibold text-fg-muted">
        Ce mois-ci
      </h2>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Réservations du site" value={month.siteBookings} />
        <StatCard label="Réservations terminées" value={month.completed} />
        <StatCard label="Chiffre d'affaires" value={formatPrice(month.revenueCents)} sub="réservations terminées" />
        <StatCard label="Panier moyen" value={month.averageCents != null ? formatPrice(month.averageCents) : "—"} />
      </div>
    </section>
  );
}

export function PrivateHome({ data, now }: { data: PrivateHomeData; now: number }) {
  const presence = appPresence(data.driver, now);
  return (
    <>
      {/* Réservations et offres relues en direct (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["ride.updated", "offer.updated", "driver.updated"]} pollMs={30_000} debounceMs={1500} />
      <PageHeader
        title={data.firstName ? `Bonjour ${data.firstName}` : "Bonjour"}
        badges={<Badge tone={presence.tone}>{presence.label}</Badge>}
        meta={
          <>
            {upperFirst(dayTitle(data.today))}
            {presence.detail ? ` · ${presence.detail}` : ""}
          </>
        }
        actions={<NewRideButton pricing={data.pricing} defaultPayment={data.defaultPayment} privateFleet />}
      />
      <PageBody className="space-y-6">
        {!data.driver && (
          <Callout tone="danger" title={`Votre fiche chauffeur a été supprimée${NB}: contactez l'équipe Rydar pour la recréer.`}>
            Les réservations de votre site ne vous sont plus proposées d&apos;ici là.
          </Callout>
        )}
        {/* À traiter et Aujourd'hui d'abord (téléphone compris), puis premiers pas, chiffres du mois, à venir et site */}
        <div className="grid items-start gap-6 xl:grid-cols-[1.6fr_1fr]">
          <div className="min-w-0 space-y-6">
            <ToTreat data={data} now={now} />
            <RideList
              title="Aujourd'hui"
              description={countLabel(data.todayRides.length, "réservation", "réservations")}
              rides={data.todayRides}
              empty="Aucune réservation aujourd'hui."
              data={data}
              now={now}
              withDate={false}
            />
          </div>
          <div className="min-w-0 space-y-6">
            <FirstStepsCard data={data} />
            <MonthFigures data={data} />
            <RideList
              title="Prochaines réservations"
              description="Confirmées, de la plus proche à la plus lointaine."
              rides={data.upcoming}
              empty="Aucune réservation confirmée à venir."
              data={data}
              now={now}
              withDate
            />
            <SiteCard data={data} now={now} />
          </div>
        </div>
      </PageBody>
    </>
  );
}
