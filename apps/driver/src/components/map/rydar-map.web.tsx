// Carte web (aperçu navigateur de l'app chauffeur) : MapLibre + style Rydar partagé.
import { DEFAULT_MAP_GLYPHS, DEFAULT_MAP_TILES, FLEET_REPORT_META, rydarMapStyle } from "@rydar/shared";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme";
import { ME_SIZE, meLabel, meMarkerSvg, meMode, type MeMode } from "./me-marker-shape";
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

/** Pictogrammes des signalements (trait 2 px, couleur héritée), équivalents web des icônes Ionicons de l'app. */
const REPORT_GLYPHS: Record<string, string> = {
  police: '<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z"/>',
  control: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.7-1.3 1.8-2 3-2s2.3.7 3 2M14 10h4M14 14h3"/>',
  accident: '<path d="M5 11l1.6-4.1A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.4L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/><path d="M6 17v2M18 17v2M7 14h.01M17 14h.01"/>',
  traffic: '<path d="M10 4h4l4.5 15h-13L10 4zM7.7 11h8.6M6.5 15h11M3 19h18"/>',
  danger: '<path d="M12 4L2.5 20h19L12 4zM12 10v4M12 17h.01"/>',
  other: '<path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
};

function reportGlyph(type: string, color: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", color);
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // Chaînes constantes ci-dessus (aucune donnée externe)
  svg.innerHTML = REPORT_GLYPHS[type] ?? REPORT_GLYPHS.other!;
  return svg;
}

/** Pastille d'un signalement (ancrage en bas, pointe colorée) ; l'élément interne porte la mise à l'échelle. */
function reportElement(r: MapReport, onPress: (id: string) => void) {
  const meta = FLEET_REPORT_META[r.type] ?? FLEET_REPORT_META.other;
  const root = dot({ display: "flex", flexDirection: "column", alignItems: "center", cursor: "pointer", padding: "4px 4px 0" });
  const bubble = dot({
    width: "40px", height: "40px", borderRadius: "999px", background: colors.surface, border: `2px solid ${meta.color}`,
    boxShadow: "0 2px 6px rgba(0,0,0,.45)", display: "grid", placeItems: "center", transformOrigin: "50% 100%",
  });
  bubble.appendChild(reportGlyph(r.type, meta.color));
  bubble.dataset.role = "bubble";
  const tip = dot({ width: "0", height: "0", borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: `7px solid ${meta.color}`, marginTop: "-1px" });
  root.append(bubble, tip);
  root.setAttribute("role", "button");
  root.setAttribute("aria-label", `Signalement\u00A0: ${meta.label}`);
  root.addEventListener("click", (e) => {
    e.stopPropagation();
    onPress(r.id);
  });
  return root;
}

/** Cercle de précision du GPS (rayon en mètres), comme le cercle natif : polygone de 48 côtés. */
function accuracyCircle(me: RydarMapProps["me"]) {
  const r = me?.accuracy ?? null;
  if (!me || r == null || r <= 15) return { type: "FeatureCollection" as const, features: [] };
  const radius = Math.min(r, 500);
  const dLat = radius / 111_320;
  const dLng = radius / (111_320 * Math.cos((me.lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    ring.push([me.lng + dLng * Math.sin(a), me.lat + dLat * Math.cos(a)]);
  }
  return {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [ring] } }],
  };
}

/** Identifiant unique du dégradé du faisceau (plusieurs cartes peuvent coexister dans la pile d'écrans). */
let meGradientSeq = 0;

/** Guidage : zoom selon la vitesse (m/s) — tuiles MapLibre de 512 px : un cran de moins que la carte native. */
const navZoom = (speed: number | null) => ((speed ?? 0) < 8 ? 16 : (speed ?? 0) < 19 ? 15 : 14);

