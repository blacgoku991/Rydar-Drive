"use client";
import { formatDate, formatTime, slugify } from "@rydar/shared";
import { Pause, Play, Search, Terminal } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

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

const LEVEL_STYLE: Record<string, string> = {
  debug: "text-fg-subtle",
  info: "text-fg",
  success: "text-brand",
  warning: "text-amber",
  error: "text-red",
};
const LEVEL_TAG: Record<string, string> = {
  debug: "DBG",
  info: "INF",
  success: "OK ",
  warning: "WRN",
  error: "ERR",
};

export function DispatchJournal({ initial, tenant, timeZone, rideNumbers }: { initial: JournalEvent[]; tenant: string; timeZone: string; rideNumbers: Record<string, number> }) {
  const [events, setEvents] = useState(initial);
  const [paused, setPaused] = useState(false);
  const [showDebug, setShowDebug] = useState(true);
  const [showSystem, setShowSystem] = useState(false);
  const [level, setLevel] = useState<"all" | "warning" | "error">("all");
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

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase().replace("#", "");
    return events.filter((e) => {
      if (!showDebug && e.level === "debug") return false;
      if (!showSystem && e.category === "system") return false;
      if (level === "warning" && !["warning", "error"].includes(e.level)) return false;
      if (level === "error" && e.level !== "error") return false;
      if (query) {
        const num = e.ride_id ? String(numbers[e.ride_id] ?? "") : "";
        if (!e.message.toLowerCase().includes(query) && num !== query && !e.type.includes(query)) return false;
      }
      return true;
    });
  }, [events, showDebug, showSystem, level, q, numbers]);

  let lastDay = "";
  return (
    <div className="surface overflow-hidden rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Terminal className="size-4 text-brand" />
          <span className="num text-[12.5px] text-fg-muted">dispatch@{slugify(tenant)}</span>
          <span className={cn("ml-1 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]", status === "live" && !paused ? "border-brand/30 text-brand" : "border-amber/30 text-amber")}>
            <span className={cn("size-1.5 rounded-full", status === "live" && !paused ? "animate-breathe bg-brand" : "bg-amber")} />
            {paused ? "en pause" : status === "live" ? "flux temps réel" : "rechargement manuel"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="#course, message…" className="h-8 w-48 rounded-lg border border-line bg-ink-850 pl-8 pr-2 text-[12.5px] outline-none placeholder:text-fg-subtle focus:border-brand/50" />
          </div>
          <div className="flex rounded-lg border border-line bg-ink-850 p-0.5 text-[12px]">
            {(["all", "warning", "error"] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLevel(l)} className={cn("rounded-md px-2.5 py-1", level === l ? "bg-ink-600 text-fg" : "text-fg-muted")}>
                {l === "all" ? "Tout" : l === "warning" ? "Alertes" : "Erreurs"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-fg-muted">Debug <Switch checked={showDebug} onCheckedChange={setShowDebug} /></label>
          <label className="flex items-center gap-2 text-[12px] text-fg-muted">Présence <Switch checked={showSystem} onCheckedChange={setShowSystem} /></label>
          <button type="button" onClick={() => setPaused((p) => !p)} className="grid size-8 place-items-center rounded-lg border border-line text-fg-muted hover:text-fg" aria-label={paused ? "Reprendre" : "Pause"}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
        </div>
      </div>
      <div className="max-h-[calc(100dvh-260px)] min-h-[420px] overflow-y-auto bg-ink-950/60 px-2 py-2 font-mono text-[12.5px] leading-[1.75]">
        {shown.length === 0 && <p className="px-3 py-10 text-center text-fg-subtle">Aucun événement pour ces filtres.</p>}
        {shown.map((e) => {
          const day = formatDate(e.created_at, timeZone);
          const header = day !== lastDay;
          lastDay = day;
          const num = e.ride_id ? numbers[e.ride_id] : undefined;
          return (
            <div key={e.id}>
              {header && <div className="px-3 pb-1 pt-3 text-[12px] text-fg-subtle">— {day} —</div>}
              <div className={cn("group grid grid-cols-[84px_38px_76px_1fr] gap-3 rounded-md px-3 hover:bg-white/[0.03]", e.level === "error" && "bg-red/[0.05]")}>
                <span className="text-fg-subtle">{formatTime(e.created_at, timeZone, true)}</span>
                <span className={cn("text-[11px] font-semibold", LEVEL_STYLE[e.level])}>{LEVEL_TAG[e.level]}</span>
                <span className="truncate">
                  {e.ride_id && num ? (
                    <Link href={`/dashboard/rides/${e.ride_id}`} className="text-blue hover:underline">#{num}</Link>
                  ) : (
                    <span className="text-fg-subtle">{e.category === "system" ? "fleet" : "—"}</span>
                  )}
                </span>
                <span className={cn("min-w-0", e.category === "dispatch" ? "text-fg-muted" : LEVEL_STYLE[e.level])}>
                  {e.message}
                  {e.category !== "timeline" && Object.keys(e.data ?? {}).length > 0 && (
                    <span className="ml-2 hidden text-fg-subtle group-hover:inline">{JSON.stringify(e.data).slice(0, 140)}</span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
