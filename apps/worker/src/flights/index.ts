// Choix du fournisseur de données de vol + cache (2 min par numéro, date et mode).
import { aerodataboxProvider } from "./aerodatabox";
import { aviationstackProvider } from "./aviationstack";
import { flightawareProvider } from "./flightaware";
import { mockProvider, parseMockDelays } from "./mock";
import type { FlightContext, FlightInfo, FlightProvider, FlightProviderName } from "./types";

export * from "./types";

type Env = Record<string, string | undefined>;
export type ProviderChoice = { provider: FlightProvider | null; reason: string };

const KEYED: { name: Exclude<FlightProviderName, "mock">; key: string }[] = [
  { name: "aerodatabox", key: "AERODATABOX_KEY" },
  { name: "aviationstack", key: "AVIATIONSTACK_KEY" },
  { name: "flightaware", key: "FLIGHTAWARE_KEY" },
];

function build(name: FlightProviderName, env: Env, timeoutMs: number): FlightProvider {
  switch (name) {
    case "aerodatabox":
      return aerodataboxProvider({
        key: env.AERODATABOX_KEY!,
        marketplace: env.AERODATABOX_MARKETPLACE === "apimarket" ? "apimarket" : env.AERODATABOX_MARKETPLACE === "rapidapi" ? "rapidapi" : undefined,
        baseUrl: env.AERODATABOX_URL || undefined,
        timeoutMs,
      });
    case "aviationstack":
      return aviationstackProvider({ key: env.AVIATIONSTACK_KEY!, baseUrl: env.AVIATIONSTACK_URL || undefined, times: env.AVIATIONSTACK_TIMES === "utc" ? "utc" : "local", timeoutMs });
    case "flightaware":
      return flightawareProvider({ key: env.FLIGHTAWARE_KEY!, baseUrl: env.FLIGHTAWARE_URL || undefined, timeoutMs });
    case "mock":
      return mockProvider({ delays: parseMockDelays(env.FLIGHT_MOCK_DELAYS) });
  }
}

/**
 * FLIGHT_PROVIDER = aerodatabox | aviationstack | flightaware | mock | off.
 * Sans valeur : premier fournisseur dont la clé est définie (dans cet ordre), sinon « mock » —
 * sauf en production (NODE_ENV=production) où le mock inventerait des retards sur de vraies
 * courses : suivi désactivé, à moins de FLIGHT_PROVIDER=mock explicite.
 */
export function selectFlightProvider(env: Env = process.env, timeoutMs = 5000): ProviderChoice {
  const wanted = (env.FLIGHT_PROVIDER ?? "").trim().toLowerCase();
  if (["off", "none", "disabled", "false", "0"].includes(wanted)) return { provider: null, reason: "FLIGHT_PROVIDER=off" };
  if (wanted === "mock") return { provider: build("mock", env, timeoutMs), reason: "FLIGHT_PROVIDER=mock" };
  const keyed = KEYED.find((k) => k.name === wanted);
  if (keyed) {
    return env[keyed.key]
      ? { provider: build(keyed.name, env, timeoutMs), reason: `FLIGHT_PROVIDER=${wanted}` }
      : { provider: null, reason: `${keyed.key} manquante` };
  }
  if (wanted) return { provider: null, reason: `FLIGHT_PROVIDER inconnu : ${wanted}` };
  const first = KEYED.find((k) => env[k.key]);
  if (first) return { provider: build(first.name, env, timeoutMs), reason: `${first.key} définie` };
  if (env.NODE_ENV === "production") return { provider: null, reason: "aucune clé fournisseur (production)" };
  return { provider: build("mock", env, timeoutMs), reason: "aucune clé fournisseur" };
}

/**
 * Cache mémoire : un même vol (plusieurs courses, ou deux passages rapprochés) n'est demandé
 * qu'une fois par période ; les requêtes simultanées sont fusionnées. Les erreurs ne sont pas
 * mises en cache (nouvel essai au passage suivant) ; « introuvable » (null) l'est.
 */
export function withCache(provider: FlightProvider, ttlMs = 120_000, now: () => number = Date.now, maxEntries = 1000): FlightProvider & { size(): number } {
  const cache = new Map<string, { at: number; value: Promise<FlightInfo | null> }>();
  const prune = (t: number) => {
    for (const [k, v] of cache) if (t - v.at >= ttlMs) cache.delete(k);
    while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
  };
  return {
    name: provider.name,
    size: () => cache.size,
    getFlightStatus(flightNumber: string, date: string, ctx: FlightContext = {}) {
      const key = `${flightNumber.replace(/\s+/g, "").toUpperCase()}|${date}|${ctx.mode ?? "arrival"}|${ctx.airport ?? ""}`;
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.at < ttlMs) return hit.value;
      if (cache.size >= maxEntries / 2) prune(t);
      const value = provider.getFlightStatus(flightNumber, date, ctx);
      const entry = { at: t, value };
      cache.set(key, entry);
      value.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
      });
      return value;
    },
  };
}
