"use client";
import { DEFAULT_DISPATCH_RADII_M, RIDE_STATUS_META, dateTimeFormat, formatDistance, formatPrice, formatTime, shortAddress, type RideStatus } from "@rydar/shared";
import { BellOff, CalendarClock } from "lucide-react";
import { memo } from "react";
import { ALERT_ICON, alertLabel, severityColor } from "@/components/alerts/ride-alert-ui";
import { FlightChip, pickupShiftMinutes } from "@/components/rides/flight-info";
import { useCentrale } from "@/components/settlements/centrale-context";
import { toneDot, toneText } from "@/components/ui/badge";
import { useSharedNow } from "@/hooks/use-now";
import type { LiveAlert, LiveDriver, LiveRide } from "@/lib/queries/live";
import { cn } from "@/lib/utils";

export const SEARCHING = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED"]);
export const TERMINAL = new Set(["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"]);

/** Fuseau de la centrale (Réglages), comme la liste Courses et la fiche ; Paris hors tableau de bord. */
const DEFAULT_TZ = "Europe/Paris";
const dayKey = (t: number, tz: string) => dateTimeFormat("fr-CA", { timeZone: tz }).format(new Date(t));

function dayLabel(iso: string, now: number, tz: string) {
  const t = new Date(iso).getTime();
  const k = dayKey(t, tz);
  if (k === dayKey(now, tz)) return null;
  if (k === dayKey(now + 86_400_000, tz)) return "Demain";
  if (k === dayKey(now - 86_400_000, tz)) return "Hier";
  return dateTimeFormat("fr-FR", { weekday: "short", day: "numeric", timeZone: tz }).format(new Date(t));
}

const remainingS = (nextDispatchAt: string, now: number) => Math.max(0, (new Date(nextDispatchAt).getTime() - now) / 1000);

/** Secondes avant la vague suivante (« · 23 s ») : seule partie de la ligne rafraîchie chaque seconde. */
function WaveCountdown({ at, fallbackNow }: { at: string; fallbackNow: number }) {
  const remaining = remainingS(at, useSharedNow(1000, fallbackNow));
  return remaining > 0 ? <>{` · ${Math.ceil(remaining)} s`}</> : null;
}

/** Barre de progression de la vague en cours (même horloge d'une seconde). */
function WaveBar({ at, timeout, fallbackNow }: { at: string; timeout: number; fallbackNow: number }) {
  const pct = Math.min(100, (remainingS(at, useSharedNow(1000, fallbackNow)) / timeout) * 100);
  if (!(pct > 0)) return null;
  return (
    <span className="absolute inset-x-3 bottom-0 h-[2px] overflow-hidden rounded-full bg-white/[0.05]">
      <span className="block h-full bg-amber transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
    </span>
  );
}

type Props = {
  ride: LiveRide;
  driver?: LiveDriver;
  offers: number;
  selected: boolean;
  /** Reçoit l'identifiant de la course (fonction stable : la ligne n'est re-rendue que si ses données changent). */
  onSelect: (id: string) => void;
  /** Horloge de la liste (jour affiché) ; le compte à rebours de la vague a sa propre horloge d'une seconde. */
  now: number;
  timeout: number;
  alert?: LiveAlert;
  /** Réseau partagé (A) : « Réseau · Flotte B » (course tenue par un partenaire) ou « proposée au réseau partagé » */
  networkLabel?: string | null;
};

