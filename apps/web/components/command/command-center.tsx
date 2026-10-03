"use client";
import {
  PRESENCE_META, RIDE_STATUS_META, decodePolyline, formatPhone, formatTime, haversine, initials, shortAddress,
  type ChatMessage, type Coord, type FleetReportUpdate, type OrgKpis, type PricingRule, type RideAlertBroadcast, type RideStatus,
} from "@rydar/shared";
import { Crosshair, Eye, EyeOff, MessageSquareText, Moon, Phone, Plus, Radar, Search, Siren, Sun, Tag, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { FleetPanel } from "@/components/command/fleet-panel";
import { KpiStrip } from "@/components/command/kpi-strip";
import { ON_BOARD, reducer } from "@/components/command/live-state";
import { RideFocus } from "@/components/command/ride-focus";
import { RideRow, SEARCHING, TERMINAL } from "@/components/command/ride-row";
import { FleetMap, type FleetMapHandle } from "@/components/map/fleet-map";
import { PRESENCE_COLOR, rideColor } from "@/components/map/map-theme";
import { liveNetworkLabel, liveNetworkLock, livePartner } from "@/components/network-share/ride-network";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { NewRideSheet } from "@/components/rides/new-ride-sheet";
import { useCentrale } from "@/components/settlements/centrale-context";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import type { LiveAlert, LiveRide, LiveSnapshot } from "@/lib/queries/live";
import { cn } from "@/lib/utils";

type FeedEvent = { id: number; message: string; level: string; created_at: string; ride_id: string | null; category: string };
type Tab = "live" | "upcoming" | "alerts";

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1 };

function LiveClock() {
  const now = useNow(1000);
  return <span className="text-[12.5px] tabular-nums text-fg-subtle">{now ? formatTime(new Date(now), undefined, true) : "--:--:--"}</span>;
}

function stored(key: string, fallback: string) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}

