import {
  DRIVER_BLOCKER_META, formatDistance, type DriverAccountState, type DriverChatOverview, type DriverHome, type DriverOffer,
  type DriverPresence, type SettlementEvent,
} from "@rydar/shared";
import { isAuthRetryableFetchError, type RealtimeChannel, type Session } from "@supabase/supabase-js";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform, Vibration } from "react-native";
import { frTypo } from "@/components/centrale";
import { api, ApiError, refusalText } from "@/lib/api";
import { chatSession } from "@/lib/chat-session";
import { appEvents } from "@/lib/events";
import { ensureTracking, locationPermissionState, MAX_ACCURACY_M, requestLocationPermissions, startTracking, stopTracking } from "@/lib/location";
import { dismissClosedOfferNotifications, presentedOfferNotifications, registerForPush, setupNotificationChannels, unregisterPush } from "@/lib/notifications";
import { offerSession } from "@/lib/offer-session";
import { settlementSession } from "@/lib/settlement-session";
import { hasStoredSession, signOutThisDevice, supabase } from "@/lib/supabase";

/**
 * Résultat du passage en ligne. code : « coarse » (position approximative) et « blocked » (localisation refusée
 * définitivement) → proposer « Ouvrir les réglages » ; « cancelled » : information préalable refermée, rien à afficher.
 */
export type OnlineResult = { ok: boolean; message?: string; code?: "coarse" | "blocked" | "denied" | "foreground-only" | "cancelled" };

type Ctx = {
  session: Session | null;
  /** Session lue et, si connecté, état du compte déterminé (le splash reste affiché jusque-là). */
  ready: boolean;
  /**
   * Session enregistrée sur le téléphone mais pas encore rétablie (jeton à renouveler, pas de réseau) : ni connecté,
   * ni déconnecté — rétablie automatiquement au retour du réseau (TOKEN_REFRESHED), ou fermée (SIGNED_OUT).
   */
  restoring: boolean;
  home: DriverHome | null;
  /** Accueil jamais lu et dernière lecture en échec (réseau, serveur) : « Connexion impossible » plutôt que « Chargement… ». */
  homeError: boolean;
  offers: DriverOffer[];
  /** Heure (ms) de la dernière lecture RÉUSSIE des offres, même identique à la précédente. */
  offersReadAt: () => number;
  /** Offre fermée localement sans réponse du chauffeur : elle pourra se rouvrir si le serveur la prolonge. */
  forgetOffer: (offerId: string) => void;
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

/** Splash au lancement : au-delà, une session enregistrée mais pas encore rétablie (hors réseau) est signalée. */
const SPLASH_MAX_MS = 3000;

/** Accueil illisible au démarrage (réseau, serveur) : nouveaux essais espacés, jusqu'à la première lecture réussie. */
const INIT_RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000];

/** Présences de course : le suivi GPS tourne quoi qu'il arrive (jamais de course sans position). */
const RIDE_PRESENCES = new Set<DriverPresence>(["en_route", "arrived", "on_trip"]);

/** Fenêtre (s) en deçà de laquelle une offre est traitée comme urgente (sonnerie, compte à rebours). */
export const URGENT_OFFER_S = 120;

/** Offre à traiter tout de suite : dispatch GPS, ou fenêtre courte (course planifiée proche). */
export function isUrgentOffer(o: Pick<DriverOffer, "mode" | "sent_at" | "expires_at">) {
  if (o.mode === "geo") return true;
  if (!o.expires_at) return false;
  return new Date(o.expires_at).getTime() - new Date(o.sent_at).getTime() <= URGENT_OFFER_S * 1000;
}

/**
 * Chemin dans les réglages de l'app (ouverts par Linking.openSettings : page de Rydar Drive) jusqu'à la position,
 * avec les libellés du système.
 */
const SETTINGS_PATH =
  Platform.OS === "android"
    ? {
        position: "Autorisations › Position",
        allow: "« Autoriser seulement si l'appli est en cours d'utilisation »",
        exact: "« Utiliser la position exacte »",
      }
    : { position: "Position", allow: "« Lorsque l'app est active »", exact: "« Position exacte »" };

/** Pourquoi la position approximative empêche de recevoir des courses (passage en ligne et redémarrage). */
const COARSE_MESSAGE = `Les courses sont proposées aux chauffeurs situés à 4 km, puis 8 km du client : avec une position approximative, vous ne pouvez pas en recevoir. Dans les réglages (${SETTINGS_PATH.position}), activez ${SETTINGS_PATH.exact}.`;

