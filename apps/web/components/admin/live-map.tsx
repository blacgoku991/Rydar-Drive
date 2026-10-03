"use client";
import { initials, shortAddress, type Coord } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { PRESENCE_COLOR, ROUTE_COLOR, rideColor } from "@/components/map/map-theme";
import { MapUnavailable } from "@/components/map/map-unavailable";
import { carElement, stopElement, updateCar } from "@/components/map/markers";
import { EMPTY, setData, useMapLibre } from "@/components/map/use-maplibre";
import { cn } from "@/lib/utils";
import { textOn, type AdminLiveDriver, type AdminLiveOrg, type AdminLiveRide } from "./live-types";

type MLMarker = import("maplibre-gl").Marker;

export type LiveMapDriver = AdminLiveDriver & { location: NonNullable<AdminLiveDriver["location"]>; stale: boolean };
/** Course mise en avant (chauffeur sélectionné ou épingle) : départ, arrivée, tracé, approche. */
export type LiveMapFocus = { ride: AdminLiveRide; route: Coord[] | null; from: { lat: number; lng: number } | null };
/** `padding` : marges du cadrage (sinon celles des props, qui suivent la fiche ouverte au rendu suivant). */
export type LiveMapHandle = {
  fitPoints: (pts: Coord[], padding?: MapPadding) => void;
  flyTo: (lng: number, lat: number, zoom?: number, padding?: MapPadding) => void;
};
export type MapPadding = { top: number; bottom: number; left: number; right: number };

type Props = {
  drivers: LiveMapDriver[];
  waiting: AdminLiveRide[];
  orgs: Record<string, AdminLiveOrg>;
  focus: LiveMapFocus | null;
  selectedDriverId: string | null;
  selectedRideId: string | null;
  onSelectDriver: (id: string | null) => void;
  onSelectRide: (id: string | null) => void;
  showLabels: boolean;
  padding: MapPadding;
  className?: string;
};

const TO_PICKUP = new Set(["ACCEPTED", "DRIVER_EN_ROUTE"]);
const WAITING = new Set(["SEARCHING_DRIVER", "OFFERED"]);
const ON_BOARD = new Set(["PASSENGER_ONBOARD", "IN_PROGRESS"]);
/**
 * En dessous de ce zoom (vue région / France) : chauffeurs regroupés en bulles WebGL avec compteur ;
 * à partir de ce zoom (vue ville) : marqueurs détaillés (initiales, statut, cap, sigle de l'organisation).
 */
const DETAIL_ZOOM = 10;
type GeoJSONSource = import("maplibre-gl").GeoJSONSource;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Sigle de l'organisation accroché au marqueur (couleur stable de l'organisation).
 * Véhicule avec un cap connu : le sigle se place à l'opposé de la flèche de cap (« à l'arrière »),
 * pour ne jamais la masquer ; sinon en haut à droite.
 */
