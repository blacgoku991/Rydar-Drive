"use client";
import { PRESENCE_META, formatRelative, initials, type DriverPresence } from "@rydar/shared";
import { Search } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { useSharedNow } from "@/hooks/use-now";
import type { LiveDriver, LiveRide } from "@/lib/queries/live";
import { cn } from "@/lib/utils";

const ORDER: DriverPresence[] = ["available", "offered", "en_route", "arrived", "on_trip", "offline"];

/**
 * Flotte : filtres par état (compteurs), recherche, liste compacte. `embedded` : affichée dans le panneau des courses
 * (segment « Chauffeurs », sous 1280 px) — sans son titre, déjà donné par le segment.
 */
export function FleetPanel({
  drivers,
  rides,
  selectedId,
  onSelect,
  now,
  staleMs = 180_000,
  embedded = false,
  className,
}: {
  drivers: LiveDriver[];
  rides: Record<string, LiveRide>;
  selectedId: string | null;
  /** Fonction stable de préférence : seules les lignes dont les données changent sont re-rendues. */
  onSelect: (id: string) => void;
  /** Heure de repli (rendu serveur, hydratation) ; « vu il y a » suit ensuite sa propre horloge d'une seconde. */
  now: number;
  staleMs?: number;
  embedded?: boolean;
  className?: string;
}) {
  const [filter, setFilter] = useState<DriverPresence | "online">("online");
  const [q, setQ] = useState("");
  const counts = useMemo(() => Object.fromEntries(ORDER.map((p) => [p, drivers.filter((d) => d.presence === p).length])) as Record<DriverPresence, number>, [drivers]);
  const online = drivers.length - counts.offline;

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return drivers
      .filter((d) => (filter === "online" ? d.presence !== "offline" : d.presence === filter))
      .filter((d) => !term || `${d.first_name} ${d.last_name} ${d.vehicle?.plate ?? ""} ${d.number}`.toLowerCase().includes(term))
      .sort((a, b) => ORDER.indexOf(a.presence) - ORDER.indexOf(b.presence) || a.first_name.localeCompare(b.first_name));
  }, [drivers, filter, q]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className={cn("space-y-3 pb-3", embedded ? "px-3 pt-0" : "px-4 pt-4")}>
        {!embedded && (
          <div className="flex items-baseline justify-between">
            <h2 className="text-[14px] font-semibold tracking-tight">Flotte</h2>
            <span className="text-[12px] text-fg-muted">
              <span className="font-medium text-fg">{online}</span> en ligne sur {drivers.length}
            </span>
          </div>
        )}
        <div role="group" aria-label="Filtrer les chauffeurs" className="flex flex-wrap gap-1">
          <Chip active={filter === "online"} onClick={() => setFilter("online")} label="En ligne" n={online} />
          {ORDER.map((p) =>
            counts[p] ? <Chip key={p} active={filter === p} onClick={() => setFilter(p)} label={PRESENCE_META[p].label} n={counts[p]} color={PRESENCE_COLOR[p]} /> : null,
          )}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nom, plaque, n°"
            aria-label="Rechercher un chauffeur" title="Rechercher un chauffeur"
            className="h-9 w-full rounded-lg border border-line-field bg-white/[0.04] pl-8 pr-2 text-[13px] outline-none placeholder:text-fg-subtle focus:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-brand/70"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.map((d) => (
          <FleetRow
            key={d.id}
            d={d}
            rideNumber={d.current_ride_id ? rides[d.current_ride_id]?.number : undefined}
            selected={selectedId === d.id}
            onSelect={onSelect}
            fallbackNow={now}
            staleMs={staleMs}
          />
        ))}
        {!list.length && <p className="px-3 py-8 text-center text-[12.5px] text-fg-muted">Aucun chauffeur dans ce filtre.</p>}
      </div>
    </div>
  );
}

/** « vu il y a 12 s », « vu il y a 46 min », « vu hier » : position reçue ; « vu à l'instant » sous 5 s (ou horloge en avance). */
function seenAgoLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "sans position";
  if (now - t < 5_000) return "vu à l'instant";
  return `vu ${formatRelative(iso, new Date(now))}`;
}

/** Âge de la dernière position : seule partie de la ligne rafraîchie chaque seconde (horloge commune). */
function SeenAgo({ d, fallbackNow, staleMs }: { d: LiveDriver; fallbackNow: number; staleMs: number }) {
  const now = useSharedNow(1000, fallbackNow);
  const stale = d.location ? now - new Date(d.location.updated_at).getTime() > staleMs : true;
  return (
    <span className={cn("shrink-0 text-[12px] tabular-nums", stale && d.presence !== "offline" ? "text-amber" : "text-fg-muted")}>
      {d.location ? seenAgoLabel(d.location.updated_at, now) : "sans position"}
    </span>
  );
}

const FleetRow = memo(function FleetRow({
  d,
  rideNumber,
  selected,
  onSelect,
  fallbackNow,
  staleMs,
}: {
  d: LiveDriver;
  rideNumber: number | undefined;
  selected: boolean;
  onSelect: (id: string) => void;
  fallbackNow: number;
  staleMs: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(d.id)}
      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors", selected ? "bg-white/[0.07]" : "hover:bg-white/[0.035]")}
    >
      <span className="relative shrink-0">
        <span aria-hidden className="grid size-8 place-items-center rounded-full bg-ink-600 text-[12px] font-semibold text-fg-muted">{initials(d.first_name, d.last_name)}</span>
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-ink-800" style={{ background: PRESENCE_COLOR[d.presence] }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">
          {d.first_name} {d.last_name}
        </span>
        {d.network_giver ? (
          // Réseau partagé : course d'une autre organisation, sans position (Q5)
          <span className="block truncate text-[12px] text-violet">En course partenaire ({d.network_giver})</span>
        ) : (
          <span className="block truncate text-[12px] text-fg-muted">
            {rideNumber != null ? `${PRESENCE_META[d.presence].label} · #${rideNumber}` : d.vehicle ? `${d.vehicle.model} · ${d.vehicle.plate}` : "Sans véhicule"}
          </span>
        )}
      </span>
      {d.network_giver ? <span className="shrink-0 text-[12px] text-fg-subtle">—</span> : <SeenAgo d={d} fallbackNow={fallbackNow} staleMs={staleMs} />}
    </button>
  );
});

function Chip({ active, onClick, label, n, color }: { active: boolean; onClick: () => void; label: string; n: number; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors",
        active ? "bg-white/[0.1] text-fg" : "text-fg-muted hover:bg-white/[0.05] hover:text-fg",
      )}
    >
      {color && <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />}
      {label}
      <span className="tabular-nums text-fg-subtle">{n}</span>
    </button>
  );
}
