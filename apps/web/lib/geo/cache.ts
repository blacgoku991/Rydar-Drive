// Petit cache mémoire LRU + TTL (par instance) pour les appels géo payants / limités.
export function lruCache<V>(max = 500, ttlMs = 10 * 60_000) {
  const store = new Map<string, { v: V; t: number }>();
  return {
    get(key: string): V | undefined {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.t > ttlMs) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, hit);
      return hit.v;
    },
    set(key: string, v: V) {
      store.delete(key);
      store.set(key, { v, t: Date.now() });
      if (store.size > max) store.delete(store.keys().next().value!);
    },
  };
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const { timeoutMs = 3500, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", ...(rest.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
  return res.json();
}
