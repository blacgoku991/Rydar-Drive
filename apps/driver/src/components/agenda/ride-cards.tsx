// Planning / agenda : cartes reprises du Planning (chauffeur standard inchangé, compte de démonstration App Review
// compris) — « Courses proposées » (offres de la flotte : « Prendre cette course ») et « Mes courses » (courses attribuées,
// à venir ou en cours). Réseau partagé : offres et courses partenaires marquées « Partenaire » (organisation qui confie la
// course, part du chauffeur, une ligne d'argent). Fiche du gérant (Flotte Privée passée en centrale) : le prix seul.
import { Ionicons } from "@expo/vector-icons";
import { formatPrice, formatRideDate, shortAddress, type DriverOfferV2 } from "@rydar/shared";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PartnerBadge } from "@/components/network";
import { BigButton, Card, RouteLine } from "@/components/ui";
import { plural } from "@/lib/agenda-view";
import { offerBlockView, partnerOfferView, rideMoneyView, settleHref, type AppRide } from "@/lib/network";
import { overdue, overdueHint, waitsForCurrentRide } from "@/lib/planning";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

/** Instantanée attribuée pendant une autre course : le serveur refuse de la démarrer avant (DRIVER_BUSY). */
const AFTER_CURRENT = "À démarrer après votre course en cours";

/** Planifiée acceptée, heure passée, pas démarrée : clôturée par le serveur quelques heures plus tard (lib/planning). */
const LATE = "Heure de prise en charge dépassée";

/** « Courses proposées » : offre de la flotte (planifiée), part et blocage éventuels, « Prendre cette course ». */
export function ProposedOfferCard({
  o, tz, organization, ownerDriver, busy, disabled, onTake,
}: {
  o: DriverOfferV2;
  tz?: string;
  /** Organisation du chauffeur (motif d'un blocage) */
  organization?: string | null;
  ownerDriver: boolean;
  busy: boolean;
  disabled: boolean;
  onTake: () => void;
}) {
  // Réseau partagé : organisation qui confie la course, part du chauffeur et UNE ligne d'argent ; mode centrale :
  // part chauffeur (« Vous gagnez ») ; offre bloquée (commission en retard, impayé envers le partenaire…) ; fiche du
  // gérant : aucune commission sur ses courses, le prix
  const partner = partnerOfferView(o);
  const centrale = o.dispatch_model === "centrale" && !ownerDriver;
  const payout = partner ? partner.gainCents : centrale ? o.driver_payout_cents ?? null : null;
  const block = partner || centrale ? offerBlockView(o.blocked, o.blocked_message, { giver: o.network?.giver.name, executor: organization }) : null;
  const when = formatRideDate(o.pickup_at, tz);
  return (
    <Card style={styles.card}>
      {partner && <PartnerBadge giver={partner.giver} />}
      <View style={styles.head}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.when}>{when}</Text>
          <Text style={styles.meta}>
            Course {o.number} · {plural(o.passengers, "passager", "passagers")}
            {o.luggage > 0 ? ` · ${plural(o.luggage, "bagage", "bagages")}` : ""}
          </Text>
        </View>
        {payout != null ? (
          <View style={{ alignItems: "flex-end", gap: 2 }}>
            <Text style={styles.price}>{formatPrice(payout, o.currency)}</Text>
            <Text style={styles.meta}>sur {formatPrice(o.price_cents, o.currency)}</Text>
          </View>
        ) : (
          <Text style={styles.price}>{formatPrice(o.price_cents, o.currency)}</Text>
        )}
      </View>
      {partner ? (
        <>
          <RouteLine from={partner.pickup} to={partner.dropoff} />
          <Text style={styles.hint}>{partner.line}</Text>
        </>
      ) : (
        <RouteLine from={shortAddress(o.pickup_address)} to={shortAddress(o.dropoff_address)} />
      )}
      {block ? (
        <Pressable
          onPress={() => block.payable && router.push(settleHref(block.target))}
          disabled={!block.payable}
          style={({ pressed }) => [styles.blocked, pressed && { backgroundColor: colors.surface3 }]}
          accessibilityRole={block.payable ? "button" : "text"}
          accessibilityLabel={block.payable ? `${block.message} ${block.target === "network" ? "Voir mes courses partenaires." : "Voir mes commissions."}` : block.message}
        >
          <Ionicons name="lock-closed-outline" size={20} color={colors.red} />
          <Text style={styles.blockedText}>{block.message}</Text>
          {block.payable && <Ionicons name="chevron-forward" size={20} color={colors.muted} />}
        </Pressable>
      ) : (
        <BigButton title="Prendre cette course" height={control.md} loading={busy} disabled={disabled} onPress={onTake} />
      )}
    </Card>
  );
}

