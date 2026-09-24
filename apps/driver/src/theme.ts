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

export const radius = { sm: 10, md: 14, lg: 20, xl: 28 };
export const mono = { fontVariant: ["tabular-nums"] as "tabular-nums"[] };

/** Estimation d'approche (voiture en ville) à partir d'une distance à vol d'oiseau. */
export function approachSeconds(distanceM: number | null | undefined) {
  if (distanceM == null) return null;
  return Math.round(((distanceM * 1.35) / 1000 / 24) * 3600) + 60;
}
