// Déconnexion hors réseau (audit app#0) et clé de stockage de la session. Client supabase-js réel, stockage en
// mémoire, réseau coupé (fetch qui échoue comme React Native hors connexion).
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authStorageKey, signOutDevice } from "./auth-session";

const URL_ = "https://abcdefghijklmnop.supabase.co";
const KEY = authStorageKey(URL_);

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", role: "authenticated", exp })}.sig`;
const user = {
  id: "11111111-1111-1111-1111-111111111111", aud: "authenticated", role: "authenticated", email: "a@b.c",
  app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
};

function memoryStorage() {
  const mem = new Map<string, string>();
  const reads: string[] = [];
  return {
    mem,
    reads,
    getItem: async (k: string) => {
      reads.push(k);
      return mem.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => void mem.set(k, v),
    removeItem: async (k: string) => void mem.delete(k),
  };
}

/** Client dont la session stockée expire à `exp` (s) ; aucune requête n'aboutit (hors réseau). */
function offlineClient(exp: number) {
  const storage = memoryStorage();
  storage.mem.set(KEY, JSON.stringify({ access_token: jwt(exp), refresh_token: "rt-1", token_type: "bearer", expires_in: 3600, expires_at: exp, user }));
  const offline = (async () => {
    throw new TypeError("Network request failed");
  }) as typeof fetch;
  const client = createClient(URL_, "anon", {
    auth: { storage, storageKey: KEY, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
    global: { fetch: offline },
  });
  const events: string[] = [];
  client.auth.onAuthStateChange((e) => void events.push(e));
  return { client, storage, events };
}

/** Exécute `run` en faisant avancer les minuteries (réessais du renouvellement du jeton : ~30 s simulées). */
async function withFastTimers<T>(run: () => Promise<T>): Promise<T> {
  const p = run();
  for (let i = 0; i < 80; i++) await vi.advanceTimersByTimeAsync(1000);
  return p;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("authStorageKey", () => {
  it("est la clé par défaut de supabase-js (sessions existantes conservées à la mise à jour)", async () => {
    for (const url of [URL_, "https://xyz.supabase.co/", "http://192.168.1.10:54321", "https://api.rydar.fr"]) {
      const storage = memoryStorage();
      const client = createClient(url, "anon", { auth: { storage, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false } });
      await client.auth.getSession();
      expect(storage.reads).toContain(authStorageKey(url));
    }
  });
});

describe("signOutDevice", () => {
  it("jeton expiré + hors réseau : signOut seul garde la session (défaut de supabase-js)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { client, storage, events } = offlineClient(Math.floor(Date.now() / 1000) - 600);
    const res = await withFastTimers(() => client.auth.signOut());
    expect(res.error).not.toBeNull();
    expect(storage.mem.has(KEY)).toBe(true);
    expect(events).not.toContain("SIGNED_OUT");
  });

  it("jeton expiré + hors réseau : session effacée, SIGNED_OUT émis", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { client, storage, events } = offlineClient(Math.floor(Date.now() / 1000) - 600);
    const ok = await withFastTimers(() => signOutDevice(client.auth, storage, KEY));
    expect(ok).toBe(true);
    expect(storage.mem.has(KEY)).toBe(false);
    expect(events).toContain("SIGNED_OUT");
    expect((await client.auth.getSession()).data.session).toBeNull();
  });

  it("stockage impossible à effacer : échec signalé", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { client, storage } = offlineClient(Math.floor(Date.now() / 1000) - 600);
    const locked = {
      removeItem: async () => {
        throw new Error("trousseau indisponible");
      },
    };
    const ok = await withFastTimers(() => signOutDevice(client.auth, locked, KEY));
    expect(ok).toBe(false);
    expect(storage.mem.has(KEY)).toBe(true);
  });

  it("jeton valide : déconnexion directe", async () => {
    const { client, storage, events } = offlineClient(Math.floor(Date.now() / 1000) + 3600);
    const ok = await signOutDevice(client.auth, storage, KEY, "local");
    expect(ok).toBe(true);
    expect(storage.mem.has(KEY)).toBe(false);
    expect(events).toContain("SIGNED_OUT");
  });
});
