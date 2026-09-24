// Carte native (iOS : Apple Plans, Android : Google Maps) en style sombre Rydar.
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { colors } from "@/theme";
import { RadarPulse } from "../radar";
import type { RydarMapProps } from "./types";

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

export function RydarMap({ me, pickup, dropoff, route, dim, pulse, padding = { top: 80, bottom: 80, left: 50, right: 50 }, zoom = 15 }: RydarMapProps) {
  const ref = useRef<MapView>(null);
  const key = `${pickup?.lat},${dropoff?.lat},${route?.length ?? 0},${me ? 1 : 0}`;

  useEffect(() => {
    const pts = [...(route ?? []).map(([lng, lat]) => ({ latitude: lat, longitude: lng }))];
    if (pickup) pts.push(toLL(pickup));
    if (dropoff) pts.push(toLL(dropoff));
    if (me && (pickup || dropoff)) pts.push(toLL(me));
    if (pts.length > 1) ref.current?.fitToCoordinates(pts, { edgePadding: padding, animated: true });
    else if (me) ref.current?.animateCamera({ center: toLL(me), zoom }, { duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

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
        initialRegion={me ? { ...toLL(me), latitudeDelta: 0.02, longitudeDelta: 0.02 } : { latitude: 48.8634, longitude: 2.3488, latitudeDelta: 0.12, longitudeDelta: 0.12 }}
      >
        {route && route.length > 1 && (
          <>
            <Polyline coordinates={route.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))} strokeColor="#0b0d10" strokeWidth={9} />
            <Polyline coordinates={route.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))} strokeColor={colors.brand} strokeWidth={5} />
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
        {me && (
          <Marker coordinate={toLL(me)} anchor={{ x: 0.5, y: 0.5 }} flat rotation={me.heading ?? 0} tracksViewChanges={false}>
            <View style={styles.me}>
              <View style={styles.meArrow} />
            </View>
          </Marker>
        )}
      </MapView>
      {pulse && me && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <RadarPulse size={260} />
        </View>
      )}
      {dim && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(6,7,9,0.55)" }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  pickup: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.brand, borderWidth: 5, borderColor: "#0b0d10" },
  dropoff: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.fg, borderWidth: 4, borderColor: "#0b0d10" },
  me: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.blue, borderWidth: 4, borderColor: "#0b0d10", alignItems: "center", justifyContent: "center" },
  meArrow: { width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 8, borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: "#fff", marginTop: -2 },
});
