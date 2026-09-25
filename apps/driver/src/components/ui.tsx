import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, PanResponder, Platform, Pressable, StyleSheet, Text, View,
  type LayoutChangeEvent, type PressableProps, type StyleProp, type TextStyle, type ViewStyle,
} from "react-native";
import { colors, radius } from "@/theme";

const haptic = (style: Haptics.ImpactFeedbackStyle) => {
  if (Platform.OS !== "web") void Haptics.impactAsync(style);
};

/** Retour haptique d'une action aboutie (ou refusée). */
export function hapticResult(ok: boolean) {
  if (Platform.OS !== "web") void Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error).catch(() => null);
}

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>{children}</View>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

/** Panneau inférieur arrondi (posé sur la carte). */
export function Sheet({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.sheet, style]}>
      <View style={styles.handle} />
      {children}
    </View>
  );
}

export function BigButton({
  title, onPress, loading, variant = "primary", icon, style, disabled, height = 64,
}: {
  title: string; onPress: () => void; loading?: boolean; variant?: "primary" | "secondary" | "danger" | "ghost"; icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>; disabled?: boolean; height?: number;
} & Omit<PressableProps, "onPress" | "style">) {
  const bg = variant === "primary" ? colors.brand : variant === "danger" ? "rgba(242,85,90,0.14)" : variant === "ghost" ? "transparent" : colors.surface3;
  const fg = variant === "primary" ? colors.brandFg : variant === "danger" ? colors.red : variant === "ghost" ? colors.muted : colors.fg;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={() => {
        haptic(variant === "primary" ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { height, backgroundColor: bg, opacity: disabled ? 0.45 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {icon && <Ionicons name={icon} size={height >= 64 ? 24 : 20} color={fg} />}
          <Text style={[styles.buttonText, { color: fg, fontSize: height >= 64 ? 19 : 16 }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * Glisser pour confirmer : évite les erreurs de manipulation au volant
 * (« Je suis arrivé », « Terminer la course »…).
 */
export function SlideToConfirm({
  label, onConfirm, color = colors.brand, loading, height = 72,
}: { label: string; onConfirm: () => void; color?: string; loading?: boolean; height?: number }) {
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const knob = height - 12;
  const max = Math.max(0, width - knob - 12);
  const maxRef = useRef(max);
  maxRef.current = max;
  const fired = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    if (!loading) {
      fired.current = false;
      Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
    }
  }, [loading, label, x]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => haptic(Haptics.ImpactFeedbackStyle.Light),
      onPanResponderMove: (_, g) => x.setValue(Math.max(0, Math.min(maxRef.current, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx >= maxRef.current * 0.82 && !fired.current) {
          fired.current = true;
          Animated.timing(x, { toValue: maxRef.current, duration: 120, useNativeDriver: false }).start();
          haptic(Haptics.ImpactFeedbackStyle.Heavy);
          onConfirmRef.current();
        } else Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
      },
    }),
  ).current;

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.slide, { height, borderColor: `${color}55` }]}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityActions={[{ name: "activate", label }]}
      onAccessibilityAction={() => onConfirm()}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: x.interpolate({ inputRange: [0, Math.max(1, max)], outputRange: [0.08, 0.35] }), borderRadius: height / 2 }]} />
      <Text style={[styles.slideText, { color: colors.fg }]}>{loading ? "…" : label}</Text>
      <Animated.View
        {...pan.panHandlers}
        style={[styles.knob, { width: knob, height: knob, borderRadius: knob / 2, backgroundColor: color, transform: [{ translateX: x }] }]}
      >
        {loading ? <ActivityIndicator color={colors.brandFg} /> : <Ionicons name="chevron-forward" size={30} color={colors.brandFg} />}
      </Animated.View>
    </View>
  );
}

export function Pill({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: `${color}1F` }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

/** Progression de la course (étapes chauffeur). */
export function StepDots({ steps, current }: { steps: string[]; current: number }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 5 }}>
        {steps.map((s, i) => (
          <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < current ? colors.brand : i === current ? colors.amber : "rgba(255,255,255,0.09)" }} />
        ))}
      </View>
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600" }}>
        Étape {Math.min(current + 1, steps.length)} sur {steps.length} · <Text style={{ color: colors.fg }}>{steps[Math.min(current, steps.length - 1)]}</Text>
      </Text>
    </View>
  );
}

export function RouteLine({ from, to, big }: { from: string; to: string; big?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 14 }}>
      <View style={{ alignItems: "center", paddingTop: 6 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand }} />
        <View style={{ width: 2, flex: 1, minHeight: big ? 26 : 18, backgroundColor: colors.lineStrong, marginVertical: 4 }} />
        <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors.fg }} />
      </View>
      <View style={{ flex: 1, gap: big ? 16 : 10 }}>
        <Text style={[styles.routeText, big && { fontSize: 18 }]} numberOfLines={2}>{from}</Text>
        <Text style={[styles.routeText, big && { fontSize: 18 }, { color: colors.muted }]} numberOfLines={2}>{to}</Text>
      </View>
    </View>
  );
}

