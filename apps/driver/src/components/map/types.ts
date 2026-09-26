import type { FleetReportType } from "@rydar/shared";

export type LatLng = { lat: number; lng: number };
export type Coord = [number, number];

/** Signalement de la flotte affiché sur la carte (police, contrôle, accident…). */
export type MapReport = LatLng & { id: string; type: FleetReportType };

export type RydarMapProps = {
  /** Position du chauffeur (précision en mètres : cercle d'incertitude) */
  me?: (LatLng & { heading?: number | null; accuracy?: number | null }) | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  /** Tracé de la course [lng, lat][] */
  route?: Coord[] | null;
  /** Hors ligne : carte assombrie */
  dim?: boolean;
  /** Marges de cadrage (px) — laisser la place aux panneaux */
  padding?: { top: number; bottom: number; left: number; right: number };
  /** Zoom quand seul le chauffeur est affiché */
  zoom?: number;
  /** Signalements actifs de la flotte (optionnel) */
  reports?: MapReport[] | null;
  /** Signalement mis en avant (agrandi) */
  selectedReportId?: string | null;
  /** Appui sur un signalement */
  onReportPress?: (id: string) => void;
  /** Point à centrer en priorité (ex. signalement ouvert depuis une notification) */
  focus?: LatLng | null;
  /** Distance (px) entre le bas de la carte et le bouton « Recentrer » (au-dessus des panneaux) */
  controlsBottom?: number;
};