/** Localisation refusée définitivement : plus aucune fenêtre du système, seuls les réglages du téléphone la rétablissent. */
export const LOCATION_BLOCKED_MESSAGE = `La localisation de Rydar Drive est refusée. Pour recevoir des courses, ouvrez les réglages : ${SETTINGS_PATH.position}, choisissez ${SETTINGS_PATH.allow} puis activez ${SETTINGS_PATH.exact}.`;

/** Même refus définitif, au moment de publier un signalement de la flotte (la position l'accompagne). */
const REPORT_LOCATION_BLOCKED_MESSAGE = `Un signalement part avec votre position. Pour en publier, ouvrez les réglages : ${SETTINGS_PATH.position}, puis choisissez ${SETTINGS_PATH.allow}.`;

/**
 * Avant d'ouvrir la feuille « Signaler » (accueil, messagerie), même hors ligne : la position accompagne le
 * signalement. Autorisation jamais donnée (installation neuve) ou temporaire expirée (iOS « Demander la prochaine
 * fois », Android « Uniquement cette fois-ci ») : information préalable PUIS fenêtre du système, par la seule porte
 * d'entrée (requestLocationPermissions). Refus définitif : accès aux réglages du téléphone. Position approximative :
 * acceptée (elle situe le signalement, moins précisément).
 * true : la feuille peut s'ouvrir ; false : le chauffeur a été informé, ou a refermé l'information préalable.
 */
export async function prepareFleetReport(): Promise<boolean> {
  const perm = await requestLocationPermissions();
  if (perm === "cancelled") return false;
  if (perm === "blocked") {
    Alert.alert("Localisation refusée", frTypo(REPORT_LOCATION_BLOCKED_MESSAGE), [
      { text: "Plus tard", style: "cancel" },
      { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings().catch(() => null) },
    ]);
    return false;
  }
  if (perm === "denied") {
    Alert.alert("Localisation nécessaire", frTypo("Un signalement part avec votre position : autorisez la localisation pour le publier."));
    return false;
  }
  return true;
}

/**
 * Localisation retirée pendant que le chauffeur était EN LIGNE (réglages du téléphone) : il est passé hors ligne.
 * Accès direct aux réglages, seul endroit où la rétablir (le système ne redemande pas une autorisation retirée).
 */