export function Chip({ icon, text, color = colors.muted }: { icon: keyof typeof Ionicons.glyphMap; text: string; color?: string }) {
  return (
    <View style={styles.chip}>
      <Ionicons name={icon} size={15} color={color} />
      <Text style={[styles.chipText, { color }]}>{text}</Text>
    </View>
  );
}

/** En-tête d'écran secondaire : retour, titre, action à droite. */
export function ScreenHeader({ title, right, onBack }: { title: string; right?: React.ReactNode; onBack?: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace("/home")))}
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel="Retour"
        hitSlop={8}
      >
        <Ionicons name="chevron-back" size={22} color={colors.fg} />
      </Pressable>
      <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      <View style={{ minWidth: 44, alignItems: "flex-end" }}>{right}</View>
    </View>
  );
}

/** Sélecteur à onglets (Centrale | Flotte, Jour | Semaine | Mois), avec pastille de non-lus optionnelle. */
export function Segmented<T extends string>({
  options, value, onChange, style,
}: { options: { value: T; label: string; badge?: number }[]; value: T; onChange: (v: T) => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.segmented, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (!active) haptic(Haptics.ImpactFeedbackStyle.Light);
              onChange(o.value);
            }}
            style={[styles.segment, active && styles.segmentActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentText, active && { color: colors.fg }]}>{o.label}</Text>
            {!!o.badge && o.badge > 0 && (
              <View style={styles.segmentBadge}>
                <Text style={styles.segmentBadgeText}>{o.badge > 99 ? "99+" : o.badge}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Pastille de compteur (non-lus) posée sur un bouton rond. */
export function CountBadge({ count, color = colors.brand }: { count: number; color?: string }) {
  if (count <= 0) return null;
  return (
    <View style={[styles.countBadge, { backgroundColor: color }]} pointerEvents="none">
      <Text style={styles.countBadgeText}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

type FlashTone = "success" | "error" | "info";
/**
 * Bandeau de confirmation éphémère (« Signalé à la flotte ») : `node` à placer dans l'écran,
 * `show(texte, ton)` pour l'afficher ~2,6 s.
 */
export function useFlash(top = 0) {
  const [msg, setMsg] = useState<{ text: string; tone: FlashTone; key: number } | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!msg) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 7 }).start();
    const t = setTimeout(() => {
      Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => setMsg((m) => (m?.key === msg.key ? null : m)));
    }, msg.tone === "error" ? 4200 : 2600);
    return () => clearTimeout(t);
  }, [msg, anim]);
  const show = useCallback((text: string, tone: FlashTone = "success") => setMsg({ text, tone, key: Date.now() }), []);
  const color = msg?.tone === "error" ? colors.red : msg?.tone === "info" ? colors.blue : colors.brand;
  const node = msg ? (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.flash,
        { top, borderColor: `${color}55`, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }] },
      ]}
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={msg.tone === "error" ? "alert-circle" : msg.tone === "info" ? "information-circle" : "checkmark-circle"} size={22} color={color} />
      <Text style={styles.flashText}>{msg.text}</Text>
    </Animated.View>
  ) : null;
  return { node, show };
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 18 },
  label: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 10, borderTopWidth: 1, borderColor: colors.line },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.14)", marginBottom: 14 },
  button: { borderRadius: radius.lg, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  buttonText: { fontWeight: "800", letterSpacing: 0.2 },
  slide: { borderRadius: 999, borderWidth: 1, backgroundColor: colors.surface2, justifyContent: "center", overflow: "hidden" },
  slideText: { position: "absolute", left: 0, right: 0, textAlign: "center", fontSize: 18, fontWeight: "800", paddingLeft: 40 },
  knob: { position: "absolute", left: 6, alignItems: "center", justifyContent: "center" },
  pill: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, alignSelf: "flex-start" },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 13, fontWeight: "700" },
  routeText: { color: colors.fg, fontSize: 16, fontWeight: "600" },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.surface2 },
  chipText: { fontSize: 14, fontWeight: "600" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  headerBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  headerTitle: { flex: 1, textAlign: "center", color: colors.fg, fontSize: 18, fontWeight: "800" },
  segmented: { flexDirection: "row", padding: 4, borderRadius: 16, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line },
  segment: { flex: 1, height: 42, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  segmentActive: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong },
  segmentText: { color: colors.muted, fontSize: 15, fontWeight: "800" },
  segmentBadge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.brand },
  segmentBadgeText: { color: colors.brandFg, fontSize: 11, fontWeight: "900", fontVariant: ["tabular-nums"] },
  countBadge: { position: "absolute", top: -3, right: -3, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.bg },
  countBadgeText: { color: colors.brandFg, fontWeight: "900", fontSize: 11, fontVariant: ["tabular-nums"] },
  flash: {
    position: "absolute", left: 16, right: 16, zIndex: 50, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: 18, backgroundColor: "rgba(17,19,24,0.97)", borderWidth: 1,
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12,
  },
  flashText: { flex: 1, color: colors.fg, fontSize: 16, fontWeight: "800" },
});
