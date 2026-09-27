// Accès chauffeur : connexion, mot de passe oublié (code reçu par e-mail), inscription par le lien d'une centrale.
// Un seul écran : la carte de la ville en fond (statique, non interactive), un panneau opaque en bas dont le
// contenu change (pas de navigation).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN } from "@rydar/shared";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, BackHandler, Keyboard, Linking, Platform, Pressable, StyleSheet, Text, View, type TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  announce, AuthField, EnterView, FormScroll, Glyph, LogoMark, Notice, PanelHeader, panelTransition, TEXT_SCALE, TextLink, TITLE_SCALE,
  useKeyboardVisible, useReduceMotion, useShake, type IconName,
} from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { RydarMap } from "@/components/map/rydar-map";
import { BigButton, hapticResult } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { confirmPasswordReset, LAST_EMAIL_KEY, legalUrl, parseJoinCode, requestPasswordReset, signIn, type ApiError } from "@/lib/api";
import { canReadText, readText } from "@/lib/clipboard";
import { alpha, colors, control, mono, radius, space, type, weight } from "@/theme";

type Mode = "login" | "forgot" | "join";
type Failure = { message: string; code: string | null };

/** Conditions d'utilisation et politique de confidentialité (exigées par les stores, accessibles sans compte). */
const CGU_URL = legalUrl("cgu");
const PRIVACY_URL = legalUrl("confidentialite");
/** Espace insécable avant « ? : ; ! » (typographie française). */
const NB = " ";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Délai avant de pouvoir redemander un code (Supabase n'envoie pas deux e-mails de suite plus vite). */
const RESEND_SECONDS = 60;
const NETWORK_MESSAGE = "Vérifiez votre connexion internet (4G ou Wi-Fi), puis réessayez.";

/** Refus et erreurs serveur (codes de /api/auth/driver-login et de la réinitialisation) : titre, pictogramme, ton. */
const DENIED: Record<string, { title: string; icon: IconName; tone: "error" | "warning" }> = {
  BANNED: { title: "Compte banni", icon: "ban-outline", tone: "error" },
  REJECTED: { title: "Candidature refusée", icon: "close-circle-outline", tone: "error" },
  INACTIVE: { title: "Compte inactif", icon: "pause-circle-outline", tone: "warning" },
  ORGANIZATION_SUSPENDED: { title: "Centrale suspendue", icon: "business-outline", tone: "warning" },
  NOT_DRIVER: { title: "Compte non chauffeur", icon: "person-remove-outline", tone: "warning" },
  RATE_LIMITED: { title: "Trop de tentatives", icon: "time-outline", tone: "warning" },
  NETWORK: { title: "Pas de connexion", icon: "cloud-offline-outline", tone: "warning" },
  SAME_PASSWORD: { title: "Mot de passe inchangé", icon: "key-outline", tone: "warning" },
  WEAK_PASSWORD: { title: "Mot de passe refusé", icon: "key-outline", tone: "warning" },
  PASSWORD_UPDATE_FAILED: { title: "Mot de passe non enregistré", icon: "key-outline", tone: "error" },
};

/**
 * Connexion refusée à un compte qui existe toujours (banni, inactif, centrale suspendue, candidature refusée) : la
 * suppression du compte reste possible sans session, par e-mail et mot de passe (écran /delete-account).
 */
const DELETABLE = new Set(["BANNED", "INACTIVE", "ORGANIZATION_SUSPENDED", "REJECTED"]);

/** Code valable mais mot de passe refusé : le code a été consommé par le serveur. */
const CODE_USED_HINT: Record<string, string> = {
  SAME_PASSWORD: "Ce code a déjà servi : connectez-vous avec ce mot de passe, ou demandez un nouveau code.",
  WEAK_PASSWORD: "Ce code a déjà servi : demandez-en un nouveau.",
  PASSWORD_UPDATE_FAILED: "",
};

function emailProblem(email: string) {
  const e = email.trim();
  if (!e) return "Saisissez votre e-mail.";
  return EMAIL_RE.test(e) ? null : "Adresse e-mail invalide.";
}

function failureOf(e: unknown): Failure {
  return { message: (e as Error).message, code: (e as ApiError).code ?? null };
}

function FailureNotice({ failure }: { failure: Failure }) {
  const denied = failure.code ? DENIED[failure.code] : undefined;
  const message = failure.code === "NETWORK" ? NETWORK_MESSAGE : failure.message;
  return <Notice tone={denied?.tone ?? "error"} title={denied?.title} icon={denied?.icon} message={frTypo(message)} />;
}

export default function Login() {
  const { session, ready, canDrive, restoring } = useDriver();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const keyboard = useKeyboardVisible();
  const panel = useShake(reduceMotion);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  /** Panneau déjà changé une fois : au premier affichage, seul le panneau entier apparaît (pas de double animation). */
  const [switched, setSwitched] = useState(false);
  const animate = !reduceMotion;

  /** Changement de panneau (connexion ↔ mot de passe oublié ↔ inscription). */
  const go = useCallback(
    (next: Mode) => {
      Keyboard.dismiss();
      panelTransition(animate);
      setSwitched(true);
      setMode(next);
    },
    [animate],
  );

  useEffect(() => {
    AsyncStorage.getItem(LAST_EMAIL_KEY)
      .then((saved) => saved && setEmail((current) => current || saved))
      .catch(() => null);
  }, []);

  // Android : « retour » ramène à la connexion au lieu de quitter l'application. Seulement quand cet écran a
  // le focus : depuis /rejoindre (empilé au-dessus), le retour revient normalement ici.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android" || mode === "login") return undefined;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        go("login");
        return true;
      });
      return () => sub.remove();
    }, [mode, go]),
  );

  // Connecté et état du compte connu : accueil, ou écran d'attente / de blocage
  if (session && ready) return <Redirect href={canDrive ? "/home" : "/account"} />;

  const compact = keyboard;
  const panelProps = { compact, animate: animate && switched, onFail: panel.shake };
  return (
    <View style={styles.screen}>
      {/* Fond : carte de la ville, figée, sous un voile sombre (lisibilité du logo et du panneau) */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <RydarMap />
        <LinearGradient
          colors={[alpha(colors.bgDeep, 0.88), alpha(colors.bgDeep, 0.3), alpha(colors.bgDeep, 0.3), alpha(colors.bgDeep, 0.96)]}
          locations={[0, 0.18, 0.55, 0.85]}
          style={StyleSheet.absoluteFill}
        />
      </View>

      <FormScroll>
        <View style={[styles.brandRow, { paddingTop: insets.top + (compact ? space.sm : space.lg) }]}>
          <LogoMark size={compact ? 28 : 40} />
          <Text style={[styles.brand, compact && styles.brandCompact]} maxFontSizeMultiplier={TITLE_SCALE}>
            Rydar Drive
          </Text>
        </View>

        <View style={{ flex: 1, minHeight: compact ? space.lg : 96 }} />

        <EnterView animate={animate} from={24} duration={320} style={styles.panelWrap}>
          <Animated.View style={[styles.panel, { paddingBottom: compact ? space.lg : Math.max(insets.bottom, space.lg) + space.sm }, panel.style]}>
            {restoring && !session ? (
              <RestoringPanel animate={animate} />
            ) : mode === "login" ? (
              <LoginPanel key="login" {...panelProps} email={email} setEmail={setEmail} onForgot={() => go("forgot")} onJoin={() => go("join")} />
            ) : mode === "forgot" ? (
              <ForgotPanel key="forgot" {...panelProps} email={email} setEmail={setEmail} onBack={() => go("login")} />
            ) : (
              <JoinPanel key="join" {...panelProps} onBack={() => go("login")} />
            )}
          </Animated.View>
        </EnterView>
      </FormScroll>
    </View>
  );
}