function alertLocationLost(perm: "coarse" | "denied") {
  Alert.alert(
    perm === "coarse" ? "Position exacte désactivée" : "Localisation désactivée",
    frTypo(perm === "coarse" ? `Vous êtes passé hors ligne. ${COARSE_MESSAGE}` : "Vous êtes passé hors ligne : autorisez la localisation pour recevoir des courses."),
    [
      { text: "Plus tard", style: "cancel" },
      { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings().catch(() => null) },
    ],
  );
}

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
  const [restoring, setRestoring] = useState(false);
  const [account, setAccount] = useState<DriverAccountState | null>(null);
  /** Utilisateur pour lequel l'état du compte a été déterminé (lu, ou lecture impossible). */
  const [accountFor, setAccountFor] = useState<string | null>(null);
  const [home, setHome] = useState<DriverHome | null>(null);
  const [homeError, setHomeError] = useState(false);
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
  const offersReadAtRef = useRef(0);
  /** Compte pour lequel l'appareil est enregistré (jeton push) dans ce processus ; enregistrement en cours. */
  const pushReady = useRef<string | null>(null);
  const pushRunning = useRef(false);

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

  // Session. Jeton expiré sans réseau : supabase-js réessaie ~30 s avant de répondre « pas de session » (qu'il garde
  // pour la rétablir au retour du réseau) → splash borné, puis « hors connexion » au lieu du formulaire de connexion.
  useEffect(() => {
    let alive = true;
    let settled = false;
    const timer = setTimeout(() => {
      void hasStoredSession().then((stored) => {
        if (!alive || settled) return;
        if (stored) setRestoring(true);
        setSessionReady(true);
      });
    }, SPLASH_MAX_MS);
    supabase.auth.getSession().then(({ data, error }) => {
      settled = true;
      clearTimeout(timer);
      if (!alive) return;
      setSession(data.session);
      setRestoring(!data.session && isAuthRetryableFetchError(error));
      setSessionReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (s || event === "SIGNED_OUT") setRestoring(false);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
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

  // Changement de compte (connexion, déconnexion, session fermée par le serveur) : rien du compte précédent ne reste
  // affiché (accueil, prochaine course, offres, messagerie) ; l'appareil sera enregistré pour le nouveau compte
  useEffect(() => {
    setAccount(null);
    setAccountFor(null);
    applyHome(null);
    applyOffers([]);
    setChat(null);
    setHomeError(false);
    seenOffers.current.clear();
    pushReady.current = null;
    if (userId) void checkAccount();
  }, [userId, checkAccount, applyHome, applyOffers]);

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

  /**
   * Enregistrement de l'appareil (jeton push) pour le compte connecté. Jeton Expo illisible hors réseau, serveur
   * injoignable : nouvel essai au retour dans l'app (sinon aucune notification de toute la session).
   */
  const ensurePush = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid || pushReady.current === uid || pushRunning.current) return;
    pushRunning.current = true;
    try {
      await registerForPush();
      if (uid === userIdRef.current) pushReady.current = uid;
    } catch {
      /* réseau : nouvel essai au retour dans l'app */
    } finally {
      pushRunning.current = false;
    }
  }, []);

  // Candidat en attente : appareil enregistré dès maintenant (push « candidature acceptée », contrôle
  // serveur « appareil déjà utilisé par un chauffeur banni »), puis relecture de l'état du compte
  const pendingAccount = accountChecked && account?.state === "pending";
  useEffect(() => {
    if (!userId || !pendingAccount) return;
    let cancelled = false;
    (async () => {
      await setupNotificationChannels().catch(() => null);
      await ensurePush();
      if (!cancelled) void checkAccount();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, pendingAccount, checkAccount, ensurePush]);

  // Enregistrement push en échec (réseau) : nouvel essai à chaque retour dans l'app
  useEffect(() => {
    if (!userId || !(canDrive || pendingAccount)) return;
    const sub = AppState.addEventListener("change", (s) => s === "active" && void ensurePush());
    return () => sub.remove();
  }, [userId, canDrive, pendingAccount, ensurePush]);

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
    const uid = userIdRef.current;
    if (!uid) return null;
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
    // Compte changé pendant la lecture (déconnexion, autre chauffeur) : réponses de l'ancien compte ignorées
    if (uid !== userIdRef.current) return null;
    lastRefreshAt.current = Date.now();
    // Compte devenu inactif en cours d'usage (banni, suspendu, désactivé) : écran d'état du compte
    if (forbidden) {
      void checkAccount();
      return null;
    }
    if (h) applyHome(h);
    setHomeError(!h && !homeRef.current);
    if (o) {
      offersReadAtRef.current = Date.now();
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
    const uid = userIdRef.current;
    if (!uid) return;
    const c = await api.chatOverview().catch(() => null);
    if (c && uid === userIdRef.current) setChat(c);
  }, []);
  const scheduleChat = useCallback(() => {
    if (chatTimer.current) return;
    chatTimer.current = setTimeout(() => {
      chatTimer.current = null;
      void refreshChat();
    }, 250);
  }, [refreshChat]);

  // Retour dans l'app EN LIGNE : suivi GPS relancé s'il a été arrêté ou ne livre plus rien (système, économie
  // de batterie) — app ouverte, la position reste en direct. Localisation retirée entre-temps : hors ligne et
  // prévenu (comme au lancement), jamais « en ligne » sans position.
  useEffect(() => {
    if (!canDrive) return;
    const sub = AppState.addEventListener("change", (s) => {
      const presence = homeRef.current?.driver.presence ?? "offline";
      if (s !== "active" || presence === "offline") return;
      void (async () => {
        const perm = await locationPermissionState();
        if (perm === "ok") return void ensureTracking(RIDE_PRESENCES.has(presence)).catch(() => null);
        const res = await api.setOnline(false).catch(() => null);
        if (res && !res.ok) return; // en course : il reste en ligne jusqu'à la fin
        void stopTracking().catch(() => null);
        patchPresence("offline");
        void refresh();
        alertLocationLost(perm);
      })();
    });
    return () => sub.remove();
  }, [canDrive, patchPresence, refresh]);

  // Course en cours (en route, sur place, client à bord) : suivi GPS relancé même s'il a été arrêté plus tôt dans ce
  // processus (passage hors ligne, puis course démarrée) — autorisation déjà accordée seulement, rien n'est demandé ici
  const ridePresence = canDrive && home != null && RIDE_PRESENCES.has(home.driver.presence);
  useEffect(() => {
    if (!ridePresence) return;
    void locationPermissionState()
      .then((perm) => (perm === "ok" ? ensureTracking(true) : undefined))
      .catch(() => null);
  }, [ridePresence]);

  // Initialisation après connexion (compte actif) : données d'abord, push en parallèle, puis temps réel.
  // Dépend de l'utilisateur et non de l'objet session : le renouvellement du jeton (≈ toutes les heures)
  // ne relance ni l'enregistrement push, ni les canaux, ni le suivi GPS.
  useEffect(() => {
    if (!userId || !canDrive) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    void setupNotificationChannels()
      .catch(() => null)
      .then(() => ensurePush());
    (async () => {
      let h = await refresh();
      // Accueil illisible (réseau, serveur) : nouveaux essais espacés — sans lui, ni temps réel, ni reprise du suivi GPS
      for (let i = 0; !h && !cancelled; i++) {
        await new Promise<void>((resolve) => {
          retry = setTimeout(resolve, INIT_RETRY_MS[Math.min(i, INIT_RETRY_MS.length - 1)]);
        });
        if (cancelled) return;
        h = await refresh();
      }
      if (cancelled || !h) return;
      if (h.driver.presence !== "offline") {
        // Déjà en ligne au redémarrage : la position exacte a pu être retirée entre-temps dans les réglages
        const perm = await locationPermissionState();
        if (perm === "ok") startTracking().catch(() => null);
        else {
          await api.setOnline(false).catch(() => null);
          patchPresence("offline");
          void refresh();
          alertLocationLost(perm);
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
      // Fil de la flotte (messages + signalements, votes « toujours là », messages retirés par la centrale) :
      // topic privé fleet:<org>
      const fleet = supabase.channel(`fleet:${h.organization.id}`, { config: { private: true } });
      fleet
        .on("broadcast", { event: "chat.message" }, scheduleChat)
        .on("broadcast", { event: "chat.report" }, scheduleChat)
        .on("broadcast", { event: "chat.removed" }, scheduleChat)
        .subscribe();
      fleetChannelRef.current = fleet;
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      liveRef.current = false;
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      if (fleetChannelRef.current) void supabase.removeChannel(fleetChannelRef.current);
      channelRef.current = null;
      fleetChannelRef.current = null;
    };
  }, [userId, canDrive, refresh, refreshChat, scheduleChat, patchPresence, ensurePush]);

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
  // réel est coupé, toutes les 30 s s'il fonctionne (il signale déjà offres, courses et présence). Accueil jamais lu
  // (réseau au lancement) : relu lui aussi, toutes les 8 s
  useEffect(() => {
    if (!userId || !canDrive) return;
    const id = setInterval(() => {
      if (AppState.currentState !== "active" || homeRef.current?.driver.presence === "offline") return;
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
      else if (!res.ok) Alert.alert(res.code === "OFFER_EXPIRED" ? "Offre expirée" : "Course indisponible", frTypo(refusalText(res)));
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
        // Autorisation : lecture instantanée ; si elle manque, information préalable PUIS fenêtre du système
        // (requestLocationPermissions est la seule porte d'entrée) ; refus définitif → réglages du téléphone
        const perm = await requestLocationPermissions();
        if (perm === "cancelled") return { ok: false, code: "cancelled" };
        if (perm === "blocked") return { ok: false, code: "blocked", message: LOCATION_BLOCKED_MESSAGE };
        if (perm === "denied") return { ok: false, code: "denied", message: "Autorisez la localisation pour passer en ligne." };
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

  /**
   * Déconnexion : hors ligne, suivi arrêté, appareil retiré du compte (plus de notifications), puis session effacée
   * de CET appareil, même hors réseau avec un jeton expiré. Les données du compte sont vidées au SIGNED_OUT (effet
   * [userId]) ; l'état du compte n'est pas remis à zéro tant que la session existe (sinon écran de connexion figé).
   */
  const signOut = useCallback(async () => {
    await api.setOnline(false).catch(() => null);
    await stopTracking().catch(() => null);
    const pushRemoved = await unregisterPush();
    if (!(await signOutThisDevice())) {
      Alert.alert("Déconnexion impossible", "Réessayez dans un instant.");
      return;
    }
    applyHome(null);
    applyOffers([]);
    setChat(null);
    seenOffers.current.clear();
    if (!pushRemoved) {
      // Sans réseau, le serveur garde le jeton push de ce téléphone (messages de la centrale, offres planifiées)
      Alert.alert(
        "Notifications encore actives",
        frTypo(
          "Sans réseau, ce téléphone n'a pas pu être retiré de votre compte : il peut encore recevoir vos notifications. Pour les arrêter, désactivez les notifications de Rydar Drive dans les réglages.",
        ),
        [
          { text: "OK", style: "cancel" },
          { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings().catch(() => null) },
        ],
      );
    }
  }, [applyHome, applyOffers]);

  const offersReadAt = useCallback(() => offersReadAtRef.current, []);
  const forgetOffer = useCallback((offerId: string) => void seenOffers.current.delete(offerId), []);

  const value = useMemo(
    () => ({
      session, ready, restoring, home, homeError, offers, offersReadAt, forgetOffer, refresh, setOnline, signOut, busy, chat, refreshChat,
      account, canDrive, checkAccount,
    }),
    [
      session, ready, restoring, home, homeError, offers, offersReadAt, forgetOffer, refresh, setOnline, signOut, busy, chat, refreshChat,
      account, canDrive, checkAccount,
    ],
  );
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriver() {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error("useDriver hors DriverProvider");
  return ctx;
}
