// Position du chauffeur sur la carte native (iOS : Apple Plans, Android : Google Maps).
import { memo, useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Marker } from "react-native-maps";
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from "react-native-svg";
import { useStillHeading } from "@/hooks/use-my-position";
import {
  BEAM_GRADIENT, BEAM_PATH, BEAM_STOPS, DOT, ME_BLUE, ME_SHADOW, ME_SIZE, ME_WHITE, NAV_PATH, NAV_STROKE, meLabel, meMode,
  type MeMode,
} from "./me-marker-shape";

/**
 * Dessin pointé vers le nord, tourné DANS le SVG autour du centre du point (rotation en degrés).
 * Jamais de transformation sur la vue du marqueur : sur iPhone, react-native-maps (AIRMapMarker.m, layoutSubviews)
 * prend le cadre de la vue tournée — plus grand — pour taille du marqueur et décale le point de sa vraie position
 * (en haut à gauche, jusqu'à ~20 px à 45°) : le point semblait « bouger » en zoomant.
 */
const MeGlyph = memo(function MeGlyph({ mode, rotation }: { mode: MeMode; rotation: number }) {
  const dot = (
    <>
      <Circle cx={DOT.cx} cy={DOT.cy} r={DOT.shadow} fill={ME_SHADOW} />
      <Circle cx={DOT.cx} cy={DOT.cy} r={DOT.r} fill={ME_WHITE} />
      <Circle cx={DOT.cx} cy={DOT.cy} r={DOT.inner} fill={ME_BLUE} />
    </>
  );
  return (
    <Svg width={ME_SIZE} height={ME_SIZE} viewBox={`0 0 ${ME_SIZE} ${ME_SIZE}`}>
      <G rotation={rotation} origin={`${DOT.cx}, ${DOT.cy}`}>
      {mode === "nav" ? (
        <>
          <Path d={NAV_PATH} fill="none" stroke={ME_SHADOW} strokeWidth={NAV_STROKE + 3} strokeLinejoin="round" />
          <Path d={NAV_PATH} fill={ME_BLUE} stroke={ME_WHITE} strokeWidth={NAV_STROKE} strokeLinejoin="round" />
        </>
      ) : (
        <>
          {mode === "beam" && (
            <>
              <Defs>
                <RadialGradient id="meBeam" gradientUnits="userSpaceOnUse" cx={BEAM_GRADIENT.cx} cy={BEAM_GRADIENT.cy} r={BEAM_GRADIENT.r}>
                  {BEAM_STOPS.map((s) => (
                    <Stop key={s.offset} offset={s.offset} stopColor={ME_BLUE} stopOpacity={s.opacity} />
                  ))}
                </RadialGradient>
              </Defs>
              <Path d={BEAM_PATH} fill="url(#meBeam)" />
            </>
          )}
          {dot}
        </>
      )}
      </G>
    </Svg>
  );
});

type MeMarkerViewProps = { lat: number; lng: number; mode: MeMode; dir: number | null; mapHeading: number; label: string };

function MeMarkerView({ lat, lng, mode, dir, mapHeading, label }: MeMarkerViewProps) {
  const ios = Platform.OS === "ios";
  // Android : la vue est rendue en image ; suivie un court instant, le temps que le SVG se dessine (sinon image vide).
  // Le cap ne change ensuite que la rotation native du marqueur, sans nouvelle image.
  const [track, setTrack] = useState(!ios);
  useEffect(() => {
    if (ios) return;
    const t = setTimeout(() => setTrack(false), 800);
    return () => clearTimeout(t);
  }, [ios]);
  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      // Rotation native réservée à Google Maps (Android : marqueur à plat, cap par rapport au nord) ;
      // sur iPhone le dessin tourne dans le SVG (cap moins orientation de la carte), la vue reste fixe
      flat={!ios}
      rotation={!ios && dir != null ? dir : undefined}
      tracksViewChanges={ios || track}
      zIndex={40}
      accessibilityLabel={label}
    >
      {/* Taille fixe, sans transformation (voir MeGlyph) : le centre de la vue = la position GPS */}
      <View style={styles.wrap}>
        <MeGlyph mode={mode} rotation={ios && dir != null ? Math.round(dir - mapHeading) : 0} />
      </View>
    </Marker>
  );
}

/**
 * Position du chauffeur : point bleu à bord blanc et faisceau d'orientation (sens du véhicule : cap de marche en
 * roulant, boussole à l'arrêt) ; en guidage, flèche de navigation. mapHeading : orientation de la carte.
 */
export function MeMarker({
  me, mapHeading, navigation,
}: {
  me: { lat: number; lng: number; heading?: number | null };
  mapHeading: number;
  navigation: boolean;
}) {
  // Hors guidage, à l'arrêt : boussole en continu (flux à part, seul ce marqueur se redessine) ; en guidage, cap de la
  // position (route suivie, sens de la marche)
  const still = useStillHeading(!navigation);
  const heading = still ?? me.heading ?? null;
  const mode = meMode(heading, navigation);
  // Guidage sans cap connu : flèche dans l'axe de la carte (elle-même tournée selon le dernier cap)
  const dir = heading ?? (mode === "nav" ? mapHeading : null);
  // Nouveau marqueur quand le dessin change (Android : nouvelle image)
  return <MeMarkerView key={mode} lat={me.lat} lng={me.lng} mode={mode} dir={dir} mapHeading={mapHeading} label={meLabel(heading)} />;
}

const styles = StyleSheet.create({
  wrap: { width: ME_SIZE, height: ME_SIZE },
});
