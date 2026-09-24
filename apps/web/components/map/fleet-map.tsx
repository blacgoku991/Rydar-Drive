"use client";
import { circlePolygon, shortAddress, type DriverPresence } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { LiveDriver, LiveOffer, LiveRide } from "@/lib/queries/live";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { DEFAULT_CENTER, PRESENCE_COLOR, rideColor } from "./map-theme";

type MapLib = typeof import("maplibre-gl");
type MLMap = import("maplibre-gl").Map;
type MLMarker = import("maplibre-gl").Marker;

export type FleetMapHandle = {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  fitAll: () => void;
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
};

const STALE_MS = 3 * 60_000;
const SEARCHING = new Set(["CREATED", "SEARCHING_DRIVER", "OFFERED"]);
const TO_PICKUP = new Set(["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]);
const ON_BOARD = new Set(["PASSENGER_ONBOARD", "IN_PROGRESS"]);

type DriverMarker = {
  marker: MLMarker;
  el: HTMLDivElement;
  cone: HTMLDivElement;
  label: HTMLDivElement;
  pos: [number, number];
  anim?: number;
};

function driverElement(): { el: HTMLDivElement; cone: HTMLDivElement; label: HTMLDivElement } {
  const el = document.createElement("div");
  el.className = "rd-driver";
  const halo = document.createElement("div");
  halo.className = "rd-driver__halo";
  const cone = document.createElement("div");
  cone.className = "rd-driver__cone";
  const dot = document.createElement("div");
  dot.className = "rd-driver__dot";
  const label = document.createElement("div");
  label.className = "rd-driver__label";
  el.append(halo, cone, dot, label);
  return { el, cone, label };
}

function pinElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "rd-pin";
  el.innerHTML = '<span class="rd-pin__ring"></span><span class="rd-pin__ring"></span><span class="rd-pin__ring"></span><span class="rd-pin__core"></span>';
  return el;
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

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
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const libRef = useRef<MapLib | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const driverMarkers = useRef(new Map<string, DriverMarker>());
  const pinMarkers = useRef(new Map<string, { marker: MLMarker; el: HTMLDivElement }>());
  const flagMarker = useRef<MLMarker | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onSelectDriver, onSelectRide });
  callbacks.current = { onSelectDriver, onSelectRide };
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const dataRef = useRef({ drivers, rides, focus });
  dataRef.current = { drivers, rides, focus };

  // ---------------------------------------------------------------- init
  useEffect(() => {
    let disposed = false;
    (async () => {
      const lib = await import("maplibre-gl");
      if (disposed || !containerRef.current) return;
      lib.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
      libRef.current = lib;
      const map = new lib.Map({
        container: containerRef.current,
        style: env.mapStyleUrl,
        center: DEFAULT_CENTER,
        zoom: initialZoom,
        attributionControl: { compact: true },
        interactive,
        fadeDuration: 0,
      });
      mapRef.current = map;
      if (interactive) map.addControl(new lib.NavigationControl({ showCompass: false }), "bottom-right");
      map.on("load", () => {
        map.addSource("rd-radius", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addSource("rd-links", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addSource("rd-beams", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "rd-radius-fill",
          type: "fill",
          source: "rd-radius",
          paint: { "fill-color": "#c8f03c", "fill-opacity": ["case", ["get", "selected"], 0.075, 0.035] },
        });
        map.addLayer({
          id: "rd-radius-line",
          type: "line",
          source: "rd-radius",
          paint: { "line-color": "#c8f03c", "line-opacity": ["case", ["get", "selected"], 0.7, 0.35], "line-width": 1.2, "line-dasharray": [3, 3] },
        });
        map.addLayer({
          id: "rd-route",
          type: "line",
          source: "rd-links",
          filter: ["==", ["get", "kind"], "route"],
          layout: { "line-cap": "round" },
          paint: { "line-color": "#ffffff", "line-opacity": 0.35, "line-width": 1.6, "line-dasharray": [1, 2.5] },
        });
        map.addLayer({
          id: "rd-links-glow",
          type: "line",
          source: "rd-links",
          filter: ["!=", ["get", "kind"], "route"],
          layout: { "line-cap": "round" },
          paint: { "line-color": ["get", "color"], "line-opacity": 0.18, "line-width": 7, "line-blur": 4 },
        });
        map.addLayer({
          id: "rd-links",
          type: "line",
          source: "rd-links",
          filter: ["!=", ["get", "kind"], "route"],
          layout: { "line-cap": "round" },
          paint: { "line-color": ["get", "color"], "line-opacity": 0.9, "line-width": 2 },
        });
        map.addLayer({
          id: "rd-beams",
          type: "line",
          source: "rd-beams",
          layout: { "line-cap": "round" },
          paint: { "line-color": "#ffb020", "line-opacity": 0.85, "line-width": 1.5, "line-dasharray": [0, 4, 3] },
        });
        setReady(true);
      });
      map.on("click", () => callbacks.current.onSelectDriver?.(null));
    })();
    return () => {
      disposed = true;
      driverMarkers.current.forEach((m) => cancelAnimationFrame(m.anim ?? 0));
      driverMarkers.current.clear();
      pinMarkers.current.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [initialZoom, interactive]);

  // ---------------------------------------------------------------- fit
  const fitAll = useCallback(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    const pts: [number, number][] = [...(dataRef.current.focus ?? [])];
    if (!pts.length) for (const d of dataRef.current.drivers) if (d.location && d.presence !== "offline") pts.push([d.location.lng, d.location.lat]);
    const soon = Date.now() + 2 * 3600_000;
    if (!dataRef.current.focus?.length) for (const r of dataRef.current.rides)
      if (!["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"].includes(r.status) && new Date(r.pickup_at).getTime() < soon) pts.push([r.pickup_lng, r.pickup_lat]);
    if (!pts.length) return;
    const bounds = pts.reduce((b, p) => b.extend(p), new lib.LngLatBounds(pts[0]!, pts[0]!));
    map.fitBounds(bounds, { padding: paddingRef.current, maxZoom: 13.5, duration: 900 });
  }, []);

  useImperativeHandle(ref, () => ({
    flyTo: (lng, lat, zoom = 14) =>
      mapRef.current?.flyTo({ center: [lng, lat], zoom, padding: paddingRef.current, speed: 1.4, essential: true }),
    fitAll,
  }), [fitAll]);

  // ---------------------------------------------------------------- chauffeurs
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const now = Date.now();
    const seen = new Set<string>();

    for (const d of drivers) {
      if (!d.location) continue;
      if (d.presence === "offline" && !showOffline) continue;
      seen.add(d.id);
      const target: [number, number] = [d.location.lng, d.location.lat];
      const color = PRESENCE_COLOR[d.presence as DriverPresence] ?? PRESENCE_COLOR.offline;
      const stale = now - new Date(d.location.updated_at).getTime() > STALE_MS;
      let m = driverMarkers.current.get(d.id);
      if (!m) {
        const { el, cone, label } = driverElement();
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          callbacks.current.onSelectDriver?.(d.id);
        });
        const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat(target).addTo(map);
        m = { marker, el, cone, label, pos: target };
        driverMarkers.current.set(d.id, m);
      } else if (m.pos[0] !== target[0] || m.pos[1] !== target[1]) {
        // interpolation douce vers la nouvelle position
        cancelAnimationFrame(m.anim ?? 0);
        const from = m.marker.getLngLat();
        const start = performance.now();
        const entry = m;
        const step = (t: number) => {
          const k = Math.min(1, (t - start) / 1400);
          const e = ease(k);
          entry.marker.setLngLat([from.lng + (target[0] - from.lng) * e, from.lat + (target[1] - from.lat) * e]);
          if (k < 1) entry.anim = requestAnimationFrame(step);
        };
        entry.anim = requestAnimationFrame(step);
        m.pos = target;
      }
      m.el.style.setProperty("--c", color);
      m.el.dataset.selected = String(d.id === selectedDriverId);
      m.el.dataset.pulse = String(d.presence === "available" || d.presence === "offered");
      m.el.style.opacity = stale || d.presence === "offline" ? "0.45" : "1";
      m.cone.style.display = d.location.heading == null || (d.location.speed_mps ?? 0) < 0.5 ? "none" : "block";
      m.cone.style.transform = `rotate(${d.location.heading ?? 0}deg)`;
      m.label.textContent = `${d.first_name} · ${d.vehicle?.plate ?? "#" + d.number}`;
    }
    for (const [id, m] of driverMarkers.current) {
      if (!seen.has(id)) {
        cancelAnimationFrame(m.anim ?? 0);
        m.marker.remove();
        driverMarkers.current.delete(id);
      }
    }
    if (!fitted.current && (drivers.length || rides.length)) {
      fitted.current = true;
      fitAll();
    }
  }, [drivers, ready, showOffline, selectedDriverId, rides.length, fitAll]);

  // ---------------------------------------------------------------- courses, rayons, faisceaux
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const soon = Date.now() + 2 * 3600_000;
    const visible = rides.filter(
      (r) =>
        r.id === selectedRideId ||
        (!["COMPLETED", "CANCELLED"].includes(r.status) && (new Date(r.pickup_at).getTime() < soon || !SEARCHING.has(r.status))),
    );
    const seen = new Set<string>();
    for (const r of visible) {
      seen.add(r.id);
      let p = pinMarkers.current.get(r.id);
      if (!p) {
        const el = pinElement();
        el.title = `#${r.number} · ${shortAddress(r.pickup_address)}`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          callbacks.current.onSelectRide?.(r.id);
        });
        const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat([r.pickup_lng, r.pickup_lat]).addTo(map);
        p = { marker, el };
        pinMarkers.current.set(r.id, p);
      }
      p.marker.setLngLat([r.pickup_lng, r.pickup_lat]);
      p.el.style.setProperty("--c", rideColor(r.status));
      p.el.dataset.searching = String(SEARCHING.has(r.status) && r.type === "instant");
      p.el.style.opacity = selectedRideId && r.id !== selectedRideId ? "0.55" : "1";
      p.el.style.zIndex = r.id === selectedRideId ? "4" : "1";
    }
    for (const [id, p] of pinMarkers.current) {
      if (!seen.has(id)) {
        p.marker.remove();
        pinMarkers.current.delete(id);
      }
    }

    const byId = new Map(drivers.map((d) => [d.id, d]));
    const radius = visible
      .filter((r) => SEARCHING.has(r.status) && r.dispatch_radius_m && r.type === "instant")
      .map((r) => ({
        type: "Feature" as const,
        properties: { selected: r.id === selectedRideId },
        geometry: { type: "Polygon" as const, coordinates: [circlePolygon({ lat: r.pickup_lat, lng: r.pickup_lng }, r.dispatch_radius_m!)] },
      }));
    const beams = offers
      .filter((o) => o.status === "pending")
      .flatMap((o) => {
        const r = visible.find((x) => x.id === o.ride_id);
        const d = byId.get(o.driver_id);
        if (!r || !d?.location || r.type !== "instant") return [];
        return [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[r.pickup_lng, r.pickup_lat], [d.location.lng, d.location.lat]] } }];
      });
    const links = visible.flatMap((r) => {
      const out: any[] = [];
      const d = r.driver_id ? byId.get(r.driver_id) : undefined;
      if (d?.location && TO_PICKUP.has(r.status) && (r.type === "instant" || r.status !== "ACCEPTED")) {
        out.push({ type: "Feature", properties: { kind: "link", color: rideColor(r.status) }, geometry: { type: "LineString", coordinates: [[d.location.lng, d.location.lat], [r.pickup_lng, r.pickup_lat]] } });
      }
      if (d?.location && ON_BOARD.has(r.status) && r.dropoff_lat != null && r.dropoff_lng != null) {
        out.push({ type: "Feature", properties: { kind: "link", color: rideColor(r.status) }, geometry: { type: "LineString", coordinates: [[d.location.lng, d.location.lat], [r.dropoff_lng, r.dropoff_lat]] } });
      }
      if (r.id === selectedRideId && r.dropoff_lat != null && r.dropoff_lng != null) {
        out.push({ type: "Feature", properties: { kind: "route", color: "#ffffff" }, geometry: { type: "LineString", coordinates: [[r.pickup_lng, r.pickup_lat], [r.dropoff_lng, r.dropoff_lat]] } });
      }
      return out;
    });
    (map.getSource("rd-radius") as import("maplibre-gl").GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: radius });
    (map.getSource("rd-beams") as import("maplibre-gl").GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: beams });
    (map.getSource("rd-links") as import("maplibre-gl").GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: links });

    // Drapeau d'arrivée pour la course sélectionnée
    const sel = rides.find((r) => r.id === selectedRideId);
    if (sel && sel.dropoff_lat != null && sel.dropoff_lng != null) {
      if (!flagMarker.current) {
        const el = document.createElement("div");
        el.className = "rd-flag";
        flagMarker.current = new lib.Marker({ element: el, anchor: "center" }).setLngLat([sel.dropoff_lng, sel.dropoff_lat]).addTo(map);
      } else flagMarker.current.setLngLat([sel.dropoff_lng, sel.dropoff_lat]);
    } else {
      flagMarker.current?.remove();
      flagMarker.current = null;
    }
  }, [rides, offers, drivers, ready, selectedRideId]);

  // Faisceaux animés (tirets qui « partent » de la prise en charge)
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !offers.some((o) => o.status === "pending")) return;
    const seq = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
    let i = 0;
    const id = window.setInterval(() => {
      i = (i + 1) % seq.length;
      if (map.getLayer("rd-beams")) map.setPaintProperty("rd-beams", "line-dasharray", seq[i]);
    }, 70);
    return () => window.clearInterval(id);
  }, [ready, offers]);

  // MapLibre force `position: relative` sur son conteneur : on l'enveloppe.
  return (
    <div data-labels={showLabels} className={cn("rd-map absolute inset-0 bg-ink-900", className)}>
      <div ref={containerRef} className="size-full" />
    </div>
  );
});
