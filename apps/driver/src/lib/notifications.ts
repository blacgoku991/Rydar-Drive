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

export async function setupNotificationChannels() {
  if (Platform.OS === "web") return;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("ride-offers", {
      name: "Nouvelles courses",
      description: "Offres de course : sonnerie et vibration prioritaires",
      importance: Notifications.AndroidImportance.MAX,
      sound: "ride_offer.wav",
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
