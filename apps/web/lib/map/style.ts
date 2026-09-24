// Style de carte « Rydar Night » — MapLibre, schéma OpenMapTiles.
// Production : tuiles OpenFreeMap (gratuites, sans clé). Dev : tuiles réelles
// générées localement (scripts/dev-geo). Un style complet tiers peut aussi être
// imposé via NEXT_PUBLIC_MAP_STYLE_URL (MapTiler, Mapbox…).
import type { StyleSpecification } from "maplibre-gl";

export const MAP_TILES_URL = process.env.NEXT_PUBLIC_MAP_TILES_URL ?? "https://tiles.openfreemap.org/planet";
export const MAP_GLYPHS_URL = process.env.NEXT_PUBLIC_MAP_GLYPHS_URL ?? "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const MAP_STYLE_OVERRIDE = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "";

const FONT = ["Noto Sans Regular"];
const FONT_ITALIC = ["Noto Sans Italic"];

type Palette = {
  bg: string;
  land: string;
  park: string;
  wood: string;
  water: string;
  waterway: string;
  building: string;
  buildingLine: string;
  minor: string;
  secondary: string;
  primary: string;
  motorway: string;
  rail: string;
  runway: string;
  label: string;
  labelStrong: string;
  labelMuted: string;
  labelWater: string;
  halo: string;
};

export const NIGHT: Palette = {
  bg: "#0b0d10",
  land: "#0d1013",
  park: "#0f1813",
  wood: "#0f1712",
  water: "#0a1520",
  waterway: "#0c1a28",
  building: "#12161b",
  buildingLine: "#161b21",
  minor: "#1a1f26",
  secondary: "#212730",
  primary: "#2a313b",
  motorway: "#353d48",
  rail: "#1c2129",
  runway: "#1d232b",
  label: "#8b929d",
  labelStrong: "#c3c8cf",
  labelMuted: "#5d6470",
  labelWater: "#3f5a73",
  halo: "#0b0d10",
};

export const DAY: Palette = {
  bg: "#f3f3f1",
  land: "#efefec",
  park: "#e3ecdc",
  wood: "#dde8d6",
  water: "#cfdde8",
  waterway: "#c3d5e3",
  building: "#e4e3df",
  buildingLine: "#d9d8d3",
  minor: "#ffffff",
  secondary: "#ffffff",
  primary: "#fdfcf8",
  motorway: "#f6e7b9",
  rail: "#d2d2cf",
  runway: "#dcdcd8",
  label: "#6a6f78",
  labelStrong: "#2d3138",
  labelMuted: "#9a9ea6",
  labelWater: "#6f8ca5",
  halo: "#f7f7f5",
};

const name: any = ["coalesce", ["get", "name:fr"], ["get", "name:latin"], ["get", "name"]];

/** Largeur de route (px) interpolée par zoom. */
const width = (base: number, z12: number, z16: number): any => ["interpolate", ["exponential", 1.6], ["zoom"], 8, base, 12, z12, 16, z16, 19, z16 * 3];

