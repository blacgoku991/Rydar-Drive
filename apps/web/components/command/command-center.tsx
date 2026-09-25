"use client";
import {
  PRESENCE_META, RIDE_STATUS_META, decodePolyline, formatPhone, formatTime, haversine, initials, shortAddress,
  type Coord, type OrgKpis, type PricingRule, type RideStatus,
} from "@rydar/shared";
import { Crosshair, Eye, EyeOff, Moon, Phone, Plus, Radar, Search, Sun, Tag, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FleetPanel } from "@/components/command/fleet-panel";
import { KpiStrip } from "@/components/command/kpi-strip";
import { RideFocus } from "@/components/command/ride-focus";
import { RideRow, SEARCHING, TERMINAL } from "@/components/command/ride-row";
import { FleetMap, type FleetMapHandle } from "@/components/map/fleet-map";
import { PRESENCE_COLOR, rideColor } from "@/components/map/map-theme";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import { NewRideSheet } from "@/components/rides/new-ride-sheet";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
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
      const p = { ...action.payload };
      const prev = state.rides[p.id];
      // Le tracé n'est diffusé qu'à la création / modification : on garde l'existant
      if (p.route_polyline == null && prev?.route_polyline) delete p.route_polyline;
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

type FeedEvent = { id: number; message: string; level: string; created_at: string; ride_id: string | null; category: string };
type Tab = "live" | "upcoming" | "alerts";

function LiveClock() {
  const now = useNow(1000);
  return <span className="text-[12.5px] tabular-nums text-fg-subtle">{now ? formatTime(new Date(now), undefined, true) : "--:--:--"}</span>;
}

