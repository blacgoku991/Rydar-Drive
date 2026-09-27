// Modération du fil « Chauffeurs » côté chauffeur (règles App Store 1.2 et Google Play sur le contenu publié par
// les utilisateurs) : règles du fil acceptées avant la première publication, signaler un message à la centrale,
// masquer / réafficher les messages d'un chauffeur, contact de l'éditeur.
// La centrale traite les signalements dans son tableau de bord (Messages › fil « Toute la flotte ») : suppression du
// message ou classement. Un message signalé disparaît aussitôt du fil de celui qui l'a signalé (serveur).
import { Ionicons } from "@expo/vector-icons";
import {
  FLEET_CHAT_RULES_POINTS, LEGAL_VERSION, chatReportReason, legalVersionAccepted, type BlockChatAuthorResult,
  type DriverChatOverview, type DriverChatOverviewModerated, type ReportChatMessageResult, type RpcResult,
  type UnblockChatAuthorResult,
} from "@rydar/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Linking, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { frTypo } from "@/components/centrale";
import { BigButton, BottomSheet, hapticResult } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { colors, control, radius, space, type, weight } from "@/theme";
import { ApiError, legalUrl, rpc } from "./api";
import { termsAcceptedFor } from "./legal";

/**
 * Signale un message du fil « Chauffeurs » (motif facultatif : motif proposé et / ou précision libre).
 * Réponse ALREADY_REPORTED si ce chauffeur l'a déjà signalé. Erreurs (ApiError) : OWN_MESSAGE, NOT_REPORTABLE,
 * MESSAGE_NOT_FOUND (déjà retiré), RATE_LIMITED.
 */
export function reportChatMessage(messageId: string, choice?: string | null, detail?: string | null) {
  return rpc<ReportChatMessageResult>("report_chat_message", { p_message: messageId, p_reason: chatReportReason(choice, detail) });
}

/** Masque les messages et signalements d'un chauffeur de la centrale (pour soi seulement ; il n'en sait rien). */
export function blockChatAuthor(driverId: string) {
  return rpc<BlockChatAuthorResult>("block_chat_author", { p_driver: driverId });
}

/** Réaffiche les messages d'un chauffeur masqué. */
export function unblockChatAuthor(driverId: string) {
  return rpc<UnblockChatAuthorResult>("unblock_chat_author", { p_driver: driverId });
}

// ---------------------------------------------------------------- règles du fil (CGU)

/** Chauffeurs qui ont accepté les règles pendant cette session (avant la relecture de la messagerie). */
const acceptedNow = new Set<string>();

/**
 * Règles du fil acceptées par le chauffeur connecté : CGU de la version en vigueur, par égalité stricte
 * (driver_chat_overview.rules_version), ou acceptées pendant cette session. false tant que la messagerie n'est pas lue
 * (useFleetRules consulte aussi l'acceptation des conditions d'utilisation à l'ouverture de l'app : lib/legal.ts).
 */
export function fleetRulesAccepted(chat: DriverChatOverview | null | undefined): boolean {
  if (!chat) return false;
  const version = (chat as DriverChatOverviewModerated).rules_version;
  // Champ absent : serveur antérieur à la modération du fil (20260924004100), qui ne peut ni vérifier ni enregistrer
  // cette acceptation (la feuille reviendrait à chaque lancement, et bloquerait la publication sans registre)
  if (version === undefined) return true;
  return acceptedNow.has(chat.driver_id) || legalVersionAccepted(version);
}

/**
 * Acceptation des règles du fil = CGU de Rydar Drive (§ 8 : messagerie et signalements), version en vigueur.
 * Preuve enregistrée par le serveur (legal_acceptances : compte, version, date, source « app »). Erreur : ApiError.
 */
export async function acceptFleetRules(driverId: string | null | undefined) {
  const res = await rpc<RpcResult>("accept_legal_documents", {
    p_documents: ["cgu"],
    p_version: LEGAL_VERSION,
    p_org: null,
    p_source: "app",
  });
  if (!res?.ok) throw new ApiError(res?.message ?? "Acceptation impossible. Réessayez.", res?.code ?? null);
  if (driverId) acceptedNow.add(driverId);
}

type Waiting = { promise: Promise<boolean>; resolve: (accepted: boolean) => void };

/**
 * Règles du fil « Chauffeurs » à accepter avant de publier (message, signalement de la flotte) : les stores exigent
 * l'acceptation des conditions avant tout contenu publié par l'utilisateur. `ensure()` résout true tout de suite si
 * elles sont acceptées ; sinon il ouvre la feuille « Règles du fil » et résout true à l'acceptation, false à la
 * fermeture. `node` : la feuille, à placer dans l'écran (comme useFlash).
 */
