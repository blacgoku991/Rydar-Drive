"use client";
import { circlePolygon, decodePolyline, initials, shortAddress, type Coord, type DriverPresence } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { LiveDriver, LiveOffer, LiveRide } from "@/lib/queries/live";
import { cn } from "@/lib/utils";
import { PRESENCE_COLOR, ROUTE_COLOR, rideColor } from "./map-theme";
import { carElement, stopElement, updateCar } from "./markers";
import { EMPTY, setData, useMapLibre } from "./use-maplibre";

type MLMarker = import("maplibre-gl").Marker;

export type FleetMapHandle = {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  fitAll: () => void;
  fitPoints: (points: Coord[]) => void;
};

type Padding = { top: number; bottom: number; left: number; right: number };

type Props = {
  drivers: LiveDriver[];
  rides: LiveRide[];
  offers: LiveOffer[];
  selectedDriverId?: string | null;
  selectedRideId?: string | null;
  onSelectDriver?: (id: string | null) => void;
  onSelectRide?: (id: string | null) => void;
  showOffline?: boolean;
  showLabels?: boolean;
  padding?: Padding;
  className?: string;
  interactive?: boolean;
  initialZoom?: number;
  /** Points à cadrer au chargement (sinon : flotte en ligne + courses proches). */
  focus?: [number, number][];
  /** Itinéraire d'approche réel (chauffeur → départ) de la course sélectionnée. */
  approach?: { rideId: string; coordinates: Coord[] } | null;
  theme?: "night" | "day";
};

