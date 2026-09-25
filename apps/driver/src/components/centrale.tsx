// Mode « Centrale à commission » (option 2) : pièces d'interface partagées par l'accueil, l'offre,
// la fin de course, les gains, le profil et l'écran Commissions. Les règles (répartition, blocages)
// sont appliquées en base ; ces composants ne font que les présenter.
import { Ionicons } from "@expo/vector-icons";
import {
  DRIVER_BLOCKER_META, TRUST_LEVEL_META, formatPrice, formatRideDate, settlementStatusLabel,
  type DriverBlocker, type DriverSettlementSummary, type SettlementDirection, type SettlementStatus, type TrustLevel,
} from "@rydar/shared";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "@/theme";

const NBSP = " ";

/** Typographie française des messages serveur : espace insécable avant « : ; ! ? » (pas de « : » seul en début de ligne). */
export const frTypo = (s: string) => s.replace(/ ([:;!?»])/g, `${NBSP}$1`).replace(/« /g, `«${NBSP}`);

/** Ce que le chauffeur reverse à la centrale s'il encaisse le client : commission + frais plateforme. */
export const deductionCents = (r: { commission_cents?: number | null; platform_fee_cents?: number | null }) =>
  (r.commission_cents ?? 0) + (r.platform_fee_cents ?? 0);

/**
 * Statut d'un règlement vu par le chauffeur : settlementStatusLabel (@rydar/shared), sauf deux libellés
 * partagés formulés pour la centrale : commission déclarée (« Payé selon le chauffeur ») et part chauffeur
 * pas encore versée (« À verser »).
 */
export function driverSettlementLabel(status: SettlementStatus, direction: SettlementDirection, overdue = false) {
  if (status === "declared" && direction === "driver_owes") return "Paiement signalé";
  if (status === "due" && direction === "centrale_owes") return "À recevoir";
  return settlementStatusLabel(status, direction, overdue);
}

/** Motif de blocage → libellé, message, et si un règlement le lève (« réservée aux confirmés » : non). */
export function blockerInfo(reason: string | null | undefined, message?: string | null) {
  if (!reason) return null;
  const meta = DRIVER_BLOCKER_META[reason as DriverBlocker] as { label: string; message: string } | undefined;
  return {
    reason,
    label: meta?.label ?? "Courses bloquées",
    message: frTypo(message || meta?.message || "Réglez vos commissions pour recevoir de nouvelles courses."),
    payable: reason !== "new_driver",
  };
}

