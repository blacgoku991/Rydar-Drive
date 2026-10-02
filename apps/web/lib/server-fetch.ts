import { Agent, fetch as undiciFetch, interceptors } from "undici";

type DnsOptions = NonNullable<Parameters<typeof interceptors.dns>[0]>;

/**
 * Appels sortants du serveur web vers Supabase (Auth, PostgREST) : connexions gardées ouvertes et adresses (DNS)
 * mémorisées.
 *
 * Sans cela, après quelques secondes d'inactivité (4 s par défaut), chaque page rouvrait plusieurs connexions, chacune
 * avec une recherche DNS faite depuis le conteneur Docker : plus d'une seconde mesurée sur le VPS (contre 5 ms sur une
 * connexion déjà ouverte), plusieurs fois par page (session, centrale, données).
 */
export const KEEP_ALIVE_MS = 60_000;
/** Durée de mémorisation d'une adresse (changement d'adresse IP du serveur pris en compte en 5 min au plus). */
export const DNS_CACHE_MS = 5 * 60_000;

/** lookup : résolveur de remplacement (tests). */
export function createServerDispatcher(options: { lookup?: DnsOptions["lookup"] } = {}) {
  return new Agent({
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MS,
    connect: { timeout: 10_000 },
  }).compose(interceptors.dns({ maxTTL: DNS_CACHE_MS, ...(options.lookup ? { lookup: options.lookup } : {}) }));
}

let dispatcher: ReturnType<typeof createServerDispatcher> | null = null;

/** fetch des clients Supabase côté serveur (même contrat que fetch). */
export const serverFetch: typeof fetch = (input, init) => {
  dispatcher ??= createServerDispatcher();
  // Requête déjà construite (Request) : rejouée telle quelle par undici, avec ses en-têtes et son corps
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Promise<Response>;
};
