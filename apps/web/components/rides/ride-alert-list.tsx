"use client";
// Alertes de suivi d'une course (fiche course) : liste compacte, actions sur l'alerte encore ouverte.
import { formatTime, type RideAlertData, type RideAlertKind, type RideAlertResolution, type RideAlertSeverity, type RideAlertStatus } from "@rydar/shared";
import { BellOff, CheckCircle2 } from "lucide-react";
import { ALERT_ICON, AlertActionBar, agoFr, alertLabel, severityColor } from "@/components/alerts/ride-alert-ui";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

export type RideAlertRow = {
  id: string;
  ride_id: string;
  driver_id: string | null;
  kind: RideAlertKind;
  severity: RideAlertSeverity;
  message: string;
  data: Partial<RideAlertData> | null;
  status: RideAlertStatus;
  resolution: RideAlertResolution | null;
  muted_until: string | null;
  created_at: string;
  resolved_at: string | null;
};

const RESOLUTION: Record<RideAlertResolution, string> = {
  kept: "Chauffeur gardé",
  reassigned: "Réattribuée",
  relaunched: "Recherche relancée",
  auto_resolved: "Close d'elle-même",
};

export function RideAlertList({
  alerts,
  rideNumber,
  driverPhone,
  currentDriverId,
  timeZone,
}: {
  alerts: RideAlertRow[];
  rideNumber: number;
  driverPhone: string | null;
  currentDriverId: string | null;
  timeZone?: string;
}) {
  const now = useNow(30_000) ?? undefined;
  return (
    <ul className="divide-y divide-line">
      {alerts.map((a) => {
        const Icon = ALERT_ICON[a.kind];
        const open = a.status === "open";
        const color = open ? severityColor(a.severity) : "var(--color-fg-subtle)";
        return (
          <li key={a.id} className="py-3 first:pt-1 last:pb-0">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${color} 14%, transparent)`, color }}>
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-[13px]">
                  <span className={cn("font-semibold", !open && "text-fg-muted")} style={open ? { color } : undefined}>
                    {alertLabel(a.kind)}
                  </span>
                  {open && a.severity === "critical" && <span className="rounded bg-red/15 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-red">urgent</span>}
                  <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-fg-subtle" title={agoFr(a.created_at, now)}>
                    {formatTime(a.created_at, timeZone)}
                  </span>
                </p>
                <p className={cn("mt-0.5 text-[12.5px] leading-[18px]", open ? "text-fg" : "text-fg-muted")}>{a.message}</p>
                {!open && (
                  <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                    {a.status === "acknowledged" ? <BellOff className="size-3" /> : <CheckCircle2 className="size-3 text-green" />}
                    {a.status === "acknowledged"
                      ? `Gardé — sourdine jusqu'à ${formatTime(a.muted_until, timeZone)}`
                      : `${a.resolution ? RESOLUTION[a.resolution] : "Résolue"}${a.resolved_at ? ` à ${formatTime(a.resolved_at, timeZone)}` : ""}`}
                  </p>
                )}
              </div>
            </div>
            {open && (
              <AlertActionBar
                className="ml-11 mt-2.5"
                alert={{ id: a.id, ride_id: a.ride_id, driver_id: a.driver_id, driverName: a.data?.driver_name, rideNumber }}
                phone={a.driver_id && a.driver_id === currentDriverId ? driverPhone : undefined}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
