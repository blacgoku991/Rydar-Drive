// Suivi de vol (migration 002100) : badge compact, heure de prise en charge décalée, détail du vol.
// Sans état ni hook : utilisable côté serveur (fiche course) comme côté client (command center).
import { FLIGHT_STATUS_META, flightBadge, flightCode, formatDelay, formatRideDate, formatTime, type FlightMode, type FlightStatus } from "@rydar/shared";
import { Plane, PlaneLanding } from "lucide-react";
import { toneBg, toneText } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type FlightRide = {
  flight_number?: string | null;
  flight_mode?: FlightMode | null;
  flight_status?: FlightStatus | null;
  flight_scheduled_arrival?: string | null;
  flight_estimated_arrival?: string | null;
  flight_actual_arrival?: string | null;
  flight_delay_minutes?: number | null;
  flight_terminal?: string | null;
  flight_origin?: string | null;
  flight_checked_at?: string | null;
  pickup_at: string;
  pickup_at_original?: string | null;
};

/** Décalage automatique de la prise en charge (minutes), null s'il n'y en a pas. */
export function pickupShiftMinutes(r: Pick<FlightRide, "pickup_at" | "pickup_at_original">): number | null {
  if (!r.pickup_at_original) return null;
  const m = Math.round((Date.parse(r.pickup_at) - Date.parse(r.pickup_at_original)) / 60_000);
  return m === 0 ? null : m;
}

/** « ✈ AF1234 · +35 min », « AF1234 · atterri 14:52 · T2E », « AF1234 · annulé ». */
export function FlightChip({ ride, timeZone, className }: { ride: FlightRide; timeZone?: string; className?: string }) {
  const b = flightBadge(ride, timeZone);
  if (!b) return null;
  const Icon = ride.flight_status === "landed" ? PlaneLanding : Plane;
  return (
    <span
      className={cn("inline-flex h-5 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium tabular-nums", toneBg[b.tone], toneText[b.tone], className)}
      title={ride.flight_status ? `Vol ${flightCode(ride.flight_number)} · ${FLIGHT_STATUS_META[ride.flight_status].label}` : `Vol ${flightCode(ride.flight_number)} · suivi en attente`}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{b.text}</span>
    </span>
  );
}

/** Heure de prise en charge ; si le vol l'a décalée : ancienne heure barrée + nouvelle en évidence. */
export function PickupTime({ ride, timeZone, withDate }: { ride: FlightRide; timeZone?: string; withDate?: boolean }) {
  const shift = pickupShiftMinutes(ride);
  const fmt = (d: string) => (withDate ? formatRideDate(d, timeZone) : formatTime(d, timeZone));
  if (!shift) return <>{fmt(ride.pickup_at)}</>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <s className="font-normal text-fg-subtle decoration-fg-subtle/80">{formatTime(ride.pickup_at_original, timeZone)}</s>
      <span className="font-semibold text-amber">{fmt(ride.pickup_at)}</span>
    </span>
  );
}

function Row({ k, children, strong }: { k: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[12px] text-fg-subtle">{k}</span>
      <span className={cn("min-w-0 truncate text-right text-[13px] tabular-nums", strong ? "font-semibold text-fg" : "text-fg-muted")}>{children}</span>
    </div>
  );
}

function ago(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h`;
}

/** Détail du vol : statut, horaires prévu / estimé / réel, terminal, provenance, décalage de la prise en charge. */
export function FlightDetails({ ride, timeZone, now = Date.now(), className }: { ride: FlightRide; timeZone?: string; now?: number; className?: string }) {
  const code = flightCode(ride.flight_number);
  if (!code) return null;
  const departure = ride.flight_mode === "departure";
  const status = ride.flight_status ?? null;
  const meta = status ? FLIGHT_STATUS_META[status] : null;
  const delay = ride.flight_delay_minutes ?? null;
  const shift = pickupShiftMinutes(ride);
  const t = (d: string | null | undefined) => (d ? formatTime(d, timeZone) : "—");
  const Icon = status === "landed" ? PlaneLanding : Plane;
  const tone = meta?.tone ?? "neutral";

  return (
    <div className={cn("overflow-hidden rounded-xl border border-line", className)}>
      <div className={cn("flex items-center gap-2.5 px-3.5 py-2.5", toneBg[tone])}>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-ink-900/40", toneText[tone])}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold tracking-tight text-fg">
            Vol {code}
            {ride.flight_origin && <span className="font-normal text-fg-muted"> · {departure ? "vers" : "de"} {ride.flight_origin}</span>}
          </p>
          <p className={cn("text-[12px] font-medium", toneText[tone])}>
            {meta ? meta.label : "Suivi en attente"}
            {delay != null && Math.abs(delay) >= 5 && status !== "cancelled" && status !== "diverted" ? ` · ${formatDelay(delay)}` : ""}
            {departure ? " · au départ" : ""}
          </p>
        </div>
      </div>
      <div className="divide-y divide-line px-3.5">
        {ride.flight_scheduled_arrival || ride.flight_estimated_arrival || ride.flight_actual_arrival ? (
          <>
            <Row k={departure ? "Départ prévu" : "Arrivée prévue"}>{t(ride.flight_scheduled_arrival)}</Row>
            {ride.flight_actual_arrival ? (
              <Row k={departure ? "Parti à" : "Atterri à"} strong>{t(ride.flight_actual_arrival)}</Row>
            ) : ride.flight_estimated_arrival && ride.flight_estimated_arrival !== ride.flight_scheduled_arrival ? (
              <Row k={departure ? "Départ estimé" : "Arrivée estimée"} strong>{t(ride.flight_estimated_arrival)}</Row>
            ) : null}
          </>
        ) : (
          <Row k="Horaires">en attente de la compagnie</Row>
        )}
        {ride.flight_terminal && <Row k="Terminal">{ride.flight_terminal.replace(/^T(?=\d)/i, "")}</Row>}
        <Row k="Prise en charge" strong={!!shift}>
          {shift ? (
            <span className="inline-flex items-baseline gap-1.5">
              <s className="text-fg-subtle">{t(ride.pickup_at_original)}</s>
              <span className="text-amber">{t(ride.pickup_at)}</span>
              <span className="text-[11.5px] font-normal text-fg-subtle">({formatDelay(shift)})</span>
            </span>
          ) : (
            t(ride.pickup_at)
          )}
        </Row>
      </div>
      <p className="border-t border-line px-3.5 py-2 text-[11.5px] text-fg-subtle">
        {departure
          ? "Vol au départ : information seulement, la prise en charge ne bouge pas."
          : shift
            ? "La prise en charge suit l'arrivée du vol ; le chauffeur est prévenu."
            : "La prise en charge suivra automatiquement l'arrivée du vol."}
        {ride.flight_checked_at ? ` Vérifié ${ago(ride.flight_checked_at, now)}.` : ""}
      </p>
    </div>
  );
}
