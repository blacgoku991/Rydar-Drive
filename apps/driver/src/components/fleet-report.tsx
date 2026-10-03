// Signalements de la flotte : envoi (grandes tuiles), feuille « Signaler », carte d'un signalement + votes.
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_BUTTONS, FLEET_REPORT_META, formatDistance, haversine, type ChatMessage, type FleetReportType } from "@rydar/shared";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useDriver } from "@/hooks/driver-context";
import { lastPosition } from "@/hooks/use-my-position";
import { useNow } from "@/hooks/use-now";
import { api, type ApiError } from "@/lib/api";
import { ago, alpha, colors, control, mono, radius, space, type, weight } from "@/theme";
import { frTypo } from "./centrale";
import { BottomSheet, hapticResult, Pill } from "./ui";

type IconName = keyof typeof Ionicons.glyphMap;
type Pos = { lat: number; lng: number; accuracy?: number | null; at?: number | null } | null | undefined;
/** Signalement affiché : message du fil flotte, avec distance et vote quand ils sont connus. */
export type ReportView = ChatMessage & { distance_m?: number | null; my_vote?: boolean | null };
export type FlashFn = (text: string, tone?: "success" | "error" | "info") => void;

const NBSP = " ";
const metaOf = (t: FleetReportType | null | undefined) => FLEET_REPORT_META[t ?? "other"] ?? FLEET_REPORT_META.other;
const iconOf = (t: FleetReportType | null | undefined) => metaOf(t).ionicon as IconName;

/** Textes par défaut posés par send_chat_message (signalement sans commentaire) : inutile de les répéter sous le titre. */
const DEFAULT_BODY: Record<FleetReportType, string> = {
  police: "Contrôle de police signalé",
  control: "Contrôle VTC signalé",
  accident: "Accident signalé",
  traffic: "Bouchon signalé",
  danger: "Danger sur la route",
  other: "Signalement de la flotte",
};

/** Position assez précise et récente pour être envoyée telle quelle. */
const GOOD_ACCURACY_M = 50;
const FRESH_MS = 10_000;
/** Attente maximale d'un point GPS précis avant l'envoi (sinon : dernière position connue, si assez récente). */
const FIX_TIMEOUT_MS = 5_000;
/** Âge maximal de la position connue envoyée faute de point GPS (comme les positions du suivi, lib/location). */
const KNOWN_MAX_AGE_MS = 120_000;

type Fix = { lat: number; lng: number; accuracy: number | null; at: number };

function toFix(p: Pos): Fix | null {
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, at: p.at ?? 0 };
}

/**
 * Point à envoyer : la position connue si elle est précise (≤ 50 m) et récente (≤ 10 s) ; sinon un point GPS
 * « haute précision » demandé à l'instant (5 s au plus), ou à défaut la position connue.
 */
async function reportPosition(known: Fix | null, onLocating: (v: boolean) => void): Promise<Fix | null> {
  const fresh = known && Date.now() - known.at <= FRESH_MS;
  if (known && fresh && known.accuracy != null && known.accuracy <= GOOD_ACCURACY_M) return known;
  onLocating(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FIX_TIMEOUT_MS);
      }),
    ]);
    // Pas de point GPS à l'instant : la position connue seulement si elle date de moins de 2 min. Plus ancienne (celle
    // du matin…), le signalement partirait au mauvais endroit : rien n'est envoyé, le serveur applique sa règle
    // (dernière position enregistrée de moins de 15 min, sinon LOCATION_REQUIRED, message déjà prévu)
    if (!fix) return known && Date.now() - known.at <= KNOWN_MAX_AGE_MS ? known : null;
    const next: Fix = {
      lat: fix.coords.latitude,
      lng: fix.coords.longitude,
      accuracy: fix.coords.accuracy != null && fix.coords.accuracy > 0 ? fix.coords.accuracy : null,
      at: fix.timestamp || Date.now(),
    };
    // Point obtenu moins précis qu'une position connue encore récente : on garde la position connue
    if (known && fresh && known.accuracy != null && next.accuracy != null && next.accuracy > known.accuracy) return known;
    return next;
  } finally {
    clearTimeout(timer);
    onLocating(false);
  }
}

