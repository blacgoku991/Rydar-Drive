// Briques des écrans d'accès (connexion, mot de passe oublié, inscription par lien) : champ à libellé au-dessus,
// défilement qui garde le champ actif et le bouton au-dessus du clavier, message d'erreur, logo.
// Sobre : ni lueur, ni flou, ni dégradé, ni animation en boucle ; mouvements coupés si « Réduire les animations ».
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo, Animated, Easing, Keyboard, KeyboardAvoidingView, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, Text,
  TextInput, View, type KeyboardEvent, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

export type IconName = keyof typeof Ionicons.glyphMap;

/** Agrandissement maximal du texte (réglage « Taille du texte ») : titres et champs restent dans leur cadre. */
export const TITLE_SCALE = 1.3;
export const TEXT_SCALE = 1.5;
const INPUT_SCALE = 1.4;

/** « Réduire les animations » (iOS / Android / navigateur). */
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

/** Annonce vocale (lecteur d'écran) : erreurs, envoi du code, connexion en cours. */
export function announce(message: string) {
  try {
    if (typeof AccessibilityInfo.announceForAccessibility === "function") AccessibilityInfo.announceForAccessibility(message);
  } catch {
    /* pas de lecteur d'écran sur cette plateforme */
  }
}

/** Changement de contenu du panneau (connexion ↔ mot de passe oublié ↔ inscription) : fondu court, sauf mouvements réduits. */
export function panelTransition(animate: boolean) {
  if (animate) LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
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

/** Saisie refusée : vibration d'erreur, et courte secousse du panneau sauf si les animations sont réduites. */
export function useShake(reduceMotion: boolean) {
  const x = useRef(new Animated.Value(0)).current;
  const shake = useCallback(() => {
    if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => null);
    if (reduceMotion) return;
    x.setValue(0);
    Animated.sequence([8, -8, 5, -5, 2, 0].map((toValue) => Animated.timing(x, { toValue, duration: 45, useNativeDriver: true }))).start();
  }, [x, reduceMotion]);
  return { shake, style: { transform: [{ translateX: x }] } };
}

