"use client";
import { dateTimeFormat, formatTime } from "@rydar/shared";
import { Pause, Play, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import { DataChips } from "@/components/rides/ride-timeline";
import { timelineLabel } from "@/components/rides/timeline-labels";
import { toneDot, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { SwitchRow } from "@/components/ui/switch-row";
import { cn } from "@/lib/utils";
import { dispatchLevel, upperFirst } from "@/lib/wording";

export type JournalEvent = {
  id: number;
  ride_id: string | null;
  ride_number?: number | null;
  category: "timeline" | "dispatch" | "system";
  level: "debug" | "info" | "success" | "warning" | "error";
  type: string;
  message: string;
  actor_type: string;
  data: Record<string, unknown>;
  created_at: string;
};

type LevelFilter = "all" | "warning" | "error";
const LEVEL_FILTERS: { key: LevelFilter; label: string; title: string }[] = [
  { key: "all", label: "Tout", title: "Tous les événements" },
  { key: "warning", label: "Avertissements", title: "Avertissements et erreurs" },
  { key: "error", label: "Erreurs", title: "Erreurs seulement : courses restées sans chauffeur" },
];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** « samedi 10 octobre » (en-tête de jour du journal), dans le fuseau de l'organisation. */
function dayHeading(iso: string, timeZone: string) {
  return upperFirst(dateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone }).format(new Date(iso)));
}

/**
 * Journal du dispatch : ce qui s'est passé pour chaque course (chauffeurs prévenus, refus, attributions, alertes), en
 * temps réel. Lisible par défaut : niveaux en mots (pastille + mot), messages du métier ; les étapes internes et les
 * données techniques ne s'affichent qu'avec « Détails techniques » (Options avancées, coupé par défaut).
 */
export function DispatchJournal({ initial, timeZone, rideNumbers }: { initial: JournalEvent[]; timeZone: string; rideNumbers: Record<string, number> }) {
  const [events, setEvents] = useState(initial);
  const [paused, setPaused] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [q, setQ] = useState("");
  const status = useRealtimeStatus();
  const [numbers, setNumbers] = useState(rideNumbers);

  useRealtimeEvent("ride.event", (e: JournalEvent) => {
    if (paused) return;
    setEvents((list) => [e, ...list].slice(0, 500));
  });
  useRealtimeEvent("ride.updated", (r: { id: string; number: number }) => {
    if (r?.id && r.number) setNumbers((n) => (n[r.id] ? n : { ...n, [r.id]: r.number }));
  });

  const label = (e: JournalEvent) => timelineLabel(e, { timeZone });

  const shown = useMemo(() => {
    const query = fold(q.trim()).replace(/^#\s*/, "");
    return events.filter((e) => {
      if (!technical && e.level === "debug") return false;
      if (!showSystem && e.category === "system") return false;
      if (level === "warning" && !["warning", "error"].includes(e.level)) return false;
      if (level === "error" && e.level !== "error") return false;
      if (query) {
        const num = e.ride_id ? String(numbers[e.ride_id] ?? "") : "";
        const text = fold(`${timelineLabel(e, { timeZone })} ${e.message}`);
        if (!text.includes(query) && num !== query && !e.type.includes(query)) return false;
      }
      return true;
    });
  }, [events, technical, showSystem, level, q, numbers, timeZone]);

  const live = status === "live" && !paused;
  let lastDay = "";
  return (
    <div className="surface overflow-hidden rounded-xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
            live ? "border-brand/30 text-brand" : "border-amber/30 text-amber",
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", live ? "animate-breathe bg-brand" : "bg-amber")} />
          {paused ? "En pause" : status === "live" ? "En direct" : status === "connecting" ? "Connexion…" : "Hors connexion"}
        </span>
        <div className="relative min-w-[min(100%,12rem)] flex-1 sm:max-w-64">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={"ex. : #1671, Julien"}
            aria-label="Rechercher dans le journal"
            title="Rechercher dans le journal"
            className="h-9 w-full rounded-lg border border-line-field bg-ink-850 pl-8 pr-2 text-[13px] outline-none placeholder:text-fg-subtle focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </div>
        <div role="group" aria-label="Niveau des événements" className="flex rounded-lg border border-line bg-ink-850 p-0.5 text-[12.5px]">
          {LEVEL_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setLevel(f.key)}
              aria-pressed={level === f.key}
              title={f.title}
              className={cn("min-h-8 rounded-md px-2.5", level === f.key ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused} className="ml-auto">
          {paused ? <Play /> : <Pause />} {paused ? "Reprendre" : "Pause"}
        </Button>
      </div>
      <Disclosure
        title="Options avancées"
        hint={technical || showSystem ? "activées" : undefined}
        className="border-b border-line px-4"
        contentClassName="grid gap-2 pb-3 sm:grid-cols-2"
      >
        <SwitchRow
          title="Détails techniques"
          hintOn="Étapes internes de la recherche et données de chaque événement affichées."
          hintOff="Étapes internes de la recherche et données techniques masquées."
          checked={technical}
          onCheckedChange={setTechnical}
        />
        <SwitchRow
          title="Présence des chauffeurs"
          hintOn="Connexions et déconnexions de l'application affichées."
          hintOff="Connexions et déconnexions de l'application masquées."
          checked={showSystem}
          onCheckedChange={setShowSystem}
        />
      </Disclosure>
      <div className="max-h-[calc(100dvh-260px)] min-h-[420px] overflow-y-auto bg-ink-950/60 px-2 py-2 text-[13px] leading-relaxed">
        {shown.length === 0 && <p className="px-3 py-10 text-center text-fg-muted">Aucun événement pour ces filtres.</p>}
        {shown.map((e) => {
          const day = dayHeading(e.created_at, timeZone);
          const header = day !== lastDay;
          lastDay = day;
          const num = e.ride_id ? numbers[e.ride_id] : undefined;
          const lvl = dispatchLevel(e.level);
          const tech = e.category === "dispatch" || e.level === "debug";
          return (
            <div key={e.id}>
              {header && <p className="px-3 pb-1 pt-3 text-[12px] font-medium text-fg-muted">{day}</p>}
              {/* Téléphone : heure · niveau · course sur une ligne, message dessous ; à partir de 640 px, en colonnes */}
              <div
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-1.5 hover:bg-white/[0.03] sm:grid sm:grid-cols-[64px_100px_64px_minmax(0,1fr)] sm:items-start",
                  e.level === "error" && "bg-red/[0.05]",
                )}
              >
                <span className="tabular-nums text-[12.5px] text-fg-muted sm:pt-px">{formatTime(e.created_at, timeZone, true)}</span>
                <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] font-medium sm:pt-px", toneText[lvl.tone])}>
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDot[lvl.tone])} />
                  {lvl.label}
                </span>
                <span className="text-[12.5px]">
                  {e.ride_id && num ? (
                    // Cible de 24 px au moins (WCAG 2.5.8) ; sans préchargement (règle du tableau de bord)
                    <Link href={`/dashboard/rides/${e.ride_id}`} prefetch={false} className="inline-flex min-h-6 items-center tabular-nums text-blue hover:underline" aria-label={`Course ${num}`}>
                      #{num}
                    </Link>
                  ) : (
                    <span className="text-fg-muted">{e.category === "system" ? "Flotte" : "—"}</span>
                  )}
                </span>
                <div className="min-w-0 basis-full sm:basis-auto">
                  <p className={cn("[overflow-wrap:anywhere]", tech ? "text-fg-muted" : "text-fg")}>{label(e)}</p>
                  {technical && <DataChips data={e.data} className="mt-1" />}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
