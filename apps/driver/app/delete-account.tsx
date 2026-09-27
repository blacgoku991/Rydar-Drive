import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View, type TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AuthField, FormScroll, Notice } from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { BigButton, Screen, ScreenHeader } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api, ApiError, deleteAccount, LAST_EMAIL_KEY, legalUrl, type DeleteAccountResult } from "@/lib/api";
import { openDebt, openDebtNotice, type OpenDebt } from "@/lib/debt";
import { forgetLocalAcceptance } from "@/lib/legal";
import { stopTracking } from "@/lib/location";
import { unregisterPush } from "@/lib/notifications";
import { signOutThisDevice } from "@/lib/supabase";
import { colors, control, radius, space, type, weight } from "@/theme";

const DELETED = [
  "Votre compte de connexion, votre nom, téléphone, e-mail et photo",
  "Vos documents (carte VTC, permis…) et tous leurs fichiers",
  "Vos positions, appareils et notifications",
  "Vos messages avec la centrale, vos signalements et vos votes",
];

/** Réponses qui demandent le mot de passe : session révoquée (compte suspendu, banni…) ou absente. */
const NEEDS_PASSWORD = new Set(["UNAUTHORIZED", "SESSION"]);

type Phase = "confirm" | "password" | "done";

/**
 * Suppression définitive du compte (App Store 5.1.1(v), Google Play) : ce qui est supprimé, ce qui est conservé
 * sans identité, double confirmation. Accessible depuis le profil et depuis l'écran des comptes en attente, refusés,
 * suspendus ou bannis. Session refusée par le serveur : confirmation par mot de passe. « Supprimé » n'est affiché
 * qu'une fois tout effacé ; sinon « suppression en cours » (terminée par le serveur).
 */