export function RydarMap({
  me, pickup, dropoff, route, routeMuted, navigation = false, dim, padding = { top: 80, bottom: 80, left: 50, right: 50 }, zoom = 15, reports,
  selectedReportId, onReportPress, focus,
}: RydarMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const markers = useRef<{ pickup?: MLMarker; dropoff?: MLMarker }>({});
  const meMarker = useRef<{ marker: MLMarker; el: HTMLElement; mode: MeMode | null; gradient: string } | null>(null);
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
        instance.addSource("route-muted", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({
          id: "route-muted", type: "line", source: "route-muted", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "rgba(158,165,177,0.45)", "line-width": 4, "line-dasharray": [0.5, 2.5] },
        });
        instance.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b0d10", "line-width": 10 } });
        instance.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": colors.brand, "line-width": 5 } });
        // Précision réelle du GPS : cercle accroché à la position (rien quand elle est précise)
        instance.addSource("me-accuracy", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        instance.addLayer({ id: "me-accuracy-fill", type: "fill", source: "me-accuracy", paint: { "fill-color": "rgba(106,166,255,0.10)" } });
        instance.addLayer({ id: "me-accuracy-line", type: "line", source: "me-accuracy", paint: { "line-color": "rgba(106,166,255,0.45)", "line-width": 1 } });
        if (!disposed) setReady(true);
      });
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      map.current?.remove();
      map.current = null;
      markers.current = {};
      meMarker.current = null;
      reportMarkers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    const L = lib.current;
    if (!ready || !m || !L) return;
    const place = (key: "pickup" | "dropoff", p: { lat: number; lng: number } | null | undefined, make: () => HTMLElement) => {
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

    const line = (coords: [number, number][] | null | undefined) => ({
      type: "FeatureCollection" as const,
      features: coords && coords.length > 1 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } }] : [],
    });
    (m.getSource("route") as import("maplibre-gl").GeoJSONSource | undefined)?.setData(line(route));
    (m.getSource("route-muted") as import("maplibre-gl").GeoJSONSource | undefined)?.setData(line(routeMuted));

    // Guidage : la carte suit le chauffeur dans son sens de marche, lui un peu sous le centre
    if (navigation && me && !focus) {
      m.easeTo({
        center: [me.lng, me.lat], bearing: me.heading ?? m.getBearing(), zoom: navZoom(me.speed ?? null),
        offset: [0, m.getContainer().clientHeight * 0.2], duration: 800,
      });
      return;
    }
    if (m.getBearing() !== 0) m.setBearing(0);
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
  }, [ready, me?.lat, me?.lng, me?.heading, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng, route, routeMuted, navigation, focus?.lat, focus?.lng]);

  // Position du chauffeur : même dessin que l'app (point + faisceau d'orientation, flèche en guidage), orienté par
  // rapport au nord (rotationAlignment « map » : il reste juste quand la carte tourne pendant le guidage)
  useEffect(() => {
    const m = map.current;
    const L = lib.current;
    if (!ready || !m || !L) return;
    (m.getSource("me-accuracy") as import("maplibre-gl").GeoJSONSource | undefined)?.setData(accuracyCircle(me));
    if (!me) {
      meMarker.current?.marker.remove();
      meMarker.current = null;
      return;
    }
    let entry = meMarker.current;
    if (!entry) {
      const el = dot({ width: `${ME_SIZE}px`, height: `${ME_SIZE}px`, pointerEvents: "none", zIndex: "4" });
      el.setAttribute("role", "img");
      const marker = new L.Marker({ element: el, anchor: "center", rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([me.lng, me.lat]).addTo(m);
      entry = meMarker.current = { marker, el, mode: null, gradient: `rydar-me-beam-${++meGradientSeq}` };
    } else entry.marker.setLngLat([me.lng, me.lat]);
    const heading = me.heading ?? null;
    const mode = meMode(heading, navigation);
    if (entry.mode !== mode) {
      // Chaîne constante (me-marker-shape), aucune donnée externe
      entry.el.innerHTML = meMarkerSvg(mode, entry.gradient);
      entry.mode = mode;
    }
    // Guidage sans cap connu : flèche dans l'axe de la carte (elle-même tournée selon le dernier cap)
    entry.marker.setRotation(heading ?? (mode === "nav" ? m.getBearing() : 0));
    entry.el.setAttribute("aria-label", meLabel(heading));
  }, [ready, me?.lat, me?.lng, me?.heading, me?.accuracy, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (bubble) {
        bubble.style.transform = r.id === selectedReportId ? "scale(1.18)" : "scale(1)";
        bubble.style.background = r.id === selectedReportId ? colors.surface3 : colors.surface;
      }
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
      {dim && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(6,7,9,0.55)" }]} />}
    </View>
  );
}
