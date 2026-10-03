// Réseau partagé : pièces d'interface communes (ligne d'argent unique, étiquette « Partenaire », bandeau d'accueil,
// versement d'une course déjà payée).
// Les vues sont calculées par src/lib/network.ts (testé sous Node) ; ces composants ne font que les présenter.
import { Ionicons } from "@expo/vector-icons";
import type { DriverHomeNetwork } from "@rydar/shared";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { MoneyBanner } from "@/components/centrale";
import { BigButton, Pill } from "@/components/ui";
import { networkHomeBanner, PARTNER_BADGE, type BannerTone } from "@/lib/network";
import { colors, control, radius, space, type, weight } from "@/theme";

/** Étiquette « Partenaire » (violet = réseau partagé, NETWORK_TONE). */
export function PartnerBadge({ giver }: { giver?: string | null }) {
  return <Pill label={giver ? `${PARTNER_BADGE} · ${giver}` : PARTNER_BADGE} color={colors.violet} />;
}

/**
 * Ligne d'argent d'une course partenaire : UN seul montant échangé avec l'organisation qui confie la course
 * (« vous reverserez 12,50 € à … » / « … vous versera 37,50 € »), jamais commission ni frais.
 */
export function MoneyLine({ text, collects, style }: { text: string; collects: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.line, style]}>
      <Ionicons name={collects ? "cash-outline" : "business-outline"} size={20} color={colors.muted} style={styles.icon} />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

/**
 * Course partenaire déjà payée : compte où arrivera le versement (IBAN masqué), ou coordonnées bancaires à renseigner —
 * sans elles, l'organisation qui confie la course ne peut pas verser la part (lib/network.ts : payoutNoteView).
 */
export function PayoutNote({ note, onEdit }: { note: { missing: boolean; text: string }; onEdit: () => void }) {
  return (
    <View style={styles.payout}>
      <View style={styles.payoutRow}>
        <Ionicons name="card-outline" size={20} color={note.missing ? colors.amber : colors.muted} style={styles.icon} />
        <Text style={styles.payoutText}>{note.text}</Text>
      </View>
      {note.missing ? <BigButton title="Renseigner mon RIB" icon="card-outline" variant="secondary" height={control.md} onPress={onEdit} /> : null}
    </View>
  );
}

const TONE: Record<BannerTone, string> = { red: colors.red, amber: colors.amber, green: colors.green };

/** Bandeau d'accueil des courses partenaires (sommes à régler, blocage, part à recevoir) ; rien si tout est réglé. */
export function NetworkBanner({
  n, executor, currency, onPress,
}: { n: DriverHomeNetwork | null | undefined; executor?: string | null; currency?: string; onPress: () => void }) {
  const v = networkHomeBanner(n, executor, currency);
  if (!v) return null;
  return <MoneyBanner tone={TONE[v.tone]} icon={v.icon} title={v.title} sub={v.sub} late={v.late} alert={v.alert} cta={v.cta} onPress={onPress} />;
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
  },
  icon: { marginTop: 1 },
  text: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21, fontWeight: weight.regular },
  payout: { gap: space.sm },
  payoutRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg },
  payoutText: { flex: 1, color: colors.muted, fontSize: type.body, lineHeight: 21 },
});
