"use client";
import {
  PRESENCE_META, RIDE_STATUS_META, formatDistance, formatPhone, formatPrice, formatRelative, formatRideDate, formatTime,
  initials, shortAddress, type DriverPresence, type OrgKpis, type PricingRule, type RideStatus,
} from "@rydar/shared";
import {
  AlertTriangle, CalendarClock, Crosshair, Eye, EyeOff, Phone, Plus, Radar, Search, Tag, Users, X, Zap,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { KpiStrip } from "@/components/command/kpi-strip";
import { FleetMap, type FleetMapHandle } from "@/components/map/fleet-map";
import { PRESENCE_COLOR, rideColor } from "@/components/map/map-theme";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import { NewRideSheet } from "@/components/rides/new-ride-sheet";
import { RideStatusBadge, RideTypeTag } from "@/components/rides/status";
import { Button } from "@/components/ui/button";
import { Tooltip, Kbd } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import type { LiveDriver, LiveOffer, LiveRide, LiveSnapshot } from "@/lib/queries/live";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------- état
type State = { drivers: Record<string, LiveDriver>; rides: Record<string, LiveRide>; offers: Record<string, LiveOffer>; kpis: OrgKpis | null };
type Action =
  | { type: "snapshot"; snapshot: LiveSnapshot }
  | { type: "kpis"; kpis: OrgKpis }
  | { type: "location"; payload: any }
  | { type: "driver"; payload: any }
  | { type: "ride"; payload: any }
  | { type: "offer"; payload: any };

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot":
      return { drivers: byId(action.snapshot.drivers), rides: byId(action.snapshot.rides), offers: byId(action.snapshot.offers), kpis: action.snapshot.kpis };
    case "kpis":
      return { ...state, kpis: action.kpis };
    case "location": {
      const p = action.payload;
      const d = state.drivers[p.driver_id];
      if (!d) return state;
      return {
        ...state,
        drivers: { ...state.drivers, [d.id]: { ...d, location: { lat: p.lat, lng: p.lng, heading: p.heading, speed_mps: p.speed, updated_at: p.updated_at } } },
      };
    }
    case "driver": {
      const p = action.payload;
      const d = state.drivers[p.id];
      if (!d) return state;
      return { ...state, drivers: { ...state.drivers, [d.id]: { ...d, presence: p.presence, status: p.status, current_ride_id: p.current_ride_id } } };
    }
    case "ride": {
      const p = action.payload;
      const prev = state.rides[p.id];
      return { ...state, rides: { ...state.rides, [p.id]: { ...(prev ?? {}), ...p } as LiveRide } };
    }
    case "offer": {
      const p = action.payload;
      const offers = { ...state.offers };
      if (p.status === "pending") offers[p.id] = { ...(offers[p.id] ?? {}), ...p };
      else delete offers[p.id];
      return { ...state, offers };
    }
  }
}

// ---------------------------------------------------------------------------- utilitaires UI
const SEARCHING = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED"]);
const TERMINAL = new Set(["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"]);

function LiveClock() {
  const now = useNow(1000);
  return <span className="num text-[13px] text-fg-muted">{now ? formatTime(new Date(now), undefined, true) : "--:--:--"}</span>;
}

function RideRoute({ from, to, compact }: { from: string; to: string; compact?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3">
      <div className="flex flex-col items-center pt-[5px]">
        <span className="size-2 rounded-full bg-brand shadow-[0_0_8px_var(--color-brand)]" />
        <span className={cn("my-1 w-px flex-1 bg-gradient-to-b from-brand/50 to-white/20", compact ? "min-h-3" : "min-h-4")} />
        <span className="size-2 rotate-45 rounded-[1px] bg-fg" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-[13px] font-medium text-fg">{shortAddress(from)}</p>
        <p className="truncate text-[13px] text-fg-muted">{shortAddress(to)}</p>
      </div>
    </div>
  );
}

