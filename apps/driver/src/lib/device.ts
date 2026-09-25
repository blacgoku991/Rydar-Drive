import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "rydar.installation_id";

/**
 * Identifiant stable de l'appareil (lien appareil ↔ token push, et bannissement : un appareil
 * utilisé par un compte banni suspend tout nouveau compte qui s'y connecte).
 *  - Android : ANDROID_ID préfixé « and- » — stable après désinstallation / réinstallation
 *    (propre à l'appareil, à l'utilisateur Android et à la clé de signature de l'application) ;
 *  - iOS : UUID gardé dans le trousseau (SecureStore), qui survit à la réinstallation.
 * Format accepté par driver_register_device : 8 à 128 caractères.
 */
export async function installationId(): Promise<string> {
  if (Platform.OS === "android") {
    try {
      const androidId = Application.getAndroidId();
      if (androidId && /^[0-9a-zA-Z]{4,64}$/.test(androidId)) return `and-${androidId.toLowerCase()}`;
    } catch {
      /* module natif indisponible : repli sur l'identifiant d'installation */
    }
  }
  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(KEY, id);
  return id;
}
