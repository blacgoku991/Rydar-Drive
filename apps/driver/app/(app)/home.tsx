import { Ionicons } from "@expo/vector-icons";
import { DRIVER_FLOW, RIDE_STATUS_META, formatPrice, formatRideDate, shortAddress, type Ride, type RideStatus } from "@rydar/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RydarMap } from "@/components/map/rydar-map";
import { BigButton, Pill, RouteLine, Screen, Sheet } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
import { colors, presenceColor } from "@/theme";

export default function Home() {
  const { home, offers, setOnline, busy } = useDriver();
  const [current, setCurrent] = useState<Ride | null>(null);
  const me = useMyPosition();
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

  const initials = `${(home?.driver.first_name ?? "?").charAt(0)}${(home?.driver.last_name ?? "").charAt(0)}`;

  return (
    <Screen>
      <RydarMap me={me} dim={!online} pulse={online && !current} padding={{ top: 120, bottom: 360, left: 40, right: 40 }} />

      {/* Barre supérieure */}
      <SafeAreaView edges={["top"]} style={styles.top} pointerEvents="box-none">
        <Pressable onPress={() => router.push("/profile")} style={styles.avatar} accessibilityLabel="Profil">
          <Text style={styles.avatarText}>{initials}</Text>
        </Pressable>
        <View style={styles.earnings}>
          <Text style={styles.earningsLabel}>Aujourd&apos;hui</Text>
          <Text style={styles.earningsValue}>
            {formatPrice(home?.today.revenue_cents ?? 0)}
            <Text style={styles.earningsSub}>  · {home?.today.rides ?? 0} course{(home?.today.rides ?? 0) > 1 ? "s" : ""}</Text>
          </Text>
        </View>
        <Pressable onPress={() => router.push("/planning")} style={styles.avatar} accessibilityLabel="Planning">
          <Ionicons name="calendar-outline" size={20} color={colors.fg} />
          {scheduledOffers > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{scheduledOffers}</Text>
            </View>
          )}
        </Pressable>
      </SafeAreaView>

      {/* Panneau */}
      <View style={styles.bottom} pointerEvents="box-none">
        <Sheet>
          <SafeAreaView edges={["bottom"]} style={{ gap: 16, paddingBottom: 12 }}>
            {current ? (
              <>
                <View style={styles.row}>
                  <View>
                    <Text style={styles.title}>Course en cours</Text>
                    <Text style={styles.subtitle}>#{current.number} · {formatPrice(current.price_cents)}</Text>
                  </View>
                  <Pill label={RIDE_STATUS_META[current.status as RideStatus].short} color={presenceColor[presence] ?? colors.cyan} />
                </View>
                <RouteLine from={shortAddress(current.pickup_address)} to={shortAddress(current.dropoff_address)} />
                <BigButton
                  title={DRIVER_FLOW[current.status as RideStatus]?.label ?? "Ouvrir la course"}
                  icon="arrow-forward-circle"
                  onPress={() => router.push({ pathname: "/ride/[id]", params: { id: current.id } })}
                />
              </>
            ) : (
              <>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.title}>{online ? "Vous êtes en ligne" : "Vous êtes hors ligne"}</Text>
                    <Text style={styles.subtitle}>
                      {online ? "Les courses proches vous sont proposées automatiquement." : "Passez en ligne pour recevoir les courses de votre centrale."}
                    </Text>
                  </View>
                  <View style={[styles.statusDot, { backgroundColor: online ? colors.brand : colors.subtle }]} />
                </View>

                {home?.next_scheduled && (
                  <Pressable onPress={() => router.push({ pathname: "/ride/[id]", params: { id: home.next_scheduled!.id } })} style={styles.next}>
                    <Ionicons name="time-outline" size={20} color={colors.violet} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.nextWhen}>{formatRideDate(home.next_scheduled.pickup_at, home.organization.timezone)}</Text>
                      <Text style={styles.nextRoute} numberOfLines={1}>
                        {shortAddress(home.next_scheduled.pickup_address)} → {shortAddress(home.next_scheduled.dropoff_address)}
                      </Text>
                    </View>
                    <Text style={styles.nextPrice}>{formatPrice(home.next_scheduled.price_cents)}</Text>
                  </Pressable>
                )}

                {online ? (
                  <BigButton title="Passer hors ligne" variant="secondary" icon="pause-circle-outline" height={56} onPress={toggle} loading={busy} />
                ) : (
                  <BigButton title="PASSER EN LIGNE" icon="power" height={72} onPress={toggle} loading={busy} />
                )}
              </>
            )}
          </SafeAreaView>
        </Sheet>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(17,19,24,0.92)", borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.fg, fontWeight: "800", fontSize: 15 },
  earnings: { flex: 1, height: 48, borderRadius: 24, backgroundColor: "rgba(17,19,24,0.92)", borderWidth: 1, borderColor: colors.line, justifyContent: "center", alignItems: "center" },
  earningsLabel: { color: colors.subtle, fontSize: 11, fontWeight: "600" },
  earningsValue: { color: colors.brand, fontSize: 17, fontWeight: "800" },
  earningsSub: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  badge: { position: "absolute", top: -2, right: -2, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.violet, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  badgeText: { color: colors.bg, fontWeight: "800", fontSize: 11 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { color: colors.fg, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  subtitle: { color: colors.muted, fontSize: 14.5, marginTop: 4, lineHeight: 20 },
  statusDot: { width: 14, height: 14, borderRadius: 7 },
  next: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, backgroundColor: colors.surface2 },
  nextWhen: { color: colors.violet, fontSize: 14, fontWeight: "700" },
  nextRoute: { color: colors.fg, fontSize: 14.5, marginTop: 2 },
  nextPrice: { color: colors.fg, fontSize: 16, fontWeight: "800" },
});
