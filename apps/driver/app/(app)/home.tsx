import { Ionicons } from "@expo/vector-icons";
import { DRIVER_FLOW, PRESENCE_META, RIDE_STATUS_META, formatPrice, formatRideDate, shortAddress, type RideStatus } from "@rydar/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { OnlineToggle } from "@/components/radar";
import { Card, Label, Pill, RouteLine, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { colors, presenceColor } from "@/theme";
import type { Ride } from "@rydar/shared";

export default function Home() {
  const { home, offers, refresh, setOnline, busy } = useDriver();
  const [refreshing, setRefreshing] = useState(false);
  const [current, setCurrent] = useState<Ride | null>(null);
  const presence = home?.driver.presence ?? "offline";
  const online = presence !== "offline";
  const scheduledOffers = offers.filter((o) => o.mode === "fleet").length;

  useEffect(() => {
    const id = home?.driver.current_ride_id;
    if (id) api.ride(id).then(setCurrent).catch(() => setCurrent(null));
    else setCurrent(null);
  }, [home?.driver.current_ride_id]);

  async function toggle() {
    const res = await setOnline(!online);
    if (!res.ok || res.message) Alert.alert(res.ok ? "Localisation" : "Action impossible", res.message ?? "Réessayez.");
  }

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 16 }}
          refreshControl={<RefreshControl tintColor={colors.brand} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} />}
        >
          <View style={styles.header}>
            <View>
              <Text style={styles.hello}>Bonjour {home?.driver.first_name ?? ""}</Text>
              <Text style={styles.org}>{home?.organization.name ?? "Rydar Drive"}</Text>
            </View>
            <Pressable onPress={() => router.push("/profile")} style={styles.avatar} accessibilityLabel="Profil">
              <Text style={styles.avatarText}>{(home?.driver.first_name ?? "?").charAt(0)}{(home?.driver.last_name ?? "").charAt(0)}</Text>
            </Pressable>
          </View>

          <View style={{ alignItems: "center" }}>
            <Pill label={PRESENCE_META[presence as keyof typeof PRESENCE_META]?.label ?? "Hors ligne"} color={presenceColor[presence] ?? colors.subtle} />
            <OnlineToggle online={online} onPress={toggle} busy={busy} />
          </View>

          <View style={{ flexDirection: "row", gap: 12 }}>
            <Card style={{ flex: 1 }}>
              <Label>Aujourd&apos;hui</Label>
              <Text style={styles.stat}>{home?.today.rides ?? 0}<Text style={styles.statUnit}> course{(home?.today.rides ?? 0) > 1 ? "s" : ""}</Text></Text>
            </Card>
            <Card style={{ flex: 1 }}>
              <Label>Encaissé</Label>
              <Text style={[styles.stat, { color: colors.brand }]}>{formatPrice(home?.today.revenue_cents ?? 0)}</Text>
            </Card>
          </View>

          {current && (
            <Pressable onPress={() => router.push({ pathname: "/ride/[id]", params: { id: current.id } })}>
              <Card style={{ borderColor: "rgba(34,211,238,0.35)", gap: 14 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Label>Course en cours · #{current.number}</Label>
                  <Pill label={RIDE_STATUS_META[current.status as RideStatus].short} color={colors.cyan} />
                </View>
                <RouteLine from={shortAddress(current.pickup_address)} to={shortAddress(current.dropoff_address)} />
                <View style={styles.cta}>
                  <Text style={styles.ctaText}>{DRIVER_FLOW[current.status as RideStatus]?.label ?? "Ouvrir"}</Text>
                  <Ionicons name="arrow-forward" size={18} color={colors.brandFg} />
                </View>
              </Card>
            </Pressable>
          )}

          {home?.next_scheduled && !current && (
            <Pressable onPress={() => router.push({ pathname: "/ride/[id]", params: { id: home.next_scheduled!.id } })}>
              <Card style={{ gap: 12 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Label>Prochaine course planifiée</Label>
                  <Text style={styles.price}>{formatPrice(home.next_scheduled.price_cents)}</Text>
                </View>
                <Text style={styles.when}>{formatRideDate(home.next_scheduled.pickup_at, home.organization.timezone)}</Text>
                <RouteLine from={shortAddress(home.next_scheduled.pickup_address)} to={shortAddress(home.next_scheduled.dropoff_address)} />
              </Card>
            </Pressable>
          )}

          <Pressable onPress={() => router.push("/planning")}>
            <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <View style={styles.iconBox}><Ionicons name="calendar-outline" size={20} color={colors.violet} /></View>
                <View>
                  <Text style={styles.rowTitle}>Planning</Text>
                  <Text style={styles.rowSub}>{scheduledOffers ? `${scheduledOffers} course${scheduledOffers > 1 ? "s" : ""} planifiée${scheduledOffers > 1 ? "s" : ""} à prendre` : "Courses planifiées et à venir"}</Text>
                </View>
              </View>
              {scheduledOffers > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{scheduledOffers}</Text></View> : <Ionicons name="chevron-forward" size={18} color={colors.subtle} />}
            </Card>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  hello: { color: colors.fg, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  org: { color: colors.subtle, fontSize: 14, marginTop: 2 },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.fg, fontWeight: "700" },
  stat: { color: colors.fg, fontSize: 30, fontWeight: "800", marginTop: 8, letterSpacing: -0.5 },
  statUnit: { color: colors.subtle, fontSize: 14, fontWeight: "600" },
  price: { color: colors.fg, fontSize: 18, fontWeight: "800" },
  when: { color: colors.violet, fontSize: 15, fontWeight: "700" },
  cta: { backgroundColor: colors.brand, borderRadius: 14, height: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  ctaText: { color: colors.brandFg, fontSize: 16, fontWeight: "800" },
  iconBox: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(167,139,250,0.12)", alignItems: "center", justifyContent: "center" },
  rowTitle: { color: colors.fg, fontSize: 16, fontWeight: "700" },
  rowSub: { color: colors.subtle, fontSize: 13, marginTop: 2 },
  badge: { minWidth: 26, height: 26, borderRadius: 13, backgroundColor: colors.violet, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  badgeText: { color: colors.bg, fontWeight: "800" },
});