export default function DeleteAccount() {
  const { session } = useDriver();
  const params = useLocalSearchParams<{ email?: string }>();
  const sessionEmail = session?.user.email ?? "";
  const [phase, setPhase] = useState<Phase>(session ? "confirm" : "password");
  const [email, setEmail] = useState(sessionEmail || (typeof params.email === "string" ? params.email : ""));
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeleteAccountResult | null>(null);
  // Déjà confirmé dans la boîte de dialogue : l'étape « mot de passe » ne redemande pas
  const confirmed = useRef(false);
  const passwordRef = useRef<TextInput>(null);
  const policy = legalUrl("suppression-compte");
  const userId = session?.user.id;

  // Commissions encore dues à la centrale (lisibles par un chauffeur actif) : montant rappelé avant la suppression,
  // qui reste possible (la dette demeure ; empreintes gardées tant qu'elle est ouverte, private.debtor_identities)
  const [debt, setDebt] = useState<OpenDebt | null>(null);
  useEffect(() => {
    setDebt(null);
    if (!userId) return;
    let alive = true;
    api
      .settlements(1)
      .then((s) => alive && setDebt(openDebt(s)))
      .catch(() => null);
    return () => {
      alive = false;
    };
  }, [userId]);
  const debtNotice = debt ? openDebtNotice(debt) : null;

  function leave() {
    if (phase === "done" || !router.canGoBack()) router.replace("/login");
    else router.back();
  }

  async function finish(res: DeleteAccountResult) {
    // Arrêt du suivi GPS et des notifications, puis déconnexion de CET appareil seulement (même hors réseau avec un
    // jeton expiré) : un gérant qui roulait aussi garde ses sessions du tableau de bord. Rien du compte supprimé ne
    // reste sur le téléphone : ni l'adresse pré-remplie à la connexion, ni son acceptation des conditions.
    const uid = session?.user.id;
    await stopTracking().catch(() => null);
    await unregisterPush().catch(() => null);
    await signOutThisDevice("local").catch(() => null);
    await AsyncStorage.removeItem(LAST_EMAIL_KEY).catch(() => null);
    if (uid) await forgetLocalAcceptance(uid);
    setResult(res);
    setPhase("done");
  }

  async function run() {
    if (busy) return;
    const withPassword = phase === "password";
    if (withPassword && !password) {
      setPasswordError("Saisissez votre mot de passe.");
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    setPasswordError(null);
    try {
      const res = await deleteAccount(withPassword ? password : undefined, withPassword ? email : undefined);
      await finish(res);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("Suppression impossible pour le moment. Réessayez.", null);
      if (NEEDS_PASSWORD.has(err.code ?? "")) {
        // Champ affiché puis mis au point (le formulaire défile jusqu'à lui)
        setPhase("password");
        setTimeout(() => passwordRef.current?.focus(), 250);
      } else if (err.code === "INVALID_CREDENTIALS") {
        setPasswordError(frTypo(err.message));
        passwordRef.current?.focus();
      } else {
        // Course attribuée (message du serveur), trop de tentatives, serveur d'authentification injoignable
        // (UNAVAILABLE : rien n'a été vérifié, le mot de passe saisi reste), réseau, e-mail manquant…
        setFailure(frTypo(err.message));
      }
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (confirmed.current) return void run();
    Alert.alert(
      frTypo("Supprimer définitivement ?"),
      frTypo(
        `Votre compte et vos données personnelles seront supprimés. Cette action est irréversible.${debtNotice ? ` ${debtNotice.confirm}` : ""}`,
      ),
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Supprimer",
          style: "destructive",
          onPress: () => {
            confirmed.current = true;
            void run();
          },
        },
      ],
    );
  }

  if (phase === "done" && result) return <Done result={result} onClose={() => router.replace("/login")} />;

  return (
    <Screen>
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        <ScreenHeader title="Supprimer mon compte" onBack={leave} />
        <FormScroll>
          <View style={styles.content}>
            <Text style={styles.lead}>
              {frTypo(
                "La suppression est définitive. Si une course vous est attribuée, terminez-la ou demandez à votre centrale de la réattribuer avant de supprimer votre compte.",
              )}
            </Text>

            {debtNotice && (
              <Notice tone="warning" icon="wallet-outline" title={frTypo(debtNotice.title)} message={frTypo(debtNotice.message)} />
            )}

            <Text style={styles.section} accessibilityRole="header">
              Supprimé
            </Text>
            <View style={styles.group}>
              {DELETED.map((item) => (
                <View key={item} style={styles.row}>
                  <Ionicons name="trash-outline" size={20} color={colors.muted} />
                  <Text style={styles.rowText}>{item}</Text>
                </View>
              ))}
            </View>

            <Text style={styles.section} accessibilityRole="header">
              Conservé sans votre nom ni vos coordonnées
            </Text>
            <Text style={styles.body}>
              {frTypo(
                "Les courses réalisées, gains, commissions et règlements restent enregistrés 10 ans pour les obligations comptables de la centrale, rattachés à une fiche anonyme « Chauffeur supprimé ».",
              )}
            </Text>

            {policy && (
              <Pressable onPress={() => void Linking.openURL(policy)} accessibilityRole="link" hitSlop={8} style={styles.link}>
                <Text style={styles.linkText}>En savoir plus</Text>
                <Ionicons name="open-outline" size={16} color={colors.muted} />
              </Pressable>
            )}

            {phase === "password" && (
              <View style={styles.passwordBlock}>
                <Text style={styles.section} accessibilityRole="header">
                  Confirmez avec votre mot de passe
                </Text>
                <Text style={styles.body}>
                  {frTypo(
                    "Votre session n'est plus valable (compte suspendu, banni, centrale suspendue ou session expirée) : saisissez le mot de passe de votre compte pour confirmer la suppression.",
                  )}
                </Text>
                <AuthField
                  label="E-mail du compte"
                  icon="mail-outline"
                  value={email}
                  onChangeText={setEmail}
                  editable={!sessionEmail && !busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  keyboardType="email-address"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
                <AuthField
                  ref={passwordRef}
                  label="Mot de passe"
                  icon="lock-closed-outline"
                  secure
                  value={password}
                  onChangeText={(v) => {
                    setPassword(v);
                    if (passwordError) setPasswordError(null);
                  }}
                  error={passwordError}
                  editable={!busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType="done"
                  onSubmitEditing={confirm}
                />
              </View>
            )}

            {failure && <Notice title="Suppression impossible" message={failure} />}

            <View style={styles.footer}>
              <BigButton
                title="Supprimer définitivement"
                variant="danger"
                icon="trash-outline"
                height={control.md}
                loading={busy}
                disabled={busy}
                onPress={confirm}
              />
              <BigButton title="Annuler" variant="ghost" height={control.md} disabled={busy} onPress={leave} />
            </View>
          </View>
        </FormScroll>
      </SafeAreaView>
    </Screen>
  );
}

const DONE: Record<DeleteAccountResult["code"], { icon: keyof typeof Ionicons.glyphMap; color: string; title: string }> = {
  DELETED: { icon: "checkmark-circle-outline", color: colors.green, title: "Compte supprimé" },
  DRIVER_PROFILE_DELETED: { icon: "person-remove-outline", color: colors.green, title: "Profil chauffeur supprimé" },
  DELETION_PENDING: { icon: "time-outline", color: colors.amber, title: "Suppression en cours" },
};

const FALLBACK: Record<DeleteAccountResult["code"], string> = {
  DELETED: "Votre compte Rydar Drive et vos données personnelles ont été supprimés.",
  DRIVER_PROFILE_DELETED: "Profil chauffeur supprimé. Votre compte de gestion (tableau de bord de la centrale) est conservé.",
  DELETION_PENDING:
    "Vos données personnelles sont effacées. La suppression de vos fichiers et de votre compte de connexion se termine automatiquement, sans action de votre part.",
};

/** Issue : « supprimé » seulement quand tout est effacé ; profil seul (gérant) ; ou suppression en cours. */
function Done({ result, onClose }: { result: DeleteAccountResult; onClose: () => void }) {
  const meta = DONE[result.code];
  return (
    <Screen>
      <SafeAreaView style={styles.done} edges={["top", "bottom"]}>
        <View style={styles.doneBody} accessibilityLiveRegion="polite">
          <Ionicons name={meta.icon} size={44} color={meta.color} accessibilityElementsHidden importantForAccessibility="no" />
          <Text style={styles.doneTitle} accessibilityRole="header">
            {meta.title}
          </Text>
          <Text style={styles.doneText}>{frTypo(result.message || FALLBACK[result.code])}</Text>
          {result.code === "DRIVER_PROFILE_DELETED" && (
            <Text style={styles.body}>
              {frTypo("Vous restez connecté au tableau de bord sur vos autres appareils. Cette application est déconnectée.")}
            </Text>
          )}
        </View>
        <BigButton title="Terminer" height={control.md} onPress={onClose} />
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg, gap: space.md },
  lead: { color: colors.fg, fontSize: type.callout, lineHeight: 22 },
  section: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.semibold, marginTop: space.sm, marginLeft: space.xs },
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  rowText: { flex: 1, color: colors.fg, fontSize: type.subhead },
  body: { color: colors.muted, fontSize: type.subhead, lineHeight: 20, marginHorizontal: space.xs },
  link: { flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start", minHeight: 48, marginLeft: space.xs },
  linkText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.medium, textDecorationLine: "underline" },
  passwordBlock: { gap: space.md },
  footer: { marginTop: "auto", paddingTop: space.xl, gap: space.sm },
  done: { flex: 1, padding: space.xl, gap: space.xl, justifyContent: "space-between" },
  doneBody: { gap: space.md, paddingTop: space.xxl },
  doneTitle: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3, lineHeight: 30 },
  doneText: { color: colors.fg, fontSize: type.callout, lineHeight: 23 },
});
