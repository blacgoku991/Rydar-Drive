import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, VEHICLE_CATEGORY_META, decodePolyline, driverCollects, flightBadge, formatDistance, formatDuration, formatPrice, formatRideDate,
  type DriverOffer,
} from "@rydar/shared";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { blockerInfo, CollectNote, deductionCents } from "@/components/centrale";
import { RydarMap } from "@/components/map/rydar-map";
import { CountdownRing } from "@/components/radar";
import { BigButton, Chip, RouteLine, Screen, Sheet } from "@/components/ui";
import { URGENT_OFFER_S, useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api } from "@/lib/api";
import { offerSession } from "@/lib/offer-session";
import { approachSeconds, colors, toneColor } from "@/theme";

const RING_PATTERN = [0, 600, 300, 600, 300, 1000];
/** La sonnerie boucle pendant les 35 premières secondes de l'offre (puis silence, le compte à rebours continue). */
const RING_S = 35;
/** Durée minimale de sonnerie à l'ouverture d'une offre récente (écart d'horloge téléphone / serveur). */
const MIN_RING_S = 8;
const CHIME_PATTERN = [0, 200, 120, 200];
/** Échéance dépassée : sans liste à jour depuis ce délai (réseau), fermeture locale. */
const STALE_LIST_S = 20;
/** Échéance dépassée depuis ce délai et toujours listée : dispatch serveur arrêté (l'acceptation serait refusée). */
const DEAD_OFFER_S = 90;

type OfferState = "open" | "accepting" | "taken" | "expired" | "declined";