/** Envoi d'un signalement à la position actuelle (sinon dernière position connue côté serveur). */
export function useReportSender(me: Pos) {
  const { refreshChat } = useDriver();
  const [sending, setSending] = useState<FleetReportType | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const meRef = useRef(me);
  meRef.current = me;
  const send = useCallback(
    async (kind: FleetReportType) => {
      if (busy.current) return false;
      busy.current = true;
      setSending(kind);
      setError(null);
      try {
        // Position la plus récente entre celle de l'écran et le flux GPS partagé
        const a = toFix(meRef.current);
        const b = toFix(lastPosition());
        const known = a && b ? (b.at > a.at ? b : a) : a ?? b;
        const pos = await reportPosition(known, setLocating);
        await api.sendMessage({ channel: "fleet", reportType: kind, lat: pos?.lat ?? null, lng: pos?.lng ?? null });
        hapticResult(true);
        void refreshChat();
        return true;
      } catch (e) {
        hapticResult(false);
        const err = e as ApiError;
        // Autorisation acquise avant l'ouverture de la feuille (prepareFleetReport) : il manque un point GPS
        setError(
          frTypo(
            err.code === "LOCATION_REQUIRED"
              ? "Position introuvable : vérifiez que la localisation du téléphone est activée, placez-vous à découvert puis réessayez."
              : err.message || "Envoi impossible. Réessayez.",
          ),
        );
        return false;
      } finally {
        busy.current = false;
        setSending(null);
      }
    },
    [refreshChat],
  );
  return { send, sending, locating, error, setError };
}

