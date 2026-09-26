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
