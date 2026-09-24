import { Ionicons } from "@expo/vector-icons";
import { PAYMENT_METHOD_LABELS, VEHICLE_CATEGORY_META, formatDistance, formatDuration, formatPrice, formatRideDate, type DriverOffer } from "@rydar/shared";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, Vibration, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CountdownRing, RadarPulse } from "@/components/radar";
import { BigButton, RouteLine, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { colors } from "@/theme";

const RING_PATTERN = [0, 600, 300, 600, 300, 1000];

export default function OfferScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { offers, refresh, home } = useDriver();
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

  // Sonnerie + vibration tant que l'offre est ouverte
  useEffect(() => {
    if (state !== "open") return;
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: "duckOthers" }).catch(() => null);
    player.loop = true;
    player.volume = 1;
    player.play();
    Vibration.vibrate(RING_PATTERN, true);
    return () => {
      player.pause();
      Vibration.cancel();
    };
  }, [state, player]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // L'offre disparaît de la liste : prise par un autre chauffeur ou expirée
  useEffect(() => {
    if (state !== "open" || live) return;
    if (!snapshot.current) return;
    setState(remaining <= 0 ? "expired" : "taken");
  }, [live, state, remaining]);

  useEffect(() => {
    if (state === "open" && remaining <= 0) setState("expired");
  }, [remaining, state]);

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
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await refresh();
        if (offer.ride_type === "instant" && res.ride_id) router.replace({ pathname: "/ride/[id]", params: { id: String(res.ride_id) } });
        else {
          setMessage("Course planifiée ajoutée à votre planning.");
          setState("declined");
        }
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
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
        <Text style={styles.closedTitle}>Course déjà attribuée.</Text>
        <BigButton title="Retour" variant="secondary" onPress={() => router.replace("/home")} style={{ marginTop: 24, alignSelf: "stretch", marginHorizontal: 24 }} />
      </Screen>
    );
  }

  const closed = state === "taken" || state === "expired" || state === "declined";
  return (
    <Screen>
      <SafeAreaView style={{ flex: 1, padding: 20 }}>
        <View style={styles.top}>
          <View>
            <Text style={styles.kicker}>{offer.ride_type === "instant" ? "NOUVELLE COURSE" : "NOUVELLE COURSE PLANIFIÉE"}</Text>
            <Text style={styles.number}>#{offer.number} · {VEHICLE_CATEGORY_META[offer.vehicle_category].label}</Text>
          </View>
          {offer.ride_type === "instant" && !closed && <CountdownRing total={total} remaining={remaining} />}
        </View>

        <View style={styles.hero}>
          <RadarPulse size={280} active={!closed} color={closed ? colors.subtle : colors.brand} />
          <Text style={styles.price}>{formatPrice(offer.price_cents)}</Text>
          <Text style={styles.priceSub}>{PAYMENT_METHOD_LABELS[offer.payment_method]}</Text>
          {offer.distance_m != null && (
            <View style={styles.distance}>
              <Ionicons name="navigate" size={15} color={colors.brand} />
              <Text style={styles.distanceText}>{formatDistance(offer.distance_m)} du client</Text>
            </View>
          )}
        </View>

        <View style={styles.card}>
          {offer.ride_type === "scheduled" && <Text style={styles.when}>{formatRideDate(offer.pickup_at, home?.organization.timezone)}</Text>}
          <RouteLine from={offer.pickup_address} to={offer.dropoff_address} big />
          <View style={styles.meta}>
            <Meta icon="people" text={`${offer.passengers} passager${offer.passengers > 1 ? "s" : ""}`} />
            <Meta icon="briefcase" text={`${offer.luggage} bagage${offer.luggage > 1 ? "s" : ""}`} />
            {offer.estimated_distance_m != null && <Meta icon="speedometer" text={`${formatDistance(offer.estimated_distance_m)} · ${formatDuration(offer.estimated_duration_s)}`} />}
            {offer.flight_number && <Meta icon="airplane" text={offer.flight_number} />}
          </View>
          {offer.comment && <Text style={styles.comment}>« {offer.comment} »</Text>}
        </View>

        <View style={{ gap: 12, marginTop: "auto" }}>
          {closed ? (
            <View style={styles.closedBox}>
              <Ionicons name={state === "declined" && message ? "checkmark-circle" : "close-circle"} size={22} color={state === "declined" && message ? colors.brand : colors.amber} />
              <Text style={styles.closedText}>{message ?? (state === "expired" ? "Offre expirée." : state === "declined" ? "Offre refusée." : "Course déjà attribuée.")}</Text>
            </View>
          ) : (
            <>
              <BigButton title="ACCEPTER LA COURSE" icon="checkmark-circle" height={76} onPress={accept} loading={state === "accepting"} />
              <BigButton title="Refuser" variant="secondary" height={52} onPress={decline} disabled={state === "accepting"} />
            </>
          )}
        </View>
      </SafeAreaView>
    </Screen>
  );
}

function Meta({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.metaItem}>
      <Ionicons name={icon} size={15} color={colors.muted} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  kicker: { color: colors.brand, fontSize: 13, fontWeight: "900", letterSpacing: 2.4 },
  number: { color: colors.muted, fontSize: 14, marginTop: 6, fontWeight: "600" },
  hero: { alignItems: "center", justifyContent: "center", height: 250 },
  price: { color: colors.fg, fontSize: 64, fontWeight: "900", letterSpacing: -2 },
  priceSub: { color: colors.subtle, fontSize: 13, marginTop: 2 },
  distance: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: "rgba(200,240,60,0.1)", borderWidth: 1, borderColor: "rgba(200,240,60,0.3)" },
  distanceText: { color: colors.brand, fontWeight: "800", fontSize: 15 },
  card: { backgroundColor: colors.surface, borderRadius: 22, borderWidth: 1, borderColor: colors.line, padding: 20, gap: 16 },
  when: { color: colors.violet, fontSize: 18, fontWeight: "800" },
  meta: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { color: colors.muted, fontSize: 14, fontWeight: "600" },
  comment: { color: colors.muted, fontStyle: "italic", fontSize: 14 },
  closedBox: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, height: 76, borderRadius: 20, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong },
  closedText: { color: colors.fg, fontSize: 17, fontWeight: "800" },
  closedTitle: { color: colors.fg, fontSize: 22, fontWeight: "800" },
});
