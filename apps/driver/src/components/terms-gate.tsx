// Conditions d'utilisation à accepter dans l'application : TOUS les chauffeurs, y compris ceux créés par une centrale
// (jamais passés par le formulaire d'inscription), acceptent la version en vigueur des CGU et de la politique de
// confidentialité (lib/legal.ts). Écran plein posé au-dessus des écrans de l'app (titre, essentiel, liens vers les
// documents complets, « J'accepte » en bas ; autres issues : « Se déconnecter » et « Supprimer mon compte », possible
// sans accepter les conditions), SAUF :
//  - jamais pendant une course ni une offre : il attend que le chauffeur n'ait plus de course active ;
//  - chauffeur EN LIGNE sans course : passé hors ligne (aucune offre sans conditions acceptées ; échec réseau :
//    nouvel essai toutes les 30 s tant qu'il reste disponible), remis en ligne après « J'accepte » ;
//  - jamais bloquant hors connexion : registre illisible → pas d'écran, nouvel essai plus tard ; « J'accepte » sans
//    réseau → acceptation gardée sur le téléphone et envoyée dès que possible.
import { Ionicons } from "@expo/vector-icons";
import { LEGAL_VERSION, formatDate, type DriverPresence } from "@rydar/shared";
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated, AppState, Keyboard, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { announce, Notice, TextLink, TEXT_SCALE, TITLE_SCALE, useReduceMotion } from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { BigButton, hapticResult } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { legalUrl } from "@/lib/api";
import {
  acceptTerms, fetchTermsStatus, forgetLocalAcceptance, hasLocalAcceptance, isTransientError, markTermsAccepted, rememberLocalAcceptance,
} from "@/lib/legal";
import { offlineEnforcer, type OfflineEnforcer } from "@/lib/terms-offline";
import { colors, control, space, type, weight } from "@/theme";

/** Offre reçue ou course en cours : l'écran attend (jamais d'interruption). */
const BUSY_PRESENCES = new Set<DriverPresence>(["offered", "en_route", "arrived", "on_trip"]);
/** Écrans d'offre et de course : jamais recouverts. */
const RIDE_SCREEN = /^\/(offer|ride)(\/|$)/;
/** Nouvel essai après un échec de lecture ou d'envoi (réseau) : 10 s, 30 s, 1 min, 2 min, puis toutes les 5 min. */
const RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

/**
 * unknown : pas encore lu, ou illisible (réseau) ; pending : à accepter ; syncing : accepté sur le téléphone, en
 * attente du serveur ; accepted ; unsupported : serveur sans registre des acceptations.
 */
type GateState = "unknown" | "pending" | "syncing" | "accepted" | "unsupported";

/** L'essentiel des deux documents (résumé, les documents complets font foi). Typographie : frTypo à l'affichage. */
const POINTS = [
  "Rydar Drive fournit l'outil de dispatch de votre centrale : les courses, les clients et les prix relèvent d'elle.",
  "Quand vous êtes EN LIGNE, votre position est partagée avec votre centrale, y compris application en arrière-plan ; hors ligne, elle accompagne seulement les signalements que vous publiez.",
  "Fil Chauffeurs : aucune tolérance pour les contenus choquants ni pour les comportements abusifs. Votre centrale le modère et peut exclure leurs auteurs.",
] as const;

/**
 * Acceptation de la version en vigueur pour le compte connecté (effets liés à l'utilisateur, pas à la session) :
 * lecture du registre, relue au retour dans l'app tant qu'elle n'est pas acquise ; « J'accepte ».
 */
