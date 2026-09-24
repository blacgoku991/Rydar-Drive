"use client";
import { formatTime } from "@rydar/shared";
import { Terminal } from "lucide-react";
import { useState } from "react";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

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
  debug: { dot: "bg-fg-subtle", text: "text-fg-subtle" },
  info: { dot: "bg-blue", text: "text-fg" },
  success: { dot: "bg-brand shadow-[0_0_10px_var(--color-brand)]", text: "text-brand" },
  warning: { dot: "bg-amber shadow-[0_0_10px_var(--color-amber)]", text: "text-amber" },
  error: { dot: "bg-red shadow-[0_0_10px_var(--color-red)]", text: "text-red" },
};

const HIDDEN_KEYS = new Set(["driver_ids"]);

function DataChips({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data ?? {}).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && typeof v !== "object");
  if (!entries.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {entries.slice(0, 6).map(([k, v]) => (
        <span key={k} className="num rounded border border-line bg-white/[0.03] px-1.5 py-0.5 text-[10.5px] text-fg-subtle">
          {k}=<span className="text-fg-muted">{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

export function RideTimeline({ events, timeZone }: { events: TimelineEvent[]; timeZone: string }) {
  const [technical, setTechnical] = useState(false);
  const shown = events.filter((e) => technical || e.category === "timeline");
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] text-fg-subtle">
          <span className="num text-fg-muted">{shown.length}</span> événements
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted">
          <Terminal className="size-3.5" /> Vue technique
          <Switch checked={technical} onCheckedChange={setTechnical} />
        </label>
      </div>
      <ol className="relative">
        {shown.map((e, i) => {
          const lvl = LEVEL[e.level] ?? LEVEL.info;
          const tech = e.category !== "timeline";
          return (
            <li key={e.id} className="relative flex gap-4 pb-4 last:pb-0">
              <span className="num w-[62px] shrink-0 pt-px text-right text-[12px] text-fg-subtle">{formatTime(e.created_at, timeZone, true)}</span>
              <span className="relative flex w-3 shrink-0 justify-center">
                {i < shown.length - 1 && <span className="absolute top-3 h-[calc(100%+4px)] w-px bg-line-strong" />}
                <span className={cn("relative mt-1.5 size-2 rounded-full", tech ? "bg-ink-400" : lvl.dot)} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13px] leading-snug", tech ? "num text-[12px] text-fg-subtle" : e.level === "info" ? "text-fg" : lvl.text)}>{e.message}</p>
                {technical && <DataChips data={e.data} />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
