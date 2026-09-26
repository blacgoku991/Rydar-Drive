import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import * as aesjs from "aes-js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import { appConfig } from "./config";

/**
 * Session chiffrée : clé AES aléatoire dans le trousseau (SecureStore),
 * données chiffrées dans AsyncStorage (SecureStore est limité à ~2 Ko).
 */
class LargeSecureStore {
  /**
   * Dernière valeur déchiffrée par clé : supabase-js relit la session à CHAQUE requête (stockage + trousseau +
   * AES en JavaScript) ; la mémoire du process suffit tant que l'app vit (même moteur JS pour la tâche GPS).
   */
  private cache = new Map<string, string | null>();
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
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const encrypted = await AsyncStorage.getItem(key);
    const value = encrypted ? await this.decrypt(key, encrypted) : null;
    this.cache.set(key, value);
    return value;
  }
  async setItem(key: string, value: string) {
    await AsyncStorage.setItem(key, await this.encrypt(key, value));
    this.cache.set(key, value);
  }
  async removeItem(key: string) {
    this.cache.delete(key);
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  }
}

export const isConfigured = Boolean(appConfig.supabaseUrl && appConfig.supabaseAnonKey);

// Web (aperçu / démo) : stockage du navigateur ; mobile : trousseau chiffré.
const storage = Platform.OS === "web" ? (typeof window !== "undefined" ? window.localStorage : undefined) : new LargeSecureStore();

export const supabase = createClient(appConfig.supabaseUrl || "https://not-configured.supabase.co", appConfig.supabaseAnonKey || "missing", {
  auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

// Rafraîchissement du jeton uniquement au premier plan (recommandation Supabase RN)
AppState.addEventListener("change", (state) => {
  if (state === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
