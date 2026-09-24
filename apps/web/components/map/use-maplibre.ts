"use client";
import { useEffect, useRef, useState } from "react";
import { mapStyle } from "@/lib/map/style";
import { DEFAULT_CENTER } from "./map-theme";

export type MapLib = typeof import("maplibre-gl");
export type MLMap = import("maplibre-gl").Map;

/** Initialise une carte MapLibre (import dynamique, worker local, style Rydar). */
export function useMapLibre({
  interactive = true,
  center = DEFAULT_CENTER,
  zoom = 11.5,
  theme = "night",
  controls = true,
}: { interactive?: boolean; center?: [number, number]; zoom?: number; theme?: "night" | "day"; controls?: boolean } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const libRef = useRef<MapLib | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const lib = await import("maplibre-gl");
      if (disposed || !containerRef.current) return;
      lib.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
      libRef.current = lib;
      const map = new lib.Map({
        container: containerRef.current,
        style: mapStyle(theme),
        center,
        zoom,
        interactive,
        attributionControl: { compact: true },
        fadeDuration: 0,
        dragRotate: false,
        pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;
      if (interactive && controls) map.addControl(new lib.NavigationControl({ showCompass: false }), "bottom-right");
      map.on("load", () => !disposed && setReady(true));
    })();
    return () => {
      disposed = true;
      setReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, theme]);

  return { containerRef, libRef, mapRef, ready };
}

type GeoJSONSource = import("maplibre-gl").GeoJSONSource;
export function setData(map: MLMap | null, id: string, features: GeoJSON.Feature[]) {
  (map?.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
}

export const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
