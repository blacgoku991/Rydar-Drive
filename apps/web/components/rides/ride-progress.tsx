import { formatTime } from "@rydar/shared";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

type RideTimes = {
  status: string;
  created_at: string;
  accepted_at?: string | null;
  driver_en_route_at?: string | null;
  driver_arrived_at?: string | null;
  passenger_onboard_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  no_driver_at?: string | null;
};

const STEPS: { key: keyof RideTimes; label: string }[] = [
  { key: "created_at", label: "Reçue" },
  { key: "accepted_at", label: "Acceptée" },
  { key: "driver_en_route_at", label: "En route" },
  { key: "driver_arrived_at", label: "Arrivé" },
  { key: "passenger_onboard_at", label: "Client à bord" },
  { key: "completed_at", label: "Terminée" },
];

/** Progression visuelle d'une course, étape par étape, avec l'heure de chaque étape. */
export function RideProgress({ ride, timeZone }: { ride: RideTimes; timeZone?: string }) {
  const failed = ride.status === "CANCELLED" || ride.status === "NO_DRIVER_FOUND";
  const failedAt = ride.cancelled_at ?? ride.no_driver_at;
  let lastDone = -1;
  STEPS.forEach((s, i) => {
    if (ride[s.key]) lastDone = i;
  });
  return (
    <ol className="grid grid-cols-6 gap-1.5">
      {STEPS.map((s, i) => {
        const at = ride[s.key] as string | null | undefined;
        const done = !!at;
        const current = !failed && i === lastDone + 1;
        const failHere = failed && i === lastDone + 1;
        return (
          <li key={s.key} className="min-w-0">
            <div
              className={cn(
                "h-1 rounded-full",
                done ? "bg-brand" : failHere ? "bg-red" : current ? "animate-breathe bg-amber" : "bg-white/[0.08]",
              )}
            />
            <p className={cn("mt-2 flex items-center gap-1 truncate text-[12px]", done ? "text-fg" : failHere ? "text-red" : current ? "text-amber" : "text-fg-subtle")}>
              {done && <Check className="size-3 shrink-0 text-brand" />}
              {failHere && <X className="size-3 shrink-0" />}
              {failHere ? (ride.status === "CANCELLED" ? "Annulée" : "Sans chauffeur") : s.label}
            </p>
            <p className="text-[11.5px] tabular-nums text-fg-subtle">
              {at ? formatTime(at, timeZone) : failHere && failedAt ? formatTime(failedAt, timeZone) : current ? "en cours" : "—"}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
