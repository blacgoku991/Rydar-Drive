// Carte native (iOS : Apple Plans, Android : Google Maps) en style sombre Rydar.
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_META } from "@rydar/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { colors } from "@/theme";
import { MeMarker } from "./me-marker";
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

/**
 * Pastille d'un signalement : pictogramme Ionicons de la couleur du type, pointe posée sur le lieu.
 * Rendu suivi un court instant (sinon vue vide sur Android, le temps que la police d'icônes se dessine).
 */
function ReportMarker({ report, selected, onPress }: { report: MapReport; selected: boolean; onPress?: (id: string) => void }) {
  const meta = FLEET_REPORT_META[report.type] ?? FLEET_REPORT_META.other;
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), 1000);
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
      accessibilityLabel={`Signalement\u00A0: ${meta.label}`}
    >
      <View style={styles.reportWrap}>
        <View style={[styles.report, { borderColor: meta.color }, selected && styles.reportSelected]}>
          <Ionicons name={meta.ionicon as keyof typeof Ionicons.glyphMap} size={20} color={meta.color} />
        </View>
        <View style={[styles.reportTip, { borderTopColor: meta.color }]} />
      </View>
    </Marker>
  );
}

const DEFAULT_PADDING = { top: 80, bottom: 80, left: 50, right: 50 };
/** Altitude de caméra (Apple Plans ignore le zoom) équivalente au niveau de zoom Google. */
const altitudeFor = (zoom: number) => Math.round(1100 * 2 ** (16 - zoom));

/** Guidage : zoom selon la vitesse (m/s) — rue en ville, plus large sur voie rapide. */
const navZoom = (speed: number | null) => ((speed ?? 0) < 8 ? 17 : (speed ?? 0) < 19 ? 16 : 15);
/** Guidage : le chauffeur est placé sous le centre de la carte (part de la hauteur) pour voir la route devant. */
const NAV_LOOK_AHEAD = 0.2;
/** Guidage : intervalle minimal entre deux mouvements de caméra (le GPS iOS peut émettre plusieurs points par seconde). */
const NAV_CAMERA_MS = 700;

