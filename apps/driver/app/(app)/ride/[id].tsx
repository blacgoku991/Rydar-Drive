import { Ionicons } from "@expo/vector-icons";
import {
  DRIVER_FLOW, PAYMENT_METHOD_LABELS, RIDE_STATUS_META, formatPhone, formatPrice, formatRideDate, type Ride, type RideStatus,
} from "@rydar/shared";
import { useKeepAwake } from "expo-keep-awake";
import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { BigButton, Card, Label, Pill, RouteLine, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { setHighAccuracy } from "@/lib/location";
import { colors } from "@/theme";

const STEP_COLOR: Partial<Record<RideStatus, string>> = {
  ACCEPTED: colors.blue, DRIVER_EN_ROUTE: colors.blue, DRIVER_ARRIVED: colors.violet, PASSENGER_ONBOARD: colors.cyan, IN_PROGRESS: colors.cyan, COMPLETED: colors.green,
};

const darkMap = [
  { elementType: "geometry", stylers: [{ color: "#0e1116" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8a93a2" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#07080b" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1a1e27" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#05070a" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
];

function openNavigation(lat: number, lng: number, label: string) {
  const options = [
    { title: "Waze", url: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` },
    { title: "Google Maps", url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving` },
    ...(Platform.OS === "ios" ? [{ title: "Plans", url: `http://maps.apple.com/?daddr=${lat},${lng}&q=${encodeURIComponent(label)}` }] : []),
  ];
  Alert.alert("Navigation", label, [...options.map((o) => ({ text: o.title, onPress: () => void Linking.openURL(o.url) })), { text: "Annuler", style: "cancel" as const }]);
}

export default function RideScreen() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh, home } = useDriver();
  const [ride, setRide] = useState<Ride | null>(null);
  const [me, setMe] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const mapRef = useRef<MapView>(null);

  const load = useCallback(async () => {
    const r = await api.ride(String(id)).catch(() => null);
    setRide(r);
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    void setHighAccuracy(true).catch(() => null);
    Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 15 }, (l) => setMe({ latitude: l.coords.latitude, longitude: l.coords.longitude }))
      .then((s) => (sub = s))
      .catch(() => null);
    return () => {
      sub?.remove();
      void setHighAccuracy(false).catch(() => null);
    };
  }, []);

  useEffect(() => {
    if (!ride) return;
    const pts = [{ latitude: ride.pickup_lat, longitude: ride.pickup_lng }];
    if (ride.dropoff_lat != null && ride.dropoff_lng != null) pts.push({ latitude: ride.dropoff_lat, longitude: ride.dropoff_lng });
    if (me) pts.push(me);
    mapRef.current?.fitToCoordinates(pts, { edgePadding: { top: 80, bottom: 80, left: 60, right: 60 }, animated: true });
  }, [ride?.id, me === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ride) {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.muted }}>Chargement de la course…</Text>
      </Screen>
    );
  }

  const status = ride.status as RideStatus;
  const step = DRIVER_FLOW[status];
  const toPickup = ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"].includes(status);
  const target = toPickup || ride.dropoff_lat == null
    ? { lat: ride.pickup_lat, lng: ride.pickup_lng, label: ride.pickup_address }
    : { lat: ride.dropoff_lat!, lng: ride.dropoff_lng!, label: ride.dropoff_address };

  async function advance() {
    if (!step || !ride) return;
    setLoading(true);
    const res = await api.updateStatus(ride.id, step.next).catch((e: Error) => ({ ok: false, message: e.message }) as { ok: boolean; message?: string });
    setLoading(false);
    if (!res.ok) return Alert.alert("Action impossible", res.message ?? "Réessayez.");
    await Promise.all([load(), refresh()]);
    if (step.next === "COMPLETED") {
      Alert.alert("Course terminée", `${formatPrice(ride.price_cents)} · ${PAYMENT_METHOD_LABELS[ride.payment_method]}`, [{ text: "OK", onPress: () => router.replace("/home") }]);
    }
  }

  return (
    <Screen>
      <View style={{ height: "42%" }}>
        <MapView ref={mapRef} style={StyleSheet.absoluteFill} provider={PROVIDER_DEFAULT} customMapStyle={darkMap} userInterfaceStyle="dark" showsUserLocation showsMyLocationButton={false}>
          <Marker coordinate={{ latitude: ride.pickup_lat, longitude: ride.pickup_lng }} title="Départ" pinColor={colors.brand} />
          {ride.dropoff_lat != null && ride.dropoff_lng != null && (
            <>
              <Marker coordinate={{ latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }} title="Destination" pinColor="#ffffff" />
              <Polyline coordinates={[{ latitude: ride.pickup_lat, longitude: ride.pickup_lng }, { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }]} strokeColor="rgba(255,255,255,0.35)" strokeWidth={2} lineDashPattern={[4, 6]} />
            </>
          )}
        </MapView>
        <SafeAreaView edges={["top"]} style={styles.mapTop}>
          <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))} style={styles.back} accessibilityLabel="Retour">
            <Ionicons name="chevron-back" size={22} color={colors.fg} />
          </Pressable>
          <Pill label={RIDE_STATUS_META[status].label} color={STEP_COLOR[status] ?? colors.subtle} />
        </SafeAreaView>
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, gap: 14, paddingBottom: 190 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
          <View>
            <Label>Course #{ride.number}</Label>
            <Text style={styles.when}>{formatRideDate(ride.pickup_at, home?.organization.timezone)}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.price}>{formatPrice(ride.price_cents)}</Text>
            <Text style={styles.pay}>{PAYMENT_METHOD_LABELS[ride.payment_method]}</Text>
          </View>
        </View>

        <Card style={{ gap: 16 }}>
          <RouteLine from={ride.pickup_address} to={ride.dropoff_address} />
          <Pressable style={styles.nav} onPress={() => openNavigation(target.lat, target.lng, target.label)}>
            <Ionicons name="navigate-circle" size={22} color={colors.brand} />
            <Text style={styles.navText}>{toPickup ? "Itinéraire vers le client" : "Itinéraire vers la destination"}</Text>
          </Pressable>
        </Card>

        <Card style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <View style={styles.clientIcon}><Ionicons name="person" size={20} color={colors.fg} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.client}>{ride.customer_name}</Text>
            <Text style={styles.clientSub}>{ride.passengers} pax · {ride.luggage} bagage{ride.luggage > 1 ? "s" : ""}{ride.flight_number ? ` · vol ${ride.flight_number}` : ""}</Text>
          </View>
          <Pressable style={styles.call} onPress={() => void Linking.openURL(`tel:${ride.customer_phone}`)} accessibilityLabel={`Appeler ${formatPhone(ride.customer_phone)}`}>
            <Ionicons name="call" size={20} color={colors.brandFg} />
          </Pressable>
        </Card>
        {ride.comment ? <Card><Label>Note de la centrale</Label><Text style={styles.comment}>{ride.comment}</Text></Card> : null}
      </ScrollView>

      <SafeAreaView edges={["bottom"]} style={styles.footer}>
        {step ? (
          <>
            <Text style={styles.hint}>{step.hint}</Text>
            <BigButton title={step.label} onPress={advance} loading={loading} height={72} icon={step.next === "COMPLETED" ? "flag" : "arrow-forward-circle"} />
          </>
        ) : (
          <BigButton title="Retour à l'accueil" variant="secondary" onPress={() => router.replace("/home")} />
        )}
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapTop: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 8 },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(10,12,16,0.85)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line },
  when: { color: colors.fg, fontSize: 20, fontWeight: "800", marginTop: 4 },
  price: { color: colors.fg, fontSize: 30, fontWeight: "900", letterSpacing: -1 },
  pay: { color: colors.subtle, fontSize: 12 },
  nav: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line },
  navText: { color: colors.brand, fontSize: 15, fontWeight: "700" },
  clientIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  client: { color: colors.fg, fontSize: 17, fontWeight: "700" },
  clientSub: { color: colors.subtle, fontSize: 13, marginTop: 2 },
  call: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  comment: { color: colors.muted, fontSize: 15, marginTop: 8 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 18, paddingBottom: 12, backgroundColor: "rgba(7,8,11,0.96)", borderTopWidth: 1, borderTopColor: colors.line, gap: 10 },
  hint: { color: colors.subtle, fontSize: 13, textAlign: "center" },
});
