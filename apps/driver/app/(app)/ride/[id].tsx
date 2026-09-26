import { Ionicons } from "@expo/vector-icons";
import {
  DRIVER_FLOW, PAYMENT_METHOD_LABELS, RIDE_STATUS_META, decodePolyline, driverCollects, formatDistance, formatDuration, formatPhone, formatPrice,
  formatRideDate, haversine, shortAddress, type DriverSettlementItem, type Ride, type RideStatus,
} from "@rydar/shared";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CollectNote, deductionCents, dueText, frTypo } from "@/components/centrale";
import { FlightCard, PickupShiftBanner } from "@/components/flight";
import { RydarMap } from "@/components/map/rydar-map";
import { BigButton, BottomSheet, Chip, Pill, Screen, Sheet, SlideToConfirm, StepDots } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { setHighAccuracy } from "@/lib/location";
import { approachSeconds, colors, control, mono, overlay, radius, space, type, weight } from "@/theme";

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
/** Relecture de secours : les changements arrivent déjà en temps réel (appEvents « ride »). */
const POLL_MS = 30_000;
/** Cadrage de la carte (constante : la carte mémorisée n'est pas redessinée à chaque rendu de l'écran). */
const MAP_PADDING = { top: 100, bottom: 80, left: 50, right: 50 };

