"use client";
import {
  DEFAULT_DISPATCH_RADII_M, PAYMENT_METHOD_LABELS, RIDE_STATUS_META, VEHICLE_CATEGORY_META, formatDistance, formatDuration, formatPhone, formatPrice, formatRideDate,
  formatTime, haversine, initials, type DriverPresence, type PaymentMethod, type RideStatus, type VehicleCategory,
} from "@rydar/shared";
import { ArrowLeft, BellOff, ExternalLink, Luggage, MessageSquareText, Phone, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ALERT_ICON, AlertActionBar, agoFr, alertLabel, severityColor } from "@/components/alerts/ride-alert-ui";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { FlightDetails, PickupTime } from "@/components/rides/flight-info";
import { RideActions, type AssignableDriver } from "@/components/rides/ride-actions";
import { toneDot, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LiveAlert, LiveDriver, LiveRide } from "@/lib/queries/live";
import { cn } from "@/lib/utils";
import { SEARCHING, TERMINAL } from "./ride-row";

type Event = { id: number; level: string; message: string; created_at: string; category: string };

const ETA_STATUSES = new Set(["ACCEPTED", "DRIVER_EN_ROUTE"]);
/** Statuts où la centrale peut encore changer de chauffeur (assign_ride, migration 002200). */
const ASSIGNABLE = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED", "NO_DRIVER_FOUND", "ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]);
const LEVEL_DOT: Record<string, string> = { success: "bg-brand", warning: "bg-amber", error: "bg-red", info: "bg-fg-subtle", debug: "bg-fg-subtle" };

/** Bandeau d'alerte de suivi : type, message du serveur, âge + Relancer / Réattribuer / Garder / Appeler. */
function AlertBanner({ alert, ride, driver, now, onAssign }: { alert: LiveAlert; ride: LiveRide; driver?: LiveDriver; now: number; onAssign: () => void }) {
  const Icon = ALERT_ICON[alert.kind];
  if (alert.status !== "open") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.035] px-3.5 py-2.5 text-[12.5px] text-fg-muted">
        <BellOff className="size-4 shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{alertLabel(alert.kind)}</span> · gardé par la centrale
          {alert.muted_until ? `, sourdine jusqu'à ${formatTime(alert.muted_until)}` : ""}
        </span>
      </div>
    );
  }
  const color = severityColor(alert.severity);
  return (
    <div
      className="animate-rise overflow-hidden rounded-xl border px-3.5 py-3"
      style={{ borderColor: `color-mix(in oklab, ${color} 38%, transparent)`, background: `color-mix(in oklab, ${color} 9%, transparent)` }}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}>
          {alert.severity === "critical" && <span className="absolute inset-0 animate-ping rounded-xl opacity-25" style={{ background: color }} />}
          <Icon className="relative size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 text-[13.5px] font-semibold" style={{ color }}>
            <span className="truncate">{alertLabel(alert.kind)}</span>
            {alert.severity === "critical" && <span className="shrink-0 rounded bg-red/15 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-red">urgent</span>}
            <span className="ml-auto shrink-0 text-[11.5px] font-normal text-fg-subtle">{agoFr(alert.created_at, now)}</span>
          </p>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-fg">{alert.message}</p>
        </div>
      </div>
      <AlertActionBar
        className="mt-3"
        alert={{ id: alert.id, ride_id: ride.id, driver_id: alert.driver_id, driverName: alert.data?.driver_name ?? driver?.first_name, rideNumber: ride.number }}
        phone={driver && driver.id === alert.driver_id ? driver.phone : undefined}
        onAssign={onAssign}
      />
    </div>
  );
}

