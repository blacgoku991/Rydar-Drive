// Planning : courses planifiées proposées à la flotte (à prendre) et courses déjà attribuées (planifiées, et
// instantanées pas encore démarrées : course suivante attribuée pendant la course en cours). Réseau partagé : offres
// et courses partenaires marquées « Partenaire » (organisation qui confie la course, part du chauffeur, une ligne
// d'argent).
import { Ionicons } from "@expo/vector-icons";
import { formatPrice, formatRideDate, shortAddress } from "@rydar/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { PartnerBadge } from "@/components/network";
import { BigButton, Card, RouteLine, Screen, ScreenHeader } from "@/components/ui";
import { alertDriverBlocked, useDriver } from "@/hooks/driver-context";
import { useNow } from "@/hooks/use-now";
import { api, refusalText, type AcceptResult } from "@/lib/api";
import { offerBlockView, partnerOfferView, rideMoneyView, settleHref, type AppRide, type LegacyRideContext } from "@/lib/network";
import { myRides, overdue, overdueHint, waitsForCurrentRide } from "@/lib/planning";
import { alpha, colors, control, mono, radius, space, type, weight } from "@/theme";

const NBSP = "\u00A0";

/** Instantanée attribuée pendant une autre course : le serveur refuse de la démarrer avant (DRIVER_BUSY). */
const AFTER_CURRENT = "À démarrer après votre course en cours";

/** Planifiée acceptée, heure passée, pas démarrée : clôturée par le serveur quelques heures plus tard (lib/planning). */
const LATE = "Heure de prise en charge dépassée";

/** « 3 passagers », « 1 bagage » */
const plural = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;