function useTermsStatus(userId: string | null, refreshChat: () => Promise<void>) {
  const [state, setState] = useState<GateState>("unknown");
  const [updated, setUpdated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<GateState>(state);
  stateRef.current = state;
  const refreshChatRef = useRef(refreshChat);
  refreshChatRef.current = refreshChat;
  /** Nouvel essai programmé (lecture, ou envoi d'une acceptation faite sans réseau) */
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    setState("unknown");
    setError(null);
    if (!userId) return;
    const uid = userId;
    let alive = true;
    let running = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const retryLater = () => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        void check();
      }, delay);
    };
    const settled = () => {
      attempt = 0;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const accepted = () => {
      void forgetLocalAcceptance(uid);
      markTermsAccepted(uid);
      setState("accepted");
      settled();
    };

    async function check() {
      // Arrière-plan : reprise au retour dans l'application (écouteur plus bas)
      if (!alive || running || AppState.currentState === "background") return;
      running = true;
      try {
        const status = await fetchTermsStatus(uid).catch(() => null);
        const local = await hasLocalAcceptance(uid);
        if (!alive) return;
        if (!status) {
          // Registre illisible (réseau) : jamais bloquant, nouvel essai plus tard
          setState(local ? "syncing" : "unknown");
          return retryLater();
        }
        if (status.state === "unsupported") {
          setState("unsupported");
          return settled();
        }
        if (status.state === "accepted") return accepted();
        if (local) {
          // « J'accepte » touché sans réseau : envoyé maintenant
          try {
            await acceptTerms();
            if (!alive) return;
            accepted();
            void refreshChatRef.current();
          } catch (e) {
            if (!alive) return;
            if (isTransientError(e)) {
              setState("syncing");
              return retryLater();
            }
            // Refus du serveur : l'écran revient
            void forgetLocalAcceptance(uid);
            setUpdated(status.updated);
            setState("pending");
            settled();
          }
          return;
        }
        setUpdated(status.updated);
        setState("pending");
        settled();
      } finally {
        running = false;
      }
    }

    retryRef.current = retryLater;
    void check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && stateRef.current !== "accepted" && stateRef.current !== "unsupported") void check();
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      sub.remove();
      retryRef.current = () => undefined;
    };
  }, [userId]);

  const accept = useCallback(async () => {
    if (!userId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptTerms();
      hapticResult(true);
      void forgetLocalAcceptance(userId);
      markTermsAccepted(userId);
      setState("accepted");
      announce("Conditions acceptées");
      // Règles du fil « Chauffeurs » (CGU) : acceptées aussi (rules_version relu)
      void refreshChat();
    } catch (e) {
      if (isTransientError(e)) {
        // Sans réseau : acceptation gardée sur le téléphone et envoyée dès que possible, l'écran ne bloque pas
        await rememberLocalAcceptance(userId);
        hapticResult(true);
        setState("syncing");
        announce("Conditions acceptées");
        retryRef.current();
      } else {
        hapticResult(false);
        setError(frTypo((e as Error).message || "Acceptation impossible. Réessayez."));
      }
    } finally {
      setBusy(false);
    }
  }, [userId, busy, refreshChat]);

  return { state, updated, busy, error, accept };
}

/**
 * Enveloppe des écrans de l'application (layout (app)) : écran « Conditions d'utilisation » par-dessus quand la
 * version en vigueur n'est pas acceptée, hors course et hors offre. Le contenu recouvert est masqué au lecteur d'écran.
 */
export function TermsGate({ children }: { children: React.ReactNode }) {
  const { session, home, refreshChat, signOut, setOnline } = useDriver();
  const userId = session?.user.id ?? null;
  const pathname = usePathname();
  const terms = useTermsStatus(userId, refreshChat);
  // Accueil pas encore lu (course active inconnue), offre reçue, course en cours, écran d'offre ou de course : attente
  const busyDriver = !home || home.driver.current_ride_id != null || BUSY_PRESENCES.has(home.driver.presence);
  const visible = terms.state === "pending" && !busyDriver && !RIDE_SCREEN.test(pathname);

  // Conditions à accepter : un chauffeur disponible sans course passe hors ligne (plus aucune offre tant qu'elles ne
  // sont pas acceptées) ; il repasse en ligne après « J'accepte ». Offre ou course en cours : jamais interrompue.
  // Échec (réseau instable) ou appel sans effet : nouvel essai toutes les 30 s tant qu'il reste disponible
  // (lib/terms-offline.ts) — l'écran d'offre, jamais recouvert, ne doit pas s'ouvrir sans conditions acceptées.
  const mustGoOffline = terms.state === "pending" && home?.driver.presence === "available" && home.driver.current_ride_id == null;
  const setOnlineRef = useRef(setOnline);
  setOnlineRef.current = setOnline;
  const offline = useRef<OfflineEnforcer | null>(null);
  useEffect(() => {
    // Un compte à la fois : essais et « à remettre en ligne » du compte précédent oubliés
    const enforcer = offlineEnforcer(() => setOnlineRef.current(false));
    offline.current = enforcer;
    return () => {
      enforcer.dispose();
      if (offline.current === enforcer) offline.current = null;
    };
  }, [userId]);
  useEffect(() => {
    offline.current?.set(mustGoOffline);
  }, [mustGoOffline, userId]);
  const accepted = terms.state === "accepted" || terms.state === "syncing";
  useEffect(() => {
    if (!accepted || !offline.current?.takeWentOffline()) return;
    void setOnline(true).then((res) => {
      if (!res.ok && res.code !== "cancelled") Alert.alert("Vous êtes hors ligne", frTypo(res.message ?? "Passez en ligne depuis l'accueil."));
    });
  }, [accepted, setOnline]);

  useEffect(() => {
    // Clavier d'un écran recouvert (messagerie) : refermé
    if (visible) Keyboard.dismiss();
  }, [visible]);

  const leave = useCallback(async () => {
    if (await signOut()) router.replace("/login");
  }, [signOut]);

  return (
    <View style={styles.root}>
      <View style={styles.root} accessibilityElementsHidden={visible} importantForAccessibility={visible ? "no-hide-descendants" : "auto"}>
        {children}
      </View>
      {visible && (
        <TermsScreen
          updated={terms.updated}
          busy={terms.busy}
          error={terms.error}
          onAccept={() => void terms.accept()}
          onSignOut={() => void leave()}
          // Suppression du compte (écran au-dessus de celui-ci) : jamais subordonnée à l'acceptation
          onDelete={() => router.push("/delete-account")}
        />
      )}
    </View>
  );
}

