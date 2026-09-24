"use client";
import { formatDuration, type Coord } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { PRESENCE_COLOR, ROUTE_COLOR } from "./map-theme";
import { carElement, stopElement, updateCar } from "./markers";
import { EMPTY, setData, useMapLibre } from "./use-maplibre";

type MLMarker = import("maplibre-gl").Marker;
type Point = { lat: number; lng: number };

export type PreviewDriver = { id: string; name: string; lat: number; lng: number; etaS?: number; heading?: number | null; color?: string };

/**
 * Carte d'aperçu d'un trajet : départ, arrivée, itinéraire réel, chauffeurs
 * (avec temps d'approche). Utilisée par « Nouvelle course » et le détail d'une course.
 */
export function RoutePreview({
  pickup,
  dropoff,
  route,
  approach,
  drivers = [],
  onPick,
  className,
  interactive = true,
  padding = 64,
}: {
  pickup?: Point | null;
  dropoff?: Point | null;
  route?: Coord[] | null;
  approach?: Coord[] | null;
  drivers?: PreviewDriver[];
  onPick?: (p: Point) => void;
  className?: string;
  interactive?: boolean;
  padding?: number | { top: number; bottom: number; left: number; right: number };
}) {
  const { containerRef, libRef, mapRef, ready } = useMapLibre({ interactive, zoom: 11, controls: false });
  const markers = useRef<{ start?: MLMarker; end?: MLMarker; cars: Map<string, MLMarker> }>({ cars: new Map() });
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.addSource("rp-route", { type: "geojson", data: EMPTY });
    const layout = { "line-cap": "round" as const, "line-join": "round" as const };
    map.addLayer({ id: "rp-casing", type: "line", source: "rp-route", layout, paint: { "line-color": ROUTE_COLOR.casing, "line-width": 9, "line-opacity": ["get", "opacity"] } });
    map.addLayer({
      id: "rp-line",
      type: "line",
      source: "rp-route",
      layout,
      filter: ["!=", ["get", "dashed"], true],
      paint: { "line-color": ["get", "color"], "line-width": 4.5, "line-opacity": ["get", "opacity"] },
    });
    map.addLayer({
      id: "rp-dashed",
      type: "line",
      source: "rp-route",
      layout,
      filter: ["==", ["get", "dashed"], true],
      paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": ["get", "opacity"], "line-dasharray": [1, 1.8] },
    });
    const onClick = (e: import("maplibre-gl").MapMouseEvent) => onPickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    map.on("click", onClick);
    const m = markers.current;
    return () => {
      map.off("click", onClick);
      m.start = undefined;
      m.end = undefined;
      m.cars.clear();
    };
  }, [ready, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const m = markers.current;
    const place = (key: "start" | "end", p: Point | null | undefined) => {
      if (!p) {
        m[key]?.remove();
        m[key] = undefined;
        return;
      }
      if (!m[key]) {
        const el = stopElement(key);
        el.style.setProperty("--c", "#c8f03c");
        m[key] = new lib.Marker({ element: el, anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map);
      } else m[key]!.setLngLat([p.lng, p.lat]);
    };
    place("start", pickup);
    place("end", dropoff);

    const seen = new Set<string>();
    for (const d of drivers) {
      seen.add(d.id);
      let mk = m.cars.get(d.id);
      if (!mk) {
        mk = new lib.Marker({ element: carElement(), anchor: "center" }).setLngLat([d.lng, d.lat]).addTo(map);
        m.cars.set(d.id, mk);
      }
      mk.setLngLat([d.lng, d.lat]);
      updateCar(mk.getElement(), {
        color: d.color ?? PRESENCE_COLOR.available,
        heading: d.heading ?? null,
        moving: d.heading != null,
        initials: d.name.split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase(),
        label: d.etaS != null ? `${d.name} · ${formatDuration(d.etaS)}` : d.name,
        selected: false,
        pulse: false,
        dim: false,
      });
      mk.getElement().querySelector<HTMLElement>(".rd-car__label")!.style.opacity = "1";
    }
    for (const [id, mk] of m.cars) if (!seen.has(id)) (mk.remove(), m.cars.delete(id));

    const features: GeoJSON.Feature[] = [];
    if (route?.length) features.push({ type: "Feature", properties: { color: ROUTE_COLOR.trip, opacity: 1 }, geometry: { type: "LineString", coordinates: route } });
    else if (pickup && dropoff)
      features.push({ type: "Feature", properties: { color: ROUTE_COLOR.trip, opacity: 0.6, dashed: true }, geometry: { type: "LineString", coordinates: [[pickup.lng, pickup.lat], [dropoff.lng, dropoff.lat]] } });
    if (approach?.length) features.push({ type: "Feature", properties: { color: ROUTE_COLOR.approach, opacity: 1 }, geometry: { type: "LineString", coordinates: approach } });
    setData(map, "rp-route", features);

    // Cadrage : trajet + chauffeurs proches
    const pts: Coord[] = [...(route ?? []), ...(approach ?? [])];
    if (pickup) pts.push([pickup.lng, pickup.lat]);
    if (dropoff) pts.push([dropoff.lng, dropoff.lat]);
    for (const d of drivers.slice(0, 3)) pts.push([d.lng, d.lat]);
    if (pts.length === 1) map.easeTo({ center: pts[0], zoom: 14, duration: 700 });
    else if (pts.length > 1) {
      const b = pts.reduce((acc, p) => acc.extend(p), new lib.LngLatBounds(pts[0]!, pts[0]!));
      map.fitBounds(b, { padding, maxZoom: 15, duration: 800 });
    }
  }, [ready, pickup, dropoff, route, approach, drivers, padding, mapRef, libRef]);

  return (
    <div className={cn("rd-map absolute inset-0 bg-ink-900", onPick && "[&_canvas]:cursor-crosshair", className)}>
      <div ref={containerRef} className="size-full" />
    </div>
  );
}
