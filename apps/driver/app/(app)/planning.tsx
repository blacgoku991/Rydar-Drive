import { Ionicons } from "@expo/vector-icons";
import { formatPrice, formatRideDate, shortAddress, type Ride } from "@rydar/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BigButton, Card, Label, RouteLine, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { colors } from "@/theme";

export default function Planning() {
  const { offers, refresh, home } = useDriver();
  const [mine, setMine] = useState<Ride[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const tz = home?.organization.timezone;
  const available = offers.filter((o) => o.mode === "fleet");

  const load = useCallback(async () => {
    await refresh();
    setMine((await api.upcoming()).filter((r) => r.type === "scheduled"));
  }, [refresh]);
  useFocusEffect(useCallback(() => void load(), [load]));

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="chevron-back" size={22} color={colors.fg} /></Pressable>
          <Text style={styles.title}>Planning</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 18, gap: 14, paddingBottom: 40 }} refreshControl={<RefreshControl tintColor={colors.brand} refreshing={false} onRefresh={load} />}>
          <Label>Courses proposées · {available.length}</Label>
          {available.length === 0 && <Text style={styles.empty}>Aucune course planifiée à prendre pour le moment.</Text>}
          {available.map((o) => (
            <Card key={o.offer_id} style={{ gap: 12 }}>
              <View style={styles.row}>
                <Text style={styles.when}>{formatRideDate(o.pickup_at, tz)}</Text>
                <Text style={styles.price}>{formatPrice(o.price_cents)}</Text>
              </View>
              <RouteLine from={shortAddress(o.pickup_address)} to={shortAddress(o.dropoff_address)} />
              <BigButton
                title="Prendre cette course"
                height={52}
                loading={busy === o.offer_id}
                onPress={async () => {
                  setBusy(o.offer_id);
                  const res = await api.accept(o.offer_id).catch((e: Error) => ({ ok: false, message: e.message }) as { ok: boolean; message?: string });
                  setBusy(null);
                  Alert.alert(res.ok ? "Course attribuée" : "Trop tard", res.ok ? "Ajoutée à votre planning. Rappels programmés." : (res.message ?? "Course déjà attribuée."));
                  await load();
                }}
              />
            </Card>
          ))}

          <View style={{ height: 8 }} />
          <Label>Mes courses planifiées · {mine.length}</Label>
          {mine.length === 0 && <Text style={styles.empty}>Aucune course à venir.</Text>}
          {mine.map((r) => (
            <Pressable key={r.id} onPress={() => router.push({ pathname: "/ride/[id]", params: { id: r.id } })}>
              <Card style={{ gap: 12, borderColor: "rgba(167,139,250,0.3)" }}>
                <View style={styles.row}>
                  <Text style={[styles.when, { color: colors.violet }]}>{formatRideDate(r.pickup_at, tz)}</Text>
                  <Text style={styles.price}>{formatPrice(r.price_cents)}</Text>
                </View>
                <RouteLine from={shortAddress(r.pickup_address)} to={shortAddress(r.dropoff_address)} />
              </Card>
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  title: { color: colors.fg, fontSize: 18, fontWeight: "800" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  when: { color: colors.fg, fontSize: 16, fontWeight: "800" },
  price: { color: colors.fg, fontSize: 18, fontWeight: "900" },
  empty: { color: colors.subtle, fontSize: 14 },
});
