// Signalements de la flotte : envoi (gros boutons), feuille « Signaler », carte d'un signalement + votes.
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_BUTTONS, FLEET_REPORT_META, formatDistance, haversine, type ChatMessage, type FleetReportType } from "@rydar/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDriver } from "@/hooks/driver-context";
import { useNow } from "@/hooks/use-now";
import { api, type ApiError } from "@/lib/api";
import { ago, colors } from "@/theme";
import { hapticResult, Sheet } from "./ui";

type Pos = { lat: number; lng: number } | null | undefined;
/** Signalement affiché : message du fil flotte, avec distance et vote quand ils sont connus. */
export type ReportView = ChatMessage & { distance_m?: number | null; my_vote?: boolean | null };
export type FlashFn = (text: string, tone?: "success" | "error" | "info") => void;

const metaOf = (t: FleetReportType | null | undefined) => FLEET_REPORT_META[t ?? "other"] ?? FLEET_REPORT_META.other;

/** Textes par défaut posés par send_chat_message (signalement sans commentaire) : inutile de les répéter sous le titre. */
const DEFAULT_BODY: Record<FleetReportType, string> = {
  police: "Contrôle de police signalé",
  control: "Contrôle VTC signalé",
  accident: "Accident signalé",
  traffic: "Bouchon signalé",
  danger: "Danger sur la route",
  other: "Signalement de la flotte",
};

/** Envoi d'un signalement à la position actuelle (sinon dernière position connue côté serveur). */
export function useReportSender(me: Pos) {
  const { refreshChat } = useDriver();
  const [sending, setSending] = useState<FleetReportType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const send = useCallback(
    async (type: FleetReportType) => {
      if (busy.current) return false;
      busy.current = true;
      setSending(type);
      setError(null);
      try {
        await api.sendMessage({ channel: "fleet", reportType: type, lat: me?.lat ?? null, lng: me?.lng ?? null });
        hapticResult(true);
        void refreshChat();
        return true;
      } catch (e) {
        hapticResult(false);
        const err = e as ApiError;
        setError(err.code === "LOCATION_REQUIRED" ? "Position GPS introuvable : activez la localisation puis réessayez." : err.message);
        return false;
      } finally {
        busy.current = false;
        setSending(null);
      }
    },
    [me?.lat, me?.lng, refreshChat],
  );
  return { send, sending, error, setError };
}

