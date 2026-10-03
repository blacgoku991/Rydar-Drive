// Mode « Centrale à commission » (option 2) : pièces d'interface partagées par l'accueil, l'offre,
// la fin de course, les gains, le profil et l'écran Commissions. Les règles (répartition, blocages)
// sont appliquées en base ; ces composants ne font que les présenter.
import { Ionicons } from "@expo/vector-icons";
import { TRUST_LEVEL_META, formatPrice, type DriverSettlementSummary, type TrustLevel } from "@rydar/shared";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { blockerInfo, dueText, NBSP } from "@/lib/settlement-text";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

// Textes purs (testés sous Node) : réexportés pour les écrans
export { blockerInfo, deductionCents, driverSettlementLabel, dueText, formatLeft, formatWhen, frTypo } from "@/lib/settlement-text";

/**
 * Niveau de confiance (mode centrale) : « Période d'essai » (certaines courses réservées aux chauffeurs
 * confirmés) ou « Confirmé ». Étiquette neutre ; rien si le niveau est inconnu.
 */
export function TrustBadge({ level, style }: { level?: TrustLevel | null; style?: StyleProp<ViewStyle> }) {
  if (level !== "new" && level !== "trusted") return null;
  const trial = level === "new";
  return (
    <View
      style={[styles.trust, style]}
      accessible
      accessibilityLabel={trial ? `Période d'essai${NBSP}: certaines courses sont réservées aux chauffeurs confirmés.` : "Chauffeur confirmé"}
    >
      <Ionicons name={trial ? "time-outline" : "checkmark-circle-outline"} size={16} color={colors.muted} />
      <Text style={styles.trustText}>{trial ? "Période d'essai" : TRUST_LEVEL_META.trusted.label}</Text>
    </View>
  );
}

/**
 * Bandeau d'accueil : commissions à régler (ambre), courses bloquées (rouge), paiement signalé en
 * attente de confirmation (bleu) ou part à recevoir de la centrale (vert). null si rien à signaler.
 * Carte neutre : seule l'icône (et le titre si les courses sont bloquées) porte la couleur de l'état.
 */
export function SettlementBanner({
  s, currency = "EUR", tz, onPress, now = Date.now(),
}: { s: DriverSettlementSummary; currency?: string; tz?: string; onPress: () => void; now?: number }) {
  const blocked = blockerInfo(s.blocked, s.blocked_message);
  let tone: string;
  let icon: keyof typeof Ionicons.glyphMap;
  let title: string;
  let sub: string | null;
  let late = false;
  let cta: string;
  if (blocked) {
    tone = colors.red;
    icon = "lock-closed-outline";
    title = s.owed_cents > 0 ? `${formatPrice(s.owed_cents, currency)} à régler` : "Courses bloquées";
    sub = blocked.message;
    cta = "Régler";
  } else if (s.owed_cents > 0) {
    tone = colors.amber;
    icon = "wallet-outline";
    title = `${formatPrice(s.owed_cents, currency)} à régler à la centrale`;
    // Montant déjà en retard (next_due_at ne porte que les échéances à venir) : signalé en premier
    if ((s.overdue_cents ?? 0) > 0) {
      sub = `dont ${formatPrice(s.overdue_cents, currency)} en retard`;
      late = true;
    } else if (s.next_due_at) {
      const due = dueText(s.next_due_at, tz, now);
      sub = due.short;
      late = due.late;
    } else sub = "Commission des courses encaissées";
    cta = "Payer";
  } else if (s.declared_cents > 0) {
    tone = colors.blue;
    icon = "time-outline";
    title = `${formatPrice(s.declared_cents, currency)} signalé payé`;
    sub = "En attente de confirmation par la centrale";
    cta = "Voir";
  } else if (s.to_receive_cents > 0) {
    tone = colors.green;
    icon = "arrow-down-circle-outline";
    title = `${formatPrice(s.to_receive_cents, currency)} à recevoir`;
    sub = "Votre part des courses payées à la centrale";
    cta = "Voir";
  } else return null;
  return <MoneyBanner tone={tone} icon={icon} title={title} sub={sub} late={late} alert={!!blocked} cta={cta} onPress={onPress} />;
}

/**
 * Bandeau d'argent de l'accueil (commissions de la centrale, courses partenaires) : carte neutre, seule l'icône (et le
 * titre d'un blocage, `alert`) porte la couleur de l'état ; échéance dépassée (`late`) : sous-titre en rouge.
 */
export function MoneyBanner({
  tone, icon, title, sub, late = false, alert = false, cta, onPress,
}: {
  tone: string; icon: keyof typeof Ionicons.glyphMap; title: string; sub: string | null; late?: boolean; alert?: boolean; cta: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.banner, pressed && { backgroundColor: colors.surface3 }]}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub ?? ""}`}
      accessibilityHint={cta}
    >
      <Ionicons name={icon} size={22} color={tone} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.bannerTitle, alert && { color: tone }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
          {title}
        </Text>
        {sub ? <Text style={[styles.bannerSub, late && { color: colors.red }]} numberOfLines={3}>{sub}</Text> : null}
      </View>
      <View style={styles.bannerCta}>
        <Text style={styles.bannerCtaText}>{cta}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
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
  return (
    <View style={[styles.collect, style]}>
      <Ionicons name={collects ? "cash-outline" : "business-outline"} size={20} color={colors.muted} style={styles.collectIcon} />
      <Text style={styles.collectText}>
        {collects ? (
          <>
            {past ? "Le client vous a payé " : "Le client vous paie "}
            <Text style={styles.strong}>{formatPrice(price, currency)}</Text>
            {`${NBSP}; vous reversez `}
            <Text style={styles.strong}>{formatPrice(deduction, currency)}</Text>
            {" à la centrale."}
          </>
        ) : (
          <>
            {`Payée à la centrale${NBSP}; elle vous verse `}
            <Text style={styles.strong}>{formatPrice(payout, currency)}</Text>
            {"."}
          </>
        )}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  trust: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 28, borderRadius: radius.sm,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, alignSelf: "flex-start",
  },
  trustText: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  banner: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
  },
  bannerTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, ...mono },
  bannerSub: { color: colors.muted, fontSize: type.subhead, marginTop: 2, lineHeight: 19 },
  bannerCta: { flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: space.xs },
  bannerCtaText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.semibold },
  collect: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
  },
  collectIcon: { marginTop: 1 },
  collectText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21, fontWeight: weight.regular },
  strong: { fontWeight: weight.bold, ...mono },
});