/** « Mes courses » : course attribuée (planifiée ou instantanée à démarrer après la course en cours), toucher → détail. */
export function MyRideCard({
  r, tz, now, currentRideId, ownerDriver,
}: {
  r: AppRide;
  tz?: string;
  now: number;
  currentRideId: string | null;
  ownerDriver: boolean;
}) {
  // Instantanée attribuée : pas d'heure de prise en charge à afficher (dès que possible)
  const when = r.type === "instant" ? "Course immédiate" : formatRideDate(r.pickup_at, tz);
  const after = waitsForCurrentRide(r, currentRideId);
  const late = overdue(r, now);
  const lateHint = late ? overdueHint(late, tz, new Date(now)) : null;
  // Sa part (centrale, course partenaire), sinon le prix — part chauffeur en mode centrale seulement (une course
  // créée avant un retour au mode flotte garde sa répartition, jamais affichée : money calculé par le serveur)
  const money = rideMoneyView(r, { ownerDriver });
  const amount = money.kind === "plain" ? formatPrice(r.price_cents, r.currency) : formatPrice(money.gainCents, money.currency);
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/ride/[id]", params: { id: r.id } })}
      accessibilityRole="button"
      accessibilityLabel={`Course ${r.number}${r.network ? `, partenaire, ${r.network.giver.name}` : ""}, ${when}${late ? `, ${LATE.toLowerCase()}. ${lateHint}` : ""}${after ? `, ${AFTER_CURRENT.toLowerCase()}` : ""}, ${shortAddress(r.pickup_address)} vers ${shortAddress(r.dropoff_address)}, ${amount}`}
      accessibilityHint="Ouvre le détail de la course"
    >
      {({ pressed }) => (
        <Card style={[styles.card, pressed && { backgroundColor: colors.surface2 }]}>
          {r.network && <PartnerBadge giver={r.network.giver.name} />}
          <View style={styles.head}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.when}>{when}</Text>
              <Text style={styles.meta}>
                Course {r.number} · {plural(r.passengers, "passager", "passagers")}
                {r.luggage > 0 ? ` · ${plural(r.luggage, "bagage", "bagages")}` : ""}
              </Text>
              {after && <Text style={styles.hint}>{AFTER_CURRENT}</Text>}
            </View>
            <Text style={styles.price}>{amount}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>
          {late && (
            <View style={styles.late}>
              <Ionicons name="time-outline" size={20} color={colors.amber} style={styles.lateIcon} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.lateTitle}>{LATE}</Text>
                <Text style={styles.hint}>{lateHint}</Text>
              </View>
            </View>
          )}
          <RouteLine from={shortAddress(r.pickup_address)} to={shortAddress(r.dropoff_address)} />
        </Card>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  when: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, ...mono },
  meta: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, ...mono },
  hint: { color: colors.muted, fontSize: type.footnote, lineHeight: 18 },
  late: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  lateIcon: { marginTop: 1 },
  lateTitle: { color: colors.amber, fontSize: type.footnote, fontWeight: weight.semibold, lineHeight: 18 },
  price: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold, ...mono },
  blocked: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.md, paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.md, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  blockedText: { flex: 1, color: colors.fg, fontSize: type.body, fontWeight: weight.medium, lineHeight: 20 },
});
