import * as Application from "expo-application";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { api } from "./api";
import { isChatNotificationMuted } from "./chat-session";
import { appConfig } from "./config";
import { installationId } from "./device";
import { ensureTracking, wakeTracking } from "./location";

// Affichage des notifications même application ouverte (le modal d'offre prend ensuite le relais),
// sauf un message ou un signalement qui s'affiche déjà dans le fil ouvert de l'écran Messages.
if (Platform.OS !== "web") Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const type = (n.request.content.data as Record<string, unknown> | undefined)?.type;
    // « Position non reçue » application ouverte : le suivi est relancé, rien à afficher
    if (type === "gps_lost") {
      void ensureTracking();
      return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    const muted = isChatNotificationMuted(type);
    return { shouldShowBanner: !muted, shouldShowList: !muted, shouldPlaySound: !muted, shouldSetBadge: false };
  },
});

/** Réveil silencieux (worker : type « location_ping », sans titre ni son, private.watch_driver_gps). */
export const WAKE_TASK = "rydar-wake";

/** Type métier d'une notification reçue par la tâche : Android « dataString » (JSON), iOS « body » (objet). */
function taskPayloadType(payload: unknown): string | null {
  const o = (payload ?? {}) as Record<string, unknown>;
  const inner = (o.data ?? {}) as Record<string, unknown>;
  for (const c of [inner.dataString, o.dataString, inner.body, o.body, inner, o]) {
    let v: unknown = c;
    if (typeof c === "string") {
      try {
        v = JSON.parse(c);
      } catch {
        continue;
      }
    }
    const type = (v as Record<string, unknown> | null)?.type;
    if (typeof type === "string") return type;
  }
  return null;
}

// Tâche de notification en arrière-plan : exécutée app ouverte, en arrière-plan ou relancée sans interface
// (Android : message data-only ; iPhone : content-available, sauf app fermée à la main). Définie et enregistrée
// au chargement du module (importé en tête de index.ts). Réveil GPS : suivi relancé, position fraîche envoyée.
if (Platform.OS !== "web") {
  TaskManager.defineTask(WAKE_TASK, async ({ data }) => {
    if (taskPayloadType(data) !== "location_ping") return Notifications.BackgroundNotificationTaskResult.NoData;
    await wakeTracking().catch(() => null);
    return Notifications.BackgroundNotificationTaskResult.NewData;
  });
  void Notifications.registerTaskAsync(WAKE_TASK).catch(() => null);
}

/** Canal Android des offres instantanées (worker : channelId « ride-offers-v2 », son « ride_offer_v2 ») ;
 *  les planifiées arrivent sur « ride-offers-scheduled » (son « ride_offer »). */
const RIDE_OFFER_CHANNEL = "ride-offers-v2";
/** Messages de la centrale (worker : type chat_message → channelId « messages »). */
export const MESSAGES_CHANNEL = "messages";
/** Signalements de la flotte (worker : type fleet_report → channelId « fleet-reports »). */
export const FLEET_REPORTS_CHANNEL = "fleet-reports";

export async function setupNotificationChannels() {
  if (Platform.OS === "web") return;
  if (Platform.OS === "android") {
    // Android 8+ : le son d'un canal est figé à sa création → nouveau canal pour la nouvelle sonnerie
    await Notifications.deleteNotificationChannelAsync("ride-offers").catch(() => null);
    await Notifications.setNotificationChannelAsync(RIDE_OFFER_CHANNEL, {
      name: "Nouvelles courses",
      description: "Offres de course : sonnerie et vibration prioritaires",
      importance: Notifications.AndroidImportance.MAX,
      sound: "ride_offer_v2.wav",
      vibrationPattern: [0, 500, 250, 500, 250, 900],
      enableVibrate: true,
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      lightColor: "#C8F03C",
    });
    // Offres planifiées : son court, sans percer « Ne pas déranger » (elles peuvent attendre)
    await Notifications.setNotificationChannelAsync("ride-offers-scheduled", {
      name: "Courses planifiées",
      description: "Réservations à venir proposées à la flotte",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "ride_offer.wav",
      vibrationPattern: [0, 300, 200, 300],
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      lightColor: "#C8F03C",
    });
    await Notifications.setNotificationChannelAsync("ride-updates", {
      name: "Mises à jour des courses",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    });
    // Messagerie : son par défaut du téléphone (sound non renseigné), priorité haute
    await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
      name: "Messages de la centrale",
      description: "Messages envoyés par votre centrale",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 120, 180],
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      lightColor: "#C8F03C",
    });
    await Notifications.setNotificationChannelAsync(FLEET_REPORTS_CHANNEL, {
      name: "Signalements de la flotte",
      description: "Police, contrôles, accidents et bouchons signalés par vos collègues à proximité",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      lightColor: "#F5B544",
    });
    await Notifications.setNotificationChannelAsync("default", { name: "Général", importance: Notifications.AndroidImportance.DEFAULT });
  }
  // Boutons d'action directement dans la notification
  await Notifications.setNotificationCategoryAsync("ride_offer", [
    { identifier: "ACCEPT", buttonTitle: "Accepter", options: { opensAppToForeground: true } },
    { identifier: "DECLINE", buttonTitle: "Refuser", options: { opensAppToForeground: false, isDestructive: true } },
  ]);
}

let registeredToken: string | null = null;

/** Demande la permission, récupère le token Expo et l'enregistre pour ce chauffeur. */
export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === "web") return null; // pas de push en aperçu web
  const id = await installationId();
  const base = {
    installationId: id,
    platform: (Platform.OS === "ios" ? "ios" : "android") as "ios" | "android",
    deviceName: Device.deviceName ?? Device.modelName ?? null,
    osVersion: `${Platform.OS} ${Device.osVersion ?? ""}`.trim(),
    appVersion: Application.nativeApplicationVersion ?? null,
  };
  if (!Device.isDevice) {
    await api.registerDevice(base).catch(() => null);
    return null;
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
  if (status !== "granted") {
    await api.registerDevice(base).catch(() => null);
    return null;
  }
  const token = (await Notifications.getExpoPushTokenAsync(appConfig.easProjectId ? { projectId: appConfig.easProjectId } : undefined)).data;
  registeredToken = token;
  await api.registerDevice({ ...base, token, provider: "expo" });
  return token;
}

export async function unregisterPush() {
  if (registeredToken) await api.unregisterToken(registeredToken).catch(() => null);
  registeredToken = null;
}

type PresentedOffer = { id: string; offerId: string };

/** Notifications d'offre affichées dans le centre de notifications (hors web). */
export async function presentedOfferNotifications(): Promise<PresentedOffer[]> {
  if (Platform.OS === "web") return [];
  const list = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  return list.flatMap((n) => {
    const offerId = (n.request.content.data as Record<string, unknown> | undefined)?.offer_id;
    return offerId ? [{ id: n.request.identifier, offerId: String(offerId) }] : [];
  });
}

/**
 * Retire les notifications des offres qui ne sont plus en attente (prises, expirées, refusées).
 * `presented` doit être relevé AVANT la lecture des offres : une offre arrivée entre-temps reste affichée.
 */
export async function dismissClosedOfferNotifications(presented: PresentedOffer[], pendingOfferIds: Set<string>) {
  for (const n of presented) {
    if (!pendingOfferIds.has(n.offerId)) await Notifications.dismissNotificationAsync(n.id).catch(() => null);
  }
}
