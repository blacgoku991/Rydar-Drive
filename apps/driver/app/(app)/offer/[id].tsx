import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, VEHICLE_CATEGORY_META, decodePolyline, formatDistance, formatDuration, formatPrice, formatRideDate, type DriverOffer,
} from "@rydar/shared";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RydarMap } from "@/components/map/rydar-map";
import { CountdownRing } from "@/components/radar";
import { BigButton, Chip, RouteLine, Screen, Sheet } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
import { approachSeconds, colors } from "@/theme";

const RING_PATTERN = [0, 600, 300, 600, 300, 1000];

export default function OfferScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { offers, refresh, home } = useDriver();
  const me = useMyPosition();
  const snapshot = useRef<DriverOffer | null>(null);
  const live = offers.find((o) => o.offer_id === id) ?? null;
  if (live) snapshot.current = live;
  const offer = live ?? snapshot.current;
  const [now, setNow] = useState(Date.now());
  const [state, setState] = useState<"open" | "accepting" | "taken" | "expired" | "declined">("open");
  const [message, setMessage] = useState<string | null>(null);
  const player = useAudioPlayer(require("../../../assets/sounds/ride_offer.wav"));

  const total = useMemo(() => (offer?.expires_at && offer.sent_at ? (new Date(offer.expires_at).getTime() - new Date(offer.sent_at).getTime()) / 1000 : 30), [offer?.expires_at, offer?.sent_at]);
  const remaining = offer?.expires_at ? (new Date(offer.expires_at).getTime() - now) / 1000 : total;
  const route = useMemo(() => (offer?.route_polyline ? decodePolyline(offer.route_polyline) : null), [offer?.route_polyline]);

  // Sonnerie + vibration tant que l'offre est ouverte
  useEffect(() => {
    if (state !== "open") return;
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: "duckOthers" }).catch(() => null);
    try {
      player.loop = true;
      player.volume = 1;
      player.play();
    } catch {
      /* navigateur sans interaction : pas de son */
    }
    if (Platform.OS !== "web") Vibration.vibrate(RING_PATTERN, true);
    return () => {
      try {
        player.pause();
      } catch {
        /* lecteur libéré */
      }
      if (Platform.OS !== "web") Vibration.cancel();
    };
  }, [state, player]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // L'offre disparaît de la liste : prise par un autre chauffeur ou expirée
  useEffect(() => {
    if (state !== "open" || live || !snapshot.current) return;
    setState(remaining <= 0 ? "expired" : "taken");
  }, [live, state, remaining]);

  useEffect(() => {
    if (state === "open" && remaining <= 0 && offer?.ride_type === "instant") setState("expired");
  }, [remaining, state, offer?.ride_type]);

  useEffect(() => {
    if (state === "taken" || state === "expired" || state === "declined") {
      const t = setTimeout(() => (router.canGoBack() ? router.back() : router.replace("/home")), 2600);
      return () => clearTimeout(t);
    }
  }, [state]);

  async function accept() {
    if (!offer) return;
    setState("accepting");
    try {
      const res = await api.accept(offer.offer_id);
      if (res.ok) {
        if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await refresh();
        if (offer.ride_type === "instant" && res.ride_id) router.replace({ pathname: "/ride/[id]", params: { id: String(res.ride_id) } });
        else {
          setMessage("Course planifiée ajoutée à votre planning.");
          setState("declined");
        }
      } else {
        if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setMessage(res.message ?? "Course déjà attribuée.");
        setState("taken");
      }
    } catch (e) {
      setMessage((e as Error).message);
      setState("open");
    }
  }

  async function decline() {
    if (offer) await api.decline(offer.offer_id).catch(() => null);
    setMessage(null);
    setState("declined");
    void refresh();
  }

  if (!offer) {
    return (
      <Screen style={styles.center}>
        <Ionicons name="close-circle" size={48} color={colors.amber} />
        <Text style={styles.closedTitle}>Course déjà attribuée.</Text>
        <BigButton title="Retour" variant="secondary" onPress={() => router.replace("/home")} style={{ marginTop: 24, alignSelf: "stretch", marginHorizontal: 24 }} />
      </Screen>
    );
  }

  const closed = state === "taken" || state === "expired" || state === "declined";
  const eta = approachSeconds(offer.distance_m);
  return (
    <Screen>
      <View style={styles.mapBox}>
        <RydarMap
          me={me}
          pickup={{ lat: offer.pickup_lat, lng: offer.pickup_lng }}
          dropoff={offer.dropoff_lat != null && offer.dropoff_lng != null ? { lat: offer.dropoff_lat, lng: offer.dropoff_lng } : null}
          route={route}
          padding={{ top: 110, bottom: 60, left: 50, right: 50 }}
        />
        <SafeAreaView edges={["top"]} style={styles.mapTop} pointerEvents="box-none">
          <View style={styles.kickerBox}>
            <Text style={styles.kicker}>{offer.ride_type === "instant" ? "Nouvelle course" : "Course planifiée"}</Text>
            <Text style={styles.number}>#{offer.number} · {VEHICLE_CATEGORY_META[offer.vehicle_category].label}</Text>
          </View>
          {offer.ride_type === "instant" && !closed && (
            <View style={styles.ring}>
              <CountdownRing total={total} remaining={remaining} size={76} />
            </View>
          )}
        </SafeAreaView>
      </View>

      <Sheet style={styles.sheet}>
        <SafeAreaView edges={["bottom"]} style={{ flex: 1, gap: 16 }}>
          <View style={styles.priceRow}>
            <View>
              <Text style={styles.price}>{formatPrice(offer.price_cents)}</Text>
              <Text style={styles.priceSub}>{PAYMENT_METHOD_LABELS[offer.payment_method]}</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              {offer.ride_type === "scheduled" ? (
                <Text style={styles.when}>{formatRideDate(offer.pickup_at, home?.organization.timezone)}</Text>
              ) : eta != null ? (
                <>
                  <Text style={styles.eta}>{formatDuration(eta)}</Text>
                  <Text style={styles.etaSub}>{formatDistance(offer.distance_m)} du client</Text>
                </>
              ) : null}
            </View>
          </View>

          <RouteLine from={offer.pickup_address} to={offer.dropoff_address} big />

          <View style={styles.chips}>
            {offer.estimated_distance_m != null && <Chip icon="navigate-outline" text={`${formatDistance(offer.estimated_distance_m)} · ${formatDuration(offer.estimated_duration_s)}`} />}
            <Chip icon="people-outline" text={`${offer.passengers}`} />
            <Chip icon="briefcase-outline" text={`${offer.luggage}`} />
            {offer.flight_number && <Chip icon="airplane-outline" text={offer.flight_number} color={colors.cyan} />}
          </View>
          {offer.comment && <Text style={styles.comment}>« {offer.comment} »</Text>}

          <View style={{ gap: 6, marginTop: "auto" }}>
            {closed ? (
              <View style={styles.closedBox}>
                <Ionicons name={state === "declined" && message ? "checkmark-circle" : "close-circle"} size={24} color={state === "declined" && message ? colors.brand : colors.amber} />
                <Text style={styles.closedText}>{message ?? (state === "expired" ? "Offre expirée." : state === "declined" ? "Offre refusée." : "Course déjà attribuée.")}</Text>
              </View>
            ) : (
              <>
                <BigButton title="ACCEPTER" icon="checkmark-circle" height={80} onPress={accept} loading={state === "accepting"} />
                <Pressable onPress={decline} disabled={state === "accepting"} style={styles.decline} accessibilityRole="button">
                  <Text style={styles.declineText}>Refuser</Text>
                </Pressable>
              </>
            )}
          </View>
        </SafeAreaView>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", gap: 12 },
  mapBox: { height: "40%" },
  mapTop: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: 16, paddingTop: 8 },
  kickerBox: { backgroundColor: "rgba(17,19,24,0.92)", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: colors.line },
  kicker: { color: colors.brand, fontSize: 15, fontWeight: "800" },
  number: { color: colors.muted, fontSize: 13, marginTop: 2, fontWeight: "600" },
  ring: { backgroundColor: "rgba(17,19,24,0.92)", borderRadius: 48, padding: 4, borderWidth: 1, borderColor: colors.line },
  sheet: { flex: 1, marginTop: -24 },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  price: { color: colors.fg, fontSize: 52, fontWeight: "900", letterSpacing: -1.5 },
  priceSub: { color: colors.subtle, fontSize: 13, marginTop: -2 },
  eta: { color: colors.brand, fontSize: 28, fontWeight: "900", letterSpacing: -0.5 },
  etaSub: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  when: { color: colors.violet, fontSize: 18, fontWeight: "800" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  comment: { color: colors.muted, fontStyle: "italic", fontSize: 14 },
  decline: { height: 46, alignItems: "center", justifyContent: "center" },
  declineText: { color: colors.muted, fontSize: 16, fontWeight: "700" },
  closedBox: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, height: 80, borderRadius: 20, backgroundColor: colors.surface2 },
  closedText: { color: colors.fg, fontSize: 17, fontWeight: "800" },
  closedTitle: { color: colors.fg, fontSize: 22, fontWeight: "800" },
});
