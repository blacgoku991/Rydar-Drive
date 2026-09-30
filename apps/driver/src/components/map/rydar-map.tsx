// Carte native (iOS : Apple Plans, Android : Google Maps) en style sombre Rydar.
import { Ionicons } from "@expo/vector-icons";
import { FLEET_REPORT_META } from "@rydar/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT, type Details, type Region } from "react-native-maps";
import Svg, { G, Path } from "react-native-svg";
import { colors } from "@/theme";
import { MapGestures, headingGap, isNorthUp, nearCenter, normHeading, shouldAutoRecenter } from "./follow";
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
      {/* Vue conservée (collapsable) : sinon Fabric l'aplatit et iOS mesure la pastille seule, décalée de quelques points */}
      <View style={styles.reportWrap} collapsable={false}>
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

/** Cadrage programmé (Recentrer, boussole, reprise du suivi) : aucun mouvement de suivi pendant son animation (ms). */
const FRAME_MS = 700;
/** Orientation de la carte relue au plus toutes les … ms pendant un geste (flèche du chauffeur, boussole). */
const HEADING_REFRESH_MS = 100;

/** Aiguille de la boussole : pointe rouge vers le nord (tournée de l'inverse de l'orientation de la carte). */
function CompassNeedle({ heading }: { heading: number }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <G rotation={-heading} origin="12, 12">
        <Path d="M12 2.5 L16.5 12 L7.5 12 Z" fill={colors.red} />
        <Path d="M12 21.5 L16.5 12 L7.5 12 Z" fill={colors.muted} />
      </G>
    </Svg>
  );
}

