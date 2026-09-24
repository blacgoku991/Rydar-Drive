"use client";
import { DEFAULT_DISPATCH_RADII_M, RIDE_STATUS_META, formatDistance, formatPrice, formatTime, shortAddress, type RideStatus } from "@rydar/shared";
import { CalendarClock } from "lucide-react";
import { toneDot, toneText } from "@/components/ui/badge";
import type { LiveDriver, LiveRide } from "@/lib/queries/live";
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

/** Ligne de course : heure, trajet, statut en clair, prix — rien de superflu. */
export function RideRow({
  ride,
  driver,
  offers,
  selected,
  onSelect,
  now,
  timeout,
}: {
  ride: LiveRide;
  driver?: LiveDriver;
  offers: number;
  selected: boolean;
  onSelect: () => void;
  now: number;
  timeout: number;
}) {
  const status = ride.status as RideStatus;
  const meta = RIDE_STATUS_META[status] ?? { label: status, tone: "neutral" as const };
  const searching = SEARCHING.has(status);
  const remaining = ride.next_dispatch_at ? Math.max(0, (new Date(ride.next_dispatch_at).getTime() - now) / 1000) : 0;
  const pct = searching && ride.type === "instant" ? Math.min(100, (remaining / timeout) * 100) : 0;
  const day = dayLabel(ride.pickup_at, now);

  let detail: string | null = null;
  if (searching) {
    detail = ride.type === "instant"
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
        selected ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
      )}
    >
      <div className="flex gap-3">
        <div className="w-11 shrink-0 pt-px">
          <p className="text-[14px] font-semibold tabular-nums tracking-tight text-fg">{formatTime(ride.pickup_at)}</p>
          {day ? (
            <p className="text-[11px] text-violet">{day}</p>
          ) : ride.type === "scheduled" ? (
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
