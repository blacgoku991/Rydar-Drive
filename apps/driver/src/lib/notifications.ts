import * as Application from "expo-application";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "./api";
import { appConfig } from "./config";
import { installationId } from "./device";

// Affichage des notifications même application ouverte (le modal d'offre prend ensuite le relais).
if (Platform.OS !== "web") Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Canal Android des offres (le worker envoie channelId « ride-offers-v2 », son « ride_offer_v2 »). */
const RIDE_OFFER_CHANNEL = "ride-offers-v2";

export async function setupNotificationChannels() {
  if (Platform.OS === "web") return;
  if (Platform.OS === "android") {
    // Android 8+ : le son d'un canal est figé à sa création → nouveau canal pour la nouvelle sonnerie
    await Notifications.deleteNotificationChannelAsync("ride-offers").catch(() => null);
    await Notifications.setNotificationChannelAsync(RIDE_OFFER_CHANNEL, {
      name: "Nouvelles courses",
      description: "Offres de course : sonnerie et vibration prioritaires",
      importance: Notifications.AndroidImportance.MAX,
      sound: "ride_offer_v2.wav",
      vibrationPattern: [0, 500, 250, 500, 250, 900],
      enableVibrate: true,
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      lightColor: "#C8F03C",
    });
    await Notifications.setNotificationChannelAsync("ride-updates", {
      name: "Mises à jour des courses",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    });
    await Notifications.setNotificationChannelAsync("default", { name: "Général", importance: Notifications.AndroidImportance.DEFAULT });
  }
  // Boutons d'action directement dans la notification
  await Notifications.setNotificationCategoryAsync("ride_offer", [
    { identifier: "ACCEPT", buttonTitle: "ACCEPTER", options: { opensAppToForeground: true } },
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
