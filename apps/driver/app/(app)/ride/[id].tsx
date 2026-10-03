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
import { NavBanner } from "@/components/nav-banner";
import { BigButton, BottomSheet, Chip, Pill, Screen, Sheet, SlideToConfirm, StepDots } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { useNavigation } from "@/hooks/use-navigation";
import { api, refusalText } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { overdue, overdueHint } from "@/lib/planning";
import { navUrl, rideTarget, type NavApp, type RideTarget } from "@/lib/ride-target";
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
/** Boutons Waze / Plans : hauteur au-dessus du bas de la carte ; « Recentrer » se place au-dessus d'eux. */
const NAV_APPS_BOTTOM = 38;
const RECENTER_BOTTOM = NAV_APPS_BOTTOM + control.sm + space.sm;
const TO_PICKUP: RideStatus[] = ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"];
/** Course acceptée : guidage vers la prise en charge à partir de 90 min avant l'heure (avant : aperçu du trajet). */
const GUIDE_BEFORE_MS = 90 * 60_000;

const NBSP = " ";
const passengersText = (n: number) => `${n}${NBSP}passager${n > 1 ? "s" : ""}`;
const luggageText = (n: number) => (n > 0 ? `${n}${NBSP}bagage${n > 1 ? "s" : ""}` : "Sans bagage");

function openNav(app: NavApp, target: RideTarget) {
  void Linking.openURL(navUrl(app, target)).catch(() => null);
}

/** Retour à l'accueil existant (dépile), au lieu d'empiler un nouvel accueil à chaque course. */
const toHome = () => router.dismissTo("/home");

