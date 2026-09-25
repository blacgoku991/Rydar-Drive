import { Ionicons } from "@expo/vector-icons";
import {
  DRIVER_FLOW, PAYMENT_METHOD_LABELS, RIDE_STATUS_META, decodePolyline, formatDistance, formatDuration, formatPhone, formatPrice, formatRideDate,
  haversine, type Ride, type RideStatus,
} from "@rydar/shared";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { FlightCard, PickupShiftBanner } from "@/components/flight";
import { RydarMap } from "@/components/map/rydar-map";
import { BigButton, Chip, Pill, Screen, Sheet, SlideToConfirm, StepDots } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { setHighAccuracy } from "@/lib/location";
import { approachSeconds, colors } from "@/theme";

const STEP_COLOR: Partial<Record<RideStatus, string>> = {
  ACCEPTED: colors.blue, DRIVER_EN_ROUTE: colors.blue, DRIVER_ARRIVED: colors.violet, PASSENGER_ONBOARD: colors.cyan, IN_PROGRESS: colors.cyan, COMPLETED: colors.green,
};
const STEPS: { status: RideStatus; label: string }[] = [
  { status: "ACCEPTED", label: "Aller au départ" },
  { status: "DRIVER_EN_ROUTE", label: "En route vers le client" },
  { status: "DRIVER_ARRIVED", label: "Au point de départ" },
  { status: "PASSENGER_ONBOARD", label: "Client à bord" },
  { status: "IN_PROGRESS", label: "En course" },
];

function openNav(app: "waze" | "google" | "apple", lat: number, lng: number, label: string) {
  const url =
    app === "waze"
      ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`
      : app === "google"
        ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
        : `http://maps.apple.com/?daddr=${lat},${lng}&q=${encodeURIComponent(label)}`;
  void Linking.openURL(url);
}