/** Gros bouton de signalement (emoji + libellé), utilisable au volant. */
export function ReportButton({
  type, onPress, loading, disabled, compact, style,
}: { type: FleetReportType; onPress: () => void; loading?: boolean; disabled?: boolean; compact?: boolean; style?: StyleProp<ViewStyle> }) {
  const meta = metaOf(type);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Signaler : ${meta.label}`}
      style={({ pressed }) => [
        compact ? styles.btnCompact : styles.btn,
        { backgroundColor: `${meta.color}1A`, borderColor: `${meta.color}47`, opacity: disabled && !loading ? 0.5 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={meta.color} />
      ) : (
        <Text style={compact ? styles.emojiCompact : styles.emoji}>{meta.emoji}</Text>
      )}
      <Text style={[compact ? styles.btnLabelCompact : styles.btnLabel]} numberOfLines={1}>
        {compact ? meta.short : meta.label}
      </Text>
    </Pressable>
  );
}

/** Feuille « Signaler à la flotte » : 5 gros boutons, envoi immédiat à la position actuelle. */
export function ReportSheet({ visible, onClose, onSent, me }: { visible: boolean; onClose: () => void; onSent: (type: FleetReportType) => void; me: Pos }) {
  const { send, sending, error, setError } = useReportSender(me);
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setError(null);
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 70 }).start();
    } else Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setMounted(false));
  }, [visible, anim, setError]);

  if (!mounted) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 40 }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Fermer" />
      </Animated.View>
      <Animated.View style={[styles.sheetWrap, { transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [520, 0] }) }] }]}>
        <Sheet>
          <SafeAreaView edges={["bottom"]} style={{ gap: 16, paddingBottom: 14 }}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>Signaler à la flotte</Text>
                <Text style={styles.sheetSub}>Un appui suffit : votre position actuelle est partagée avec les chauffeurs proches.</Text>
              </View>
              <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Fermer" hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.fg} />
              </Pressable>
            </View>
            <View style={styles.grid}>
              {FLEET_REPORT_BUTTONS.map((t, i) => (
                <ReportButton
                  key={t}
                  type={t}
                  loading={sending === t}
                  disabled={sending != null}
                  style={i === FLEET_REPORT_BUTTONS.length - 1 && FLEET_REPORT_BUTTONS.length % 2 === 1 ? { flexBasis: "100%" } : null}
                  onPress={async () => {
                    if (await send(t)) onSent(t);
                  }}
                />
              ))}
            </View>
            {error && (
              <View style={styles.error} accessibilityLiveRegion="assertive">
                <Ionicons name="alert-circle" size={20} color={colors.red} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </SafeAreaView>
        </Sheet>
      </Animated.View>
    </View>
  );
}

/** Rangée compacte de signalements rapides (haut du fil « Flotte »). */
export function QuickReportRow({ me, onSent, onError }: { me: Pos; onSent: (type: FleetReportType) => void; onError: FlashFn }) {
  const { send, sending, error } = useReportSender(me);
  useEffect(() => {
    if (error) onError(error, "error");
  }, [error, onError]);
  return (
    <View style={styles.row}>
      {FLEET_REPORT_BUTTONS.map((t) => (
        <ReportButton
          key={t}
          type={t}
          compact
          loading={sending === t}
          disabled={sending != null}
          onPress={async () => {
            if (await send(t)) onSent(t);
          }}
        />
      ))}
    </View>
  );
}

/** Ligne d'information : « signalé par Karim T. · il y a 6 min · confirmé 2× ». */
export function reportMetaLine(r: ReportView, myDriverId: string | null | undefined, now = Date.now()) {
  const who = r.author_driver_id && r.author_driver_id === myDriverId ? "vous" : r.author_name;
  const parts = [`signalé par ${who}`, ago(r.created_at, now)];
  if (r.confirmations > 0) parts.push(`confirmé ${r.confirmations}×`);
  return parts.join(" · ");
}

/**
 * Carte d'un signalement : type, auteur, âge, confirmations, distance, et votes « Toujours là » / « Plus là »
 * (vote_fleet_report, idempotent : un second appui identique ne compte pas deux fois).
 */
export function ReportCard({
  report, me, myDriverId, onClose, onFlash, onExpired, variant = "floating", style,
}: {
  report: ReportView; me: Pos; myDriverId: string | null | undefined; onClose?: () => void; onFlash: FlashFn; onExpired?: () => void;
  variant?: "floating" | "feed"; style?: StyleProp<ViewStyle>;
}) {
  const { refreshChat } = useDriver();
  const now = useNow(30_000);
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [vote, setVote] = useState<boolean | null>(report.my_vote ?? null);
  useEffect(() => setVote(report.my_vote ?? null), [report.id, report.my_vote]);

  const meta = metaOf(report.report_type);
  const mine = !!myDriverId && report.author_driver_id === myDriverId;
  const active = report.active && (!report.expires_at || new Date(report.expires_at).getTime() > now);
  const distance = me && report.lat != null && report.lng != null ? haversine(me, { lat: report.lat, lng: report.lng }) : report.distance_m ?? null;

  async function doVote(still: boolean) {
    if (busy) return;
    setBusy(still ? "yes" : "no");
    try {
      const res = await api.voteReport(report.id, still);
      if (!res.ok) {
        hapticResult(false);
        onFlash(res.message ?? "Ce signalement a expiré.", "info");
        onExpired?.();
      } else {
        hapticResult(true);
        setVote(still);
        if (res.expired) {
          onFlash("Signalement retiré de la carte");
          onExpired?.();
        } else onFlash(still ? "Merci, signalement confirmé" : "Merci, c'est noté");
      }
    } catch (e) {
      hapticResult(false);
      onFlash((e as Error).message, "error");
    } finally {
      setBusy(null);
      void refreshChat();
    }
  }

  const feed = variant === "feed";
  return (
    <View style={[feed ? styles.feedCard : styles.card, { borderColor: active ? `${meta.color}40` : colors.line, opacity: active ? 1 : 0.6 }, style]}>
      <View style={styles.cardHead}>
        <View style={[feed ? styles.cardIconSmall : styles.cardIcon, { backgroundColor: `${meta.color}1F`, borderColor: `${meta.color}66` }]}>
          <Text style={feed ? styles.cardEmojiSmall : styles.cardEmoji}>{meta.emoji}</Text>
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[styles.cardTitle, feed && { fontSize: 17 }]} numberOfLines={1}>{meta.label}</Text>
            {distance != null && active ? (
              <View style={styles.dist}>
                <Ionicons name="navigate" size={11} color={colors.fg} />
                <Text style={styles.distText}>{formatDistance(distance)}</Text>
              </View>
            ) : null}
            {!active && <Text style={styles.ended}>Terminé</Text>}
          </View>
          <Text style={styles.cardMeta} numberOfLines={2}>{reportMetaLine(report, myDriverId, now)}</Text>
        </View>
        {onClose && (
          <Pressable onPress={onClose} style={styles.cardClose} accessibilityLabel="Fermer" hitSlop={8}>
            <Ionicons name="close" size={18} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {feed && report.body && report.body !== DEFAULT_BODY[report.report_type ?? "other"] ? <Text style={styles.cardBody}>{report.body}</Text> : null}
      {active && (
        <View style={styles.votes}>
          <Pressable
            onPress={() => void doVote(true)}
            disabled={busy != null}
            accessibilityRole="button"
            accessibilityState={{ selected: vote === true }}
            style={({ pressed }) => [styles.vote, feed && { height: 44 }, vote === true && styles.voteYes, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}
          >
            {busy === "yes" ? <ActivityIndicator color={colors.brand} /> : <Ionicons name="checkmark-circle" size={feed ? 18 : 20} color={vote === true ? colors.brandFg : colors.brand} />}
            <Text style={[styles.voteText, vote === true && { color: colors.brandFg }]}>Toujours là</Text>
          </Pressable>
          <Pressable
            onPress={() => void doVote(false)}
            disabled={busy != null}
            accessibilityRole="button"
            accessibilityState={{ selected: vote === false }}
            style={({ pressed }) => [styles.vote, feed && { height: 44 }, vote === false && styles.voteNo, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}
          >
            {busy === "no" ? <ActivityIndicator color={colors.muted} /> : <Ionicons name={mine ? "trash-outline" : "close-circle"} size={feed ? 18 : 20} color={vote === false ? colors.fg : colors.muted} />}
            <Text style={[styles.voteText, { color: vote === false ? colors.fg : colors.muted }]}>{mine ? "Retirer" : "Plus là"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(4,5,7,0.62)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetTitle: { color: colors.fg, fontSize: 24, fontWeight: "900", letterSpacing: -0.4 },
  sheetSub: { color: colors.muted, fontSize: 14, marginTop: 4, lineHeight: 19 },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  btn: { flexGrow: 1, flexBasis: "46%", height: 96, borderRadius: 22, borderWidth: 1.5, alignItems: "center", justifyContent: "center", gap: 6 },
  emoji: { fontSize: 34, lineHeight: 40 },
  btnLabel: { color: colors.fg, fontSize: 16, fontWeight: "800" },
  row: { flexDirection: "row", gap: 8 },
  btnCompact: { flex: 1, height: 74, borderRadius: 18, borderWidth: 1.5, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 2 },
  emojiCompact: { fontSize: 25, lineHeight: 30 },
  btnLabelCompact: { color: colors.fg, fontSize: 11.5, fontWeight: "800" },
  error: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 16, backgroundColor: "rgba(242,85,90,0.12)", borderWidth: 1, borderColor: "rgba(242,85,90,0.3)" },
  errorText: { flex: 1, color: colors.fg, fontSize: 15, fontWeight: "700" },
  card: {
    backgroundColor: "rgba(17,19,24,0.98)", borderRadius: 24, borderWidth: 1.5, padding: 16, gap: 14,
    shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 14,
  },
  feedCard: { backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, padding: 14, gap: 12 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIcon: { width: 50, height: 50, borderRadius: 25, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  cardEmoji: { fontSize: 26, lineHeight: 32 },
  cardIconSmall: { width: 42, height: 42, borderRadius: 21, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  cardEmojiSmall: { fontSize: 21, lineHeight: 26 },
  cardTitle: { color: colors.fg, fontSize: 19, fontWeight: "900", letterSpacing: -0.3, flexShrink: 1 },
  cardMeta: { color: colors.muted, fontSize: 13.5, lineHeight: 18 },
  cardBody: { color: colors.fg, fontSize: 15, lineHeight: 21 },
  ended: { color: colors.subtle, fontSize: 12, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.surface3, overflow: "hidden" },
  dist: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.surface3 },
  distText: { color: colors.fg, fontSize: 13, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardClose: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2, marginLeft: -2 },
  votes: { flexDirection: "row", gap: 10 },
  vote: { flex: 1, height: 52, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line },
  voteYes: { backgroundColor: colors.brand, borderColor: colors.brand },
  voteNo: { backgroundColor: colors.surface3, borderColor: colors.lineStrong },
  voteText: { color: colors.fg, fontSize: 15.5, fontWeight: "800" },
});