// ---------------------------------------------------------------------------- composant
export function CommandCenter({
  initial,
  orgName,
  pricing,
  offerTimeout,
  locationMaxAgeS = 180,
  defaultPayment,
}: {
  initial: LiveSnapshot;
  orgName: string;
  pricing: PricingRule[];
  offerTimeout: number;
  /** Au-delà, la position n'est plus prise en compte par le dispatch (réglage de l'organisation). */
  locationMaxAgeS?: number;
  defaultPayment: string;
}) {
  const [state, dispatch] = useReducer(reducer, initial, (s) => reducer({ drivers: {}, rides: {}, offers: {}, kpis: null }, { type: "snapshot", snapshot: s }));
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("live");
  const [query, setQuery] = useState("");
  const [showOffline, setShowOffline] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [mapTheme, setMapTheme] = useState<"night" | "day">("night");
  useEffect(() => {
    try {
      if (window.localStorage.getItem("rydar.mapTheme") === "day") setMapTheme("day");
    } catch {
      /* stockage indisponible */
    }
  }, []);
  const toggleTheme = () =>
    setMapTheme((t) => {
      const next = t === "night" ? "day" : "night";
      try {
        window.localStorage.setItem("rydar.mapTheme", next);
      } catch {
        /* stockage indisponible */
      }
      return next;
    });
  const [newRideOpen, setNewRideOpen] = useState(false);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [approach, setApproach] = useState<{ rideId: string; coordinates: Coord[]; durationS: number; from: { lat: number; lng: number } } | null>(null);
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
    setFeed((f) => [p, ...f].slice(0, 40));
  });

  // Repli : synchronisation périodique si le temps réel n'est pas disponible
  useEffect(() => {
    const interval = realtime === "live" ? 45_000 : 6_000;
    const id = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(id);
  }, [realtime, refresh]);

  // Raccourcis : N = nouvelle course, Échap = désélection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
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

  const lists = useMemo(() => {
    const horizon = now + 2 * 3600_000;
    const soon = (r: LiveRide) => new Date(r.pickup_at).getTime() < horizon;
    const live = rides.filter((r) => !TERMINAL.has(r.status) && (r.type === "instant" || soon(r) || (!SEARCHING.has(r.status) && r.status !== "ACCEPTED")));
    const liveIds = new Set(live.map((r) => r.id));
    const upcoming = rides.filter((r) => !TERMINAL.has(r.status) && !liveIds.has(r.id));
    const alerts = rides.filter(
      (r) => r.status === "NO_DRIVER_FOUND" || (r.type === "scheduled" && SEARCHING.has(r.status) && new Date(r.pickup_at).getTime() < now + 24 * 3600_000),
    );
    const rank = (s: string) =>
      s === "NO_DRIVER_FOUND" ? 0 : SEARCHING.has(s) ? 1 : s === "DRIVER_ARRIVED" ? 2 : s === "DRIVER_EN_ROUTE" ? 3 : s === "ACCEPTED" ? 4 : 5;
    live.sort((a, b) => rank(a.status) - rank(b.status) || a.pickup_at.localeCompare(b.pickup_at));
    const recent = rides.filter((r) => r.status === "COMPLETED").slice(-3).reverse();
    return { live: [...live, ...recent], upcoming, alerts };
  }, [rides, now]);

  const visibleList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = lists[tab];
    if (!q) return list;
    return list.filter((r) => `#${r.number} ${r.number} ${r.customer_name} ${r.pickup_address} ${r.dropoff_address}`.toLowerCase().includes(q));
  }, [lists, tab, query]);

  const ride = selectedRide ? state.rides[selectedRide] : null;
  const rideDriver = ride?.driver_id ? state.drivers[ride.driver_id] : undefined;

  // Itinéraire d'approche réel (chauffeur → départ) de la course sélectionnée
  useEffect(() => {
    const loc = rideDriver?.location;
    if (!ride || !loc || !["ACCEPTED", "DRIVER_EN_ROUTE"].includes(ride.status)) {
      if (approach) setApproach(null);
      return;
    }
    if (approach?.rideId === ride.id && haversine(approach.from, loc) < 150) return;
    let cancelled = false;
    fetch("/api/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { lat: loc.lat, lng: loc.lng }, to: { lat: ride.pickup_lat, lng: ride.pickup_lng } }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { polyline: string; durationS: number } | null) => {
        if (!cancelled && j) setApproach({ rideId: ride.id, coordinates: decodePolyline(j.polyline), durationS: j.durationS, from: { lat: loc.lat, lng: loc.lng } });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride?.id, ride?.status, rideDriver?.location?.lat, rideDriver?.location?.lng]);

  const selectRide = (id: string | null) => {
    setSelectedRide(id);
    setSelectedDriver(null);
    const r = id ? state.rides[id] : null;
    if (!r) return;
    const pts: Coord[] = [[r.pickup_lng, r.pickup_lat]];
    if (r.route_polyline) pts.push(...decodePolyline(r.route_polyline));
    else if (r.dropoff_lng != null && r.dropoff_lat != null) pts.push([r.dropoff_lng, r.dropoff_lat]);
    const d = r.driver_id ? state.drivers[r.driver_id] : null;
    if (d?.location) pts.push([d.location.lng, d.location.lat]);
    mapRef.current?.fitPoints(pts);
  };
  const selectDriver = (id: string | null) => {
    setSelectedDriver(id);
    const d = id ? state.drivers[id] : null;
    if (d?.location) mapRef.current?.flyTo(d.location.lng, d.location.lat, 14.5);
  };

  // Ouverture d'une course depuis une alerte (toast, cloche, notification du navigateur) ou ?ride=
  const selectRideRef = useRef(selectRide);
  selectRideRef.current = selectRide;
  const ridesRef = useRef(state.rides);
  ridesRef.current = state.rides;
  useEffect(() => {
    // Course hors du direct (terminée, trop ancienne) : sa fiche complète
    const open = (id: string) => (ridesRef.current[id] ? selectRideRef.current(id) : window.location.assign(`/dashboard/rides/${id}`));
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) open(id);
    };
    window.addEventListener("rydar:focus-ride", onFocus);
    const fromUrl = new URLSearchParams(window.location.search).get("ride");
    if (fromUrl) {
      // après le cadrage initial de la carte sur la flotte
      window.setTimeout(() => open(fromUrl), 1500);
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => window.removeEventListener("rydar:focus-ride", onFocus);
  }, []);

  const driver = selectedDriver ? state.drivers[selectedDriver] : null;
  const driverRide = driver?.current_ride_id ? state.rides[driver.current_ride_id] : null;
  const fleetCenter = useMemo(() => {
    const pts = drivers.filter((d) => d.location).map((d) => d.location!);
    if (!pts.length) return null;
    return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  }, [drivers]);
  const rideFeed = useMemo(() => (ride ? feed.filter((e) => e.ride_id === ride.id) : []), [feed, ride]);

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
          approach={approach}
          theme={mapTheme}
          staleMs={locationMaxAgeS * 1000}
          padding={{ top: 110, bottom: 60, left: 420, right: 360 }}
        />
      </div>

      {/* Indicateurs + outils (haut droite) */}
      <div className="pointer-events-none absolute right-3 top-3 z-20 hidden items-start gap-2 lg:flex">
        <KpiStrip kpis={state.kpis} className="pointer-events-auto hidden xl:flex" />
        <div className="glass pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1.5">
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
          <Tooltip content={mapTheme === "night" ? "Carte claire" : "Carte sombre"}>
            <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Thème de la carte">
              {mapTheme === "night" ? <Sun /> : <Moon />}
            </Button>
          </Tooltip>
          <Tooltip content="Recentrer sur la flotte">
            <Button variant="ghost" size="icon-sm" onClick={() => mapRef.current?.fitAll()} aria-label="Recentrer">
              <Crosshair />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Panneau courses (gauche) */}
      <aside className="z-10 flex min-h-0 flex-1 flex-col bg-ink-850 lg:glass lg:absolute lg:bottom-3 lg:left-3 lg:top-3 lg:w-[392px] lg:flex-none lg:rounded-2xl">
        <div className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-3">
          <span className="relative grid size-2 place-items-center">
            {realtime === "live" && <span className="absolute size-2 animate-ping rounded-full bg-brand/60" />}
            <span className={cn("size-2 rounded-full", realtime === "live" ? "bg-brand" : "bg-amber")} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold tracking-tight">{orgName}</p>
            <p className="flex items-center gap-1.5">
              <LiveClock />
              <span className="text-[12px] text-fg-subtle">· {realtime === "live" ? "temps réel" : "synchronisation"}</span>
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setNewRideOpen(true)}>
            <Plus /> Nouvelle course
          </Button>
        </div>

        {ride ? (
          <RideFocus
            ride={ride}
            driver={rideDriver}
            drivers={drivers}
            offers={offersByRide[ride.id] ?? 0}
            approachS={approach?.rideId === ride.id ? approach.durationS : null}
            liveEvents={rideFeed}
            onBack={() => setSelectedRide(null)}
            onSelectDriver={selectDriver}
          />
        ) : (
          <>
            <div className="space-y-2.5 px-3 pb-2 pt-3">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.035] p-1">
                {(
                  [
                    { k: "live", label: "En cours", n: lists.live.filter((r) => !TERMINAL.has(r.status)).length },
                    { k: "upcoming", label: "À venir", n: lists.upcoming.length },
                    { k: "alerts", label: "Alertes", n: lists.alerts.length },
                  ] as const
                ).map(({ k, label, n }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTab(k)}
                    className={cn("flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors", tab === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg")}
                  >
                    {label}
                    <span className={cn("tabular-nums", k === "alerts" && n > 0 ? "text-red" : "text-fg-subtle")}>{n}</span>
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="N° de course, client, adresse"
                  className="h-8 w-full rounded-lg bg-white/[0.04] pl-8 pr-2 text-[12.5px] outline-none placeholder:text-fg-subtle focus:bg-white/[0.06]"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {visibleList.length === 0 ? (
                <div className="flex flex-col items-center px-6 py-14 text-center">
                  <Radar className="mb-3 size-6 text-fg-subtle" />
                  <p className="text-[13px] font-medium">Aucune course {tab === "alerts" ? "en alerte" : tab === "upcoming" ? "à venir" : "en cours"}</p>
                  <p className="mt-1 text-[12px] text-fg-subtle">Les nouvelles courses apparaissent ici instantanément.</p>
                  <Button variant="secondary" size="sm" className="mt-4" onClick={() => setNewRideOpen(true)}>
                    <Plus /> Nouvelle course <kbd className="kbd ml-1">N</kbd>
                  </Button>
                </div>
              ) : (
                visibleList.map((r) => (
                  <RideRow
                    key={r.id}
                    ride={r}
                    driver={r.driver_id ? state.drivers[r.driver_id] : undefined}
                    offers={offersByRide[r.id] ?? 0}
                    selected={false}
                    onSelect={() => selectRide(r.id)}
                    now={now}
                    timeout={offerTimeout}
                  />
                ))
              )}
            </div>
          </>
        )}
      </aside>

      {/* Flotte (droite) */}
      <aside className="z-10 hidden min-h-0 xl:glass xl:absolute xl:bottom-3 xl:right-3 xl:top-[76px] xl:flex xl:w-[312px] xl:flex-col xl:rounded-2xl">
        <FleetPanel drivers={drivers} rides={state.rides} selectedId={selectedDriver} onSelect={selectDriver} now={now} staleMs={locationMaxAgeS * 1000} className="flex-1" />
      </aside>

      {/* Fiche chauffeur sélectionné */}
      {driver && (
        <div className="glass absolute bottom-3 left-1/2 z-30 w-[340px] -translate-x-1/2 animate-rise rounded-2xl p-4 lg:left-[calc(50%+40px)]">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-ink-600 text-[13px] font-semibold" style={{ boxShadow: `0 0 0 2px ${PRESENCE_COLOR[driver.presence]}` }}>
              {initials(driver.first_name, driver.last_name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">
                {driver.first_name} {driver.last_name} <span className="text-[12px] font-normal text-fg-subtle">#{driver.number}</span>
              </p>
              <p className="text-[12.5px]" style={{ color: PRESENCE_COLOR[driver.presence] }}>
                {PRESENCE_META[driver.presence].label}
                <span className="text-fg-subtle"> · {driver.location ? `vu à ${formatTime(driver.location.updated_at)}` : "position inconnue"}</span>
              </p>
              <p className="truncate text-[12px] text-fg-muted">
                {driver.vehicle ? `${driver.vehicle.brand ?? ""} ${driver.vehicle.model} · ${driver.vehicle.plate}` : "Sans véhicule"}
              </p>
            </div>
            <button type="button" onClick={() => setSelectedDriver(null)} className="rounded-md p-1 text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Fermer">
              <X className="size-4" />
            </button>
          </div>
          {driverRide && (
            <button type="button" onClick={() => selectRide(driverRide.id)} className="mt-3 w-full rounded-xl bg-white/[0.04] px-3 py-2 text-left text-[12.5px] hover:bg-white/[0.07]">
              <span className="flex items-center justify-between">
                <span className="text-fg-subtle">Course #{driverRide.number}</span>
                <span style={{ color: rideColor(driverRide.status) }}>{RIDE_STATUS_META[driverRide.status as RideStatus]?.short}</span>
              </span>
              <span className="mt-0.5 block truncate text-fg">
                {shortAddress(driverRide.pickup_address)} → {shortAddress(driverRide.dropoff_address)}
              </span>
            </button>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={`tel:${driver.phone}`} title={formatPhone(driver.phone)}>
                <Phone /> Appeler
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/drivers/${driver.id}`}>Profil</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Journal en direct (discret) */}
      {!driver && feed.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-[420px] z-10 hidden max-w-[440px] lg:block">
          <div className="glass rounded-xl px-3 py-2">
            <ul className="space-y-0.5">
              {feed.slice(0, 3).map((e) => (
                <li key={e.id} className="flex animate-rise gap-2.5 text-[12px]">
                  <span className="shrink-0 tabular-nums text-fg-subtle">{formatTime(e.created_at, undefined, true)}</span>
                  <span className={cn("truncate", e.level === "error" ? "text-red" : e.level === "warning" ? "text-amber" : e.level === "success" ? "text-brand" : "text-fg-muted")}>
                    {e.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <NewRideSheet
        open={newRideOpen}
        onOpenChange={setNewRideOpen}
        pricing={pricing}
        defaultPayment={defaultPayment}
        center={fleetCenter}
        onCreated={async (r) => {
          await refresh();
          setTab("live");
          selectRide(r.id);
        }}
      />
    </div>
  );
}
