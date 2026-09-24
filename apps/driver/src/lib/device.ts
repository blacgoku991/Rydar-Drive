import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const KEY = "rydar.installation_id";

/** Identifiant stable de l'installation (pour lier appareil ↔ token push). */
export async function installationId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(KEY, id);
  return id;
}