/** Apparition (fondu + léger glissement) au montage : panneau d'accès, changement de panneau. */
export function EnterView({
  children, delay = 0, from = 8, duration = 220, animate = true, style,
}: { children: React.ReactNode; delay?: number; from?: number; duration?: number; animate?: boolean; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (!animate) {
      v.setValue(1);
      return;
    }
    const anim = Animated.timing(v, { toValue: 1, duration, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [animate, delay, duration, v]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/** Pictogramme décoratif : ignoré par le lecteur d'écran (le libellé voisin suffit). */
export function Glyph({ name, size = 20, color = colors.muted }: { name: IconName; size?: number; color?: string }) {
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Ionicons name={name} size={size} color={color} />
    </View>
  );
}

/** Logo Rydar (anneaux + point, comme l'icône de l'app), statique. */
export function LogoMark({ size }: { size: number }) {
  return (
    <View style={{ width: size, height: size }} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Circle cx={50} cy={50} r={46} fill={colors.bgDeep} stroke={colors.brand} strokeWidth={6} />
        <Circle cx={50} cy={50} r={28} fill="none" stroke={colors.brand} strokeOpacity={0.5} strokeWidth={4} />
        <Circle cx={50} cy={50} r={10} fill={colors.brand} />
      </Svg>
    </View>
  );
}

// --- Défilement du formulaire ----------------------------------------------------------------------

/** Champ qui prend le focus → FormScroll le fait apparaître au-dessus du clavier. */
const RevealContext = createContext<((node: View | null) => void) | null>(null);

/**
 * Conteneur des écrans d'accès : KeyboardAvoidingView + ScrollView. Le contenu occupe au moins tout l'écran
 * (flexGrow) ; clavier ouvert, il défile : jusqu'au bas du formulaire (bouton visible) tant que le champ
 * actif reste visible, sinon jusqu'à ce champ. Toucher hors d'un champ ferme le clavier.
 */
export function FormScroll({ children }: { children: React.ReactNode }) {
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const focused = useRef<View | null>(null);
  const sizes = useRef({ content: 0, viewport: 0 });
  const keyboardUp = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reveal = useCallback(() => {
    const s = scroll.current;
    if (!s) return;
    const end = Math.max(0, sizes.current.content - sizes.current.viewport);
    const node = focused.current;
    if (!node || !content.current) {
      s.scrollToEnd({ animated: true });
      return;
    }
    node.measureLayout(
      content.current,
      (_x, y) => s.scrollTo({ y: Math.min(end, Math.max(0, y - space.md)), animated: true }),
      () => s.scrollToEnd({ animated: true }),
    );
  }, []);

  const schedule = useCallback(
    (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reveal, delay);
    },
    [reveal],
  );

  useEffect(() => {
    // Après l'animation du clavier (hauteur disponible à jour)
    const show = Keyboard.addListener("keyboardDidShow", () => {
      keyboardUp.current = true;
      schedule(60);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardUp.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [schedule]);

  const onFieldFocus = useCallback(
    (node: View | null) => {
      focused.current = node;
      // Passage d'un champ à l'autre, clavier déjà ouvert
      if (keyboardUp.current) schedule(0);
    },
    [schedule],
  );

  return (
    <RevealContext.Provider value={onFieldFocus}>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          ref={scroll}
          style={styles.fill}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          showsVerticalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
          onLayout={(e) => {
            sizes.current.viewport = e.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_w, h) => {
            sizes.current.content = h;
          }}
        >
          <View ref={content} collapsable={false} style={styles.scrollContent}>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </RevealContext.Provider>
  );
}

// --- Champ ---------------------------------------------------------------------------------------

type AuthFieldProps = Omit<TextInputProps, "style" | "placeholder"> & {
  label: string;
  icon: IconName;
  /** Exemple affiché dans le champ vide pendant la saisie. */
  hint?: string;
  /** Aide sous le champ (remplacée par l'erreur). */
  help?: string | null;
  error?: string | null;
  /** Mot de passe : masqué, avec bouton « afficher ». */
  secure?: boolean;
  right?: React.ReactNode;
  inputStyle?: StyleProp<TextStyle>;
  ref?: React.Ref<TextInput>;
};

/**
 * Champ de formulaire : libellé au-dessus (lu une seule fois : c'est le nom du champ pour le lecteur d'écran),
 * cadre de 56 px dont toute la surface donne le focus, bordure lime au focus, rouge en erreur, œil pour les
 * mots de passe. L'erreur s'affiche sous le champ et fait partie de sa description vocale.
 */
export function AuthField({
  label, icon, hint, help, error, secure, right, inputStyle, value, onFocus, onBlur, editable = true, keyboardType, ref, ...input
}: AuthFieldProps) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const inner = useRef<TextInput | null>(null);
  const wrap = useRef<View>(null);
  const onReveal = useContext(RevealContext);
  const setRef = useCallback(
    (node: TextInput | null) => {
      inner.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.RefObject<TextInput | null>).current = node;
    },
    [ref],
  );
  const border = error ? colors.red : focused ? colors.brand : colors.lineStrong;
  const note = error || help;
  return (
    <View ref={wrap} collapsable={false} style={styles.fieldWrap}>
      <Text style={styles.fieldLabel} maxFontSizeMultiplier={TEXT_SCALE} accessible={false} accessibilityElementsHidden importantForAccessibility="no">
        {label}
      </Text>
      <Pressable
        accessible={false}
        disabled={!editable}
        onPress={() => inner.current?.focus()}
        style={[styles.field, { borderColor: border }, !editable && styles.fieldDisabled]}
      >
        <Glyph name={icon} size={20} />
        <TextInput
          ref={setRef}
          value={value}
          editable={editable}
          secureTextEntry={secure && hidden}
          // Android : mot de passe affiché → clavier sans suggestions ni mémorisation
          keyboardType={secure && !hidden && Platform.OS === "android" ? "visible-password" : keyboardType}
          placeholder={focused && !value ? hint : undefined}
          placeholderTextColor={colors.muted}
          accessibilityLabel={label}
          accessibilityHint={error ?? help ?? undefined}
          accessibilityState={{ disabled: !editable }}
          maxFontSizeMultiplier={INPUT_SCALE}
          selectionColor={colors.brand}
          cursorColor={colors.brand}
          keyboardAppearance="dark"
          onFocus={(e) => {
            setFocused(true);
            onReveal?.(wrap.current);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, inputStyle]}
          {...input}
        />
        {secure && (
          <Pressable
            onPress={() => setHidden((h) => !h)}
            style={({ pressed }) => [styles.fieldAction, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={hidden ? "Afficher le mot de passe" : "Masquer le mot de passe"}
          >
            <Glyph name={hidden ? "eye-outline" : "eye-off-outline"} size={22} />
          </Pressable>
        )}
        {right}
      </Pressable>
      {!!note && (
        // Déjà lu avec le champ (accessibilityHint) : masqué au lecteur d'écran pour ne pas l'entendre deux fois
        <Text
          style={[styles.fieldNote, !!error && styles.fieldError]}
          maxFontSizeMultiplier={TEXT_SCALE}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {note}
        </Text>
      )}
    </View>
  );
}

// --- Liens, en-têtes, messages -------------------------------------------------------------------

/**
 * Lien texte (« Mot de passe oublié ? », « Renvoyer le code ») : cible de 48 px, désactivé en gris lisible.
 * role « link » : page ouverte dans le navigateur (conditions d'utilisation, confidentialité).
 */
export function TextLink({
  title, onPress, disabled, muted, icon, align = "center", accessibilityLabel, role = "button",
}: {
  title: string; onPress: () => void; disabled?: boolean; muted?: boolean; icon?: IconName;
  align?: "center" | "flex-end" | "flex-start"; accessibilityLabel?: string; role?: "button" | "link";
}) {
  const color = disabled || muted ? colors.muted : colors.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.textLink, { alignSelf: align }, pressed && styles.pressed]}
    >
      {icon && <Glyph name={icon} size={18} color={color} />}
      <Text style={[styles.textLinkText, { color }]} maxFontSizeMultiplier={TEXT_SCALE}>
        {title}
      </Text>
    </Pressable>
  );
}

/** En-tête de panneau secondaire : retour + titre ; sous-titre masqué clavier ouvert (compact). */
export function PanelHeader({ title, subtitle, onBack, compact }: { title: string; subtitle?: React.ReactNode; onBack?: () => void; compact?: boolean }) {
  return (
    <View style={styles.panelHeader}>
      <View style={styles.panelHeaderRow}>
        {onBack && (
          <Pressable
            onPress={onBack}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Retour à la connexion"
          >
            <Glyph name="chevron-back" size={22} color={colors.fg} />
          </Pressable>
        )}
        <Text style={styles.panelTitle} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
          {title}
        </Text>
      </View>
      {!!subtitle && !compact && (
        <Text style={styles.panelSubtitle} maxFontSizeMultiplier={TEXT_SCALE}>
          {subtitle}
        </Text>
      )}
    </View>
  );
}

/**
 * Message d'erreur ou d'information dans le panneau : pictogramme et titre de la couleur de l'état,
 * texte en clair sur fond neutre. Annoncé au lecteur d'écran à l'affichage.
 */
export function Notice({ tone = "error", title, message, icon }: { tone?: "error" | "warning" | "info"; title?: string; message: string; icon?: IconName }) {
  const tint = tone === "error" ? colors.red : tone === "warning" ? colors.amber : colors.blue;
  useEffect(() => {
    announce(title ? `${title}. ${message}` : message);
  }, [title, message]);
  return (
    <View style={styles.notice} accessibilityRole="alert">
      <Glyph name={icon ?? (tone === "info" ? "information-circle-outline" : "alert-circle-outline")} size={20} color={tint} />
      <View style={styles.noticeBody}>
        {!!title && (
          <Text style={[styles.noticeTitle, { color: tint }]} maxFontSizeMultiplier={TEXT_SCALE}>
            {title}
          </Text>
        )}
        <Text style={styles.noticeText} maxFontSizeMultiplier={TEXT_SCALE}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  pressed: { opacity: 0.6 },
  fieldWrap: { gap: space.sm },
  fieldLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  field: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: control.md,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.bg,
    paddingLeft: space.lg,
    gap: space.md,
  },
  fieldDisabled: { opacity: 0.6 },
  input: {
    flex: 1,
    alignSelf: "stretch",
    minHeight: control.md - 2,
    paddingVertical: 0,
    paddingHorizontal: 0,
    paddingRight: space.lg,
    color: colors.fg,
    fontSize: type.callout,
    fontWeight: weight.medium,
    // Aperçu web : pas de contour de focus du navigateur (la bordure du champ l'indique déjà)
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : null),
  },
  fieldAction: { width: control.sm, height: control.sm, alignItems: "center", justifyContent: "center", marginRight: space.xs, borderRadius: radius.md },
  fieldNote: { color: colors.muted, fontSize: type.footnote, lineHeight: 18 },
  fieldError: { color: colors.red, fontWeight: weight.medium },
  textLink: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: control.sm, paddingHorizontal: space.xs },
  textLinkText: { fontSize: type.body, fontWeight: weight.semibold, ...mono },
  panelHeader: { gap: space.sm },
  panelHeaderRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  back: {
    width: control.sm, height: control.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surface2, marginLeft: -space.xs,
  },
  panelTitle: { flex: 1, color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3 },
  panelSubtitle: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  notice: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 14,
    borderRadius: radius.md, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  noticeBody: { flex: 1, gap: 2 },
  noticeTitle: { fontSize: type.body, fontWeight: weight.semibold },
  noticeText: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
});
