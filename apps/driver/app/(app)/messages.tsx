// Messagerie chauffeur : fil direct avec la centrale + fil de la flotte (messages et signalements).
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_META, formatTime, type ChatMessage } from "@rydar/shared";
import { useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { QuickReportRow, ReportCard, type ReportView } from "@/components/fleet-report";
import { hapticResult, Screen, ScreenHeader, Segmented, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
import { chatSession, type ChatTab } from "@/lib/chat-session";
import { useAppEvent } from "@/lib/events";
import { colors } from "@/theme";

const QUICK_REPLIES = ["J'arrive", "Bien reçu", "Client en retard", "Je suis sur place"];

const dayKey = (d: string | Date, timeZone?: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

/** « Aujourd'hui », « Hier », « lundi 22 septembre » */
function dayLabel(d: string, timeZone?: string) {
  const key = dayKey(d, timeZone);
  const now = Date.now();
  if (key === dayKey(new Date(now), timeZone)) return "Aujourd'hui";
  if (key === dayKey(new Date(now - 86_400_000), timeZone)) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone }).format(new Date(d));
}

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
  const scroll = useRef<ScrollView>(null);
  const tz = home?.organization.timezone;
  const myId = home?.driver.id;

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
      flash.show((e as Error).message, "error");
    } finally {
      setPending((p) => p.filter((x) => x.key !== key));
      setSending(false);
    }
  }

  const phone = home?.organization.phone;
  const empty = !rows.some((r) => r.kind !== "day");

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader
          title="Messages"
          right={
            phone ? (
              <Pressable onPress={() => void Linking.openURL(`tel:${phone}`)} style={styles.call} accessibilityLabel="Appeler la centrale" hitSlop={6}>
                <Ionicons name="call" size={19} color={colors.brandFg} />
              </Pressable>
            ) : undefined
          }
        />
        <Segmented
          style={{ marginHorizontal: 16, marginBottom: 6 }}
          value={tab}
          onChange={setTab}
          options={[
            { value: "dispatch", label: "Centrale", badge: chat?.dispatch.unread ?? 0 },
            { value: "fleet", label: "Flotte", badge: chat?.fleet.unread ?? 0 },
          ]}
        />

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          {tab === "fleet" && (
            <View style={styles.quick}>
              <QuickReportRow me={me} onError={flash.show} onSent={(t) => flash.show(`${FLEET_REPORT_META[t].emoji}  Signalé à la flotte`)} />
            </View>
          )}

          <ScrollView
            ref={scroll}
            style={{ flex: 1 }}
            contentContainerStyle={[styles.list, empty && { flex: 1, justifyContent: "center" }]}
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {!chat ? (
              <ActivityIndicator color={colors.brand} />
            ) : empty ? (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}>
                  <Ionicons name={tab === "dispatch" ? "chatbubbles-outline" : "radio-outline"} size={30} color={colors.brand} />
                </View>
                <Text style={styles.emptyTitle}>{tab === "dispatch" ? "Aucun message" : "Rien à signaler"}</Text>
                <Text style={styles.emptyText}>
                  {tab === "dispatch"
                    ? "Écrivez à votre centrale ou touchez une réponse rapide."
                    : "Les signalements et messages de vos collègues apparaissent ici."}
                </Text>
              </View>
            ) : (
              rows.map((row) => {
                if (row.kind === "day") {
                  return (
                    <View key={row.key} style={styles.day}>
                      <View style={styles.dayLine} />
                      <Text style={styles.dayText}>{row.label}</Text>
                      <View style={styles.dayLine} />
                    </View>
                  );
                }
                if (row.kind === "report") {
                  return <ReportCard key={row.key} variant="feed" report={row.r} me={me} myDriverId={myId} onFlash={flash.show} style={{ marginVertical: 4 }} />;
                }
                if (row.kind === "pending") {
                  return (
                    <View key={row.key} style={[styles.bubbleRow, { justifyContent: "flex-end" }]}>
                      <View style={[styles.bubble, styles.mine, { opacity: 0.6 }]}>
                        <Text style={[styles.body, { color: colors.brandFg }]}>{row.body}</Text>
                        <Text style={[styles.time, { color: "rgba(11,13,4,0.6)" }]}>Envoi…</Text>
                      </View>
                    </View>
                  );
                }
                const { m, mine, first, seen } = row;
                if (m.author_type === "system") {
                  return <Text key={row.key} style={styles.system}>{m.body}</Text>;
                }
                return (
                  <View key={row.key} style={[styles.bubbleRow, { justifyContent: mine ? "flex-end" : "flex-start", marginTop: first ? 8 : 2 }]}>
                    <View style={{ maxWidth: "82%", alignItems: mine ? "flex-end" : "flex-start" }}>
                      {!mine && first && (
                        <Text style={styles.author}>
                          {m.author_type === "user" ? `${m.author_name} · Centrale` : m.author_name}
                        </Text>
                      )}
                      <View style={[styles.bubble, mine ? styles.mine : m.author_type === "user" ? styles.dispatch : styles.theirs]}>
                        <Text style={[styles.body, mine && { color: colors.brandFg }]}>{m.body}</Text>
                        <Text style={[styles.time, mine && { color: "rgba(11,13,4,0.6)" }]}>{formatTime(m.created_at, tz)}</Text>
                      </View>
                      {seen && (
                        <View style={styles.seen}>
                          <Ionicons name="checkmark-done" size={14} color={colors.brand} />
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
                    style={({ pressed }) => [styles.reply, { opacity: sending ? 0.5 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Réponse rapide : ${q}`}
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
                placeholder={tab === "dispatch" ? "Message à la centrale…" : "Message à la flotte…"}
                placeholderTextColor={colors.subtle}
                style={styles.input}
                multiline
                maxLength={1000}
                onSubmitEditing={() => void send(text)}
                submitBehavior="submit"
                returnKeyType="send"
                accessibilityLabel="Votre message"
              />
              <Pressable
                onPress={() => void send(text)}
                disabled={!text.trim() || sending}
                style={({ pressed }) => [styles.send, { opacity: !text.trim() ? 0.4 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
                accessibilityRole="button"
                accessibilityLabel="Envoyer"
              >
                {sending ? <ActivityIndicator color={colors.brandFg} /> : <Ionicons name="arrow-up" size={24} color={colors.brandFg} />}
              </Pressable>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      {flash.node}
    </Screen>
  );
}

const styles = StyleSheet.create({
  call: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.brand },
  quick: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, borderBottomWidth: 1, borderColor: colors.line },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 2 },
  day: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 12 },
  dayLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dayText: { color: colors.subtle, fontSize: 12.5, fontWeight: "700", textTransform: "capitalize" },
  bubbleRow: { flexDirection: "row" },
  author: { color: colors.muted, fontSize: 12.5, fontWeight: "700", marginBottom: 4, marginLeft: 6 },
  bubble: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 7, borderRadius: 20, gap: 3 },
  mine: { backgroundColor: colors.brand, borderBottomRightRadius: 6 },
  dispatch: { backgroundColor: colors.surface3, borderBottomLeftRadius: 6, borderWidth: 1, borderColor: "rgba(179,157,250,0.28)" },
  theirs: { backgroundColor: colors.surface2, borderBottomLeftRadius: 6, borderWidth: 1, borderColor: colors.line },
  body: { color: colors.fg, fontSize: 16, lineHeight: 22 },
  time: { color: colors.subtle, fontSize: 11, fontWeight: "600", alignSelf: "flex-end", fontVariant: ["tabular-nums"] },
  seen: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4, marginRight: 4 },
  seenText: { color: colors.subtle, fontSize: 11.5, fontWeight: "600" },
  system: { color: colors.subtle, fontSize: 13, textAlign: "center", marginVertical: 6 },
  empty: { alignItems: "center", gap: 10, paddingHorizontal: 30 },
  emptyIcon: { width: 68, height: 68, borderRadius: 34, backgroundColor: "rgba(200,240,60,0.1)", alignItems: "center", justifyContent: "center", marginBottom: 4 },
  emptyTitle: { color: colors.fg, fontSize: 19, fontWeight: "800" },
  emptyText: { color: colors.muted, fontSize: 14.5, textAlign: "center", lineHeight: 20 },
  composer: { borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingTop: 10, paddingBottom: 10, gap: 10 },
  replies: { gap: 8, paddingHorizontal: 12 },
  reply: { height: 40, paddingHorizontal: 16, borderRadius: 20, justifyContent: "center", backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong },
  replyText: { color: colors.fg, fontSize: 14.5, fontWeight: "700" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 12 },
  input: {
    flex: 1, minHeight: 50, maxHeight: 130, borderRadius: 25, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 14,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, color: colors.fg, fontSize: 16,
  },
  send: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
});
