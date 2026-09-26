// Palette « Rydar Night » (identique au dashboard web).
export const colors = {
  bg: "#0A0B0E",
  bgDeep: "#060709",
  surface: "#111318",
  surface2: "#16191F",
  surface3: "#1C2027",
  line: "rgba(255,255,255,0.07)",
  lineStrong: "rgba(255,255,255,0.12)",
  fg: "#EEF0F3",
  muted: "#9EA5B1",
  subtle: "#666D79",
  brand: "#C8F03C",
  brandFg: "#0B0D04",
  amber: "#F5B544",
  blue: "#6AA6FF",
  violet: "#B39DFA",
  cyan: "#45D6E6",
  green: "#4FD58F",
  red: "#F2555A",
};

export const presenceColor: Record<string, string> = {
  available: colors.brand,
  offered: colors.amber,
  en_route: colors.blue,
  arrived: colors.violet,
  on_trip: colors.cyan,
  offline: colors.subtle,
};

// --- Système de design (sobre, lisible en plein soleil) -------------------------------------------
// Règles : 4 graisses au plus (400/500/600/700, jamais 800/900) ; couleur = information (lime : en ligne et
// action principale ; ambre / rouge / bleu : états), jamais décoration ; cibles tactiles ≥ 48 px (56 en
// conduite) ; aucune animation en boucle décorative ; aucun emoji ; icônes Ionicons « outline ».

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, full: 999 };
export const mono = { fontVariant: ["tabular-nums"] as "tabular-nums"[] };

/** Échelle typographique (pt). Information utile en conduite : 15 minimum ; métadonnées : 13. */
export const type = { caption: 12, footnote: 13, subhead: 14, body: 15, callout: 16, headline: 17, title3: 20, title2: 24, title1: 30, display: 40 } as const;
export const weight = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
/** Hauteurs de contrôle : 48 (secondaire), 56 (standard), 64 (principal), 72 (« Passer en ligne », « Accepter »). */
export const control = { sm: 48, md: 56, lg: 64, xl: 72 } as const;

/** Couleur du thème avec opacité : alpha(colors.red, 0.12) → "rgba(242,85,90,0.12)". */
export function alpha(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Boutons et pastilles posés sur la carte : fond sombre opaque, bordure fine. */
export const overlay = { backgroundColor: "rgba(17,19,24,0.94)", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)" } as const;

/** Tons des libellés partagés (@rydar/shared : vols, documents) → couleurs de l'app. */
export function toneColor(tone: string | null | undefined) {
  switch (tone) {
    case "green": return colors.green;
    case "amber": return colors.amber;
    case "red": return colors.red;
    case "blue": return colors.blue;
    case "violet": return colors.violet;
    case "cyan": return colors.cyan;
    default: return colors.muted;
  }
}

/** « à l'instant », « il y a 6 min », « il y a 2 h », « il y a 3 j » (sans Intl.RelativeTimeFormat, absent de Hermes). */
export function ago(date: string | number | Date | null | undefined, now = Date.now()) {
  if (date == null) return "";
  const s = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (s < 45) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

/** Estimation d'approche (voiture en ville) à partir d'une distance à vol d'oiseau. */
export function approachSeconds(distanceM: number | null | undefined) {
  if (distanceM == null) return null;
  return Math.round(((distanceM * 1.35) / 1000 / 24) * 3600) + 60;
}
