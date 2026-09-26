// Écrans d'accès (connexion, mot de passe oublié, inscription par lien) : radar animé, logo, champs à
// libellé flottant, bouton lumineux, carte vitrée. Animations natives, coupées si « Réduire les animations ».
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing, Keyboard, LayoutAnimation, Platform, Pressable, StyleSheet, Text, TextInput, View,
  type KeyboardEvent, type StyleProp, type TextInputProps, type ViewStyle,
} from "react-native";
import Svg, { Circle, Defs, G, Line, Path, RadialGradient, Stop } from "react-native-svg";
import { colors, radius } from "@/theme";

type IconName = keyof typeof Ionicons.glyphMap;

/** « Réduire les animations » (iOS / Android / navigateur) : balayage, reflets et entrées désactivés. */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduce(v))
      .catch(() => null);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * Clavier affiché. iOS : annoncé avant l'animation du clavier, dont on reprend la durée et la courbe
 * (comme KeyboardAvoidingView) pour que l'écran se réorganise en même temps que lui.
 */
export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const animate = (e: KeyboardEvent) => {
      if (!ios || !e?.duration) return;
      LayoutAnimation.configureNext({
        duration: Math.max(e.duration, 10),
        update: { duration: Math.max(e.duration, 10), type: LayoutAnimation.Types[e.easing as keyof typeof LayoutAnimation.Types] ?? "keyboard" },
      });
    };
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      animate(e);
      setVisible(true);
    });
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", (e) => {
      animate(e);
      setVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/** Secousse horizontale (saisie refusée) + vibration d'erreur. */
export function useShake() {
  const x = useRef(new Animated.Value(0)).current;
  const shake = useCallback(() => {
    if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => null);
    x.setValue(0);
    Animated.sequence([10, -10, 7, -7, 3, 0].map((toValue) => Animated.timing(x, { toValue, duration: 45, useNativeDriver: true }))).start();
  }, [x]);
  return { shake, style: { transform: [{ translateX: x }] } };
}

