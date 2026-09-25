import { formatDistance, type DriverHome, type DriverOffer } from "@rydar/shared";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Vibration } from "react-native";
import { api } from "@/lib/api";
import { locationPermissionState, MAX_ACCURACY_M, requestLocationPermissions, startTracking, stopTracking, type TrackingResult } from "@/lib/location";
import { dismissClosedOfferNotifications, presentedOfferNotifications, registerForPush, setupNotificationChannels, unregisterPush } from "@/lib/notifications";
import { offerSession } from "@/lib/offer-session";
import { supabase } from "@/lib/supabase";

export type OnlineResult = { ok: boolean; message?: string; code?: "coarse" | "imprecise" };

type Ctx = {
  session: Session | null;
  ready: boolean;
  home: DriverHome | null;
  offers: DriverOffer[];
  refresh: () => Promise<void>;
  setOnline: (online: boolean) => Promise<OnlineResult>;
  signOut: () => Promise<void>;
  busy: boolean;
};

/** Fenêtre (s) en deçà de laquelle une offre est traitée comme urgente (sonnerie, compte à rebours). */
export const URGENT_OFFER_S = 120;

/** Offre à traiter tout de suite : dispatch GPS, ou fenêtre courte (course planifiée proche). */
export function isUrgentOffer(o: Pick<DriverOffer, "mode" | "sent_at" | "expires_at">) {
  if (o.mode === "geo") return true;
  if (!o.expires_at) return false;
  return new Date(o.expires_at).getTime() - new Date(o.sent_at).getTime() <= URGENT_OFFER_S * 1000;
}

/** Pourquoi la position approximative empêche de recevoir des courses (passage en ligne et redémarrage). */
const COARSE_MESSAGE =
  "Les courses sont proposées aux chauffeurs situés à 4 km, puis 8 km du client : avec une position approximative, vous ne pouvez pas en recevoir. Dans les réglages de Rydar Drive › Position, activez la position exacte.";

const DriverContext = createContext<Ctx | null>(null);