/** Ligne de course : heure, trajet, statut en clair, prix — plus le vol suivi et l'alerte de suivi s'il y en a. */
function RideRowView({ ride, driver, offers, selected, onSelect, now, timeout, alert, networkLabel }: Props) {
  const status = ride.status as RideStatus;
  const meta = RIDE_STATUS_META[status] ?? { label: status, tone: "neutral" as const };
  const searching = SEARCHING.has(status);
  const geo = ride.type === "instant" || ride.dispatch_mode === "geo";
  const countdown = searching && geo && ride.next_dispatch_at ? ride.next_dispatch_at : null;
  const tz = useCentrale()?.timeZone || DEFAULT_TZ;
  const day = dayLabel(ride.pickup_at, now, tz);
  const shifted = pickupShiftMinutes(ride) != null;
  const openAlert = alert?.status === "open" ? alert : null;
  const alertColor = openAlert ? severityColor(openAlert.severity) : null;
  const AlertIcon = alert ? ALERT_ICON[alert.kind] : null;

  let detail: string | null = null;
  if (searching) {
    detail = networkLabel
      ? networkLabel
      : geo
        ? `${offers} offre${offers > 1 ? "s" : ""} · rayon ${formatDistance(ride.dispatch_radius_m ?? DEFAULT_DISPATCH_RADII_M[0])}`
        : `proposée à la flotte · ${offers} chauffeur${offers > 1 ? "s" : ""}`;
  } else if (networkLabel) {
    // Chauffeur partenaire : son organisation, jamais de marqueur ni de position (v1)
    detail = networkLabel;
  } else if (driver) {
    detail = `${driver.first_name} ${driver.last_name.charAt(0)}. · ${driver.vehicle?.plate ?? ""}`;
  } else if (status === "NO_DRIVER_FOUND") {
    detail = "à relancer ou attribuer";
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(ride.id)}
      className={cn(
        "group relative w-full overflow-hidden rounded-xl px-3 py-3 text-left transition-colors",
        selected ? "bg-white/[0.07]" : openAlert ? "bg-white/[0.025] hover:bg-white/[0.045]" : "hover:bg-white/[0.035]",
      )}
    >
      {alertColor && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full" style={{ background: alertColor }} />}
      <div className="flex gap-3">
        <div className="w-11 shrink-0 pt-px">
          {shifted ? (
            <>
              <p className="text-[14px] font-semibold tabular-nums tracking-tight text-amber">{formatTime(ride.pickup_at, tz)}</p>
              <p className="text-[11px] tabular-nums text-fg-subtle line-through decoration-fg-subtle/80" title="Heure demandée, décalée par le vol">
                {formatTime(ride.pickup_at_original, tz)}
              </p>
            </>
          ) : (
            <p className="text-[14px] font-semibold tabular-nums tracking-tight text-fg">{formatTime(ride.pickup_at, tz)}</p>
          )}
          {day ? (
            <p className="text-[11px] text-violet">{day}</p>
          ) : ride.type === "scheduled" && !shifted ? (
            <CalendarClock className="mt-0.5 size-3 text-violet" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-fg">{shortAddress(ride.pickup_address)}</p>
          <p className="truncate text-[13px] text-fg-muted">→ {shortAddress(ride.dropoff_address)}</p>
          <p className={cn("mt-1.5 flex items-center gap-1.5 text-[12px]", toneText[meta.tone])}>
            <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[meta.tone], searching && "animate-breathe")} />
            <span className="shrink-0 font-medium">{meta.label}</span>
            {detail && (
              <span className={cn("truncate", networkLabel ? "text-violet" : "text-fg-subtle")}>
                · {detail}
                {countdown && <WaveCountdown at={countdown} fallbackNow={now} />}
              </span>
            )}
          </p>
          {ride.flight_number && (
            <div className="mt-1.5 flex min-w-0">
              <FlightChip ride={ride} timeZone={tz} />
            </div>
          )}
          {alert && AlertIcon && (
            <p
              className={cn("mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] font-medium", !openAlert && "text-fg-subtle")}
              style={openAlert ? { color: alertColor! } : undefined}
              title={alert.message}
            >
              {openAlert ? <AlertIcon className="size-3.5 shrink-0" /> : <BellOff className="size-3 shrink-0" />}
              <span className="truncate">{openAlert ? alert.message || alertLabel(alert.kind) : `${alertLabel(alert.kind)} · chauffeur gardé`}</span>
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[14px] font-semibold tabular-nums text-fg">{formatPrice(ride.price_cents)}</p>
          <p className="text-[11px] text-fg-subtle">#{ride.number}</p>
        </div>
      </div>
      {countdown && <WaveBar at={countdown} timeout={timeout} fallbackNow={now} />}
    </button>
  );
}

/** Le chauffeur n'est comparé que sur ce que la ligne affiche : un point GPS ne la re-rend pas. */
const sameDriver = (a?: LiveDriver, b?: LiveDriver) =>
  a === b || (!!a && !!b && a.first_name === b.first_name && a.last_name === b.last_name && a.vehicle?.plate === b.vehicle?.plate);

export const RideRow = memo(
  RideRowView,
  (a, b) =>
    a.ride === b.ride &&
    sameDriver(a.driver, b.driver) &&
    a.offers === b.offers &&
    a.selected === b.selected &&
    a.onSelect === b.onSelect &&
    a.now === b.now &&
    a.timeout === b.timeout &&
    a.alert === b.alert &&
    a.networkLabel === b.networkLabel,
);