export function rydarMapStyle(theme: "night" | "day" = "night", opts: { tiles?: string; glyphs?: string } = {}): StyleSpecification {
  const c = theme === "night" ? NIGHT : DAY;
  const tiles = opts.tiles ?? MAP_TILES_URL;
  const roadLine = (id: string, classes: string[], color: string, w: any, minzoom = 0, extra: Record<string, unknown> = {}) => ({
    id,
    type: "line" as const,
    source: "omt",
    "source-layer": "transportation",
    minzoom,
    filter: ["all", ["match", ["get", "class"], classes, true, false], ["!=", ["get", "brunnel"], "tunnel"]] as any,
    layout: { "line-cap": "round" as const, "line-join": "round" as const },
    paint: { "line-color": color, "line-width": w, ...extra },
  });

  return {
    version: 8,
    name: `Rydar ${theme === "night" ? "Night" : "Day"}`,
    glyphs: opts.glyphs ?? MAP_GLYPHS_URL,
    sources: {
      omt: { type: "vector", url: tiles, attribution: "© OpenStreetMap · Overture Maps · OpenFreeMap" },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": c.bg } },
      {
        id: "landuse",
        type: "fill",
        source: "omt",
        "source-layer": "landuse",
        filter: ["match", ["get", "class"], ["residential", "suburb", "quarter", "neighbourhood"], true, false],
        paint: { "fill-color": c.land, "fill-opacity": 0.7 },
      },
      {
        id: "landcover-wood",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["wood", "forest", "grass", "wetland", "farmland", "scrub"], true, false],
        paint: { "fill-color": c.wood, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 12, 0.9] },
      },
      {
        id: "park",
        type: "fill",
        source: "omt",
        "source-layer": "park",
        paint: { "fill-color": c.park, "fill-opacity": 0.9 },
      },
      {
        id: "landuse-park",
        type: "fill",
        source: "omt",
        "source-layer": "landuse",
        filter: ["match", ["get", "class"], ["cemetery", "pitch", "stadium", "park", "grass", "recreation_ground", "golf_course"], true, false],
        paint: { "fill-color": c.park, "fill-opacity": 0.75 },
      },
      {
        id: "water",
        type: "fill",
        source: "omt",
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": c.water },
      },
      {
        id: "waterway",
        type: "line",
        source: "omt",
        "source-layer": "waterway",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: {
          "line-color": c.waterway,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, ["match", ["get", "class"], ["river", "canal"], 1, 0.3], 16, ["match", ["get", "class"], ["river", "canal"], 8, 2]],
        },
      },
      {
        id: "aeroway-area",
        type: "fill",
        source: "omt",
        "source-layer": "aeroway",
        minzoom: 10,
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: { "fill-color": c.runway, "fill-opacity": ["match", ["get", "class"], ["runway", "taxiway", "apron"], 0.9, 0.35] },
      },
      {
        id: "aeroway-line",
        type: "line",
        source: "omt",
        "source-layer": "aeroway",
        minzoom: 10,
        filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
        paint: { "line-color": c.runway, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, ["match", ["get", "class"], "runway", 2, 0.5], 16, ["match", ["get", "class"], "runway", 40, 10]] },
      },
      {
        id: "building",
        type: "fill",
        source: "omt",
        "source-layer": "building",
        minzoom: 14,
        paint: {
          "fill-color": c.building,
          "fill-outline-color": c.buildingLine,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1],
        },
      },
      // Tunnels discrets
      {
        id: "road-tunnel",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 12,
        filter: ["all", ["==", ["get", "brunnel"], "tunnel"], ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"], true, false]],
        paint: { "line-color": c.minor, "line-width": width(0.3, 1, 5), "line-dasharray": [1, 1.5], "line-opacity": 0.6 },
      },
      {
        id: "rail",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 11,
        filter: ["all", ["match", ["get", "class"], ["rail", "transit"], true, false], ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "line-color": c.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 16, 1.6], "line-dasharray": [3, 2] },
      },
      roadLine("road-service", ["service", "track"], c.minor, width(0, 0.3, 3), 14),
      roadLine("road-minor", ["minor", "unclassified", "residential", "living_street"], c.minor, width(0.1, 0.8, 7), 12),
      roadLine("road-tertiary", ["tertiary"], c.secondary, width(0.2, 1.2, 9), 10),
      roadLine("road-secondary", ["secondary"], c.secondary, width(0.3, 1.6, 10), 9),
      roadLine("road-primary", ["primary"], c.primary, width(0.4, 2, 12), 7),
      roadLine("road-trunk", ["trunk"], c.primary, width(0.6, 2.4, 13), 5),
      roadLine("road-motorway", ["motorway"], c.motorway, width(0.7, 2.6, 14), 5),
      {
        id: "road-label",
        type: "symbol",
        source: "omt",
        "source-layer": "transportation_name",
        minzoom: 13,
        filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"], true, false],
        layout: {
          "symbol-placement": "line",
          "text-field": name,
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13],
          "text-max-angle": 30,
          "symbol-spacing": 350,
        },
        paint: { "text-color": c.labelMuted, "text-halo-color": c.halo, "text-halo-width": 1.2 },
      },
      {
        id: "water-label",
        type: "symbol",
        source: "omt",
        "source-layer": "waterway",
        minzoom: 12,
        filter: ["==", ["get", "class"], "river"],
        layout: { "symbol-placement": "line", "text-field": name, "text-font": FONT_ITALIC, "text-size": 12, "text-letter-spacing": 0.15 },
        paint: { "text-color": c.labelWater, "text-halo-color": c.halo, "text-halo-width": 1 },
      },
      {
        id: "airport-label",
        type: "symbol",
        source: "omt",
        "source-layer": "aerodrome_label",
        minzoom: 9,
        layout: { "text-field": name, "text-font": FONT, "text-size": 12, "text-max-width": 8 },
        paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.2 },
      },
      {
        id: "place-quarter",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 12,
        filter: ["match", ["get", "class"], ["suburb", "quarter", "neighbourhood"], true, false],
        layout: {
          "text-field": name,
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 13],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.12,
          "text-max-width": 8,
        },
        paint: { "text-color": c.labelMuted, "text-halo-color": c.halo, "text-halo-width": 1.2 },
      },
      {
        id: "place-town",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 9,
        filter: ["match", ["get", "class"], ["town", "village"], true, false],
        layout: { "text-field": name, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 14], "text-max-width": 8 },
        paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.4 },
      },
      {
        id: "place-city",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        filter: ["==", ["get", "class"], "city"],
        maxzoom: 14,
        layout: { "text-field": name, "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 5, 12, 12, 17], "text-max-width": 8 },
        paint: { "text-color": c.labelStrong, "text-halo-color": c.halo, "text-halo-width": 1.6 },
      },
    ],
  } as StyleSpecification;
}

/** Style effectif : URL imposée (fournisseur tiers) ou style Rydar. */
export function mapStyle(theme: "night" | "day" = "night"): string | StyleSpecification {
  return MAP_STYLE_OVERRIDE || rydarMapStyle(theme);
}
