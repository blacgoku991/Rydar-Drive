export type LatLng = { lat: number; lng: number };
export type Coord = [number, number];

export type RydarMapProps = {
  /** Position du chauffeur */
  me?: (LatLng & { heading?: number | null }) | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  /** Tracé de la course [lng, lat][] */
  route?: Coord[] | null;
  /** Hors ligne : carte assombrie */
  dim?: boolean;
  /** En ligne, en attente : onde radar autour du chauffeur */
  pulse?: boolean;
  /** Marges de cadrage (px) — laisser la place aux panneaux */
  padding?: { top: number; bottom: number; left: number; right: number };
  /** Zoom quand seul le chauffeur est affiché */
  zoom?: number;
};