export function useFleetRules(chat: DriverChatOverview | null, refreshChat: () => Promise<void>) {
  const userId = useDriver().session?.user.id ?? null;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRef<Waiting | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const settle = useCallback((accepted: boolean) => {
    const w = waiting.current;
    waiting.current = null;
    setVisible(false);
    w?.resolve(accepted);
  }, []);

  const ensure = useCallback((): Promise<boolean> => {
    // CGU acceptées à l'ouverture de l'app (écran « Conditions d'utilisation ») : règles du fil comprises
    if (termsAcceptedFor(userIdRef.current) || fleetRulesAccepted(chatRef.current)) return Promise.resolve(true);
    // Feuille déjà ouverte (double appui) : même attente
    if (waiting.current) return waiting.current.promise;
    let resolve: (accepted: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    waiting.current = { promise, resolve };
    setError(null);
    // Clavier du message refermé : il masquerait la feuille et ses boutons (le texte reste dans le champ)
    Keyboard.dismiss();
    setVisible(true);
    return promise;
  }, []);

  // Écran quitté feuille ouverte : l'action en attente est abandonnée
  useEffect(() => () => waiting.current?.resolve(false), []);

  const accept = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await acceptFleetRules(chatRef.current?.driver_id);
      hapticResult(true);
      void refreshChat();
      settle(true);
    } catch (e) {
      hapticResult(false);
      setError(frTypo((e as Error).message || "Acceptation impossible. Réessayez."));
    } finally {
      setBusy(false);
    }
  }, [refreshChat, settle]);

  const node = <FleetRulesSheet visible={visible} busy={busy} error={error} onAccept={() => void accept()} onClose={() => settle(false)} />;
  return { ensure, node };
}

/** Feuille « Règles du fil » : résumé du § 8 des CGU, lien vers les CGU, « J'accepte ». */
function FleetRulesSheet({
  visible, busy, error, onAccept, onClose,
}: { visible: boolean; busy: boolean; error: string | null; onAccept: () => void; onClose: () => void }) {
  const { height } = useWindowDimensions();
  const cgu = legalUrl("cgu");
  return (
    <BottomSheet visible={visible} onClose={onClose} dismissable={!busy}>
      <View style={{ gap: space.xs }}>
        <Text style={styles.title} accessibilityRole="header">Règles du fil Chauffeurs</Text>
        <Text style={styles.muted}>{frTypo("À accepter avant de publier dans ce fil (message ou signalement) :")}</Text>
      </View>
      {/* Grands caractères : la liste défile, les boutons restent visibles */}
      <ScrollView style={{ maxHeight: Math.round(height * 0.42) }} contentContainerStyle={styles.points} bounces={false}>
        {FLEET_CHAT_RULES_POINTS.map((point) => (
          <View key={point} style={styles.point}>
            <Text style={styles.bullet} accessibilityElementsHidden importantForAccessibility="no">
              •
            </Text>
            <Text style={styles.pointText}>{frTypo(point)}</Text>
          </View>
        ))}
      </ScrollView>
      {cgu && (
        <Pressable
          onPress={() => void Linking.openURL(cgu).catch(() => null)}
          style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }]}
          accessibilityRole="link"
          accessibilityLabel="Lire les conditions d'utilisation"
        >
          <Text style={styles.linkText}>Lire les conditions d'utilisation</Text>
          <Ionicons name="open-outline" size={16} color={colors.fg} />
        </Pressable>
      )}
      <Text style={styles.muted}>
        {frTypo("En touchant « J'accepte », vous acceptez les conditions d'utilisation de Rydar Drive et vous vous engagez à respecter ces règles.")}
      </Text>
      {error && (
        <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Ionicons name="alert-circle-outline" size={20} color={colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <BigButton title="J'accepte" icon="checkmark" height={control.md} loading={busy} onPress={onAccept} />
      <BigButton title="Annuler" variant="ghost" height={control.sm} disabled={busy} onPress={onClose} />
    </BottomSheet>
  );
}

// ---------------------------------------------------------------- contact de l'éditeur

/** Éditeur de Rydar Drive (public_legal_info) : recours quand la centrale ne traite pas un abus (CGU § 8). */
export type PublisherContact = { name: string; email: string | null };

let contactRequest: Promise<PublisherContact | null> | null = null;

/** Contact de l'éditeur, lu une fois par session (nouvel essai après un échec) ; null s'il est illisible. */
export function publisherContact(): Promise<PublisherContact | null> {
  if (!contactRequest) {
    contactRequest = rpc<Record<string, string | null> | null>("public_legal_info")
      .then((info) => ({
        name: info?.company_name?.trim() || "Rydar Drive",
        email: info?.email?.trim() || info?.privacy_email?.trim() || null,
      }))
      .catch(() => {
        contactRequest = null;
        return null;
      });
  }
  return contactRequest;
}

/** Contact de l'éditeur, lu à la demande (feuille ouverte) : undefined pendant la lecture, null s'il est illisible. */
export function usePublisherContact(enabled: boolean): PublisherContact | null | undefined {
  const [contact, setContact] = useState<PublisherContact | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void publisherContact().then((c) => {
      if (alive) setContact(c);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return contact;
}

const styles = StyleSheet.create({
  title: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold },
  muted: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  points: { gap: space.sm },
  point: { flexDirection: "row", gap: space.sm },
  bullet: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  pointText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  // Cible tactile de 48 px
  link: { flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start", minHeight: control.sm },
  linkText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.medium, textDecorationLine: "underline" },
  error: {
    flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  errorText: { flex: 1, color: colors.fg, fontSize: type.body, fontWeight: weight.medium, lineHeight: 21 },
});
