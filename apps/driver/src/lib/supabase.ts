import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import * as aesjs from "aes-js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { appConfig } from "./config";

/**
 * Session chiffrée : clé AES aléatoire dans le trousseau (SecureStore),
 * données chiffrées dans AsyncStorage (SecureStore est limité à ~2 Ko).
 */
class LargeSecureStore {
  private async encrypt(key: string, value: string) {
    const encryptionKey = Crypto.getRandomBytes(256 / 8);
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
    return aesjs.utils.hex.fromBytes(encrypted);
  }
  private async decrypt(key: string, value: string) {
    const hexKey = await SecureStore.getItemAsync(key);
    if (!hexKey) return null;
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(hexKey), new aesjs.Counter(1));
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)));
  }
  async getItem(key: string) {
    const encrypted = await AsyncStorage.getItem(key);
    return encrypted ? this.decrypt(key, encrypted) : null;
  }
  async setItem(key: string, value: string) {
    await AsyncStorage.setItem(key, await this.encrypt(key, value));
  }
  async removeItem(key: string) {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  }
}

export const isConfigured = Boolean(appConfig.supabaseUrl && appConfig.supabaseAnonKey);

export const supabase = createClient(appConfig.supabaseUrl || "https://not-configured.supabase.co", appConfig.supabaseAnonKey || "missing", {
  auth: { storage: new LargeSecureStore(), autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

// Rafraîchissement du jeton uniquement au premier plan (recommandation Supabase RN)
AppState.addEventListener("change", (state) => {
  if (state === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
