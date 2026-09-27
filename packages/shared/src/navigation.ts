// Guidage dans l'app chauffeur : étapes d'itinéraire (manœuvres) et instructions en français.
// Les étapes viennent du serveur (OSRM, Mapbox ou Google) ; l'app affiche la prochaine manœuvre.

export type NavManeuver = {
  /** Type OSRM : depart, arrive, turn, continue, new name, merge, on ramp, off ramp, fork, end of road, roundabout, rotary… */
  type: string;
  /** left, right, slight left, slight right, sharp left, sharp right, straight, uturn */
  modifier?: string | null;
  /** Numéro de sortie d'un rond-point */
  exit?: number | null;
};

export type NavStep = NavManeuver & {
  lat: number;
  lng: number;
  /** Nom de la voie empruntée après la manœuvre */
  name: string;
  instruction: string;
};

const DIRECTION: Record<string, string> = {
  left: "à gauche",
  right: "à droite",
  "slight left": "légèrement à gauche",
  "slight right": "légèrement à droite",
  "sharp left": "franchement à gauche",
  "sharp right": "franchement à droite",
  straight: "tout droit",
  uturn: "demi-tour",
};

/** 1 → « 1re », 2 → « 2e » */
export function ordinalFr(n: number) {
  return n === 1 ? "1re" : `${n}e`;
}

/** Instruction lisible au volant : « Tournez à droite sur Rue de Berri », « Au rond-point, prenez la 2e sortie ». */
export function navInstruction(m: NavManeuver, name?: string | null): string {
  const on = name ? ` sur ${name}` : "";
  const dir = m.modifier ? DIRECTION[m.modifier] : undefined;
  switch (m.type) {
    case "depart":
      return name ? `Partez sur ${name}` : "Partez";
    case "arrive":
      return "Vous êtes arrivé";
    case "roundabout":
    case "rotary":
      return m.exit ? `Au rond-point, prenez la ${ordinalFr(m.exit)} sortie${on}` : `Au rond-point, continuez${on}`;
    case "exit roundabout":
    case "exit rotary":
      return `Sortez du rond-point${on}`;
    case "merge":
      return `Insérez-vous${on}`;
    case "on ramp":
      return `Prenez la bretelle${dir && m.modifier !== "straight" ? ` ${dir}` : ""}${on}`;
    case "off ramp":
      return `Prenez la sortie${dir && m.modifier !== "straight" ? ` ${dir}` : ""}${on}`;
    case "fork":
      return `À l'embranchement, restez ${m.modifier?.includes("left") ? "à gauche" : m.modifier?.includes("right") ? "à droite" : "dans l'axe"}${on}`;
    case "end of road":
      return `Au bout de la route, tournez ${m.modifier?.includes("left") ? "à gauche" : "à droite"}${on}`;
    case "continue":
    case "new name":
      if (!m.modifier || m.modifier === "straight") return `Continuez${on}`;
      return m.modifier === "uturn" ? `Faites demi-tour${on}` : `Continuez ${dir}${on}`;
    default:
      if (m.modifier === "uturn") return `Faites demi-tour${on}`;
      if (!m.modifier || m.modifier === "straight") return `Continuez tout droit${on}`;
      return `Tournez ${dir}${on}`;
  }
}

/** Distance annoncée avant une manœuvre : « 800 m », « 50 m », « 1,2 km » (arrondis de conduite). */
export function navDistance(m: number) {
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toString().replace(".", ",")} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

// -----------------------------------------------------------------------------
// Suivi sur l'itinéraire : où est le chauffeur sur le tracé, quelle est la prochaine manœuvre
// -----------------------------------------------------------------------------

type Pt = { lat: number; lng: number };
type Coord = [number, number];

const EARTH_R = 6_371_000;
const RAD = Math.PI / 180;

/** Itinéraire préparé une fois (distances cumulées, position des manœuvres sur le tracé). */
export type NavTrack = {
  coords: Coord[];
  /** Distance (m) depuis le départ jusqu'à chaque point du tracé */
  cum: number[];
  total: number;
  steps: (NavStep & { along: number })[];
};

