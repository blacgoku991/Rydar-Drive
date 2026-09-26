// Carte web (aperçu navigateur de l'app chauffeur) : MapLibre + style Rydar partagé.
import { DEFAULT_MAP_GLYPHS, DEFAULT_MAP_TILES, FLEET_REPORT_META, rydarMapStyle } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme";
import { RadarPulse } from "../radar";
import type { MapReport, RydarMapProps } from "./types";

type MLMap = import("maplibre-gl").Map;
type MLMarker = import("maplibre-gl").Marker;

const TILES = process.env.EXPO_PUBLIC_MAP_TILES_URL || DEFAULT_MAP_TILES;
const GLYPHS = process.env.EXPO_PUBLIC_MAP_GLYPHS_URL || DEFAULT_MAP_GLYPHS;

function dot(style: Partial<CSSStyleDeclaration>, inner?: HTMLElement) {
  const el = document.createElement("div");
  Object.assign(el.style, style);
  if (inner) el.appendChild(inner);
  return el;
}

/** Pastille emoji d'un signalement (ancrage en bas, pointe colorée) ; l'élément interne porte la mise à l'échelle. */
function reportElement(r: MapReport, onPress: (id: string) => void) {
  const meta = FLEET_REPORT_META[r.type] ?? FLEET_REPORT_META.other;
  const root = dot({ display: "flex", flexDirection: "column", alignItems: "center", cursor: "pointer", padding: "4px 4px 0" });
  const bubble = dot({
    width: "40px", height: "40px", borderRadius: "999px", background: colors.surface, border: `2.5px solid ${meta.color}`,
    boxShadow: `0 0 0 4px ${meta.color}2E, 0 8px 18px rgba(0,0,0,.6)`, display: "grid", placeItems: "center",
    fontSize: "20px", lineHeight: "1", transition: "transform 160ms ease", transformOrigin: "50% 100%",
  });
  bubble.textContent = meta.emoji;
  bubble.dataset.role = "bubble";
  const tip = dot({ width: "0", height: "0", borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: `7px solid ${meta.color}`, marginTop: "-1px" });
  root.append(bubble, tip);
  root.setAttribute("role", "button");
  root.setAttribute("aria-label", `Signalement : ${meta.label}`);
  root.addEventListener("click", (e) => {
    e.stopPropagation();
    onPress(r.id);
  });
  return root;
}

