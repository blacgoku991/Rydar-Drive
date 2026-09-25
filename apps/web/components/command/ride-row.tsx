"use client";
import { DEFAULT_DISPATCH_RADII_M, RIDE_STATUS_META, formatDistance, formatPrice, formatTime, shortAddress, type RideStatus } from "@rydar/shared";
import { BellOff, CalendarClock } from "lucide-react";
import { ALERT_ICON, alertLabel, severityColor } from "@/components/alerts/ride-alert-ui";
import { FlightChip, pickupShiftMinutes } from "@/components/rides/flight-info";
import { toneDot, toneText } from "@/components/ui/badge";
import type { LiveAlert, LiveDriver, LiveRide } from "@/lib/queries/live";
import { cn } from "@/lib/utils";

export const SEARCHING = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED"]);
export const TERMINAL = new Set(["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"]);

const TZ = "Europe/Paris";
const dayKey = (t: number) => new Intl.DateTimeFormat("fr-CA", { timeZone: TZ }).format(new Date(t));

function dayLabel(iso: string, now: number) {
  const t = new Date(iso).getTime();
  const k = dayKey(t);
  if (k === dayKey(now)) return null;
  if (k === dayKey(now + 86_400_000)) return "Demain";
  if (k === dayKey(now - 86_400_000)) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", timeZone: TZ }).format(new Date(t));
}

/** Ligne de course : heure, trajet, statut en clair, prix — plus le vol suivi et l'alerte de suivi s'il y en a. */
export function RideRow({
  ride,
  driver,
  offers,
  selected,
  onSelect,
  now,
  timeout,
  alert,
}: {
  ride: LiveRide;
  driver?: LiveDriver;
  offers: number;
  selected: boolean;
  onSelect: () => void;
  now: number;
  timeout: number;
  alert?: LiveAlert;
}) {
  const status = ride.status as RideStatus;
  const meta = RIDE_STATUS_META[status] ?? { label: status, tone: "neutral" as const };
  const searching = SEARCHING.has(status);
  const geo = ride.type === "instant" || ride.dispatch_mode === "geo";
  const remaining = ride.next_dispatch_at ? Math.max(0, (new Date(ride.next_dispatch_at).getTime() - now) / 1000) : 0;
  const pct = searching && geo ? Math.min(100, (remaining / timeout) * 100) : 0;
  const day = dayLabel(ride.pickup_at, now);
  const shifted = pickupShiftMinutes(ride) != null;
  const openAlert = alert?.status === "open" ? alert : null;
  const alertColor = openAlert ? severityColor(openAlert.severity) : null;
  const AlertIcon = alert ? ALERT_ICON[alert.kind] : null;

  let detail: string | null = null;
  if (searching) {
    detail = geo
      ? `${offers} offre${offers > 1 ? "s" : ""} · rayon ${formatDistance(ride.dispatch_radius_m ?? DEFAULT_DISPATCH_RADII_M[0])}${remaining > 0 ? ` · ${Math.ceil(remaining)} s` : ""}`
      : `proposée à la flotte · ${offers} chauffeur${offers > 1 ? "s" : ""}`;
  } else if (driver) {
    detail = `${driver.first_name} ${driver.last_name.charAt(0)}. · ${driver.vehicle?.plate ?? ""}`;
  } else if (status === "NO_DRIVER_FOUND") {
    detail = "à relancer ou attribuer";
  }

  return (
    <button
      type="button"
      onClick={onSelect}
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
              <p className="text-[14px] font-semibold tabular-nums tracking-tight text-amber">{formatTime(ride.pickup_at)}</p>
              <p className="text-[11px] tabular-nums text-fg-subtle line-through decoration-fg-subtle/80" title="Heure demandée, décalée par le vol">
                {formatTime(ride.pickup_at_original)}
              </p>
            </>
          ) : (
            <p className="text-[14px] font-semibold tabular-nums tracking-tight text-fg">{formatTime(ride.pickup_at)}</p>
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
            {detail && <span className="truncate text-fg-subtle">· {detail}</span>}
          </p>
          {ride.flight_number && (
            <div className="mt-1.5 flex min-w-0">
              <FlightChip ride={ride} />
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
      {pct > 0 && (
        <span className="absolute inset-x-3 bottom-0 h-[2px] overflow-hidden rounded-full bg-white/[0.05]">
          <span className="block h-full bg-amber transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
        </span>
      )}
    </button>
  );
}