/** Projection locale (m) autour d'une latitude : suffisante à l'échelle d'une rue. */
function local(lat0: number) {
  const kx = EARTH_R * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_R * RAD;
  return (lng: number, lat: number) => [lng * kx, lat * ky] as const;
}

/** Point le plus proche sur le segment i du tracé : distance au tracé et position (m depuis le départ). */
function onSegment(t: NavTrack, i: number, p: Pt, xy: ReturnType<typeof local>) {
  const a = t.coords[i]!;
  const b = t.coords[i + 1]!;
  const [ax, ay] = xy(a[0], a[1]);
  const [bx, by] = xy(b[0], b[1]);
  const [px, py] = xy(p.lng, p.lat);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const k = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const qx = ax + k * dx;
  const qy = ay + k * dy;
  return { dist: Math.hypot(px - qx, py - qy), along: t.cum[i]! + k * (t.cum[i + 1]! - t.cum[i]!), k };
}

export type TrackPosition = {
  /** Segment du tracé où se trouve le chauffeur */
  index: number;
  /** Fraction parcourue du segment (0–1) */
  k: number;
  /** Distance parcourue depuis le départ du tracé (m) */
  along: number;
  /** Écart au tracé (m) : au-delà de quelques dizaines de mètres, le chauffeur a quitté l'itinéraire */
  off: number;
};

/**
 * Position du chauffeur sur le tracé. Recherche d'abord autour de la dernière position connue (`hint`),
 * pour ne pas « sauter » sur une autre portion d'un itinéraire qui repasse par la même rue.
 */
export function locateOnTrack(t: NavTrack, p: Pt, hint = 0): TrackPosition | null {
  const n = t.coords.length - 1;
  if (n < 1) return null;
  const xy = local(p.lat);
  const scan = (from: number, to: number) => {
    let best: TrackPosition | null = null;
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const s = onSegment(t, i, p, xy);
      if (!best || s.dist < best.off) best = { index: i, k: s.k, along: s.along, off: s.dist };
    }
    return best;
  };
  // Vers l'avant d'abord (le segment courant compris : un recul du GPS reste sur ce segment)
  const near = scan(hint, hint + 120);
  if (near && near.off <= 40) return near;
  const all = scan(0, n);
  return near && all && near.off <= all.off ? near : all;
}

/** Prépare un itinéraire : distances cumulées et position de chaque manœuvre le long du tracé. */
export function buildNavTrack(coords: Coord[], steps: NavStep[]): NavTrack {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const xy = local((a[1] + b[1]) / 2);
    const [ax, ay] = xy(a[0], a[1]);
    const [bx, by] = xy(b[0], b[1]);
    cum.push(cum[i - 1]! + Math.hypot(bx - ax, by - ay));
  }
  const total = cum[cum.length - 1] ?? 0;
  const track: NavTrack = { coords, cum, total, steps: [] };
  let hint = 0;
  for (const s of steps) {
    if (s.type === "arrive") {
      track.steps.push({ ...s, along: total });
      continue;
    }
    const pos = locateOnTrack(track, s, hint);
    const along = pos ? pos.along : 0;
    if (pos) hint = pos.index;
    track.steps.push({ ...s, along });
  }
  if (!track.steps.some((s) => s.type === "arrive") && coords.length > 1) {
    const end = coords[coords.length - 1]!;
    track.steps.push({ type: "arrive", modifier: null, exit: null, lng: end[0], lat: end[1], name: "", instruction: navInstruction({ type: "arrive" }), along: total });
  }
  return track;
}

/** Prochaine manœuvre (le départ est ignoré) et distance restante jusqu'à elle. */
export function nextManeuver(t: NavTrack, along: number): { step: NavTrack["steps"][number]; index: number; distance: number } | null {
  for (let i = 0; i < t.steps.length; i++) {
    const s = t.steps[i]!;
    if (s.type === "depart") continue;
    // Manœuvre franchie dès qu'on la dépasse de quelques mètres (précision GPS)
    if (s.along > along + 8 || s.type === "arrive") return { step: s, index: i, distance: Math.max(0, s.along - along) };
  }
  return null;
}

