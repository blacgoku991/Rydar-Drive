import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors } from "@/theme";

/** Ondes radar concentriques (animation native). */
export function RadarPulse({ size = 260, color = colors.brand, active = true, rings = 3 }: { size?: number; color?: string; active?: boolean; rings?: number }) {
  const anims = useRef(Array.from({ length: rings }, () => new Animated.Value(0))).current;
  useEffect(() => {
    if (!active) return;
    const loops = anims.map((a, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 700),
          Animated.timing(a, { toValue: 1, duration: 2400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(a, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, anims]);
  return (
    <View pointerEvents="none" style={{ width: size, height: size, position: "absolute", alignItems: "center", justifyContent: "center" }}>
      {anims.map((a, i) => (
        <Animated.View
          key={i}
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: color,
            opacity: a.interpolate({ inputRange: [0, 0.7, 1], outputRange: [active ? 0.7 : 0, 0.15, 0] }),
            transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }],
          }}
        />
      ))}
    </View>
  );
}

/** Grand interrupteur EN LIGNE / HORS LIGNE. */
export function OnlineToggle({ online, onPress, busy }: { online: boolean; onPress: () => void; busy?: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1400, useNativeDriver: true }),
    ]));
    if (online) loop.start();
    return () => loop.stop();
  }, [online, pulse]);
  const color = online ? colors.brand : colors.subtle;
  return (
    <View style={styles.toggleWrap}>
      <RadarPulse size={300} active={online} />
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: online, busy }}
        onPress={onPress}
        disabled={busy}
        style={({ pressed }) => [styles.toggle, { borderColor: online ? "rgba(200,240,60,0.55)" : colors.lineStrong, transform: [{ scale: pressed ? 0.97 : 1 }] }]}
      >
        <Animated.View style={[styles.core, { backgroundColor: online ? "rgba(200,240,60,0.1)" : colors.surface2, opacity: online ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }) : 1 }]} />
        <View style={[styles.statusDot, { backgroundColor: color, shadowColor: color }]} />
        <Text style={[styles.toggleText, { color: online ? colors.fg : colors.muted }]}>{busy ? "…" : online ? "EN LIGNE" : "HORS LIGNE"}</Text>
        <Text style={styles.toggleHint}>{online ? "Touchez pour passer hors ligne" : "Touchez pour recevoir des courses"}</Text>
      </Pressable>
    </View>
  );
}

/** Anneau de compte à rebours (temps de réponse à une offre). */
export function CountdownRing({ total, remaining, size = 84, color = colors.brand }: { total: number; remaining: number; size?: number; color?: string }) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={remaining <= 8 ? colors.amber : color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${c}`} strokeDashoffset={c * (1 - pct)} />
      </Svg>
      <Text style={{ color: colors.fg, fontSize: 24, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{Math.max(0, Math.ceil(remaining))}</Text>
      <Text style={{ color: colors.subtle, fontSize: 10, fontWeight: "700", letterSpacing: 1 }}>SEC</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleWrap: { alignItems: "center", justifyContent: "center", height: 320 },
  toggle: { width: 220, height: 220, borderRadius: 110, borderWidth: 1.5, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, overflow: "hidden" },
  core: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 110 },
  statusDot: { width: 14, height: 14, borderRadius: 7, marginBottom: 14, shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  toggleText: { fontSize: 26, fontWeight: "900", letterSpacing: 2 },
  toggleHint: { color: colors.subtle, fontSize: 12, marginTop: 8, textAlign: "center", paddingHorizontal: 24 },
});