/** Apparition (fondu + glissement) au montage. */
export function EnterView({
  children, delay = 0, from = 14, animate = true, style,
}: { children: React.ReactNode; delay?: number; from?: number; animate?: boolean; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (!animate) {
      v.setValue(1);
      return;
    }
    const anim = Animated.timing(v, { toValue: 1, duration: 420, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [animate, delay, v]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

// --- Radar --------------------------------------------------------------------------------------

const SWEEP_MS = 5600;
const RINGS = [0.3, 0.48, 0.66, 0.84];
const TRAIL_DEG = 78;
const TRAIL_LAYERS = 22;
/** Échos (d : distance au centre, a : angle en degrés depuis le nord, sens horaire) — couleurs des statuts chauffeur. */
const BLIPS = [
  { d: 0.5, a: 32, color: colors.brand },
  { d: 0.76, a: 98, color: colors.brand },
  { d: 0.84, a: 150, color: colors.cyan },
  { d: 0.88, a: 192, color: colors.brand },
  { d: 0.62, a: 238, color: colors.amber },
  { d: 0.9, a: 292, color: colors.brand },
  { d: 0.56, a: 330, color: colors.brand },
];
const BLIP_DECAY = 0.42;

function polar(c: number, radiusPx: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: c + radiusPx * Math.sin(rad), y: c - radiusPx * Math.cos(rad) };
}

/** Luminosité d'un écho selon la position du balayage (0 → 1 = un tour) : s'allume au passage, s'éteint ensuite. */
function blipRange(angle: number): { input: number[]; output: number[] } {
  const p = angle / 360;
  if (p + BLIP_DECAY <= 1) return { input: [0, p, p + 0.002, p + BLIP_DECAY, 1], output: [0, 0, 1, 0, 0] };
  const tail = p + BLIP_DECAY - 1;
  const atZero = 1 - (1 - p) / BLIP_DECAY;
  return { input: [0, tail, p, p + 0.002, 1], output: [atZero, 0, 0, 1, atZero] };
}

/**
 * Écran radar : anneaux, graduations, halo, balayage tournant (traînée dégradée)
 * et échos qui s'allument au passage. Un seul Animated.Value (pilote natif) anime le tout.
 */
export function RadarScope({ size, animate = true }: { size: number; animate?: boolean }) {
  const sweep = useRef(new Animated.Value(0.14)).current;
  useEffect(() => {
    if (!animate) {
      sweep.setValue(0.14);
      return;
    }
    sweep.setValue(0);
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: SWEEP_MS, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [animate, sweep]);

  const c = size / 2;
  const R = c * 0.97;
  const scope = useMemo(() => {
    const ticks = Array.from({ length: 72 }, (_, i) => {
      const deg = i * 5;
      const major = deg % 30 === 0;
      const a = polar(c, R, deg);
      const b = polar(c, R - (major ? 11 : 5), deg);
      return <Line key={deg} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={colors.brand} strokeOpacity={major ? 0.3 : 0.13} strokeWidth={major ? 1.4 : 1} />;
    });
    // Traînée : secteurs superposés, tous terminés sur le bord d'attaque → dégradé angulaire sans jointure
    const lead = polar(c, R, 0);
    const trail = Array.from({ length: TRAIL_LAYERS }, (_, k) => {
      const start = polar(c, R, -TRAIL_DEG * (1 - k / TRAIL_LAYERS));
      return <Path key={k} d={`M ${c} ${c} L ${start.x} ${start.y} A ${R} ${R} 0 0 1 ${lead.x} ${lead.y} Z`} fill={colors.brand} fillOpacity={0.015} />;
    });
    return { ticks, trail, lead };
  }, [c, R]);

  const rotate = sweep.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="scopeGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.brand} stopOpacity={0.2} />
            <Stop offset="0.35" stopColor={colors.brand} stopOpacity={0.06} />
            <Stop offset="1" stopColor={colors.brand} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={c} cy={c} r={c} fill="url(#scopeGlow)" />
        <G>
          <Line x1={c - R} y1={c} x2={c + R} y2={c} stroke={colors.brand} strokeOpacity={0.09} strokeDasharray="2 7" />
          <Line x1={c} y1={c - R} x2={c} y2={c + R} stroke={colors.brand} strokeOpacity={0.09} strokeDasharray="2 7" />
        </G>
        {RINGS.map((f, i) => (
          <Circle key={f} cx={c} cy={c} r={R * f} fill="none" stroke={colors.brand} strokeOpacity={0.15 - i * 0.022} strokeWidth={1} />
        ))}
        <Circle cx={c} cy={c} r={R} fill="none" stroke={colors.brand} strokeOpacity={0.22} strokeWidth={1.2} />
        {scope.ticks}
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
        <Svg width={size} height={size}>
          {scope.trail}
          <Line x1={c} y1={c} x2={scope.lead.x} y2={scope.lead.y} stroke={colors.brand} strokeOpacity={0.14} strokeWidth={7} strokeLinecap="round" />
          <Line x1={c} y1={c} x2={scope.lead.x} y2={scope.lead.y} stroke={colors.brand} strokeOpacity={0.85} strokeWidth={1.6} strokeLinecap="round" />
        </Svg>
      </Animated.View>
      {BLIPS.map((b) => {
        const p = polar(c, R * b.d, b.a);
        const { input, output } = blipRange(b.a);
        return (
          <Animated.View
            key={b.a}
            style={[
              styles.blip,
              {
                left: p.x - 10,
                top: p.y - 10,
                opacity: sweep.interpolate({ inputRange: input, outputRange: output, extrapolate: "clamp" }),
                transform: [{ scale: sweep.interpolate({ inputRange: input, outputRange: output.map((o) => 0.8 + o * 0.5), extrapolate: "clamp" }) }],
              },
            ]}
          >
            <View style={[styles.blipHalo, { backgroundColor: `${b.color}33` }]} />
            <View style={[styles.blipCore, { backgroundColor: b.color, shadowColor: b.color }]} />
          </Animated.View>
        );
      })}
    </View>
  );
}

/** Logo Rydar (anneaux + point, comme l'icône de l'app) ; intérieur translucide : le balayage passe dessous. */
export function LogoMark({ size }: { size: number }) {
  return (
    <View style={[styles.logo, { width: size, height: size, borderRadius: size / 2 }]}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Circle cx={50} cy={50} r={46} fill="rgba(8,9,12,0.55)" stroke={colors.brand} strokeWidth={5.5} />
        <Circle cx={50} cy={50} r={29} fill="none" stroke={colors.brand} strokeOpacity={0.42} strokeWidth={4} />
        <Circle cx={50} cy={50} r={10} fill={colors.brand} />
      </Svg>
    </View>
  );
}

/** Point lumineux qui respire (statut « en ligne »). */
export function PulseDot({ color = colors.brand, animate = true }: { color?: string; animate?: boolean }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!animate) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.35, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, v]);
  return <Animated.View style={[styles.pulseDot, { backgroundColor: color, shadowColor: color, opacity: v }]} />;
}

// --- Formulaire ---------------------------------------------------------------------------------

/** Carte vitrée (flou iOS / navigateur ; fond opaque sur Android, où le flou natif est coûteux). */
export function GlassCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.glass, style]}>
      {Platform.OS !== "android" && <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />}
      <LinearGradient pointerEvents="none" colors={["rgba(255,255,255,0.075)", "rgba(255,255,255,0)"]} style={styles.glassSheen} />
      <View style={styles.glassBody}>{children}</View>
    </View>
  );
}