/** Portion du tracé qui reste à parcourir, à partir de la position projetée du chauffeur. */
export function remainingTrack(t: NavTrack, pos: TrackPosition): Coord[] {
  const a = t.coords[pos.index]!;
  const b = t.coords[pos.index + 1] ?? a;
  const start: Coord = [a[0] + (b[0] - a[0]) * pos.k, a[1] + (b[1] - a[1]) * pos.k];
  return [start, ...t.coords.slice(pos.index + 1)];
}

/**
 * Position affichée « collée » au tracé (comme Waze / Google Maps) : point projeté sur la route et cap du
 * tronçon parcouru (plus stable que le cap GPS). À n'utiliser que tant que le chauffeur est sur l'itinéraire.
 */
export function snapToTrack(t: NavTrack, pos: TrackPosition): { lat: number; lng: number; heading: number | null } {
  const a = t.coords[pos.index]!;
  const b = t.coords[pos.index + 1] ?? a;
  const lng = a[0] + (b[0] - a[0]) * pos.k;
  const lat = a[1] + (b[1] - a[1]) * pos.k;
  if (a[0] === b[0] && a[1] === b[1]) return { lat, lng, heading: null };
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return { lat, lng, heading: ((Math.atan2(y, x) / RAD) + 360) % 360 };
}

/** Écart maximal (m) pour poser la position affichée sur le tracé : 20 m, 12 m si le point GPS est précis. */
export const NAV_SNAP_MAX_M = 20;
export const NAV_SNAP_MIN_M = 12;

/**
 * Position à AFFICHER en guidage. Posée sur l'itinéraire seulement si le chauffeur y est vraiment : écart de
 * 12 à 20 m au plus selon la précision du point, et en roulant, cap dans le sens du tronçon (±60°). Sinon null :
 * la vraie position GPS est affichée (comme Waze), jamais la rue voisine par où passe l'itinéraire.
 */
export function snapForDisplay(
  t: NavTrack,
  pos: TrackPosition,
  me: { accuracy: number | null; heading: number | null; speed: number | null },
): { lat: number; lng: number; heading: number | null } | null {
  const limit = Math.min(NAV_SNAP_MAX_M, Math.max(NAV_SNAP_MIN_M, me.accuracy ?? NAV_SNAP_MAX_M));
  if (pos.off > limit) return null;
  const snap = snapToTrack(t, pos);
  if (snap.heading != null && me.heading != null && (me.speed ?? 0) >= 3) {
    const delta = Math.abs(((me.heading - snap.heading + 540) % 360) - 180);
    if (delta > 60) return null;
  }
  return snap;
}

/** Pictogramme d'une manœuvre (dessin choisi par l'app). */
export type ManeuverGlyph =
  | "straight" | "left" | "right" | "slight-left" | "slight-right" | "sharp-left" | "sharp-right"
  | "uturn" | "roundabout" | "arrive";

export function maneuverGlyph(m: NavManeuver): ManeuverGlyph {
  if (m.type === "arrive") return "arrive";
  if (m.type === "roundabout" || m.type === "rotary" || m.type === "exit roundabout" || m.type === "exit rotary") return "roundabout";
  const mod = m.modifier ?? "straight";
  if (mod === "uturn") return "uturn";
  if (m.type === "fork" || m.type === "on ramp" || m.type === "off ramp" || m.type === "merge") {
    if (mod.includes("left")) return "slight-left";
    if (mod.includes("right")) return "slight-right";
    return "straight";
  }
  if (m.type === "end of road") return mod.includes("left") ? "left" : "right";
  switch (mod) {
    case "left": return "left";
    case "right": return "right";
    case "slight left": return "slight-left";
    case "slight right": return "slight-right";
    case "sharp left": return "sharp-left";
    case "sharp right": return "sharp-right";
    default: return "straight";
  }
}
