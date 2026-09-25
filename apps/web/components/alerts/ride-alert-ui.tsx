"use client";
// Alertes de suivi (retard, immobile, GPS muet, pas démarrée) : éléments communs au toast, au bandeau du
// command center et à la fiche course. Les décisions restent à la centrale : Relancer (retirer la course
// au chauffeur et relancer la recherche), Réattribuer (choisir un autre chauffeur), Garder (sourdine 15 min).
import { RIDE_ALERT_META, type RideAlertKind, type RideAlertSeverity } from "@rydar/shared";
import { CirclePause, ClockAlert, Eye, Phone, RotateCw, SatelliteDish, TimerOff, UserCog, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { acknowledgeRideAlert, relaunchRide } from "@/app/dashboard/rides/actions";
import { getBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export const ALERT_ICON: Record<RideAlertKind, LucideIcon> = {
  late: ClockAlert,
  stalled: CirclePause,
  no_gps: SatelliteDish,
  not_started: TimerOff,
};

export const severityColor = (s: RideAlertSeverity | null | undefined) => (s === "critical" ? "var(--color-red)" : "var(--color-amber)");

export const alertLabel = (kind: RideAlertKind) => RIDE_ALERT_META[kind]?.label ?? "Alerte";

/** « à l'instant », « il y a 6 min », « il y a 2 h » */
export function agoFr(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  return `il y a ${h} h${s % 3600 >= 60 && h < 10 ? ` ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}` : ""}`;
}

// ---------------------------------------------------------------- numéro du chauffeur (lecture RLS, en cache)
const phones = new Map<string, Promise<string | null>>();
export function useDriverPhone(driverId: string | null | undefined, known?: string | null) {
  const [phone, setPhone] = useState<string | null>(known ?? null);
  useEffect(() => {
    if (known || !driverId) return;
    let p = phones.get(driverId);
    if (!p) {
      p = Promise.resolve(
        getBrowserClient()
          .from("drivers")
          .select("phone")
          .eq("id", driverId)
          .maybeSingle()
          .then(({ data }: { data: { phone: string | null } | null }) => data?.phone ?? null),
      ).catch(() => null);
      phones.set(driverId, p);
    }
    let alive = true;
    void p.then((v) => alive && setPhone(v));
    return () => {
      alive = false;
    };
  }, [driverId, known]);
  return known ?? phone;
}

// ---------------------------------------------------------------- ouverture de l'attribution manuelle
/** Ouvre la course dans le command center avec la fenêtre « Attribution manuelle ». */
export function openAssign(rideId: string) {
  if (window.location.pathname === "/dashboard") window.dispatchEvent(new CustomEvent("rydar:assign-ride", { detail: rideId }));
  else window.location.assign(`/dashboard?ride=${rideId}&assign=1`);
}

// ---------------------------------------------------------------- actions
type ActionAlert = { id: string; ride_id: string; driver_id: string | null; driverName?: string | null; rideNumber?: number | null };

/**
 * Relancer · Réattribuer · Garder · Appeler (· Voir).
 * `onDone` : l'alerte est traitée (toast à fermer) ; `onAssign` : remplace l'ouverture par défaut de l'attribution.
 */
export function AlertActionBar({
  alert,
  phone,
  onView,
  onDone,
  onAssign,
  size = "sm",
  className,
}: {
  alert: ActionAlert;
  phone?: string | null;
  onView?: () => void;
  onDone?: () => void;
  onAssign?: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const [busy, setBusy] = useState<"relaunch" | "keep" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const timer = useRef<number | null>(null);
  const tel = useDriverPhone(alert.driver_id, phone);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const who = alert.driverName || "le chauffeur";
  const label = alert.rideNumber ? `#${alert.rideNumber}` : "";

  const relaunch = async () => {
    if (!confirm) {
      setConfirm(true);
      timer.current = window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    setConfirm(false);
    setBusy("relaunch");
    const res = await relaunchRide(alert.ride_id, alert.driver_id, "Alerte de suivi");
    setBusy(null);
    if (res.ok && res.code === "RELAUNCHED") {
      toast.success(`Course ${label} retirée à ${who}`.replace("  ", " "), { description: "Nouvelle recherche lancée — il ne sera plus sollicité pour cette course." });
      onDone?.();
    } else if (res.ok) {
      toast.info(`Course ${label} retirée à ${who}`.replace("  ", " "), {
        description: "Dispatch automatique désactivé : attribuez-la à un chauffeur.",
        action: { label: "Attribuer", onClick: () => openAssign(alert.ride_id) },
        duration: 12_000,
      });
      onDone?.();
    } else if (res.code === "DRIVER_CHANGED") {
      toast.info("La course a déjà changé de chauffeur", { description: "Rien n'a été retiré : vérifiez la course avant d'agir." });
      onDone?.();
    } else toast.error(res.error);
  };

  const keep = async () => {
    setBusy("keep");
    const res = await acknowledgeRideAlert(alert.id);
    setBusy(null);
    if (res.ok) {
      toast.success(`On garde ${who}`, { description: "Alerte en sourdine 15 min." });
      onDone?.();
    } else toast.error(res.error);
  };

  // Tient sur une ligne jusqu'à 390 px de large (toast mobile)
  const h = size === "md" ? "h-8 px-3 text-[12.5px]" : "h-7 px-2 text-[12px] min-[420px]:px-2.5";
  const ico = size === "md" ? "size-8" : "size-7";
  return (
    <div className={cn("flex flex-wrap items-center gap-1 min-[420px]:gap-1.5", className)}>
      <button
        type="button"
        disabled={!!busy}
        onClick={relaunch}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-60",
          h,
          confirm ? "bg-red text-white hover:bg-red/90" : "bg-brand text-brand-fg hover:opacity-90",
        )}
        title="Retirer la course au chauffeur et relancer la recherche"
      >
        <RotateCw className={cn("size-3.5", busy === "relaunch" && "animate-spin")} />
        {confirm ? "Confirmer ?" : "Relancer"}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => (onAssign ? onAssign() : openAssign(alert.ride_id))}
        className={cn("inline-flex items-center gap-1.5 rounded-lg bg-white/[0.08] font-medium text-fg transition-colors hover:bg-white/[0.13] disabled:opacity-60", h)}
        title="Choisir un autre chauffeur"
      >
        <UserCog className="size-3.5" /> Réattribuer
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={keep}
        className={cn("inline-flex items-center rounded-lg font-medium text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-60", h)}
        title="Garder le chauffeur (sourdine 15 min)"
      >
        {busy === "keep" ? "…" : "Garder"}
      </button>
      <span className="ml-auto flex gap-1">
        {tel && (
          <a
            href={`tel:${tel}`}
            className={cn("grid place-items-center rounded-lg bg-white/[0.06] text-fg-muted transition-colors hover:bg-white/[0.12] hover:text-fg", ico)}
            aria-label={`Appeler ${who}`}
            title={`Appeler ${who}`}
          >
            <Phone className="size-3.5" />
          </a>
        )}
        {onView && (
          <button
            type="button"
            onClick={onView}
            // sur mobile, toucher le texte du toast ouvre déjà la course
            className={cn("hidden place-items-center rounded-lg bg-white/[0.06] text-fg-muted transition-colors hover:bg-white/[0.12] hover:text-fg min-[420px]:grid", ico)}
            aria-label="Voir la course"
            title="Voir la course"
          >
            <Eye className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}
