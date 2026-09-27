// Dessin de la position du chauffeur, commun à la carte native (react-native-svg) et à l'aperçu web (SVG DOM) :
// point bleu à bord blanc + faisceau d'orientation hors guidage, flèche de navigation en guidage.
// Tout est dessiné pointé vers le nord (haut) puis tourné selon le cap : par la carte sur Android (marqueur à plat),
// dans le SVG sur iPhone (la vue du marqueur n'est jamais transformée, voir me-marker.tsx).
import { colors } from "@/theme";

/** Faisceau : éventail de 70° (±35°), rayon 46 px, pointe au centre du point. */
const BEAM_R = 46;
const BEAM_HALF_DEG = 35;

/** Côté du marqueur (px) : le faisceau tient dans le carré, quel que soit le cap. */
export const ME_SIZE = BEAM_R * 2;
const C = ME_SIZE / 2;

export const ME_BLUE = colors.blue;
export const ME_WHITE = "#FFFFFF";
/** Ombre légère : liseré sombre concentrique (identique quel que soit le cap, contrairement à une ombre décalée) */
export const ME_SHADOW = "rgba(0,0,0,0.32)";

/** Point : 22 px, bord blanc de 3 px. */
export const DOT = { cx: C, cy: C, r: 11, inner: 8, shadow: 12.5 } as const;

const at = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
};
export const BEAM_PATH = `M${C} ${C} L${at(-BEAM_HALF_DEG, BEAM_R)} A${BEAM_R} ${BEAM_R} 0 0 1 ${at(BEAM_HALF_DEG, BEAM_R)} Z`;
/** Opacité du faisceau : pleine près du point, nulle au bord (la direction se lit, le fond reste visible). */
export const BEAM_STOPS = [
  { offset: 0, opacity: 0.6 },
  { offset: 0.3, opacity: 0.48 },
  { offset: 1, opacity: 0 },
] as const;
export const BEAM_GRADIENT = { cx: C, cy: C, r: BEAM_R } as const;

/** Flèche de navigation (34 px de haut, 26 de large) centrée sur la position, pointe vers le haut. */
export const NAV_PATH = `M${C} ${C - 18} L${C + 13} ${C + 14} L${C} ${C + 7.5} L${C - 13} ${C + 14} Z`;
export const NAV_STROKE = 2.5;

export type MeMode = "dot" | "beam" | "nav";

/** Guidage : flèche ; sinon point, avec faisceau dès que le cap est connu. */
export function meMode(heading: number | null | undefined, navigation: boolean): MeMode {
  if (navigation) return "nav";
  return heading == null ? "dot" : "beam";
}

const DIRECTIONS = ["le nord", "le nord-est", "l'est", "le sud-est", "le sud", "le sud-ouest", "l'ouest", "le nord-ouest"];

/** Libellé d'accessibilité : « Votre position, orientée vers le nord-est ». */
export function meLabel(heading: number | null | undefined) {
  if (heading == null) return "Votre position";
  const i = Math.round((((heading % 360) + 360) % 360) / 45) % 8;
  return `Votre position, orientée vers ${DIRECTIONS[i]}`;
}

/** Même dessin en SVG texte pour l'aperçu web (chaînes constantes, aucune donnée externe). */
export function meMarkerSvg(mode: MeMode, gradientId: string) {
  const dot =
    `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.shadow}" fill="${ME_SHADOW}"/>` +
    `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${ME_WHITE}"/>` +
    `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.inner}" fill="${ME_BLUE}"/>`;
  let body = dot;
  if (mode === "beam") {
    const stops = BEAM_STOPS.map((s) => `<stop offset="${s.offset}" stop-color="${ME_BLUE}" stop-opacity="${s.opacity}"/>`).join("");
    body =
      `<defs><radialGradient id="${gradientId}" gradientUnits="userSpaceOnUse" cx="${BEAM_GRADIENT.cx}" cy="${BEAM_GRADIENT.cy}" r="${BEAM_GRADIENT.r}">${stops}</radialGradient></defs>` +
      `<path d="${BEAM_PATH}" fill="url(#${gradientId})"/>` +
      dot;
  } else if (mode === "nav") {
    body =
      `<path d="${NAV_PATH}" fill="none" stroke="${ME_SHADOW}" stroke-width="${NAV_STROKE + 3}" stroke-linejoin="round"/>` +
      `<path d="${NAV_PATH}" fill="${ME_BLUE}" stroke="${ME_WHITE}" stroke-width="${NAV_STROKE}" stroke-linejoin="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ME_SIZE}" height="${ME_SIZE}" viewBox="0 0 ${ME_SIZE} ${ME_SIZE}" aria-hidden="true" style="display:block;overflow:visible">${body}</svg>`;
}
