// Palette « Night Radar » (identique au dashboard web).
export const colors = {
  bg: "#07080B",
  bgDeep: "#040506",
  surface: "#0E1116",
  surface2: "#13161D",
  surface3: "#1A1E27",
  line: "rgba(255,255,255,0.08)",
  lineStrong: "rgba(255,255,255,0.14)",
  fg: "#F4F5F7",
  muted: "#9AA3B2",
  subtle: "#5F6777",
  brand: "#C8F03C",
  brandFg: "#0B0D04",
  amber: "#FFB020",
  blue: "#4C9DFF",
  violet: "#A78BFA",
  cyan: "#22D3EE",
  green: "#3DDC97",
  red: "#FF4D5E",
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
export const mono = { fontVariant: ["tabular-nums"] as ("tabular-nums")[] };
