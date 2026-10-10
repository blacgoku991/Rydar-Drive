// Agenda, vue Semaine : 7 lignes, lundi en premier (lib/agenda-view.ts : weekRows) — jour, nombre de courses, total en
// chiffres tabulaires, jusqu'à 3 éléments compacts (« 08:30 Orly → Paris 8e ») puis « +n ». Toucher une ligne ouvre la
// vue Jour de ce jour.
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { plural, type WeekRow } from "@/lib/agenda-view";
import { colors, control, mono, radius, space, toneColor, type, weight } from "@/theme";

export function WeekList({ rows, onOpenDay }: { rows: WeekRow[]; onOpenDay: (day: string) => void }) {
  return (
    <View style={styles.list}>
      {rows.map((r, i) => (
        <Pressable
          key={r.day}
          onPress={() => onOpenDay(r.day)}
          style={({ pressed }) => [styles.row, i > 0 && styles.sep, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={r.a11y}
          accessibilityHint="Ouvre la vue jour"
        >
          <View style={styles.head}>
            <Text style={[styles.title, r.today && styles.today]} numberOfLines={1}>{r.title}</Text>
            {r.count > 0 && <Text style={styles.count}>{plural(r.count, "course", "courses")}</Text>}
            {r.total && <Text style={styles.total}>{r.total}</Text>}
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </View>
          {r.lines.map((l) => (
            <View key={l.id} style={styles.line}>
              <View style={[styles.dot, { backgroundColor: toneColor(l.tone) }]} />
              <Text style={[styles.lineText, l.muted && styles.muted]} numberOfLines={1}>{l.text}</Text>
            </View>
          ))}
          {r.more > 0 && <Text style={styles.more}>+{r.more}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  row: { minHeight: control.md, paddingHorizontal: space.lg, paddingVertical: space.md, gap: 6, justifyContent: "center" },
  sep: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { backgroundColor: colors.surface2 },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { flex: 1, color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  today: { color: colors.brand },
  count: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.medium, ...mono },
  total: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.bold, ...mono },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 6, height: 6, borderRadius: 3 },
  lineText: { flex: 1, color: colors.fg, fontSize: type.subhead, ...mono },
  muted: { color: colors.muted },
  more: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold, marginLeft: 14, ...mono },
});