// ---------------------------------------------------------------------------- composant
export function CommandCenter({
  initial,
  orgName,
  pricing,
  offerTimeout,
  locationMaxAgeS = 180,
  firstPassWaves = 4,
  defaultPayment,
}: {
  initial: LiveSnapshot;
  orgName: string;
  pricing: PricingRule[];
  offerTimeout: number;
  /** Au-delà, la position n'est plus prise en compte par le dispatch (réglage de l'organisation). */
  locationMaxAgeS?: number;
  /** Nombre de vagues du premier passage : au-delà, la recherche est en relance */
  firstPassWaves?: number;
  defaultPayment: string;
}) {
  const [state, dispatch] = useReducer(reducer, initial, (s) =>
    reducer({ drivers: {}, rides: {}, offers: {}, alerts: {}, reports: {}, kpis: null }, { type: "snapshot", snapshot: s }),
  );
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("live");
  const [query, setQuery] = useState("");
  const [showOffline, setShowOffline] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [showReports, setShowReports] = useState(true);
  const [mapTheme, setMapTheme] = useState<"night" | "day">("night");
  useEffect(() => {
    if (stored("rydar.mapTheme", "night") === "day") setMapTheme("day");
    if (stored("rydar.mapReports", "on") === "off") setShowReports(false);
  }, []);
  const toggleTheme = () =>
    setMapTheme((t) => {
      const next = t === "night" ? "day" : "night";
      store("rydar.mapTheme", next);
      return next;
    });
  const toggleReports = () =>
    setShowReports((v) => {
      store("rydar.mapReports", v ? "off" : "on");
      if (v) setSelectedReport(null);
      return !v;
    });
  // Marges de cadrage de la carte selon la mise en page (panneaux flottants sur grand écran, carte seule sur mobile)
  const [layout, setLayout] = useState<"mobile" | "lg" | "xl">("xl");
  useEffect(() => {
    const lg = window.matchMedia("(min-width: 1024px)");
    const xl = window.matchMedia("(min-width: 1280px)");
    const apply = () => setLayout(xl.matches ? "xl" : lg.matches ? "lg" : "mobile");
    apply();
    lg.addEventListener("change", apply);
    xl.addEventListener("change", apply);
    return () => {
      lg.removeEventListener("change", apply);
      xl.removeEventListener("change", apply);
    };
  }, []);
  const mapPadding = useMemo(
    () =>
      layout === "mobile"
        ? { top: 64, bottom: 36, left: 36, right: 36 }
        : { top: 110, bottom: 60, left: 420, right: layout === "xl" ? 360 : 60 },
    [layout],
  );
  const [newRideOpen, setNewRideOpen] = useState(false);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [approach, setApproach] = useState<{ rideId: string; coordinates: Coord[]; durationS: number; from: { lat: number; lng: number } } | null>(null);
  const mapRef = useRef<FleetMapHandle>(null);
  // Horloge de l'écran (listes, jour affiché, signalements expirés) : 15 s. Ce qui bouge à la seconde (heure, compte à
  // rebours des vagues, « vu il y a ») a sa propre horloge, dans de petits composants.
  const serverNow = useMemo(() => Date.parse(initial.serverTime), [initial.serverTime]);
  const now = useNow(15_000) ?? serverNow;
  const realtime = useRealtimeStatus();
  const orgId = useCentrale()?.orgId ?? null;

  // Échec (réseau, 503 si une lecture a échoué côté serveur) : l'état courant est conservé jusqu'au prochain essai
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/live", { cache: "no-store" });
      if (res.ok) dispatch({ type: "snapshot", snapshot: (await res.json()) as LiveSnapshot });
    } catch {
      /* réseau indisponible : prochain sondage */
    }
  }, []);
  // Indicateurs : relus après un changement qui les concerne, au plus une fois toutes les 2 s
  const kpiTimer = useRef<number | null>(null);
  const refreshKpis = useCallback(() => {
    if (kpiTimer.current) return;
    kpiTimer.current = window.setTimeout(async () => {
      kpiTimer.current = null;
      try {
        const res = await fetch("/api/dashboard/live?kpis=1", { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { kpis: OrgKpis };
          if (json.kpis) dispatch({ type: "kpis", kpis: json.kpis });
        }
      } catch {
        /* réseau indisponible : prochaine mise à jour */
      }
    }, 2000);
  }, []);
  useEffect(() => () => {
    if (kpiTimer.current) window.clearTimeout(kpiTimer.current);
  }, []);

  // Instantané relu : à chaque reconnexion du canal, au retour sur l'onglet après plus d'une minute, toutes les 2 min en
  // temps réel (filet de sécurité, onglet visible) ; sans temps réel, sondage 6 → 18 → 30 s, en pause onglet caché.
  const { schedule: resync } = useLiveSync(() => void refresh(), { pollMs: 6000, maxPollMs: 30_000, livePollMs: 120_000, resyncAfterHiddenMs: 60_000 });
  // Réseau partagé : « network.updated » (org:{A} → { ride_id } ; org:{B} → { execution_id }) ne porte que des
  // identifiants → instantané relu (partage ouvert, accepté, retiré, clos). Jamais émis tant que le réseau est fermé.
  useRealtimeEvent("network.updated", () => resync());

  // Positions GPS regroupées : au plus un rendu par seconde (dernière position de chaque chauffeur), aucun tant que
  // l'onglet est caché (appliquées à son retour)
  const pendingLocations = useRef(new Map<string, any>());
  const locationTimer = useRef<number | null>(null);
  const flushLocations = useCallback(() => {
    locationTimer.current = null;
    if (document.visibilityState === "hidden" || !pendingLocations.current.size) return;
    const payloads = [...pendingLocations.current.values()];
    pendingLocations.current.clear();
    dispatch({ type: "locations", payloads });
  }, []);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") flushLocations();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (locationTimer.current) window.clearTimeout(locationTimer.current);
    };
  }, [flushLocations]);
  useRealtimeEvent("driver.location", (p) => {
    if (!p?.driver_id) return;
    pendingLocations.current.set(p.driver_id, p);
    if (locationTimer.current == null) locationTimer.current = window.setTimeout(flushLocations, 1000);
  });
  useRealtimeEvent("driver.updated", (p) => {
    const prev = state.drivers[p.id];
    if (!prev) void refresh();
    else {
      dispatch({ type: "driver", payload: p });
      // Chauffeurs en ligne / libres (indicateurs)
      if (prev.presence !== p.presence) refreshKpis();
      // Réseau partagé (B) : course partenaire dont l'organisation n'est pas encore connue → instantané relu
      if (p.network === true && !p.network_giver && !prev.network_giver) resync();
    }
  });
  useRealtimeEvent("ride.updated", (p) => {
    const prev = state.rides[p.id];
    dispatch({ type: "ride", payload: p });
    // Courses du jour, chiffre d'affaires, recherches en cours : seulement si statut, prix ou horaire changent
    if (!prev || prev.status !== p.status || prev.price_cents !== p.price_cents || prev.pickup_at !== p.pickup_at) refreshKpis();
    // Réseau partagé (A) : chauffeur partenaire diffusé sans identifiant ; organisation inconnue → instantané relu
    if (p.network === true && !prev?.driver_org_id) resync();
  });
  useRealtimeEvent("offer.updated", (p) => dispatch({ type: "offer", payload: p }));
  useRealtimeEvent("ride.event", (p) => {
    if (p.category === "system") return;
    setFeed((f) => [p, ...f].slice(0, 40));
  });
  useRealtimeEvent("ride.alert", (p: RideAlertBroadcast) => p?.id && dispatch({ type: "alert", payload: p }));
  useRealtimeEvent("chat.message", (m: ChatMessage) => m?.report_type && dispatch({ type: "report", payload: m }));
  useRealtimeEvent("chat.report", (u: FleetReportUpdate) => u?.id && dispatch({ type: "report-update", payload: u }));


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
        setSelectedReport(null);
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

  // Alerte la plus grave de chaque course (ouverte avant « en sourdine », critique avant avertissement)
  const alertByRide = useMemo(() => {
    const m: Record<string, LiveAlert> = {};
    for (const a of Object.values(state.alerts)) {
      if (a.status === "resolved") continue;
      const cur = m[a.ride_id];
      const score = (x: LiveAlert) => (x.status === "open" ? 0 : 10) + (SEVERITY_RANK[x.severity] ?? 5);
      if (!cur || score(a) < score(cur)) m[a.ride_id] = a;
    }
    return m;
  }, [state.alerts]);

  // Courses en alerte ouverte : gardées sur la carte même au-delà de 2 h (elles sont dans la liste « En cours »)
  const alertRideIds = useMemo(
    () => new Set(Object.entries(alertByRide).filter(([, a]) => a.status === "open").map(([rideId]) => rideId)),
    [alertByRide],
  );

  // Signalements encore actifs (retirés à l'expiration, vérifié toutes les 15 s)
  const tick = Math.floor(now / 15_000);
  const reports = useMemo(() => {
    const t = tick * 15_000;
    return Object.values(state.reports).filter((r) => Date.parse(r.expires_at) > t);
  }, [state.reports, tick]);
  useEffect(() => {
    if (selectedReport && !reports.some((r) => r.id === selectedReport)) setSelectedReport(null);
  }, [reports, selectedReport]);

  const lists = useMemo(() => {
    const horizon = now + 2 * 3600_000;
    const soon = (r: LiveRide) => new Date(r.pickup_at).getTime() < horizon;
    const openAlert = (r: LiveRide) => alertByRide[r.id]?.status === "open";
    const live = rides.filter((r) => !TERMINAL.has(r.status) && (r.type === "instant" || soon(r) || openAlert(r) || (!SEARCHING.has(r.status) && r.status !== "ACCEPTED")));
    const liveIds = new Set(live.map((r) => r.id));
    const upcoming = rides.filter((r) => !TERMINAL.has(r.status) && !liveIds.has(r.id));
    const flightProblem = (r: LiveRide) => !TERMINAL.has(r.status) && (r.flight_status === "cancelled" || r.flight_status === "diverted");
    const alerts = rides.filter(
      (r) =>
        openAlert(r) ||
        flightProblem(r) ||
        r.status === "NO_DRIVER_FOUND" ||
        (r.type === "scheduled" && SEARCHING.has(r.status) && new Date(r.pickup_at).getTime() < now + 24 * 3600_000),
    );
    const alertRank = (r: LiveRide) => (openAlert(r) ? (SEVERITY_RANK[alertByRide[r.id]!.severity] ?? 1) - 3 : 0);
    alerts.sort((a, b) => alertRank(a) - alertRank(b) || a.pickup_at.localeCompare(b.pickup_at));
    const rank = (r: LiveRide) => {
      const s = r.status;
      return alertRank(r) || (s === "NO_DRIVER_FOUND" ? 0 : SEARCHING.has(s) ? 1 : s === "DRIVER_ARRIVED" ? 2 : s === "DRIVER_EN_ROUTE" ? 3 : s === "ACCEPTED" ? 4 : 5);
    };
    live.sort((a, b) => rank(a) - rank(b) || a.pickup_at.localeCompare(b.pickup_at));
    const recent = rides.filter((r) => r.status === "COMPLETED").slice(-3).reverse();
    return { live: [...live, ...recent], upcoming, alerts };
  }, [rides, now, alertByRide]);

  const visibleList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = lists[tab];
    if (!q) return list;
    return list.filter((r) => `#${r.number} ${r.number} ${r.customer_name} ${r.pickup_address} ${r.dropoff_address} ${r.flight_number ?? ""}`.toLowerCase().includes(q));
  }, [lists, tab, query]);

  const ride = selectedRide ? state.rides[selectedRide] : null;
  const rideDriver = ride?.driver_id ? state.drivers[ride.driver_id] : undefined;
  // Réseau partagé (A) : « Réseau · Flotte B » / « proposée au réseau partagé » (rien pour une course propre)
  const partners = state.partners;
  const networkOf = useCallback((r: LiveRide) => liveNetworkLabel(r, orgId, partners), [orgId, partners]);
  const rideNetwork = useMemo(() => {
    if (!ride) return null;
    const label = networkOf(ride);
    return label ? { label, held: livePartner(ride, orgId).held, lock: liveNetworkLock(ride, orgId) } : null;
  }, [ride, networkOf, orgId]);

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
  }, [ride?.id, ride?.status, rideDriver?.location?.lat, rideDriver?.location?.lng]);

  const selectRide = (id: string | null) => {
    setSelectedRide(id);
    setSelectedDriver(null);
    setSelectedReport(null);
    setAssignOpen(false);
    const r = id ? state.rides[id] : null;
    if (!r) return;
    const pts: Coord[] = [[r.pickup_lng, r.pickup_lat]];
    if (r.route_polyline) pts.push(...decodePolyline(r.route_polyline));
    else if (r.dropoff_lng != null && r.dropoff_lat != null) pts.push([r.dropoff_lng, r.dropoff_lat]);
    const d = r.driver_id ? state.drivers[r.driver_id] : null;
    if (d?.location) pts.push([d.location.lng, d.location.lat]);
    // Tracé pas encore chargé : cadrage complété à son arrivée s'il déborde (effet ci-dessous)
    pendingRouteFit.current = r.route_polyline === undefined ? { rideId: r.id, pts } : null;
    mapRef.current?.fitPoints(pts);
  };
  const selectDriver = (id: string | null) => {
    setSelectedDriver(id);
    if (id) setSelectedReport(null);
    const d = id ? state.drivers[id] : null;
    if (d?.location) mapRef.current?.flyTo(d.location.lng, d.location.lat, 14.5);
  };
  const selectReport = (id: string | null) => {
    setSelectedReport(id);
    if (id) setSelectedDriver(null);
  };
  // Fonctions stables pour les lignes mémorisées (liste des courses, flotte)
  const selectHandlers = useRef({ selectRide, selectDriver });
  selectHandlers.current = { selectRide, selectDriver };
  const onRowSelect = useCallback((id: string) => selectHandlers.current.selectRide(id), []);
  const onFleetSelect = useCallback((id: string) => selectHandlers.current.selectDriver(id), []);

  // Tracé d'une course : absent de l'instantané (sauf client à bord), chargé quand il doit être dessiné
  const pendingRouteFit = useRef<{ rideId: string; pts: Coord[] } | null>(null);
  const routeRequests = useRef(new Map<string, number>());
  const missingRoutes = useMemo(
    () =>
      Object.values(state.rides)
        .filter((r) => r.route_polyline === undefined && (r.id === selectedRide || ON_BOARD.has(r.status)))
        .map((r) => r.id)
        .join(","),
    [state.rides, selectedRide],
  );
  useEffect(() => {
    if (!missingRoutes) return;
    for (const id of missingRoutes.split(",")) {
      const last = routeRequests.current.get(id);
      if (last && Date.now() - last < 30_000) continue;
      routeRequests.current.set(id, Date.now());
      fetch(`/api/dashboard/rides/${id}?route=1`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((j: { route_polyline?: string | null } | null) => {
          if (j) dispatch({ type: "route", id, polyline: j.route_polyline ?? null });
        })
        .catch(() => undefined);
    }
  }, [missingRoutes]);
  useEffect(() => {
    const fit = pendingRouteFit.current;
    if (!ride || !fit || fit.rideId !== ride.id || ride.route_polyline === undefined) return;
    pendingRouteFit.current = null;
    if (!ride.route_polyline) return;
    const line = decodePolyline(ride.route_polyline);
    const lngs = fit.pts.map((p) => p[0]);
    const lats = fit.pts.map((p) => p[1]);
    const [w, e, s, n] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
    if (line.some(([lng, lat]) => lng < w || lng > e || lat < s || lat > n)) mapRef.current?.fitPoints([...fit.pts, ...line]);
  }, [ride]);

  // Ouverture d'une course / d'un signalement depuis une alerte (toast, cloche, notification) ou l'URL
  const selectRideRef = useRef(selectRide);
  selectRideRef.current = selectRide;
  const ridesRef = useRef(state.rides);
  ridesRef.current = state.rides;
  const reportsRef = useRef(state.reports);
  reportsRef.current = state.reports;
  useEffect(() => {
    // Course hors du direct (terminée, trop ancienne) : sa fiche complète
    const open = (id: string, assign = false) => {
      if (!ridesRef.current[id]) return window.location.assign(`/dashboard/rides/${id}`);
      selectRideRef.current(id);
      if (assign) window.setTimeout(() => setAssignOpen(true), 0);
    };
    const openReport = (id: string) => {
      const r = reportsRef.current[id];
      if (!r || Date.parse(r.expires_at) <= Date.now()) {
        toast.info("Ce signalement a expiré", { description: "Il n'est plus affiché sur la carte." });
        return;
      }
      setShowReports(true);
      setSelectedRide(null);
      setSelectedDriver(null);
      setSelectedReport(id);
      mapRef.current?.fitPoints([[r.lng, r.lat]]);
    };
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) open(id);
    };
    const onAssign = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) open(id, true);
    };
    const onReport = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) openReport(id);
    };
    window.addEventListener("rydar:focus-ride", onFocus);
    window.addEventListener("rydar:assign-ride", onAssign);
    window.addEventListener("rydar:focus-report", onReport);
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("ride");
    const reportFromUrl = params.get("report");
    if (fromUrl || reportFromUrl) {
      // la carte applique ce cadrage à la place du cadrage initial sur la flotte, même si elle charge encore
      window.setTimeout(() => (fromUrl ? open(fromUrl, params.get("assign") === "1") : openReport(reportFromUrl!)), 0);
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => {
      window.removeEventListener("rydar:focus-ride", onFocus);
      window.removeEventListener("rydar:assign-ride", onAssign);
      window.removeEventListener("rydar:focus-report", onReport);
    };
  }, []);

  const driver = selectedDriver ? state.drivers[selectedDriver] : null;
  const driverRide = driver?.current_ride_id ? state.rides[driver.current_ride_id] : null;
  const fleetCenter = useMemo(() => {
    const pts = drivers.filter((d) => d.location).map((d) => d.location!);
    if (!pts.length) return null;
    return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  }, [drivers]);
  const rideFeed = useMemo(() => (ride ? feed.filter((e) => e.ride_id === ride.id) : []), [feed, ride]);
  const alertCount = lists.alerts.length;

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
          alertRideIds={alertRideIds}
          onSelectDriver={selectDriver}
          onSelectRide={selectRide}
          showOffline={showOffline}
          showLabels={showLabels}
          approach={approach}
          theme={mapTheme}
          staleMs={locationMaxAgeS * 1000}
          padding={mapPadding}
          reports={showReports ? reports : undefined}
          selectedReportId={selectedReport}
          onSelectReport={selectReport}
        />
      </div>

      {/* Indicateurs + outils (haut droite) */}
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-start gap-2">
        <KpiStrip kpis={state.kpis} className="pointer-events-auto hidden min-[1400px]:flex" />
        <div className="glass pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1 lg:p-1.5">
          <Tooltip content={showReports ? "Masquer les signalements" : "Afficher les signalements"}>
            <Button variant="ghost" size="icon-sm" onClick={toggleReports} aria-label="Signalements de la flotte" aria-pressed={showReports} className="relative">
              <Siren className={cn(showReports && "text-amber")} />
              {showReports && reports.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-amber px-0.5 text-[9.5px] font-bold tabular-nums text-ink-950">
                  {reports.length}
                </span>
              )}
            </Button>
          </Tooltip>
          <span className="hidden lg:contents">
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
          </span>
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
            firstPassWaves={firstPassWaves}
            approachS={approach?.rideId === ride.id ? approach.durationS : null}
            liveEvents={rideFeed}
            alert={alertByRide[ride.id]}
            now={now}
            assignOpen={assignOpen}
            onAssignOpenChange={setAssignOpen}
            onBack={() => setSelectedRide(null)}
            onSelectDriver={selectDriver}
            network={rideNetwork}
          />
        ) : (
          <>
            <div className="space-y-2.5 px-3 pb-2 pt-3">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.035] p-1">
                {(
                  [
                    { k: "live", label: "En cours", n: lists.live.filter((r) => !TERMINAL.has(r.status)).length },
                    { k: "upcoming", label: "À venir", n: lists.upcoming.length },
                    { k: "alerts", label: "Alertes", n: alertCount },
                  ] as const
                ).map(({ k, label, n }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTab(k)}
                    className={cn("flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors", tab === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg")}
                  >
                    {label}
                    {k === "alerts" && n > 0 ? (
                      <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-red/15 px-1 text-[11px] font-semibold tabular-nums text-red">{n}</span>
                    ) : (
                      <span className="tabular-nums text-fg-subtle">{n}</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="N° de course, client, adresse, vol"
                  aria-label="Rechercher une course" title="Rechercher une course"
                  className="h-8 w-full rounded-lg border border-line-field bg-white/[0.04] pl-8 pr-2 text-[12.5px] outline-none placeholder:text-fg-subtle focus:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-brand/70"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {visibleList.length === 0 ? (
                <div className="flex flex-col items-center px-6 py-14 text-center">
                  <Radar className="mb-3 size-6 text-fg-subtle" />
                  <p className="text-[13px] font-medium">Aucune course {tab === "alerts" ? "en alerte" : tab === "upcoming" ? "à venir" : "en cours"}</p>
                  <p className="mt-1 text-[12px] text-fg-subtle">
                    {tab === "alerts" ? "Retards, GPS muets, vols annulés et courses sans chauffeur s'afficheront ici." : "Les nouvelles courses apparaissent ici instantanément."}
                  </p>
                  {tab !== "alerts" && (
                    <Button variant="secondary" size="sm" className="mt-4" onClick={() => setNewRideOpen(true)}>
                      <Plus /> Nouvelle course <kbd className="kbd ml-1">N</kbd>
                    </Button>
                  )}
                </div>
              ) : (
                visibleList.map((r) => (
                  <RideRow
                    key={r.id}
                    ride={r}
                    driver={r.driver_id ? state.drivers[r.driver_id] : undefined}
                    offers={offersByRide[r.id] ?? 0}
                    selected={false}
                    onSelect={onRowSelect}
                    now={now}
                    timeout={offerTimeout}
                    alert={alertByRide[r.id]}
                    networkLabel={networkOf(r)}
                  />
                ))
              )}
            </div>
          </>
        )}
      </aside>

      {/* Flotte (droite) */}
      <aside className="z-10 hidden min-h-0 xl:glass xl:absolute xl:bottom-3 xl:right-3 xl:top-[76px] xl:flex xl:w-[312px] xl:flex-col xl:rounded-2xl">
        <FleetPanel drivers={drivers} rides={state.rides} selectedId={selectedDriver} onSelect={onFleetSelect} now={serverNow} staleMs={locationMaxAgeS * 1000} className="flex-1" />
      </aside>

      {/* Fiche chauffeur sélectionné */}
      {driver && (
        <div className="glass absolute bottom-3 left-1/2 z-30 w-[340px] max-w-[calc(100vw-24px)] -translate-x-1/2 animate-rise rounded-2xl p-4 lg:left-[calc(50%+40px)]">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-ink-600 text-[13px] font-semibold" style={{ boxShadow: `0 0 0 2px ${PRESENCE_COLOR[driver.presence]}` }}>
              {initials(driver.first_name, driver.last_name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">
                {driver.first_name} {driver.last_name} <span className="text-[12px] font-normal text-fg-subtle">#{driver.number}</span>
              </p>
              {driver.network_giver ? (
                // Réseau partagé (B) : course d'une autre organisation, position non partagée pendant la course (Q5)
                <p className="text-[12.5px] text-violet">
                  En course partenaire ({driver.network_giver})
                  <span className="text-fg-subtle"> · position masquée pendant la course</span>
                </p>
              ) : (
                <p className="text-[12.5px]" style={{ color: PRESENCE_COLOR[driver.presence] }}>
                  {PRESENCE_META[driver.presence].label}
                  <span className="text-fg-subtle"> · {driver.location ? `vu à ${formatTime(driver.location.updated_at)}` : "position inconnue"}</span>
                </p>
              )}
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
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={`tel:${driver.phone}`} title={formatPhone(driver.phone)}>
                <Phone /> Appeler
              </a>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href={`/dashboard/messages?driver=${driver.id}`}>
                <MessageSquareText /> Message
              </Link>
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