export function DriverProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [home, setHome] = useState<DriverHome | null>(null);
  const [offers, setOffers] = useState<DriverOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const seenOffers = useRef(new Set<string>());
  const handledResponses = useRef(new Set<string>());
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const openOffer = useCallback((offer: DriverOffer) => {
    if (seenOffers.current.has(offer.offer_id)) return;
    seenOffers.current.add(offer.offer_id);
    if (offerSession.openId === offer.offer_id) return;
    if (isUrgentOffer(offer)) router.push({ pathname: "/offer/[id]", params: { id: offer.offer_id } });
    else Vibration.vibrate([0, 200, 120, 200]);
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    // Relevé des notifications AVANT la lecture des offres (cf. dismissClosedOfferNotifications)
    const presented = await presentedOfferNotifications();
    const [h, o] = await Promise.all([api.home().catch(() => null), api.offers().catch(() => null)]);
    if (h) setHome(h);
    if (o) {
      setOffers(o);
      // Offre flotte à fenêtre courte : ouverte aussi, sauf en pleine course (la flotte entière la reçoit)
      const onRide = Boolean(h?.driver.current_ride_id);
      const fresh = o.find((x) => !seenOffers.current.has(x.offer_id) && (x.mode === "geo" || (!onRide && isUrgentOffer(x))));
      if (fresh) openOffer(fresh);
      void dismissClosedOfferNotifications(presented, new Set(o.map((x) => x.offer_id)));
    }
  }, [session, openOffer]);

  // Initialisation après connexion : canaux, push, données, temps réel
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      await setupNotificationChannels().catch(() => null);
      await registerForPush().catch(() => null);
      await refresh();
      const h = await api.home().catch(() => null);
      if (cancelled || !h) return;
      if (h.driver.presence !== "offline") {
        // Déjà en ligne au redémarrage : la position exacte a pu être retirée entre-temps dans les réglages
        const perm = await locationPermissionState();
        if (perm === "ok") startTracking().catch(() => null);
        else {
          await api.setOnline(false).catch(() => null);
          await refresh();
          Alert.alert(
            perm === "coarse" ? "Position exacte désactivée" : "Localisation désactivée",
            perm === "coarse" ? `Vous êtes passé hors ligne. ${COARSE_MESSAGE}` : "Vous êtes passé hors ligne : autorisez la localisation pour recevoir des courses.",
          );
        }
      }
      await supabase.realtime.setAuth(session.access_token);
      const ch = supabase.channel(`driver:${h.driver.id}`, { config: { private: true } });
      ch.on("broadcast", { event: "offer.updated" }, () => void refresh())
        .on("broadcast", { event: "ride.updated" }, () => void refresh())
        .on("broadcast", { event: "ride.unassigned" }, () => void refresh())
        .on("broadcast", { event: "driver.updated" }, () => void refresh())
        .subscribe();
      channelRef.current = ch;
    })();
    return () => {
      cancelled = true;
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    };
  }, [session, refresh]);

  // Repli : rafraîchissement périodique quand l'app est active et le chauffeur en ligne
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      if (AppState.currentState === "active" && home?.driver.presence !== "offline") void refresh();
    }, 8000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [session, home?.driver.presence, refresh]);

  // Réponse à une notification (ACCEPTER / Refuser / ouverture) — écouteur ou démarrage à froid
  const handleResponse = useCallback(async (r: Notifications.NotificationResponse) => {
    const key = `${r.notification.request.identifier}:${r.actionIdentifier}`;
    if (handledResponses.current.has(key)) return;
    handledResponses.current.add(key);
    if (Platform.OS !== "web") {
      try {
        Notifications.clearLastNotificationResponse();
      } catch {
        /* module indisponible */
      }
    }
    const data = (r.notification.request.content.data ?? {}) as Record<string, unknown>;
    const offerId = data.offer_id ? String(data.offer_id) : null;
    if (offerId) seenOffers.current.add(offerId); // pas de seconde ouverture par refresh()
    if (r.actionIdentifier === "ACCEPT" && offerId) {
      const res = await api.accept(offerId).catch(() => null);
      if (res?.ok) offerSession.accepted.add(offerId);
      await refresh();
      if (!res) router.push({ pathname: "/offer/[id]", params: { id: offerId } }); // réseau : réessai depuis l'offre
      else if (!res.ok) Alert.alert(res.code === "OFFER_EXPIRED" ? "Offre expirée" : "Course indisponible", res.message ?? "Course déjà attribuée.");
      else if (data.ride_type === "instant" && res.ride_id) router.push({ pathname: "/ride/[id]", params: { id: String(res.ride_id) } });
      else {
        // Course planifiée (offre flotte ou GPS à l'approche) : direction le planning
        router.push("/planning");
        Alert.alert("Course attribuée", "Ajoutée à votre planning. Rappels programmés.");
      }
      return;
    }
    if (r.actionIdentifier === "DECLINE" && offerId) {
      await api.decline(offerId).catch(() => null);
      void refresh();
      return;
    }
    if (offerId) {
      await refresh();
      // Bannière touchée alors que l'offre est déjà à l'écran : rien à ouvrir
      if (offerSession.openId !== offerId) router.push({ pathname: "/offer/[id]", params: { id: offerId } });
    } else if (data.ride_id) router.push({ pathname: "/ride/[id]", params: { id: String(data.ride_id) } });
  }, [refresh]);

  // Notifications : réception au premier plan + actions
  useEffect(() => {
    if (!session) return;
    const received = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as Record<string, any>;
      if (data?.type === "ride_offer" || data?.type === "ride_offer_scheduled") void refresh();
      if (data?.type === "ride_cancelled" || data?.type === "ride_assigned" || data?.type === "ride_unassigned") void refresh();
    });
    const response = Notifications.addNotificationResponseReceivedListener((r) => void handleResponse(r).catch(() => null));
    // Démarrage à froid (tap sur ACCEPTER, app fermée) : la réponse précède l'écouteur
    if (Platform.OS !== "web") {
      try {
        const last = Notifications.getLastNotificationResponse();
        if (last) void handleResponse(last).catch(() => null);
      } catch {
        /* module indisponible */
      }
    }
    return () => {
      received.remove();
      response.remove();
    };
  }, [session, refresh, handleResponse]);

  const setOnline = useCallback(async (online: boolean): Promise<OnlineResult> => {
    setBusy(true);
    try {
      if (online) {
        // 1. autorisations (position exacte exigée) → 2. EN LIGNE serveur → 3. suivi, premier point forcé
        const perm = await requestLocationPermissions();
        if (perm === "denied") return { ok: false, message: "Autorisez la localisation pour passer en ligne." };
        if (perm === "coarse") return { ok: false, code: "coarse", message: COARSE_MESSAGE };
        const res = await api.setOnline(true);
        if (!res.ok) {
          await refresh();
          return { ok: false, message: res.message };
        }
        let track: TrackingResult;
        try {
          track = await startTracking();
        } catch (e) {
          // Aucun suivi possible : on ne reste pas EN LIGNE sans position
          await api.setOnline(false).catch(() => null);
          await refresh();
          return { ok: false, message: (e as Error).message };
        }
        await refresh();
        if (track.accuracyM != null && track.accuracyM > MAX_ACCURACY_M) {
          return {
            ok: true,
            code: "imprecise",
            message: `Votre position n'est connue qu'à ${formatDistance(track.accuracyM)} près : au-delà de 1,5 km, elle n'est pas utilisée pour vous proposer des courses. Activez le GPS (haute précision) et patientez à découvert.`,
          };
        }
        if (!track.background) return { ok: true, message: "Position partagée uniquement quand l'application est ouverte." };
        return { ok: true, message: perm === "foreground-only" ? "Autorisez « Toujours » la localisation pour rester en ligne application fermée." : undefined };
      }
      const res = await api.setOnline(false);
      if (res.ok) await stopTracking();
      await refresh();
      return { ok: res.ok, message: res.message };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.setOnline(false).catch(() => null);
    await stopTracking().catch(() => null);
    await unregisterPush();
    await supabase.auth.signOut();
    setHome(null);
    setOffers([]);
    seenOffers.current.clear();
  }, []);

  const value = useMemo(() => ({ session, ready, home, offers, refresh, setOnline, signOut, busy }), [session, ready, home, offers, refresh, setOnline, signOut, busy]);
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriver() {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error("useDriver hors DriverProvider");
  return ctx;
}
