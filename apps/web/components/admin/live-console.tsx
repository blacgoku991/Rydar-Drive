"use client";
import {
  DISPATCH_MODEL_META, PRESENCE_META, RIDE_STATUS_META, RIDE_TYPE_LABELS, VEHICLE_CATEGORY_META,
  decodePolyline, formatPhone, formatRideDate, formatTime, initials, shortAddress,
  type Coord, type DriverPresence, type VehicleCategory,
} from "@rydar/shared";
import { ChevronRight, Crosshair, LocateFixed, Navigation2, Phone, Search, SlidersHorizontal, Tag, X } from "lucide-react";
import Link from "next/link";
import { Dialog as D } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRESENCE_COLOR, rideColor } from "@/components/map/map-theme";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Switch, Tooltip } from "@/components/ui/misc";
import { useNow, useSharedNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { LiveMap, type LiveMapDriver, type LiveMapFocus, type LiveMapHandle, type MapPadding } from "./live-map";
import {
  BUSY_PRESENCES, ONLINE_PRESENCES, PRESENCE_SHORT, STALE_MS, WAITING_STATUSES, compassPoint, formatAge, textOn,
  type AdminLiveDriver, type AdminLiveOffer, type AdminLiveOrg, type AdminLiveRide, type AdminLiveSnapshot,
} from "./live-types";

type ModelFilter = "all" | "fleet" | "centrale";
type PresenceFilter = "all" | (typeof ONLINE_PRESENCES)[number];
type Selection = { kind: "driver" | "ride"; id: string } | null;

const POLL_MS = 5000;
/** Au-delà, la liste est tronquée (la carte affiche tout) : affiner avec les filtres. */
const LIST_MAX = 300;
const PRESENCE_ORDER: DriverPresence[] = ["available", "offered", "en_route", "arrived", "on_trip", "offline"];
/** Marges de cadrage : panneau à gauche (bureau), barre en haut (mobile) ; fiche ouverte à droite ou en bas. */
function mapPadding(desktop: boolean, card: boolean): MapPadding {
  return desktop
    ? { top: 72, bottom: 96, left: 436, right: card ? 428 : 72 }
    : { top: 84, bottom: card ? 380 : 48, left: 36, right: 36 };
}

// --------------------------------------------------------------------------- petits éléments

/** Sigle coloré de l'organisation (même rendu que sur la carte). */
function OrgTag({ org, size = "sm" }: { org: AdminLiveOrg | undefined; size?: "xs" | "sm" | "md" }) {
  const color = org?.color ?? "#666d79";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-[5px] font-bold leading-none tracking-[0.02em]",
        size === "xs" ? "h-4 min-w-4 px-0.5 text-[8.5px]" : size === "sm" ? "h-5 min-w-5 px-1 text-[9.5px]" : "size-8 rounded-lg text-[11.5px]",
      )}
      style={{ background: color, color: textOn(color) }}
    >
      {org?.code ?? "?"}
    </span>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-white/[0.035] px-2 py-1.5">
      <p className="text-[17px] font-semibold leading-tight tabular-nums" style={{ color: value > 0 ? color : undefined }}>
        {value}
      </p>
      <p className="truncate text-[11px] text-fg-muted">{label}</p>
    </div>
  );
}

function Chip({ active, onClick, label, n, color }: { active: boolean; onClick: () => void; label: string; n: number; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors",
        active ? "bg-white/[0.1] text-fg" : "text-fg-muted hover:bg-white/[0.05] hover:text-fg",
        !n && !active && "opacity-50",
      )}
    >
      {color && <span className="size-1.5 rounded-full" style={{ background: color }} />}
      {label}
      <span className="tabular-nums text-fg-subtle">{n}</span>
    </button>
  );
}