const NBSP = " ";
const passengersText = (n: number) => `${n}${NBSP}passager${n > 1 ? "s" : ""}`;
const luggageText = (n: number) => (n > 0 ? `${n}${NBSP}bagage${n > 1 ? "s" : ""}` : "Sans bagage");

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
  // Écran allumé pendant la course ; départ rapide de l'écran (fin de course → Commissions) : sur le web,
  // le verrou peut ne pas être encore actif au démontage — pas d'erreur dans ce cas
  useKeepAwake(undefined, { suppressDeactivateWarnings: true });
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh, home } = useDriver();
  const me = useMyPosition();
  const [ride, setRide] = useState<Ride | null>(null);
  const [loading, setLoading] = useState(false);
  // Mode centrale : récapitulatif de fin de course (part chauffeur, commission à régler ou part à recevoir)
  const [done, setDone] = useState<{ ride: Ride; settlement: DriverSettlementItem | null } | null>(null);

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
    const t = setInterval(load, POLL_MS);
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
  // Points de la carte : mêmes objets tant que les coordonnées ne changent pas (pas de recadrage ni de rendu natif inutile)
  const pickupLat = ride?.pickup_lat;
  const pickupLng = ride?.pickup_lng;
  const dropoffLat = ride?.dropoff_lat;
  const dropoffLng = ride?.dropoff_lng;
  const pickup = useMemo(() => (pickupLat != null && pickupLng != null ? { lat: pickupLat, lng: pickupLng } : null), [pickupLat, pickupLng]);
  const dropoff = useMemo(() => (dropoffLat != null && dropoffLng != null ? { lat: dropoffLat, lng: dropoffLng } : null), [dropoffLat, dropoffLng]);

  if (!ride) {
    return (
      <Screen style={styles.center}>
        <ActivityIndicator color={colors.muted} />
        <Text style={styles.loadingText} accessibilityLiveRegion="polite">Chargement de la course…</Text>
      </Screen>
    );
  }

  const status = ride.status as RideStatus;
  const step = DRIVER_FLOW[status];
  // Mode centrale : répartition calculée sur la course (part chauffeur / commission / frais plateforme)
  const centrale = (home?.model ?? home?.organization.dispatch_model) === "centrale" && ride.driver_payout_cents != null;
  const stepIndex = Math.max(0, STEPS.findIndex((s) => s.status === status));
  const toPickup = ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"].includes(status);
  const target = toPickup || ride.dropoff_lat == null
    ? { lat: ride.pickup_lat, lng: ride.pickup_lng, label: ride.pickup_address }
    : { lat: ride.dropoff_lat!, lng: ride.dropoff_lng!, label: ride.dropoff_address };
  const distToTarget = me ? haversine(me, target) : null;
  const etaToTarget = toPickup ? approachSeconds(distToTarget) : distToTarget != null && ride.estimated_distance_m ? Math.round(((distToTarget * 1.3) / Math.max(1, ride.estimated_distance_m)) * (ride.estimated_duration_s ?? 0)) : null;
  const navApp = Platform.OS === "ios" ? "Plans" : "Maps";

  async function advance() {
    if (!step || !ride) return;
    setLoading(true);
    const res = await api.updateStatus(ride.id, step.next).catch((e: Error) => ({ ok: false, message: e.message }) as { ok: boolean; message?: string });
    setLoading(false);
    if (!res.ok) return Alert.alert("Action impossible", res.message ? frTypo(res.message) : "Réessayez.");
    await Promise.all([load(), refresh()]);
    if (step.next === "COMPLETED" && centrale) {
      // Règlement créé à la clôture (trigger) : montant et échéance exacts pour le récapitulatif
      const mine = await api.settlements(20).catch(() => null);
      setDone({ ride, settlement: mine?.items.find((x) => x.ride_id === ride.id) ?? null });
      return;
    }
    if (step.next === "COMPLETED") {
      Alert.alert(`Course ${ride.number} terminée`, `${formatPrice(ride.price_cents)} · ${PAYMENT_METHOD_LABELS[ride.payment_method]}`, [{ text: "OK", onPress: () => router.replace("/home") }]);
      if (Platform.OS === "web") router.replace("/home");
    }
  }

  return (
    <Screen>
      <View style={styles.mapBox}>
        <RydarMap me={me} pickup={pickup} dropoff={dropoff} route={route} padding={MAP_PADDING} />
        <SafeAreaView edges={["top"]} style={styles.mapTop} pointerEvents="box-none">
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
            style={({ pressed }) => [styles.round, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Retour"
            hitSlop={4}
          >
            <Ionicons name="chevron-back" size={22} color={colors.fg} />
          </Pressable>
          <View style={styles.statusBox} accessible accessibilityLabel={`Course ${ride.number}, ${RIDE_STATUS_META[status].label}`}>
            <Text style={styles.statusNumber}>Course {ride.number}</Text>
            <View>
              <Pill label={RIDE_STATUS_META[status].label} color={STEP_COLOR[status] ?? colors.muted} />
            </View>
          </View>
        </SafeAreaView>
        {step && (
          <View style={styles.navRow}>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}
              onPress={() => openNav("waze", target.lat, target.lng, target.label)}
              accessibilityRole="button"
              accessibilityLabel="Ouvrir l'itinéraire dans Waze"
            >
              <Ionicons name="navigate-outline" size={20} color={colors.muted} />
              <Text style={styles.navText}>Waze</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}
              onPress={() => openNav(Platform.OS === "ios" ? "apple" : "google", target.lat, target.lng, target.label)}
              accessibilityRole="button"
              accessibilityLabel={`Ouvrir l'itinéraire dans ${navApp}`}
            >
              <Ionicons name="map-outline" size={20} color={colors.muted} />
              <Text style={styles.navText}>{navApp}</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Sheet style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {toPickup && <PickupShiftBanner ride={ride} tz={home?.organization.timezone} />}
          {step && <StepDots steps={STEPS.map((s) => s.label)} current={stepIndex} />}

          <View style={styles.targetRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.targetKicker}>{toPickup ? "Prise en charge" : "Destination"}</Text>
              <Text style={styles.target} numberOfLines={2}>{target.label}</Text>
            </View>
            {etaToTarget != null && step && (
              <View style={styles.etaBox} accessible accessibilityLabel={`Arrivée dans ${formatDuration(etaToTarget)}, ${formatDistance(distToTarget)}`}>
                <Text style={styles.eta}>{formatDuration(etaToTarget)}</Text>
                <Text style={styles.etaSub}>{formatDistance(distToTarget)}</Text>
              </View>
            )}
          </View>

          <View style={styles.client}>
            <Ionicons name="person-outline" size={20} color={colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.clientName} numberOfLines={1}>{ride.customer_name}</Text>
              <Text style={styles.clientSub} numberOfLines={1}>{formatRideDate(ride.pickup_at, home?.organization.timezone)} · {formatPrice(ride.price_cents)}</Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.call, pressed && styles.pressed]}
              onPress={() => void Linking.openURL(`tel:${ride.customer_phone}`)}
              accessibilityRole="button"
              accessibilityLabel={`Appeler ${ride.customer_name}, ${formatPhone(ride.customer_phone)}`}
            >
              <Ionicons name="call-outline" size={22} color={colors.fg} />
            </Pressable>
          </View>

          {/* Vol suivi (prise en charge à l'aéroport ou dépôt pour un vol) */}
          {ride.flight_number ? <FlightCard ride={ride} tz={home?.organization.timezone} /> : null}

          <View style={styles.chips}>
            <Chip icon="people-outline" text={passengersText(ride.passengers)} />
            <Chip icon="briefcase-outline" text={luggageText(ride.luggage)} />
            <Chip icon="card-outline" text={PAYMENT_METHOD_LABELS[ride.payment_method]} />
            {centrale && <Chip icon="wallet-outline" text={`Vous gagnez ${formatPrice(ride.driver_payout_cents, ride.currency)}`} color={colors.fg} />}
          </View>
          {ride.comment ? (
            <View style={styles.note}>
              <Ionicons name="chatbubble-outline" size={20} color={colors.muted} style={styles.iconTop} />
              <View style={{ flex: 1 }}>
                <Text style={styles.noteLabel}>Commentaire</Text>
                <Text style={styles.noteText}>{ride.comment}</Text>
              </View>
            </View>
          ) : null}
        </ScrollView>
      </Sheet>

      <SafeAreaView edges={["bottom"]} style={styles.footer}>
        {step ? (
          <SlideToConfirm label={step.label} onConfirm={advance} loading={loading} color={step.next === "COMPLETED" ? colors.green : colors.brand} />
        ) : (
          <BigButton title="Retour à l'accueil" variant="secondary" height={control.md} onPress={() => router.replace("/home")} />
        )}
      </SafeAreaView>

      <BottomSheet visible={done != null} onClose={() => router.dismissTo("/home")}>
        {done && <RideDoneSummary ride={done.ride} settlement={done.settlement} tz={home?.organization.timezone} />}
      </BottomSheet>
    </Screen>
  );
}

