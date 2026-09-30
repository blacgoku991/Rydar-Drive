import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, VEHICLE_CATEGORY_META, decodePolyline, driverCollects, flightBadge, formatDistance, formatDuration, formatPrice, formatRideDate,
  type DriverOffer,
} from "@rydar/shared";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { blockerInfo, CollectNote, deductionCents, frTypo } from "@/components/centrale";
import { RydarMap } from "@/components/map/rydar-map";
import { CountdownRing } from "@/components/radar";
import { BigButton, Chip, RouteLine, Screen, Sheet } from "@/components/ui";
import { URGENT_OFFER_S, useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { api, refusalText } from "@/lib/api";
import { offerSession } from "@/lib/offer-session";
import { approachSeconds, colors, control, mono, overlay, radius, space, toneColor, type, weight } from "@/theme";

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
/** Bouton « Accepter » : la plus grande cible de l'écran, atteignable au pouce sans viser. */
const ACCEPT_H = 80;
/** Cadrage de la carte : place pour l'en-tête et l'anneau en haut, pour la feuille en bas (constante : carte non redessinée). */
const MAP_PADDING = { top: 110, bottom: 60, left: 50, right: 50 };

const NBSP = " ";
const passengersText = (n: number) => `${n}${NBSP}passager${n > 1 ? "s" : ""}`;
const luggageText = (n: number) => (n > 0 ? `${n}${NBSP}bagage${n > 1 ? "s" : ""}` : "Sans bagage");

type OfferState = "open" | "accepting" | "taken" | "expired" | "declined";

/**
 * Compte à rebours de l'offre (anneau + secondes). Son propre minuteur (4 rendus par seconde) : seul
 * l'anneau se redessine, pas l'écran ni la carte.
 */
function OfferCountdown({ expiresAt, total }: { expiresAt: string | null; total: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [expiresAt]);
  const remaining = expiresAt ? (new Date(expiresAt).getTime() - now) / 1000 : total;
  return <CountdownRing total={total} remaining={remaining} size={76} />;
}

export default function OfferScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { offers, offersReadAt, forgetOffer, refresh, home } = useDriver();
  const me = useMyPosition();
  const snapshot = useRef<DriverOffer | null>(null);
  const live = offers.find((o) => o.offer_id === id) ?? null;
  if (live) snapshot.current = live;
  const offer = live ?? snapshot.current;
  // Horloge de la logique d'expiration / prolongation (1 s) ; l'anneau a son propre minuteur (OfferCountdown)
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
  // Rouverte par une prolongation du serveur : elle a déjà sonné, pas de nouvelle sonnerie
  const reopened = useRef(false);
  // Fermée localement faute de liste à jour (réseau) : elle pourra se rouvrir si le serveur la prolonge
  const staleClose = useRef(false);

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
  // Points de la carte : mêmes objets tant que les coordonnées ne changent pas (carte mémorisée, pas de rendu natif inutile)
  const pickupLat = offer?.pickup_lat;
  const pickupLng = offer?.pickup_lng;
  const dropoffLat = offer?.dropoff_lat;
  const dropoffLng = offer?.dropoff_lng;
  const pickup = useMemo(() => (pickupLat != null && pickupLng != null ? { lat: pickupLat, lng: pickupLng } : null), [pickupLat, pickupLng]);
  const dropoff = useMemo(() => (dropoffLat != null && dropoffLng != null ? { lat: dropoffLat, lng: dropoffLng } : null), [dropoffLat, dropoffLng]);
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

  // Sonnerie + vibration en boucle tant qu'une offre urgente est ouverte ; offre planifiée : un seul carillon.
  // Chauffeur bloqué (mode centrale) : pas de sonnerie, l'offre ne peut pas être acceptée.
  useEffect(() => {
    if (state !== "open" || !loaded || blockedReason || reopened.current) return;
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
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // L'offre disparaît de la liste serveur : attribuée (à moi ou à un autre), retirée ou expirée
  useEffect(() => {
    if (state !== "open" || live || !snapshot.current) return;
    closedExpiry.current = snapshot.current.expires_at;
    // Accepter depuis la notification : instantanée → course en cours ; planifiée → planning
    if (home?.driver.current_ride_id === snapshot.current.ride_id || offerSession.accepted.has(snapshot.current.offer_id)) {
      setMessage(snapshot.current.ride_type === "instant" ? "Course acceptée." : "Course attribuée, ajoutée à votre planning.");
      setState("declined");
      return;
    }
    setMessage(null);
    // Échéance relue à l'instant (l'horloge de l'écran n'avance que toutes les secondes)
    const left = snapshot.current.expires_at ? new Date(snapshot.current.expires_at).getTime() - Date.now() : remaining;
    setState(left <= 0 ? "expired" : "taken");
  }, [live, state, remaining, home?.driver.current_ride_id]);

  // Échéance atteinte mais offre toujours listée : le serveur peut la prolonger (vague suivante) → on vérifie
  const overdue = urgent && state === "open" && live != null && remaining <= 0;
  // Début de l'attente de la prolongation : la liste est jugée figée si AUCUNE lecture n'a réussi depuis
  const overdueAt = useRef(0);
  useEffect(() => {
    if (!overdue) return;
    overdueAt.current = Date.now();
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [overdue, refresh]);

  // Filet de sécurité : liste figée (réseau : aucune lecture réussie depuis 20 s, même sans changement) ou
  // dispatch arrêté → fermeture locale
  useEffect(() => {
    if (!overdue) return;
    const stale = now - Math.max(offersReadAt(), overdueAt.current) > STALE_LIST_S * 1000;
    if (stale || remaining <= -DEAD_OFFER_S) {
      closedExpiry.current = offer?.expires_at ?? null;
      staleClose.current = stale && remaining > -DEAD_OFFER_S;
      setState("expired");
    }
  }, [overdue, now, remaining, offer?.expires_at, offersReadAt]);

  // Prolongée après une fermeture locale (expirée / refusée à l'acceptation) : l'offre est rouverte, sans sonnerie
  useEffect(() => {
    if ((state === "expired" || state === "taken") && live?.expires_at && live.expires_at !== closedExpiry.current && remaining > 0) {
      reopened.current = true;
      staleClose.current = false;
      setMessage(null);
      setState("open");
    }
  }, [state, live?.expires_at, remaining]);

  // Android : le retour système ne ferme pas une offre ouverte (comme l'iPhone, sans geste de retour) — « Refuser »,
  // ou « Plus tard » pour une offre planifiée (le retour vaut alors « Plus tard »)
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android" || (state !== "open" && state !== "accepting")) return undefined;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (state === "open" && !urgent) close();
        return true;
      });
      return () => sub.remove();
    }, [state, urgent]),
  );

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
    // Fermée faute de réseau alors que le serveur la propose encore : rouverte s'il la prolonge
    if (staleClose.current) forgetOffer(id);
    if (router.canGoBack()) router.back();
    else router.dismissTo("/home");
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
        // Motif du refus (déjà attribuée, course annulée, recherche terminée…) : libellé du code, sinon du serveur
        setMessage(refusalText(res));
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
          <ActivityIndicator color={colors.muted} />
          <Text style={styles.loading} accessibilityLiveRegion="polite">Chargement de l&apos;offre…</Text>
        </Screen>
      );
    }
    return (
      <Screen style={styles.center}>
        <Ionicons name="close-circle-outline" size={40} color={colors.muted} />
        <Text style={styles.closedTitle} accessibilityRole="header">Offre indisponible</Text>
        <Text style={styles.loading}>Elle a expiré, a été annulée ou a été attribuée à un autre chauffeur.</Text>
        <BigButton title="Retour" variant="secondary" height={control.md} onPress={() => router.dismissTo("/home")} style={styles.back} />
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
  const busy = state === "accepting";
  // Fermée après acceptation (course acceptée / ajoutée au planning) : confirmation ; sinon expirée / prise / refusée
  const success = state === "declined" && message != null;
  const category = VEHICLE_CATEGORY_META[offer.vehicle_category].label;

  const secondary = (
    <View style={styles.secondary}>
      {!urgent && (
        <Pressable
          onPress={close}
          disabled={busy}
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Plus tard"
          accessibilityHint="Ferme l'offre sans la refuser"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={styles.laterText}>Plus tard</Text>
        </Pressable>
      )}
      <Pressable
        onPress={decline}
        disabled={busy}
        style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Refuser l'offre"
        accessibilityState={{ disabled: busy }}
      >
        <Text style={styles.declineText}>Refuser</Text>
      </Pressable>
    </View>
  );

  return (
    <Screen>
      <View style={[styles.mapBox, (centrale || blocked) && { height: blocked ? "27%" : "37%" }]}>
        {/* Offre (quelques secondes pour décider) : carte fixe, sans rotation ni boussole (compte à rebours à droite) */}
        <RydarMap me={me} pickup={pickup} dropoff={dropoff} route={route} padding={MAP_PADDING} rotatable={false} />
        <SafeAreaView edges={["top"]} style={styles.mapTop} pointerEvents="box-none">
          <View style={styles.headBox} accessible accessibilityRole="header" accessibilityLabel={`${offer.ride_type === "instant" ? "Nouvelle offre" : "Offre planifiée"}, course ${offer.number}, ${category}`}>
            <Text style={styles.kicker}>{offer.ride_type === "instant" ? "Nouvelle offre" : "Offre planifiée"}</Text>
            <Text style={styles.number} numberOfLines={1}>Course {offer.number} · {category}</Text>
          </View>
          {urgent && !closed && (
            <View style={styles.ring}>
              <OfferCountdown expiresAt={offer.expires_at} total={total} />
            </View>
          )}
        </SafeAreaView>
      </View>

      <Sheet style={styles.sheet}>
        <SafeAreaView edges={["bottom"]} style={[styles.body, { gap: centrale ? space.md : space.lg }]}>
          <View style={styles.priceRow}>
            {centrale ? (
              <View
                style={{ flex: 1 }}
                accessible
                accessibilityLabel={`Vous gagnez ${formatPrice(offer.driver_payout_cents, offer.currency)}. Course ${formatPrice(offer.price_cents, offer.currency)}, commission ${formatPrice(deduction, offer.currency)}.`}
              >
                <Text style={styles.priceLabel}>Vous gagnez</Text>
                <Text style={styles.price} numberOfLines={1} adjustsFontSizeToFit>
                  {formatPrice(offer.driver_payout_cents, offer.currency)}
                </Text>
                <Text style={styles.priceSub} numberOfLines={1}>
                  Course {formatPrice(offer.price_cents, offer.currency)} · commission {formatPrice(deduction, offer.currency)}
                </Text>
              </View>
            ) : (
              <View style={{ flex: 1 }}>
                <Text style={styles.price} numberOfLines={1} adjustsFontSizeToFit>{formatPrice(offer.price_cents, offer.currency)}</Text>
                <Text style={styles.priceSub}>{PAYMENT_METHOD_LABELS[offer.payment_method]}</Text>
              </View>
            )}
            <View style={styles.approach}>
              {offer.ride_type === "scheduled" ? (
                <Text style={styles.when}>{formatRideDate(offer.pickup_at, home?.organization.timezone)}</Text>
              ) : eta != null ? (
                <View accessible accessibilityLabel={`Client à ${formatDuration(eta)}, ${formatDistance(offer.distance_m)}`} style={{ alignItems: "flex-end" }}>
                  <Text style={styles.eta}>{formatDuration(eta)}</Text>
                  <Text style={styles.etaSub}>{formatDistance(offer.distance_m)} du client</Text>
                </View>
              ) : null}
            </View>
          </View>

          <RouteLine from={offer.pickup_address} to={offer.dropoff_address} big />

          <View style={styles.chips}>
            {offer.estimated_distance_m != null && <Chip icon="navigate-outline" text={`${formatDistance(offer.estimated_distance_m)} · ${formatDuration(offer.estimated_duration_s)}`} />}
            <Chip icon="people-outline" text={passengersText(offer.passengers)} />
            <Chip icon="briefcase-outline" text={luggageText(offer.luggage)} />
            {flight && <Chip icon="airplane-outline" text={flight.text} color={toneColor(flight.tone)} />}
          </View>
          {offer.comment ? (
            <View style={styles.comment}>
              <Ionicons name="chatbubble-outline" size={20} color={colors.muted} style={styles.commentIcon} />
              <Text style={styles.commentText} numberOfLines={3}>{offer.comment}</Text>
            </View>
          ) : null}
          {/* Qui encaisse le client : le chauffeur (il reverse la commission) ou la centrale (elle verse la part) */}
          {centrale && !blocked && (
            <CollectNote collects={collects} price={offer.price_cents} deduction={deduction} payout={offer.driver_payout_cents} currency={offer.currency} />
          )}

          <View style={styles.actions}>
            {closed ? (
              <View style={styles.closedBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <Ionicons name={success ? "checkmark-circle-outline" : "close-circle-outline"} size={24} color={success ? colors.green : colors.amber} />
                <Text style={styles.closedText}>
                  {state === "expired" ? "Offre expirée." : message ? frTypo(message) : state === "declined" ? "Offre refusée." : "Offre retirée."}
                </Text>
              </View>
            ) : blocked && block ? (
              // Mode centrale : commission en retard / contestée, plafond d'encours… → acceptation impossible
              <>
                <View style={styles.blockBox} accessibilityRole="alert">
                  <Ionicons name="lock-closed-outline" size={20} color={colors.red} style={styles.commentIcon} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.blockTitle}>Acceptation impossible</Text>
                    <Text style={styles.blockText}>{block.message}</Text>
                  </View>
                </View>
                <BigButton title="Accepter" icon="lock-closed-outline" variant="secondary" height={control.md} disabled onPress={() => undefined} />
                {block.payable && (
                  <BigButton title="Régler mes commissions" icon="wallet-outline" height={control.lg} onPress={() => router.push("/commissions")} />
                )}
                {secondary}
              </>
            ) : (
              <>
                {state === "open" && message ? (
                  <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">{frTypo(message)}</Text>
                ) : null}
                <BigButton title="Accepter" height={ACCEPT_H} onPress={accept} loading={busy} />
                {secondary}
              </>
            )}
          </View>
        </SafeAreaView>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", gap: space.md, paddingHorizontal: space.xl },
  back: { marginTop: space.xl, alignSelf: "stretch" },
  mapBox: { height: "40%" },
  mapTop: {
    position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start",
    gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm,
  },
  headBox: { ...overlay, flexShrink: 1, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  kicker: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.medium },
  number: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, marginTop: 2, ...mono },
  ring: { ...overlay, borderRadius: radius.full, padding: 4 },
  sheet: { flex: 1, marginTop: -24 },
  body: { flex: 1 },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: space.md },
  priceLabel: { color: colors.muted, fontSize: type.body, fontWeight: weight.medium },
  price: { color: colors.fg, fontSize: type.display, lineHeight: type.display + 6, fontWeight: weight.bold, letterSpacing: -0.5, ...mono },
  priceSub: { color: colors.muted, fontSize: type.body, ...mono },
  approach: { alignItems: "flex-end" },
  eta: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, ...mono },
  etaSub: { color: colors.muted, fontSize: type.body, ...mono },
  when: { color: colors.fg, fontSize: type.title3, fontWeight: weight.semibold, textAlign: "right", ...mono },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  comment: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  commentIcon: { marginTop: 1 },
  commentText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  actions: { gap: space.sm, marginTop: "auto" },
  secondary: { flexDirection: "row", gap: space.sm },
  secondaryBtn: { flex: 1, height: control.md, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.surface2 },
  declineText: { color: colors.muted, fontSize: type.callout, fontWeight: weight.semibold },
  laterText: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  error: { color: colors.red, fontSize: type.body, fontWeight: weight.medium, textAlign: "center", marginBottom: space.xs },
  blockBox: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, borderRadius: radius.lg,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, marginBottom: space.xs,
  },
  blockTitle: { color: colors.red, fontSize: type.callout, fontWeight: weight.bold },
  blockText: { color: colors.fg, fontSize: type.body, lineHeight: 21, marginTop: 2 },
  closedBox: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, minHeight: ACCEPT_H, paddingHorizontal: space.lg,
    borderRadius: radius.md, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  closedText: { flexShrink: 1, color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold },
  closedTitle: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold },
  loading: { color: colors.muted, fontSize: type.body, lineHeight: 21, textAlign: "center" },
});