function Detail({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11.5px] text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-[12.5px] leading-snug text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

// --------------------------------------------------------------------------- composant principal

export function LiveConsole({ initial, initialOrg }: { initial: AdminLiveSnapshot; initialOrg: string | null }) {
  const [snap, setSnap] = useState(initial);
  // Écart horloge navigateur / serveur : les âges de position sont calculés à l'heure du serveur
  const [skew, setSkew] = useState(0);
  const [sync, setSync] = useState<{ at: number | null; error: string | null }>({ at: null, error: null });
  const [model, setModel] = useState<ModelFilter>("all");
  const [orgFilter, setOrgFilter] = useState<string>(initialOrg ?? "all");
  const [presence, setPresence] = useState<PresenceFilter>("all");
  const [showStale, setShowStale] = useState(true);
  const [showWaiting, setShowWaiting] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [tab, setTab] = useState<"orgs" | "drivers">(initialOrg ? "drivers" : "orgs");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [drawer, setDrawer] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const [route, setRoute] = useState<{ rideId: string; coords: Coord[] | null } | null>(null);
  const mapRef = useRef<LiveMapHandle>(null);
  // Horloge de l'écran : 15 s (fraîcheur des positions, minutes avant prise en charge) ; les âges affichés à la seconde
  // (liste, fiches, « Actualisé il y a ») ont leur propre horloge commune, sans re-rendre toute la console.
  const now = useNow(15_000);
  const initialServerNow = useMemo(() => Date.parse(initial.serverTime), [initial.serverTime]);
  const serverNow = now != null ? now - skew : initialServerNow;
  const clock = useMemo(() => ({ skew, fallback: initialServerNow }), [skew, initialServerNow]);

  // ------------------------------------------------------------------ rafraîchissement toutes les 5 s (pause onglet caché)
  const inflight = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const load = useCallback(async () => {
    if (inflight.current || stopped.current) return;
    const ctrl = new AbortController();
    inflight.current = ctrl;
    // Réponse bloquée (réseau mobile, serveur figé) : abandon après 15 s, sinon plus aucun rafraîchissement
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 15_000);
    try {
      const res = await fetch("/api/admin/live", { cache: "no-store", signal: ctrl.signal });
      if (res.status === 401 || res.status === 403) {
        stopped.current = true;
        setSync((s) => ({ ...s, error: "Session expirée : reconnectez-vous." }));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as AdminLiveSnapshot;
      setSnap(json);
      setSkew(Date.now() - Date.parse(json.serverTime));
      setSync({ at: Date.now(), error: null });
    } catch (err) {
      if ((err as Error).name !== "AbortError" || timedOut) setSync((s) => ({ ...s, error: "Connexion perdue, nouvel essai dans 5 s" }));
    } finally {
      window.clearTimeout(timeout);
      if (inflight.current === ctrl) inflight.current = null;
    }
  }, []);

  useEffect(() => {
    setSkew(Date.now() - Date.parse(initial.serverTime));
    setSync({ at: Date.now(), error: null });
    let timer: number | undefined;
    const stop = () => {
      if (timer) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => void load(), POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) return stop();
      void load();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
    };
  }, [load, initial.serverTime]);

  // Mise en page (panneau latéral ≥ lg, tiroir sinon)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => {
      setDesktop(mq.matches);
      if (mq.matches) setDrawer(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Échap : ferme la fiche
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("[role=dialog]")) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------------ données dérivées
  const orgById = useMemo(() => Object.fromEntries(snap.orgs.map((o) => [o.id, o])) as Record<string, AdminLiveOrg>, [snap.orgs]);
  const rideById = useMemo(() => Object.fromEntries(snap.rides.map((r) => [r.id, r])) as Record<string, AdminLiveRide>, [snap.rides]);
  // Offres en attente : course proposée à chaque chauffeur, chauffeurs sollicités par course
  const offerByDriver = useMemo(() => {
    const m: Record<string, AdminLiveOffer> = {};
    for (const o of snap.offers ?? []) if (rideById[o.ride_id]) m[o.driver_id] = o;
    return m;
  }, [snap.offers, rideById]);
  const offeredByRide = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const o of snap.offers ?? []) (m[o.ride_id] ??= []).push(o.driver_id);
    return m;
  }, [snap.offers]);
  // Fraîcheur des positions recalculée toutes les 15 s (évite de redessiner la carte chaque seconde)
  const staleTick = Math.floor(serverNow / 15_000);
  const isStale = useCallback(
    (d: AdminLiveDriver) => !d.location || staleTick * 15_000 - Date.parse(d.location.updated_at) > STALE_MS,
    [staleTick],
  );

  const inModel = useCallback((orgId: string) => model === "all" || orgById[orgId]?.dispatch_model === model, [model, orgById]);
  const inScope = useCallback((orgId: string) => inModel(orgId) && (orgFilter === "all" || orgFilter === orgId), [inModel, orgFilter]);

  /** Chauffeurs du périmètre (modèle + organisation), avant filtre de statut. */
  const scoped = useMemo(() => snap.drivers.filter((d) => inScope(d.organization_id)), [snap.drivers, inScope]);
  const presenceCounts = useMemo(() => {
    const c = { all: 0, available: 0, offered: 0, en_route: 0, arrived: 0, on_trip: 0 } as Record<PresenceFilter, number>;
    for (const d of scoped) {
      if (!showStale && isStale(d)) continue;
      c.all++;
      if (d.presence in c) c[d.presence as PresenceFilter]++;
    }
    return c;
  }, [scoped, showStale, isStale]);
  const filtered = useMemo(
    () => scoped.filter((d) => (presence === "all" || d.presence === presence) && (showStale || !isStale(d))),
    [scoped, presence, showStale, isStale],
  );
  const mapDrivers = useMemo(
    () => filtered.filter((d): d is AdminLiveDriver & { location: NonNullable<AdminLiveDriver["location"]> } => !!d.location).map((d) => ({ ...d, stale: isStale(d) }) as LiveMapDriver),
    [filtered, isStale],
  );
  const waiting = useMemo(() => snap.rides.filter((r) => WAITING_STATUSES.has(r.status) && inScope(r.organization_id)), [snap.rides, inScope]);

  const summary = useMemo(() => {
    let available = 0;
    let busy = 0;
    let stale = 0;
    for (const d of scoped) {
      if (isStale(d)) stale++;
      if (d.presence === "available") available++;
      if (BUSY_PRESENCES.has(d.presence)) busy++;
    }
    return { online: scoped.length, available, busy, stale, waiting: waiting.length };
  }, [scoped, waiting, isStale]);

  const modelCounts = useMemo(() => {
    const c = { all: snap.drivers.length, fleet: 0, centrale: 0 };
    for (const d of snap.drivers) c[orgById[d.organization_id]?.dispatch_model === "centrale" ? "centrale" : "fleet"]++;
    return c;
  }, [snap.drivers, orgById]);

  /** Compteurs par organisation (en ligne / disponibles / en course / en attente), triés par chauffeurs en ligne. */
  const orgRows = useMemo(() => {
    const rows = new Map(
      snap.orgs.filter((o) => inModel(o.id)).map((o) => [o.id, { org: o, online: 0, available: 0, busy: 0, stale: 0, waiting: 0 }]),
    );
    for (const d of snap.drivers) {
      const r = rows.get(d.organization_id);
      if (!r) continue;
      r.online++;
      if (d.presence === "available") r.available++;
      if (BUSY_PRESENCES.has(d.presence)) r.busy++;
      if (isStale(d)) r.stale++;
    }
    for (const ride of snap.rides) {
      const r = rows.get(ride.organization_id);
      if (r && WAITING_STATUSES.has(ride.status)) r.waiting++;
    }
    return [...rows.values()].sort((a, b) => b.online - a.online || b.waiting - a.waiting || a.org.name.localeCompare(b.org.name, "fr"));
  }, [snap.orgs, snap.drivers, snap.rides, inModel, isStale]);

  const driverList = useMemo(() => {
    const term = query.trim().toLowerCase();
    return filtered
      .filter((d) => !term || `${d.first_name} ${d.last_name} ${d.number} ${d.vehicle?.plate ?? ""} ${orgById[d.organization_id]?.name ?? ""}`.toLowerCase().includes(term))
      .sort(
        (a, b) =>
          Number(isStale(a)) - Number(isStale(b)) ||
          PRESENCE_ORDER.indexOf(a.presence) - PRESENCE_ORDER.indexOf(b.presence) ||
          a.first_name.localeCompare(b.first_name, "fr"),
      );
  }, [filtered, query, orgById, isStale]);

  // ------------------------------------------------------------------ sélection
  const selectedDriver = selection?.kind === "driver" ? snap.drivers.find((d) => d.id === selection.id) ?? null : null;
  const driverRideId = selectedDriver ? selectedDriver.current_ride_id ?? offerByDriver[selectedDriver.id]?.ride_id ?? null : null;
  const selectedRide = selection?.kind === "ride" ? rideById[selection.id] ?? null : driverRideId ? rideById[driverRideId] ?? null : null;
  // Sélection disparue (chauffeur passé hors ligne, course attribuée hors périmètre) : fiche fermée
  useEffect(() => {
    if (selection && !(selection.kind === "driver" ? selectedDriver : selectedRide)) setSelection(null);
  }, [selection, selectedDriver, selectedRide]);

  // Tracé de la course mise en avant (une requête par course)
  const focusRideId = selectedRide?.id ?? null;
  const routeCache = useRef(new Map<string, Coord[] | null>());
  useEffect(() => {
    if (!focusRideId) return setRoute(null);
    const cached = routeCache.current.get(focusRideId);
    if (cached !== undefined) return setRoute({ rideId: focusRideId, coords: cached });
    setRoute({ rideId: focusRideId, coords: null });
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/live?ride=${focusRideId}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { route_polyline: string | null };
        const coords = json.route_polyline ? decodePolyline(json.route_polyline) : null;
        routeCache.current.set(focusRideId, coords);
        if (!cancelled) setRoute({ rideId: focusRideId, coords });
      } catch {
        // tracé indisponible (réseau, réponse illisible) : trait direct départ → arrivée
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusRideId]);

  const focusDriverLoc = selectedDriver?.location ?? (selectedRide?.driver_id ? snap.drivers.find((d) => d.id === selectedRide.driver_id)?.location : null) ?? null;
  const focus = useMemo<LiveMapFocus | null>(
    () =>
      selectedRide
        ? {
            ride: selectedRide,
            route: route?.rideId === selectedRide.id ? route.coords : null,
            from: focusDriverLoc ? { lat: focusDriverLoc.lat, lng: focusDriverLoc.lng } : null,
          }
        : null,
    [selectedRide, route, focusDriverLoc],
  );

  const padding = mapPadding(desktop, !!selection);
  const selectDriver = (id: string | null, fly = false) => {
    setSelection(id ? { kind: "driver", id } : null);
    const d = id ? snap.drivers.find((x) => x.id === id) : null;
    if (fly && d?.location) mapRef.current?.flyTo(d.location.lng, d.location.lat, 14.5, mapPadding(desktop, true));
  };
  const selectRide = (id: string | null) => {
    setSelection(id ? { kind: "ride", id } : null);
    const r = id ? rideById[id] : null;
    if (!r) return;
    const pts: Coord[] = [[r.pickup_lng, r.pickup_lat]];
    if (r.dropoff_lng != null && r.dropoff_lat != null) pts.push([r.dropoff_lng, r.dropoff_lat]);
    mapRef.current?.fitPoints(pts, mapPadding(desktop, true));
  };
  const fitDrivers = (list: AdminLiveDriver[], rides: AdminLiveRide[] = []) => {
    const fresh = list.filter((d) => d.location && !isStale(d));
    const pts: Coord[] = (fresh.length ? fresh : list.filter((d) => d.location)).map((d) => [d.location!.lng, d.location!.lat]);
    for (const r of rides) pts.push([r.pickup_lng, r.pickup_lat]);
    mapRef.current?.fitPoints(pts, mapPadding(desktop, !!selection));
  };
  const recenter = () => fitDrivers(filtered, showWaiting ? waiting : []);
  /** Périmètre « organisation » + cadrage sur ses chauffeurs ; `toggle` : un second clic revient à toutes. */
  const pickOrg = (id: string, toggle = true) => {
    const next = toggle && orgFilter === id ? "all" : id;
    setOrgFilter(next);
    setPresence("all");
    const list = snap.drivers.filter((d) => inModel(d.organization_id) && (next === "all" || d.organization_id === next));
    fitDrivers(list, showWaiting ? snap.rides.filter((r) => WAITING_STATUSES.has(r.status) && (next === "all" || r.organization_id === next)) : []);
    if (next !== "all") setTab("drivers");
  };
  const changeModel = (m: ModelFilter) => {
    setModel(m);
    const keepOrg = orgFilter !== "all" && (m === "all" || orgById[orgFilter]?.dispatch_model === m);
    if (!keepOrg) setOrgFilter("all");
    const match = (orgId: string) => (m === "all" || orgById[orgId]?.dispatch_model === m) && (!keepOrg || orgId === orgFilter);
    fitDrivers(
      snap.drivers.filter((d) => match(d.organization_id)),
      showWaiting ? snap.rides.filter((r) => WAITING_STATUSES.has(r.status) && match(r.organization_id)) : [],
    );
  };


  // ------------------------------------------------------------------ panneau (latéral ou tiroir)
  // Bureau : seule la liste défile ; tiroir mobile : tout le panneau défile (fermeture : croix, Échap ou voile)
  const panel = (inDrawer: boolean) => (
    <div className={inDrawer ? "h-full overflow-y-auto overscroll-contain" : "flex h-full min-h-0 flex-col"}>
      <div className="border-b border-white/[0.05] px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2.5">
          <span className={cn("size-2 shrink-0 rounded-full", sync.error ? "bg-amber" : "bg-brand")} aria-hidden />
          <div className="min-w-0 flex-1">
            <h1 className="text-[14px] font-semibold tracking-tight">Carte en direct</h1>
            <p className={cn("truncate text-[12px]", sync.error ? "text-amber" : "text-fg-muted")} aria-live="polite">
              <SyncLabel sync={sync} />
            </p>
          </div>
          {inDrawer && (
            <D.Close className="grid size-10 place-items-center rounded-lg text-fg-muted hover:bg-white/5 hover:text-fg">
              <X className="size-4" />
              <span className="sr-only">Fermer</span>
            </D.Close>
          )}
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <Stat label="En ligne" value={summary.online} />
          <Stat label="Disponibles" value={summary.available} color={PRESENCE_COLOR.available} />
          <Stat label="Occupés" value={summary.busy} color={PRESENCE_COLOR.on_trip} />
          <Stat label="En attente" value={summary.waiting} color={PRESENCE_COLOR.offered} />
        </div>
        {summary.stale > 0 && (
          <p className="mt-2 text-[11.5px] text-fg-muted">
            {summary.stale} position{summary.stale > 1 ? "s" : ""} de plus de 10 min{showStale ? " (grisées sur la carte)" : " masquée" + (summary.stale > 1 ? "s" : "")}
          </p>
        )}
      </div>

      <div className="space-y-2.5 border-b border-white/[0.05] px-3 py-3">
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.035] p-1" role="group" aria-label="Type d'organisation">
          {(
            [
              { k: "all", label: "Toutes" },
              { k: "fleet", label: "Flottes" },
              { k: "centrale", label: "Centrales" },
            ] as const
          ).map(({ k, label }) => (
            <button
              key={k}
              type="button"
              onClick={() => changeModel(k)}
              aria-pressed={model === k}
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors",
                model === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {label}
              <span className="tabular-nums text-fg-subtle">{modelCounts[k]}</span>
            </button>
          ))}
        </div>
        <NativeSelect value={orgFilter} onChange={(e) => pickOrg(e.target.value, false)} aria-label="Organisation" className="h-9 text-[13px]">
          <option value="all">Toutes les organisations</option>
          {orgRows.map((r) => (
            <option key={r.org.id} value={r.org.id}>
              {r.org.name} · {r.online} en ligne
            </option>
          ))}
        </NativeSelect>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Statut">
          <Chip active={presence === "all"} onClick={() => setPresence("all")} label="Tous" n={presenceCounts.all} />
          {ONLINE_PRESENCES.map((p) => (
            <Chip key={p} active={presence === p} onClick={() => setPresence(presence === p ? "all" : p)} label={PRESENCE_SHORT[p]} n={presenceCounts[p]} color={PRESENCE_COLOR[p]} />
          ))}
        </div>
        <div className="space-y-1.5 px-1 pt-0.5">
          <label className="flex min-h-8 cursor-pointer items-center justify-between gap-3 text-[12.5px] text-fg-muted">
            Positions de plus de 10 min
            <Switch checked={showStale} onCheckedChange={setShowStale} aria-label="Afficher les positions de plus de 10 min" />
          </label>
          <label className="flex min-h-8 cursor-pointer items-center justify-between gap-3 text-[12.5px] text-fg-muted">
            Courses en attente de chauffeur
            <Switch checked={showWaiting} onCheckedChange={setShowWaiting} aria-label="Afficher les courses en attente de chauffeur" />
          </label>
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/[0.035] p-1" role="tablist">
          {(
            [
              { k: "orgs", label: "Organisations", n: orgRows.length },
              { k: "drivers", label: "Chauffeurs", n: filtered.length },
            ] as const
          ).map(({ k, label, n }) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors",
                tab === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {label}
              <span className="tabular-nums text-fg-subtle">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === "orgs" ? (
        <div className={cn("px-2 pb-2 pt-2", !inDrawer && "min-h-0 flex-1 overflow-y-auto")}>
          <div className="flex items-center gap-3 px-2.5 pb-1 text-[11px] text-fg-subtle">
            <span className="flex-1">Organisation</span>
            <span className="grid w-[132px] shrink-0 grid-cols-3 gap-1 text-right">
              <span>En ligne</span>
              <span>Dispo.</span>
              <span title="En route, sur place ou en course">Occupés</span>
            </span>
          </div>
          {orgRows.map(({ org, online, available, busy, waiting: w }) => {
            const active = orgFilter === org.id;
            return (
              <button
                key={org.id}
                type="button"
                onClick={() => {
                  pickOrg(org.id);
                  if (inDrawer && orgFilter !== org.id) setDrawer(false);
                }}
                aria-pressed={active}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                  active ? "bg-white/[0.08]" : "hover:bg-white/[0.035]",
                  !online && !active && "opacity-60",
                )}
              >
                <OrgTag org={org} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">{org.name}</span>
                  <span className="block truncate text-[11.5px] text-fg-muted">
                    {org.dispatch_model === "centrale" ? "Centrale" : "Flotte"}
                    {org.city ? ` · ${org.city}` : ""}
                    {org.status === "suspended" ? <span className="text-amber"> · suspendue</span> : null}
                    {w > 0 ? <span className="text-amber"> · {w} en attente</span> : null}
                  </span>
                </span>
                <span className="grid w-[132px] shrink-0 grid-cols-3 gap-1 text-right text-[13px] tabular-nums">
                  <span className="text-fg">{online}</span>
                  <span className={available ? "text-brand" : "text-fg-subtle"}>{available}</span>
                  <span className={busy ? "text-cyan" : "text-fg-subtle"}>{busy}</span>
                </span>
              </button>
            );
          })}
          {!orgRows.length && <p className="px-3 py-8 text-center text-[12.5px] text-fg-muted">Aucune organisation de ce type.</p>}
        </div>
      ) : (
        <div className={cn(!inDrawer && "flex min-h-0 flex-1 flex-col")}>
          <div className="px-3 pb-1 pt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Nom, n°, plaque, organisation"
                aria-label="Rechercher un chauffeur"
                className="h-9 w-full rounded-lg border border-line-field bg-white/[0.04] pl-8 pr-2 text-[12.5px] outline-none placeholder:text-fg-subtle focus:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-brand/70"
              />
            </div>
          </div>
          <div className={cn("px-2 pb-2 pt-1", !inDrawer && "min-h-0 flex-1 overflow-y-auto")}>
            {driverList.slice(0, LIST_MAX).map((d) => {
              const org = orgById[d.organization_id];
              const stale = isStale(d);
              const rideId = d.current_ride_id ?? offerByDriver[d.id]?.ride_id;
              const ride = rideId ? rideById[rideId] : undefined;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    selectDriver(d.id, true);
                    if (inDrawer) setDrawer(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                    selection?.kind === "driver" && selection.id === d.id ? "bg-white/[0.08]" : "hover:bg-white/[0.035]",
                  )}
                >
                  <span className="relative shrink-0">
                    <span className={cn("grid size-9 place-items-center rounded-full bg-ink-600 text-[11px] font-semibold", stale ? "text-fg-subtle" : "text-fg-muted")}>
                      {initials(d.first_name, d.last_name)}
                    </span>
                    <span
                      className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-ink-800"
                      style={{ background: stale ? PRESENCE_COLOR.offline : PRESENCE_COLOR[d.presence] }}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">
                      {d.first_name} {d.last_name} <span className="font-normal text-fg-subtle">n° {d.number}</span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px]">
                      <OrgTag org={org} size="xs" />
                      <span className="shrink-0" style={{ color: PRESENCE_COLOR[d.presence] }}>
                        {PRESENCE_SHORT[d.presence]}
                        {ride ? ` · ${ride.number}` : ""}
                      </span>
                      <span className="truncate text-fg-muted">· {org?.name ?? "—"}</span>
                    </span>
                  </span>
                  <span className={cn("shrink-0 text-right text-[11.5px] tabular-nums", stale ? "text-amber" : "text-fg-muted")}>
                    {d.location ? <Age at={d.location.updated_at} clock={clock} /> : "sans GPS"}
                  </span>
                </button>
              );
            })}
            {driverList.length > LIST_MAX && (
              <p className="px-3 py-3 text-center text-[12px] text-fg-muted">
                {LIST_MAX} premiers sur {driverList.length} : affinez avec les filtres ou la recherche.
              </p>
            )}
            {!driverList.length && <p className="px-3 py-8 text-center text-[12.5px] text-fg-muted">Aucun chauffeur en ligne dans ce filtre.</p>}
          </div>
        </div>
      )}

      {inDrawer && (
        <div className="border-t border-white/[0.05] px-4 py-3">
          <Legend />
        </div>
      )}
    </div>
  );

  // ------------------------------------------------------------------ rendu
  const selectedOrg = selectedDriver ? orgById[selectedDriver.organization_id] : selectedRide ? orgById[selectedRide.organization_id] : undefined;

  return (
    <div className="relative h-[calc(100dvh-56px)] overflow-hidden lg:h-dvh">
      <LiveMap
        ref={mapRef}
        drivers={mapDrivers}
        waiting={showWaiting ? waiting : []}
        orgs={orgById}
        focus={focus}
        selectedDriverId={selectedDriver?.id ?? null}
        selectedRideId={selection?.kind === "ride" ? selection.id : null}
        onSelectDriver={(id) => selectDriver(id)}
        onSelectRide={(id) => (id ? selectRide(id) : setSelection(null))}
        showLabels={showLabels}
        padding={padding}
      />

      {/* Panneau latéral (bureau) */}
      <aside className="glass absolute bottom-3 left-3 top-3 z-10 hidden w-[380px] flex-col overflow-hidden rounded-2xl lg:flex" aria-label="Filtres et listes">
        {panel(false)}
      </aside>

      {/* Barre du haut (mobile) : ouvre le tiroir */}
      <div className="absolute inset-x-3 top-3 z-10 flex items-center gap-2 lg:hidden">
        <button type="button" onClick={() => setDrawer(true)} className="glass flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-left">
          <SlidersHorizontal className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">
              {summary.online} en ligne
              <span className="font-normal text-fg-muted">
                {" "}· {summary.available} dispo. · {summary.busy} occupés
              </span>
            </span>
            <span className={cn("block truncate text-[11.5px]", sync.error ? "text-amber" : "text-fg-muted")}>
              {orgFilter !== "all" ? orgById[orgFilter]?.name : model === "all" ? "Toutes les organisations" : model === "fleet" ? "Flottes" : "Centrales"}
              {presence !== "all" ? ` · ${PRESENCE_SHORT[presence]}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-[12px] font-medium text-brand">Filtres</span>
        </button>
        <Button variant="secondary" size="icon" className="glass size-12 rounded-xl" onClick={recenter} aria-label="Recentrer la carte">
          <Crosshair />
        </Button>
      </div>

      {/* Outils (bureau) */}
      <div className="glass absolute right-3 top-3 z-10 hidden items-center gap-0.5 rounded-2xl p-1.5 lg:flex">
        <Tooltip content={showLabels ? "Masquer les noms" : "Afficher les noms"}>
          <Button variant="ghost" size="icon-sm" onClick={() => setShowLabels((v) => !v)} aria-label="Noms des chauffeurs" aria-pressed={showLabels}>
            <Tag className={cn(showLabels && "text-brand")} />
          </Button>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={recenter}>
          <Crosshair /> Recentrer
        </Button>
      </div>

      {/* Légende (bureau) */}
      <div className="glass pointer-events-none absolute bottom-3 left-[404px] z-10 hidden rounded-xl px-3 py-2 lg:block">
        <Legend />
      </div>

      {/* Fiche chauffeur / course */}
      {(selectedDriver || selectedRide) && (
        <div className="glass absolute inset-x-3 bottom-3 z-20 max-h-[62dvh] overflow-y-auto rounded-2xl p-4 lg:inset-x-auto lg:bottom-auto lg:right-3 lg:top-[64px] lg:max-h-[calc(100dvh-80px)] lg:w-[360px]">
          {selectedDriver ? (
            <DriverCard
              driver={selectedDriver}
              org={selectedOrg}
              ride={selectedRide}
              offer={offerByDriver[selectedDriver.id] ?? null}
              clock={clock}
              stale={isStale(selectedDriver)}
              onClose={() => setSelection(null)}
              onCenter={() => selectedDriver.location && mapRef.current?.flyTo(selectedDriver.location.lng, selectedDriver.location.lat, 15, mapPadding(desktop, true))}
              onShowRide={() => {
                if (!selectedRide) return;
                const pts: Coord[] = [[selectedRide.pickup_lng, selectedRide.pickup_lat]];
                if (selectedRide.dropoff_lng != null && selectedRide.dropoff_lat != null) pts.push([selectedRide.dropoff_lng, selectedRide.dropoff_lat]);
                if (selectedDriver.location) pts.push([selectedDriver.location.lng, selectedDriver.location.lat]);
                if (route?.rideId === selectedRide.id && route.coords) pts.push(...route.coords);
                mapRef.current?.fitPoints(pts, mapPadding(desktop, true));
              }}
            />
          ) : selectedRide ? (
            <RideCard
              ride={selectedRide}
              org={selectedOrg}
              clock={clock}
              driver={selectedRide.driver_id ? snap.drivers.find((d) => d.id === selectedRide.driver_id) ?? null : null}
              offeredTo={(offeredByRide[selectedRide.id] ?? []).map((id) => snap.drivers.find((d) => d.id === id)).filter((d): d is AdminLiveDriver => !!d)}
              onClose={() => setSelection(null)}
              onSelectDriver={(id) => selectDriver(id, true)}
            />
          ) : null}
        </div>
      )}

      {/* Tiroir (mobile) */}
      <D.Root open={drawer} onOpenChange={setDrawer}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <D.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[86dvh] flex-col overflow-hidden rounded-t-2xl border-t border-line-strong bg-ink-850 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-8">
            <D.Title className="sr-only">Filtres de la carte</D.Title>
            <D.Description className="sr-only">Organisations, statuts et liste des chauffeurs en ligne</D.Description>
            {panel(true)}
          </D.Content>
        </D.Portal>
      </D.Root>
    </div>
  );
}

// --------------------------------------------------------------------------- légende

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-fg-muted">
      {ONLINE_PRESENCES.map((p) => (
        <span key={p} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border-2" style={{ borderColor: PRESENCE_COLOR[p] }} />
          {PRESENCE_SHORT[p]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full" style={{ background: PRESENCE_COLOR.offered, boxShadow: "0 0 0 2px #0b0d10, 0 0 0 3px #f5b544" }} />
        Course en attente
      </span>
      <span className="flex items-center gap-1.5">
        <span className="grid h-3.5 min-w-3.5 place-items-center rounded-[4px] bg-fg-muted px-0.5 text-[8px] font-bold text-ink-950">AB</span>
        Sigle de l'organisation
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border-2 border-fg-subtle opacity-50" />
        Position &gt; 10 min
      </span>
    </div>
  );
}

// --------------------------------------------------------------------------- fiches

function OrgLink({ org }: { org: AdminLiveOrg | undefined }) {
  if (!org) return null;
  return (
    <Link href={`/admin/organizations/${org.id}`} className="mt-3 flex items-center gap-2.5 rounded-xl bg-white/[0.04] px-3 py-2 transition-colors hover:bg-white/[0.07]">
      <OrgTag org={org} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{org.name}</span>
        <span className="block truncate text-[11.5px] text-fg-muted">
          {DISPATCH_MODEL_META[org.dispatch_model].label}
          {org.city ? ` · ${org.city}` : ""}
          {org.status === "suspended" ? <span className="text-amber"> · suspendue</span> : null}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
    </Link>
  );
}

function RideSummary({ ride, onClick, heading, note }: { ride: AdminLiveRide; onClick?: () => void; heading?: string; note?: React.ReactNode }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn("mt-3 block w-full rounded-xl bg-white/[0.04] px-3 py-2.5 text-left text-[12.5px]", onClick && "transition-colors hover:bg-white/[0.07]")}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-fg">{heading ?? `Course ${ride.number}`}</span>
        {!heading && <span className="shrink-0" style={{ color: rideColor(ride.status) }}>{RIDE_STATUS_META[ride.status]?.label ?? ride.status}</span>}
      </span>
      {note && <span className="mt-0.5 block text-[11.5px] text-fg-muted">{note}</span>}
      <span className="mt-1.5 flex items-start gap-2">
        <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: rideColor(ride.status) }} />
        <span className="min-w-0 truncate text-fg">{shortAddress(ride.pickup_address)}</span>
      </span>
      <span className="mt-1 flex items-start gap-2">
        <span className="mt-1 size-2 shrink-0 rounded-[2px] bg-fg" />
        <span className="min-w-0 truncate text-fg">{shortAddress(ride.dropoff_address)}</span>
      </span>
      {onClick && <span className="mt-1.5 block text-[11.5px] text-fg-muted">Voir le trajet sur la carte</span>}
    </Comp>
  );
}

/** Heure du serveur (horloge du navigateur corrigée de l'écart mesuré) ; `fallback` : heure du rendu serveur. */
type ServerClock = { skew: number; fallback: number };

/** Heure du serveur, rafraîchie chaque seconde (horloge commune à tous les âges affichés). */
function useServerNow({ skew, fallback }: ServerClock) {
  return useSharedNow(1000, fallback + skew) - skew;
}

/** « 12 s », « 3 min » : âge d'une position à l'heure du serveur. */
function Age({ at, clock }: { at: string; clock: ServerClock }) {
  return <>{formatAge(useServerNow(clock) - Date.parse(at))}</>;
}

/** « Actualisé il y a 3 s · toutes les 5 s » (horloge du navigateur, comme l'heure de la dernière lecture). */
function SyncLabel({ sync }: { sync: { at: number | null; error: string | null } }) {
  const now = useSharedNow(1000, Number.NaN);
  if (sync.error) return <>{sync.error}</>;
  return <>{sync.at && !Number.isNaN(now) ? `Actualisé il y a ${formatAge(now - sync.at)} · toutes les 5 s` : "Actualisation toutes les 5 s"}</>;
}

function DriverCard({
  driver: d,
  org,
  ride,
  offer,
  clock,
  stale,
  onClose,
  onCenter,
  onShowRide,
}: {
  driver: AdminLiveDriver;
  org: AdminLiveOrg | undefined;
  ride: AdminLiveRide | null;
  offer: AdminLiveOffer | null;
  clock: ServerClock;
  stale: boolean;
  onClose: () => void;
  onCenter: () => void;
  onShowRide: () => void;
}) {
  const serverNow = useServerNow(clock);
  const loc = d.location;
  const speedKmh = loc?.speed_mps != null && loc.speed_mps >= 0 ? Math.round(loc.speed_mps * 3.6) : null;
  const category = d.vehicle?.category ? VEHICLE_CATEGORY_META[d.vehicle.category as VehicleCategory]?.label ?? d.vehicle.category : null;
  return (
    <>
      <div className="flex items-start gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-full bg-ink-600 text-[13px] font-semibold"
          style={{ boxShadow: `0 0 0 2px ${stale ? PRESENCE_COLOR.offline : PRESENCE_COLOR[d.presence]}` }}
        >
          {initials(d.first_name, d.last_name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold">
            {d.first_name} {d.last_name} <span className="text-[12px] font-normal text-fg-subtle">n° {d.number}</span>
          </p>
          <p className="text-[12.5px]" style={{ color: PRESENCE_COLOR[d.presence] }}>
            {PRESENCE_META[d.presence].label}
            {d.online_since && <span className="text-fg-muted"> · en ligne depuis {formatTime(d.online_since)}</span>}
          </p>
        </div>
        <button type="button" onClick={onClose} className="-mr-1 -mt-1 grid size-9 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Fermer la fiche">
          <X className="size-4" />
        </button>
      </div>

      <OrgLink org={org} />

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Detail label="Téléphone">
          <a href={`tel:${d.phone}`} className="hover:text-brand">
            {formatPhone(d.phone)}
          </a>
        </Detail>
        <Detail label="Catégorie">{category ?? "—"}</Detail>
        <Detail label="Véhicule">{d.vehicle ? [d.vehicle.brand, d.vehicle.model].filter(Boolean).join(" ") + (d.vehicle.color ? ` · ${d.vehicle.color}` : "") : "Sans véhicule"}</Detail>
        <Detail label="Plaque">{d.vehicle ? <span className="mono">{d.vehicle.plate}</span> : "—"}</Detail>
        <Detail label="Dernière position">
          {loc ? (
            <span className={stale ? "text-amber" : undefined}>
              il y a {formatAge(serverNow - Date.parse(loc.updated_at))}
              {stale ? " · ancienne" : loc.accuracy_m != null ? <span className="text-fg-muted"> · ±{Math.round(loc.accuracy_m)}{" "}m</span> : null}
            </span>
          ) : (
            <span className="text-amber">Aucune position</span>
          )}
        </Detail>
        <Detail label="Vitesse · cap">
          {loc && (speedKmh != null || loc.heading != null) ? (
            <span className="inline-flex items-center gap-1.5">
              {speedKmh != null && <span className="tabular-nums">{speedKmh}{" "}km/h</span>}
              {speedKmh != null && loc.heading != null && <span className="text-fg-subtle">·</span>}
              {loc.heading != null && (
                <>
                  <Navigation2 className="size-3.5 text-fg-muted" style={{ transform: `rotate(${loc.heading}deg)` }} aria-hidden />
                  <span className="tabular-nums">
                    {compassPoint(loc.heading)} {Math.round(((loc.heading % 360) + 360) % 360)}°
                  </span>
                </>
              )}
            </span>
          ) : (
            "—"
          )}
        </Detail>
      </dl>

      {ride && (
        <RideSummary
          ride={ride}
          onClick={onShowRide}
          {...(offer && offer.ride_id === ride.id && !d.current_ride_id
            ? {
                heading: `Course ${ride.number} proposée`,
                note: offer.expires_at
                  ? Date.parse(offer.expires_at) > serverNow
                    ? `Réponse attendue sous ${formatAge(Date.parse(offer.expires_at) - serverNow)}`
                    : "Délai de réponse écoulé"
                  : "En attente de réponse",
              }
            : {})}
        />
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button asChild variant="secondary" size="sm" className="h-10">
          <a href={`tel:${d.phone}`}>
            <Phone /> Appeler
          </a>
        </Button>
        <Button variant="secondary" size="sm" className="h-10" onClick={onCenter} disabled={!loc}>
          <LocateFixed /> Centrer
        </Button>
      </div>
    </>
  );
}

function RideCard({
  ride,
  org,
  driver,
  offeredTo,
  clock,
  onClose,
  onSelectDriver,
}: {
  ride: AdminLiveRide;
  org: AdminLiveOrg | undefined;
  driver: AdminLiveDriver | null;
  offeredTo: AdminLiveDriver[];
  clock: ServerClock;
  onClose: () => void;
  onSelectDriver: (id: string) => void;
}) {
  const serverNow = useServerNow(clock);
  const inMin = Math.round((Date.parse(ride.pickup_at) - serverNow) / 60_000);
  const category = VEHICLE_CATEGORY_META[ride.vehicle_category as VehicleCategory]?.label ?? ride.vehicle_category;
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: rideColor(ride.status), boxShadow: "0 0 0 3px #0b0d10" }} />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold">Course {ride.number}</p>
          <p className="text-[12.5px]" style={{ color: rideColor(ride.status) }}>
            {RIDE_STATUS_META[ride.status]?.label ?? ride.status}
            <span className="text-fg-muted"> · {RIDE_TYPE_LABELS[ride.type]}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} className="-mr-1 -mt-1 grid size-9 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Fermer la fiche">
          <X className="size-4" />
        </button>
      </div>
      <OrgLink org={org} />
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Detail label="Départ prévu">
          {formatRideDate(ride.pickup_at)}
          {WAITING_STATUSES.has(ride.status) && (
            <span className={cn("block", inMin < 0 ? "text-amber" : "text-fg-muted")}>
              {inMin < 0 ? `En retard de ${formatAge(-inMin * 60_000)}` : inMin === 0 ? "Maintenant" : `Dans ${formatAge(inMin * 60_000)}`}
            </span>
          )}
        </Detail>
        <Detail label="Catégorie">
          {category} · {ride.passengers} pass.
        </Detail>
        {WAITING_STATUSES.has(ride.status) && <Detail label="Recherche">{ride.dispatch_wave > 0 ? `vague ${ride.dispatch_wave}` : "en cours"}</Detail>}
      </dl>
      <RideSummary ride={ride} heading="Trajet" />
      {offeredTo.length > 0 && (
        <div className="mt-3">
          <p className="text-[11.5px] text-fg-muted">Proposée à {offeredTo.length} chauffeur{offeredTo.length > 1 ? "s" : ""}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {offeredTo.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => onSelectDriver(d.id)}
                className="flex h-9 items-center gap-2 rounded-lg bg-white/[0.05] px-2.5 text-[12.5px] transition-colors hover:bg-white/[0.09]"
              >
                <span className="size-2 rounded-full" style={{ background: PRESENCE_COLOR[d.presence] }} />
                {d.first_name} {d.last_name.charAt(0)}.
              </button>
            ))}
          </div>
        </div>
      )}
      {driver && (
        <Button variant="secondary" size="sm" className="mt-3 h-10 w-full" onClick={() => onSelectDriver(driver.id)}>
          Chauffeur : {driver.first_name} {driver.last_name}
        </Button>
      )}
    </>
  );
}