function DispatchProgress({ ride, offers, now, timeout }: { ride: LiveRide; offers: number; now: number; timeout: number }) {
  const remaining = ride.next_dispatch_at ? Math.max(0, (new Date(ride.next_dispatch_at).getTime() - now) / 1000) : 0;
  const pct = ride.type === "instant" ? Math.min(100, (remaining / timeout) * 100) : 100;
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between text-[11.5px]">
        <span className="flex items-center gap-1.5 text-amber">
          <Radar className="size-3.5 animate-spin [animation-duration:3s]" />
          {ride.type === "instant"
            ? `Vague ${ride.dispatch_wave || 1} · ${formatDistance(ride.dispatch_radius_m ?? 3000)}`
            : "Proposée à la flotte"}
        </span>
        <span className="num text-fg-muted">
          {offers} offre{offers > 1 ? "s" : ""}
          {ride.type === "instant" && (remaining > 0 ? ` · ${Math.ceil(remaining)} s` : " · vague suivante…")}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-gradient-to-r from-amber to-brand transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RideCard({
  ride, driver, offers, selected, onSelect, now, timeout,
}: { ride: LiveRide; driver?: LiveDriver; offers: number; selected: boolean; onSelect: () => void; now: number; timeout: number }) {
  const status = ride.status as RideStatus;
  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn(
        "group w-full rounded-xl border p-3 text-left transition-all",
        selected ? "border-brand/40 bg-brand/[0.045] shadow-[0_0_0_1px_rgb(200_240_60/0.15)]" : "border-line bg-white/[0.015] hover:border-line-strong hover:bg-white/[0.03]",
        status === "NO_DRIVER_FOUND" && !selected && "border-red/25 bg-red/[0.04]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="num text-[12px] text-fg-subtle">#{ride.number}</span>
          <RideTypeTag type={ride.type} />
        </div>
        <RideStatusBadge status={status} />
      </div>
      <div className="mt-2.5 flex items-start gap-3">
        <RideRoute from={ride.pickup_address} to={ride.dropoff_address} />
        <div className="shrink-0 text-right">
          <p className="num text-[15px] font-semibold text-fg">{formatPrice(ride.price_cents)}</p>
          <p className="mt-1 text-[11px] text-fg-subtle">{formatRideDate(ride.pickup_at)}</p>
        </div>
      </div>
      <p className="mt-2 truncate text-[11.5px] text-fg-subtle">
        {ride.customer_name} · {ride.passengers} pax
      </p>
      {SEARCHING.has(status) && <DispatchProgress ride={ride} offers={offers} now={now} timeout={timeout} />}
      {driver && !SEARCHING.has(status) && (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-line bg-white/[0.02] px-2.5 py-2">
          <span
            className="grid size-6 place-items-center rounded-full text-[10px] font-bold text-ink-900"
            style={{ background: rideColor(status) }}
          >
            {initials(driver.first_name, driver.last_name)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
            {driver.first_name} {driver.last_name.charAt(0)}.
            <span className="text-fg-subtle"> · {driver.vehicle?.model} · {driver.vehicle?.plate}</span>
          </span>
        </div>
      )}
      {status === "NO_DRIVER_FOUND" && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-red">
          <AlertTriangle className="size-3.5" /> Aucun chauffeur — relancez ou attribuez manuellement
        </p>
      )}
    </button>
  );
}

const PRESENCE_ORDER: DriverPresence[] = ["available", "offered", "en_route", "arrived", "on_trip", "offline"];

function DriverRow({ d, selected, onSelect, now }: { d: LiveDriver; selected: boolean; onSelect: () => void; now: number }) {
  const color = PRESENCE_COLOR[d.presence];
  const stale = d.location ? now - new Date(d.location.updated_at).getTime() > 180_000 : true;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors", selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]")}
    >
      <span className="relative">
        <span className="grid size-8 place-items-center rounded-full border border-line-strong bg-ink-600 text-[11px] font-semibold" style={{ boxShadow: `0 0 0 2px ${color}40` }}>
          {initials(d.first_name, d.last_name)}
        </span>
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-ink-800" style={{ background: color }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">
          {d.first_name} {d.last_name} <span className="num text-[11px] text-fg-subtle">#{d.number}</span>
        </span>
        <span className="block truncate text-[11.5px] text-fg-subtle">
          {d.vehicle ? `${d.vehicle.model} · ${d.vehicle.plate}` : "Sans véhicule"}
        </span>
      </span>
      <span className={cn("shrink-0 text-[10.5px]", stale && d.presence !== "offline" ? "text-amber" : "text-fg-subtle")}>
        {d.location ? formatRelative(d.location.updated_at, new Date(now)).replace("il y a ", "") : "—"}
      </span>
    </button>
  );
}