export default function Planning() {
  const { offers, refresh, home } = useDriver();
  const [upcoming, setUpcoming] = useState<AppRide[] | null>(null);
  // Lecture de « Mes courses » en échec (réseau) : dernière liste connue gardée, jamais « Aucune course »
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tz = home?.organization.timezone;
  const driverId = home?.driver.id;
  const currentRideId = home?.driver.current_ride_id ?? null;
  const available = offers.filter((o) => o.mode === "fleet");
  const mine = useMemo(() => (upcoming && driverId ? myRides(upcoming, driverId) : null), [upcoming, driverId]);
  // Planifiées en retard : heure de clôture automatique à jour
  const now = useNow(30_000);
  // Serveur antérieur à driver_rides_upcoming : argent déduit du modèle de l'organisation
  const legacy = useRef<LegacyRideContext>({});
  legacy.current = { model: home?.model ?? home?.organization.dispatch_model, organization: home?.organization.name };

  // « Mes courses » lues par la fiche du chauffeur (filtre côté serveur) : en même temps que l'accueil si elle est
  // connue, sinon après lui (accueil illisible : erreur affichée, jamais « Aucune course »)
  const load = useCallback(async () => {
    const read = (id: string | undefined) => (id ? api.upcoming(id, legacy.current).catch(() => null) : Promise.resolve(null));
    const [h, known] = await Promise.all([refresh(), driverId ? read(driverId) : undefined]);
    const list = known !== undefined ? known : await read(h?.driver.id);
    setLoadError(list == null);
    if (list) setUpcoming(list);
  }, [refresh, driverId]);
  useFocusEffect(useCallback(() => void load(), [load]));

  const pull = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <ScreenHeader title="Planning" />
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl tintColor={colors.muted} colors={[colors.fg]} progressBackgroundColor={colors.surface2} refreshing={refreshing} onRefresh={pull} />}
        >
          <Text style={styles.section} accessibilityRole="header">
            Courses proposées <Text style={mono}>· {available.length}</Text>
          </Text>
          {available.length === 0 && <Text style={styles.empty}>Aucune course planifiée à prendre pour le moment.</Text>}
          {available.map((o) => {
            // Réseau partagé : organisation qui confie la course, part du chauffeur et UNE ligne d'argent ; mode centrale :
            // part chauffeur (« Vous gagnez ») ; offre bloquée (commission en retard, impayé envers le partenaire…)
            const partner = partnerOfferView(o);
            const payout = partner ? partner.gainCents : o.dispatch_model === "centrale" ? o.driver_payout_cents ?? null : null;
            const block = partner || o.dispatch_model === "centrale"
              ? offerBlockView(o.blocked, o.blocked_message, { giver: o.network?.giver.name, executor: home?.organization.name })
              : null;
            const when = formatRideDate(o.pickup_at, tz);
            return (
              <Card key={o.offer_id} style={styles.card}>
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
                  <BigButton
                    title="Prendre cette course"
                    height={control.md}
                    loading={busy === o.offer_id}
                    disabled={busy != null && busy !== o.offer_id}
                    onPress={async () => {
                      setBusy(o.offer_id);
                      const res = await api.accept(o.offer_id).catch((e: Error) => ({ ok: false, code: "NETWORK", message: e.message }) as AcceptResult);
                      setBusy(null);
                      if (!res.ok && res.code === "DRIVER_BLOCKED") alertDriverBlocked(res, { giver: o.network?.giver.name, executor: home?.organization.name });
                      else
                        Alert.alert(
                          res.ok ? "Course attribuée" : "Course indisponible",
                          res.ok ? "Ajoutée à votre planning. Rappels programmés." : frTypo(refusalText(res)),
                        );
                      await load();
                    }}
                  />
                )}
              </Card>
            );
          })}

          <Text style={[styles.section, { marginTop: space.lg }]} accessibilityRole="header">
            Mes courses {mine ? <Text style={mono}>· {mine.length}</Text> : null}
          </Text>
          {loadError ? (
            <View style={styles.error} accessibilityRole="alert">
              <Text style={styles.errorText}>
                {frTypo(mine ? "Connexion impossible : cette liste n'est peut-être pas à jour." : "Connexion impossible : vos courses n'ont pas pu être chargées.")}
              </Text>
              <BigButton title="Réessayer" icon="refresh-outline" variant="secondary" height={control.md} loading={refreshing} onPress={pull} />
            </View>
          ) : null}
          {mine?.length === 0 && <Text style={styles.empty}>Aucune course à venir.</Text>}
          {(mine ?? []).map((r) => {
            // Instantanée attribuée : pas d'heure de prise en charge à afficher (dès que possible)
            const when = r.type === "instant" ? "Course immédiate" : formatRideDate(r.pickup_at, tz);
            const after = waitsForCurrentRide(r, currentRideId);
            const late = overdue(r, now);
            const lateHint = late ? overdueHint(late, tz, new Date(now)) : null;
            // Sa part (centrale, course partenaire), sinon le prix — part chauffeur en mode centrale seulement (une course
            // créée avant un retour au mode flotte garde sa répartition, jamais affichée : money calculé par le serveur)
            const money = rideMoneyView(r);
            const amount = money.kind === "plain" ? formatPrice(r.price_cents, r.currency) : formatPrice(money.gainCents, money.currency);
            return (
              <Pressable
                key={r.id}
                onPress={() => router.push({ pathname: "/ride/[id]", params: { id: r.id } })}
                accessibilityRole="button"
                accessibilityLabel={`Course ${r.number}${r.network ? `, partenaire, ${r.network.giver.name}` : ""}, ${when}${late ? `, ${LATE.toLowerCase()}. ${lateHint}` : ""}${after ? `, ${AFTER_CURRENT.toLowerCase()}` : ""}, ${shortAddress(r.pickup_address)} vers ${shortAddress(r.dropoff_address)}, ${amount}`}
                accessibilityHint="Ouvre le détail de la course"
              >
                {({ pressed }) => (
                  <Card style={[styles.card, styles.mineCard, pressed && { backgroundColor: colors.surface2 }]}>
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
          })}
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl + space.sm, gap: space.md },
  section: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.semibold },
  empty: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  error: { gap: space.sm },
  errorText: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
  card: { gap: space.md },
  // Course planifiée attribuée : liseré violet discret (état « planifiée », comme sur le dashboard)
  mineCard: {},
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
