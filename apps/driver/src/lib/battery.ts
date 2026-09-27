import * as Battery from "expo-battery";
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
 * Réglages de l'app (Batterie › Non restreinte) : sans permission spéciale (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
 * est encadrée par Google Play).
 */
export async function requestBatteryExemption() {
  await Linking.openSettings().catch(() => null);
}