type AuthFieldProps = Omit<TextInputProps, "style" | "placeholder"> & {
  label: string;
  icon: IconName;
  /** Exemple affiché dans le champ vide pendant la saisie. */
  hint?: string;
  error?: string | null;
  /** Mot de passe : masqué, avec bouton « afficher ». */
  secure?: boolean;
  right?: React.ReactNode;
  ref?: React.Ref<TextInput>;
};

/** Champ à libellé flottant : icône, halo au focus, erreur sous le champ, œil pour les mots de passe. */
export function AuthField({ label, icon, hint, error, secure, right, value, onFocus, onBlur, editable = true, ref, ...input }: AuthFieldProps) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const filled = !!value;
  const lift = useRef(new Animated.Value(filled ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(lift, { toValue: focused || filled ? 1 : 0, duration: 170, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [focused, filled, lift]);
  const tint = error ? colors.red : focused ? colors.brand : colors.subtle;
  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.field, focused && styles.fieldFocused, !!error && styles.fieldInvalid, !editable && { opacity: 0.6 }]}>
        <View style={[styles.fieldIcon, focused && !error && { backgroundColor: "rgba(200,240,60,0.12)" }]}>
          <Ionicons name={icon} size={18} color={tint} />
        </View>
        <View style={styles.fieldBody}>
          <Animated.Text
            pointerEvents="none"
            numberOfLines={1}
            style={[
              styles.floatLabel,
              {
                top: lift.interpolate({ inputRange: [0, 1], outputRange: [20, 9] }),
                fontSize: lift.interpolate({ inputRange: [0, 1], outputRange: [16, 11.5] }),
                color: error ? colors.red : focused ? colors.brand : colors.muted,
              },
            ]}
          >
            {label}
          </Animated.Text>
          <TextInput
            ref={ref}
            value={value}
            editable={editable}
            secureTextEntry={secure && hidden}
            placeholder={focused && !filled ? hint : undefined}
            placeholderTextColor={colors.subtle}
            accessibilityLabel={label}
            selectionColor={colors.brand}
            cursorColor={colors.brand}
            keyboardAppearance="dark"
            onFocus={(e) => {
              setFocused(true);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            style={styles.fieldInput}
            {...input}
          />
        </View>
        {secure && (
          <Pressable
            onPress={() => setHidden((h) => !h)}
            hitSlop={10}
            style={styles.fieldAction}
            accessibilityRole="button"
            accessibilityLabel={hidden ? "Afficher le mot de passe" : "Masquer le mot de passe"}
          >
            <Ionicons name={hidden ? "eye-outline" : "eye-off-outline"} size={20} color={colors.muted} />
          </Pressable>
        )}
        {right}
      </View>
      {!!error && (
        <Text style={styles.fieldError} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
    </View>
  );
}

/** Bouton principal : dégradé lime, halo, reflet qui passe de temps en temps, chargement. */
export function GlowButton({
  title, onPress, loading, loadingTitle, icon = "arrow-forward", animate = true,
}: { title: string; onPress: () => void; loading?: boolean; loadingTitle?: string; icon?: IconName | null; animate?: boolean }) {
  const [width, setWidth] = useState(0);
  const shine = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animate || !width || loading) return;
    shine.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(2600),
        Animated.timing(shine, { toValue: 1, duration: 950, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(shine, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, width, loading, shine]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={loading ? (loadingTitle ?? title) : title}
      accessibilityState={{ busy: !!loading, disabled: !!loading }}
      disabled={loading}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onPress={() => {
        if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => null);
        onPress();
      }}
      style={({ pressed }) => [styles.ctaWrap, { transform: [{ scale: pressed ? 0.975 : 1 }] }]}
    >
      <LinearGradient colors={["#DDFF6A", colors.brand, "#A4CF2A"]} locations={[0, 0.55, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cta}>
        {width > 0 && !loading && (
          <Animated.View
            pointerEvents="none"
            style={[styles.shine, { transform: [{ translateX: shine.interpolate({ inputRange: [0, 1], outputRange: [-120, width + 40] }) }, { skewX: "-22deg" }] }]}
          >
            <LinearGradient
              colors={["rgba(255,255,255,0)", "rgba(255,255,255,0.55)", "rgba(255,255,255,0)"]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        )}
        {loading ? (
          <View style={styles.ctaRow}>
            <ActivityIndicator color={colors.brandFg} />
            <Text style={styles.ctaText}>{loadingTitle ?? title}</Text>
          </View>
        ) : (
          <View style={styles.ctaRow}>
            <Text style={styles.ctaText}>{title}</Text>
            {icon && (
              <View style={styles.ctaIcon}>
                <Ionicons name={icon} size={17} color={colors.brand} />
              </View>
            )}
          </View>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** Lien texte (« Mot de passe oublié ? », « Renvoyer le lien »). */
export function TextLink({
  title, onPress, disabled, color = colors.brand, icon, align = "center",
}: { title: string; onPress: () => void; disabled?: boolean; color?: string; icon?: IconName; align?: "center" | "flex-end" | "flex-start" }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.textLink, { alignSelf: align, opacity: disabled ? 0.45 : pressed ? 0.6 : 1 }]}
    >
      {icon && <Ionicons name={icon} size={15} color={color} />}
      <Text style={[styles.textLinkText, { color }]}>{title}</Text>
    </Pressable>
  );
}

/** En-tête de panneau secondaire : retour + titre + sous-titre. */
export function PanelHeader({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack?: () => void }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={8} style={styles.back} accessibilityRole="button" accessibilityLabel="Retour à la connexion">
            <Ionicons name="chevron-back" size={20} color={colors.fg} />
          </Pressable>
        )}
        <Text style={styles.panelTitle} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {!!subtitle && <Text style={styles.panelSubtitle}>{subtitle}</Text>}
    </View>
  );
}

/** Message d'erreur / d'information dans la carte (icône, titre optionnel, texte). */
export function Notice({ tone = "error", title, message, icon }: { tone?: "error" | "warning" | "info"; title?: string; message: string; icon?: IconName }) {
  const tint = tone === "error" ? colors.red : tone === "warning" ? colors.amber : colors.blue;
  return (
    <EnterView from={6}>
      <View
        style={[styles.notice, { borderColor: `${tint}55`, backgroundColor: `${tint}14` }]}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
      >
        <Ionicons name={icon ?? (tone === "info" ? "information-circle" : "alert-circle")} size={22} color={tint} />
        <View style={{ flex: 1, gap: 2 }}>
          {!!title && <Text style={[styles.noticeTitle, { color: tint }]}>{title}</Text>}
          <Text style={styles.noticeText}>{message}</Text>
        </View>
      </View>
    </EnterView>
  );
}

const styles = StyleSheet.create({
  blip: { position: "absolute", width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  blipHalo: { position: "absolute", width: 20, height: 20, borderRadius: 10 },
  blipCore: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  logo: { alignItems: "center", justifyContent: "center", shadowColor: colors.brand, shadowOpacity: 0.45, shadowRadius: 22, shadowOffset: { width: 0, height: 0 } },
  pulseDot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  glass: {
    borderRadius: radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.09)",
    backgroundColor: Platform.OS === "android" ? "rgba(16,18,23,0.95)" : "rgba(13,15,19,0.6)",
  },
  glassSheen: { position: "absolute", left: 0, right: 0, top: 0, height: 90 },
  glassBody: { padding: 20, gap: 14 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    height: 62,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(8,9,12,0.55)",
    paddingLeft: 12,
    paddingRight: 8,
    gap: 12,
  },
  fieldFocused: {
    borderColor: "rgba(200,240,60,0.6)",
    backgroundColor: "rgba(200,240,60,0.04)",
    shadowColor: colors.brand,
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  fieldInvalid: { borderColor: `${colors.red}AA`, backgroundColor: `${colors.red}0D` },
  fieldIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.05)" },
  fieldBody: { flex: 1, alignSelf: "stretch", justifyContent: "center" },
  floatLabel: { position: "absolute", left: 0, right: 0, fontWeight: "600" },
  fieldInput: {
    height: 62, paddingTop: 22, paddingBottom: 6, paddingHorizontal: 0, color: colors.fg, fontSize: 16, fontWeight: "600",
    // Aperçu web : pas de contour de focus du navigateur (le champ entier s'illumine déjà)
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : null),
  },
  fieldAction: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  fieldError: { color: colors.red, fontSize: 13, fontWeight: "600", paddingHorizontal: 6 },
  ctaWrap: {
    borderRadius: 20,
    shadowColor: colors.brand,
    shadowOpacity: Platform.OS === "ios" ? 0.35 : 0,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  cta: { height: 60, borderRadius: 20, overflow: "hidden", alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  shine: { position: "absolute", top: -10, bottom: -10, left: 0, width: 70 },
  ctaRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  ctaText: { color: colors.brandFg, fontSize: 18, fontWeight: "900", letterSpacing: 0.2 },
  ctaIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandFg },
  textLink: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  textLinkText: { fontSize: 14, fontWeight: "700" },
  back: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.07)" },
  panelTitle: { flex: 1, color: colors.fg, fontSize: 22, fontWeight: "800", letterSpacing: -0.4 },
  panelSubtitle: { color: colors.muted, fontSize: 14.5, lineHeight: 21 },
  notice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1 },
  noticeTitle: { fontSize: 15, fontWeight: "900" },
  noticeText: { color: colors.fg, fontSize: 14.5, lineHeight: 20, fontWeight: "600" },
});