function setOrgTag(el: HTMLElement, org: AdminLiveOrg | undefined, size: "car" | "pin", heading: number | null = null) {
  let tag = el.querySelector<HTMLSpanElement>("[data-org-tag]");
  if (!tag) {
    tag = document.createElement("span");
    tag.dataset.orgTag = "";
    Object.assign(tag.style, {
      position: "absolute",
      transform: "translate(-50%, -50%)",
      minWidth: "13px",
      height: "13px",
      padding: "0 2px",
      borderRadius: "4px",
      border: "1.5px solid #0b0d10",
      font: "700 8px/13px var(--font-sans), system-ui, sans-serif",
      letterSpacing: "0.02em",
      textAlign: "center",
      pointerEvents: "none",
      boxSizing: "content-box",
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(tag);
  }
  // position du centre du sigle, relative au centre du marqueur (26 px véhicule, 18 px épingle)
  const half = size === "car" ? 13 : 9;
  let dx = size === "car" ? 13 : 11;
  let dy = size === "car" ? -11 : -10;
  if (heading != null) {
    const a = ((heading + 180) * Math.PI) / 180;
    dx = Math.round(Math.sin(a) * 19);
    dy = Math.round(-Math.cos(a) * 19);
  }
  const left = `${half + dx}px`;
  const top = `${half + dy}px`;
  if (tag.style.left !== left) tag.style.left = left;
  if (tag.style.top !== top) tag.style.top = top;
  if (size === "car") {
    // Sigle passé sous le marqueur (cap vers le nord) : le nom (6 px sous le marqueur) descend d'autant, sinon le sigle le chevauche
    const label = el.querySelector<HTMLElement>(".rd-car__label");
    const tagBottom = half + dy + 8; // demi-hauteur du sigle : 13 px + bordures
    const labelTop = tagBottom + 3 > 2 * half + 6 ? `${tagBottom + 3}px` : "";
    if (label && label.style.top !== labelTop) label.style.top = labelTop;
  }
  const code = org?.code ?? "?";
  const color = org?.color ?? "#666d79";
  if (tag.textContent !== code) tag.textContent = code;
  if (tag.dataset.color !== color) {
    tag.dataset.color = color;
    tag.style.background = color;
    tag.style.color = textOn(color);
  }
}

/** Départ / arrivée de la course mise en avant : un clic ne remonte pas jusqu'à la carte (qui fermerait la fiche). */
function keepSelection(el: HTMLElement) {
  el.addEventListener("click", (e) => e.stopPropagation());
  return el;
}

export const LiveMap = forwardRef<LiveMapHandle, Props>(function LiveMap(
  { drivers, waiting, orgs, focus, selectedDriverId, selectedRideId, onSelectDriver, onSelectRide, showLabels, padding, className },
  ref,
) {
  const { containerRef, libRef, mapRef, ready, failed } = useMapLibre({ zoom: 11 });
  const cars = useRef(new Map<string, { marker: MLMarker; el: HTMLDivElement; pos: [number, number]; anim?: number }>());
  const pins = useRef(new Map<string, { marker: MLMarker; el: HTMLDivElement }>());
  const focusMarks = useRef<{ start: MLMarker | null; end: MLMarker | null }>({ start: null, end: null });
  const fitted = useRef(false);
  const callbacks = useRef({ onSelectDriver, onSelectRide });
  callbacks.current = { onSelectDriver, onSelectRide };
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  /** Vue détaillée (zoom ≥ DETAIL_ZOOM) : marqueurs HTML ; sinon bulles de regroupement. */
  const detailed = useRef(true);
  const selectedRef = useRef<{ driver: string | null; ride: string | null }>({ driver: null, ride: null });
  selectedRef.current = { driver: selectedDriverId, ride: selectedRideId };
  /** Marqueur HTML visible en vue détaillée, ou s'il est sélectionné. */
  const applyDetail = useCallback((id: string, el: HTMLElement) => {
    el.style.display = detailed.current || id === selectedRef.current.driver || id === selectedRef.current.ride ? "" : "none";
  }, []);

  // ------------------------------------------------------------------ calques (tracé de la course mise en avant)
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const layout = { "line-cap": "round" as const, "line-join": "round" as const };
    map.addSource("adm-route", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "adm-route-casing",
      type: "line",
      source: "adm-route",
      filter: ["!=", ["get", "dashed"], true],
      layout,
      paint: { "line-color": ROUTE_COLOR.casing, "line-width": ["+", ["get", "width"], 4], "line-opacity": 0.9 },
    });
    map.addLayer({
      id: "adm-route-line",
      type: "line",
      source: "adm-route",
      filter: ["!=", ["get", "dashed"], true],
      layout,
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
    });
    map.addLayer({
      id: "adm-route-dashed",
      type: "line",
      source: "adm-route",
      filter: ["==", ["get", "dashed"], true],
      layout,
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-dasharray": [1.2, 2] },
    });

    // Regroupement des chauffeurs aux petits zooms (police des libellés reprise du style chargé)
    const symbolFont = map
      .getStyle()
      .layers.map((l) => (l.type === "symbol" ? (l.layout as Record<string, unknown> | undefined)?.["text-font"] : undefined))
      .find((f): f is string[] => Array.isArray(f) && f.every((x) => typeof x === "string"));
    // Courses en attente en vue large : petits points ambre (épingles HTML en vue ville)
    map.addSource("adm-waiting", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "adm-waiting-points",
      type: "circle",
      source: "adm-waiting",
      maxzoom: DETAIL_ZOOM,
      paint: { "circle-color": ["get", "color"], "circle-radius": 4.5, "circle-stroke-color": "#0b0d10", "circle-stroke-width": 2 },
    });
    map.addSource("adm-drivers", { type: "geojson", data: EMPTY, cluster: true, clusterMaxZoom: DETAIL_ZOOM - 1, clusterRadius: 44 });
    map.addLayer({
      id: "adm-clusters",
      type: "circle",
      source: "adm-drivers",
      maxzoom: DETAIL_ZOOM,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#101318",
        "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 50, 24, 200, 30],
        "circle-stroke-color": "#eef0f3",
        "circle-stroke-opacity": 0.55,
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "adm-cluster-count",
      type: "symbol",
      source: "adm-drivers",
      maxzoom: DETAIL_ZOOM,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": symbolFont ?? ["Noto Sans Regular"],
        "text-size": 12.5,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": "#eef0f3" },
    });
    map.addLayer({
      id: "adm-points",
      type: "circle",
      source: "adm-drivers",
      maxzoom: DETAIL_ZOOM,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": 6,
        "circle-stroke-color": "#0b0d10",
        "circle-stroke-width": 2,
        "circle-opacity": ["case", ["get", "stale"], 0.4, 1],
      },
    });
    const interactive = ["adm-clusters", "adm-points", "adm-waiting-points"];
    const hit = (point: import("maplibre-gl").PointLike) => map.queryRenderedFeatures(point, { layers: interactive })[0];
    map.on("mousemove", (e) => {
      map.getCanvas().style.cursor = hit(e.point) ? "pointer" : "";
    });
    map.on("click", (e) => {
      const f = hit(e.point);
      if (f?.properties?.cluster_id != null) {
        // bulle : zoom jusqu'à l'éclatement du groupe
        const center = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        void (map.getSource("adm-drivers") as GeoJSONSource)
          .getClusterExpansionZoom(Number(f.properties.cluster_id))
          .then((zoom) => map.easeTo({ center, zoom: Math.max(zoom, map.getZoom() + 1), duration: 600 }))
          .catch(() => undefined);
        return;
      }
      if (f?.properties?.ride) return callbacks.current.onSelectRide(String(f.properties.ride));
      if (f?.properties?.id) return callbacks.current.onSelectDriver(String(f.properties.id));
      callbacks.current.onSelectDriver(null);
      callbacks.current.onSelectRide(null);
    });
    // Bascule bulles ⇄ marqueurs détaillés au franchissement du seuil
    const onZoom = () => {
      const next = map.getZoom() >= DETAIL_ZOOM;
      if (next === detailed.current) return;
      detailed.current = next;
      cars.current.forEach((m, id) => applyDetail(id, m.el));
      pins.current.forEach((p, id) => applyDetail(id, p.el));
    };
    onZoom();
    map.on("zoom", onZoom);
    const carsMap = cars.current;
    const pinsMap = pins.current;
    const marks = focusMarks.current;
    return () => {
      carsMap.forEach((m) => cancelAnimationFrame(m.anim ?? 0));
      carsMap.clear();
      pinsMap.clear();
      marks.start = null;
      marks.end = null;
    };
  }, [ready, mapRef, applyDetail]);

  // ------------------------------------------------------------------ cadrage
  const fitPoints = useCallback(
    (pts: Coord[], pad?: MapPadding) => {
      const map = mapRef.current;
      const lib = libRef.current;
      if (!map || !lib || !pts.length) return;
      const bounds = pts.reduce((b, p) => b.extend(p), new lib.LngLatBounds(pts[0]!, pts[0]!));
      map.fitBounds(bounds, { padding: pad ?? paddingRef.current, maxZoom: 14.5, duration: 900 });
    },
    [mapRef, libRef],
  );
  useImperativeHandle(
    ref,
    () => ({
      fitPoints,
      // `offset` et non `padding` : MapLibre garderait la marge, qui s'ajouterait à celle des fitBounds suivants
      flyTo: (lng, lat, zoom = 14.5, pad) => {
        const p = pad ?? paddingRef.current;
        mapRef.current?.flyTo({ center: [lng, lat], zoom, offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2], speed: 1.4, essential: true });
      },
    }),
    [fitPoints, mapRef],
  );

  // ------------------------------------------------------------------ chauffeurs
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const seen = new Set<string>();
    for (const d of drivers) {
      seen.add(d.id);
      const target: [number, number] = [d.location.lng, d.location.lat];
      let m = cars.current.get(d.id);
      if (!m) {
        const el = carElement();
        const id = d.id;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          callbacks.current.onSelectDriver(id);
        });
        const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat(target).addTo(map);
        m = { marker, el, pos: target };
        cars.current.set(d.id, m);
      } else if (m.pos[0] !== target[0] || m.pos[1] !== target[1]) {
        // déplacement animé : le marqueur glisse vers la nouvelle position (pas de recréation)
        cancelAnimationFrame(m.anim ?? 0);
        const from = m.marker.getLngLat();
        const start = performance.now();
        const entry = m;
        const step = (t: number) => {
          const k = Math.min(1, (t - start) / 1600);
          const e = ease(k);
          entry.marker.setLngLat([from.lng + (target[0] - from.lng) * e, from.lat + (target[1] - from.lat) * e]);
          if (k < 1) entry.anim = requestAnimationFrame(step);
        };
        entry.anim = requestAnimationFrame(step);
        m.pos = target;
      }
      const org = orgs[d.organization_id];
      const selected = d.id === selectedDriverId;
      updateCar(m.el, {
        color: PRESENCE_COLOR[d.presence] ?? PRESENCE_COLOR.offline,
        heading: d.location.heading,
        // flèche de cap dès qu'un cap est connu (position récente)
        moving: d.location.heading != null && !d.stale,
        initials: initials(d.first_name, d.last_name),
        label: `${d.first_name} ${d.last_name.charAt(0)}. · ${org?.name ?? "—"}${d.stale ? " · position ancienne" : ""}`,
        selected,
        pulse: false,
        dim: d.stale,
      });
      setOrgTag(m.el, org, "car", d.location.heading != null && !d.stale ? d.location.heading : null);
      m.el.setAttribute("aria-label", `${d.first_name} ${d.last_name}, ${org?.name ?? ""}`);
      m.el.style.zIndex = selected ? "8" : d.stale ? "2" : "4";
      applyDetail(d.id, m.el);
    }
    for (const [id, m] of cars.current) {
      if (seen.has(id)) continue;
      cancelAnimationFrame(m.anim ?? 0);
      m.marker.remove();
      cars.current.delete(id);
    }
    // Même jeu de chauffeurs pour les bulles de regroupement (vue région / France)
    setData(
      map,
      "adm-drivers",
      drivers
        .filter((d) => d.id !== selectedDriverId)
        .map((d) => ({
          type: "Feature" as const,
          properties: { id: d.id, color: d.stale ? PRESENCE_COLOR.offline : (PRESENCE_COLOR[d.presence] ?? PRESENCE_COLOR.offline), stale: d.stale },
          geometry: { type: "Point" as const, coordinates: [d.location.lng, d.location.lat] },
        })),
    );
  }, [drivers, orgs, selectedDriverId, ready, mapRef, libRef, applyDetail]);

  // ------------------------------------------------------------------ courses en attente de chauffeur
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const seen = new Set<string>();
    for (const r of waiting) {
      seen.add(r.id);
      let p = pins.current.get(r.id);
      if (!p) {
        const el = stopElement("start");
        const id = r.id;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          callbacks.current.onSelectRide(id);
        });
        const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat([r.pickup_lng, r.pickup_lat]).addTo(map);
        p = { marker, el };
        pins.current.set(r.id, p);
      }
      const org = orgs[r.organization_id];
      p.marker.setLngLat([r.pickup_lng, r.pickup_lat]);
      p.el.style.setProperty("--c", rideColor(r.status));
      p.el.title = `Course ${r.number} · ${org?.name ?? ""} · ${shortAddress(r.pickup_address)} · en attente de chauffeur`;
      p.el.dataset.searching = "false";
      p.el.dataset.dim = String(!!selectedRideId && selectedRideId !== r.id);
      // agrandissement sur le point intérieur : MapLibre positionne l'élément racine avec `transform`
      const dot = p.el.querySelector<HTMLElement>(".rd-stop__dot");
      if (dot) dot.style.transform = r.id === selectedRideId ? "scale(1.3)" : "";
      p.el.style.zIndex = r.id === selectedRideId ? "7" : "3";
      setOrgTag(p.el, org, "pin");
      applyDetail(r.id, p.el);
    }
    for (const [id, p] of pins.current) {
      if (seen.has(id)) continue;
      p.marker.remove();
      pins.current.delete(id);
    }
    setData(
      map,
      "adm-waiting",
      waiting
        .filter((r) => r.id !== selectedRideId)
        .map((r) => ({
          type: "Feature" as const,
          properties: { ride: r.id, color: rideColor(r.status) },
          geometry: { type: "Point" as const, coordinates: [r.pickup_lng, r.pickup_lat] },
        })),
    );
  }, [waiting, orgs, selectedRideId, ready, mapRef, libRef, applyDetail]);

  // ------------------------------------------------------------------ course mise en avant
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const marks = focusMarks.current;
    const features: GeoJSON.Feature[] = [];
    const r = focus?.ride;
    const pinned = r ? pins.current.has(r.id) : false;
    // Départ (sauf si déjà épinglé comme course en attente, ou client à bord)
    if (r && !pinned && !ON_BOARD.has(r.status)) {
      if (!marks.start) marks.start = new lib.Marker({ element: keepSelection(stopElement("start")), anchor: "center" }).setLngLat([r.pickup_lng, r.pickup_lat]).addTo(map);
      marks.start.setLngLat([r.pickup_lng, r.pickup_lat]);
      marks.start.getElement().style.setProperty("--c", rideColor(r.status));
    } else if (marks.start) {
      marks.start.remove();
      marks.start = null;
    }
    // Arrivée
    if (r && r.dropoff_lat != null && r.dropoff_lng != null) {
      if (!marks.end) marks.end = new lib.Marker({ element: keepSelection(stopElement("end")), anchor: "center" }).setLngLat([r.dropoff_lng, r.dropoff_lat]).addTo(map);
      marks.end.setLngLat([r.dropoff_lng, r.dropoff_lat]);
      const trip: Coord[] = focus.route?.length ? focus.route : [[r.pickup_lng, r.pickup_lat], [r.dropoff_lng, r.dropoff_lat]];
      features.push({
        type: "Feature",
        properties: { color: ON_BOARD.has(r.status) ? ROUTE_COLOR.onboard : ROUTE_COLOR.trip, width: 4, dashed: !focus.route?.length },
        geometry: { type: "LineString", coordinates: trip },
      });
    } else if (marks.end) {
      marks.end.remove();
      marks.end = null;
    }
    // Approche du chauffeur vers le départ (trait direct, indicatif) ; ambre : course proposée à ce chauffeur
    if (r && focus.from && (TO_PICKUP.has(r.status) || WAITING.has(r.status))) {
      features.push({
        type: "Feature",
        properties: { color: WAITING.has(r.status) ? rideColor(r.status) : ROUTE_COLOR.approach, width: 3, dashed: true },
        geometry: { type: "LineString", coordinates: [[focus.from.lng, focus.from.lat], [r.pickup_lng, r.pickup_lat]] },
      });
    }
    setData(map, "adm-route", features);
    // `waiting` : l'épingle de départ dépend des courses en attente affichées (interrupteur, filtres)
  }, [focus, waiting, ready, mapRef, libRef]);

  // ------------------------------------------------------------------ cadrage initial (une seule fois)
  useEffect(() => {
    if (!ready || fitted.current) return;
    const pts: Coord[] = drivers.filter((d) => !d.stale).map((d) => [d.location.lng, d.location.lat]);
    for (const r of waiting) pts.push([r.pickup_lng, r.pickup_lat]);
    if (!pts.length) for (const d of drivers) pts.push([d.location.lng, d.location.lat]);
    if (!pts.length) return;
    fitted.current = true;
    fitPoints(pts);
  }, [drivers, waiting, ready, fitPoints]);

  // MapLibre force `position: relative` sur son conteneur : on l'enveloppe.
  return (
    <div data-labels={showLabels} className={cn("rd-map absolute inset-0 bg-ink-900", className)}>
      <div ref={containerRef} className="size-full" />
      {failed && <MapUnavailable />}
    </div>
  );
});
