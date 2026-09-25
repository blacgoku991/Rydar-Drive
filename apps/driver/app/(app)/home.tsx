import { Ionicons } from "@expo/vector-icons";
import {
  DRIVER_FLOW, FLEET_REPORT_META, RIDE_STATUS_META, TRUST_LEVEL_META, formatPrice, formatRideDate, shortAddress, type Ride, type RideStatus,
} from "@rydar/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SettlementBanner, TrustBadge } from "@/components/centrale";
import { ReportCard, ReportSheet } from "@/components/fleet-report";
import { RydarMap } from "@/components/map/rydar-map";
import type { LatLng, MapReport } from "@/components/map/types";
import { BigButton, CountBadge, Pill, RouteLine, Screen, Sheet, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useMyPosition } from "@/hooks/use-my-position";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { colors, presenceColor } from "@/theme";

export default function Home() {
  const { home, offers, setOnline, busy, chat, refreshChat } = useDriver();
  const params = useLocalSearchParams<{ report?: string }>();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 66);
  const [current, setCurrent] = useState<Ride | null>(null);
  const [reporting, setReporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(null);
  const me = useMyPosition();
  const now = useNow(20_000);
  const presence = home?.driver.presence ?? "offline";
  const online = presence !== "offline";
  const scheduledOffers = offers.filter((o) => o.mode === "fleet").length;
  const unread = chat?.unread_total ?? 0;
  // Mode centrale : gains nets du jour (part chauffeur), commissions à régler / blocage, statut « Nouveau »
  const centrale = (home?.model ?? home?.organization.dispatch_model) === "centrale";
  const settlement = centrale ? home?.settlement ?? null : null;
  const blockedOffers = Boolean(settlement?.blocked);
  const isNew = centrale && home?.driver.trust_level === "new";

  useEffect(() => {
    const id = home?.driver.current_ride_id;
    if (id) api.ride(id).then(setCurrent).catch(() => setCurrent(null));
    else setCurrent(null);
  }, [home?.driver.current_ride_id]);

  // Signalements actifs de la flotte (masqués dès leur expiration, sans attendre le serveur)
  const activeReports = useMemo(
    () => (chat?.reports ?? []).filter((r) => r.report_type && r.lat != null && r.lng != null && r.expires_at && new Date(r.expires_at).getTime() > now),
    [chat?.reports, now],
  );
  const mapReports = useMemo<MapReport[]>(
    () => activeReports.map((r) => ({ id: r.id, type: r.report_type!, lat: r.lat!, lng: r.lng! })),
    [activeReports],
  );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, chat, activeReports]);

  async function toggle() {
    const res = await setOnline(!online);
    if (res.code === "coarse") {
      Alert.alert("Activez la position exacte", res.message, [
        { text: "Plus tard", style: "cancel" },
        { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings().catch(() => null) },
      ]);
      return;
    }
    if (!res.ok || res.message) Alert.alert(res.ok ? (res.code === "imprecise" ? "Position imprécise" : "Localisation") : "Action impossible", res.message ?? "Réessayez.");
  }

  const initials = `${(home?.driver.first_name ?? "?").charAt(0)}${(home?.driver.last_name ?? "").charAt(0)}`;

  return (
    <Screen>
      <RydarMap
        me={me}
        dim={!online && !selected}
        pulse={online && !current && !focus}
        padding={{ top: 120, bottom: 360, left: 40, right: 40 }}
        reports={mapReports}
        selectedReportId={selectedId}
        onReportPress={(id) => openReport(id)}
        focus={focus}
      />

      {/* Barre supérieure */}
      <SafeAreaView edges={["top"]} style={styles.top} pointerEvents="box-none">
        <Pressable onPress={() => router.push("/profile")} style={styles.avatar} accessibilityLabel="Profil">
          <Text style={styles.avatarText}>{initials}</Text>
        </Pressable>
        <Pressable onPress={() => router.push("/earnings")} style={({ pressed }) => [styles.earnings, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel="Mes gains">
          <Text style={styles.earningsLabel}>{centrale ? "Vos gains du jour" : "Aujourd'hui"}</Text>
          <Text style={styles.earningsValue} numberOfLines={1} adjustsFontSizeToFit>
            {formatPrice(centrale ? home?.today.net_cents ?? 0 : home?.today.revenue_cents ?? 0)}
            <Text style={styles.earningsSub}>  · {home?.today.rides ?? 0} course{(home?.today.rides ?? 0) > 1 ? "s" : ""}</Text>
          </Text>
        </Pressable>
        <Pressable onPress={() => router.push("/messages")} style={styles.avatar} accessibilityLabel={unread > 0 ? `Messages, ${unread} non lus` : "Messages"}>
          <Ionicons name="chatbubbles-outline" size={20} color={colors.fg} />
          <CountBadge count={unread} />
        </Pressable>
        <Pressable onPress={() => router.push("/planning")} style={styles.avatar} accessibilityLabel="Planning">
          <Ionicons name="calendar-outline" size={20} color={colors.fg} />
          {scheduledOffers > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{scheduledOffers}</Text>
            </View>
          )}
        </Pressable>
      </SafeAreaView>

      {flash.node}

      {/* Signalement touché sur la carte : carte d'information + votes à la place du panneau */}
      {selected ? (
        <SafeAreaView edges={["bottom"]} style={styles.bottomCard} pointerEvents="box-none">
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
        <View style={styles.bottom} pointerEvents="box-none">
          {/* Bouton rond « Signaler » posé sur la carte, au-dessus du panneau */}
          <View style={styles.fabRow} pointerEvents="box-none">
            {activeReports.length > 0 && (
              <Pressable
                onPress={() => openReport(activeReports[0]!.id)}
                style={styles.reportsPill}
                accessibilityRole="button"
                accessibilityLabel={`${activeReports.length} signalements actifs, voir le plus proche`}
              >
                <Text style={styles.reportsPillText}>
                  {activeReports.slice(0, 3).map((r) => FLEET_REPORT_META[r.report_type ?? "other"].emoji).join(" ")}  {activeReports.length} signalement{activeReports.length > 1 ? "s" : ""}
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setReporting(true)}
              style={({ pressed }) => [styles.fab, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}
              accessibilityRole="button"
              accessibilityLabel="Signaler à la flotte"
            >
              <Ionicons name="warning" size={26} color={colors.brandFg} />
              <Text style={styles.fabText}>Signaler</Text>
            </Pressable>
          </View>
          <Sheet>
            <SafeAreaView edges={["bottom"]} style={{ gap: 16, paddingBottom: 12 }}>
              {current ? (
                <>
                  <View style={styles.row}>
                    <View>
                      <Text style={styles.title}>Course en cours</Text>
                      <Text style={styles.subtitle}>
                        #{current.number} · {centrale && current.driver_payout_cents != null ? `vous gagnez ${formatPrice(current.driver_payout_cents)}` : formatPrice(current.price_cents)}
                      </Text>
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
                  {/* Mode centrale : commissions à régler (rouge si les courses sont bloquées), paiement signalé, part à recevoir */}
                  {settlement && (
                    <SettlementBanner s={settlement} tz={home?.organization.timezone} now={now} onPress={() => router.push("/commissions")} />
                  )}
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.title}>{online ? "Vous êtes en ligne" : "Vous êtes hors ligne"}</Text>
                      <Text style={[styles.subtitle, online && blockedOffers && { color: colors.red }]}>
                        {online
                          ? blockedOffers
                            ? "Aucune course ne vous est proposée tant que vos commissions ne sont pas réglées."
                            : "Les courses proches vous sont proposées automatiquement."
                          : "Passez en ligne pour recevoir les courses de votre centrale."}
                      </Text>
                    </View>
                    <View style={[styles.statusDot, { backgroundColor: online ? (blockedOffers ? colors.red : colors.brand) : colors.subtle }]} />
                  </View>
                  {/* Nouveau chauffeur (inscrit par lien) : courses plafonnées en prix jusqu'à la confirmation */}
                  {isNew && (
                    <View style={styles.trustRow}>
                      <TrustBadge level="new" />
                      <Text style={styles.trustText}>{TRUST_LEVEL_META.new.description}</Text>
                    </View>
                  )}

                  {home?.next_scheduled && (
                    <Pressable onPress={() => router.push({ pathname: "/ride/[id]", params: { id: home.next_scheduled!.id } })} style={styles.next}>
                      <Ionicons name="time-outline" size={20} color={colors.violet} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.nextWhen}>{formatRideDate(home.next_scheduled.pickup_at, home.organization.timezone)}</Text>
                        <Text style={styles.nextRoute} numberOfLines={1}>
                          {shortAddress(home.next_scheduled.pickup_address)} → {shortAddress(home.next_scheduled.dropoff_address)}
                        </Text>
                      </View>
                      <Text style={styles.nextPrice}>
                        {formatPrice(centrale && home.next_scheduled.driver_payout_cents != null ? home.next_scheduled.driver_payout_cents : home.next_scheduled.price_cents)}
                      </Text>
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
      )}

      <ReportSheet
        visible={reporting}
        me={me}
        onClose={() => setReporting(false)}
        onSent={(t) => {
          setReporting(false);
          flash.show(`${FLEET_REPORT_META[t].emoji}  Signalé à la flotte`);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(17,19,24,0.92)", borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.fg, fontWeight: "800", fontSize: 15 },
  earnings: { flex: 1, height: 48, borderRadius: 24, paddingHorizontal: 10, backgroundColor: "rgba(17,19,24,0.92)", borderWidth: 1, borderColor: colors.line, justifyContent: "center", alignItems: "center" },
  earningsLabel: { color: colors.subtle, fontSize: 11, fontWeight: "600" },
  earningsValue: { color: colors.brand, fontSize: 17, fontWeight: "800" },
  earningsSub: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  badge: { position: "absolute", top: -2, right: -2, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.violet, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  badgeText: { color: colors.bg, fontWeight: "800", fontSize: 11 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bottomCard: { position: "absolute", left: 12, right: 12, bottom: 12 },
  fabRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "flex-end", gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
  fab: {
    width: 74, height: 74, borderRadius: 37, backgroundColor: colors.amber, alignItems: "center", justifyContent: "center", gap: 1,
    borderWidth: 3, borderColor: "rgba(10,11,14,0.85)",
    shadowColor: colors.amber, shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  fabText: { color: colors.brandFg, fontSize: 11.5, fontWeight: "900", letterSpacing: 0.2 },
  reportsPill: { height: 36, borderRadius: 18, paddingHorizontal: 12, justifyContent: "center", backgroundColor: "rgba(17,19,24,0.92)", borderWidth: 1, borderColor: colors.line, marginBottom: 19 },
  reportsPillText: { color: colors.fg, fontSize: 13, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { color: colors.fg, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  subtitle: { color: colors.muted, fontSize: 14.5, marginTop: 4, lineHeight: 20 },
  statusDot: { width: 14, height: 14, borderRadius: 7 },
  next: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, backgroundColor: colors.surface2 },
  nextWhen: { color: colors.violet, fontSize: 14, fontWeight: "700" },
  nextRoute: { color: colors.fg, fontSize: 14.5, marginTop: 2 },
  nextPrice: { color: colors.fg, fontSize: 16, fontWeight: "800" },
  trustRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: -4 },
  trustText: { flex: 1, color: colors.muted, fontSize: 13.5, lineHeight: 18 },
});
