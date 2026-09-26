import {
  DRIVER_BLOCKER_META, formatDistance, type DriverAccountState, type DriverChatOverview, type DriverHome, type DriverOffer, type SettlementEvent,
} from "@rydar/shared";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Vibration } from "react-native";
import { api, ApiError } from "@/lib/api";
import { chatSession } from "@/lib/chat-session";
import { appEvents } from "@/lib/events";
import { locationPermissionState, MAX_ACCURACY_M, requestLocationPermissions, startTracking, stopTracking } from "@/lib/location";
import { dismissClosedOfferNotifications, presentedOfferNotifications, registerForPush, setupNotificationChannels, unregisterPush } from "@/lib/notifications";
import { offerSession } from "@/lib/offer-session";
import { settlementSession } from "@/lib/settlement-session";
import { supabase } from "@/lib/supabase";

export type OnlineResult = { ok: boolean; message?: string; code?: "coarse" | "foreground-only" };

type Ctx = {
  session: Session | null;
  /** Session lue et, si connecté, état du compte déterminé (le splash reste affiché jusque-là). */
  ready: boolean;
  home: DriverHome | null;
  offers: DriverOffer[];
  /** Relecture de l'accueil et des offres (une seule à la fois, les demandes simultanées sont regroupées). */
  refresh: () => Promise<DriverHome | null>;
  setOnline: (online: boolean) => Promise<OnlineResult>;
  signOut: () => Promise<void>;
  /** Passage en ligne / hors ligne en cours (confirmation du serveur, quelques centaines de ms). */
  busy: boolean;
  /** Messagerie (centrale + flotte) et signalements actifs — driver_chat_overview, tenu à jour en temps réel. */
  chat: DriverChatOverview | null;
  /** Relecture immédiate de la messagerie (après un envoi, un vote, une lecture). */
  refreshChat: () => Promise<void>;
  /**
   * État du compte (driver_account_state) : actif, candidature en attente, refusé, banni, suspendu…
   * null tant qu'il n'a pas pu être lu (hors ligne : le chauffeur n'est pas bloqué pour autant).
   */
  account: DriverAccountState | null;
  /** Compte utilisable pour rouler (accueil, offres, courses) ; sinon écran d'état du compte. */
  canDrive: boolean;
  /** Relit l'état du compte (écran d'attente, retour au premier plan, accès refusé par le serveur). */
  checkAccount: () => Promise<DriverAccountState | null>;
};