type PanelProps = { compact: boolean; animate: boolean; onFail: () => void };

// --- Session gardée sur le téléphone, pas encore rétablie (lancement hors réseau, jeton à renouveler) ---------------

function RestoringPanel({ animate }: { animate: boolean }) {
  return (
    <EnterView animate={animate} style={styles.panelBody}>
      <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
        Reconnexion
      </Text>
      <Notice
        tone="warning"
        title="Pas de connexion"
        icon="cloud-offline-outline"
        message={frTypo("Vous restez connecté : votre session sera rétablie dès le retour du réseau (4G ou Wi-Fi).")}
      />
    </EnterView>
  );
}

// --- Connexion -----------------------------------------------------------------------------------

function LoginPanel({
  email, setEmail, onForgot, onJoin, compact, animate, onFail,
}: PanelProps & { email: string; setEmail: (v: string) => void; onForgot: () => void; onJoin: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [invalid, setInvalid] = useState<{ email?: string | null; password?: string | null }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const passwordRef = useRef<TextInput>(null);

  async function submit() {
    if (loading) return;
    const problems = { email: emailProblem(email), password: password ? null : "Saisissez votre mot de passe." };
    setInvalid(problems);
    setFailure(null);
    const first = problems.email ?? problems.password;
    if (first) {
      onFail();
      announce(first);
      if (!problems.email) passwordRef.current?.focus();
      return;
    }
    Keyboard.dismiss();
    setLoading(true);
    announce("Connexion en cours");
    try {
      await signIn(email, password);
      hapticResult(true);
      AsyncStorage.setItem(LAST_EMAIL_KEY, email.trim().toLowerCase()).catch(() => null);
      // Redirection dès que l'état du compte est lu (bouton en attente jusque-là)
    } catch (e) {
      setFailure(failureOf(e));
      setLoading(false);
      onFail();
    }
  }

  return (
    <EnterView animate={animate} style={styles.panelBody}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
          Connexion
        </Text>
        {!compact && (
          <Text style={styles.lead} maxFontSizeMultiplier={TEXT_SCALE}>
            Identifiants fournis par votre centrale.
          </Text>
        )}
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

      <View>
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
          submitBehavior="blurAndSubmit"
          onSubmitEditing={submit}
        />
        <TextLink title={`Mot de passe oublié${NB}?`} onPress={onForgot} align="flex-end" disabled={loading} />
      </View>

      {failure && <FailureNotice failure={failure} />}
      {failure?.code && DELETABLE.has(failure.code) && (
        <TextLink
          title="Supprimer mon compte"
          icon="trash-outline"
          muted
          disabled={loading}
          onPress={() => router.push({ pathname: "/delete-account", params: { email: email.trim().toLowerCase() } })}
        />
      )}

      <BigButton title="Se connecter" onPress={submit} loading={loading} height={control.md} />

      {!compact && (
        <Pressable
          onPress={onJoin}
          disabled={loading}
          style={({ pressed }) => [styles.joinRow, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Nouveau chauffeur ? Rejoindre une centrale"
          accessibilityState={{ disabled: loading }}
        >
          <Text style={styles.joinText} maxFontSizeMultiplier={TEXT_SCALE}>
            Nouveau chauffeur{NB}? <Text style={styles.joinStrong}>Rejoindre une centrale</Text>
          </Text>
        </Pressable>
      )}
      {/* Information légale, discrète (acceptation explicite ensuite dans l'app : components/terms-gate.tsx). Clavier
          ouvert : la phrase seule, pour garder « Se connecter » visible ; les liens reviennent clavier fermé */}
      <View style={styles.legal}>
        <Text style={styles.legalText} maxFontSizeMultiplier={TEXT_SCALE}>
          En vous connectant, vous acceptez les conditions d&apos;utilisation et la politique de confidentialité.
        </Text>
        {!compact && (CGU_URL || PRIVACY_URL) && (
          <View style={styles.legalLinks}>
            {CGU_URL && (
              <TextLink title="Conditions d'utilisation" role="link" onPress={() => void Linking.openURL(CGU_URL).catch(() => null)} muted />
            )}
            {PRIVACY_URL && (
              <TextLink title="Confidentialité" role="link" onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => null)} muted />
            )}
          </View>
        )}
      </View>
    </EnterView>
  );
}

// --- Mot de passe oublié : adresse → code reçu par e-mail + nouveau mot de passe --------------------

function ForgotPanel({ email, setEmail, onBack, compact, animate, onFail }: PanelProps & { email: string; setEmail: (v: string) => void; onBack: () => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [resent, setResent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [invalid, setInvalid] = useState<{ code?: string | null; password?: string | null; confirm?: string | null }>({});
  const [saving, setSaving] = useState(false);
  const codeRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** Envoi (ou renvoi) de l'e-mail : code à saisir ici + lien de secours. */
  async function request(target: string, resend: boolean) {
    setFailure(null);
    setResent(false);
    setSending(true);
    try {
      await requestPasswordReset(target);
      hapticResult(true);
      setCooldown(RESEND_SECONDS);
      if (resend) {
        setCode("");
        setInvalid((p) => ({ ...p, code: null }));
        setResent(true);
      } else {
        panelTransition(animate);
        setSentTo(target);
        announce("Code envoyé. Saisissez le code reçu par e-mail.");
      }
    } catch (e) {
      setFailure(failureOf(e));
      onFail();
    } finally {
      setSending(false);
    }
  }

  function send() {
    if (sending) return;
    const problem = emailProblem(email);
    setEmailError(problem);
    setFailure(null);
    if (problem) {
      onFail();
      announce(problem);
      return;
    }
    Keyboard.dismiss();
    void request(email.trim().toLowerCase(), false);
  }

  async function save() {
    if (saving || !sentTo) return;
    const digits = code.replace(/\D/g, "");
    const problems = {
      code: /^\d{6,10}$/.test(digits) ? null : "Saisissez les chiffres du code reçu par e-mail.",
      password:
        password.length < NEW_PASSWORD_MIN
          ? `${NEW_PASSWORD_MIN} caractères minimum.`
          : password.length > NEW_PASSWORD_MAX
            ? `${NEW_PASSWORD_MAX} caractères maximum.`
            : null,
      confirm: !confirm ? "Saisissez à nouveau le mot de passe." : confirm !== password ? "Les deux mots de passe ne correspondent pas." : null,
    };
    setInvalid(problems);
    setFailure(null);
    setResent(false);
    const first = problems.code ?? problems.password ?? problems.confirm;
    if (first) {
      onFail();
      announce(first);
      (problems.code ? codeRef : problems.password ? passwordRef : confirmRef).current?.focus();
      return;
    }
    Keyboard.dismiss();
    setSaving(true);
    announce("Enregistrement du mot de passe");
    try {
      await confirmPasswordReset(sentTo, digits, password);
      hapticResult(true);
      AsyncStorage.setItem(LAST_EMAIL_KEY, sentTo).catch(() => null);
      // Session ouverte : redirection dès que l'état du compte est lu (bouton en attente jusque-là)
    } catch (e) {
      const err = failureOf(e);
      setSaving(false);
      onFail();
      if (err.code === "OTP_INVALID") {
        setInvalid({ code: err.message });
        announce(err.message);
        return;
      }
      if (err.code && err.code in CODE_USED_HINT) {
        // Code consommé par le serveur : il faut en demander un nouveau
        setCode("");
        if (err.code !== "SAME_PASSWORD") {
          setPassword("");
          setConfirm("");
        }
        const hint = CODE_USED_HINT[err.code];
        setFailure({ code: err.code, message: hint ? `${err.message} ${hint}` : err.message });
        return;
      }
      setFailure(err);
    }
  }

  if (!sentTo) {
    return (
      <EnterView animate={animate} style={styles.panelBody}>
        <PanelHeader
          title="Mot de passe oublié"
          subtitle={`Saisissez l'adresse e-mail de votre compte chauffeur${NB}: vous recevrez un code pour choisir un nouveau mot de passe.`}
          onBack={onBack}
          compact={compact}
        />
        <AuthField
          label="E-mail"
          icon="mail-outline"
          hint="vous@exemple.fr"
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            if (emailError) setEmailError(null);
          }}
          error={emailError}
          editable={!sending}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          keyboardType="email-address"
          returnKeyType="send"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={send}
        />
        {failure && <FailureNotice failure={failure} />}
        <BigButton title="Recevoir un code" onPress={send} loading={sending} height={control.md} />
      </EnterView>
    );
  }

  return (
    <EnterView animate={animate} style={styles.panelBody}>
      <PanelHeader
        title="Nouveau mot de passe"
        subtitle={
          <>
            Saisissez le code reçu par e-mail à <Text style={styles.strong}>{sentTo}</Text>.
          </>
        }
        onBack={onBack}
        compact={compact}
      />
      <AuthField
        ref={codeRef}
        label="Code reçu par e-mail"
        icon="keypad-outline"
        value={code}
        onChangeText={(v) => {
          setCode(v.replace(/\D/g, ""));
          if (invalid.code) setInvalid((p) => ({ ...p, code: null }));
        }}
        error={invalid.code}
        editable={!saving}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={10}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
        inputStyle={styles.codeInput}
      />
      <AuthField
        ref={passwordRef}
        label="Nouveau mot de passe"
        icon="lock-closed-outline"
        secure
        value={password}
        help={`${NEW_PASSWORD_MIN} caractères minimum.`}
        onChangeText={(v) => {
          setPassword(v);
          if (invalid.password) setInvalid((p) => ({ ...p, password: null }));
        }}
        error={invalid.password}
        editable={!saving}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmRef.current?.focus()}
      />
      <AuthField
        ref={confirmRef}
        label="Confirmez le mot de passe"
        icon="lock-closed-outline"
        secure
        value={confirm}
        onChangeText={(v) => {
          setConfirm(v);
          if (invalid.confirm) setInvalid((p) => ({ ...p, confirm: null }));
        }}
        error={invalid.confirm}
        editable={!saving}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={save}
      />
      {failure && <FailureNotice failure={failure} />}
      {resent && !failure && <Notice tone="info" icon="mail-outline" message="Nouveau code envoyé. Seul le dernier code reçu est valable." />}
      <BigButton title="Changer le mot de passe" onPress={save} loading={saving} height={control.md} />
      <View style={styles.resendRow}>
        <TextLink
          title={sending ? "Envoi…" : cooldown > 0 ? `Renvoyer le code dans ${cooldown}${NB}s` : "Renvoyer le code"}
          accessibilityLabel={cooldown > 0 ? `Renvoyer le code, disponible dans ${cooldown} secondes` : "Renvoyer le code"}
          icon="refresh-outline"
          onPress={() => void request(sentTo, true)}
          disabled={sending || saving || cooldown > 0}
        />
      </View>
      {!compact && (
        <Text style={styles.note} maxFontSizeMultiplier={TEXT_SCALE}>
          L&apos;e-mail contient aussi un lien{NB}: vous pouvez l&apos;ouvrir à la place. Rien reçu{NB}? Vérifiez les courriers indésirables.
        </Text>
      )}
    </EnterView>
  );
}

