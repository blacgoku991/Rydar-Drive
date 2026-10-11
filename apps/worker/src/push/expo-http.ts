import { Expo, type ExpoPushMessage, type ExpoPushReceipt, type ExpoPushTicket } from "expo-server-sdk";
import type { ExpoClient } from "./expo";

// Client HTTP de l'API Expo Push, à la place des requêtes du SDK (expo-server-sdk) :
// - chaque requête est bornée (AbortSignal.timeout) et ANNULÉE à l'échéance : le SDK appelle fetch sans signal et
//   limite à 6 requêtes simultanées ; 6 requêtes sans réponse bloquaient TOUTES les notifications (offres comprises)
//   jusqu'au délai d'undici (300 s) ;
// - les messages envoyés dans le même tour de boucle (un lot de notifications) partent ensemble, 100 par requête
//   (limite d'Expo), au lieu d'une requête par notification.
// Le SDK ne sert plus qu'au découpage (fonctions pures, aucune requête).

const SEND_LIMIT = 100;

export class ExpoHttpError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    /** Code d'erreur de la requête renvoyé par Expo (ex. PUSH_TOO_MANY_EXPERIENCE_IDS) et ses détails. */
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type ExpoHttpOptions = {
  accessToken?: string;
  /** Délai maximal d'une requête, réponse comprise (ms). */
  timeoutMs?: number;
  /** Adresse de l'API (EXPO_BASE_URL : tests, faux serveur). */
  baseUrl?: string;
  fetch?: typeof fetch;
};

type Pending = { messages: ExpoPushMessage[]; resolve: (tickets: ExpoPushTicket[]) => void; reject: (error: unknown) => void };

export function expoHttpClient(opts: ExpoHttpOptions = {}): ExpoClient {
  const sdk = new Expo();
  const timeoutMs = opts.timeoutMs || 10_000;
  const base = (opts.baseUrl || process.env.EXPO_BASE_URL || "https://exp.host").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (error) {
      const name = (error as Error)?.name;
      throw new ExpoHttpError(name === "TimeoutError" || name === "AbortError" ? `EXPO_TIMEOUT (${timeoutMs} ms)` : `EXPO_NETWORK: ${(error as Error).message}`, 0);
    }
    let json: { data?: unknown; errors?: { code?: string; message?: string; details?: unknown }[] } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // corps non JSON : erreur ci-dessous
    }
    if (res.status !== 200 || !json || json.errors) {
      const first = json?.errors?.[0];
      throw new ExpoHttpError(
        `EXPO_HTTP_${res.status}: ${first ? `${first.code ?? ""} ${first.message ?? ""}`.trim() : text.slice(0, 200)}`,
        res.status,
        first?.code,
        first?.details,
      );
    }
    return json.data as T;
  }

  let queue: Pending[] = [];
  let scheduled = false;

  /** Message d'un expéditeur ; ses tickets sont rendus quand tous ses messages ont une réponse (requêtes séparées possibles). */
  type Item = { owner: Owner; index: number; message: ExpoPushMessage };
  type Owner = { pending: Pending; tickets: ExpoPushTicket[]; remaining: number; done: boolean };

  function settle(item: Item, ticket: ExpoPushTicket) {
    const o = item.owner;
    if (o.done) return;
    o.tickets[item.index] = ticket;
    if (--o.remaining === 0) {
      o.done = true;
      o.pending.resolve(o.tickets);
    }
  }
  function fail(item: Item, error: unknown) {
    const o = item.owner;
    if (o.done) return;
    o.done = true;
    o.pending.reject(error);
  }

  /**
   * Une requête Expo. Requête ENTIÈRE refusée alors qu'elle porte plusieurs expéditeurs : un jeton fautif (jeton d'un
   * AUTRE projet Expo enregistré par un chauffeur, message invalide) ne doit jamais faire échouer les notifications
   * des autres centrales du même lot (audit p5, worker-infra-1) :
   *  - PUSH_TOO_MANY_EXPERIENCE_IDS (projets mélangés) : un envoi par projet, d'après details (projet → jetons) ;
   *  - autre refus 400 : un envoi par expéditeur.
   * Un seul nouvel essai (split = false) ; panne, délai dépassé, 429 ou 5xx : échec du groupe comme avant (pas de
   * multiplication des requêtes pendant une panne d'Expo).
   */
  function send(items: Item[], split: boolean) {
    const messages = items.map((i) => i.message);
    post<ExpoPushTicket[]>("/--/api/v2/push/send", messages).then(
      (tickets) => {
        if (!Array.isArray(tickets) || tickets.length !== messages.length) {
          const error = new ExpoHttpError(`EXPO_BAD_RESPONSE: ${messages.length} tickets attendus`, 200);
          for (const item of items) fail(item, error);
          return;
        }
        items.forEach((item, i) => settle(item, tickets[i]!));
      },
      (error) => {
        const parts = split ? splitOnRequestError(items, error) : null;
        if (parts) for (const part of parts) send(part, false);
        else for (const item of items) fail(item, error);
      },
    );
  }

  /** Sous-groupes à renvoyer après un refus de la requête entière, ou null (échec du groupe). */
  function splitOnRequestError(items: Item[], error: unknown): Item[][] | null {
    if (!(error instanceof ExpoHttpError) || error.statusCode !== 400) return null;
    let key: (item: Item) => unknown = (item) => item.owner;
    if (error.code === "PUSH_TOO_MANY_EXPERIENCE_IDS" && error.details && typeof error.details === "object") {
      const projectOf = new Map<string, string>();
      for (const [project, tokens] of Object.entries(error.details as Record<string, unknown>)) {
        if (Array.isArray(tokens)) for (const t of tokens) projectOf.set(String(t), project);
      }
      // Jeton absent des détails : envoyé seul avec son expéditeur
      key = (item) => projectOf.get(String(item.message.to)) ?? item.owner;
    }
    const parts = new Map<unknown, Item[]>();
    for (const item of items) parts.set(key(item), [...(parts.get(key(item)) ?? []), item]);
    return parts.size > 1 ? [...parts.values()] : null;
  }

  /** Envoie les messages en attente : requêtes de 100 au plus, l'appel d'un expéditeur jamais coupé en deux. */
  function flush() {
    scheduled = false;
    const pending = queue;
    queue = [];
    const groups: Item[][] = [];
    let group: Item[] = [];
    for (const p of pending) {
      if (group.length && group.length + p.messages.length > SEND_LIMIT) {
        groups.push(group);
        group = [];
      }
      const owner: Owner = { pending: p, tickets: new Array(p.messages.length), remaining: p.messages.length, done: false };
      p.messages.forEach((message, index) => group.push({ owner, index, message }));
    }
    if (group.length) groups.push(group);
    for (const g of groups) send(g, true);
  }

  return {
    chunkPushNotifications: (messages: ExpoPushMessage[]) => sdk.chunkPushNotifications(messages),
    chunkPushNotificationReceiptIds: (ids: string[]) => sdk.chunkPushNotificationReceiptIds(ids),
    sendPushNotificationsAsync: (messages: ExpoPushMessage[]) =>
      new Promise<ExpoPushTicket[]>((resolve, reject) => {
        if (!messages.length) return resolve([]);
        queue.push({ messages, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
      }),
    getPushNotificationReceiptsAsync: (ids: string[]) => post<{ [id: string]: ExpoPushReceipt }>("/--/api/v2/push/getReceipts", { ids }),
  };
}
