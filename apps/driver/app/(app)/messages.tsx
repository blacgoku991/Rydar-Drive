// Messagerie chauffeur : conversation privée avec la centrale (« Ma centrale ») et fil commun à tous les
// chauffeurs de la centrale (« Chauffeurs » : messages et signalements). Fil « Chauffeurs » modéré : règles
// acceptées avant la première publication ; appui long sur le message d'un autre → signaler à la centrale, masquer
// les messages de son auteur (réaffichables).
import { Ionicons } from "@expo/vector-icons";
import {
  CHAT_REPORT_REASON_MAX, CHAT_REPORT_REASONS, FLEET_CHAT_RULES, FLEET_REPORT_META, formatTime, type ChatBlockedAuthor, type ChatMessage,
  type DriverChatOverviewModerated,
} from "@rydar/shared";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { ReportCard, ReportSheet, type ReportView } from "@/components/fleet-report";
import { BigButton, BottomSheet, hapticResult, Screen, ScreenHeader, Segmented, useFlash } from "@/components/ui";
import { prepareFleetReport, useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api, ApiError, legalUrl } from "@/lib/api";
import { blockChatAuthor, reportChatMessage, unblockChatAuthor, useFleetRules, usePublisherContact } from "@/lib/chat-moderation";
import { chatSession, type ChatTab } from "@/lib/chat-session";
import { useAppEvent } from "@/lib/events";
import { alpha, colors, control, mono, radius, space, type, weight } from "@/theme";

type IconName = keyof typeof Ionicons.glyphMap;

const NBSP = "\u00A0";

const QUICK_REPLIES = ["J'arrive", "Bien reçu", "Client en retard", "Je suis sur place"];

const dayKey = (d: string | Date, timeZone?: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

/** « Aujourd'hui », « Hier », « Lundi 22 septembre » (majuscule sur le premier mot seulement). */
function dayLabel(d: string, timeZone?: string) {
  const key = dayKey(d, timeZone);
  const now = Date.now();
  if (key === dayKey(new Date(now), timeZone)) return "Aujourd'hui";
  if (key === dayKey(new Date(now - 86_400_000), timeZone)) return "Hier";
  const s = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone }).format(new Date(d));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** « de Centrale Express », « d'Elite Paris » */
const deName = (name: string) => (/^[aeiouyàâäéèêëîïôöûüœ]/i.test(name) ? `d'${name}` : `de ${name}`);

/** Auteur affiché d'un message (« Sofiane T. », « Lina · Centrale »). */
const authorLabel = (m: ChatMessage) => (m.author_type === "user" ? `${m.author_name} · Centrale` : m.author_name);

/** Ce que devient un message signalé (feuille de signalement et aide de l'action). */
const REPORT_OUTCOME = "Votre centrale en est informée dans sa messagerie et décide s'il doit être retiré. Le message disparaît de votre fil.";

/** Conditions d'utilisation (règles du fil, § 8) : ligne de règles au-dessus du champ de saisie. */
const CGU_URL = legalUrl("cgu");

const longPressFeedback = () => {
  if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => null);
};

type Pending = { key: string; body: string; tab: ChatTab };
type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: ChatMessage; mine: boolean; first: boolean; seen: boolean }
  | { kind: "report"; key: string; r: ReportView }
  | { kind: "pending"; key: string; body: string };