function TermsScreen({
  updated, busy, error, onAccept, onSignOut, onDelete,
}: { updated: boolean; busy: boolean; error: string | null; onAccept: () => void; onSignOut: () => void; onDelete: () => void }) {
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(0)).current;
  // Apparition en fondu court (une fois), immédiate si « Réduire les animations »
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const anim = Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [opacity, reduceMotion]);

  const cgu = legalUrl("cgu");
  const privacy = legalUrl("confidentialite");
  const lead = updated
    ? "Les conditions d'utilisation et la politique de confidentialité de Rydar Drive ont été mises à jour. Lisez-les, puis acceptez-les pour continuer."
    : "Pour utiliser Rydar Drive, lisez puis acceptez ses conditions d'utilisation et sa politique de confidentialité.";

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.screen, { opacity }]} accessibilityViewIsModal>
      <SafeAreaView edges={["top", "bottom"]} style={styles.root}>
        <ScrollView contentContainerStyle={styles.content} bounces={false} overScrollMode="never">
          <View style={styles.head}>
            <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
              Conditions d'utilisation
            </Text>
            <Text style={styles.lead} maxFontSizeMultiplier={TEXT_SCALE}>{frTypo(lead)}</Text>
          </View>
          <View style={styles.points}>
            {POINTS.map((point) => (
              <View key={point} style={styles.point}>
                <Text style={styles.bullet} accessibilityElementsHidden importantForAccessibility="no" maxFontSizeMultiplier={TEXT_SCALE}>
                  •
                </Text>
                <Text style={styles.pointText} maxFontSizeMultiplier={TEXT_SCALE}>{frTypo(point)}</Text>
              </View>
            ))}
          </View>
          {(cgu || privacy) && (
            <View>
              {cgu && <DocLink title="Lire les conditions d'utilisation" url={cgu} />}
              {privacy && <DocLink title="Lire la politique de confidentialité" url={privacy} />}
            </View>
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Text style={styles.note} maxFontSizeMultiplier={TEXT_SCALE}>
            {frTypo(
              `En touchant « J'accepte », vous acceptez les conditions d'utilisation et la politique de confidentialité (version du ${formatDate(LEGAL_VERSION)}).`,
            )}
          </Text>
          {error && <Notice tone="error" message={error} />}
          <BigButton title="J'accepte" icon="checkmark" height={control.lg} loading={busy} onPress={onAccept} />
          <View style={styles.others}>
            <TextLink title="Se déconnecter" onPress={onSignOut} disabled={busy} muted />
            <TextLink title="Supprimer mon compte" onPress={onDelete} disabled={busy} muted />
          </View>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

/** Document complet, ouvert dans le navigateur (cible de 48 px). */
function DocLink({ title, url }: { title: string; url: string }) {
  return (
    <Pressable
      onPress={() => void Linking.openURL(url).catch(() => null)}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
      accessibilityRole="link"
      accessibilityLabel={title}
      accessibilityHint="S'ouvre dans le navigateur"
    >
      <Text style={styles.linkText} maxFontSizeMultiplier={TEXT_SCALE}>{title}</Text>
      <Ionicons name="open-outline" size={18} color={colors.fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { backgroundColor: colors.bg, zIndex: 60 },
  pressed: { opacity: 0.6 },
  content: { flexGrow: 1, paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.lg, gap: space.xl },
  head: { gap: space.sm },
  title: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3 },
  lead: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  points: { gap: space.md },
  point: { flexDirection: "row", gap: space.sm },
  bullet: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  pointText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  link: { flexDirection: "row", alignItems: "center", gap: space.sm, alignSelf: "flex-start", minHeight: control.sm },
  linkText: { color: colors.fg, fontSize: type.body, fontWeight: weight.medium, textDecorationLine: "underline" },
  footer: {
    paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.sm, gap: space.md, borderTopWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg,
  },
  note: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  // Issues secondaires côte à côte (cibles de 48 px), à la ligne en très grands caractères
  others: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: space.lg, marginTop: -space.xs },
});