/** Tuile de signalement (pictogramme + libellé), utilisable au volant. */
export function ReportButton({
  type: kind, onPress, loading, disabled, compact, style,
}: { type: FleetReportType; onPress: () => void; loading?: boolean; disabled?: boolean; compact?: boolean; style?: StyleProp<ViewStyle> }) {
  const meta = metaOf(kind);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Signaler${NBSP}: ${meta.label}`}
      accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(loading) }}
      style={({ pressed }) => [
        compact ? styles.tileCompact : styles.tile,
        pressed && { backgroundColor: colors.surface3 },
        disabled && !loading && { opacity: 0.5 },
        style,
      ]}
    >
      <View style={compact ? styles.tileIconCompact : styles.tileIcon}>
        {loading ? (
          <ActivityIndicator color={colors.fg} />
        ) : (
          <Ionicons name={iconOf(kind)} size={compact ? 22 : 26} color={meta.color} />
        )}
      </View>
      <Text style={compact ? styles.tileLabelCompact : styles.tileLabel} numberOfLines={1}>
        {compact ? meta.short : meta.label}
      </Text>
    </Pressable>
  );
}

/** Feuille « Signaler » : 5 tuiles, envoi immédiat à la position actuelle. */
export function ReportSheet({ visible, onClose, onSent, me }: { visible: boolean; onClose: () => void; onSent: (type: FleetReportType) => void; me: Pos }) {
  const { send, sending, locating, error, setError } = useReportSender(me);

  useEffect(() => {
    if (visible) setError(null);
  }, [visible, setError]);

  const last = FLEET_REPORT_BUTTONS.length - 1;
  const odd = FLEET_REPORT_BUTTONS.length % 2 === 1;
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.sheetHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sheetTitle} accessibilityRole="header">Signaler</Text>
          <Text style={styles.sheetSub}>Votre position actuelle est envoyée aux chauffeurs à proximité.</Text>
        </View>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && { backgroundColor: colors.surface2 }]}
          accessibilityRole="button"
          accessibilityLabel="Fermer"
          hitSlop={4}
        >
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
            style={i === last && odd ? { flexBasis: "100%" } : null}
            onPress={async () => {
              if (await send(t)) onSent(t);
            }}
          />
        ))}
      </View>
      {locating && (
        <View style={styles.hint} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={colors.muted} />
          <Text style={styles.hintText}>Recherche de votre position précise…</Text>
        </View>
      )}
      {error && (
        <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Ionicons name="alert-circle-outline" size={20} color={colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </BottomSheet>
  );
}

/** Ligne d'information : « Signalé par Karim T. · il y a 6 min · confirmé 2 fois ». */
export function reportMetaLine(r: ReportView, myDriverId: string | null | undefined, now = Date.now()) {
  const who = r.author_driver_id && r.author_driver_id === myDriverId ? "vous" : r.author_name;
  const parts = [`Signalé par ${who}`, ago(r.created_at, now)];
  if (r.confirmations > 0) parts.push(`confirmé ${r.confirmations}${NBSP}fois`);
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
        onFlash(frTypo(res.message ?? "Ce signalement a expiré."), "info");
        if (res.code === "REPORT_EXPIRED") onExpired?.();
      } else {
        hapticResult(true);
        setVote(still);
        if (res.expired) {
          onFlash("Signalement retiré de la carte");
          onExpired?.();
        } else onFlash(still ? "Signalement confirmé" : "Vote enregistré");
      }
    } catch (e) {
      hapticResult(false);
      onFlash(frTypo((e as Error).message), "error");
    } finally {
      setBusy(null);
      void refreshChat();
    }
  }

  const feed = variant === "feed";
  const voteH = feed ? control.sm : control.md;
  return (
    <View style={[feed ? styles.feedCard : styles.card, !active && { opacity: 0.6 }, style]}>
      <View style={styles.cardHead}>
        <Ionicons name={iconOf(report.report_type)} size={20} color={meta.color} style={styles.cardIcon} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>{meta.label}</Text>
            {distance != null && active ? (
              <Text style={styles.distText} accessibilityLabel={`à ${formatDistance(distance)}`}>{formatDistance(distance)}</Text>
            ) : null}
            {!active && <Pill label="Terminé" color={colors.muted} />}
          </View>
          <Text style={styles.cardMeta} numberOfLines={2}>{reportMetaLine(report, myDriverId, now)}</Text>
        </View>
        {onClose && (
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.cardClose, pressed && { backgroundColor: colors.surface3 }]}
            accessibilityRole="button"
            accessibilityLabel="Fermer"
            hitSlop={4}
          >
            <Ionicons name="close" size={20} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {feed && report.body && report.body !== DEFAULT_BODY[report.report_type ?? "other"] ? <Text style={styles.cardBody}>{report.body}</Text> : null}
      {active && (
        <View style={styles.votes}>
          {/* L'auteur ne confirme pas son propre signalement (refusé par le serveur) : il peut seulement le retirer */}
          {!mine && (
            <Pressable
              onPress={() => void doVote(true)}
              disabled={busy != null}
              accessibilityRole="button"
              accessibilityLabel="Toujours là"
              accessibilityState={{ selected: vote === true, disabled: busy != null, busy: busy === "yes" }}
              style={({ pressed }) => [styles.vote, { height: voteH }, vote === true && styles.voteOn, pressed && { backgroundColor: colors.surface3 }]}
            >
              {busy === "yes" ? (
                <ActivityIndicator color={colors.fg} />
              ) : (
                <Ionicons name={vote === true ? "checkmark-circle" : "checkmark-circle-outline"} size={20} color={colors.fg} />
              )}
              <Text style={styles.voteText}>Toujours là</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => void doVote(false)}
            disabled={busy != null}
            accessibilityRole="button"
            accessibilityLabel={mine ? "Retirer mon signalement" : "Plus là"}
            accessibilityState={{ selected: vote === false, disabled: busy != null, busy: busy === "no" }}
            style={({ pressed }) => [styles.vote, { height: voteH }, vote === false && styles.voteOn, pressed && { backgroundColor: colors.surface3 }]}
          >
            {busy === "no" ? (
              <ActivityIndicator color={colors.fg} />
            ) : (
              <Ionicons
                name={mine ? "trash-outline" : vote === false ? "close-circle" : "close-circle-outline"}
                size={20}
                color={vote === false ? colors.fg : colors.muted}
              />
            )}
            <Text style={styles.voteText}>{mine ? "Retirer" : "Plus là"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  sheetTitle: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3 },
  sheetSub: { color: colors.muted, fontSize: type.body, marginTop: space.xs, lineHeight: 21 },
  close: { width: control.sm, height: control.sm, borderRadius: radius.full, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    flexGrow: 1, flexBasis: "46%", minHeight: control.xl + space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
    alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: space.sm, paddingVertical: space.md,
  },
  tileIcon: { height: 28, alignItems: "center", justifyContent: "center" },
  tileLabel: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, textAlign: "center" },
  row: { flexDirection: "row", gap: space.sm },
  tileCompact: {
    flex: 1, height: control.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
    alignItems: "center", justifyContent: "center", gap: space.xs, paddingHorizontal: 2,
  },
  tileIconCompact: { height: 24, alignItems: "center", justifyContent: "center" },
  tileLabelCompact: { color: colors.fg, fontSize: type.caption, fontWeight: weight.semibold },
  hint: { flexDirection: "row", alignItems: "center", gap: 10 },
  hintText: { color: colors.muted, fontSize: type.subhead },
  error: {
    flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  errorText: { flex: 1, color: colors.fg, fontSize: type.body, fontWeight: weight.medium, lineHeight: 21 },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineStrong, padding: space.lg, gap: space.lg,
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  feedCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14, gap: space.md },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  cardIcon: { marginTop: 2 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardTitle: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, flexShrink: 1 },
  distText: { color: colors.muted, fontSize: type.body, fontWeight: weight.semibold, ...mono },
  cardMeta: { color: colors.muted, fontSize: type.subhead, lineHeight: 19 },
  cardBody: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
  cardClose: { width: 44, height: 44, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2, marginTop: -10, marginRight: -6 },
  votes: { flexDirection: "row", gap: 10 },
  vote: {
    flex: 1, borderRadius: radius.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  voteOn: { backgroundColor: colors.surface3, borderColor: alpha(colors.fg, 0.45) },
  voteText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
});
