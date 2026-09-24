// Carte web (aperçu navigateur de l'app chauffeur) : MapLibre + style Rydar partagé.
import { DEFAULT_MAP_GLYPHS, DEFAULT_MAP_TILES, rydarMapStyle } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme";
import { RadarPulse } from "../radar";
import type { RydarMapProps } from "./types";

type MLMap = import("maplibre-gl").Map;
type MLMarker = import("maplibre-gl").Marker;

const TILES = process.env.EXPO_PUBLIC_MAP_TILES_URL ?? DEFAULT_MAP_TILES;
const GLYPHS = process.env.EXPO_PUBLIC_MAP_GLYPHS_URL ?? DEFAULT_MAP_GLYPHS;

function dot(style: Partial<CSSStyleDeclaration>, inner?: HTMLElement) {
  const el = document.createElement("div");
  Object.assign(el.style, style);
  if (inner) el.appendChild(inner);
  return el;
}

export function RydarMap({ me, pickup, dropoff, route, dim, pulse, padding = { top: 80, bottom: 80, left: 50, right: 50 }, zoom = 15 }: RydarMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const markers = useRef<{ me?: MLMarker; pickup?: MLMarker; dropoff?: MLMarker }>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
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
      instance.on("load", () => {
        instance.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b0d10", "line-width": 10 } });
        instance.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": colors.brand, "line-width": 5 } });
        if (!disposed) setReady(true);
      });
    })();
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      markers.current = {};
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
    if (pts.length > 1) {
      const b = pts.reduce((acc, p) => acc.extend(p), new L.LngLatBounds(pts[0]!, pts[0]!));
      m.fitBounds(b, { padding, maxZoom: 15.5, duration: 700 });
    } else if (me) m.easeTo({ center: [me.lng, me.lat], zoom, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me?.lat, me?.lng, me?.heading, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng, route]);

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
