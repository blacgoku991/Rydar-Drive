import { navDistance, type ManeuverGlyph } from "@rydar/shared";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import type { NavNext } from "@/hooks/use-navigation";
import { colors, mono, radius, space, type, weight } from "@/theme";

/** Tracés (grille 24) des manœuvres vers la droite ; les manœuvres à gauche sont les mêmes, en miroir. */
const RIGHT: Record<string, { line: string; head: string }> = {
  straight: { line: "M12 21V4", head: "M6.5 9.5L12 4l5.5 5.5" },
  right: { line: "M7 21v-8a4 4 0 0 1 4-4h9", head: "M15 4l5 5-5 5" },
  "slight-right": { line: "M8 21v-6.5L17.5 5", head: "M11 5h6.5v6.5" },
  "sharp-right": { line: "M7 21V7l10 10", head: "M17 10.5V17h-6.5" },
  // Demi-tour par la gauche (circulation à droite) : dessiné tel quel, sans miroir
  uturn: { line: "M16 21V9a4 4 0 0 0-8 0v7", head: "M4.5 12.5L8 16l3.5-3.5" },
};

function Glyph({ glyph, size, color }: { glyph: ManeuverGlyph; size: number; color: string }) {
  const stroke = { stroke: color, strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" } as const;
  if (glyph === "arrive") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M12 21.5s-6.5-5.6-6.5-11.5a6.5 6.5 0 0 1 13 0c0 5.9-6.5 11.5-6.5 11.5z" {...stroke} />
        <Circle cx={12} cy={10} r={2.2} {...stroke} />
      </Svg>
    );
  }
  if (glyph === "roundabout") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx={12} cy={10.5} r={4.2} {...stroke} />
        <Path d="M12 21.5v-6.8M15 7.5l4.5-4.5" {...stroke} />
        <Path d="M14.5 3h5v5" {...stroke} />
      </Svg>
    );
  }
  const left = glyph.endsWith("left");
  const d = RIGHT[glyph.replace("left", "right")] ?? RIGHT.straight!;
  return (
    <View style={left ? styles.mirror : undefined}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={d.line} {...stroke} />
        <Path d={d.head} {...stroke} />
      </Svg>
    </View>
  );
}

/** Pictogramme d'une manœuvre (flèche de direction, rond-point, arrivée). */
export function ManeuverIcon({ glyph, size = 32, color = colors.fg }: { glyph: ManeuverGlyph; size?: number; color?: string }) {
  return <Glyph glyph={glyph} size={size} color={color} />;
}

/**
 * Bandeau de guidage posé sur la carte : prochaine manœuvre, distance, instruction ; « Puis… » quand deux
 * manœuvres s'enchaînent ; « Recalcul de l'itinéraire » quand le chauffeur a quitté le tracé.
 */
export function NavBanner({ next, then, rerouting }: { next: NavNext | null; then: ManeuverGlyph | null; rerouting: boolean }) {
  if (rerouting) {
    return (
      <View style={styles.banner} accessible accessibilityLabel="Recalcul de l'itinéraire">
        <View style={styles.glyphBox}>
          <ActivityIndicator color={colors.fg} />
        </View>
        <Text style={[styles.instruction, styles.flex]}>Recalcul de l'itinéraire…</Text>
      </View>
    );
  }
  if (!next) return null;
  const arrived = next.glyph === "arrive" && next.distance < 20;
  const distance = arrived ? null : navDistance(next.distance);
  return (
    <View style={styles.banner} accessible accessibilityLabel={distance ? `Dans ${distance}, ${next.instruction}` : next.instruction}>
      <View style={styles.glyphBox}>
        <ManeuverIcon glyph={next.glyph} />
      </View>
      <View style={styles.flex}>
        {distance && <Text style={styles.distance}>{distance}</Text>}
        <Text style={styles.instruction} numberOfLines={2}>{next.instruction}</Text>
        {then && !arrived && (
          <View style={styles.then}>
            <Text style={styles.thenText}>Puis</Text>
            <ManeuverIcon glyph={then} size={18} color={colors.muted} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.lineStrong,
  },
  glyphBox: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  mirror: { transform: [{ scaleX: -1 }] },
  flex: { flex: 1 },
  distance: { color: colors.fg, fontSize: type.title2, lineHeight: type.title2 + 4, fontWeight: weight.bold, ...mono },
  instruction: { color: colors.fg, fontSize: type.body, lineHeight: 20, fontWeight: weight.medium },
  then: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  thenText: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium },
});
