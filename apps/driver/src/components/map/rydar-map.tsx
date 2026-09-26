// Carte native (iOS : Apple Plans, Android : Google Maps) en style sombre Rydar.
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_META } from "@rydar/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { colors } from "@/theme";
import type { MapReport, RydarMapProps } from "./types";

const darkMap = [
  { elementType: "geometry", stylers: [{ color: "#0d1013" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8b929d" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b0d10" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1f252d" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#353d48" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#2a313b" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0a1520" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ visibility: "on" }, { color: "#0f1813" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

const toLL = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

/** Pastille emoji d'un signalement ; rendu suivi un court instant (sinon vue vide sur Android). */
function ReportMarker({ report, selected, onPress }: { report: MapReport; selected: boolean; onPress?: (id: string) => void }) {
  const meta = FLEET_REPORT_META[report.type] ?? FLEET_REPORT_META.other;
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), 700);
    return () => clearTimeout(t);
  }, [selected]);
  return (
    <Marker
      coordinate={toLL(report)}
      anchor={{ x: 0.5, y: 1 }}
      // iOS (Apple Plans) : anchor ignoré, la pointe est posée sur le lieu par décalage
      centerOffset={{ x: 0, y: -25 }}
      tracksViewChanges={track}
      zIndex={selected ? 30 : 20}
      onPress={() => onPress?.(report.id)}
      accessibilityLabel={`Signalement : ${meta.label}`}
    >
      <View style={styles.reportWrap}>
        <View style={[styles.report, { borderColor: meta.color, transform: [{ scale: selected ? 1.18 : 1 }] }]}>
          <Text style={styles.reportEmoji}>{meta.emoji}</Text>
        </View>
        <View style={[styles.reportTip, { borderTopColor: meta.color }]} />
      </View>
    </Marker>
  );
}

const DEFAULT_PADDING = { top: 80, bottom: 80, left: 50, right: 50 };
/** Altitude de caméra (Apple Plans ignore le zoom) équivalente au niveau de zoom Google. */
const altitudeFor = (zoom: number) => Math.round(1100 * 2 ** (16 - zoom));

/** Position du chauffeur : point bleu, flèche de cap quand il roule. */
function MeMarker({ me }: { me: NonNullable<RydarMapProps["me"]> }) {
  const heading = me.heading ?? null;
  const ios = Platform.OS === "ios";
  return (
    <Marker
      // Android : vue rendue en image — nouvelle image quand la flèche apparaît / disparaît
      key={heading == null ? "dot" : "dir"}
      coordinate={toLL(me)}
      anchor={{ x: 0.5, y: 0.5 }}
      // Rotation native réservée à Google Maps (Android) ; sur iPhone la vue elle-même tourne
      flat={!ios}
      rotation={!ios && heading != null ? heading : undefined}
      tracksViewChanges={ios}
      zIndex={40}
      accessibilityLabel="Votre position"
    >
      <View style={[styles.meWrap, ios && heading != null && { transform: [{ rotate: `${heading}deg` }] }]}>
        {heading != null && <View style={styles.meArrow} />}
        <View style={styles.meDot} />
      </View>
    </Marker>
  );
}

