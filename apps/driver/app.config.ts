import type { ConfigContext, ExpoConfig } from "expo/config";

// Application chauffeur Rydar Drive — iOS & Android.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Rydar Drive",
  slug: "rydar-drive",
  scheme: "rydardrive",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#07080B",
  ios: {
    bundleIdentifier: process.env.APNS_BUNDLE_ID ?? "app.rydar.driver",
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ["location", "remote-notification", "audio"],
      NSLocationWhenInUseUsageDescription: "Rydar Drive utilise votre position pour vous proposer les courses les plus proches.",
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "Lorsque vous êtes EN LIGNE, votre position est partagée avec votre centrale même application fermée, pour recevoir les courses proches.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: process.env.ANDROID_PACKAGE ?? "app.rydar.driver",
    adaptiveIcon: { foregroundImage: "./assets/images/adaptive-icon.png", backgroundColor: "#07080B" },
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "POST_NOTIFICATIONS",
      "VIBRATE",
      "WAKE_LOCK",
    ],
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY ?? "" } },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "Lorsque vous êtes EN LIGNE, votre position est partagée avec votre centrale pour recevoir les courses proches.",
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/images/notification-icon.png",
        color: "#C8F03C",
        sounds: ["./assets/sounds/ride_offer.wav"],
      },
    ],
    ["expo-splash-screen", { image: "./assets/images/splash.png", backgroundColor: "#07080B", imageWidth: 160 }],
  ],
  experiments: { typedRoutes: false },
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