/** Valeur numérique d'une donnée de notification (FCM/APNs transportent des chaînes). */
const num = (v: unknown) => (v == null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Compte devenu inactif, banni ou suspendu en cours d'usage : les RPC chauffeur répondent FORBIDDEN (42501). */
const isForbidden = (e: unknown) => e instanceof ApiError && (e.code ?? "").startsWith("FORBIDDEN");

/** Relecture périodique de l'état du compte (suspension, bannissement) quand l'app est au premier plan. */
const ACCOUNT_CHECK_MS = 60_000;

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

/** Écran Commissions : rafraîchi s'il est déjà affiché, sinon ouvert. */
function openCommissions() {
  appEvents.emit("settlements", undefined);
  if (!settlementSession.open) router.push("/commissions");
}

/** Acceptation refusée (mode centrale) : commission en retard, plafond d'encours… → accès direct au règlement. */
export function alertDriverBlocked(res: { reason?: string | null; message?: string }) {
  const meta = res.reason ? DRIVER_BLOCKER_META[res.reason as keyof typeof DRIVER_BLOCKER_META] : undefined;
  const payable = res.reason !== "new_driver";
  Alert.alert("Acceptation impossible", res.message ?? meta?.message ?? "Réglez vos commissions pour accepter des courses.", [
    { text: payable ? "Plus tard" : "OK", style: "cancel" },
    ...(payable ? [{ text: "Régler mes commissions", onPress: () => router.push("/commissions") }] : []),
  ]);
}

const DriverContext = createContext<Ctx | null>(null);

export function DriverProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [account, setAccount] = useState<DriverAccountState | null>(null);
  /** Utilisateur pour lequel l'état du compte a été déterminé (lu, ou lecture impossible). */
  const [accountFor, setAccountFor] = useState<string | null>(null);
  const [home, setHome] = useState<DriverHome | null>(null);
  const [offers, setOffers] = useState<DriverOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<DriverChatOverview | null>(null);
  const seenOffers = useRef(new Set<string>());
  const handledResponses = useRef(new Set<string>());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const fleetChannelRef = useRef<RealtimeChannel | null>(null);
  const chatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userId = session?.user.id ?? null;
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;
  // Dernières données appliquées (JSON) : pas de re-rendu de toute l'app quand rien n'a changé
  const homeRef = useRef<DriverHome | null>(null);
  const homeJson = useRef("");
  const offersJson = useRef("");
  const inflight = useRef<Promise<DriverHome | null> | null>(null);
  const refreshAgain = useRef(false);
  const lastRefreshAt = useRef(0);
  /** Canal temps réel abonné : le sondage de repli ralentit */
  const liveRef = useRef(false);
  const onlinePending = useRef(false);

  const applyHome = useCallback((h: DriverHome | null) => {
    const json = h ? JSON.stringify(h) : "";
    if (json === homeJson.current) return;
    homeJson.current = json;
    homeRef.current = h;
    setHome(h);
  }, []);
  const applyOffers = useCallback((o: DriverOffer[]) => {
    const json = JSON.stringify(o);
    if (json === offersJson.current) return;
    offersJson.current = json;
    setOffers(o);
  }, []);
  /** Présence affichée tout de suite (mise en ligne optimiste), confirmée ou annulée ensuite. */
  const patchPresence = useCallback((presence: DriverHome["driver"]["presence"]) => {
    const h = homeRef.current;
    if (!h || h.driver.presence === presence) return;
    const next = { ...h, driver: { ...h.driver, presence } };
    homeRef.current = next;
    homeJson.current = "";
    setHome(next);
  }, []);

  // Session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // État du compte (actif, candidature, refus, bannissement…) — driver_account_state fonctionne même compte inactif
  const checkAccount = useCallback(async (): Promise<DriverAccountState | null> => {
    const uid = userIdRef.current;
    if (!uid) return null;
    const state = await api.accountState().catch(() => undefined); // undefined : réseau, on garde le dernier état connu
    if (uid !== userIdRef.current) return null;
    if (state !== undefined) setAccount(state);
    setAccountFor(uid);
    return state ?? null;
  }, []);

  useEffect(() => {
    setAccount(null);
    setAccountFor(null);
    if (userId) void checkAccount();
  }, [userId, checkAccount]);

  const accountChecked = userId != null && accountFor === userId;
  const ready = sessionReady && (!userId || accountChecked);
  // État illisible (hors ligne) : comportement historique, l'app reste utilisable
  const canDrive = session != null && accountChecked && (account == null || account.state === "active");
  const blockedAccount = accountChecked && account != null && account.state !== "active";

  // Compte bloqué (banni, suspendu, candidature…) : plus de suivi GPS ni de données de course
  useEffect(() => {
    if (!blockedAccount) return;
    void stopTracking().catch(() => null);
    applyHome(null);
    applyOffers([]);
  }, [blockedAccount, applyHome, applyOffers]);

  // Candidat en attente : appareil enregistré dès maintenant (push « candidature acceptée », contrôle
  // serveur « appareil déjà utilisé par un chauffeur banni »), puis relecture de l'état du compte
  const pendingAccount = accountChecked && account?.state === "pending";
  useEffect(() => {
    if (!userId || !pendingAccount) return;
    let cancelled = false;
    (async () => {
      await setupNotificationChannels().catch(() => null);
      await registerForPush().catch(() => null);
      if (!cancelled) void checkAccount();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, pendingAccount, checkAccount]);

  // Retour au premier plan : candidature validée, compte suspendu ou banni entre-temps
  useEffect(() => {
    if (!userId) return;
    const sub = AppState.addEventListener("change", (s) => s === "active" && void checkAccount());
    return () => sub.remove();
  }, [userId, checkAccount]);

  // Chauffeur actif : le canal driver:{id} n'est plus lisible dès la suspension (RLS realtime.messages →
  // current_driver_id()), le dernier « driver.updated » n'arrive donc pas. Relecture légère de l'état du compte.
  useEffect(() => {
    if (!canDrive) return;
    const id = setInterval(() => {
      if (AppState.currentState === "active") void checkAccount();
    }, ACCOUNT_CHECK_MS);
    return () => clearInterval(id);
  }, [canDrive, checkAccount]);

  const openOffer = useCallback((offer: DriverOffer) => {
    if (seenOffers.current.has(offer.offer_id)) return;
    seenOffers.current.add(offer.offer_id);
    if (offerSession.openId === offer.offer_id) return;
    if (isUrgentOffer(offer)) router.push({ pathname: "/offer/[id]", params: { id: offer.offer_id } });
    else Vibration.vibrate([0, 200, 120, 200]);
  }, []);

  const fetchOnce = useCallback(async (): Promise<DriverHome | null> => {
    if (!userIdRef.current) return null;
    // Relevé des notifications lancé AVANT la lecture des offres (cf. dismissClosedOfferNotifications),
    // en parallèle des requêtes : il se termine bien avant elles
    const presentedP = presentedOfferNotifications();
    let forbidden = false;
    const [h, o] = await Promise.all([
      api.home().catch((e: unknown) => {
        forbidden = isForbidden(e);
        return null;
      }),
      api.offers().catch(() => null),
    ]);
    const presented = await presentedP;
    lastRefreshAt.current = Date.now();
    // Compte devenu inactif en cours d'usage (banni, suspendu, désactivé) : écran d'état du compte
    if (forbidden) {
      void checkAccount();
      return null;
    }
    if (h) applyHome(h);
    if (o) {
      applyOffers(o);
      // Offre flotte à fenêtre courte : ouverte aussi, sauf en pleine course (la flotte entière la reçoit)
      const onRide = Boolean((h ?? homeRef.current)?.driver.current_ride_id);
      const fresh = o.find((x) => !seenOffers.current.has(x.offer_id) && (x.mode === "geo" || (!onRide && isUrgentOffer(x))));
      if (fresh) openOffer(fresh);
      void dismissClosedOfferNotifications(presented, new Set(o.map((x) => x.offer_id)));
    }
    return h ?? homeRef.current;
  }, [openOffer, checkAccount, applyHome, applyOffers]);

  // Une seule relecture à la fois : les demandes arrivées pendant ce temps (temps réel, notification,
  // écran) déclenchent UNE relecture de plus à la fin, au lieu de 3 ou 4 en parallèle
  const refresh = useCallback((): Promise<DriverHome | null> => {
    if (inflight.current) {
      refreshAgain.current = true;
      return inflight.current;
    }
    const run = (async () => {
      let h = await fetchOnce();
      while (refreshAgain.current) {
        refreshAgain.current = false;
        h = await fetchOnce();
      }
      return h;
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = run;
    return run;
  }, [fetchOnce]);

  // Messagerie : une lecture complète (30 derniers messages par fil + signalements actifs) par rafale d'événements
  const refreshChat = useCallback(async () => {
    if (!userIdRef.current) return;
    const c = await api.chatOverview().catch(() => null);
    if (c) setChat(c);
  }, []);
  const scheduleChat = useCallback(() => {
    if (chatTimer.current) return;
    chatTimer.current = setTimeout(() => {
      chatTimer.current = null;
      void refreshChat();
    }, 250);
  }, [refreshChat]);

  // Initialisation après connexion (compte actif) : données d'abord, push en parallèle, puis temps réel.
  // Dépend de l'utilisateur et non de l'objet session : le renouvellement du jeton (≈ toutes les heures)
  // ne relance ni l'enregistrement push, ni les canaux, ni le suivi GPS.
  useEffect(() => {
    if (!userId || !canDrive) return;
    let cancelled = false;
    void setupNotificationChannels()
      .catch(() => null)
      .then(() => registerForPush())
      .catch(() => null);
    (async () => {
      const h = await refresh();
      if (cancelled || !h) return;
      if (h.driver.presence !== "offline") {
        // Déjà en ligne au redémarrage : la position exacte a pu être retirée entre-temps dans les réglages
        const perm = await locationPermissionState();
        if (perm === "ok") startTracking().catch(() => null);
        else {
          await api.setOnline(false).catch(() => null);
          patchPresence("offline");
          void refresh();
          Alert.alert(
            perm === "coarse" ? "Position exacte désactivée" : "Localisation désactivée",
            perm === "coarse" ? `Vous êtes passé hors ligne. ${COARSE_MESSAGE}` : "Vous êtes passé hors ligne : autorisez la localisation pour recevoir des courses.",
          );
        }
      }
      void refreshChat();
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (token) await supabase.realtime.setAuth(token);
      if (cancelled) return;
      let subscribedOnce = false;
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
        // Mode centrale : commission créée, déclarée, confirmée, contestée… (bandeau d'accueil, blocage, écran Commissions)
        .on("broadcast", { event: "settlement.updated" }, (m) => {
          void refresh();
          appEvents.emit("settlements", m.payload as SettlementEvent | undefined);
        })
        .subscribe((status) => {
          liveRef.current = status === "SUBSCRIBED";
          // Reconnexion : relecture (des événements ont pu être manqués pendant la coupure)
          if (status === "SUBSCRIBED") {
            if (subscribedOnce) void refresh();
            subscribedOnce = true;
          }
        });
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
      liveRef.current = false;
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      if (fleetChannelRef.current) void supabase.removeChannel(fleetChannelRef.current);
      channelRef.current = null;
      fleetChannelRef.current = null;
    };
  }, [userId, canDrive, refresh, refreshChat, scheduleChat, patchPresence]);

  // Messagerie : repli périodique (le temps réel peut manquer un message) et relecture au retour au premier plan
  useEffect(() => {
    if (!userId || !canDrive) return;
    let last = 0;
    const id = setInterval(() => {
      // Temps réel actif : une relecture par minute suffit ; sinon toutes les 30 s
      if (AppState.currentState !== "active" || Date.now() - last < (liveRef.current ? 60_000 : 30_000)) return;
      last = Date.now();
      void refreshChat();
    }, 30_000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refreshChat());
    return () => {
      clearInterval(id);
      sub.remove();
      if (chatTimer.current) clearTimeout(chatTimer.current);
      chatTimer.current = null;
    };
  }, [userId, canDrive, refreshChat]);

  // Repli : relecture périodique quand l'app est active et le chauffeur en ligne — toutes les 8 s si le temps
  // réel est coupé, toutes les 30 s s'il fonctionne (il signale déjà offres, courses et présence)
  useEffect(() => {
    if (!userId || !canDrive) return;
    const id = setInterval(() => {
      if (AppState.currentState !== "active" || (homeRef.current?.driver.presence ?? "offline") === "offline") return;
      if (Date.now() - lastRefreshAt.current >= (liveRef.current ? 30_000 : 8000)) void refresh();
    }, 8000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [userId, canDrive, refresh]);

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
    // Messagerie, signalements, vols, documents, commissions, course retirée : chaque notification ouvre son écran
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
      // Mode centrale : commission à régler, relance, contestation, paiement confirmé, versement… (data.ride_id présent)
      if (type.startsWith("settlement_")) {
        void refresh();
        openCommissions();
        return;
      }
      // Candidature validée par la centrale : état du compte relu, direction l'accueil
      if (type === "application_approved") {
        const state = await checkAccount();
        if (!state || state.state === "active") {
          await refresh();
          router.replace("/home");
        }
        return;
      }
      // Chauffeur confirmé : toutes les courses de la centrale lui sont proposées
      if (type === "driver_trusted") {
        await refresh();
        router.dismissTo("/home");
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
      else if (!res.ok && res.code === "DRIVER_BLOCKED") alertDriverBlocked(res);
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
  }, [refresh, refreshChat, checkAccount]);

  // Notifications : réception au premier plan + actions
  useEffect(() => {
    if (!userId) return;
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
      // Mode centrale : bandeau d'accueil et écran Commissions à jour ; candidature validée ; chauffeur confirmé
      if (type.startsWith("settlement_")) {
        void refresh();
        appEvents.emit("settlements", undefined);
      }
      if (type === "application_approved") void checkAccount();
      if (type === "driver_trusted") void refresh();
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
  }, [userId, refresh, handleResponse, scheduleChat, checkAccount]);

  /**
   * En ligne / hors ligne, OPTIMISTE : l'interface bascule tout de suite ; seul l'appel au serveur est attendu
   * (quelques centaines de ms), et l'état précédent revient s'il échoue. Le suivi GPS démarre sans attendre de
   * premier point (la tâche le livre elle-même) ; un problème de localisation est signalé ensuite.
   */
  const setOnline = useCallback(async (online: boolean): Promise<OnlineResult> => {
    if (onlinePending.current) return { ok: true }; // double appui
    onlinePending.current = true;
    const previous = homeRef.current?.driver.presence ?? "offline";
    try {
      if (online) {
        // Autorisations : lecture instantanée, fenêtre seulement si elles manquent (position exacte exigée)
        const perm = await requestLocationPermissions();
        if (perm === "denied") return { ok: false, message: "Autorisez la localisation pour passer en ligne." };
        if (perm === "coarse") return { ok: false, code: "coarse", message: COARSE_MESSAGE };
        patchPresence("available");
        setBusy(true);
        const res = await api.setOnline(true);
        if (!res.ok) {
          patchPresence(previous);
          void refresh();
          return { ok: false, message: res.message };
        }
        startTracking()
          .then((track) => {
            void track.firstAccuracy.then((acc) => {
              if (acc != null && acc > MAX_ACCURACY_M) {
                Alert.alert(
                  "Position imprécise",
                  `Votre position n'est connue qu'à ${formatDistance(acc)} près : au-delà de 1,5 km, elle n'est pas utilisée pour vous proposer des courses. Activez le GPS et patientez à découvert.`,
                );
              }
            });
            if (!track.background) Alert.alert("Localisation", "Position partagée uniquement quand l'application est ouverte.");
          })
          .catch(async (e: unknown) => {
            // Aucun suivi possible : on ne reste pas EN LIGNE sans position
            await api.setOnline(false).catch(() => null);
            patchPresence("offline");
            void refresh();
            Alert.alert("Vous êtes hors ligne", (e as Error).message);
          });
        return { ok: true, code: perm === "foreground-only" ? "foreground-only" : undefined };
      }
      patchPresence("offline");
      setBusy(true);
      const res = await api.setOnline(false);
      if (!res.ok) {
        patchPresence(previous);
        void refresh();
        return { ok: false, message: res.message };
      }
      // Suivi arrêté après la confirmation du serveur (sinon « disponible » sans position)
      void stopTracking().catch(() => null);
      return { ok: true };
    } catch (e) {
      patchPresence(previous);
      if (isForbidden(e)) void checkAccount();
      return { ok: false, message: (e as Error).message };
    } finally {
      onlinePending.current = false;
      setBusy(false);
    }
  }, [refresh, checkAccount, patchPresence]);

  const signOut = useCallback(async () => {
    await api.setOnline(false).catch(() => null);
    await stopTracking().catch(() => null);
    await unregisterPush();
    await supabase.auth.signOut();
    applyHome(null);
    applyOffers([]);
    setChat(null);
    setAccount(null);
    setAccountFor(null);
    seenOffers.current.clear();
  }, [applyHome, applyOffers]);

  const value = useMemo(
    () => ({ session, ready, home, offers, refresh, setOnline, signOut, busy, chat, refreshChat, account, canDrive, checkAccount }),
    [session, ready, home, offers, refresh, setOnline, signOut, busy, chat, refreshChat, account, canDrive, checkAccount],
  );
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriver() {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error("useDriver hors DriverProvider");
  return ctx;
}