function RydarMapImpl({
  me, pickup, dropoff, route, dim, padding = DEFAULT_PADDING, zoom = 16, reports, selectedReportId, onReportPress, focus, controlsBottom = 24,
}: RydarMapProps) {
  const ref = useRef<MapView>(null);
  // Suivi du chauffeur tant qu'il ne déplace pas la carte à la main ; bouton « Recentrer » ensuite
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const routeCoords = useMemo(() => (route && route.length > 1 ? route.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) : null), [route]);
  const framed = Boolean(pickup || dropoff || routeCoords);
  const hasMe = me != null;
  const key = `${pickup?.lat},${pickup?.lng},${dropoff?.lat},${dropoff?.lng},${route?.length ?? 0},${hasMe ? 1 : 0},${focus?.lat},${focus?.lng}`;
  // Dernières valeurs pour « Recentrer » (position à jour, pas celle du dernier cadrage)
  const latest = useRef({ me, pickup, dropoff, routeCoords, focus, padding, zoom });
  latest.current = { me, pickup, dropoff, routeCoords, focus, padding, zoom };

  const frame = useCallback(() => {
    const { me, pickup, dropoff, routeCoords, focus, padding, zoom } = latest.current;
    if (focus) {
      ref.current?.animateCamera({ center: toLL(focus), zoom, altitude: altitudeFor(zoom), pitch: 0 }, { duration: 600 });
      return;
    }
    const pts = [...(routeCoords ?? [])];
    if (pickup) pts.push(toLL(pickup));
    if (dropoff) pts.push(toLL(dropoff));
    if (me && (pickup || dropoff)) pts.push(toLL(me));
    if (pts.length > 1) ref.current?.fitToCoordinates(pts, { edgePadding: padding, animated: true });
    else if (me) ref.current?.animateCamera({ center: toLL(me), zoom, altitude: altitudeFor(zoom), pitch: 0, heading: 0 }, { duration: 600 });
  }, []);

  // Cadrage : signalement ciblé, course (tracé + points), sinon le chauffeur à l'échelle de la rue
  useEffect(() => {
    setFollow(true);
    frame();
  }, [key, frame]);

  // Suivi : la carte accompagne le chauffeur (centre seulement : zoom choisi conservé)
  useEffect(() => {
    if (!follow || !me || framed || focus) return;
    ref.current?.animateCamera({ center: toLL(me) }, { duration: 500 });
  }, [follow, me?.lat, me?.lng, framed, focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const accuracy = me?.accuracy ?? null;
  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_DEFAULT}
        customMapStyle={darkMap}
        userInterfaceStyle="dark"
        showsCompass={false}
        showsPointsOfInterests={false}
        toolbarEnabled={false}
        // Carte à plat, nord en haut : lisible d'un coup d'œil au volant
        pitchEnabled={false}
        rotateEnabled={false}
        showsBuildings={false}
        onPanDrag={() => {
          if (followRef.current) setFollow(false);
        }}
        initialRegion={me ? { ...toLL(me), latitudeDelta: 0.01, longitudeDelta: 0.01 } : { latitude: 48.8634, longitude: 2.3488, latitudeDelta: 0.12, longitudeDelta: 0.12 }}
      >
        {routeCoords && (
          <>
            <Polyline coordinates={routeCoords} strokeColor="#0b0d10" strokeWidth={9} />
            <Polyline coordinates={routeCoords} strokeColor={colors.brand} strokeWidth={5} />
          </>
        )}
        {pickup && (
          <Marker coordinate={toLL(pickup)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.pickup} />
          </Marker>
        )}
        {dropoff && (
          <Marker coordinate={toLL(dropoff)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.dropoff} />
          </Marker>
        )}
        {reports?.map((r) => (
          <ReportMarker key={r.id} report={r} selected={r.id === selectedReportId} onPress={onReportPress} />
        ))}
        {/* Précision réelle du GPS : cercle accroché à la position (rien quand elle est précise) */}
        {me && accuracy != null && accuracy > 15 && (
          <Circle center={toLL(me)} radius={Math.min(accuracy, 500)} strokeWidth={1} strokeColor="rgba(106,166,255,0.45)" fillColor="rgba(106,166,255,0.10)" zIndex={1} />
        )}
        {me && <MeMarker me={me} />}
      </MapView>
      {dim && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(6,7,9,0.55)" }]} />}
      {!follow && (me || framed) && (
        <Pressable
          onPress={() => {
            setFollow(true);
            frame();
          }}
          style={({ pressed }) => [styles.recenter, { bottom: controlsBottom, opacity: pressed ? 0.8 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel="Recentrer la carte"
          hitSlop={6}
        >
          <Ionicons name="locate" size={22} color={colors.fg} />
        </Pressable>
      )}
    </View>
  );
}

/** Carte (mémorisée : pas de nouveau rendu natif quand l'écran parent se redessine pour autre chose). */
export const RydarMap = memo(RydarMapImpl);

const styles = StyleSheet.create({
  pickup: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.brand, borderWidth: 5, borderColor: "#0b0d10" },
  dropoff: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.fg, borderWidth: 4, borderColor: "#0b0d10" },
  meWrap: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  meDot: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: colors.blue, borderWidth: 3, borderColor: "#FFFFFF",
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 4,
  },
  recenter: {
    position: "absolute", right: 16, width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(17,19,24,0.94)", borderWidth: 1, borderColor: colors.lineStrong,
  },
  reportWrap: { alignItems: "center", paddingTop: 4, paddingHorizontal: 4 },
  report: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  reportEmoji: { fontSize: 20, lineHeight: 24, textAlign: "center" },
  reportTip: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 7, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
  // Flèche de cap au-dessus du point (la vue entière tourne selon le cap)
  meArrow: {
    position: "absolute", top: 0, width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderBottomWidth: 11,
    borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: colors.blue,
  },
});