export default function OfferScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { offers, refresh, home } = useDriver();
  const me = useMyPosition();
  const snapshot = useRef<DriverOffer | null>(null);
  const live = offers.find((o) => o.offer_id === id) ?? null;
  if (live) snapshot.current = live;
  const offer = live ?? snapshot.current;
  const [now, setNow] = useState(Date.now());
  const [state, setState] = useState<OfferState>("open");
  const [message, setMessage] = useState<string | null>(null);
  // Ouverture directe (notification) : la liste des offres n'est peut-être pas encore chargée
  const [checked, setChecked] = useState(live != null);
  // Mode centrale : acceptation refusée (DRIVER_BLOCKED) en attendant la relecture de l'offre (champ blocked)
  const [blockedLocal, setBlockedLocal] = useState<{ reason: string; message?: string } | null>(null);
  useEffect(() => setBlockedLocal(null), [offers]);
  const block = blockerInfo(offer?.blocked ?? blockedLocal?.reason, offer?.blocked ? null : blockedLocal?.message);
  const blockedReason = block?.reason ?? null;
  const ringtone = useAudioPlayer(require("../../../assets/sounds/ride_offer_v2.wav"));
  const chime = useAudioPlayer(require("../../../assets/sounds/ride_offer.wav"));
  const chimed = useRef(false);
  // Échéance au moment de la fermeture locale : seule une prolongation serveur rouvre l'offre
  const closedExpiry = useRef<string | null>(null);

  // Anneau : fenêtre initiale (envoi → échéance), puis, à chaque prolongation serveur (élargissement
  // du rayon), fenêtre depuis l'échéance précédente — l'anneau repart plein au lieu de sauter.
  const ringBase = useRef<{ expiresAt: string; from: number } | null>(null);
  const total = useMemo(() => {
    if (!offer?.expires_at) return 30;
    const prev = ringBase.current;
    const from = !prev
      ? new Date(offer.sent_at).getTime()
      : prev.expiresAt === offer.expires_at
        ? prev.from
        : Math.min(new Date(prev.expiresAt).getTime(), Date.now());
    ringBase.current = { expiresAt: offer.expires_at, from };
    return Math.max(1, (new Date(offer.expires_at).getTime() - from) / 1000);
  }, [offer?.expires_at, offer?.sent_at]);
  const remaining = offer?.expires_at ? (new Date(offer.expires_at).getTime() - now) / 1000 : total;
  // Urgente : dispatch GPS ou fenêtre courte → compte à rebours + sonnerie en boucle ; sinon un carillon
  const urgent = offer != null && (offer.mode === "geo" || (offer.expires_at != null && total <= URGENT_OFFER_S));
  const route = useMemo(() => (offer?.route_polyline ? decodePolyline(offer.route_polyline) : null), [offer?.route_polyline]);
  const loaded = offer != null;

  useEffect(() => {
    if (!checked) void refresh().finally(() => setChecked(true));
  }, []);

  // Une seule fenêtre d'offre : la bannière touchée ensuite ne rouvre pas un second écran
  useEffect(() => {
    offerSession.openId = id;
    return () => {
      if (offerSession.openId === id) offerSession.openId = null;
    };
  }, [id]);

  // Dernière lecture réussie de la liste (chaque rafraîchissement réussi remplace le tableau)
  const listAt = useRef(Date.now());
  useEffect(() => {
    listAt.current = Date.now();
  }, [offers]);

  // Sonnerie + vibration en boucle tant qu'une offre urgente est ouverte ; offre planifiée : un seul carillon.
  // Chauffeur bloqué (mode centrale) : pas de sonnerie, l'offre ne peut pas être acceptée.
  useEffect(() => {
    if (state !== "open" || !loaded || blockedReason) return;
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: "duckOthers" }).catch(() => null);
    if (!urgent) {
      if (chimed.current) return;
      chimed.current = true;
      try {
        chime.volume = 1;
        chime.play();
      } catch {
        /* navigateur sans interaction : pas de son */
      }
      if (Platform.OS !== "web") Vibration.vibrate(CHIME_PATTERN);
      return;
    }
    // Sonnerie limitée aux 35 premières secondes après l'envoi : l'offre, prolongée à la vague suivante,
    // peut rester ouverte plus longtemps, sans sonner indéfiniment
    const age = (Date.now() - new Date(snapshot.current?.sent_at ?? Date.now()).getTime()) / 1000;
    const ringS = age < 60 ? Math.min(RING_S, Math.max(MIN_RING_S, RING_S - age)) : 0;
    if (ringS <= 0) return;
    try {
      ringtone.loop = true;
      ringtone.volume = 1;
      ringtone.play();
    } catch {
      /* navigateur sans interaction : pas de son */
    }
    if (Platform.OS !== "web") Vibration.vibrate(RING_PATTERN, true);
    const stop = () => {
      try {
        ringtone.pause();
      } catch {
        /* lecteur libéré */
      }
      if (Platform.OS !== "web") Vibration.cancel();
    };
    const t = setTimeout(stop, ringS * 1000);
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [state, urgent, loaded, ringtone, chime, blockedReason]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // L'offre disparaît de la liste serveur : attribuée (à moi ou à un autre), retirée ou expirée
  useEffect(() => {
    if (state !== "open" || live || !snapshot.current) return;
    closedExpiry.current = snapshot.current.expires_at;
    // ACCEPTER depuis la notification : instantanée → course en cours ; planifiée → planning
    if (home?.driver.current_ride_id === snapshot.current.ride_id || offerSession.accepted.has(snapshot.current.offer_id)) {
      setMessage(snapshot.current.ride_type === "instant" ? "Course acceptée." : "Course attribuée — ajoutée à votre planning.");
      setState("declined");
      return;
    }
    setMessage(null);
    setState(remaining <= 0 ? "expired" : "taken");
  }, [live, state, remaining, home?.driver.current_ride_id]);

  // Échéance atteinte mais offre toujours listée : le serveur peut la prolonger (vague suivante) → on vérifie
  const overdue = urgent && state === "open" && live != null && remaining <= 0;
  useEffect(() => {
    if (!overdue) return;
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [overdue, refresh]);

  // Filet de sécurité : liste figée (réseau) ou dispatch arrêté → fermeture locale
  useEffect(() => {
    if (!overdue) return;
    if (now - listAt.current > STALE_LIST_S * 1000 || remaining <= -DEAD_OFFER_S) {
      closedExpiry.current = offer?.expires_at ?? null;
      setState("expired");
    }
  }, [overdue, now, remaining, offer?.expires_at]);

  // Prolongée après une fermeture locale (expirée / refusée à l'acceptation) : l'offre est rouverte
  useEffect(() => {
    if ((state === "expired" || state === "taken") && live?.expires_at && live.expires_at !== closedExpiry.current && remaining > 0) {
      setMessage(null);
      setState("open");
    }
  }, [state, live?.expires_at, remaining]);

  // Fermeture automatique, uniquement si l'écran est au premier plan (sinon back() fermerait l'écran du dessus)
  const closed = state === "taken" || state === "expired" || state === "declined";
  useFocusEffect(
    useCallback(() => {
      if (!closed) return;
      const t = setTimeout(close, 2600);
      return () => clearTimeout(t);
    }, [closed]),
  );

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/home");
  }

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
      } else if (res.code === "DRIVER_BLOCKED") {
        // Mode centrale : commission en retard / contestée, plafond… L'offre reste ouverte : le chauffeur
        // peut régler (ou signaler son paiement) puis accepter.
        if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setBlockedLocal({ reason: res.reason ?? "unpaid", message: res.message });
        setState("open");
        void refresh();
      } else {
        if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        closedExpiry.current = offer.expires_at;
        setMessage(res.message ?? null);
        setState(res.code === "OFFER_EXPIRED" ? "expired" : "taken");
        void refresh();
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
    if (!checked) {
      return (
        <Screen style={styles.center}>
          <Text style={styles.loading}>Chargement de l&apos;offre…</Text>
        </Screen>
      );
    }
    return (
      <Screen style={styles.center}>
        <Ionicons name="close-circle" size={48} color={colors.amber} />
        <Text style={styles.closedTitle}>Offre indisponible</Text>
        <Text style={styles.loading}>Elle a expiré ou a été attribuée à un autre chauffeur.</Text>
        <BigButton title="Retour" variant="secondary" onPress={() => router.replace("/home")} style={{ marginTop: 24, alignSelf: "stretch", marginHorizontal: 24 }} />
      </Screen>
    );
  }

  const eta = approachSeconds(offer.distance_m);
  // Vol suivi : « AF1234 · +35 min », « AF1234 · atterri 14:52 · T2E »
  const flight = flightBadge(offer, home?.organization.timezone);
  // Mode centrale : « Vous gagnez 40 € » (part chauffeur), course 59 € · commission 19 € (commission + frais)
  const centrale = offer.dispatch_model === "centrale" && offer.driver_payout_cents != null;
  const deduction = deductionCents(offer);
  const collects = offer.driver_collects ?? driverCollects(offer.payment_method);
  // Motif renvoyé par le serveur (mode centrale uniquement), même pour une course sans répartition (prix absent)
  const blocked = block != null && !closed;
  return (
    <Screen>
      <View style={[styles.mapBox, (centrale || blocked) && { height: blocked ? "27%" : "37%" }]}>
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
          {urgent && !closed && (
            <View style={styles.ring}>
              <CountdownRing total={total} remaining={remaining} size={76} />
            </View>
          )}
        </SafeAreaView>
      </View>

      <Sheet style={styles.sheet}>
        <SafeAreaView edges={["bottom"]} style={{ flex: 1, gap: centrale ? 14 : 16 }}>
          <View style={styles.priceRow}>
            {centrale ? (
              <View style={{ flex: 1 }} accessibilityLabel={`Vous gagnez ${formatPrice(offer.driver_payout_cents, offer.currency)}`}>
                <Text style={styles.gainLabel}>Vous gagnez</Text>
                <Text style={[styles.price, styles.gain]} numberOfLines={1} adjustsFontSizeToFit>
                  {formatPrice(offer.driver_payout_cents, offer.currency)}
                </Text>
                <Text style={styles.gainSub} numberOfLines={1}>
                  Course {formatPrice(offer.price_cents, offer.currency)} · commission {formatPrice(deduction, offer.currency)}
                </Text>
              </View>
            ) : (
              <View>
                <Text style={styles.price}>{formatPrice(offer.price_cents)}</Text>
                <Text style={styles.priceSub}>{PAYMENT_METHOD_LABELS[offer.payment_method]}</Text>
              </View>
            )}
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
            {flight && <Chip icon="airplane-outline" text={flight.text} color={flight.tone === "neutral" ? colors.cyan : toneColor(flight.tone)} />}
          </View>
          {offer.comment && <Text style={styles.comment}>« {offer.comment} »</Text>}
          {/* Qui encaisse le client : le chauffeur (il reverse la commission) ou la centrale (elle verse la part) */}
          {centrale && !blocked && (
            <CollectNote collects={collects} price={offer.price_cents} deduction={deduction} payout={offer.driver_payout_cents} currency={offer.currency} />
          )}

          <View style={{ gap: 6, marginTop: "auto" }}>
            {closed ? (
              <View style={styles.closedBox}>
                <Ionicons name={state === "declined" && message ? "checkmark-circle" : "close-circle"} size={24} color={state === "declined" && message ? colors.brand : colors.amber} />
                <Text style={styles.closedText}>{state === "expired" ? "Offre expirée." : message ?? (state === "declined" ? "Offre refusée." : "Course déjà attribuée.")}</Text>
              </View>
            ) : blocked && block ? (
              // Mode centrale : commission en retard / contestée, plafond d'encours… → acceptation impossible
              <>
                <View style={styles.blockBox} accessibilityRole="alert">
                  <Ionicons name="lock-closed" size={22} color={colors.red} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.blockTitle}>Acceptation impossible</Text>
                    <Text style={styles.blockText}>{block.message}</Text>
                  </View>
                </View>
                <BigButton title="ACCEPTER" icon="lock-closed" variant="secondary" height={56} disabled onPress={() => undefined} />
                {block.payable && (
                  <BigButton title="Régler mes commissions" icon="wallet" height={64} onPress={() => router.push("/commissions")} style={{ marginTop: 4 }} />
                )}
                <View style={styles.secondary}>
                  {!urgent && (
                    <Pressable onPress={close} style={styles.decline} accessibilityRole="button">
                      <Text style={styles.laterText}>Plus tard</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={decline} style={styles.decline} accessibilityRole="button">
                    <Text style={styles.declineText}>Refuser</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <BigButton title="ACCEPTER" icon="checkmark-circle" height={80} onPress={accept} loading={state === "accepting"} />
                <View style={styles.secondary}>
                  {!urgent && (
                    <Pressable onPress={close} disabled={state === "accepting"} style={styles.decline} accessibilityRole="button">
                      <Text style={styles.laterText}>Plus tard</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={decline} disabled={state === "accepting"} style={styles.decline} accessibilityRole="button">
                    <Text style={styles.declineText}>Refuser</Text>
                  </Pressable>
                </View>
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
  gainLabel: { color: colors.muted, fontSize: 15, fontWeight: "800", marginBottom: -4 },
  gain: { color: colors.brand, fontVariant: ["tabular-nums"] },
  gainSub: { color: colors.muted, fontSize: 14.5, fontWeight: "700", marginTop: -2, fontVariant: ["tabular-nums"] },
  blockBox: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, backgroundColor: "rgba(242,85,90,0.12)", borderWidth: 1, borderColor: "rgba(242,85,90,0.42)", marginBottom: 4 },
  blockTitle: { color: colors.red, fontSize: 16, fontWeight: "900" },
  blockText: { color: colors.fg, fontSize: 14, lineHeight: 19, marginTop: 2, fontWeight: "600" },
  eta: { color: colors.brand, fontSize: 28, fontWeight: "900", letterSpacing: -0.5 },
  etaSub: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  when: { color: colors.violet, fontSize: 18, fontWeight: "800" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  comment: { color: colors.muted, fontStyle: "italic", fontSize: 14 },
  secondary: { flexDirection: "row" },
  decline: { flex: 1, height: 46, alignItems: "center", justifyContent: "center" },
  declineText: { color: colors.muted, fontSize: 16, fontWeight: "700" },
  laterText: { color: colors.fg, fontSize: 16, fontWeight: "700" },
  closedBox: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, height: 80, borderRadius: 20, backgroundColor: colors.surface2 },
  closedText: { color: colors.fg, fontSize: 17, fontWeight: "800" },
  closedTitle: { color: colors.fg, fontSize: 22, fontWeight: "800" },
  loading: { color: colors.muted, fontSize: 15, textAlign: "center", paddingHorizontal: 32 },
});
