// Agenda, vue Mois : grille 7 × 6 commençant le lundi (lib/agenda-view.ts : monthCells). Cases de 48 × 52 px au moins
// (≈ 49 px de large sur un écran de 375 px), quantième en chiffres tabulaires, jusqu'à 3 points de 6 px (couleur =
// information) puis « +n » ; aujourd'hui : contour lime ; jour choisi : fond plus clair ; hors du mois : estompé.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { WEEKDAY_INITIALS, type MonthCell } from "@/lib/agenda-view";
import { colors, mono, radius, toneColor, type, weight } from "@/theme";

const CELL_W = `${100 / 7}%` as const;

export function MonthGrid({ cells, onSelect }: { cells: MonthCell[]; onSelect: (day: string) => void }) {
  return (
    <View>
      <View style={styles.head} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {WEEKDAY_INITIALS.map((d, i) => (
          <Text key={i} style={styles.headText}>{d}</Text>
        ))}
      </View>
      <View style={styles.grid}>
        {cells.map((c) => (
          <Pressable
            key={c.day}
            onPress={() => onSelect(c.day)}
            style={({ pressed }) => [styles.cell, c.selected && styles.selected, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={c.a11y}
            accessibilityState={{ selected: c.selected }}
            accessibilityHint="Affiche les courses de ce jour sous le calendrier"
          >
            <View style={[styles.inner, c.today && styles.today]}>
              <Text style={[styles.num, !c.inMonth && styles.outside, c.today && styles.todayNum]}>{c.label}</Text>
              <View style={styles.dots}>
                {c.dots.map((tone, i) => (
                  <View key={i} style={[styles.dot, { backgroundColor: toneColor(tone) }]} />
                ))}
                {c.more > 0 && <Text style={styles.more}>+{c.more}</Text>}
              </View>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", marginBottom: 2 },
  headText: { width: CELL_W, textAlign: "center", color: colors.muted, fontSize: type.caption, fontWeight: weight.semibold, paddingVertical: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: CELL_W, height: 52, padding: 1, borderRadius: radius.sm },
  selected: { backgroundColor: colors.surface2 },
  pressed: { backgroundColor: colors.surface3 },
  inner: { flex: 1, alignItems: "center", paddingTop: 6, gap: 6, borderRadius: radius.sm, borderWidth: 1.5, borderColor: "transparent" },
  today: { borderColor: colors.brand },
  num: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, ...mono },
  outside: { color: colors.muted, fontWeight: weight.regular },
  todayNum: { fontWeight: weight.bold },
  dots: { flexDirection: "row", alignItems: "center", gap: 3, height: 14 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  more: { color: colors.muted, fontSize: type.caption, lineHeight: 14, fontWeight: weight.semibold, ...mono },
});
