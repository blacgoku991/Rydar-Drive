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
    let json: { data?: unknown; errors?: { code?: string; message?: string }[] } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // corps non JSON : erreur ci-dessous
    }
    if (res.status !== 200 || !json || json.errors) {
      const first = json?.errors?.[0];
      throw new ExpoHttpError(`EXPO_HTTP_${res.status}: ${first ? `${first.code ?? ""} ${first.message ?? ""}`.trim() : text.slice(0, 200)}`, res.status);
    }
    return json.data as T;
  }

  let queue: Pending[] = [];
  let scheduled = false;

  /** Envoie les messages en attente : requêtes de 100 au plus, l'appel d'un expéditeur jamais coupé en deux. */
  function flush() {
    scheduled = false;
    const pending = queue;
    queue = [];
    const groups: Pending[][] = [];
    let group: Pending[] = [];
    let count = 0;
    for (const p of pending) {
      if (group.length && count + p.messages.length > SEND_LIMIT) {
        groups.push(group);
        group = [];
        count = 0;
      }
      group.push(p);
      count += p.messages.length;
    }
    if (group.length) groups.push(group);
    for (const g of groups) {
      const messages = g.flatMap((p) => p.messages);
      post<ExpoPushTicket[]>("/--/api/v2/push/send", messages).then(
        (tickets) => {
          if (!Array.isArray(tickets) || tickets.length !== messages.length) {
            const error = new ExpoHttpError(`EXPO_BAD_RESPONSE: ${messages.length} tickets attendus`, 200);
            for (const p of g) p.reject(error);
            return;
          }
          let i = 0;
          for (const p of g) {
            p.resolve(tickets.slice(i, i + p.messages.length));
            i += p.messages.length;
          }
        },
        (error) => {
          for (const p of g) p.reject(error);
        },
      );
    }
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