/** Durée restante / écoulée, insécable : « 18 min », « 5 h 12 », « 24 h », « 3 j ». */
export function formatLeft(ms: number) {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (m < 60) return `${m}${NBSP}min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest && h < 10 ? `${h}${NBSP}h${NBSP}${String(rest).padStart(2, "0")}` : `${h}${NBSP}h`;
  return `${Math.floor(h / 24)}${NBSP}j`;
}

/** « 20:06 » (aujourd'hui), « demain 06:30 », « le jeu. 25/09 06:30 ». */
export function formatWhen(iso: string, tz?: string) {
  const s = formatRideDate(iso, tz);
  if (s.startsWith("Aujourd'hui ")) return s.slice("Aujourd'hui ".length);
  if (s.startsWith("Demain ")) return `demain ${s.slice("Demain ".length)}`;
  if (s.startsWith("Hier ")) return `hier ${s.slice("Hier ".length)}`;
  return `le ${s}`;
}

/**
 * Échéance d'une commission : « À régler avant 20:06 · dans 6 h 34 » ou « En retard de 2 h 10 »
 * (short : « Avant 20:06 · dans 6 h 34 », pour un titre qui dit déjà « à régler »).
 */
export function dueText(dueAt: string, tz?: string, now = Date.now()) {
  const ms = new Date(dueAt).getTime() - now;
  if (ms <= 0) {
    const text = `En retard de ${formatLeft(ms)}`;
    return { text, short: text, late: true };
  }
  const tail = `${formatWhen(dueAt, tz)} · dans ${formatLeft(ms)}`;
  return { text: `À régler avant ${tail}`, short: `Avant ${tail}`, late: false };
}

/** Badge « Nouveau » (plafond de prix des courses jusqu'à la confirmation). */
export function TrustBadge({ level, style }: { level?: TrustLevel | null; style?: StyleProp<ViewStyle> }) {
  if (level !== "new") return null;
  return (
    <View style={[styles.trust, style]} accessibilityLabel={`Chauffeur ${TRUST_LEVEL_META.new.label} : ${TRUST_LEVEL_META.new.description}`}>
      <Ionicons name="sparkles" size={13} color={colors.amber} />
      <Text style={styles.trustText}>{TRUST_LEVEL_META.new.label}</Text>
    </View>
  );
}

/**
 * Bandeau d'accueil : commissions à régler (ambre), courses bloquées (rouge), paiement signalé en
 * attente de confirmation (bleu) ou part à recevoir de la centrale (vert). null si rien à signaler.
 */
export function SettlementBanner({
  s, currency = "EUR", tz, onPress, now = Date.now(),
}: { s: DriverSettlementSummary; currency?: string; tz?: string; onPress: () => void; now?: number }) {
  const blocked = blockerInfo(s.blocked, s.blocked_message);
  let tone: string;
  let icon: keyof typeof Ionicons.glyphMap;
  let title: string;
  let sub: string | null;
  let cta: string;
  if (blocked) {
    tone = colors.red;
    icon = "lock-closed";
    title = s.owed_cents > 0 ? `${formatPrice(s.owed_cents, currency)} à régler` : "Courses bloquées";
    sub = blocked.message;
    cta = "Régler";
  } else if (s.owed_cents > 0) {
    tone = colors.amber;
    icon = "wallet";
    title = `${formatPrice(s.owed_cents, currency)} à régler à la centrale`;
    sub = s.next_due_at ? dueText(s.next_due_at, tz, now).short : "Commission des courses encaissées";
    cta = "Payer";
  } else if (s.declared_cents > 0) {
    tone = colors.blue;
    icon = "time";
    title = `${formatPrice(s.declared_cents, currency)} signalé payé`;
    sub = "En attente de confirmation par la centrale";
    cta = "Voir";
  } else if (s.to_receive_cents > 0) {
    tone = colors.green;
    icon = "arrow-down-circle";
    title = `${formatPrice(s.to_receive_cents, currency)} à recevoir`;
    sub = "Votre part des courses payées à la centrale";
    cta = "Voir";
  } else return null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.banner, { borderColor: `${tone}66`, backgroundColor: `${tone}17` }, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub ?? ""}`}
    >
      <View style={[styles.bannerIcon, { backgroundColor: `${tone}26` }]}>
        <Ionicons name={icon} size={20} color={tone} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.bannerTitle, blocked && { color: tone }]} numberOfLines={1} adjustsFontSizeToFit>{title}</Text>
        {sub ? <Text style={styles.bannerSub} numberOfLines={3}>{sub}</Text> : null}
      </View>
      <View style={[styles.bannerCta, { backgroundColor: tone }]}>
        <Text style={styles.bannerCtaText}>{cta}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Encaissement d'une course (mode centrale) : le client paie le chauffeur (espèces / carte à bord)
 * qui reverse commission + frais, ou la centrale (en ligne / facture) qui verse la part chauffeur.
 */
export function CollectNote({
  collects, price, deduction, payout, currency = "EUR", past = false, style,
}: {
  collects: boolean; price: number | null | undefined; deduction: number; payout: number | null | undefined; currency?: string; past?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const tone = collects ? colors.amber : colors.green;
  return (
    <View style={[styles.collect, { borderColor: `${tone}40`, backgroundColor: `${tone}10` }, style]}>
      <Ionicons name={collects ? "cash" : "business"} size={20} color={tone} />
      <Text style={styles.collectText}>
        {collects ? (
          <>
            {past ? "Le client vous a payé " : "Le client vous paie "}
            <Text style={styles.strong}>{formatPrice(price, currency)}</Text>
            {" — vous reversez "}
            <Text style={[styles.strong, { color: colors.amber }]}>{formatPrice(deduction, currency)}</Text>
            {" à la centrale"}
          </>
        ) : (
          <>
            {"Payée à la centrale — elle vous verse "}
            <Text style={[styles.strong, { color: colors.green }]}>{formatPrice(payout, currency)}</Text>
          </>
        )}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  trust: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, height: 26, borderRadius: 13, backgroundColor: "rgba(245,181,68,0.14)", borderWidth: 1, borderColor: "rgba(245,181,68,0.35)", alignSelf: "flex-start" },
  trustText: { color: colors.amber, fontSize: 12.5, fontWeight: "900", letterSpacing: 0.3 },
  banner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 18, borderWidth: 1 },
  bannerIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  bannerTitle: { color: colors.fg, fontSize: 16, fontWeight: "900", fontVariant: ["tabular-nums"] },
  bannerSub: { color: colors.muted, fontSize: 13, marginTop: 2, lineHeight: 17 },
  bannerCta: { height: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  bannerCtaText: { color: colors.brandFg, fontSize: 14, fontWeight: "900" },
  collect: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 16, borderWidth: 1 },
  collectText: { flex: 1, color: colors.fg, fontSize: 15, lineHeight: 21, fontWeight: "600" },
  strong: { fontWeight: "900", fontVariant: ["tabular-nums"] },
});