function RydarMapImpl({
  me, pickup, dropoff, route, routeMuted, navigation = false, dim, padding = DEFAULT_PADDING, zoom = 16, reports, selectedReportId, onReportPress, focus,
  controlsBottom = 24,
}: RydarMapProps) {
  const ref = useRef<MapView>(null);
  // Suivi du chauffeur : suspendu le temps d'un geste, arrêté quand la carte est déplacée ailleurs (bouton « Recentrer »,
  // retour automatique quand il roule)
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
  // Orientation de la carte : sens de marche en guidage, sinon nord en haut ou celle choisie à deux doigts
  const [camHeading, setCamHeading] = useState(0);
  const camHeadingRef = useRef(0);
  const lastNavCamera = useRef(0);
  const size = useRef({ width: 0, height: 0 });
  const frameAt = useRef(0);
  const headingAt = useRef(0);
  const alive = useRef(true);
  // Dernières valeurs pour « Recentrer » et les rappels de la carte (position à jour, pas celle du dernier cadrage)
  const latest = useRef({ me, pickup, dropoff, routeCoords, focus, padding, zoom, navigation, framed });
  latest.current = { me, pickup, dropoff, routeCoords, focus, padding, zoom, navigation, framed };
  /**
   * Gestes du chauffeur. Carte immobile après un geste qui l'a bougée : chauffeur resté près du centre (zoom, rotation,
   * petit glissement) → le suivi continue ; carte déplacée ailleurs → « Recentrer ». Guidage, course cadrée ou
   * signalement ouvert : tout geste arrête le suivi.
   */
  const [gestures] = useState(
    () =>
      new MapGestures((g) => {
        const { me, navigation, focus, framed } = latest.current;
        if (navigation || framed || focus || !me) {
          setFollow(false);
          return;
        }
        ref.current
          ?.pointForCoordinate(toLL(me))
          .then((p) => {
            if (alive.current && !g.busy) setFollow(nearCenter(p, size.current));
          })
          .catch(() => {
            if (alive.current) setFollow(false);
          });
      }),
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      gestures.dispose();
    };
  }, [gestures]);

  const showHeading = useCallback((h: number) => {
    const n = normHeading(h);
    if (headingGap(n, camHeadingRef.current) <= 1) return;
    camHeadingRef.current = n;
    setCamHeading(n);
  }, []);

  /** Caméra de guidage : chauffeur un peu sous le centre, carte tournée dans son sens de marche. */
  const navCamera = useCallback((duration: number) => {
    const { me } = latest.current;
    if (!me) return;
    lastNavCamera.current = Date.now();
    const heading = me.heading ?? camHeadingRef.current;
    const z = navZoom(me.speed ?? null);
    const metersPerPx = (156_543.03 * Math.cos((me.lat * Math.PI) / 180)) / 2 ** z;
    const center = ahead(me, heading, size.current.height * NAV_LOOK_AHEAD * metersPerPx);
    ref.current?.animateCamera({ center, heading, zoom: z, altitude: altitudeFor(z), pitch: 0 }, { duration });
    showHeading(heading);
  }, [showHeading]);

  const frame = useCallback(() => {
    const { me, pickup, dropoff, routeCoords, focus, padding, zoom, navigation } = latest.current;
    // Bilan de geste en attente sans objet : l'app recadre la carte
    gestures.drop();
    frameAt.current = Date.now();
    if (navigation && me && !focus) {
      navCamera(600);
      return;
    }
    if (focus) {
      ref.current?.animateCamera({ center: toLL(focus), zoom, altitude: altitudeFor(zoom), pitch: 0 }, { duration: 600 });
      return;
    }
    const pts = [...(routeCoords ?? [])];
    if (pickup) pts.push(toLL(pickup));
    if (dropoff) pts.push(toLL(dropoff));
    if (me && (pickup || dropoff)) pts.push(toLL(me));
    if (pts.length > 1) {
      // Vue d'ensemble de la course (fin du guidage comprise) : nord en haut avant de cadrer
      if (!isNorthUp(camHeadingRef.current)) {
        camHeadingRef.current = 0;
        setCamHeading(0);
        ref.current?.setCamera({ heading: 0 });
      }
      ref.current?.fitToCoordinates(pts, { edgePadding: padding, animated: true });
    } else if (me) {
      // Chauffeur seul, à l'échelle de la rue ; orientation choisie à deux doigts conservée (boussole pour le nord)
      ref.current?.animateCamera({ center: toLL(me), zoom, altitude: altitudeFor(zoom), pitch: 0 }, { duration: 600 });
    }
  }, [navCamera, gestures]);

  /** Retour sur le chauffeur sans changer le zoom ni l'orientation choisis (guidage : caméra de navigation). */
  const resume = useCallback(() => {
    const { me, navigation } = latest.current;
    gestures.drop();
    followRef.current = true;
    setFollow(true);
    if (!me) return;
    frameAt.current = Date.now();
    if (navigation) navCamera(600);
    else ref.current?.animateCamera({ center: toLL(me) }, { duration: 600 });
  }, [navCamera, gestures]);

  /** Boussole : nord en haut, même centre et même zoom. */
  const northUp = useCallback(() => {
    frameAt.current = Date.now();
    camHeadingRef.current = 0;
    setCamHeading(0);
    ref.current?.animateCamera({ heading: 0 }, { duration: 400 });
  }, []);

  // Cadrage : signalement ciblé, course (tracé + points), sinon le chauffeur à l'échelle de la rue
  useEffect(() => {
    setFollow(true);
    frame();
  }, [key, frame]);

  // Suivi : la carte accompagne le chauffeur, jamais pendant un geste. Guidage : position, cap et zoom
  useEffect(() => {
    if (!follow || !me || focus || !navigation || gestures.busy) return;
    if (Date.now() - lastNavCamera.current >= NAV_CAMERA_MS) navCamera(900);
  }, [follow, me?.lat, me?.lng, me?.heading, focus, navigation, navCamera]);
  // Hors guidage : centre seulement, zoom et orientation choisis conservés (un changement de cap, boussole comprise,
  // ne bouge pas la carte)
  useEffect(() => {
    if (!follow || !me || focus || navigation || framed || gestures.busy) return;
    // Cadrage en cours (Recentrer, boussole, reprise) : il place déjà la carte
    if (Date.now() - frameAt.current < FRAME_MS) return;
    ref.current?.animateCamera({ center: toLL(me) }, { duration: 500 });
  }, [follow, me?.lat, me?.lng, framed, focus, navigation]);

  /** Orientation réelle de la carte (rotation à deux doigts, cap refusé) : flèche du chauffeur et boussole justes. */
  const refreshHeading = useCallback((force: boolean) => {
    const now = Date.now();
    if (!force && now - headingAt.current < HEADING_REFRESH_MS) return;
    headingAt.current = now;
    ref.current
      ?.getCamera()
      .then((c) => {
        if (alive.current) showHeading(c.heading ?? 0);
      })
      .catch(() => null);
  }, [showHeading]);

  const onTouchStart = useCallback(() => gestures.touchStart(), [gestures]);
  const onTouchEnd = useCallback((e: GestureResponderEvent) => gestures.touchEnd(e.nativeEvent.touches?.length ?? 0), [gestures]);
  const onPanDrag = useCallback(() => gestures.panDrag(), [gestures]);

  const onRegionChange = useCallback((_region: Region, details?: Details) => {
    // iOS : les animations de l'app n'émettent rien, tout mouvement vient du chauffeur ou de la carte elle-même (double
    // appui) ; Android : isGesture
    const gesture = Platform.OS === "ios" || details?.isGesture === true;
    gestures.regionChange(gesture);
    if (gesture) refreshHeading(false);
  }, [gestures, refreshHeading]);

  const onRegionChangeComplete = useCallback(() => {
    refreshHeading(true);
    gestures.regionChangeComplete();
  }, [gestures, refreshHeading]);

  // Chaque seconde : geste resté sans fin (contact perdu) ; retour automatique sur le chauffeur quand il roule et
  // ne touche plus la carte (accueil et guidage ; une course cadrée ou un signalement ouvert restent où ils sont)
  useEffect(() => {
    const t = setInterval(() => {
      gestures.tick();
      if (followRef.current || gestures.busy) return;
      const { me, navigation, framed, focus } = latest.current;
      if (!me || !(navigation || (!framed && !focus))) return;
      if (shouldAutoRecenter(me, gestures.lastTouchAt, Date.now())) resume();
    }, 1000);
    return () => clearInterval(t);
  }, [gestures, resume]);

  const accuracy = me?.accuracy ?? null;
  const showCompass = !navigation && !isNorthUp(camHeading);
  const showRecenter = !follow && (me != null || framed);
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        size.current = { width, height };
      }}
    >
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_DEFAULT}
        customMapStyle={darkMap}
        userInterfaceStyle="dark"
        showsCompass={false}
        showsPointsOfInterests={false}
        toolbarEnabled={false}
        // Carte à plat, lisible d'un coup d'œil au volant. Rotation à deux doigts partout (boussole pour revenir au
        // nord) ; en guidage, la carte tourne d'elle-même dans le sens de marche
        pitchEnabled={false}
        rotateEnabled
        showsBuildings={false}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onPanDrag={onPanDrag}
        onRegionChange={onRegionChange}
        onRegionChangeComplete={onRegionChangeComplete}
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
      {/* Commandes de la carte, au-dessus des panneaux : boussole (carte tournée), puis « Recentrer » au plus près du pouce */}
      {(showCompass || showRecenter) && (
        <View style={[styles.controls, { bottom: controlsBottom }]} pointerEvents="box-none">
          {showCompass && (
            <Pressable
              onPress={northUp}
              style={({ pressed }) => [styles.control, { opacity: pressed ? 0.8 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Remettre le nord en haut"
              hitSlop={6}
            >
              <CompassNeedle heading={camHeading} />
            </Pressable>
          )}
          {showRecenter && (
            <Pressable
              onPress={() => {
                setFollow(true);
                frame();
              }}
              style={({ pressed }) => [styles.control, { opacity: pressed ? 0.8 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={navigation ? "Reprendre le guidage" : "Recentrer la carte"}
              hitSlop={6}
            >
              <Ionicons name={navigation ? "navigate" : "locate"} size={22} color={colors.fg} />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

/** Carte (mémorisée : pas de nouveau rendu natif quand l'écran parent se redessine pour autre chose). */
export const RydarMap = memo(RydarMapImpl);

const styles = StyleSheet.create({
  pickup: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.brand, borderWidth: 5, borderColor: "#0b0d10" },
  dropoff: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.fg, borderWidth: 4, borderColor: "#0b0d10" },
  controls: { position: "absolute", right: 16, alignItems: "center", gap: 12 },
  control: {
    width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(17,19,24,0.94)", borderWidth: 1, borderColor: colors.lineStrong,
  },
  reportWrap: { alignItems: "center", paddingTop: 4, paddingHorizontal: 4 },
  report: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  reportSelected: { transform: [{ scale: 1.18 }], backgroundColor: colors.surface3 },
  reportTip: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 7, borderLeftColor: "transparent", borderRightColor: "transparent", marginTop: -1 },
});