export default function Messages() {
  const { chat, refreshChat, home, session } = useDriver();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<ChatTab>(params.tab === "fleet" ? "fleet" : "dispatch");
  const me = useMyPosition();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const focused = useIsFocused();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [reporting, setReporting] = useState(false);
  /** Message du fil « Chauffeurs » ouvert par un appui long (feuille : signaler, masquer son auteur) */
  const [moderating, setModerating] = useState<ChatMessage | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);
  // Masquage immédiat, sans attendre la relecture de la messagerie (le serveur les exclut ensuite lui-même)
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenAuthors, setHiddenAuthors] = useState<ReadonlySet<string>>(() => new Set());
  // Fil « Chauffeurs » : règles (CGU) acceptées avant la première publication, message ou signalement
  const rules = useFleetRules(chat, refreshChat);
  const openingReport = useRef(false);
  const sendingRef = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const tz = home?.organization.timezone;
  const myId = home?.driver.id;
  const myUserId = session?.user.id;
  const orgName = home?.organization.name?.trim() || "votre centrale";
  const blocked = (chat as DriverChatOverviewModerated | null)?.blocked ?? [];

  useEffect(() => {
    if (params.tab === "fleet" || params.tab === "dispatch") setTab(params.tab);
  }, [params.tab]);
  // Notification touchée alors que l'écran est déjà ouvert
  useAppEvent("messages:tab", setTab);

  // Fil affiché : pas de bannière en double pour ses notifications (cf. notifications.ts)
  useFocusEffect(
    useCallback(() => {
      chatSession.openThread = tab;
      void refreshChat();
      return () => {
        chatSession.openThread = null;
      };
    }, [tab, refreshChat]),
  );

  const thread = tab === "dispatch" ? chat?.dispatch : chat?.fleet;

  // Lu à l'ouverture et à chaque message reçu dans le fil ouvert
  const marking = useRef(false);
  useEffect(() => {
    if (!focused || !chat || !thread || thread.unread <= 0 || marking.current) return;
    marking.current = true;
    api
      .markRead(thread.thread)
      .then(() => refreshChat())
      .catch(() => null)
      .finally(() => {
        marking.current = false;
      });
  }, [focused, chat, thread, refreshChat]);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    const msgs = thread?.messages ?? [];
    const votes = new Map((chat?.reports ?? []).map((r) => [r.id, r]));
    const seenAt = tab === "dispatch" && chat?.dispatch.seen_by_dispatch_at ? new Date(chat.dispatch.seen_by_dispatch_at).getTime() : 0;
    // « Vu » : sous mon dernier message lu par la centrale
    let lastSeenMine: string | null = null;
    for (const m of msgs) if (m.author_driver_id === myId && new Date(m.created_at).getTime() <= seenAt) lastSeenMine = m.id;
    let prevDay = "";
    let prevAuthor = "";
    for (const m of msgs) {
      if (tab === "fleet" && (hiddenIds.has(m.id) || (m.author_driver_id != null && hiddenAuthors.has(m.author_driver_id)))) continue;
      const day = dayKey(m.created_at, tz);
      if (day !== prevDay) {
        list.push({ kind: "day", key: `d-${day}`, label: dayLabel(m.created_at, tz) });
        prevDay = day;
        prevAuthor = "";
      }
      if (m.report_type) {
        const live = votes.get(m.id);
        list.push({ kind: "report", key: m.id, r: live ? { ...m, ...live } : { ...m, active: m.active && !!m.expires_at && new Date(m.expires_at).getTime() > Date.now() } });
        prevAuthor = "";
        continue;
      }
      const author = `${m.author_type}:${m.author_driver_id ?? m.author_user_id ?? m.author_name}`;
      list.push({ kind: "msg", key: m.id, m, mine: !!myId && m.author_driver_id === myId, first: author !== prevAuthor, seen: m.id === lastSeenMine });
      prevAuthor = author;
    }
    for (const p of pending) if (p.tab === tab) list.push({ kind: "pending", key: p.key, body: p.body });
    return list;
  }, [thread, chat?.reports, chat?.dispatch.seen_by_dispatch_at, tab, tz, myId, pending, hiddenIds, hiddenAuthors]);

  async function send(raw: string) {
    const body = raw.trim();
    // Envoi en cours, ou règles du fil affichées (touche « Envoyer » du clavier) : un seul envoi
    if (!body || sending || sendingRef.current) return;
    sendingRef.current = true;
    const key = `p-${Date.now()}`;
    const target = tab;
    try {
      // Première publication dans le fil « Chauffeurs » : règles à accepter (sinon rien ne part, le texte reste)
      if (target === "fleet" && !(await rules.ensure())) return;
      setSending(true);
      setPending((p) => [...p, { key, body, tab: target }]);
      if (raw === text) setText("");
      try {
        await api.sendMessage({ channel: target === "dispatch" ? "driver" : "fleet", body });
        hapticResult(true);
        await refreshChat();
      } catch (e) {
        hapticResult(false);
        if (raw === text) setText(raw);
        flash.show(frTypo((e as Error).message), "error");
      } finally {
        setPending((p) => p.filter((x) => x.key !== key));
        setSending(false);
      }
    } finally {
      sendingRef.current = false;
    }
  }

  /**
   * « Signaler un incident » : règles du fil acceptées, puis autorisation de position (information préalable et
   * fenêtre du système si elle n'a jamais été donnée : la position accompagne le signalement, même hors ligne).
   */
  async function openReportSheet() {
    if (openingReport.current) return;
    openingReport.current = true;
    try {
      if (!(await rules.ensure()) || !(await prepareFleetReport())) return;
      setReporting(true);
    } finally {
      openingReport.current = false;
    }
  }

  /**
   * Appui long possible : message d'un autre auteur du fil « Chauffeurs » (chauffeur ou centrale), hors messages
   * système. Chauffeur qui est aussi membre de sa centrale : ses messages écrits depuis le tableau de bord sont
   * aussi les siens (le serveur refuse de les signaler).
   */
  const moderatable = (m: ChatMessage) =>
    tab === "fleet" &&
    m.author_type !== "system" &&
    !(m.author_type === "driver" && m.author_driver_id === myId) &&
    !(m.author_type === "user" && !!myUserId && m.author_user_id === myUserId);
  const openActions = (m: ChatMessage) => {
    longPressFeedback();
    setModerating(m);
  };

  async function submitReport(m: ChatMessage, choice: string | null, detail: string) {
    try {
      const res = await reportChatMessage(m.id, choice, detail);
      setModerating(null);
      setHiddenIds((prev) => new Set(prev).add(m.id));
      hapticResult(true);
      if (res.code === "ALREADY_REPORTED") flash.show("Vous aviez déjà signalé ce message.", "info");
      else flash.show("Message signalé à votre centrale", "success", "flag-outline");
      void refreshChat();
      return true;
    } catch (e) {
      hapticResult(false);
      if (e instanceof ApiError && e.code === "MESSAGE_NOT_FOUND") {
        // Retiré par la centrale entre-temps : il disparaît du fil
        setModerating(null);
        setHiddenIds((prev) => new Set(prev).add(m.id));
        flash.show("Ce message n'est plus disponible.", "info");
        void refreshChat();
        return true;
      }
      flash.show(frTypo((e as Error).message), "error");
      return false;
    }
  }

  async function block(driverId: string, name: string) {
    setHiddenAuthors((prev) => new Set(prev).add(driverId));
    try {
      await blockChatAuthor(driverId);
      hapticResult(true);
      flash.show(`Messages de ${name} masqués`, "success", "eye-off-outline");
      void refreshChat();
    } catch (e) {
      setHiddenAuthors((prev) => {
        const next = new Set(prev);
        next.delete(driverId);
        return next;
      });
      hapticResult(false);
      flash.show(frTypo((e as Error).message), "error");
    }
  }

  function confirmBlock(m: ChatMessage) {
    const id = m.author_driver_id;
    if (!id) return;
    setModerating(null);
    Alert.alert(
      frTypo(`Masquer les messages de ${m.author_name} ?`),
      frTypo("Vous ne verrez plus ses messages ni ses signalements, et ne recevrez plus ses alertes. Il n'en est pas informé. Vous pourrez les réafficher depuis cet écran."),
      [
        { text: "Annuler", style: "cancel" },
        { text: "Masquer", style: "destructive", onPress: () => void block(id, m.author_name) },
      ],
    );
  }

  async function unblock(b: ChatBlockedAuthor) {
    try {
      await unblockChatAuthor(b.driver_id);
      setHiddenAuthors((prev) => {
        const next = new Set(prev);
        next.delete(b.driver_id);
        return next;
      });
      hapticResult(true);
      flash.show(`Messages de ${b.name} réaffichés`, "success", "eye-outline");
      await refreshChat();
    } catch (e) {
      hapticResult(false);
      flash.show(frTypo((e as Error).message), "error");
    }
  }

  // Plus personne à réafficher : la feuille se referme
  useEffect(() => {
    if (showBlocked && blocked.length === 0) setShowBlocked(false);
  }, [showBlocked, blocked.length]);

  const phone = home?.organization.phone;
  const empty = !rows.some((r) => r.kind !== "day");
  const canSend = !!text.trim() && !sending;

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader
          title="Messages"
          right={
            phone ? (
              <Pressable
                onPress={() => void Linking.openURL(`tel:${phone}`)}
                style={({ pressed }) => [styles.call, pressed && { backgroundColor: colors.surface3 }]}
                accessibilityRole="button"
                accessibilityLabel={`Appeler ${orgName}`}
                hitSlop={6}
              >
                <Ionicons name="call-outline" size={20} color={colors.fg} />
              </Pressable>
            ) : undefined
          }
        />
        <View style={styles.top}>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "dispatch", label: "Ma centrale", badge: chat?.dispatch.unread ?? 0 },
              { value: "fleet", label: "Chauffeurs", badge: chat?.fleet.unread ?? 0 },
            ]}
          />
          <View style={styles.scopeRow}>
            <Text style={[styles.scope, { flex: 1 }]} numberOfLines={2}>
              {tab === "dispatch" ? `Conversation privée avec ${orgName}` : `Visible par tous les chauffeurs ${deName(orgName)}`}
            </Text>
            {tab === "fleet" && blocked.length > 0 && (
              <Pressable
                onPress={() => setShowBlocked(true)}
                hitSlop={{ left: 8, right: 8 }}
                style={({ pressed }) => [styles.blockedLink, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel={`${blocked.length} chauffeur${blocked.length > 1 ? "s" : ""} masqué${blocked.length > 1 ? "s" : ""}, réafficher`}
              >
                <Ionicons name="eye-off-outline" size={16} color={colors.muted} />
                <Text style={styles.blockedLinkText}>
                  {blocked.length}{NBSP}masqué{blocked.length > 1 ? "s" : ""}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.muted} />
              </Pressable>
            )}
          </View>
          {tab === "fleet" && (
            <BigButton
              title="Signaler un incident"
              variant="secondary"
              icon="flag-outline"
              height={control.sm}
              onPress={() => void openReportSheet()}
            />
          )}
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView
            ref={scroll}
            style={{ flex: 1 }}
            contentContainerStyle={[styles.list, empty && { flex: 1, justifyContent: "center" }]}
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {!chat ? (
              <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement des messages" />
            ) : empty ? (
              <Text style={styles.empty}>{tab === "dispatch" ? "Aucun message de la centrale." : "Aucun message des chauffeurs."}</Text>
            ) : (
              rows.map((row) => {
                if (row.kind === "day") {
                  return (
                    <View key={row.key} style={styles.day} accessibilityRole="header">
                      <View style={styles.dayLine} />
                      <Text style={styles.dayText}>{row.label}</Text>
                      <View style={styles.dayLine} />
                    </View>
                  );
                }
                if (row.kind === "report") {
                  const card = <ReportCard variant="feed" report={row.r} me={me} myDriverId={myId} onFlash={flash.show} style={{ marginVertical: space.xs }} />;
                  if (!moderatable(row.r)) return <View key={row.key}>{card}</View>;
                  // Appui long hors des boutons de vote ; accessible={false} : les boutons de la carte restent lisibles
                  // au lecteur d'écran (l'auteur reste masquable depuis ses messages)
                  const r = row.r;
                  return (
                    <Pressable key={row.key} accessible={false} delayLongPress={350} onLongPress={() => openActions(r)}>
                      {card}
                    </Pressable>
                  );
                }
                if (row.kind === "pending") {
                  return (
                    <View key={row.key} style={[styles.bubbleRow, { justifyContent: "flex-end", marginTop: 2 }]}>
                      <View style={[styles.bubble, styles.mine, { opacity: 0.6 }]} accessible accessibilityLabel={`Envoi en cours${NBSP}: ${row.body}`}>
                        <Text style={[styles.body, styles.mineText]}>{row.body}</Text>
                        <Text style={[styles.time, styles.mineTime]}>Envoi…</Text>
                      </View>
                    </View>
                  );
                }
                const { m, mine, first, seen } = row;
                if (m.author_type === "system") {
                  return <Text key={row.key} style={styles.system}>{m.body}</Text>;
                }
                const author = authorLabel(m);
                const time = formatTime(m.created_at, tz);
                const label = `${mine ? "Vous" : author}, ${time}${NBSP}: ${m.body}`;
                const content = (
                  <>
                    <Text style={[styles.body, mine && styles.mineText]}>{m.body}</Text>
                    <Text style={[styles.time, mine && styles.mineTime]}>{time}</Text>
                  </>
                );
                return (
                  <View key={row.key} style={[styles.bubbleRow, { justifyContent: mine ? "flex-end" : "flex-start", marginTop: first ? space.sm : 2 }]}>
                    <View style={{ maxWidth: "82%", alignItems: mine ? "flex-end" : "flex-start" }}>
                      {!mine && first && <Text style={styles.author}>{author}</Text>}
                      {!mine && moderatable(m) ? (
                        <Pressable
                          onLongPress={() => openActions(m)}
                          delayLongPress={350}
                          style={({ pressed }) => [styles.bubble, styles.theirs, pressed && styles.theirsPressed]}
                          accessible
                          accessibilityLabel={label}
                          accessibilityHint="Appui long : signaler ce message ou masquer son auteur"
                          accessibilityActions={[{ name: "longpress", label: "Signaler ou masquer" }]}
                          onAccessibilityAction={(e) => {
                            if (e.nativeEvent.actionName === "longpress") openActions(m);
                          }}
                        >
                          {content}
                        </Pressable>
                      ) : (
                        <View style={[styles.bubble, mine ? styles.mine : styles.theirs]} accessible accessibilityLabel={label}>
                          {content}
                        </View>
                      )}
                      {seen && (
                        <View style={styles.seen}>
                          <Ionicons name="checkmark-done" size={14} color={colors.muted} />
                          <Text style={styles.seenText}>Vu par la centrale</Text>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          <SafeAreaView edges={["bottom"]} style={styles.composer}>
            {tab === "fleet" &&
              (CGU_URL ? (
                // Règles du fil = CGU (§ 8) : la ligne entière ouvre les conditions d'utilisation
                <Pressable
                  onPress={() => void Linking.openURL(CGU_URL).catch(() => null)}
                  hitSlop={{ top: 6, bottom: 6 }}
                  style={({ pressed }) => pressed && { opacity: 0.6 }}
                  accessibilityRole="link"
                  accessibilityLabel={`${frTypo(FLEET_CHAT_RULES)} Conditions d'utilisation`}
                  accessibilityHint="Ouvre les conditions d'utilisation de Rydar Drive"
                >
                  <Text style={styles.rules}>
                    {frTypo(FLEET_CHAT_RULES)} <Text style={styles.rulesLink}>Conditions d'utilisation</Text>
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.rules}>{frTypo(FLEET_CHAT_RULES)}</Text>
              ))}
            {tab === "dispatch" && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.replies} keyboardShouldPersistTaps="handled">
                {QUICK_REPLIES.map((q) => (
                  <Pressable
                    key={q}
                    onPress={() => void send(q)}
                    disabled={sending}
                    style={({ pressed }) => [styles.reply, pressed && { backgroundColor: colors.surface3 }, sending && { opacity: 0.45 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Réponse rapide${NBSP}: ${q}`}
                    accessibilityState={{ disabled: sending }}
                  >
                    <Text style={styles.replyText}>{q}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <View style={styles.inputRow}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={tab === "dispatch" ? "Message à la centrale" : "Message aux chauffeurs"}
                placeholderTextColor={colors.muted}
                style={styles.input}
                multiline
                maxLength={1000}
                onSubmitEditing={() => void send(text)}
                submitBehavior="submit"
                returnKeyType="send"
                accessibilityLabel={tab === "dispatch" ? "Message à la centrale" : "Message aux chauffeurs"}
              />
              <Pressable
                onPress={() => void send(text)}
                disabled={!canSend}
                style={({ pressed }) => [styles.send, canSend ? { backgroundColor: pressed ? alpha(colors.brand, 0.85) : colors.brand } : styles.sendOff]}
                accessibilityRole="button"
                accessibilityLabel="Envoyer"
                accessibilityState={{ disabled: !canSend, busy: sending }}
              >
                {sending ? (
                  <ActivityIndicator color={colors.muted} />
                ) : (
                  <Ionicons name="arrow-up" size={22} color={canSend ? colors.brandFg : colors.subtle} />
                )}
              </Pressable>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {flash.node}

      <ReportSheet
        visible={reporting}
        me={me}
        onClose={() => setReporting(false)}
        onSent={(t) => {
          setReporting(false);
          const meta = FLEET_REPORT_META[t] ?? FLEET_REPORT_META.other;
          flash.show(`Signalement envoyé · ${meta.label}`, "success", meta.ionicon as IconName);
        }}
      />

      {rules.node}

      <ModerationSheet message={moderating} onClose={() => setModerating(null)} onReport={submitReport} onBlock={confirmBlock} />

      <BottomSheet visible={showBlocked} onClose={() => setShowBlocked(false)}>
        <Text style={styles.sheetTitle} accessibilityRole="header">Chauffeurs masqués</Text>
        <Text style={styles.sheetText}>{frTypo("Leurs messages et signalements ne s'affichent plus pour vous. Eux n'en savent rien.")}</Text>
        {blocked.map((b) => (
          <View key={b.driver_id} style={styles.blockedRow}>
            <Text style={styles.blockedName} numberOfLines={1}>{b.name}</Text>
            <BigButton title="Réafficher" variant="secondary" icon="eye-outline" height={control.sm} onPress={() => void unblock(b)} />
          </View>
        ))}
        <BigButton title="Fermer" variant="ghost" height={control.sm} onPress={() => setShowBlocked(false)} />
      </BottomSheet>
    </Screen>
  );
}

/** Action de la feuille (libellé long possible : il passe à la ligne au lieu de déborder, comme dans BigButton). */
function ActionRow({ icon, title, hint, onPress }: { icon: IconName; title: string; hint: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
    >
      <Ionicons name={icon} size={20} color={colors.fg} />
      <Text style={styles.actionText} maxFontSizeMultiplier={1.3}>
        {title}
      </Text>
    </Pressable>
  );
}

/**
 * Recours auprès de l'éditeur (CGU § 8) quand le message signalé vient de la centrale, qui modère son propre fil :
 * e-mail de l'éditeur (public_legal_info), sinon ses coordonnées sur la page des mentions légales.
 */
function PublisherRecourse({ messageId }: { messageId: string }) {
  const contact = usePublisherContact(true);
  if (contact === undefined) return null;
  const email = contact?.email ?? null;
  const subject = encodeURIComponent("Signalement d'un message — Rydar Drive");
  const body = encodeURIComponent(`Référence du message : ${messageId}\n\n`);
  const url = email ? `mailto:${email}?subject=${subject}&body=${body}` : legalUrl("mentions-legales");
  if (!url) return null;
  return (
    <View style={styles.recourse}>
      <Text style={styles.sheetText}>{frTypo("Si votre centrale ne traite pas un abus, écrivez à l'éditeur de Rydar Drive :")}</Text>
      <Pressable
        onPress={() => void Linking.openURL(url).catch(() => null)}
        style={({ pressed }) => [styles.recourseLink, pressed && { opacity: 0.6 }]}
        accessibilityRole="link"
        accessibilityLabel={email ? `Écrire à ${email}` : "Coordonnées de l'éditeur"}
      >
        <Ionicons name={email ? "mail-outline" : "open-outline"} size={18} color={colors.fg} />
        <Text style={styles.recourseText} numberOfLines={1}>{email ?? "Coordonnées de l'éditeur"}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Feuille d'actions d'un message du fil « Chauffeurs » (appui long) : « Signaler ce message » (motif facultatif),
 * « Masquer les messages de ce chauffeur » (auteur chauffeur seulement ; un message de la centrale se signale, il
 * ne se masque pas, et l'éditeur reste joignable si la centrale ne traite pas l'abus).
 */
function ModerationSheet({
  message, onClose, onReport, onBlock,
}: {
  message: ChatMessage | null;
  onClose: () => void;
  /** Envoi du signalement ; true s'il est enregistré (la feuille se ferme) */
  onReport: (m: ChatMessage, choice: string | null, detail: string) => Promise<boolean>;
  onBlock: (m: ChatMessage) => void;
}) {
  const [step, setStep] = useState<"actions" | "report">("actions");
  const [choice, setChoice] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  // Dernier message affiché : conservé pendant l'animation de fermeture
  const last = useRef<ChatMessage | null>(null);
  if (message) last.current = message;
  const m = message ?? last.current;
  const fromCentrale = m?.author_type === "user";

  useEffect(() => {
    if (!message) return;
    setStep("actions");
    setChoice(null);
    setDetail("");
  }, [message]);

  async function send() {
    if (!m || busy) return;
    setBusy(true);
    await onReport(m, choice, detail);
    setBusy(false);
  }

  return (
    <BottomSheet visible={!!message} onClose={onClose} keyboard dismissable={!busy}>
      {m && step === "actions" && (
        <>
          <View style={{ gap: space.xs }}>
            <Text style={styles.sheetTitle} accessibilityRole="header">Message de {authorLabel(m)}</Text>
            <Text style={styles.sheetQuote} numberOfLines={3}>{m.body}</Text>
          </View>
          <ActionRow icon="flag-outline" title="Signaler ce message" hint={frTypo(REPORT_OUTCOME)} onPress={() => setStep("report")} />
          {m.author_type === "driver" && m.author_driver_id && (
            <ActionRow
              icon="eye-off-outline"
              title="Masquer les messages de ce chauffeur"
              hint={`Vous ne verrez plus les messages de ${m.author_name}`}
              onPress={() => onBlock(m)}
            />
          )}
          <BigButton title="Annuler" variant="ghost" height={control.sm} onPress={onClose} />
        </>
      )}
      {m && step === "report" && (
        <>
          <View style={{ gap: space.xs }}>
            <Text style={styles.sheetTitle} accessibilityRole="header">Signaler ce message</Text>
            <Text style={styles.sheetText}>
              {frTypo(fromCentrale ? `Ce message vient de votre centrale. ${REPORT_OUTCOME}` : `${REPORT_OUTCOME} Motif facultatif :`)}
            </Text>
          </View>
          {fromCentrale && (
            <>
              <PublisherRecourse messageId={m.id} />
              <Text style={styles.sheetText}>{frTypo("Motif facultatif :")}</Text>
            </>
          )}
          <View style={styles.reasons}>
            {CHAT_REPORT_REASONS.map((r) => {
              const on = choice === r;
              return (
                <Pressable
                  key={r}
                  onPress={() => setChoice(on ? null : r)}
                  style={({ pressed }) => [styles.reason, on && styles.reasonOn, pressed && { backgroundColor: colors.surface3 }]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={r}
                >
                  {on && <Ionicons name="checkmark" size={18} color={colors.fg} />}
                  <Text style={[styles.reasonText, on && { color: colors.fg }]}>{r}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={detail}
            onChangeText={setDetail}
            placeholder="Précisez (facultatif)"
            placeholderTextColor={colors.muted}
            style={styles.reasonInput}
            maxLength={CHAT_REPORT_REASON_MAX}
            multiline
            accessibilityLabel="Précision sur le signalement, facultative"
          />
          <BigButton title="Envoyer le signalement" icon="flag-outline" height={control.md} loading={busy} onPress={() => void send()} />
          <BigButton title="Retour" variant="ghost" height={control.sm} disabled={busy} onPress={() => setStep("actions")} />
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  call: { width: 44, height: 44, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  top: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: colors.line },
  scope: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, lineHeight: 18, paddingHorizontal: 2 },
  scopeRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  // Cible tactile de 48 px (le texte reste discret)
  blockedLink: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: control.sm, paddingHorizontal: space.xs },
  blockedLinkText: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  list: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg, gap: 2 },
  empty: { color: colors.muted, fontSize: type.body, textAlign: "center", paddingHorizontal: space.xxl },
  day: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: space.md },
  dayLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dayText: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium },
  bubbleRow: { flexDirection: "row" },
  author: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, marginBottom: space.xs, marginLeft: space.xs },
  bubble: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 7, borderRadius: radius.lg, gap: 3 },
  // Mes messages : fond clair neutre (la couleur de marque reste réservée à « en ligne » et à l'action principale)
  mine: { backgroundColor: colors.fg, borderBottomRightRadius: radius.sm / 2 },
  mineText: { color: colors.bg },
  mineTime: { color: alpha(colors.bg, 0.6) },
  theirs: { backgroundColor: colors.surface2, borderBottomLeftRadius: radius.sm / 2, borderWidth: 1, borderColor: colors.line },
  theirsPressed: { backgroundColor: colors.surface3 },
  body: { color: colors.fg, fontSize: type.callout, fontWeight: weight.regular, lineHeight: 22 },
  time: { color: colors.muted, fontSize: type.caption, fontWeight: weight.medium, alignSelf: "flex-end", ...mono },
  seen: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.xs, marginRight: space.xs },
  seenText: { color: colors.muted, fontSize: type.caption, fontWeight: weight.medium },
  system: { color: colors.muted, fontSize: type.footnote, textAlign: "center", marginVertical: 6 },
  composer: { borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingTop: 10, paddingBottom: 10, gap: 10 },
  // Règles d'usage : ligne discrète (métadonnée, 13 pt), jamais en couleur ; lien vers les CGU souligné
  rules: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.regular, lineHeight: 18, paddingHorizontal: space.lg },
  rulesLink: { color: colors.fg, fontWeight: weight.medium, textDecorationLine: "underline" },
  replies: { gap: space.sm, paddingHorizontal: space.md },
  reply: {
    height: control.sm, paddingHorizontal: space.lg, borderRadius: radius.md, justifyContent: "center",
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  replyText: { color: colors.fg, fontSize: type.body, fontWeight: weight.medium },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: space.md },
  input: {
    flex: 1, minHeight: control.sm, maxHeight: 130, borderRadius: radius.md, paddingHorizontal: 14, paddingTop: 13, paddingBottom: 13,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, color: colors.fg, fontSize: type.callout,
  },
  send: { width: control.sm, height: control.sm, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  sendOff: { backgroundColor: colors.surface3 },
  action: {
    minHeight: control.md, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.md, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong,
  },
  actionText: { flex: 1, color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, lineHeight: 22 },
  sheetTitle: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold },
  sheetText: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  sheetQuote: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  recourse: { gap: 2 },
  // Cible tactile de 48 px
  recourseLink: { flexDirection: "row", alignItems: "center", gap: space.sm, alignSelf: "flex-start", minHeight: control.sm, maxWidth: "100%" },
  recourseText: { flexShrink: 1, color: colors.fg, fontSize: type.subhead, fontWeight: weight.medium, textDecorationLine: "underline" },
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  reason: {
    minHeight: control.sm, paddingHorizontal: space.lg, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  reasonOn: { backgroundColor: colors.surface3, borderColor: colors.lineStrong },
  reasonText: { color: colors.muted, fontSize: type.body, fontWeight: weight.medium },
  reasonInput: {
    minHeight: control.sm, maxHeight: 110, borderRadius: radius.md, paddingHorizontal: 14, paddingTop: 13, paddingBottom: 13,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, color: colors.fg, fontSize: type.callout,
  },
  blockedRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  blockedName: { flex: 1, color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
});
