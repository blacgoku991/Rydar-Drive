// Planning : courses planifiées proposées à la flotte (à prendre) et courses planifiées déjà attribuées.
import { Ionicons } from "@expo/vector-icons";
import { formatPrice, formatRideDate, shortAddress, type Ride } from "@rydar/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { blockerInfo, frTypo } from "@/components/centrale";
import { BigButton, Card, RouteLine, Screen, ScreenHeader } from "@/components/ui";
import { alertDriverBlocked, useDriver } from "@/hooks/driver-context";
import { api, type AcceptResult } from "@/lib/api";
import { alpha, colors, control, mono, radius, space, type, weight } from "@/theme";

const NBSP = "\u00A0";

/** « 3 passagers », « 1 bagage » */
const plural = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;

export default function Planning() {
  const { offers, refresh, home } = useDriver();
  const [mine, setMine] = useState<Ride[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tz = home?.organization.timezone;
  const available = offers.filter((o) => o.mode === "fleet");

  const load = useCallback(async () => {
    const [, upcoming] = await Promise.all([refresh(), api.upcoming()]);
    setMine(upcoming.filter((r) => r.type === "scheduled"));
  }, [refresh]);
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
            // Mode centrale : part chauffeur (« Vous gagnez »), et offre bloquée (commission en retard…)
            const payout = o.dispatch_model === "centrale" ? o.driver_payout_cents ?? null : null;
            const block = o.dispatch_model === "centrale" ? blockerInfo(o.blocked) : null;
            const when = formatRideDate(o.pickup_at, tz);
            return (
              <Card key={o.offer_id} style={styles.card}>
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
                      <Text style={styles.price}>{formatPrice(payout)}</Text>
                      <Text style={styles.meta}>sur {formatPrice(o.price_cents)}</Text>
                    </View>
                  ) : (
                    <Text style={styles.price}>{formatPrice(o.price_cents)}</Text>
                  )}
                </View>
                <RouteLine from={shortAddress(o.pickup_address)} to={shortAddress(o.dropoff_address)} />
                {block ? (
                  <Pressable
                    onPress={() => block.payable && router.push("/commissions")}
                    disabled={!block.payable}
                    style={({ pressed }) => [styles.blocked, pressed && { backgroundColor: colors.surface3 }]}
                    accessibilityRole={block.payable ? "button" : "text"}
                    accessibilityLabel={block.payable ? `${block.message} Voir mes commissions.` : block.message}
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
                      if (!res.ok && res.code === "DRIVER_BLOCKED") alertDriverBlocked(res);
                      else
                        Alert.alert(
                          res.ok ? "Course attribuée" : "Course indisponible",
                          res.ok ? "Ajoutée à votre planning. Rappels programmés." : frTypo(res.message ?? "Course déjà attribuée."),
                        );
                      await load();
                    }}
                  />
                )}
              </Card>
            );
          })}

          <Text style={[styles.section, { marginTop: space.lg }]} accessibilityRole="header">
            Mes courses planifiées <Text style={mono}>· {mine.length}</Text>
          </Text>
          {mine.length === 0 && <Text style={styles.empty}>Aucune course à venir.</Text>}
          {mine.map((r) => {
            const when = formatRideDate(r.pickup_at, tz);
            const amount = formatPrice(r.driver_payout_cents ?? r.price_cents);
            return (
              <Pressable
                key={r.id}
                onPress={() => router.push({ pathname: "/ride/[id]", params: { id: r.id } })}
                accessibilityRole="button"
                accessibilityLabel={`Course ${r.number}, ${when}, ${shortAddress(r.pickup_address)} vers ${shortAddress(r.dropoff_address)}, ${amount}`}
                accessibilityHint="Ouvre le détail de la course"
              >
                {({ pressed }) => (
                  <Card style={[styles.card, styles.mineCard, pressed && { backgroundColor: colors.surface2 }]}>
                    <View style={styles.head}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.when}>{when}</Text>
                        <Text style={styles.meta}>
                          Course {r.number} · {plural(r.passengers, "passager", "passagers")}
                          {r.luggage > 0 ? ` · ${plural(r.luggage, "bagage", "bagages")}` : ""}
                        </Text>
                      </View>
                      <Text style={styles.price}>{amount}</Text>
                      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                    </View>
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
  card: { gap: space.md },
  // Course planifiée attribuée : liseré violet discret (état « planifiée », comme sur le dashboard)
  mineCard: {},
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  when: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, ...mono },
  meta: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, ...mono },
  price: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold, ...mono },
  blocked: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.md, paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.md, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  blockedText: { flex: 1, color: colors.fg, fontSize: type.body, fontWeight: weight.medium, lineHeight: 20 },
});
