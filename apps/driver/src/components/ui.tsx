import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "@/theme";

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>
      <LinearGradient colors={["rgba(200,240,60,0.07)", "transparent"]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 0.6, y: 0.45 }} />
      {children}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function BigButton({
  title, onPress, loading, variant = "primary", icon, style, disabled, height = 64,
}: {
  title: string; onPress: () => void; loading?: boolean; variant?: "primary" | "secondary" | "danger"; icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>; disabled?: boolean; height?: number;
} & Omit<PressableProps, "onPress" | "style">) {
  const bg = variant === "primary" ? colors.brand : variant === "danger" ? "rgba(255,77,94,0.14)" : colors.surface3;
  const fg = variant === "primary" ? colors.brandFg : variant === "danger" ? colors.red : colors.fg;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={() => {
        void Haptics.impactAsync(variant === "primary" ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { height, backgroundColor: bg, opacity: disabled ? 0.45 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        variant === "primary" && styles.glow,
        variant !== "primary" && { borderWidth: 1, borderColor: variant === "danger" ? "rgba(255,77,94,0.3)" : colors.lineStrong },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {icon && <Ionicons name={icon} size={22} color={fg} />}
          <Text style={[styles.buttonText, { color: fg, fontSize: height >= 64 ? 18 : 15 }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Pill({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.pill, { borderColor: `${color}55`, backgroundColor: `${color}1A` }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function RouteLine({ from, to, big }: { from: string; to: string; big?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 14 }}>
      <View style={{ alignItems: "center", paddingTop: 6 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand }} />
        <View style={{ width: 2, flex: 1, minHeight: big ? 30 : 20, backgroundColor: "rgba(200,240,60,0.35)", marginVertical: 4 }} />
        <View style={{ width: 10, height: 10, backgroundColor: colors.fg, transform: [{ rotate: "45deg" }] }} />
      </View>
      <View style={{ flex: 1, gap: big ? 18 : 12 }}>
        <View>
          <Text style={styles.routeLabel}>Départ</Text>
          <Text style={[styles.routeText, big && { fontSize: 19 }]} numberOfLines={2}>{from}</Text>
        </View>
        <View>
          <Text style={styles.routeLabel}>Destination</Text>
          <Text style={[styles.routeText, big && { fontSize: 19 }, { color: colors.muted }]} numberOfLines={2}>{to}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 18 },
  label: { color: colors.subtle, fontSize: 11, fontWeight: "700", letterSpacing: 1.6, textTransform: "uppercase" },
  button: { borderRadius: radius.lg, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  glow: { shadowColor: colors.brand, shadowOpacity: 0.45, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  buttonText: { fontWeight: "800", letterSpacing: 0.3 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, borderWidth: 1, alignSelf: "flex-start" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 12, fontWeight: "700" },
  routeLabel: { color: colors.subtle, fontSize: 11, fontWeight: "600", marginBottom: 2 },
  routeText: { color: colors.fg, fontSize: 16, fontWeight: "600" },
});
