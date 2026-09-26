// Messagerie chauffeur : conversation privée avec la centrale (« Ma centrale ») et fil commun à tous les
// chauffeurs de la centrale (« Chauffeurs » : messages et signalements).
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_META, formatTime, type ChatMessage } from "@rydar/shared";
import { useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { ReportCard, ReportSheet, type ReportView } from "@/components/fleet-report";
import { BigButton, hapticResult, Screen, ScreenHeader, Segmented, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
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

type Pending = { key: string; body: string; tab: ChatTab };
type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: ChatMessage; mine: boolean; first: boolean; seen: boolean }
  | { kind: "report"; key: string; r: ReportView }
  | { kind: "pending"; key: string; body: string };

export default function Messages() {
  const { chat, refreshChat, home } = useDriver();
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
  const scroll = useRef<ScrollView>(null);
  const tz = home?.organization.timezone;
  const myId = home?.driver.id;
  const orgName = home?.organization.name?.trim() || "votre centrale";

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
  }, [thread, chat?.reports, chat?.dispatch.seen_by_dispatch_at, tab, tz, myId, pending]);

  async function send(raw: string) {
    const body = raw.trim();
    if (!body || sending) return;
    const key = `p-${Date.now()}`;
    const target = tab;
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
  }

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
          <Text style={styles.scope} numberOfLines={2}>
            {tab === "dispatch" ? `Conversation privée avec ${orgName}` : `Visible par tous les chauffeurs ${deName(orgName)}`}
          </Text>
          {tab === "fleet" && (
            <BigButton
              title="Signaler un incident"
              variant="secondary"
              icon="flag-outline"
              height={control.sm}
              onPress={() => setReporting(true)}
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
                  return <ReportCard key={row.key} variant="feed" report={row.r} me={me} myDriverId={myId} onFlash={flash.show} style={{ marginVertical: space.xs }} />;
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
                const author = m.author_type === "user" ? `${m.author_name} · Centrale` : m.author_name;
                const time = formatTime(m.created_at, tz);
                return (
                  <View key={row.key} style={[styles.bubbleRow, { justifyContent: mine ? "flex-end" : "flex-start", marginTop: first ? space.sm : 2 }]}>
                    <View style={{ maxWidth: "82%", alignItems: mine ? "flex-end" : "flex-start" }}>
                      {!mine && first && <Text style={styles.author}>{author}</Text>}
                      <View
                        style={[styles.bubble, mine ? styles.mine : styles.theirs]}
                        accessible
                        accessibilityLabel={`${mine ? "Vous" : author}, ${time}${NBSP}: ${m.body}`}
                      >
                        <Text style={[styles.body, mine && styles.mineText]}>{m.body}</Text>
                        <Text style={[styles.time, mine && styles.mineTime]}>{time}</Text>
                      </View>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  call: { width: 44, height: 44, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  top: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: colors.line },
  scope: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, lineHeight: 18, paddingHorizontal: 2 },
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
  body: { color: colors.fg, fontSize: type.callout, fontWeight: weight.regular, lineHeight: 22 },
  time: { color: colors.muted, fontSize: type.caption, fontWeight: weight.medium, alignSelf: "flex-end", ...mono },
  seen: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.xs, marginRight: space.xs },
  seenText: { color: colors.muted, fontSize: type.caption, fontWeight: weight.medium },
  system: { color: colors.muted, fontSize: type.footnote, textAlign: "center", marginVertical: 6 },
  composer: { borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingTop: 10, paddingBottom: 10, gap: 10 },
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
});
