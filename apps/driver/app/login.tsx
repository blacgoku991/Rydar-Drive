// Accès chauffeur : connexion, mot de passe oublié, inscription par le lien d'une centrale.
// Un seul écran : le radar tourne en fond, la carte vitrée change de contenu (pas de navigation).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect, router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Animated, BackHandler, Easing, Keyboard, KeyboardAvoidingView, LayoutAnimation, Platform, Pressable, StyleSheet, Text, View,
  useWindowDimensions, type TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AuthField, EnterView, GlassCard, GlowButton, LogoMark, Notice, PanelHeader, PulseDot, RadarScope, TextLink,
  useKeyboardVisible, useReduceMotion, useShake,
} from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { RadarPulse } from "@/components/radar";
import { hapticResult } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { parseJoinCode, requestPasswordReset, signIn, type ApiError } from "@/lib/api";
import { canReadText, readText } from "@/lib/clipboard";
import { colors } from "@/theme";

type Mode = "login" | "forgot" | "join";
type Failure = { message: string; code: string | null };

/** Dernière adresse utilisée (pré-remplie à la prochaine connexion). */
const LAST_EMAIL_KEY = "rydar.driver.lastEmail";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESEND_SECONDS = 60;
/** En dessous de cette hauteur (petit écran, clavier ouvert), l'en-tête ne garde que le logo. */
const HERO_FULL_MIN = 200;

/** Refus de connexion (codes de /api/auth/driver-login) : titre, icône et ton du message. */
const DENIED: Record<string, { title: string; icon: keyof typeof Ionicons.glyphMap; tone: "error" | "warning" }> = {
  BANNED: { title: "Compte banni", icon: "ban", tone: "error" },
  REJECTED: { title: "Candidature refusée", icon: "close-circle", tone: "error" },
  INACTIVE: { title: "Compte inactif", icon: "pause-circle", tone: "warning" },
  ORGANIZATION_SUSPENDED: { title: "Centrale suspendue", icon: "business", tone: "warning" },
  NOT_DRIVER: { title: "Compte non chauffeur", icon: "person-remove", tone: "warning" },
  RATE_LIMITED: { title: "Trop de tentatives", icon: "time", tone: "warning" },
  NETWORK: { title: "Pas de connexion", icon: "cloud-offline", tone: "warning" },
};

function emailProblem(email: string) {
  const e = email.trim();
  if (!e) return "Saisissez votre e-mail.";
  return EMAIL_RE.test(e) ? null : "Adresse e-mail invalide.";
}

function FailureNotice({ failure }: { failure: Failure }) {
  const denied = failure.code ? DENIED[failure.code] : undefined;
  return <Notice tone={denied?.tone ?? "error"} title={denied?.title} icon={denied?.icon} message={frTypo(failure.message)} />;
}