export default function RideScreen() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh, home } = useDriver();
  const me = useMyPosition();
  const [ride, setRide] = useState<Ride | null>(null);
  const [loading, setLoading] = useState(false);

  const hadRide = useRef(false);
  const load = useCallback(async () => {
    const r = await api.ride(String(id)).catch(() => undefined); // undefined : réseau, on garde l'affichage
    if (r === undefined) return;
    if (r === null && hadRide.current) {
      // Course retirée par la centrale (réattribuée) : plus visible pour ce chauffeur
      hadRide.current = false;
      Alert.alert("Course retirée", "La centrale a réattribué cette course.");
      router.replace("/home");
      return;
    }
    if (r) hadRide.current = true;
    setRide(r);
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  // Vol retardé, prise en charge décalée, course retirée : relecture immédiate
  useAppEvent("ride", (rideId) => {
    if (!rideId || rideId === String(id)) void load();
  });

  useEffect(() => {
    void setHighAccuracy(true).catch(() => null);
    return () => void setHighAccuracy(false).catch(() => null);
  }, []);

  const route = useMemo(() => (ride?.route_polyline ? decodePolyline(ride.route_polyline) : null), [ride?.route_polyline]);

  if (!ride) {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.muted }}>Chargement de la course…</Text>
      </Screen>
    );
  }

  const status = ride.status as RideStatus;
  const step = DRIVER_FLOW[status];
  const stepIndex = Math.max(0, STEPS.findIndex((s) => s.status === status));
  const toPickup = ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"].includes(status);
  const target = toPickup || ride.dropoff_lat == null
    ? { lat: ride.pickup_lat, lng: ride.pickup_lng, label: ride.pickup_address }
    : { lat: ride.dropoff_lat!, lng: ride.dropoff_lng!, label: ride.dropoff_address };
  const distToTarget = me ? haversine(me, target) : null;
  const etaToTarget = toPickup ? approachSeconds(distToTarget) : distToTarget != null && ride.estimated_distance_m ? Math.round(((distToTarget * 1.3) / Math.max(1, ride.estimated_distance_m)) * (ride.estimated_duration_s ?? 0)) : null;

  async function advance() {
    if (!step || !ride) return;
    setLoading(true);
    const res = await api.updateStatus(ride.id, step.next).catch((e: Error) => ({ ok: false, message: e.message }) as { ok: boolean; message?: string });
    setLoading(false);
    if (!res.ok) return Alert.alert("Action impossible", res.message ?? "Réessayez.");
    await Promise.all([load(), refresh()]);
    if (step.next === "COMPLETED") {
      Alert.alert("Course terminée", `${formatPrice(ride.price_cents)} · ${PAYMENT_METHOD_LABELS[ride.payment_method]}`, [{ text: "OK", onPress: () => router.replace("/home") }]);
      if (Platform.OS === "web") router.replace("/home");
    }
  }

  return (
    <Screen>
      <View style={styles.mapBox}>
        <RydarMap
          me={me}
          pickup={{ lat: ride.pickup_lat, lng: ride.pickup_lng }}
          dropoff={ride.dropoff_lat != null && ride.dropoff_lng != null ? { lat: ride.dropoff_lat, lng: ride.dropoff_lng } : null}
          route={route}
          padding={{ top: 100, bottom: 80, left: 50, right: 50 }}
        />
        <SafeAreaView edges={["top"]} style={styles.mapTop} pointerEvents="box-none">
          <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))} style={styles.round} accessibilityLabel="Retour">
            <Ionicons name="chevron-back" size={22} color={colors.fg} />
          </Pressable>
          <Pill label={RIDE_STATUS_META[status].label} color={STEP_COLOR[status] ?? colors.subtle} />
        </SafeAreaView>
        {step && (
          <View style={styles.navRow}>
            <Pressable style={styles.navBtn} onPress={() => openNav("waze", target.lat, target.lng, target.label)} accessibilityLabel="Ouvrir Waze">
              <Ionicons name="navigate" size={18} color={colors.brandFg} />
              <Text style={styles.navText}>Waze</Text>
            </Pressable>
            <Pressable style={[styles.navBtn, styles.navBtnAlt]} onPress={() => openNav(Platform.OS === "ios" ? "apple" : "google", target.lat, target.lng, target.label)} accessibilityLabel="Ouvrir le GPS">
              <Ionicons name="map" size={18} color={colors.fg} />
              <Text style={[styles.navText, { color: colors.fg }]}>{Platform.OS === "ios" ? "Plans" : "Maps"}</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Sheet style={styles.sheet}>
        <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 150 }} showsVerticalScrollIndicator={false}>
          {toPickup && <PickupShiftBanner ride={ride} tz={home?.organization.timezone} />}
          {step && <StepDots steps={STEPS.map((s) => s.label)} current={stepIndex} />}

          <View style={styles.targetRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.targetKicker}>{toPickup ? "Prise en charge" : "Destination"}</Text>
              <Text style={styles.target} numberOfLines={2}>{target.label}</Text>
            </View>
            {etaToTarget != null && step && (
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.eta}>{formatDuration(etaToTarget)}</Text>
                <Text style={styles.etaSub}>{formatDistance(distToTarget)}</Text>
              </View>
            )}
          </View>

          <View style={styles.client}>
            <View style={styles.clientIcon}>
              <Text style={styles.clientInitial}>{ride.customer_name.charAt(0)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.clientName} numberOfLines={1}>{ride.customer_name}</Text>
              <Text style={styles.clientSub}>{formatRideDate(ride.pickup_at, home?.organization.timezone)} · {formatPrice(ride.price_cents)}</Text>
            </View>
            <Pressable style={styles.call} onPress={() => void Linking.openURL(`tel:${ride.customer_phone}`)} accessibilityLabel={`Appeler ${formatPhone(ride.customer_phone)}`}>
              <Ionicons name="call" size={22} color={colors.brandFg} />
            </Pressable>
          </View>

          {/* Vol suivi (prise en charge à l'aéroport ou dépôt pour un vol) */}
          {ride.flight_number ? <FlightCard ride={ride} tz={home?.organization.timezone} /> : null}

          <View style={styles.chips}>
            <Chip icon="people-outline" text={`${ride.passengers} passager${ride.passengers > 1 ? "s" : ""}`} />
            <Chip icon="briefcase-outline" text={`${ride.luggage}`} />
            <Chip icon="card-outline" text={PAYMENT_METHOD_LABELS[ride.payment_method]} />
          </View>
          {ride.comment ? (
            <View style={styles.note}>
              <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.amber} />
              <Text style={styles.noteText}>{ride.comment}</Text>
            </View>
          ) : null}
        </ScrollView>
      </Sheet>

      <SafeAreaView edges={["bottom"]} style={styles.footer}>
        {step ? (
          <SlideToConfirm label={step.label} onConfirm={advance} loading={loading} color={step.next === "COMPLETED" ? colors.green : colors.brand} />
        ) : (
          <BigButton title="Retour à l'accueil" variant="secondary" onPress={() => router.replace("/home")} />
        )}
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapBox: { height: "50%" },
  mapTop: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 8 },
  round: { width: 46, height: 46, borderRadius: 23, backgroundColor: "rgba(17,19,24,0.92)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line },
  navRow: { position: "absolute", right: 14, bottom: 38, flexDirection: "row", gap: 8 },
  navBtn: { flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: colors.brand },
  navBtnAlt: { backgroundColor: "rgba(17,19,24,0.94)", borderWidth: 1, borderColor: colors.line },
  navText: { color: colors.brandFg, fontWeight: "800", fontSize: 15 },
  sheet: { flex: 1, marginTop: -24 },
  targetRow: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  targetKicker: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
  target: { color: colors.fg, fontSize: 20, fontWeight: "800", marginTop: 2, letterSpacing: -0.3 },
  eta: { color: colors.brand, fontSize: 26, fontWeight: "900" },
  etaSub: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  client: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 18, backgroundColor: colors.surface2 },
  clientIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  clientInitial: { color: colors.fg, fontSize: 18, fontWeight: "800" },
  clientName: { color: colors.fg, fontSize: 17, fontWeight: "700" },
  clientSub: { color: colors.subtle, fontSize: 13, marginTop: 2 },
  call: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  note: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 14, backgroundColor: "rgba(245,181,68,0.08)" },
  noteText: { color: colors.fg, fontSize: 15, flex: 1 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, backgroundColor: colors.surface },
});
