// Agenda : barre de période (‹ libellé ›) des vues Jour, Semaine et Mois, et puce « Aujourd'hui » de l'en-tête. Aucune
// navigation par balayage (pas de conflit avec le geste retour d'iOS) : boutons de 48 px.
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, control, radius, space, type, weight } from "@/theme";

export function PeriodBar({
  label, prevLabel, nextLabel, onPrev, onNext,
}: { label: string; prevLabel: string; nextLabel: string; onPrev: () => void; onNext: () => void }) {
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onPrev}
        style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={prevLabel}
      >
        <Ionicons name="chevron-back" size={22} color={colors.fg} />
      </Pressable>
      <Text style={styles.label} numberOfLines={1} accessibilityRole="header" accessibilityLiveRegion="polite">
        {label}
      </Text>
      <Pressable
        onPress={onNext}
        style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={nextLabel}
      >
        <Ionicons name="chevron-forward" size={22} color={colors.fg} />
      </Pressable>
    </View>
  );
}

/** Puce « Aujourd'hui » (en-tête de l'écran, 48 px) : retour à la période du jour. */
export function TodayChip({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="Aujourd'hui"
      accessibilityHint="Affiche la période d'aujourd'hui"
    >
      <Text style={styles.chipText}>Aujourd&apos;hui</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: space.sm },
  arrow: {
    width: control.sm, height: control.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  pressed: { backgroundColor: colors.surface3 },
  label: { flex: 1, textAlign: "center", color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold },
  chip: {
    height: control.sm, paddingHorizontal: space.md, borderRadius: radius.full, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  chipText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.semibold },
});