/**
 * Fin de course (mode centrale) : « Course 1692 terminée · Vous gagnez 40 € », puis « Commission 19 € à régler »
 * (le chauffeur a encaissé le client) ou « 40 € vous seront versés par la centrale » (client payé en ligne).
 */
function RideDoneSummary({ ride, settlement, tz }: { ride: Ride; settlement: DriverSettlementItem | null; tz?: string }) {
  const currency = ride.currency ?? "EUR";
  const payout = settlement?.driver_payout_cents ?? ride.driver_payout_cents ?? null;
  const collects = settlement ? settlement.direction === "driver_owes" : driverCollects(ride.payment_method);
  const owed = settlement?.direction === "driver_owes" ? settlement.amount_cents : deductionCents(ride);
  const due = settlement?.direction === "driver_owes" && settlement.status === "due" ? dueText(settlement.due_at, tz) : null;
  return (
    <>
      <View style={styles.doneHead} accessibilityRole="header">
        <Ionicons name="checkmark-circle-outline" size={24} color={colors.muted} />
        <View style={{ flex: 1 }}>
          <Text style={styles.doneTitle}>Course {ride.number} terminée</Text>
          <Text style={styles.doneRoute} numberOfLines={1}>{shortAddress(ride.pickup_address)} → {shortAddress(ride.dropoff_address)}</Text>
        </View>
      </View>
      <View accessible accessibilityLabel={`Vous gagnez ${formatPrice(payout, currency)}. Course ${formatPrice(ride.price_cents, currency)}, ${PAYMENT_METHOD_LABELS[ride.payment_method]}.`}>
        <Text style={styles.doneGainLabel}>Vous gagnez</Text>
        <Text style={styles.doneGain} numberOfLines={1} adjustsFontSizeToFit>{formatPrice(payout, currency)}</Text>
        <Text style={styles.doneGainSub}>
          Course {formatPrice(ride.price_cents, currency)} · {PAYMENT_METHOD_LABELS[ride.payment_method]}
        </Text>
      </View>
      {collects ? (
        <>
          <View style={styles.owed}>
            <Ionicons name="wallet-outline" size={20} color={colors.muted} style={styles.iconTop} />
            <View style={{ flex: 1 }}>
              <Text style={styles.owedTitle}>Commission {formatPrice(owed, currency)} à régler</Text>
              <Text style={[styles.owedSub, due?.late && { color: colors.amber }]}>{due ? due.text : "À reverser à la centrale"}</Text>
            </View>
          </View>
          <CollectNote collects past price={ride.price_cents} deduction={owed} payout={payout} currency={currency} />
          <BigButton title="Payer maintenant" icon="wallet-outline" height={control.lg} onPress={() => router.replace("/commissions")} />
          <BigButton title="Plus tard" variant="ghost" height={control.md} onPress={() => router.dismissTo("/home")} />
        </>
      ) : (
        <>
          <View style={styles.owed}>
            <Ionicons name="arrow-down-circle-outline" size={20} color={colors.muted} style={styles.iconTop} />
            <Text style={[styles.owedTitle, { flex: 1 }]}>{formatPrice(payout, currency)} vous seront versés par la centrale</Text>
          </View>
          <BigButton title="Retour à l'accueil" height={control.lg} onPress={() => router.dismissTo("/home")} />
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", gap: space.md },
  loadingText: { color: colors.muted, fontSize: type.body },
  mapBox: { height: "50%" },
  mapTop: {
    position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm,
  },
  round: { ...overlay, width: control.sm, height: control.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.surface3 },
  statusBox: {
    ...overlay, flexDirection: "row", alignItems: "center", gap: 10, height: control.sm, borderRadius: radius.full,
    paddingLeft: space.lg, paddingRight: 6, flexShrink: 1,
  },
  statusNumber: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, ...mono },
  navRow: { position: "absolute", right: space.lg, bottom: 38, flexDirection: "row", gap: space.sm },
  navBtn: {
    ...overlay, flexDirection: "row", alignItems: "center", gap: space.sm, height: control.sm, paddingHorizontal: space.lg, borderRadius: radius.full,
  },
  navText: { color: colors.fg, fontWeight: weight.semibold, fontSize: type.body },
  sheet: { flex: 1, marginTop: -24 },
  scroll: { gap: space.lg, paddingBottom: 150 },
  targetRow: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  targetKicker: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium },
  target: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold, marginTop: 2, lineHeight: 26 },
  etaBox: { alignItems: "flex-end" },
  eta: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, ...mono },
  etaSub: { color: colors.muted, fontSize: type.body, ...mono },
  client: {
    flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm,
    borderRadius: radius.lg, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  clientName: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold },
  clientSub: { color: colors.muted, fontSize: type.body, marginTop: 2, ...mono },
  call: {
    width: control.md, height: control.md, borderRadius: radius.full, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong,
    alignItems: "center", justifyContent: "center",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  note: {
    flexDirection: "row", gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  iconTop: { marginTop: 1 },
  noteLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, marginBottom: 2 },
  noteText: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
  footer: {
    position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md,
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line,
  },
  doneHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  doneTitle: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold, ...mono },
  doneRoute: { color: colors.muted, fontSize: type.body, marginTop: 2 },
  doneGainLabel: { color: colors.muted, fontSize: type.body, fontWeight: weight.medium },
  doneGain: { color: colors.fg, fontSize: type.display, lineHeight: type.display + 6, fontWeight: weight.bold, letterSpacing: -0.5, ...mono },
  doneGainSub: { color: colors.muted, fontSize: type.body, ...mono },
  owed: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, borderRadius: radius.lg,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  owedTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, ...mono },
  owedSub: { color: colors.muted, fontSize: type.body, marginTop: 2 },
});