/** Détail d'une course dans le panneau du command center (sans quitter la carte). */
export function RideFocus({
  ride,
  driver,
  drivers,
  offers,
  approachS,
  liveEvents,
  alert,
  now,
  assignOpen,
  onAssignOpenChange,
  onBack,
  onSelectDriver,
}: {
  ride: LiveRide;
  driver?: LiveDriver;
  drivers: LiveDriver[];
  offers: number;
  approachS: number | null;
  liveEvents: Event[];
  alert?: LiveAlert;
  now: number;
  assignOpen?: boolean;
  onAssignOpenChange?: (open: boolean) => void;
  onBack: () => void;
  onSelectDriver: (id: string) => void;
}) {
  const status = ride.status as RideStatus;
  const meta = RIDE_STATUS_META[status] ?? { label: status, tone: "neutral" as const };
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dashboard/rides/${ride.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((j: { events: Event[] }) => !cancelled && setEvents(j.events.filter((e) => e.category === "timeline")))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ride.id, ride.status, ride.pickup_at, alert?.id]);

  const timeline = [...liveEvents.filter((e) => !events.some((x) => x.id === e.id) && e.category === "timeline"), ...events]
    .sort((a, b) => b.id - a.id)
    .slice(0, 8);

  const assignable: AssignableDriver[] = drivers
    .filter((d) => d.status === "active" && d.presence !== "offline" && d.id !== ride.driver_id)
    .map((d) => ({
      id: d.id,
      name: `${d.first_name} ${d.last_name}`,
      number: d.number,
      presence: d.presence as DriverPresence,
      vehicle: d.vehicle ? `${d.vehicle.model} · ${d.vehicle.plate}` : "Sans véhicule",
      distance_m: d.location ? haversine(d.location, { lat: ride.pickup_lat, lng: ride.pickup_lng }) : null,
    }))
    .sort((a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9));

  const eta = ETA_STATUSES.has(status) && approachS != null ? approachS : null;
  const openAssign = () => onAssignOpenChange?.(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Retour à la liste">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight">Course #{ride.number}</p>
          <p className="text-[12px] text-fg-subtle">{formatRideDate(ride.pickup_at)} · {ride.type === "instant" ? "immédiate" : "planifiée"}</p>
        </div>
        <Button asChild variant="ghost" size="icon-sm" aria-label="Ouvrir la fiche complète">
          <Link href={`/dashboard/rides/${ride.id}`}>
            <ExternalLink />
          </Link>
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {alert && !TERMINAL.has(status) && <AlertBanner alert={alert} ride={ride} driver={driver} now={now} onAssign={openAssign} />}

        {/* Statut + ETA */}
        <div className={cn("rounded-xl px-3.5 py-3", status === "NO_DRIVER_FOUND" ? "bg-red/[0.08]" : "bg-white/[0.04]")}>
          <p className={cn("flex items-center gap-2 text-[13.5px] font-semibold", toneText[meta.tone])}>
            <span className={cn("size-2 rounded-full", toneDot[meta.tone], SEARCHING.has(status) && "animate-breathe")} />
            {meta.label}
          </p>
          <p className="mt-1 text-[12.5px] text-fg-muted">
            {SEARCHING.has(status)
              ? ride.type === "instant" || ride.dispatch_mode === "geo"
                ? `Vague ${ride.dispatch_wave || 1} · rayon ${formatDistance(ride.dispatch_radius_m ?? DEFAULT_DISPATCH_RADII_M[0])} · ${offers} chauffeur${offers > 1 ? "s" : ""} sollicité${offers > 1 ? "s" : ""}`
                : `Proposée à la flotte · ${offers} chauffeur${offers > 1 ? "s" : ""}`
              : eta != null
                ? `Arrivée au départ dans ~${formatDuration(eta)} (${formatTime(new Date(Date.now() + eta * 1000))})`
                : status === "DRIVER_ARRIVED"
                  ? "Le chauffeur attend le client au point de départ"
                  : ride.estimated_duration_s && (status === "IN_PROGRESS" || status === "PASSENGER_ONBOARD")
                    ? `Trajet estimé ${formatDuration(ride.estimated_duration_s)}`
                    : status === "NO_DRIVER_FOUND"
                      ? "Aucun chauffeur n'a accepté : relancez ou attribuez manuellement."
                      : status === "CREATED"
                        ? "En attente d'attribution manuelle."
                        : "—"}
          </p>
        </div>

        {/* Trajet */}
        <div className="flex gap-3">
          <div className="flex flex-col items-center pt-1.5">
            <span className="size-2.5 rounded-full bg-brand ring-4 ring-brand/15" />
            <span className="my-1 w-px flex-1 bg-line-strong" />
            <span className="size-2.5 rounded-[2px] bg-fg ring-4 ring-white/10" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-[11.5px] text-fg-subtle">
                Départ · <PickupTime ride={ride} />
              </p>
              <p className="text-[13.5px] leading-snug text-fg">{ride.pickup_address}</p>
            </div>
            <div>
              <p className="text-[11.5px] text-fg-subtle">Destination</p>
              <p className="text-[13.5px] leading-snug text-fg">{ride.dropoff_address}</p>
            </div>
          </div>
        </div>

        {/* Vol suivi */}
        {ride.flight_number && <FlightDetails ride={ride} now={now} />}

        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-line">
          {[
            ["Distance", formatDistance(ride.estimated_distance_m)],
            ["Durée", formatDuration(ride.estimated_duration_s)],
            ["Prix", formatPrice(ride.price_cents)],
          ].map(([k, v]) => (
            <div key={k} className="bg-ink-800 px-3 py-2.5">
              <p className="text-[11.5px] text-fg-subtle">{k}</p>
              <p className={cn("text-[15px] font-semibold tracking-tight", k === "Prix" ? "text-brand" : "text-fg")}>{v}</p>
            </div>
          ))}
        </div>

        {/* Client */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium">{ride.customer_name}</p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-fg-subtle">
              <span className="flex items-center gap-1"><Users className="size-3" /> {ride.passengers}</span>
              <span className="flex items-center gap-1"><Luggage className="size-3" /> {ride.luggage ?? 0}</span>
              <span>{VEHICLE_CATEGORY_META[ride.vehicle_category as VehicleCategory]?.label ?? ride.vehicle_category}</span>
            </p>
          </div>
          {ride.customer_phone && (
            <Button asChild variant="secondary" size="icon-sm" aria-label="Appeler le client">
              <a href={`tel:${ride.customer_phone}`}><Phone /></a>
            </Button>
          )}
        </div>

        {/* Chauffeur */}
        {driver && (
          <div className="flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 hover:border-line-strong">
            <button type="button" onClick={() => onSelectDriver(driver.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-600 text-[12px] font-semibold" style={{ boxShadow: `0 0 0 2px ${PRESENCE_COLOR[driver.presence]}` }}>
                {initials(driver.first_name, driver.last_name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{driver.first_name} {driver.last_name}</span>
                <span className="block truncate text-[12px] text-fg-subtle">
                  {driver.vehicle ? `${driver.vehicle.brand ?? ""} ${driver.vehicle.model} · ${driver.vehicle.plate}` : "—"}
                </span>
              </span>
            </button>
            <Link
              href={`/dashboard/messages?driver=${driver.id}`}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-white/5 hover:text-fg"
              aria-label={`Écrire à ${driver.first_name}`}
              title={`Écrire à ${driver.first_name}`}
            >
              <MessageSquareText className="size-4" />
            </Link>
            <a href={`tel:${driver.phone}`} className="grid size-8 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-white/5 hover:text-fg" aria-label={`Appeler ${formatPhone(driver.phone)}`}>
              <Phone className="size-4" />
            </a>
          </div>
        )}

        {!TERMINAL.has(status) || status === "NO_DRIVER_FOUND" ? (
          <div className="flex flex-wrap gap-2">
            <RideActions
              compact
              rideId={ride.id}
              number={ride.number}
              canCancel={!TERMINAL.has(status)}
              canRedispatch={status === "NO_DRIVER_FOUND" || SEARCHING.has(status)}
              canAssign={ASSIGNABLE.has(status)}
              assignLabel={ride.driver_id ? "Réattribuer" : "Attribuer"}
              assignOpen={assignOpen}
              onAssignOpenChange={onAssignOpenChange}
              drivers={assignable}
            />
          </div>
        ) : null}

        {/* Chronologie */}
        {timeline.length > 0 && (
          <div>
            <p className="mb-2 text-[12px] font-medium text-fg-subtle">Chronologie</p>
            <ol className="space-y-1.5">
              {timeline.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 text-[12.5px]">
                  <span className="w-11 shrink-0 tabular-nums text-fg-subtle">{formatTime(e.created_at)}</span>
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", LEVEL_DOT[e.level] ?? "bg-fg-subtle")} />
                  <span className="text-fg-muted">{e.message}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <p className="text-[11.5px] text-fg-subtle">Paiement : {ride.payment_method ? (PAYMENT_METHOD_LABELS[ride.payment_method as PaymentMethod] ?? ride.payment_method) : "—"}</p>
      </div>
    </div>
  );
}
