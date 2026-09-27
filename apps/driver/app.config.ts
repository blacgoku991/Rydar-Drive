import type { ConfigContext, ExpoConfig } from "expo/config";

// Domaine des liens d'inscription (https://DOMAINE/rejoindre/{code} ouvre l'app) : celui de l'API web
function linkDomain() {
  if (process.env.APP_LINK_DOMAIN) return process.env.APP_LINK_DOMAIN;
  try {
    return new URL(process.env.EXPO_PUBLIC_API_URL || "").hostname;
  } catch {
    return "";
  }
}
const LINK_DOMAIN = linkDomain();

// Projet EAS (eas init) : builds, envoi aux stores et mises à jour à distance (EAS Update)
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || "";

// Application chauffeur Rydar Drive — iOS & Android.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Rydar Drive",
  slug: "rydar-drive",
  scheme: "rydardrive",
  // 1.1.0 : position en direct app ouverte, app fermée = hors ligne en 3 min (private.watch_driver_gps, par version)
  version: "1.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#07080B",
  ios: {
    bundleIdentifier: process.env.APNS_BUNDLE_ID || "app.rydar.driver",
    supportsTablet: false,
    associatedDomains: LINK_DOMAIN ? [`applinks:${LINK_DOMAIN}`] : [],
    infoPlist: {
      // Seul mode d'arrière-plan utilisé : la position EN LIGNE (Apple refuse les modes déclarés sans usage)
      UIBackgroundModes: ["location"],
      NSLocationWhenInUseUsageDescription: "Rydar Drive utilise votre position pour vous proposer les courses les plus proches.",
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "Lorsque vous êtes EN LIGNE, votre position est partagée avec votre centrale même application fermée, pour recevoir les courses proches.",
      ITSAppUsesNonExemptEncryption: false,
    },
    // Offres de course en « time-sensitive » (traversent les résumés / modes Concentration)
    entitlements: { "com.apple.developer.usernotifications.time-sensitive": true },
  },
  android: {
    package: process.env.ANDROID_PACKAGE || "app.rydar.driver",
    adaptiveIcon: { foregroundImage: "./assets/images/adaptive-icon.png", backgroundColor: "#07080B" },
    // Position EN LIGNE par un service de premier plan démarré app ouverte : ni « position en arrière-plan »
    // (ACCESS_BACKGROUND_LOCATION, déclaration Google Play), ni exemption de batterie ne sont nécessaires
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "POST_NOTIFICATIONS",
      "VIBRATE",
      "WAKE_LOCK",
    ],
    blockedPermissions: ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"],
    intentFilters: LINK_DOMAIN
      ? [{ action: "VIEW", autoVerify: true, data: [{ scheme: "https", host: LINK_DOMAIN, pathPrefix: "/rejoindre/" }], category: ["BROWSABLE", "DEFAULT"] }]
      : [],
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY || "" } },
  },
  web: { bundler: "metro", output: "single", favicon: "./assets/images/icon.png" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "Lorsque vous êtes EN LIGNE, votre position est partagée avec votre centrale pour recevoir les courses proches.",
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/images/notification-icon.png",
        color: "#C8F03C",
        // v2 : sonnerie ~10 s (canal Android « ride-offers-v2 ») ; v1 conservée (carillon court, anciens envois)
        sounds: ["./assets/sounds/ride_offer_v2.wav", "./assets/sounds/ride_offer.wav"],
      },
    ],
    ["expo-splash-screen", { image: "./assets/images/splash.png", backgroundColor: "#07080B", imageWidth: 160 }],
    [
      "expo-image-picker",
      {
        photosPermission: "Rydar Drive accède à vos photos pour envoyer vos justificatifs (carte VTC, permis…) à votre centrale.",
        cameraPermission: "Rydar Drive utilise l'appareil photo pour photographier vos justificatifs (carte VTC, permis…).",
        microphonePermission: false,
      },
    ],
  ],
  experiments: { typedRoutes: false },
  // Mises à jour à distance (JavaScript seulement) : « eas update --channel production ». Une mise à jour ne
  // s'installe que sur les builds de la MÊME version (runtimeVersion = version) : tout changement natif
  // (module, permission, icône…) exige une nouvelle version et un nouveau build publié sur les stores.
  ...(EAS_PROJECT_ID
    ? { updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}`, fallbackToCacheTimeout: 0 }, runtimeVersion: { policy: "appVersion" as const } }
    : {}),
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    eas: { projectId: EAS_PROJECT_ID || undefined },
  },
});
