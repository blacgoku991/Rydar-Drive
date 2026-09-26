import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { alpha, colors, mono, type, weight } from "@/theme";

/** Seuil (s) sous lequel l'anneau passe à l'ambre : il reste peu de temps pour répondre. */
const LOW_S = 8;

/**
 * Anneau de compte à rebours (temps de réponse à une offre) : secondes restantes au centre.
 * Aucune animation propre : l'anneau suit la valeur `remaining` fournie par l'écran.
 */
export function CountdownRing({ total, remaining, size = 84, color = colors.brand }: { total: number; remaining: number; size?: number; color?: string }) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const seconds = Math.max(0, Math.ceil(remaining));
  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`${seconds} seconde${seconds > 1 ? "s" : ""} pour répondre`}
    >
      <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={alpha(colors.fg, 0.1)} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={remaining <= LOW_S ? colors.amber : color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c}`}
          strokeDashoffset={c * (1 - pct)}
        />
      </Svg>
      <Text style={{ color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, lineHeight: type.title2 + 4, ...mono }}>{seconds}</Text>
      <Text style={{ color: colors.muted, fontSize: type.caption, fontWeight: weight.medium, lineHeight: type.caption + 2 }}>s</Text>
    </View>
  );
}