function LiveFeed({ events }: { events: { id: number; message: string; level: string; created_at: string; ride_id: string | null }[] }) {
  if (!events.length) return null;
  return (
    <div className="glass pointer-events-auto w-[420px] max-w-full rounded-xl px-3.5 py-2.5">
      <p className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        <span className="size-1.5 animate-breathe rounded-full bg-brand" /> Dispatch en direct
      </p>
      <ul className="space-y-1">
        {events.slice(0, 4).map((e) => (
          <li key={e.id} className="flex animate-rise gap-3 text-[12px]">
            <span className="num shrink-0 text-fg-subtle">{formatTime(e.created_at, undefined, true)}</span>
            <span className={cn("truncate", e.level === "error" ? "text-red" : e.level === "warning" ? "text-amber" : e.level === "success" ? "text-brand" : "text-fg-muted")}>
              {e.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------- composant
export function CommandCenter({
  initial,
  orgName,
  pricing,
  offerTimeout,
  defaultPayment,
}: {
  initial: LiveSnapshot;
  orgName: string;
  pricing: PricingRule[];
  offerTimeout: number;
  defaultPayment: string;
}) {
  const [state, dispatch] = useReducer(reducer, initial, (s) => reducer({ drivers: {}, rides: {}, offers: {}, kpis: null }, { type: "snapshot", snapshot: s }));
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [tab, setTab] = useState<"live" | "scheduled" | "alerts">("live");
  const [showOffline, setShowOffline] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [newRideOpen, setNewRideOpen] = useState(false);
  const [driverQuery, setDriverQuery] = useState("");
  const [feed, setFeed] = useState<{ id: number; message: string; level: string; created_at: string; ride_id: string | null }[]>([]);
  const mapRef = useRef<FleetMapHandle>(null);
  const now = useNow(1000) ?? Date.parse(initial.serverTime);
  const realtime = useRealtimeStatus();

  const refresh = useCallback(async () => {
    const res = await fetch("/api/dashboard/live", { cache: "no-store" });
    if (res.ok) dispatch({ type: "snapshot", snapshot: (await res.json()) as LiveSnapshot });
  }, []);
  const kpiTimer = useRef<number | null>(null);
  const refreshKpis = useCallback(() => {
    if (kpiTimer.current) window.clearTimeout(kpiTimer.current);
    kpiTimer.current = window.setTimeout(async () => {
      const res = await fetch("/api/dashboard/live?kpis=1", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { kpis: OrgKpis };
        if (json.kpis) dispatch({ type: "kpis", kpis: json.kpis });
      }
    }, 1200);
  }, []);

  useRealtimeEvent("driver.location", (p) => dispatch({ type: "location", payload: p }));
  useRealtimeEvent("driver.updated", (p) => {
    if (!state.drivers[p.id]) void refresh();
    else dispatch({ type: "driver", payload: p });
  });
  useRealtimeEvent("ride.updated", (p) => {
    dispatch({ type: "ride", payload: p });
    refreshKpis();
  });
  useRealtimeEvent("offer.updated", (p) => dispatch({ type: "offer", payload: p }));
  useRealtimeEvent("ride.event", (p) => {
    if (p.category === "system") return;
    setFeed((f) => [p, ...f].slice(0, 12));
  });

  // Repli : synchronisation périodique si le temps réel n'est pas disponible
  useEffect(() => {
    const interval = realtime === "live" ? 45_000 : 6_000;
    const id = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(id);
  }, [realtime, refresh]);

  // Raccourci clavier « N » : nouvelle course
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setNewRideOpen(true);
      }
      if (e.key === "Escape") {
        setSelectedRide(null);
        setSelectedDriver(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const drivers = useMemo(() => Object.values(state.drivers), [state.drivers]);
  const rides = useMemo(() => Object.values(state.rides).sort((a, b) => a.pickup_at.localeCompare(b.pickup_at)), [state.rides]);
  const offers = useMemo(() => Object.values(state.offers), [state.offers]);
  const offersByRide = useMemo(() => {
    const m: Record<string, number> = {};
    for (const o of offers) m[o.ride_id] = (m[o.ride_id] ?? 0) + 1;
    return m;
  }, [offers]);

  const horizon = now + 2 * 3600_000;
  const lists = useMemo(() => {
    const live = rides.filter(
      (r) => !TERMINAL.has(r.status) && (r.type === "instant" || new Date(r.pickup_at).getTime() < horizon || !SEARCHING.has(r.status) && r.status !== "ACCEPTED"),
    );
    const recent = rides.filter((r) => r.status === "COMPLETED").slice(-3);
    const scheduled = rides.filter((r) => r.type === "scheduled" && !TERMINAL.has(r.status));
    const alerts = rides.filter((r) => r.status === "NO_DRIVER_FOUND" || (r.type === "scheduled" && SEARCHING.has(r.status) && new Date(r.pickup_at).getTime() < now + 24 * 3600_000));
    const rank = (s: string) =>
      s === "NO_DRIVER_FOUND" ? 0 : SEARCHING.has(s) ? 1 : s === "DRIVER_ARRIVED" ? 2 : s === "DRIVER_EN_ROUTE" ? 3 : s === "IN_PROGRESS" || s === "PASSENGER_ONBOARD" ? 4 : s === "ACCEPTED" ? 5 : 6;
    live.sort((a, b) => rank(a.status) - rank(b.status) || a.pickup_at.localeCompare(b.pickup_at));
    return { live: [...live, ...recent.reverse()], scheduled, alerts };
  }, [rides, horizon, now]);

  const groupedDrivers = useMemo(() => {
    const q = driverQuery.trim().toLowerCase();
    const filtered = drivers.filter((d) => !q || `${d.first_name} ${d.last_name} ${d.vehicle?.plate ?? ""} ${d.number}`.toLowerCase().includes(q));
    return PRESENCE_ORDER.map((p) => ({ presence: p, list: filtered.filter((d) => d.presence === p) })).filter((g) => g.list.length);
  }, [drivers, driverQuery]);

  const selectRide = (id: string | null) => {
    setSelectedRide(id);
    setSelectedDriver(null);
    const r = id ? state.rides[id] : null;
    if (r) mapRef.current?.flyTo(r.pickup_lng, r.pickup_lat, 13.2);
  };
  const selectDriver = (id: string | null) => {
    setSelectedDriver(id);
    const d = id ? state.drivers[id] : null;
    if (d?.location) mapRef.current?.flyTo(d.location.lng, d.location.lat, 14.5);
  };

  const driver = selectedDriver ? state.drivers[selectedDriver] : null;
  const driverRide = driver?.current_ride_id ? state.rides[driver.current_ride_id] : null;
  const online = drivers.filter((d) => d.presence !== "offline").length;
  const list = lists[tab];

  return (
    <div className="relative flex h-[calc(100dvh-56px)] flex-col overflow-hidden lg:h-dvh">
      {/* Carte plein écran */}
      <div className="relative h-[46vh] shrink-0 lg:absolute lg:inset-0 lg:h-auto">
        <FleetMap
          ref={mapRef}
          drivers={drivers}
          rides={rides}
          offers={offers}
          selectedDriverId={selectedDriver}
          selectedRideId={selectedRide}
          onSelectDriver={selectDriver}
          onSelectRide={selectRide}
          showOffline={showOffline}
          showLabels={showLabels}
          padding={{ top: 170, bottom: 90, left: 410, right: 350 }}
        />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgb(7_8_11/0.55)_100%)]" />
      </div>

      {/* Barre supérieure + KPIs */}
      <div className="pointer-events-none z-20 flex flex-col gap-3 p-3 lg:absolute lg:inset-x-0 lg:top-0 lg:p-4">
        <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-3">
          <div className="glass flex items-center gap-3 rounded-xl px-3.5 py-2">
            <span className="relative grid size-2.5 place-items-center">
              <span className={cn("absolute size-2.5 rounded-full", realtime === "live" ? "animate-ping bg-brand/60" : "")} />
              <span className={cn("size-2 rounded-full", realtime === "live" ? "bg-brand" : "bg-amber")} />
            </span>
            <span className="text-[13px] font-semibold tracking-tight">{orgName}</span>
            <span className="h-3.5 w-px bg-line-strong" />
            <LiveClock />
            <span className="hidden text-[12px] text-fg-subtle sm:inline">
              · {online} en ligne
            </span>
          </div>
          <div className="glass flex items-center gap-1 rounded-xl p-1">
            <Tooltip content={showLabels ? "Masquer les noms" : "Afficher les noms"}>
              <Button variant="ghost" size="icon-sm" onClick={() => setShowLabels((v) => !v)} aria-label="Noms des chauffeurs">
                <Tag className={cn(showLabels && "text-brand")} />
              </Button>
            </Tooltip>
            <Tooltip content={showOffline ? "Masquer les hors ligne" : "Afficher les hors ligne"}>
              <Button variant="ghost" size="icon-sm" onClick={() => setShowOffline((v) => !v)} aria-label="Chauffeurs hors ligne">
                {showOffline ? <Eye className="text-brand" /> : <EyeOff />}
              </Button>
            </Tooltip>
            <Tooltip content="Recentrer sur la flotte">
              <Button variant="ghost" size="icon-sm" onClick={() => mapRef.current?.fitAll()} aria-label="Recentrer">
                <Crosshair />
              </Button>
            </Tooltip>
            <Button variant="primary" size="sm" onClick={() => setNewRideOpen(true)} className="ml-1">
              <Plus /> Nouvelle course <span className="ml-1 hidden rounded bg-black/15 px-1 text-[10px] font-bold sm:inline">N</span>
            </Button>
          </div>
        </div>
        <div className="pointer-events-auto">
          <KpiStrip kpis={state.kpis} />
        </div>
      </div>

      {/* Panneau courses */}
      <aside className="z-10 flex min-h-0 flex-1 flex-col lg:glass lg:absolute lg:bottom-4 lg:left-4 lg:top-[172px] lg:w-[376px] lg:flex-none lg:rounded-2xl">
        <div className="space-y-3 border-b border-line px-4 pb-3 pt-3.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Courses actives</h2>
          <div className="grid grid-cols-3 gap-0.5 rounded-lg border border-line bg-ink-850 p-0.5">
            {(
              [
                { k: "live", label: "Live", icon: Zap, n: lists.live.filter((r) => !TERMINAL.has(r.status)).length },
                { k: "scheduled", label: "Planifiées", icon: CalendarClock, n: lists.scheduled.length },
                { k: "alerts", label: "Alertes", icon: AlertTriangle, n: lists.alerts.length },
              ] as const
            ).map(({ k, label, n }) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={cn(
                  "flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors",
                  tab === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {label}
                <span className={cn("num rounded px-1 text-[10.5px]", k === "alerts" && n > 0 ? "bg-red/15 text-red" : "text-fg-subtle")}>{n}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {list.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="relative mb-4 grid size-14 place-items-center">
                <span className="absolute inset-0 animate-ping-ring rounded-full border border-brand/40" />
                <Radar className="size-6 text-brand" />
              </div>
              <p className="text-[13px] font-medium">Aucune course {tab === "alerts" ? "en alerte" : tab === "scheduled" ? "planifiée" : "en cours"}</p>
              <p className="mt-1 text-[12px] text-fg-subtle">Les nouvelles courses apparaissent ici instantanément.</p>
            </div>
          ) : (
            list.map((r) => (
              <RideCard
                key={r.id}
                ride={r}
                driver={r.driver_id ? state.drivers[r.driver_id] : undefined}
                offers={offersByRide[r.id] ?? 0}
                selected={selectedRide === r.id}
                onSelect={() => selectRide(selectedRide === r.id ? null : r.id)}
                now={now}
                timeout={offerTimeout}
              />
            ))
          )}
        </div>
        {selectedRide && state.rides[selectedRide] && (
          <div className="border-t border-line p-3">
            <Button asChild variant="secondary" size="sm" className="w-full">
              <Link href={`/dashboard/rides/${selectedRide}`}>Ouvrir la course #{state.rides[selectedRide]!.number} · timeline</Link>
            </Button>
          </div>
        )}
      </aside>

      {/* Panneau chauffeurs */}
      <aside className="z-10 hidden min-h-0 flex-col xl:glass xl:absolute xl:bottom-4 xl:right-4 xl:top-[172px] xl:flex xl:w-[318px] xl:rounded-2xl">
        <div className="border-b border-line px-4 pb-3 pt-3.5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
              <Users className="size-4 text-fg-subtle" /> Chauffeurs connectés
            </h2>
            <span className="num text-[12px] text-fg-muted">
              <span className="text-brand">{online}</span>/{drivers.length}
            </span>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <input
              value={driverQuery}
              onChange={(e) => setDriverQuery(e.target.value)}
              placeholder="Nom, plaque, n°…"
              className="h-8 w-full rounded-lg border border-line bg-ink-850 pl-8 pr-2 text-[12.5px] outline-none placeholder:text-fg-subtle focus:border-brand/50"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {groupedDrivers.map((g) => (
            <div key={g.presence} className="mb-2">
              <p className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                <span className="size-1.5 rounded-full" style={{ background: PRESENCE_COLOR[g.presence] }} />
                {PRESENCE_META[g.presence].label}
                <span className="num text-fg-subtle/70">{g.list.length}</span>
              </p>
              {g.list.map((d) => (
                <DriverRow key={d.id} d={d} now={now} selected={selectedDriver === d.id} onSelect={() => selectDriver(d.id)} />
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* Fiche chauffeur sélectionné */}
      {driver && (
        <div className="glass absolute bottom-4 right-4 z-30 w-[318px] animate-rise rounded-2xl p-4 xl:right-[346px]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full border border-line-strong bg-ink-600 text-[13px] font-semibold" style={{ boxShadow: `0 0 0 2px ${PRESENCE_COLOR[driver.presence]}55` }}>
                {initials(driver.first_name, driver.last_name)}
              </span>
              <div>
                <p className="text-[14px] font-semibold">
                  {driver.first_name} {driver.last_name}
                </p>
                <p className="text-[12px]" style={{ color: PRESENCE_COLOR[driver.presence] }}>
                  {PRESENCE_META[driver.presence].label}
                </p>
              </div>
            </div>
            <button type="button" onClick={() => setSelectedDriver(null)} className="rounded-md p-1 text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Fermer">
              <X className="size-4" />
            </button>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12px]">
            <div>
              <dt className="text-fg-subtle">Véhicule</dt>
              <dd className="truncate text-fg">{driver.vehicle ? `${driver.vehicle.brand ?? ""} ${driver.vehicle.model}` : "—"}</dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Plaque</dt>
              <dd className="num text-fg">{driver.vehicle?.plate ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Téléphone</dt>
              <dd className="text-fg">{formatPhone(driver.phone)}</dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Dernière position</dt>
              <dd className="text-fg">{driver.location ? `${formatTime(driver.location.updated_at, undefined, true)}` : "—"}</dd>
            </div>
          </dl>
          {driverRide && (
            <button type="button" onClick={() => selectRide(driverRide.id)} className="mt-3 w-full rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-left text-[12px] hover:border-line-strong">
              <span className="flex items-center justify-between">
                <span className="text-fg-subtle">Course actuelle #{driverRide.number}</span>
                <span style={{ color: rideColor(driverRide.status) }}>{RIDE_STATUS_META[driverRide.status as RideStatus]?.short}</span>
              </span>
              <span className="mt-1 block truncate text-fg">
                {shortAddress(driverRide.pickup_address)} → {shortAddress(driverRide.dropoff_address)}
              </span>
            </button>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={`tel:${driver.phone}`}>
                <Phone /> Appeler
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/drivers/${driver.id}`}>Profil</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Flux live + légende */}
      <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 hidden -translate-x-1/2 lg:block">
        <LiveFeed events={feed} />
      </div>
      <div className="pointer-events-none absolute bottom-4 left-[404px] z-10 hidden 2xl:block">
        <div className="glass flex items-center gap-3 rounded-xl px-3 py-2 text-[11px] text-fg-muted">
          {PRESENCE_ORDER.map((p) => (
            <span key={p} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: PRESENCE_COLOR[p], boxShadow: `0 0 8px ${PRESENCE_COLOR[p]}` }} />
              {PRESENCE_META[p].label}
            </span>
          ))}
        </div>
      </div>

      <NewRideSheet
        open={newRideOpen}
        onOpenChange={setNewRideOpen}
        pricing={pricing}
        defaultPayment={defaultPayment}
        onCreated={async (r) => {
          await refresh();
          setTab("live");
          selectRide(r.id);
        }}
      />
    </div>
  );
}
