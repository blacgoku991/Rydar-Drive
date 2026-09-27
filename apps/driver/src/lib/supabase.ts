import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import * as aesjs from "aes-js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import { authStorageKey, signOutDevice } from "./auth-session";
import { appConfig } from "./config";

/**
 * Session chiffrée : clé AES aléatoire dans le trousseau (SecureStore),
 * données chiffrées dans AsyncStorage (SecureStore est limité à ~2 Ko).
 * Écriture en trois temps (nouvelle clé « .next », données, clé courante) : un arrêt de l'app entre deux
 * écritures (fermeture, système) laisse toujours une paire clé / données lisible — sinon déconnexion silencieuse.
 */
class LargeSecureStore {
  /**
   * Dernière valeur déchiffrée par clé : supabase-js relit la session à CHAQUE requête (stockage + trousseau +
   * AES en JavaScript) ; la mémoire du process suffit tant que l'app vit (même moteur JS pour la tâche GPS).
   */
  private cache = new Map<string, string | null>();
  private static decryptWith(hexKey: string | null, value: string) {
    if (!hexKey) return null;
    try {
      const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(hexKey), new aesjs.Counter(1));
      const plain = aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)));
      JSON.parse(plain); // supabase-js n'écrit que du JSON : autre chose = mauvaise clé
      return plain;
    } catch {
      return null;
    }
  }
  private async decrypt(key: string, value: string) {
    for (const k of [key, `${key}.next`]) {
      const plain = LargeSecureStore.decryptWith(await SecureStore.getItemAsync(k), value);
      if (plain != null) return plain;
    }
    return null;
  }
  async getItem(key: string) {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const encrypted = await AsyncStorage.getItem(key);
    const value = encrypted ? await this.decrypt(key, encrypted) : null;
    // Données présentes mais illisibles (trousseau pas encore accessible, clé manquante) : rien en cache, relu ensuite
    if (value != null || !encrypted) this.cache.set(key, value);
    return value;
  }
  async setItem(key: string, value: string) {
    // Mémoire d'abord : un jeton déjà renouvelé par le serveur reste utilisable même si l'écriture échoue
    this.cache.set(key, value);
    const encryptionKey = Crypto.getRandomBytes(256 / 8);
    const hexKey = aesjs.utils.hex.fromBytes(encryptionKey);
    const encrypted = aesjs.utils.hex.fromBytes(
      new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1)).encrypt(aesjs.utils.utf8.toBytes(value)),
    );
    const opts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
    try {
      await SecureStore.setItemAsync(`${key}.next`, hexKey, opts);
      await AsyncStorage.setItem(key, encrypted);
      await SecureStore.setItemAsync(key, hexKey, opts);
    } catch {
      // Écriture impossible pour l'instant (trousseau indisponible) : la session reste en mémoire, réécrite
      // au prochain renouvellement ; une erreur ici ferait rejeter le jeton neuf par supabase-js
    }
  }
  async removeItem(key: string) {
    this.cache.delete(key);
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
    await SecureStore.deleteItemAsync(`${key}.next`).catch(() => null);
  }
}

/**
 * Délai maximal des requêtes Supabase (hors envoi de fichiers) : une requête bloquée (changement d'antenne en
 * roulant) ne doit pas figer le renouvellement du jeton ni l'envoi des positions. Coupée, elle devient une
 * erreur réseau, réessayée ; la session est conservée.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const fetchWithTimeout: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
  if (url.includes("/storage/v1/")) return fetch(input, init);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};

// Web (aperçu / démo) : stockage du navigateur ; mobile : trousseau chiffré.
const storage = Platform.OS === "web" ? (typeof window !== "undefined" ? window.localStorage : undefined) : new LargeSecureStore();

const SUPABASE_URL = appConfig.supabaseUrl || "https://not-configured.supabase.co";
/** Clé de la session : celle que supabase-js prend par défaut (sessions existantes conservées), rendue explicite. */
const AUTH_STORAGE_KEY = authStorageKey(SUPABASE_URL);

export const supabase = createClient(SUPABASE_URL, appConfig.supabaseAnonKey || "missing", {
  auth: { storage, storageKey: AUTH_STORAGE_KEY, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  global: { fetch: fetchWithTimeout },
});

/**
 * Déconnexion de CET appareil, même hors réseau avec un jeton expiré (voir signOutDevice) ; « local » : les autres
 * sessions du compte (tableau de bord d'un gérant qui roule aussi) sont gardées. false : session encore présente.
 */
export function signOutThisDevice(scope: "global" | "local" = "global") {
  return signOutDevice(supabase.auth, storage, AUTH_STORAGE_KEY, scope);
}

/** Session enregistrée sur l'appareil (lecture du stockage seule, sans renouvellement ni réseau). */
export async function hasStoredSession() {
  try {
    return (await storage?.getItem(AUTH_STORAGE_KEY)) != null;
  } catch {
    return false;
  }
}

// Rafraîchissement du jeton uniquement au premier plan (recommandation Supabase RN)
AppState.addEventListener("change", (state) => {
  if (state === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