const STALE_MS = 3 * 60_000;
const SEARCHING = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED"]);
const TO_PICKUP = new Set(["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]);
const ON_BOARD = new Set(["PASSENGER_ONBOARD", "IN_PROGRESS"]);
const TERMINAL = new Set(["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"]);

type CarMarker = { marker: MLMarker; el: HTMLDivElement; pos: [number, number]; anim?: number };
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const polyCache = new Map<string, Coord[]>();
function routeOf(r: LiveRide): Coord[] | null {
  if (!r.route_polyline) return null;
  let c = polyCache.get(r.route_polyline);
  if (!c) {
    c = decodePolyline(r.route_polyline);
    if (polyCache.size > 400) polyCache.clear();
    polyCache.set(r.route_polyline, c);
  }
  return c;
}

export const FleetMap = forwardRef<FleetMapHandle, Props>(function FleetMap(
  {
    drivers,
    rides,
    offers,
    selectedDriverId,
    selectedRideId,
    onSelectDriver,
    onSelectRide,
    showOffline = false,
    showLabels = false,
    padding = { top: 40, bottom: 40, left: 40, right: 40 },
    className,
    interactive = true,
    initialZoom = 11.6,
    focus,
    approach,
    theme = "night",
  },
  ref,
) {
  const { containerRef, libRef, mapRef, ready } = useMapLibre({ interactive, zoom: initialZoom, theme });
  const cars = useRef(new Map<string, CarMarker>());
  const stops = useRef(new Map<string, { marker: MLMarker; el: HTMLDivElement }>());
  const ends = useRef(new Map<string, MLMarker>());
  const fitted = useRef(false);
  const callbacks = useRef({ onSelectDriver, onSelectRide });
  callbacks.current = { onSelectDriver, onSelectRide };
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const dataRef = useRef({ drivers, rides, focus });
  dataRef.current = { drivers, rides, focus };

  // ---------------------------------------------------------------- calques
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const lineLayout = { "line-cap": "round" as const, "line-join": "round" as const };
    map.addSource("rd-radius", { type: "geojson", data: EMPTY });
    map.addSource("rd-routes", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "rd-radius-fill",
      type: "fill",
      source: "rd-radius",
      paint: { "fill-color": "#f5b544", "fill-opacity": 0.05 },
    });
    map.addLayer({
      id: "rd-radius-line",
      type: "line",
      source: "rd-radius",
      paint: { "line-color": "#f5b544", "line-opacity": 0.6, "line-width": 1.2, "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: "rd-routes-casing",
      type: "line",
      source: "rd-routes",
      filter: ["!=", ["get", "dashed"], true],
      layout: lineLayout,
      paint: { "line-color": ROUTE_COLOR.casing, "line-width": ["+", ["get", "width"], 4], "line-opacity": ["get", "opacity"] },
    });
    map.addLayer({
      id: "rd-routes-line",
      type: "line",
      source: "rd-routes",
      filter: ["!=", ["get", "dashed"], true],
      layout: lineLayout,
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] },
    });
    map.addLayer({
      id: "rd-routes-dashed",
      type: "line",
      source: "rd-routes",
      filter: ["==", ["get", "dashed"], true],
      layout: lineLayout,
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"], "line-dasharray": [1.2, 2] },
    });
    map.on("click", () => {
      callbacks.current.onSelectDriver?.(null);
    });
    const carsMap = cars.current;
    const stopsMap = stops.current;
    const endsMap = ends.current;
    return () => {
      carsMap.forEach((m) => cancelAnimationFrame(m.anim ?? 0));
      carsMap.clear();
      stopsMap.clear();
      endsMap.clear();
    };
  }, [ready, mapRef]);

  // ---------------------------------------------------------------- cadrage
  const fitPoints = useCallback((pts: Coord[]) => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !pts.length) return;
    const bounds = pts.reduce((b, p) => b.extend(p), new lib.LngLatBounds(pts[0]!, pts[0]!));
    map.fitBounds(bounds, { padding: paddingRef.current, maxZoom: 14.5, duration: 900 });
  }, [mapRef, libRef]);

  const fitAll = useCallback(() => {
    const pts: Coord[] = [...(dataRef.current.focus ?? [])];
    if (!pts.length) for (const d of dataRef.current.drivers) if (d.location && d.presence !== "offline") pts.push([d.location.lng, d.location.lat]);
    const soon = Date.now() + 2 * 3600_000;
    if (!dataRef.current.focus?.length)
      for (const r of dataRef.current.rides) if (!TERMINAL.has(r.status) && new Date(r.pickup_at).getTime() < soon) pts.push([r.pickup_lng, r.pickup_lat]);
    fitPoints(pts);
  }, [fitPoints]);

  useImperativeHandle(ref, () => ({
    flyTo: (lng, lat, zoom = 14) => mapRef.current?.flyTo({ center: [lng, lat], zoom, padding: paddingRef.current, speed: 1.4, essential: true }),
    fitAll,
    fitPoints,
  }), [fitAll, fitPoints, mapRef]);

  // ---------------------------------------------------------------- véhicules
  const offeredDrivers = useMemo(() => new Set(offers.filter((o) => o.status === "pending").map((o) => o.driver_id)), [offers]);

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const now = Date.now();
    const seen = new Set<string>();
    const selectedRide = selectedRideId ? rides.find((r) => r.id === selectedRideId) : null;
    for (const d of drivers) {
      if (!d.location) continue;
      if (d.presence === "offline" && !showOffline) continue;
      seen.add(d.id);
      const target: [number, number] = [d.location.lng, d.location.lat];
      let m = cars.current.get(d.id);
      if (!m) {
        const el = carElement();
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          callbacks.current.onSelectDriver?.(d.id);
        });
        const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat(target).addTo(map);
        m = { marker, el, pos: target };
        cars.current.set(d.id, m);
      } else if (m.pos[0] !== target[0] || m.pos[1] !== target[1]) {
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
      const stale = now - new Date(d.location.updated_at).getTime() > STALE_MS;
      const related = !selectedRide || selectedRide.driver_id === d.id || offers.some((o) => o.ride_id === selectedRide.id && o.driver_id === d.id);
      updateCar(m.el, {
        color: PRESENCE_COLOR[d.presence as DriverPresence] ?? PRESENCE_COLOR.offline,
        heading: d.location.heading,
        moving: (d.location.speed_mps ?? 0) > 0.8,
        initials: initials(d.first_name, d.last_name),
        label: `${d.first_name} · ${d.vehicle?.plate ?? "#" + d.number}`,
        selected: d.id === selectedDriverId,
        pulse: offeredDrivers.has(d.id),
        dim: stale || d.presence === "offline" || !related,
      });
      m.el.style.zIndex = d.id === selectedDriverId ? "6" : related && selectedRide ? "5" : "3";
    }
    for (const [id, m] of cars.current) {
      if (!seen.has(id)) {
        cancelAnimationFrame(m.anim ?? 0);
        m.marker.remove();
        cars.current.delete(id);
      }
    }
    if (!fitted.current && (drivers.length || rides.length)) {
      fitted.current = true;
      fitAll();
    }
  }, [drivers, ready, showOffline, selectedDriverId, selectedRideId, rides, offers, offeredDrivers, fitAll, mapRef, libRef]);

  // ---------------------------------------------------------------- courses & tracés
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const soon = Date.now() + 2 * 3600_000;
    const visible = rides.filter(
      (r) => r.id === selectedRideId || (!TERMINAL.has(r.status) && (new Date(r.pickup_at).getTime() < soon || !SEARCHING.has(r.status))),
    );
    const byId = new Map(drivers.map((d) => [d.id, d]));
    const seen = new Set<string>();
    const seenEnds = new Set<string>();
    const features: GeoJSON.Feature[] = [];

    for (const r of visible) {
      const selected = r.id === selectedRideId;
      const onboard = ON_BOARD.has(r.status);
      // Point de départ (masqué une fois le client à bord, sauf sélection)
      if (!onboard || selected) {
        seen.add(r.id);
        let p = stops.current.get(r.id);
        if (!p) {
          const el = stopElement("start");
          el.title = `#${r.number} · ${shortAddress(r.pickup_address)}`;
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            callbacks.current.onSelectRide?.(r.id);
          });
          const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat([r.pickup_lng, r.pickup_lat]).addTo(map);
          p = { marker, el };
          stops.current.set(r.id, p);
        }
        p.marker.setLngLat([r.pickup_lng, r.pickup_lat]);
        p.el.style.setProperty("--c", rideColor(r.status));
        p.el.dataset.searching = String(SEARCHING.has(r.status) && r.type === "instant");
        p.el.dataset.dim = String(!!selectedRideId && !selected);
        p.el.style.zIndex = selected ? "4" : "2";
      }
      // Arrivée : course sélectionnée ou client à bord
      if ((selected || onboard) && r.dropoff_lat != null && r.dropoff_lng != null) {
        seenEnds.add(r.id);
        let e = ends.current.get(r.id);
        if (!e) {
          e = new lib.Marker({ element: stopElement("end"), anchor: "center" }).setLngLat([r.dropoff_lng, r.dropoff_lat]).addTo(map);
          ends.current.set(r.id, e);
        }
        e.setLngLat([r.dropoff_lng, r.dropoff_lat]);
        e.getElement().dataset.dim = String(!!selectedRideId && !selected);
      }

      const d = r.driver_id ? byId.get(r.driver_id) : undefined;
      const trip = routeOf(r) ?? (r.dropoff_lat != null && r.dropoff_lng != null ? [[r.pickup_lng, r.pickup_lat], [r.dropoff_lng, r.dropoff_lat]] as Coord[] : null);
      if (trip && (selected || onboard)) {
        features.push({
          type: "Feature",
          properties: { color: onboard ? ROUTE_COLOR.onboard : ROUTE_COLOR.trip, width: selected ? 4 : 3, opacity: selected ? 1 : selectedRideId ? 0.25 : 0.7, dashed: !r.route_polyline },
          geometry: { type: "LineString", coordinates: trip },
        });
      }
      if (d?.location && TO_PICKUP.has(r.status) && r.status !== "DRIVER_ARRIVED") {
        const real = selected && approach?.rideId === r.id ? approach.coordinates : null;
        features.push({
          type: "Feature",
          properties: { color: ROUTE_COLOR.approach, width: selected ? 4 : 2, opacity: selected ? 1 : selectedRideId ? 0.2 : 0.55, dashed: !real },
          geometry: { type: "LineString", coordinates: real ?? [[d.location.lng, d.location.lat], [r.pickup_lng, r.pickup_lat]] },
        });
      }
      // Recherche en cours sur la course sélectionnée : rayon + chauffeurs sollicités
      if (selected && SEARCHING.has(r.status) && r.type === "instant") {
        for (const o of offers) {
          const od = o.ride_id === r.id && o.status === "pending" ? byId.get(o.driver_id) : undefined;
          if (od?.location)
            features.push({
              type: "Feature",
              properties: { color: "#f5b544", width: 1.5, opacity: 0.8, dashed: true },
              geometry: { type: "LineString", coordinates: [[od.location.lng, od.location.lat], [r.pickup_lng, r.pickup_lat]] },
            });
        }
      }
    }
    for (const [id, p] of stops.current) if (!seen.has(id)) (p.marker.remove(), stops.current.delete(id));
    for (const [id, e] of ends.current) if (!seenEnds.has(id)) (e.remove(), ends.current.delete(id));

    const sel = visible.find((r) => r.id === selectedRideId);
    setData(
      map,
      "rd-radius",
      sel && SEARCHING.has(sel.status) && sel.type === "instant" && sel.dispatch_radius_m
        ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePolygon({ lat: sel.pickup_lat, lng: sel.pickup_lng }, sel.dispatch_radius_m)] } }]
        : [],
    );
    setData(map, "rd-routes", features);
  }, [rides, offers, drivers, ready, selectedRideId, approach, mapRef, libRef]);

  // MapLibre force `position: relative` sur son conteneur : on l'enveloppe.
  return (
    <div data-labels={showLabels} className={cn("rd-map absolute inset-0 bg-ink-900", className)}>
      <div ref={containerRef} className="size-full" />
    </div>
  );
});
