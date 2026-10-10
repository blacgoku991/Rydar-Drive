import { formatTime } from "@rydar/shared";
import { Check, X } from "lucide-react";
import { PendingStepLabel } from "@/components/rides/ride-progress-label";
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

/** Course pas encore attribuée : seule l'étape « Reçue » est faite (même après une attribution retirée puis relancée). */
const PENDING = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED"]);

/**
 * Progression visuelle d'une course, étape par étape, avec l'heure de chaque étape. Course en recherche ou proposée :
 * l'étape courante est « Recherche d'un chauffeur » (« À attribuer » sans dispatch automatique, « À confirmer » pour
 * une réservation Flotte Privée), jamais « Acceptée · en cours ».
 */
export function RideProgress({ ride, timeZone }: { ride: RideTimes; timeZone?: string }) {
  const failed = ride.status === "CANCELLED" || ride.status === "NO_DRIVER_FOUND";
  const failedAt = ride.cancelled_at ?? ride.no_driver_at;
  const pending = PENDING.has(ride.status);
  const done = (i: number) => (pending ? i === 0 : !!ride[STEPS[i]!.key]);
  let lastDone = -1;
  STEPS.forEach((_, i) => {
    if (done(i)) lastDone = i;
  });
  return (
    // Mobile : deux rangées de trois étapes (libellés entiers, sur deux lignes au besoin) ; à partir de 640 px, une rangée
    <ol className="grid grid-cols-3 gap-x-1.5 gap-y-3 sm:grid-cols-6 sm:gap-y-0">
      {STEPS.map((s, i) => {
        const at = done(i) ? (ride[s.key] as string | null | undefined) : null;
        const isDone = done(i);
        const current = !failed && i === lastDone + 1;
        const failHere = failed && i === lastDone + 1;
        return (
          <li key={s.key} className="min-w-0" aria-current={current ? "step" : undefined}>
            <div
              className={cn(
                "h-1 rounded-full",
                isDone ? "bg-brand" : failHere ? "bg-red" : current ? "animate-breathe bg-amber" : "bg-white/[0.08]",
              )}
            />
            <p className={cn("mt-2 flex items-start gap-1 text-[12px] leading-snug", isDone ? "text-fg" : failHere ? "text-red" : current ? "text-amber" : "text-fg-muted")}>
              {isDone && <Check aria-hidden className="mt-[3px] size-3 shrink-0 text-brand" />}
              {failHere && <X aria-hidden className="mt-[3px] size-3 shrink-0" />}
              <span className="min-w-0">
                {failHere ? (ride.status === "CANCELLED" ? "Annulée" : "Sans chauffeur") : current && pending ? <PendingStepLabel manual={ride.status === "CREATED"} /> : s.label}
              </span>
            </p>
            <p className="text-[12px] tabular-nums text-fg-muted">
              {at ? formatTime(at, timeZone) : failHere && failedAt ? formatTime(failedAt, timeZone) : current ? "en cours" : "—"}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
