"use client";
import { formatTime } from "@rydar/shared";
import { Terminal } from "lucide-react";
import { useState } from "react";
import { useAlerts } from "@/components/alerts/dispatch-alerts";
import { timelineLabel } from "@/components/rides/timeline-labels";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";

export type TimelineEvent = {
  id: number;
  category: "timeline" | "dispatch" | "system";
  level: "debug" | "info" | "success" | "warning" | "error";
  type: string;
  message: string;
  actor_type: string;
  data: Record<string, unknown>;
  created_at: string;
};

const LEVEL = {
  debug: { dot: "bg-fg-subtle", text: "text-fg-muted" },
  info: { dot: "bg-blue", text: "text-fg" },
  success: { dot: "bg-brand", text: "text-brand" },
  warning: { dot: "bg-amber", text: "text-amber" },
  error: { dot: "bg-red", text: "text-red" },
};

// `tenant` : déjà dans le libellé (« Organisation : … ») ; jamais le mot technique à l'écran
const HIDDEN_KEYS = new Set(["driver_ids", "tenant"]);

/** Données techniques d'un événement (« clé=valeur »), seulement dans « Détails techniques ». */
export function DataChips({ data, className }: { data: Record<string, unknown> | null | undefined; className?: string }) {
  const entries = Object.entries(data ?? {}).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && typeof v !== "object");
  if (!entries.length) return null;
  return (
    <div className={cn("mt-1.5 flex flex-wrap gap-1", className)}>
      {entries.slice(0, 6).map(([k, v]) => (
        <span key={k} className="num max-w-full break-all rounded border border-line bg-white/[0.03] px-1.5 py-0.5 text-[12px] text-fg-subtle">
          {k}=<span className="text-fg-muted">{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Chronologie d'une course, dans les mots du métier (timeline-labels.ts). « Détails techniques » (coupé par défaut)
 * ajoute les étapes internes de la recherche et leurs données. `technicalView` faux (Flotte Privée) : chronologie
 * limitée à la catégorie « timeline » (dont les étapes dispatch.private_* de la réservation), sans détails techniques.
 */
export function RideTimeline({ events, timeZone, technicalView = true }: { events: TimelineEvent[]; timeZone: string; technicalView?: boolean }) {
  const [technicalOn, setTechnical] = useState(false);
  const privateFleet = useAlerts()?.privateFleet ?? !technicalView;
  const technical = technicalView && technicalOn;
  const shown = events.filter((e) => technical || e.category === "timeline");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-fg-muted">{plural(shown.length, "événement")}</p>
        {technicalView && (
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-[12.5px] text-fg-muted">
            <Terminal aria-hidden className="size-3.5" /> Détails techniques
            <Switch checked={technicalOn} onCheckedChange={setTechnical} />
          </label>
        )}
      </div>
      <ol className="relative">
        {shown.map((e, i) => {
          const lvl = LEVEL[e.level] ?? LEVEL.info;
          const tech = e.category !== "timeline";
          return (
            <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0 sm:gap-4">
              <span className="num w-[62px] shrink-0 pt-px text-right text-[12px] text-fg-muted">{formatTime(e.created_at, timeZone, true)}</span>
              <span aria-hidden className="relative flex w-3 shrink-0 justify-center">
                {i < shown.length - 1 && <span className="absolute top-3 h-[calc(100%+4px)] w-px bg-line-strong" />}
                <span className={cn("relative mt-1.5 size-2 rounded-full", tech ? "bg-ink-400" : lvl.dot)} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13px] leading-snug [overflow-wrap:anywhere]", tech ? "num text-[12px] text-fg-muted" : e.level === "info" ? "text-fg" : lvl.text)}>
                  {timelineLabel(e, { privateFleet, timeZone })}
                </p>
                {technical && <DataChips data={e.data} />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