export function RydarMap({
  me, pickup, dropoff, route, dim, pulse, padding = { top: 80, bottom: 80, left: 50, right: 50 }, zoom = 15, reports, selectedReportId, onReportPress, focus,
}: RydarMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const markers = useRef<{ me?: MLMarker; pickup?: MLMarker; dropoff?: MLMarker }>({});
  const reportMarkers = useRef(new Map<string, { marker: MLMarker; el: HTMLElement; type: string }>());
  const onReportRef = useRef(onReportPress);
  onReportRef.current = onReportPress;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const m = await import("maplibre-gl");
      if (disposed || !container.current) return;
      m.setWorkerUrl("/maplibre-gl-worker.mjs");
      lib.current = m;
      const instance = new m.Map({
        container: container.current,
        style: rydarMapStyle("night", { tiles: TILES, glyphs: GLYPHS }) as never,
        center: me ? [me.lng, me.lat] : [2.3488, 48.8634],
        zoom: me ? zoom : 12,
        attributionControl: false,
        dragRotate: false,
        fadeDuration: 0,
      });
      map.current = instance;
      ro = new ResizeObserver(() => instance.resize());
      ro.observe(container.current);
      instance.on("load", () => {
        instance.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b0d10", "line-width": 10 } });
        instance.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": colors.brand, "line-width": 5 } });
        if (!disposed) setReady(true);
      });
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      map.current?.remove();
      map.current = null;
      markers.current = {};
      reportMarkers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    const L = lib.current;
    if (!ready || !m || !L) return;
    const place = (key: "me" | "pickup" | "dropoff", p: { lat: number; lng: number } | null | undefined, make: () => HTMLElement) => {
      if (!p) {
        markers.current[key]?.remove();
        markers.current[key] = undefined;
        return;
      }
      if (!markers.current[key]) markers.current[key] = new L.Marker({ element: make(), anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(m);
      else markers.current[key]!.setLngLat([p.lng, p.lat]);
    };
    place("pickup", pickup, () => dot({ width: "20px", height: "20px", borderRadius: "999px", background: colors.brand, border: "5px solid #0b0d10", boxShadow: "0 0 0 2px " + colors.brand }));
    place("dropoff", dropoff, () => dot({ width: "16px", height: "16px", borderRadius: "4px", background: colors.fg, border: "4px solid #0b0d10", boxShadow: "0 0 0 2px " + colors.fg }));
    place("me", me, () =>
      dot(
        { width: "30px", height: "30px", borderRadius: "999px", background: colors.blue, border: "4px solid #0b0d10", boxShadow: "0 0 0 2px rgba(106,166,255,0.5), 0 6px 16px rgba(0,0,0,.6)", display: "grid", placeItems: "center" },
        dot({ width: "0", height: "0", borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderBottom: "8px solid #fff", marginTop: "-2px" }),
      ),
    );
    if (me && markers.current.me) markers.current.me.setRotation(me.heading ?? 0);

    (m.getSource("route") as import("maplibre-gl").GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: route && route.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } }] : [],
    });

    const pts: [number, number][] = [...(route ?? [])];
    if (pickup) pts.push([pickup.lng, pickup.lat]);
    if (dropoff) pts.push([dropoff.lng, dropoff.lat]);
    if (me && (pickup || dropoff)) pts.push([me.lng, me.lat]);
    if (focus) m.easeTo({ center: [focus.lng, focus.lat], zoom, duration: 600 });
    else if (pts.length > 1) {
      const b = pts.reduce((acc, p) => acc.extend(p), new L.LngLatBounds(pts[0]!, pts[0]!));
      m.fitBounds(b, { padding, maxZoom: 15.5, duration: 700 });
    } else if (me) m.easeTo({ center: [me.lng, me.lat], zoom, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me?.lat, me?.lng, me?.heading, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng, route, focus?.lat, focus?.lng]);

  // Signalements de la flotte : un marqueur par id (ajout, déplacement, retrait à l'expiration)
  useEffect(() => {
    const m = map.current;
    const L = lib.current;
    if (!ready || !m || !L) return;
    const current = reportMarkers.current;
    const keep = new Set<string>();
    for (const r of reports ?? []) {
      keep.add(r.id);
      let entry = current.get(r.id);
      if (entry && entry.type !== r.type) {
        entry.marker.remove();
        entry = undefined;
      }
      if (!entry) {
        const el = reportElement(r, (id) => onReportRef.current?.(id));
        entry = { marker: new L.Marker({ element: el, anchor: "bottom" }).setLngLat([r.lng, r.lat]).addTo(m), el, type: r.type };
        current.set(r.id, entry);
      } else entry.marker.setLngLat([r.lng, r.lat]);
      const bubble = entry.el.querySelector<HTMLElement>('[data-role="bubble"]');
      if (bubble) bubble.style.transform = r.id === selectedReportId ? "scale(1.18)" : "scale(1)";
      entry.el.style.zIndex = r.id === selectedReportId ? "3" : "2";
    }
    for (const [id, entry] of current) {
      if (!keep.has(id)) {
        entry.marker.remove();
        current.delete(id);
      }
    }
  }, [ready, reports, selectedReportId]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <div ref={container} style={{ position: "absolute", inset: 0, background: "#0b0d10" }} />
      {pulse && me && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <RadarPulse size={260} />
        </View>
      )}
      {dim && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(6,7,9,0.55)" }]} />}
    </View>
  );
}