/** Point situé à `m` mètres de p dans la direction `heading` (degrés). */
function ahead(p: { lat: number; lng: number }, heading: number, m: number) {
  const r = (heading * Math.PI) / 180;
  return {
    latitude: p.lat + (m * Math.cos(r)) / 111_320,
    longitude: p.lng + (m * Math.sin(r)) / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

function RydarMapImpl({
  me, pickup, dropoff, route, routeMuted, navigation = false, dim, padding = DEFAULT_PADDING, zoom = 16, reports, selectedReportId, onReportPress, focus,
  controlsBottom = 24,
}: RydarMapProps) {
  const ref = useRef<MapView>(null);
  // Suivi du chauffeur tant qu'il ne déplace pas la carte à la main ; bouton « Recentrer » ensuite
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const routeCoords = useMemo(() => (route && route.length > 1 ? route.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) : null), [route]);
  const mutedCoords = useMemo(
    () => (routeMuted && routeMuted.length > 1 ? routeMuted.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) : null),
    [routeMuted],
  );
  const framed = Boolean(pickup || dropoff || routeCoords);
  const hasMe = me != null;
  // Tracé repéré par son arrivée : le tracé restant du guidage raccourcit à chaque point sans recadrer la carte
  const routeEnd = route && route.length > 1 ? route[route.length - 1] : null;
  const key = `${pickup?.lat},${pickup?.lng},${dropoff?.lat},${dropoff?.lng},${routeEnd?.[0]},${routeEnd?.[1]},${hasMe ? 1 : 0},${focus?.lat},${focus?.lng},${navigation}`;
  // Orientation de la carte (guidage : sens de marche ; sinon nord en haut)
  const [camHeading, setCamHeading] = useState(0);
  const camHeadingRef = useRef(0);
  const lastNavCamera = useRef(0);
  const height = useRef(0);
  // Dernières valeurs pour « Recentrer » (position à jour, pas celle du dernier cadrage)
  const latest = useRef({ me, pickup, dropoff, routeCoords, focus, padding, zoom, navigation });
  latest.current = { me, pickup, dropoff, routeCoords, focus, padding, zoom, navigation };

  /** Caméra de guidage : chauffeur un peu sous le centre, carte tournée dans son sens de marche. */
  const navCamera = useCallback((duration: number) => {
    const { me } = latest.current;
    if (!me) return;
    lastNavCamera.current = Date.now();
    const heading = me.heading ?? camHeadingRef.current;
    const z = navZoom(me.speed ?? null);
    const metersPerPx = (156_543.03 * Math.cos((me.lat * Math.PI) / 180)) / 2 ** z;
    const center = ahead(me, heading, height.current * NAV_LOOK_AHEAD * metersPerPx);
    ref.current?.animateCamera({ center, heading, zoom: z, altitude: altitudeFor(z), pitch: 0 }, { duration });
    if (heading !== camHeadingRef.current) {
      camHeadingRef.current = heading;
      setCamHeading(heading);
    }
  }, []);

  const frame = useCallback(() => {
    const { me, pickup, dropoff, routeCoords, focus, padding, zoom, navigation } = latest.current;
    if (navigation && me && !focus) {
      navCamera(600);
      return;
    }
    // Fin du guidage : retour au nord en haut avant de cadrer
    if (camHeadingRef.current !== 0) {
      camHeadingRef.current = 0;
      setCamHeading(0);
      ref.current?.setCamera({ heading: 0 });
    }
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
  }, [navCamera]);

  // Cadrage : signalement ciblé, course (tracé + points), sinon le chauffeur à l'échelle de la rue
  useEffect(() => {
    setFollow(true);
    frame();
  }, [key, frame]);

  // Suivi : la carte accompagne le chauffeur. Guidage : position, cap et zoom
  useEffect(() => {
    if (!follow || !me || focus || !navigation) return;
    if (Date.now() - lastNavCamera.current >= NAV_CAMERA_MS) navCamera(900);
  }, [follow, me?.lat, me?.lng, me?.heading, focus, navigation, navCamera]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hors guidage : centre seulement, zoom choisi conservé (un changement de cap, boussole comprise, ne bouge pas la carte)
  useEffect(() => {
    if (!follow || !me || focus || navigation || framed) return;
    ref.current?.animateCamera({ center: toLL(me) }, { duration: 500 });
  }, [follow, me?.lat, me?.lng, framed, focus, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

  const accuracy = me?.accuracy ?? null;
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => (height.current = e.nativeEvent.layout.height)}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_DEFAULT}
        customMapStyle={darkMap}
        userInterfaceStyle="dark"
        showsCompass={false}
        showsPointsOfInterests={false}
        toolbarEnabled={false}
        // Carte à plat, nord en haut : lisible d'un coup d'œil au volant. Guidage : rotation permise, sinon Apple Plans
        // ignore le cap de la caméra (la carte ne tournerait pas dans le sens de marche)
        pitchEnabled={false}
        rotateEnabled={navigation}
        showsBuildings={false}
        onPanDrag={() => {
          if (followRef.current) setFollow(false);
        }}
        onRegionChangeComplete={() => {
          if (!navigation) return;
          // Orientation réelle de la carte (geste de rotation, cap refusé) : la flèche du chauffeur reste juste
          void ref.current?.getCamera().then((c) => {
            const h = ((c.heading % 360) + 360) % 360;
            if (Math.abs(((h - camHeadingRef.current + 540) % 360) - 180) > 1) {
              camHeadingRef.current = h;
              setCamHeading(h);
            }
          }).catch(() => null);
        }}
        initialRegion={me ? { ...toLL(me), latitudeDelta: 0.01, longitudeDelta: 0.01 } : { latitude: 48.8634, longitude: 2.3488, latitudeDelta: 0.12, longitudeDelta: 0.12 }}
      >
        {mutedCoords && <Polyline coordinates={mutedCoords} strokeColor="rgba(158,165,177,0.45)" strokeWidth={4} lineDashPattern={[2, 8]} />}
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
        {me && <MeMarker me={me} mapHeading={camHeading} navigation={navigation} />}
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
          accessibilityLabel={navigation ? "Reprendre le guidage" : "Recentrer la carte"}
          hitSlop={6}
        >
          <Ionicons name={navigation ? "navigate" : "locate"} size={22} color={colors.fg} />
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
  recenter: {
    position: "absolute", right: 16, width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(17,19,24,0.94)", borderWidth: 1, borderColor: colors.lineStrong,
  },
  reportWrap: { alignItems: "center", paddingTop: 4, paddingHorizontal: 4 },
  report: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  reportSelected: { transform: [{ scale: 1.18 }], backgroundColor: colors.surface3 },
  reportTip: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 7, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
});
