import { formatDistance, type DriverChatOverview, type DriverHome, type DriverOffer } from "@rydar/shared";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Vibration } from "react-native";
import { api } from "@/lib/api";
import { chatSession } from "@/lib/chat-session";
import { appEvents } from "@/lib/events";
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
  /** Messagerie (centrale + flotte) et signalements actifs — driver_chat_overview, tenu à jour en temps réel. */
  chat: DriverChatOverview | null;
  /** Relecture immédiate de la messagerie (après un envoi, un vote, une lecture). */
  refreshChat: () => Promise<void>;
};

/** Valeur numérique d'une donnée de notification (FCM/APNs transportent des chaînes). */
const num = (v: unknown) => (v == null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

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
  const [chat, setChat] = useState<DriverChatOverview | null>(null);
  const seenOffers = useRef(new Set<string>());
  const handledResponses = useRef(new Set<string>());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const fleetChannelRef = useRef<RealtimeChannel | null>(null);
  const chatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Messagerie : une lecture complète (30 derniers messages par fil + signalements actifs) par rafale d'événements
  const refreshChat = useCallback(async () => {
    if (!session) return;
    const c = await api.chatOverview().catch(() => null);
    if (c) setChat(c);
  }, [session]);
  const scheduleChat = useCallback(() => {
    if (chatTimer.current) return;
    chatTimer.current = setTimeout(() => {
      chatTimer.current = null;
      void refreshChat();
    }, 250);
  }, [refreshChat]);

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
      void refreshChat();
      await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;
      const ch = supabase.channel(`driver:${h.driver.id}`, { config: { private: true } });
      ch.on("broadcast", { event: "offer.updated" }, () => void refresh())
        .on("broadcast", { event: "ride.updated" }, (m) => {
          void refresh();
          // Vol retardé, prise en charge décalée… : l'écran de course ouvert se relit tout de suite
          appEvents.emit("ride", (m.payload as { id?: string } | undefined)?.id);
        })
        .on("broadcast", { event: "ride.unassigned" }, (m) => {
          void refresh();
          appEvents.emit("ride", (m.payload as { id?: string; ride_id?: string } | undefined)?.ride_id ?? (m.payload as { id?: string } | undefined)?.id);
        })
        .on("broadcast", { event: "driver.updated" }, () => void refresh())
        // Fil direct avec la centrale : nouveaux messages et accusés de lecture (« Vu »)
        .on("broadcast", { event: "chat.message" }, scheduleChat)
        .on("broadcast", { event: "chat.read" }, scheduleChat)
        // Documents : validation, refus, échéance
        .on("broadcast", { event: "driver.document" }, () => appEvents.emit("documents"))
        .subscribe();
      channelRef.current = ch;
      // Fil de la flotte (messages + signalements, votes « toujours là ») : topic privé fleet:<org>
      const fleet = supabase.channel(`fleet:${h.organization.id}`, { config: { private: true } });
      fleet
        .on("broadcast", { event: "chat.message" }, scheduleChat)
        .on("broadcast", { event: "chat.report" }, scheduleChat)
        .subscribe();
      fleetChannelRef.current = fleet;
    })();
    return () => {
      cancelled = true;
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      if (fleetChannelRef.current) void supabase.removeChannel(fleetChannelRef.current);
      channelRef.current = null;
      fleetChannelRef.current = null;
    };
  }, [session, refresh, refreshChat, scheduleChat]);

  // Messagerie : repli périodique (le temps réel peut manquer un message) et relecture au retour au premier plan
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      if (AppState.currentState === "active") void refreshChat();
    }, 30_000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refreshChat());
    return () => {
      clearInterval(id);
      sub.remove();
      if (chatTimer.current) clearTimeout(chatTimer.current);
      chatTimer.current = null;
    };
  }, [session, refreshChat]);

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
    const type = typeof data.type === "string" ? data.type : "";
    // Messagerie, signalements, vols, documents, course retirée : chaque notification ouvre son écran
    if (!offerId) {
      if (type === "chat_message") {
        void refreshChat();
        if (chatSession.openThread) appEvents.emit("messages:tab", "dispatch");
        else router.push({ pathname: "/messages", params: { tab: "dispatch" } });
        return;
      }
      if (type === "fleet_report" && data.message_id) {
        void refreshChat();
        const focus = { id: String(data.message_id), lat: num(data.lat), lng: num(data.lng) };
        router.dismissTo({ pathname: "/home", params: { report: focus.id } });
        appEvents.emit("report:focus", focus);
        return;
      }
      if (type === "flight_update" && data.ride_id) {
        void refresh();
        appEvents.emit("ride", String(data.ride_id));
        router.push({ pathname: "/ride/[id]", params: { id: String(data.ride_id) } });
        return;
      }
      if (type.startsWith("document_")) {
        appEvents.emit("documents");
        router.push("/documents");
        return;
      }
      if (type === "ride_unassigned") {
        await refresh();
        router.dismissTo("/home");
        return;
      }
    }
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
  }, [refresh, refreshChat]);

  // Notifications : réception au premier plan + actions
  useEffect(() => {
    if (!session) return;
    const received = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as Record<string, any>;
      const type = typeof data?.type === "string" ? (data.type as string) : "";
      if (type === "ride_offer" || type === "ride_offer_scheduled") void refresh();
      if (type === "ride_cancelled" || type === "ride_assigned" || type === "ride_unassigned") void refresh();
      // Au premier plan : écrans à jour sans attendre le temps réel (la bannière est tue si le fil est ouvert)
      if (type === "chat_message" || type === "fleet_report") scheduleChat();
      if (type === "flight_update") {
        void refresh();
        appEvents.emit("ride", data?.ride_id ? String(data.ride_id) : undefined);
      }
      if (type.startsWith("document_")) appEvents.emit("documents");
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
  }, [session, refresh, handleResponse, scheduleChat]);

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
    setChat(null);
    seenOffers.current.clear();
  }, []);

  const value = useMemo(
    () => ({ session, ready, home, offers, refresh, setOnline, signOut, busy, chat, refreshChat }),
    [session, ready, home, offers, refresh, setOnline, signOut, busy, chat, refreshChat],
  );
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriver() {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error("useDriver hors DriverProvider");
  return ctx;
}