// --- Rejoindre une centrale (lien d'inscription) --------------------------------------------------

function JoinPanel({ onBack, compact, animate, onFail }: PanelProps & { onBack: () => void }) {
  const [link, setLink] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const code = parseJoinCode(link);
  const [pasteAvailable] = useState(canReadText);

  function fail(message: string) {
    setInvalid(message);
    onFail();
    announce(message);
  }

  function next() {
    if (!code) {
      fail(link.trim() ? "Lien non reconnu : copiez le lien complet envoyé par la centrale." : "Collez le lien reçu de votre centrale.");
      return;
    }
    Keyboard.dismiss();
    router.push(`/rejoindre/${code}`);
  }

  async function paste() {
    const text = await readText();
    if (!text) {
      fail("Presse-papiers vide : copiez d'abord le lien reçu de votre centrale.");
      return;
    }
    setLink(text);
    if (!parseJoinCode(text)) {
      fail("Lien non reconnu : copiez le lien complet envoyé par la centrale.");
      return;
    }
    setInvalid(null);
    announce("Lien reconnu");
  }

  return (
    <EnterView animate={animate} style={styles.panelBody}>
      <PanelHeader
        title="Rejoindre une centrale"
        subtitle="Collez le lien d'inscription envoyé par votre centrale (WhatsApp, SMS ou e-mail)."
        onBack={onBack}
        compact={compact}
      />
      <View style={styles.joinField}>
        <AuthField
          label="Lien d'inscription"
          icon="link-outline"
          hint="https://…/rejoindre/…"
          value={link}
          onChangeText={(v) => {
            setLink(v);
            if (invalid) setInvalid(null);
          }}
          error={invalid ? frTypo(invalid) : null}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={next}
          right={
            pasteAvailable && !link ? (
              <Pressable
                onPress={paste}
                hitSlop={4}
                style={({ pressed }) => [styles.pasteBtn, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Coller le lien"
              >
                <Glyph name="clipboard-outline" size={18} />
                <Text style={styles.pasteText} maxFontSizeMultiplier={TEXT_SCALE}>
                  Coller
                </Text>
              </Pressable>
            ) : null
          }
        />
        {code && !invalid && (
          <View style={styles.recognized}>
            <Glyph name="checkmark-circle-outline" size={20} color={colors.green} />
            <Text style={styles.recognizedText} maxFontSizeMultiplier={TEXT_SCALE}>
              Lien reconnu
            </Text>
          </View>
        )}
      </View>
      <BigButton title="Continuer" onPress={next} height={control.md} />
      {!compact && (
        <Text style={styles.note} maxFontSizeMultiplier={TEXT_SCALE}>
          Vous pouvez aussi toucher directement le lien reçu{NB}: il ouvre l&apos;inscription dans l&apos;application.
        </Text>
      )}
    </EnterView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDeep },
  pressed: { opacity: 0.6 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xl },
  brand: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold, letterSpacing: -0.2 },
  brandCompact: { fontSize: type.headline },
  panelWrap: { width: "100%", maxWidth: 560, alignSelf: "center" },
  panel: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
  },
  panelBody: { gap: space.lg },
  heading: { gap: space.xs },
  title: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3 },
  lead: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  strong: { color: colors.fg, fontWeight: weight.semibold },
  note: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  joinRow: {
    minHeight: control.sm, alignItems: "center", justifyContent: "center", paddingTop: space.md,
    borderTopWidth: 1, borderColor: colors.line,
  },
  joinText: { color: colors.muted, fontSize: type.body, textAlign: "center" },
  joinStrong: { color: colors.fg, fontWeight: weight.semibold },
  legal: { alignItems: "center" },
  legalText: { color: colors.muted, fontSize: type.footnote, lineHeight: 18, textAlign: "center" },
  // Liens de 48 px de haut (cibles tactiles), côte à côte, à la ligne en très grands caractères
  legalLinks: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: space.lg },
  codeInput: { fontSize: type.title3, fontWeight: weight.semibold, letterSpacing: 4, ...mono },
  resendRow: { alignItems: "center", marginTop: -space.sm },
  joinField: { gap: space.sm },
  pasteBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingHorizontal: space.md, marginRight: 6,
    borderRadius: radius.sm, backgroundColor: colors.surface3,
  },
  pasteText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  recognized: { flexDirection: "row", alignItems: "center", gap: space.sm },
  recognizedText: { color: colors.fg, fontSize: type.body, fontWeight: weight.medium },
});
