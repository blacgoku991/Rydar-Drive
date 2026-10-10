// Agenda : ligne d'une course ou d'une réservation (liste du jour choisi sous la grille du mois) — heure en chiffres
// tabulaires, point et état (couleur = information), trajet, prix. Toucher : la course, l'offre en attente, ou la carte
// du bloc « À traiter ».
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { EntryView } from "@/lib/agenda-view";
import { colors, control, mono, radius, space, toneColor, type, weight } from "@/theme";

export function EntryRow({ v, onPress }: { v: EntryView; onPress: () => void }) {
  const tone = toneColor(v.tone);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={v.a11y}
      accessibilityHint={v.target.kind === "ride" ? "Ouvre le détail de la course" : v.target.kind === "offer" ? "Ouvre la réservation" : "Affiche la réservation à traiter"}
    >
      <Text style={[styles.time, v.muted && styles.muted]}>{v.time}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.kindRow}>
          <View style={[styles.dot, { backgroundColor: tone }]} />
          <Text style={[styles.kind, { color: v.muted ? colors.muted : tone }]} numberOfLines={1}>{v.kindLabel}</Text>
          <Text style={styles.title} numberOfLines={1}>{v.title}</Text>
        </View>
        <Text style={[styles.route, v.muted && styles.muted]} numberOfLines={1}>{v.route}</Text>
      </View>
      <Text style={[styles.price, v.muted && styles.muted]}>{v.price}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.md, paddingHorizontal: space.lg, paddingVertical: 10,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
  },
  pressed: { backgroundColor: colors.surface2 },
  time: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold, ...mono },
  kindRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  kind: { fontSize: type.footnote, fontWeight: weight.semibold },
  title: { flexShrink: 1, color: colors.muted, fontSize: type.footnote, ...mono },
  route: { color: colors.fg, fontSize: type.subhead },
  price: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.bold, ...mono },
  muted: { color: colors.muted },
});
