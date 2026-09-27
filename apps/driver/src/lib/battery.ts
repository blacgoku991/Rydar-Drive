import * as Application from "expo-application";
import * as Battery from "expo-battery";
import * as IntentLauncher from "expo-intent-launcher";
import { Linking, Platform } from "react-native";

/**
 * Android : l'économie de batterie restreint-elle Rydar Drive ? (le système peut alors couper l'app et son GPS
 * écran éteint ou dans une autre application). Toujours faux ailleurs.
 */
export async function batteryRestricted() {
  if (Platform.OS !== "android") return false;
  return Battery.isBatteryOptimizationEnabledAsync().catch(() => false);
}

/**
 * Fenêtre système « Autoriser Rydar Drive à toujours s'exécuter en arrière-plan ? » (permission
 * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) ; à défaut, les réglages de l'app (Batterie › Non restreinte).
 */
export async function requestBatteryExemption() {
  if (Platform.OS !== "android") return;
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, {
      data: `package:${Application.applicationId}`,
    });
  } catch {
    await Linking.openSettings().catch(() => null);
  }
}