export default function RideScreen() {
  // Écran allumé pendant la course ; départ rapide de l'écran (fin de course → Commissions) : sur le web,
  // le verrou peut ne pas être encore actif au démontage — pas d'erreur dans ce cas
  useKeepAwake(undefined, { suppressDeactivateWarnings: true });
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh, home, setOnline } = useDriver();
  const me = useMyPosition();
  const [ride, setRide] = useState<Ride | null>(null);
  // Course invisible pour ce chauffeur dès l'ouverture (réattribuée, notification ou planning périmés)
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  // Mode centrale : récapitulatif de fin de course (part chauffeur, commission à régler ou part à recevoir)
  const [done, setDone] = useState<{ ride: Ride; settlement: DriverSettlementItem | null } | null>(null);

  const hadRide = useRef(false);
  const load = useCallback(async () => {
    const r = await api.ride(String(id)).catch(() => undefined); // undefined : réseau, on garde l'affichage
    if (r === undefined) return;
    if (r === null) {
      if (hadRide.current) {
        // Course retirée par la centrale (réattribuée) : plus visible pour ce chauffeur
        hadRide.current = false;
        Alert.alert("Course retirée", "La centrale a réattribué cette course.");
        toHome();
      } else setMissing(true);
      return;
    }
    hadRide.current = true;
    setMissing(false);
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

  const rideRoute = useMemo(() => (ride?.route_polyline ? decodePolyline(ride.route_polyline) : null), [ride?.route_polyline]);
  // Points de la carte : mêmes objets tant que les coordonnées ne changent pas (pas de recadrage ni de rendu natif inutile)
  const pickupLat = ride?.pickup_lat;
  const pickupLng = ride?.pickup_lng;
  const dropoffLat = ride?.dropoff_lat;
  const dropoffLng = ride?.dropoff_lng;
  const pickup = useMemo(() => (pickupLat != null && pickupLng != null ? { lat: pickupLat, lng: pickupLng } : null), [pickupLat, pickupLng]);
  const dropoff = useMemo(() => (dropoffLat != null && dropoffLng != null ? { lat: dropoffLat, lng: dropoffLng } : null), [dropoffLat, dropoffLng]);

  // Guidage sur notre carte : vers la prise en charge, puis vers la destination (Waze / Plans restent proposés)
  const rideStatus = ride?.status as RideStatus | undefined;
  const headingToPickup = rideStatus == null || TO_PICKUP.includes(rideStatus);
  // Destination sans coordonnées : pas de guidage intégré (jamais vers la prise en charge à sa place)
  const navTarget = headingToPickup ? pickup : dropoff;
  // Course planifiée acceptée longtemps à l'avance : aperçu du trajet, le guidage démarre à l'approche de l'heure
  const pickupSoon = rideStatus !== "ACCEPTED" || (ride != null && new Date(ride.pickup_at).getTime() - Date.now() < GUIDE_BEFORE_MS);
  const navOn = rideStatus != null && DRIVER_FLOW[rideStatus] != null && rideStatus !== "DRIVER_ARRIVED" && navTarget != null && pickupSoon;
  const nav = useNavigation(me, navTarget, navOn);
  // Trait principal : trajet guidé restant (sinon trajet de la course une fois le client à bord) ; en pointillé,
  // pendant l'approche, le trajet du client
  const mapRoute = navOn ? (nav.route ?? (headingToPickup ? null : rideRoute)) : rideRoute;
  // Guidage : véhicule posé sur la route suivie, orienté comme elle (sans cercle d'imprécision), comme Waze
  const snapped = nav.position;
  const shownMe = useMemo(
    () => (me && snapped ? { ...me, lat: snapped.lat, lng: snapped.lng, heading: snapped.heading ?? me.heading, accuracy: null } : me),
    [me, snapped],
  );
  const mutedRoute = navOn && headingToPickup ? rideRoute : null;

  if (!ride) {
    if (missing) {
      return (
        <Screen style={[styles.center, styles.missing]}>
          <Ionicons name="close-circle-outline" size={40} color={colors.muted} />
          <Text style={styles.missingTitle} accessibilityRole="header">Course indisponible</Text>
          <Text style={styles.loadingText}>Elle a été retirée ou réattribuée par la centrale.</Text>
          <BigButton title="Retour à l'accueil" variant="secondary" height={control.md} onPress={toHome} style={styles.missingBack} />
        </Screen>
      );
    }
    return (
      <Screen style={styles.center}>
        <SafeAreaView edges={["top"]} style={styles.mapTop} pointerEvents="box-none">
          <BackButton />
        </SafeAreaView>
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
  const toPickup = headingToPickup;
  // Client à bord : la destination, même sans coordonnées (adresse seule, sans estimation d'arrivée)
  const target = rideTarget(ride, toPickup);
  const distToTarget = me && target.lat != null && target.lng != null ? haversine(me, { lat: target.lat, lng: target.lng }) : null;
  const estimatedEta = toPickup ? approachSeconds(distToTarget) : distToTarget != null && ride.estimated_distance_m ? Math.round(((distToTarget * 1.3) / Math.max(1, ride.estimated_distance_m)) * (ride.estimated_duration_s ?? 0)) : null;
  // Itinéraire guidé disponible : distance et durée par la route ; sinon estimation
  const etaToTarget = nav.remainingS ?? estimatedEta;
  const distLeft = nav.remainingM ?? distToTarget;
  const guiding = navOn && (nav.next != null || nav.rerouting);
  // Planifiée pas démarrée à l'heure : encore démarrable, clôturée par le serveur quelques heures après (lib/planning)
  const late = overdue(ride);
  const navApp = Platform.OS === "ios" ? "Plans" : "Maps";

  async function advance() {
    if (!step || !ride) return;
    // (glissière en attente dès maintenant : elle ne revient au départ qu'à la fin de l'attente)
    setLoading(true);
    // Départ vers le client alors que le chauffeur est hors ligne (course planifiée acceptée hors ligne, passé hors
    // ligne depuis) : en ligne d'abord (information préalable si l'autorisation manque), sinon la course se ferait
    // sans position (ni suivi par la centrale, ni alerte de retard)
    if (step.next === "DRIVER_EN_ROUTE" && home?.driver.presence === "offline") {
      const online = await setOnline(true);
      if (!online.ok) {
        setLoading(false);
        if (online.code === "cancelled") return;
        const settings = online.code === "coarse" || online.code === "blocked";
        return Alert.alert(
          "Passez en ligne pour démarrer",
          frTypo(online.message ?? "Réessayez."),
          settings
            ? [{ text: "Plus tard", style: "cancel" }, { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings().catch(() => null) }]
            : undefined,
        );
      }
    }
    const res = await api
      .updateStatus(ride.id, step.next)
      .catch((e: Error) => ({ ok: false, code: (e as { code?: string | null }).code ?? null, message: e.message }) as { ok: boolean; code?: string | null; message?: string });
    // Glissière gardée en attente jusqu'à la relecture : réarmée plus tôt, elle repartait avec l'ANCIEN libellé (second
    // glissé = même statut redemandé, refusé). Refus ou réponse perdue : la course est relue aussi (annulée, statut
    // déjà passé) au lieu d'attendre le sondage suivant.
    await Promise.all([load(), refresh()]).catch(() => null);
    setLoading(false);
    if (!res.ok) {
      const text = res.code === "INVALID_TRANSITION"
        ? "La course a changé (annulée ou mise à jour par la centrale) : l'écran vient d'être actualisé."
        : refusalText(res, "Réessayez.");
      return Alert.alert("Action impossible", frTypo(text));
    }
    if (step.next === "COMPLETED" && centrale) {
      // Règlement créé à la clôture (trigger) : montant et échéance exacts pour le récapitulatif
      const mine = await api.settlements(20).catch(() => null);
      setDone({ ride, settlement: mine?.items.find((x) => x.ride_id === ride.id) ?? null });
      return;
    }
    if (step.next === "COMPLETED") {
      Alert.alert(`Course ${ride.number} terminée`, `${formatPrice(ride.price_cents)} · ${PAYMENT_METHOD_LABELS[ride.payment_method]}`, [{ text: "OK", onPress: toHome }]);
      if (Platform.OS === "web") toHome();
    }
  }

  return (
    <Screen>
      <View style={[styles.mapBox, navOn && styles.mapBoxNav]}>
        <RydarMap
          me={shownMe}
          pickup={pickup}
          dropoff={dropoff}
          route={mapRoute}
          routeMuted={mutedRoute}
          navigation={navOn}
          padding={MAP_PADDING}
          controlsBottom={RECENTER_BOTTOM}
        />
        <SafeAreaView edges={["top"]} style={styles.mapTop} pointerEvents="box-none">
          <BackButton />
          {guiding ? (
            <View style={styles.flex}>
              <NavBanner next={nav.next} then={nav.then} rerouting={nav.rerouting} />
            </View>
          ) : (
            <View style={styles.statusBox} accessible accessibilityLabel={`Course ${ride.number}, ${RIDE_STATUS_META[status].label}`}>
              <Text style={styles.statusNumber}>Course {ride.number}</Text>
              <View>
                <Pill label={RIDE_STATUS_META[status].label} color={STEP_COLOR[status] ?? colors.muted} />
              </View>
            </View>
          )}
        </SafeAreaView>
        {step && (
          <View style={styles.navRow}>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}
              onPress={() => openNav("waze", target)}
              accessibilityRole="button"
              accessibilityLabel="Ouvrir l'itinéraire dans Waze"
            >
              <Ionicons name="navigate-outline" size={20} color={colors.muted} />
              <Text style={styles.navText}>Waze</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}
              onPress={() => openNav(Platform.OS === "ios" ? "apple" : "google", target)}
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
          {late && (
            <View style={styles.late} accessibilityLiveRegion="polite">
              <Ionicons name="time-outline" size={20} color={colors.amber} style={styles.iconTop} />
              <View style={{ flex: 1 }}>
                <Text style={styles.lateTitle}>Heure de prise en charge dépassée</Text>
                <Text style={styles.lateSub}>{overdueHint(late, home?.organization.timezone)}</Text>
              </View>
            </View>
          )}
          {step && <StepDots steps={STEPS.map((s) => s.label)} current={stepIndex} />}

          <View style={styles.targetRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.targetKicker}>{toPickup ? "Prise en charge" : "Destination"}</Text>
              <Text style={styles.target} numberOfLines={2}>{target.label}</Text>
            </View>
            {etaToTarget != null && step && (
              <View style={styles.etaBox} accessible accessibilityLabel={`Arrivée dans ${formatDuration(etaToTarget)}, ${formatDistance(distLeft)}`}>
                <Text style={styles.eta}>{formatDuration(etaToTarget)}</Text>
                <Text style={styles.etaSub}>{formatDistance(distLeft)}</Text>
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
          <BigButton title="Retour à l'accueil" variant="secondary" height={control.md} onPress={toHome} />
        )}
      </SafeAreaView>

      <BottomSheet visible={done != null} onClose={() => router.dismissTo("/home")}>
        {done && <RideDoneSummary ride={done.ride} settlement={done.settlement} tz={home?.organization.timezone} />}
      </BottomSheet>
    </Screen>
  );
}

/** Bouton ‹ : écran précédent, sinon l'accueil (écran ouvert directement, par une notification). */
function BackButton() {
  return (
    <Pressable
      onPress={() => (router.canGoBack() ? router.back() : toHome())}
      style={({ pressed }) => [styles.round, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="Retour"
      hitSlop={4}
    >
      <Ionicons name="chevron-back" size={22} color={colors.fg} />
    </Pressable>
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
  loadingText: { color: colors.muted, fontSize: type.body, lineHeight: 21, textAlign: "center" },
  missing: { paddingHorizontal: space.xl },
  missingTitle: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold },
  missingBack: { marginTop: space.xl, alignSelf: "stretch" },
  mapBox: { height: "50%" },
  // Guidage : la carte prend plus de place (la route devant compte plus que les détails)
  mapBoxNav: { height: "58%" },
  flex: { flex: 1 },
  mapTop: {
    position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start",
    gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm,
  },
  round: { ...overlay, width: control.sm, height: control.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.surface3 },
  statusBox: {
    ...overlay, flexDirection: "row", alignItems: "center", gap: 10, height: control.sm, borderRadius: radius.full,
    paddingLeft: space.lg, paddingRight: 6, flexShrink: 1,
  },
  statusNumber: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, ...mono },
  navRow: { position: "absolute", right: space.lg, bottom: NAV_APPS_BOTTOM, flexDirection: "row", gap: space.sm },
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
  late: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
  },
  lateTitle: { color: colors.amber, fontSize: type.body, fontWeight: weight.semibold, lineHeight: 21 },
  lateSub: { color: colors.muted, fontSize: type.footnote, lineHeight: 18, marginTop: 2 },
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