export default function Login() {
  const { session, ready, canDrive } = useDriver();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const keyboard = useKeyboardVisible();
  const card = useShake();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [heroHeight, setHeroHeight] = useState(0);
  const compact = keyboard || (heroHeight > 0 && heroHeight < HERO_FULL_MIN);
  const radarScale = useRef(new Animated.Value(1)).current;

  /** Changement de panneau (connexion ↔ mot de passe oublié ↔ inscription), hauteur animée. */
  function go(next: Mode) {
    Keyboard.dismiss();
    LayoutAnimation.configureNext(LayoutAnimation.create(260, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setMode(next);
  }

  useEffect(() => {
    AsyncStorage.getItem(LAST_EMAIL_KEY)
      .then((saved) => saved && setEmail((current) => current || saved))
      .catch(() => null);
  }, []);

  useEffect(() => {
    Animated.timing(radarScale, { toValue: compact ? 0.62 : 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [compact, radarScale]);

  // Android : le bouton retour ramène à la connexion au lieu de quitter l'application
  useEffect(() => {
    if (mode === "login" || Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      go("login");
      return true;
    });
    return () => sub.remove();
  }, [mode]);

  // Connecté et état du compte connu : accueil, ou écran d'attente / de blocage
  if (session && ready) return <Redirect href={canDrive ? "/home" : "/account"} />;

  const logo = compact ? 58 : 92;
  const radarSize = Math.round(Math.min(Math.max(width * 1.35, 440), 640));
  return (
    <View style={styles.screen}>
      <LinearGradient colors={[colors.bg, colors.bgDeep]} style={StyleSheet.absoluteFill} />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={[styles.column, { paddingTop: insets.top + 10, paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 18) }]}>
          {/* En-tête : radar centré sur le logo (déborde derrière la carte), nom, badge */}
          <View style={styles.hero} onLayout={(e) => setHeroHeight(e.nativeEvent.layout.height)}>
            <EnterView animate={!reduceMotion} from={-8} style={{ alignItems: "center" }}>
              <View style={{ width: logo, height: logo, alignItems: "center", justifyContent: "center" }}>
                <Animated.View
                  pointerEvents="none"
                  style={{ position: "absolute", width: radarSize, height: radarSize, left: (logo - radarSize) / 2, top: (logo - radarSize) / 2, transform: [{ scale: radarScale }] }}
                >
                  <RadarScope size={radarSize} animate={!reduceMotion} />
                </Animated.View>
                <LogoMark size={logo} />
              </View>
              {!compact && (
                <View style={styles.brandBlock}>
                  <Text style={styles.wordmark} accessibilityRole="header">
                    Rydar<Text style={styles.wordmarkLight}> Drive</Text>
                  </Text>
                  <View style={styles.kicker}>
                    <PulseDot animate={!reduceMotion} />
                    <Text style={styles.kickerText}>ESPACE CHAUFFEUR</Text>
                  </View>
                </View>
              )}
            </EnterView>
          </View>

          <View>
            {/* Fondu sous la carte : le radar s'efface vers le bas */}
            <LinearGradient pointerEvents="none" colors={["rgba(6,7,9,0)", "rgba(6,7,9,0.92)"]} locations={[0, 0.45]} style={styles.bottomFade} />
            <EnterView animate={!reduceMotion} delay={140} from={28}>
              <Animated.View style={card.style}>
                <GlassCard>
                  {mode === "login" ? (
                    <LoginPanel key="login" email={email} setEmail={setEmail} onForgot={() => go("forgot")} onFail={card.shake} animate={!reduceMotion} />
                  ) : mode === "forgot" ? (
                    <ForgotPanel key="forgot" email={email} setEmail={setEmail} onBack={() => go("login")} onFail={card.shake} animate={!reduceMotion} />
                  ) : (
                    <JoinPanel key="join" onBack={() => go("login")} onFail={card.shake} animate={!reduceMotion} />
                  )}
                </GlassCard>
              </Animated.View>
            </EnterView>
            {mode === "login" && !keyboard && (
              <EnterView animate={!reduceMotion} delay={260}>
                <Pressable onPress={() => go("join")} style={({ pressed }) => [styles.joinRow, pressed && { opacity: 0.6 }]} accessibilityRole="button" hitSlop={6}>
                  <Text style={styles.joinMuted}>Nouveau chauffeur ?</Text>
                  <Text style={styles.joinLink}>Rejoindre une centrale</Text>
                  <Ionicons name="arrow-forward" size={15} color={colors.brand} />
                </Pressable>
              </EnterView>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

type PanelProps = { onFail: () => void; animate: boolean };

function LoginPanel({ email, setEmail, onForgot, onFail, animate }: PanelProps & { email: string; setEmail: (v: string) => void; onForgot: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [invalid, setInvalid] = useState<{ email?: string | null; password?: string | null }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const passwordRef = useRef<TextInput>(null);

  async function submit() {
    const problems = { email: emailProblem(email), password: password ? null : "Saisissez votre mot de passe." };
    setInvalid(problems);
    setFailure(null);
    if (problems.email || problems.password) {
      onFail();
      if (!problems.email) passwordRef.current?.focus();
      return;
    }
    Keyboard.dismiss();
    setLoading(true);
    try {
      await signIn(email, password);
      hapticResult(true);
      AsyncStorage.setItem(LAST_EMAIL_KEY, email.trim().toLowerCase()).catch(() => null);
      // Redirection dès que l'état du compte est lu (bouton en attente jusque-là)
    } catch (e) {
      setFailure({ message: (e as Error).message, code: (e as ApiError).code ?? null });
      setLoading(false);
      onFail();
    }
  }

  return (
    <EnterView animate={animate} from={10} style={{ gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Text style={styles.title} accessibilityRole="header">Bienvenue à bord</Text>
        <Text style={styles.subtitle}>Connectez-vous avec les identifiants de votre centrale.</Text>
      </View>
      <AuthField
        label="E-mail"
        icon="mail-outline"
        hint="vous@exemple.fr"
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          if (invalid.email) setInvalid((p) => ({ ...p, email: null }));
        }}
        error={invalid.email}
        editable={!loading}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
        keyboardType="email-address"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      <View style={{ gap: 8 }}>
        <AuthField
          ref={passwordRef}
          label="Mot de passe"
          icon="lock-closed-outline"
          secure
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            if (invalid.password) setInvalid((p) => ({ ...p, password: null }));
          }}
          error={invalid.password}
          editable={!loading}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <TextLink title="Mot de passe oublié ?" onPress={onForgot} align="flex-end" disabled={loading} />
      </View>
      {failure && <FailureNotice failure={failure} />}
      <GlowButton title="Se connecter" loadingTitle="Connexion…" onPress={submit} loading={loading} animate={animate} />
    </EnterView>
  );
}

function ForgotPanel({ email, setEmail, onBack, onFail, animate }: PanelProps & { email: string; setEmail: (v: string) => void; onBack: () => void }) {
  const [loading, setLoading] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send() {
    const problem = emailProblem(email);
    setInvalid(problem);
    setFailure(null);
    if (problem) {
      onFail();
      return;
    }
    Keyboard.dismiss();
    setLoading(true);
    try {
      const target = email.trim().toLowerCase();
      await requestPasswordReset(target);
      hapticResult(true);
      setSentTo(target);
      setCooldown(RESEND_SECONDS);
    } catch (e) {
      setFailure({ message: (e as Error).message, code: (e as ApiError).code ?? null });
      onFail();
    } finally {
      setLoading(false);
    }
  }

  if (sentTo) {
    return (
      <EnterView animate={animate} from={10} style={{ gap: 16 }}>
        <View style={styles.mailBadgeWrap}>
          <RadarPulse size={128} rings={2} active={animate} />
          <View style={styles.mailBadge}>
            <Ionicons name="mail-unread-outline" size={30} color={colors.brand} />
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Text style={[styles.title, { textAlign: "center" }]} accessibilityRole="header">Vérifiez vos e-mails</Text>
          <Text style={[styles.subtitle, { textAlign: "center" }]}>
            Si un compte chauffeur existe pour <Text style={styles.strong}>{sentTo}</Text>, un lien vient de partir. Ouvrez-le sur ce téléphone,
            choisissez un nouveau mot de passe, puis revenez vous connecter.
          </Text>
        </View>
        <View style={styles.tip}>
          <Ionicons name="information-circle-outline" size={18} color={colors.muted} />
          <Text style={styles.tipText}>Rien reçu ? Regardez dans les courriers indésirables, ou contactez votre centrale.</Text>
        </View>
        {failure && <FailureNotice failure={failure} />}
        <GlowButton title="Retour à la connexion" icon="log-in-outline" onPress={onBack} animate={animate} />
        <TextLink
          title={loading ? "Envoi…" : cooldown > 0 ? `Renvoyer le lien dans ${cooldown} s` : "Renvoyer le lien"}
          icon="refresh"
          onPress={send}
          disabled={loading || cooldown > 0}
          color={colors.muted}
        />
      </EnterView>
    );
  }

  return (
    <EnterView animate={animate} from={10} style={{ gap: 14 }}>
      <PanelHeader
        title="Mot de passe oublié"
        subtitle="Indiquez l'e-mail de votre compte chauffeur : vous recevrez un lien pour choisir un nouveau mot de passe."
        onBack={onBack}
      />
      <AuthField
        label="E-mail"
        icon="mail-outline"
        hint="vous@exemple.fr"
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          if (invalid) setInvalid(null);
        }}
        error={invalid}
        editable={!loading}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
        keyboardType="email-address"
        returnKeyType="send"
        onSubmitEditing={send}
      />
      {failure && <FailureNotice failure={failure} />}
      <GlowButton title="Envoyer le lien" loadingTitle="Envoi…" icon="paper-plane" onPress={send} loading={loading} animate={animate} />
    </EnterView>
  );
}

function JoinPanel({ onBack, onFail, animate }: PanelProps & { onBack: () => void }) {
  const [link, setLink] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const code = parseJoinCode(link);
  const [pasteAvailable] = useState(canReadText);

  function next() {
    if (!code) {
      setInvalid(link.trim() ? "Lien non reconnu : copiez le lien complet envoyé par la centrale." : "Collez le lien reçu de votre centrale.");
      onFail();
      return;
    }
    Keyboard.dismiss();
    router.push(`/rejoindre/${code}`);
  }

  async function paste() {
    const text = await readText();
    if (!text) return;
    setLink(text.trim());
    setInvalid(null);
  }

  return (
    <EnterView animate={animate} from={10} style={{ gap: 14 }}>
      <PanelHeader
        title="Rejoindre une centrale"
        subtitle="Collez le lien d'inscription envoyé par votre centrale (WhatsApp, SMS, e-mail)."
        onBack={onBack}
      />
      <AuthField
        label="Lien d'inscription"
        icon="link-outline"
        hint="https://…/rejoindre/…"
        value={link}
        onChangeText={(v) => {
          setLink(v);
          if (invalid) setInvalid(null);
        }}
        error={invalid}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={next}
        right={
          pasteAvailable && !link ? (
            <Pressable onPress={paste} hitSlop={6} style={({ pressed }) => [styles.pasteBtn, pressed && { opacity: 0.6 }]} accessibilityRole="button" accessibilityLabel="Coller le lien">
              <Ionicons name="clipboard-outline" size={15} color={colors.brand} />
              <Text style={styles.pasteText}>Coller</Text>
            </Pressable>
          ) : null
        }
      />
      {code && (
        <View style={styles.recognized}>
          <Ionicons name="checkmark-circle" size={16} color={colors.brand} />
          <Text style={styles.recognizedText}>Lien reconnu</Text>
        </View>
      )}
      <GlowButton title="Continuer" onPress={next} animate={animate} />
      <View style={styles.tip}>
        <Ionicons name="flash-outline" size={18} color={colors.muted} />
        <Text style={styles.tipText}>Astuce : touchez directement le lien reçu, il ouvre l&apos;inscription dans l&apos;application.</Text>
      </View>
    </EnterView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDeep },
  column: { flex: 1, paddingHorizontal: 18 },
  hero: { flex: 1, minHeight: 72, alignItems: "center", justifyContent: "center" },
  brandBlock: { alignItems: "center", gap: 12, marginTop: 20 },
  wordmark: { color: colors.fg, fontSize: 36, fontWeight: "900", letterSpacing: -1.2 },
  wordmarkLight: { color: colors.muted, fontWeight: "300", letterSpacing: -0.8 },
  kicker: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99,
    borderWidth: 1, borderColor: "rgba(200,240,60,0.25)", backgroundColor: "rgba(200,240,60,0.06)",
  },
  kickerText: { color: colors.brand, fontSize: 11, fontWeight: "800", letterSpacing: 2.2 },
  bottomFade: { position: "absolute", left: -18, right: -18, top: 0, bottom: -40 },
  title: { color: colors.fg, fontSize: 25, fontWeight: "900", letterSpacing: -0.6 },
  subtitle: { color: colors.muted, fontSize: 14.5, lineHeight: 21 },
  strong: { color: colors.fg, fontWeight: "800" },
  joinRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16, paddingVertical: 6 },
  joinMuted: { color: colors.muted, fontSize: 14 },
  joinLink: { color: colors.brand, fontSize: 14, fontWeight: "800" },
  mailBadgeWrap: { height: 128, alignItems: "center", justifyContent: "center" },
  mailBadge: {
    width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: "rgba(200,240,60,0.5)", backgroundColor: "rgba(200,240,60,0.08)",
  },
  tip: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.04)" },
  tipText: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 19 },
  pasteBtn: {
    flexDirection: "row", alignItems: "center", gap: 5, height: 34, paddingHorizontal: 10, borderRadius: 12,
    backgroundColor: "rgba(200,240,60,0.1)", marginRight: 4,
  },
  pasteText: { color: colors.brand, fontSize: 13, fontWeight: "800" },
  recognized: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -4, paddingHorizontal: 6 },
  recognizedText: { color: colors.brand, fontSize: 13, fontWeight: "700" },
});
