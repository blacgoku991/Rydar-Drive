import { Ionicons } from "@expo/vector-icons";
import {
  DRIVER_FLOW, FLEET_REPORT_META, RIDE_STATUS_META, formatPrice, formatRideDate, haversine, shortAddress, type RideStatus,
} from "@rydar/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { frTypo, SettlementBanner } from "@/components/centrale";
import { ReportCard, ReportSheet } from "@/components/fleet-report";
import { RydarMap } from "@/components/map/rydar-map";
import type { LatLng, MapReport } from "@/components/map/types";
import { NetworkBanner } from "@/components/network";
import { BigButton, CollapsibleSheet, CountBadge, Pill, RouteLine, Screen, useFlash, type SheetSurfaceProps } from "@/components/ui";
import { LOCATION_BLOCKED_MESSAGE, prepareFleetReport, useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { useNetworkTermsPrompt } from "@/hooks/use-network-terms-prompt";
import { useReturnFlash } from "@/hooks/use-return-flash";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { batteryRestricted, requestBatteryExemption } from "@/lib/battery";
import { useFleetRules } from "@/lib/chat-moderation";
import { useAppEvent } from "@/lib/events";
import { locationPermissionBlocked } from "@/lib/location";
import { rideMoneyView, settleHref, type AppRide, type LegacyRideContext } from "@/lib/network";
import { overdue } from "@/lib/planning";
import { colors, control, mono, overlay, presenceColor, radius, space, type, weight } from "@/theme";

type IconName = keyof typeof Ionicons.glyphMap;
const NBSP = " ";

/** Conseils « rester joignable » : une fois par lancement de l'app. */
let reachHintShown = false;

/**
 * Android, chauffeur passé EN LIGNE : l'économie de batterie peut couper l'app en arrière-plan (écran éteint,
 * autre application) — il passerait alors hors ligne sans l'avoir voulu.
 */
async function reachabilityHint() {
  if (reachHintShown || !(await batteryRestricted())) return;
  reachHintShown = true;
  Alert.alert(
    "Restez en ligne",
    frTypo(`Pour que votre position reste en direct écran éteint ou dans une autre application, réglez la batterie de Rydar Drive sur « Non restreinte » : Réglages › Batterie.`),
    [{ text: "Plus tard", style: "cancel" }, { text: "Ouvrir les réglages", onPress: () => void requestBatteryExemption() }],
  );
}
/** Écart entre les boutons posés sur la carte et le panneau du bas. */
const GAP = space.md;
/** Course en cours illisible (réseau) : nouvel essai après ce délai. */
const CURRENT_RIDE_RETRY_MS = 5000;

const openSettings = () => void Linking.openSettings().catch(() => null);

export default function Home() {
  const { home, homeError, refresh, offers, setOnline, busy, chat, refreshChat } = useDriver();
  const params = useLocalSearchParams<{ report?: string }>();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 66);
  const [current, setCurrent] = useState<AppRide | null>(null);
  const [reporting, setReporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(null);
  // Hauteur occupée en bas de l'écran (panneau, ou carte d'un signalement) : place du bouton « Recentrer »
  const [bottomH, setBottomH] = useState(0);
  // Localisation refusée définitivement : « Ouvrir les réglages » remplace « Passer en ligne » (l'information
  // préalable ne se répète pas, aucune fenêtre du système ne s'ouvrirait plus)
  const [locationBlocked, setLocationBlocked] = useState(false);
  // Panneau réduit par le chauffeur (glisser vers le bas) pour dégager la carte ; rouvert à chaque nouvelle course
  const [collapsed, setCollapsed] = useState(false);
  // « Signaler » publie dans le fil « Chauffeurs » : règles (CGU) acceptées avant la première publication
  const rules = useFleetRules(chat, refreshChat);
  const openingReport = useRef(false);
  const me = useMyPosition();
  const now = useNow(20_000);
  const loading = !home;
  const presence = home?.driver.presence ?? "offline";
  const online = presence !== "offline";
  const scheduledOffers = offers.filter((o) => o.mode === "fleet").length;
  const unread = chat?.unread_total ?? 0;
  // Mode centrale : gains nets du jour (part chauffeur), commissions à régler / blocage, période d'essai
  const centrale = (home?.model ?? home?.organization.dispatch_model) === "centrale";
  const settlement = centrale ? home?.settlement ?? null : null;
  const blockedOffers = Boolean(settlement?.blocked);
  const isNew = centrale && home?.driver.trust_level === "new";
  // Réseau partagé : conditions proposées une fois, accueil au premier plan (jamais pendant une offre ou une course)
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useNetworkTermsPrompt(focused, now);
  // Retour de l'écran des conditions (proposé ici) : « Courses du réseau partagé activées »
  useReturnFlash(flash.show);
  // Serveur antérieur à driver_ride : argent de la course en cours déduit du modèle de l'organisation
  const legacy = useRef<LegacyRideContext>({});
  legacy.current = { model: home?.model ?? home?.organization.dispatch_model, organization: home?.organization.name };

  // Course en cours : relue à chaque changement de présence (en route, sur place, client à bord) ou de course ;
  // lecture en échec (réseau) : nouvel essai, la carte « Course en cours » reste affichée en attendant
  const currentRideId = home?.driver.current_ride_id ?? null;
  const [rideTick, setRideTick] = useState(0);
  useAppEvent("ride", (rideId) => {
    if (!rideId || rideId === currentRideId) setRideTick((n) => n + 1);
  });
  useEffect(() => {
    if (!currentRideId) return setCurrent(null);
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      api
        .ride(currentRideId, legacy.current)
        .then((r) => alive && setCurrent(r))
        .catch(() => {
          if (alive) retry = setTimeout(load, CURRENT_RIDE_RETRY_MS);
        });
    };
    load();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [currentRideId, presence, rideTick]);
  // Course connue de l'accueil mais pas encore lue (réseau) : carte minimale, l'écran de course se charge lui-même
  const currentShown = current != null && current.id === currentRideId ? current : null;
  // Argent de la course en cours (driver_ride.money) : sa part (centrale, course partenaire), sinon le prix
  const currentMoney = currentShown ? rideMoneyView(currentShown) : null;
  // Nouvelle course en cours : panneau rouvert (le chauffeur voit la course sans avoir à le tirer)
  useEffect(() => {
    if (currentRideId) setCollapsed(false);
  }, [currentRideId]);

  // Signalements actifs de la flotte (masqués dès leur expiration, sans attendre le serveur)
  const activeReports = useMemo(
    () => (chat?.reports ?? []).filter((r) => r.report_type && r.lat != null && r.lng != null && r.expires_at && new Date(r.expires_at).getTime() > now),
    [chat?.reports, now],
  );
  const mapReports = useMemo<MapReport[]>(
    () => activeReports.map((r) => ({ id: r.id, type: r.report_type!, lat: r.lat!, lng: r.lng! })),
    [activeReports],
  );
  // Signalement le plus proche (ouvert depuis la pastille « 3 signalements »)
  const nearest = useMemo(() => {
    if (!activeReports.length) return null;
    if (!me) return activeReports[0]!;
    let best = activeReports[0]!;
    let bestD = Infinity;
    for (const r of activeReports) {
      const d = haversine(me, { lat: r.lat!, lng: r.lng! });
      if (d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best;
  }, [activeReports, me]);
  const selected = selectedId ? activeReports.find((r) => r.id === selectedId) ?? null : null;

  function openReport(id: string, at?: { lat?: number; lng?: number }) {
    const r = activeReports.find((x) => x.id === id);
    setSelectedId(id);
    if (r?.lat != null && r.lng != null) setFocus({ lat: r.lat, lng: r.lng });
    else if (at?.lat != null && at.lng != null) setFocus({ lat: at.lat, lng: at.lng });
  }
  function closeReport() {
    setSelectedId(null);
    setFocus(null);
  }
  // Rappel stable pour la carte (mémorisée : pas de nouveau rendu natif à chaque rafraîchissement de l'accueil)
  const openReportRef = useRef(openReport);
  openReportRef.current = openReport;
  const onReportPress = useCallback((id: string) => openReportRef.current(id), []);

  // Notification « signalement » touchée : accueil centré sur le signalement
  useAppEvent("report:focus", (p) => {
    void refreshChat();
    openReport(p.id, p);
  });
  useEffect(() => {
    if (params.report) {
      void refreshChat();
      openReport(String(params.report));
    }
  }, [params.report]);
  // Position connue une fois la messagerie relue ; signalement expiré entre-temps → message
  useEffect(() => {
    if (!selectedId || !chat) return;
    const r = activeReports.find((x) => x.id === selectedId);
    if (r?.lat != null && r.lng != null) {
      if (!focus) setFocus({ lat: r.lat, lng: r.lng });
      return;
    }
    const t = setTimeout(() => {
      flash.show("Ce signalement n'est plus actif.", "info");
      closeReport();
    }, 1500);
    return () => clearTimeout(t);
  }, [selectedId, chat, activeReports]);

  // Relue à l'ouverture et au retour dans l'app (le chauffeur a pu l'autoriser dans les réglages du téléphone)
  useEffect(() => {
    let alive = true;
    const check = () => void locationPermissionBlocked().then((b) => alive && setLocationBlocked(b));
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  /**
   * « Signaler », même hors ligne : règles du fil acceptées, puis autorisation de position (information préalable et
   * fenêtre du système si elle n'a jamais été donnée ou a expiré : la position accompagne le signalement).
   */
  async function openReportSheet() {
    if (openingReport.current) return;
    openingReport.current = true;
    try {
      if (!(await rules.ensure())) return;
      if (!(await prepareFleetReport())) {
        // Refus définitif : « Ouvrir les réglages » remplace aussi « Passer en ligne »
        setLocationBlocked(await locationPermissionBlocked());
        return;
      }
      setReporting(true);
    } finally {
      openingReport.current = false;
    }
  }

  // Accueil illisible (réseau) : relecture à la demande (les nouveaux essais automatiques continuent)
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  // La bascule est immédiate (setOnline est optimiste) : seul l'appel au serveur reste en cours (busy)
  async function toggle() {
    if (!home) return;
    const res = await setOnline(!online);
    if (res.code === "cancelled") return;
    if (res.code === "coarse" || res.code === "blocked") {
      if (res.code === "blocked") setLocationBlocked(true);
      Alert.alert(
        res.code === "coarse" ? "Activez la position exacte" : "Localisation refusée",
        frTypo(res.message ?? LOCATION_BLOCKED_MESSAGE),
        [{ text: "Plus tard", style: "cancel" }, { text: "Ouvrir les réglages", onPress: openSettings }],
      );
      return;
    }
    if (!res.ok) Alert.alert("Action impossible", frTypo(res.message ?? "Réessayez."));
    else if (!online) void reachabilityHint();
  }

  const measure = useCallback(
    (offset: number) => (e: LayoutChangeEvent) => {
      const h = Math.round(e.nativeEvent.layout.height) + offset;
      setBottomH((prev) => (Math.abs(prev - h) < 2 ? prev : h));
    },
    [],
  );
  const onPanelLayout = useMemo(() => measure(0), [measure]);
  const onCardLayout = useMemo(() => measure(space.md), [measure]);
  const mapPadding = useMemo(
    () => ({ top: insets.top + 72, bottom: Math.max(bottomH, 280) + GAP, left: 40, right: 40 }),
    [insets.top, bottomH],
  );

  const initials = home ? `${(home.driver.first_name ?? "").charAt(0)}${(home.driver.last_name ?? "").charAt(0)}`.toUpperCase() : "";
  const todayCents = centrale ? home?.today.net_cents ?? 0 : home?.today.revenue_cents ?? 0;
  const todayRides = home?.today.rides ?? 0;
  const todayRidesText = `${todayRides}${NBSP}course${todayRides > 1 ? "s" : ""}`;
  const todayLabel = centrale ? "Votre part aujourd'hui" : "Aujourd'hui";

  const statusTitle = loading ? (homeError ? "Connexion impossible" : "Chargement…") : online ? "Vous êtes en ligne" : "Vous êtes hors ligne";
  const statusText = loading
    ? homeError
      ? "Vérifiez votre connexion internet (4G ou Wi-Fi). Nouvel essai automatique."
      : null
    : online
      ? blockedOffers
        ? "Aucune course ne vous est proposée tant que vos commissions ne sont pas réglées."
        : "Les courses proches vous sont proposées automatiquement."
      : locationBlocked
        ? frTypo("Localisation refusée : autorisez-la dans les réglages pour recevoir des courses.")
        : "Passez en ligne pour recevoir des courses.";
  const dotColor = online ? (blockedOffers ? colors.red : colors.brand) : colors.subtle;

  // Panneau réduit : une ligne d'état et l'action principale (même logique que le panneau ouvert). Titre court :
  // il partage la ligne avec le bouton (point rouge + « Courses bloquées » = en ligne, commissions à régler).
  const peekTitle = currentRideId
    ? currentShown
      ? `Course ${currentShown.number} · ${RIDE_STATUS_META[currentShown.status as RideStatus].short}`
      : "Course en cours"
    : loading
      ? statusTitle
      : online
        ? blockedOffers ? "Courses bloquées" : "En ligne"
        : "Hors ligne";
  const peekDot = currentRideId ? presenceColor[presence] ?? colors.cyan : dotColor;
  const renderPeek = (surface: SheetSurfaceProps) => (
    <SafeAreaView edges={["bottom"]} style={styles.peek}>
      {/* Appui ou glissé vers le haut sur la ligne d'état : panneau rouvert */}
      <View {...surface} style={styles.peekInfo} accessibilityLabel={`${peekTitle}. Afficher le panneau`}>
        {!loading && <View style={[styles.dot, { backgroundColor: peekDot }]} />}
        <Text style={styles.peekTitle} numberOfLines={1}>{peekTitle}</Text>
      </View>
      {currentRideId ? (
        <BigButton
          title="Ouvrir"
          icon="arrow-forward"
          height={control.md}
          onPress={() => router.push({ pathname: "/ride/[id]", params: { id: currentRideId } })}
        />
      ) : loading ? (
        homeError ? <BigButton title="Réessayer" icon="refresh-outline" variant="secondary" height={control.md} loading={retrying} onPress={retry} /> : null
      ) : online ? (
        <BigButton title="Passer hors ligne" variant="secondary" icon="pause-circle-outline" height={control.md} onPress={toggle} />
      ) : locationBlocked ? (
        <BigButton
          title="Réglages"
          icon="settings-outline"
          height={control.md}
          onPress={openSettings}
          accessibilityHint="Autorisez la localisation de Rydar Drive pour passer en ligne"
        />
      ) : (
        <BigButton title="Passer en ligne" icon="power" height={control.md} onPress={toggle} />
      )}
    </SafeAreaView>
  );

  const next = home?.next_scheduled ?? null;
  const nextWhen = next ? formatRideDate(next.pickup_at, home?.organization.timezone) : "";
  // Prochaine course dont l'heure est passée sans démarrage : signalée (clôturée par le serveur quelques heures après)
  const nextLate = next != null && overdue({ type: "scheduled", status: "ACCEPTED", pickup_at: next.pickup_at }, now) != null;
  const nextPrice = next ? formatPrice(centrale && next.driver_payout_cents != null ? next.driver_payout_cents : next.price_cents) : "";

  return (
    <Screen>
      <RydarMap
        me={me}
        dim={!online && !selected && !collapsed}
        padding={mapPadding}
        reports={mapReports}
        selectedReportId={selectedId}
        onReportPress={onReportPress}
        focus={focus}
        controlsBottom={bottomH + GAP}
        controlsTop={insets.top + 72}
      />

      {/* Barre supérieure : profil, gains du jour, messages, planning */}
      <SafeAreaView edges={["top"]} style={styles.top} pointerEvents="box-none">
        <Pressable
          onPress={() => router.push("/profile")}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Profil"
        >
          {initials ? <Text style={styles.initials}>{initials}</Text> : <Ionicons name="person-outline" size={22} color={colors.fg} />}
        </Pressable>
        <Pressable
          onPress={() => router.push("/earnings")}
          style={({ pressed }) => [styles.today, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={home ? `${todayLabel}${NBSP}: ${formatPrice(todayCents)}, ${todayRidesText}. Voir mes gains` : "Voir mes gains"}
        >
          <Text style={styles.todayLabel} numberOfLines={1}>{todayLabel}</Text>
          <Text style={styles.todayValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {home ? formatPrice(todayCents) : "–"}
            {home ? <Text style={styles.todaySub}>{` · ${todayRidesText}`}</Text> : null}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => router.push("/messages")}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={unread > 0 ? `Messages, ${unread} non lu${unread > 1 ? "s" : ""}` : "Messages"}
        >
          <Ionicons name="chatbubble-outline" size={22} color={colors.fg} />
          <CountBadge count={unread} />
        </Pressable>
        <Pressable
          onPress={() => router.push("/planning")}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={scheduledOffers > 0 ? `Planning, ${scheduledOffers} course${scheduledOffers > 1 ? "s" : ""} proposée${scheduledOffers > 1 ? "s" : ""}` : "Planning"}
        >
          <Ionicons name="calendar-outline" size={22} color={colors.fg} />
          <CountBadge count={scheduledOffers} color={colors.violet} />
        </Pressable>
      </SafeAreaView>

      {flash.node}

      {/* Signalement touché sur la carte : carte d'information + votes à la place du panneau */}
      {selected ? (
        <SafeAreaView edges={["bottom"]} style={styles.bottomCard} pointerEvents="box-none" onLayout={onCardLayout}>
          <ReportCard
            report={selected}
            me={me}
            myDriverId={home?.driver.id}
            onClose={closeReport}
            onFlash={flash.show}
            onExpired={closeReport}
          />
        </SafeAreaView>
      ) : (
        <View style={styles.bottom} pointerEvents="box-none" onLayout={onPanelLayout}>
          {/* Colonne de droite posée sur la carte : « Signaler » (et « Recentrer » juste au-dessus, dans la carte) */}
          <View style={styles.fabRow} pointerEvents="box-none">
            {nearest && (
              <Pressable
                onPress={() => openReport(nearest.id)}
                style={({ pressed }) => [styles.reportsPill, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${activeReports.length} signalement${activeReports.length > 1 ? "s" : ""} actif${activeReports.length > 1 ? "s" : ""}, voir le plus proche`}
              >
                <Ionicons
                  name={(FLEET_REPORT_META[nearest.report_type ?? "other"] ?? FLEET_REPORT_META.other).ionicon as IconName}
                  size={20}
                  color={(FLEET_REPORT_META[nearest.report_type ?? "other"] ?? FLEET_REPORT_META.other).color}
                />
                <Text style={styles.reportsPillText}>
                  {activeReports.length}{NBSP}signalement{activeReports.length > 1 ? "s" : ""}
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => void openReportSheet()}
              style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Signaler à la flotte"
              accessibilityHint="Police, contrôle, accident, bouchon ou danger à votre position"
            >
              <Ionicons name="warning-outline" size={24} color={colors.fg} />
            </Pressable>
          </View>

          <CollapsibleSheet collapsed={collapsed} onCollapsedChange={setCollapsed} peek={renderPeek}>
            <SafeAreaView edges={["bottom"]} style={styles.panel}>
              {currentShown ? (
                <>
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.title} accessibilityRole="header">Course en cours</Text>
                      <Text style={styles.subtitle}>
                        Course {currentShown.number}
                        {currentShown.network ? ` · partenaire (${currentShown.network.giver.name})` : ""}
                        {" · "}
                        <Text style={mono}>
                          {currentMoney && currentMoney.kind !== "plain"
                            ? `vous gagnez ${formatPrice(currentMoney.gainCents, currentMoney.currency)}`
                            : formatPrice(currentShown.price_cents, currentShown.currency)}
                        </Text>
                      </Text>
                    </View>
                    <Pill label={RIDE_STATUS_META[currentShown.status as RideStatus].short} color={presenceColor[presence] ?? colors.cyan} />
                  </View>
                  <RouteLine from={shortAddress(currentShown.pickup_address)} to={shortAddress(currentShown.dropoff_address)} />
                  <BigButton
                    title={DRIVER_FLOW[currentShown.status as RideStatus]?.label ?? "Ouvrir la course"}
                    icon="arrow-forward"
                    onPress={() => router.push({ pathname: "/ride/[id]", params: { id: currentShown.id } })}
                  />
                </>
              ) : currentRideId ? (
                <>
                  <Text style={styles.title} accessibilityRole="header">Course en cours</Text>
                  <BigButton
                    title="Ouvrir la course"
                    icon="arrow-forward"
                    onPress={() => router.push({ pathname: "/ride/[id]", params: { id: currentRideId } })}
                  />
                </>
              ) : (
                <>
                  {/* Mode centrale : commissions à régler (rouge si les courses sont bloquées), paiement signalé, part à recevoir */}
                  {settlement && (
                    <SettlementBanner s={settlement} tz={home?.organization.timezone} now={now} onPress={() => router.push("/commissions")} />
                  )}
                  {/* Réseau partagé : sommes à régler aux organisations partenaires (blocage de leurs courses), part à recevoir */}
                  <NetworkBanner n={home?.network} executor={home?.organization.name} onPress={() => router.push(settleHref("network"))} />

                  <View style={styles.status} accessibilityLiveRegion="polite">
                    <View style={styles.statusHead}>
                      {!loading && <View style={[styles.dot, { backgroundColor: dotColor }]} />}
                      <Text style={styles.title} accessibilityRole="header">{statusTitle}</Text>
                      {busy && (
                        <ActivityIndicator
                          size="small"
                          color={colors.muted}
                          style={styles.busy}
                          accessibilityLabel="Synchronisation en cours"
                        />
                      )}
                    </View>
                    {statusText && (
                      <Text style={[styles.subtitle, online && blockedOffers && { color: colors.red }]}>{statusText}</Text>
                    )}
                  </View>

                  {/* Nouveau chauffeur (inscrit par lien) : certaines courses réservées jusqu'à la confirmation */}
                  {isNew && (
                    <View style={styles.note}>
                      <Ionicons name="information-circle-outline" size={20} color={colors.muted} />
                      <Text style={styles.noteText}>
                        Période d'essai{NBSP}: certaines courses sont réservées aux chauffeurs confirmés.
                      </Text>
                    </View>
                  )}

                  {next && (
                    <Pressable
                      onPress={() => router.push({ pathname: "/ride/[id]", params: { id: next.id } })}
                      style={({ pressed }) => [styles.next, pressed && { backgroundColor: colors.surface3 }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Prochaine course, ${nextWhen}${nextLate ? ", heure dépassée" : ""}, de ${shortAddress(next.pickup_address)} à ${shortAddress(next.dropoff_address)}, ${nextPrice}`}
                    >
                      <Ionicons name="time-outline" size={20} color={nextLate ? colors.amber : colors.muted} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.nextWhen} numberOfLines={1}>
                          {nextWhen}
                          {nextLate ? <Text style={styles.nextLate}> · heure dépassée</Text> : null}
                        </Text>
                        <Text style={styles.nextRoute} numberOfLines={1}>
                          {shortAddress(next.pickup_address)} → {shortAddress(next.dropoff_address)}
                        </Text>
                      </View>
                      <Text style={styles.nextPrice}>{nextPrice}</Text>
                      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                    </Pressable>
                  )}

                  {loading && homeError ? (
                    <BigButton title="Réessayer" icon="refresh-outline" variant="secondary" height={control.md} loading={retrying} onPress={retry} />
                  ) : loading ? (
                    <BigButton title="Passer en ligne" icon="power" height={control.xl} onPress={() => undefined} disabled />
                  ) : online ? (
                    <BigButton title="Passer hors ligne" variant="secondary" icon="pause-circle-outline" height={control.md} onPress={toggle} />
                  ) : locationBlocked ? (
                    <BigButton
                      title="Ouvrir les réglages"
                      icon="settings-outline"
                      height={control.xl}
                      onPress={openSettings}
                      accessibilityHint="Autorisez la localisation de Rydar Drive pour passer en ligne"
                    />
                  ) : (
                    <BigButton title="Passer en ligne" icon="power" height={control.xl} onPress={toggle} />
                  )}
                </>
              )}
            </SafeAreaView>
          </CollapsibleSheet>
        </View>
      )}

      {rules.node}

      <ReportSheet
        visible={reporting}
        me={me}
        onClose={() => setReporting(false)}
        onSent={(t) => {
          setReporting(false);
          const meta = FLEET_REPORT_META[t] ?? FLEET_REPORT_META.other;
          flash.show(`Signalement envoyé · ${meta.label}`, "success", meta.ionicon as IconName);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm },
  round: { ...overlay, width: control.sm, height: control.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.surface3 },
  initials: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  today: { ...overlay, flex: 1, height: control.sm, borderRadius: radius.full, paddingHorizontal: space.md, alignItems: "center", justifyContent: "center" },
  todayLabel: { color: colors.muted, fontSize: type.caption, fontWeight: weight.semibold },
  todayValue: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, ...mono },
  todaySub: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bottomCard: { position: "absolute", left: space.md, right: space.md, bottom: space.md },
  // paddingRight 12 : le bouton de 56 px est centré sur la même colonne que « Recentrer » (48 px à 16 px du bord)
  fabRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.md, paddingLeft: space.lg, paddingRight: space.md, paddingBottom: GAP },
  fab: { ...overlay, width: control.md, height: control.md, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  reportsPill: {
    ...overlay, height: control.sm, borderRadius: radius.full, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1,
  },
  reportsPillText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, ...mono },
  panel: { gap: space.lg, paddingBottom: space.md },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  status: { gap: space.xs },
  statusHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  busy: { marginLeft: "auto" },
  title: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3 },
  subtitle: { color: colors.muted, fontSize: type.body, lineHeight: 21, marginTop: 2 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  noteText: { flex: 1, color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  peek: { flexDirection: "row", alignItems: "center", gap: space.md, paddingBottom: space.md },
  peekInfo: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: control.md },
  peekTitle: { flex: 1, color: colors.fg, fontSize: type.headline, fontWeight: weight.bold },
  next: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.lg, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.lg, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  nextWhen: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  nextLate: { color: colors.amber },
  nextRoute: { color: colors.muted, fontSize: type.subhead, marginTop: 2 },
  nextPrice: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, ...mono },
});
