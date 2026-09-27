import {
  buildNavTrack, decodePolyline, haversine, locateOnTrack, maneuverGlyph, nextManeuver, remainingTrack, snapForDisplay,
  type Coord, type LatLng, type ManeuverGlyph, type NavTrack,
} from "@rydar/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchDriverRoute } from "@/lib/api";
import type { MyPosition } from "./use-my-position";

/** Écart au tracé (m) au-delà duquel le chauffeur a quitté l'itinéraire (s'y ajoute l'imprécision du point, 20 m au plus). */
const OFF_ROUTE_M = 30;
/** Points hors itinéraire consécutifs avant un recalcul (un point GPS isolé ne suffit pas). */
const OFF_ROUTE_FIXES = 2;
/** Délai minimal entre deux calculs d'itinéraire. */
const REROUTE_MIN_MS = 10_000;
/** Recalcul périodique (durée restante mise à jour avec le trafic quand le fournisseur le permet). */
const REFRESH_MS = 3 * 60_000;
/** Distance à la cible sous laquelle on annonce l'arrivée. */
const ARRIVED_M = 30;
/** Deux manœuvres plus proches que cette distance : la seconde est annoncée (« Puis… »). */
const THEN_M = 120;
/** Itinéraire calculé depuis un point imprécis (au-delà) : recalculé dès qu'un point précis (≤ 20 m) arrive. */
const ROUGH_START_M = 40;

type Loaded = { track: NavTrack; durationS: number; target: string; at: number; fromAccuracy: number | null };

export type NavNext = { glyph: ManeuverGlyph; instruction: string; exit: number | null; distance: number };

export type Navigation = {
  /** Tracé restant [lng, lat][] depuis la position du chauffeur (null : pas d'itinéraire calculé) */
  route: Coord[] | null;
  /** Prochaine manœuvre */
  next: NavNext | null;
  /** Manœuvre qui suit de près la prochaine */
  then: ManeuverGlyph | null;
  /** Distance et durée restantes par la route */
  remainingM: number | null;
  remainingS: number | null;
  /** Chauffeur sorti de l'itinéraire : nouveau calcul en cours */
  rerouting: boolean;
  /**
   * Position à afficher, posée sur la route suivie quand le chauffeur y est vraiment (12 à 20 m, dans le sens du
   * tronçon) ; null sinon : la vraie position GPS est affichée (jamais la rue voisine).
   */
  position: { lat: number; lng: number; heading: number | null } | null;
};

/** Sur l'itinéraire : écart au tracé dans la marge (30 m + imprécision du point, 20 m au plus). */
const onRoute = (off: number, accuracy: number | null) => off <= OFF_ROUTE_M + Math.min(accuracy ?? 0, 20);

const EMPTY: Navigation = { route: null, next: null, then: null, remainingM: null, remainingS: null, rerouting: false, position: null };
const keyOf = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * Guidage dans l'app : itinéraire routier vers la cible (prise en charge puis destination), position sur le tracé,
 * prochaine manœuvre, distance et durée restantes ; nouveau calcul quand le chauffeur quitte l'itinéraire.
 * Sans serveur d'itinéraire (ou hors réseau) : rien, l'écran garde le tracé de la course et l'estimation.
 */
export function useNavigation(me: MyPosition | null, target: LatLng | null, enabled: boolean): Navigation {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [offCount, setOffCount] = useState(0);
  const targetKey = target ? keyOf(target) : null;
  const latest = useRef({ me, target });
  latest.current = { me, target };
  const hint = useRef(0);
  const lastFetch = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  const request = useRef(async () => {
    const { me: from, target: to } = latest.current;
    if (!from || !to) return;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    lastFetch.current = Date.now();
    const r = await fetchDriverRoute(from, to, ctrl.signal);
    if (ctrl.signal.aborted || inflight.current !== ctrl) return;
    inflight.current = null;
    // Estimation à vol d'oiseau (aucun fournisseur) : pas de guidage, le tracé de la course reste affiché
    if (!r || r.approximate) return;
    const coords = decodePolyline(r.polyline);
    if (coords.length < 2) return;
    hint.current = 0;
    setOffCount(0);
    setLoaded({ track: buildNavTrack(coords, r.steps), durationS: r.durationS, target: keyOf(to), at: Date.now(), fromAccuracy: from.accuracy });
  }).current;

  // Premier calcul, puis à chaque changement de cible (prise en charge → destination)
  const hasMe = me != null;
  useEffect(() => {
    if (!enabled || !targetKey || !hasMe) return;
    void request();
    return () => {
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [enabled, targetKey, hasMe, request]);

  const current = loaded && loaded.target === targetKey ? loaded : null;
  const pos = useMemo(() => {
    if (!current || !me) return null;
    const p = locateOnTrack(current.track, me, hint.current);
    if (p) hint.current = p.index;
    return p;
  }, [current, me]);

  // Sortie d'itinéraire (plusieurs points de suite) : nouveau calcul ; sinon recalcul périodique
  useEffect(() => {
    if (!enabled || !current || !pos || !me) return;
    const off = !onRoute(pos.off, me.accuracy);
    const count = off ? offCount + 1 : 0;
    if (count !== offCount) setOffCount(count);
    const since = Date.now() - lastFetch.current;
    if (count >= OFF_ROUTE_FIXES) {
      if (since > REROUTE_MIN_MS) void request();
      else {
        // Calcul récent : nouvel essai à la fin du délai, même si le GPS n'envoie plus de point (chauffeur arrêté)
        const t = setTimeout(() => void request(), REROUTE_MIN_MS - since);
        return () => clearTimeout(t);
      }
    } else if (
      // Départ calculé depuis un point imprécis (Wi-Fi, premier point) : recalcul dès qu'un point précis arrive
      current.fromAccuracy != null && current.fromAccuracy > ROUGH_START_M && me.accuracy != null && me.accuracy <= 20 && since > 3000
    ) {
      void request();
    } else if (Date.now() - current.at > REFRESH_MS && since > REFRESH_MS) void request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, enabled]);

  return useMemo(() => {
    if (!enabled || !current || !pos || !me) return EMPTY;
    const t = current.track;
    const remainingM = Math.max(0, t.total - pos.along);
    const remainingS = t.total > 0 ? Math.round((current.durationS * remainingM) / t.total) : null;
    const arrived = target != null && haversine(me, target) < ARRIVED_M;
    const n = arrived ? null : nextManeuver(t, pos.along);
    const step = n?.step;
    const following = n ? t.steps[n.index + 1] : undefined;
    return {
      route: remainingTrack(t, pos),
      next: arrived
        ? { glyph: "arrive", instruction: "Vous êtes arrivé", exit: null, distance: 0 }
        : step
          ? { glyph: maneuverGlyph(step), instruction: step.instruction, exit: step.exit ?? null, distance: n.distance }
          : null,
      then: step && following && following.along - step.along < THEN_M ? maneuverGlyph(following) : null,
      remainingM: Math.round(remainingM),
      remainingS,
      rerouting: offCount >= OFF_ROUTE_FIXES,
      position: snapForDisplay(t, pos, me),
    };
  }, [enabled, current, pos, me, target, offCount]);
}
