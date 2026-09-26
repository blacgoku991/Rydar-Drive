// Style de carte du dashboard : style Rydar partagé (@rydar/shared) + variables d'environnement.
// Un style complet tiers peut être imposé via NEXT_PUBLIC_MAP_STYLE_URL (MapTiler, Mapbox…).
import { DEFAULT_MAP_GLYPHS, DEFAULT_MAP_TILES, rydarMapStyle } from "@rydar/shared";
import type { StyleSpecification } from "maplibre-gl";

export const MAP_TILES_URL = process.env.NEXT_PUBLIC_MAP_TILES_URL || DEFAULT_MAP_TILES;
export const MAP_GLYPHS_URL = process.env.NEXT_PUBLIC_MAP_GLYPHS_URL || DEFAULT_MAP_GLYPHS;
export const MAP_STYLE_OVERRIDE = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "";

/** Style effectif : URL imposée (fournisseur tiers) ou style Rydar. */
export function mapStyle(theme: "night" | "day" = "night"): string | StyleSpecification {
  return MAP_STYLE_OVERRIDE || (rydarMapStyle(theme, { tiles: MAP_TILES_URL, glyphs: MAP_GLYPHS_URL }) as unknown as StyleSpecification);
}
