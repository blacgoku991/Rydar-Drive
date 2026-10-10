// Agenda, vue Jour : frise 0-24 h (64 px par heure) dans un défilement placé sur maintenant (aujourd'hui) ou 1 h avant
// la 1re course ; blocs placés à l'heure de prise en charge, hauteur selon la durée estimée (30 min et 48 px au moins),
// côte à côte quand ils se chevauchent (mention « Chevauchement »). Trait « maintenant » statique, recalculé par
// l'horloge de l'écran (aucune animation). lib/agenda-view.ts : timelineBlocks, entryView.
import { useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  HOUR_PX, entryView, nowLineTop, timelineBlocks, timelineHeight, timelineScrollY, type AgendaEntry, type EntryTarget,
} from "@/lib/agenda-view";
import { colors, mono, radius, space, toneColor, type, weight } from "@/theme";

/** Colonne des heures à gauche de la frise. */
const GUTTER = 52;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function DayTimeline({
  day, items, tz, now, isToday, onOpen,
}: {
  day: string;
  items: readonly AgendaEntry[];
  tz: string;
  now: number;
  isToday: boolean;
  onOpen: (target: EntryTarget) => void;
}) {
  const blocks = useMemo(() => timelineBlocks(items, tz), [items, tz]);
  const height = timelineHeight(blocks);
  const nowTop = isToday ? nowLineTop(now, tz) : null;
  const { height: windowH } = useWindowDimensions();
  const boxH = Math.round(Math.min(640, Math.max(360, windowH * 0.55)));
  const scrollRef = useRef<ScrollView>(null);
  // Défilement initial à l'ouverture du jour (pas à chaque relecture ni à chaque tic de l'horloge)
  const scrolledFor = useRef<string | null>(null);
  const initialY = timelineScrollY(blocks, nowTop);
  useEffect(() => {
    if (scrolledFor.current === day) return;
    scrolledFor.current = day;
    const t = setTimeout(() => scrollRef.current?.scrollTo({ y: initialY, animated: false }), 0);
    return () => clearTimeout(t);
  }, [day, initialY]);

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.box, { height: boxH }]}
      contentContainerStyle={{ height }}
      nestedScrollEnabled
      accessibilityLabel="Frise de la journée"
    >
      {HOURS.map((h) => (
        <View key={h} style={[styles.hour, { top: h * HOUR_PX }]} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Text style={styles.hourText}>{`${String(h).padStart(2, "0")}:00`}</Text>
          <View style={styles.hourLine} />
        </View>
      ))}
      <View style={styles.lane} pointerEvents="box-none">
        {blocks.map((b) => {
          const v = entryView(b.item, { tz, now }, b.overlap);
          const roomy = b.height >= 64;
          return (
            <Pressable
              key={b.item.id}
              onPress={() => onOpen(v.target)}
              style={[styles.slot, { top: b.top, height: b.height, left: `${(b.column / b.columns) * 100}%`, width: `${100 / b.columns}%` }]}
              accessibilityRole="button"
              accessibilityLabel={v.a11y}
            >
              {({ pressed }) => (
                <View style={[styles.block, { borderLeftColor: toneColor(v.tone) }, pressed && styles.pressed]}>
                  <Text style={[styles.blockTitle, v.muted && styles.muted]} numberOfLines={1}>
                    {v.time} · {v.title}
                  </Text>
                  {(roomy || !b.overlap) && <Text style={[styles.blockRoute, v.muted && styles.muted]} numberOfLines={1}>{v.route}</Text>}
                  {b.overlap && <Text style={styles.overlap} numberOfLines={1}>Chevauchement</Text>}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
      {nowTop != null && (
        <View style={[styles.now, { top: nowTop }]} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <View style={styles.nowDot} />
          <View style={styles.nowLine} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  hour: { position: "absolute", left: 0, right: 0, height: HOUR_PX, flexDirection: "row", alignItems: "flex-start" },
  hourText: { width: GUTTER, paddingLeft: space.sm, marginTop: -1, color: colors.muted, fontSize: type.caption, ...mono },
  hourLine: { flex: 1, height: 1, backgroundColor: colors.line },
  lane: { position: "absolute", top: 0, bottom: 0, left: GUTTER, right: space.sm },
  slot: { position: "absolute", padding: 1 },
  block: {
    flex: 1, overflow: "hidden", borderRadius: radius.sm, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong,
    borderLeftWidth: 3, paddingHorizontal: space.sm, paddingVertical: 4, gap: 1,
  },
  pressed: { backgroundColor: colors.surface3 },
  blockTitle: { color: colors.fg, fontSize: type.footnote, fontWeight: weight.semibold, ...mono },
  blockRoute: { color: colors.muted, fontSize: type.footnote },
  overlap: { color: colors.amber, fontSize: type.footnote, fontWeight: weight.semibold },
  muted: { color: colors.muted },
  now: { position: "absolute", left: GUTTER - 4, right: 0, height: 8, marginTop: -4, flexDirection: "row", alignItems: "center" },
  nowDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand },
  nowLine: { flex: 1, height: 2, backgroundColor: colors.brand },
});
