// Webhooks sortants : un essai d'envoi HTTP (POST) vers une cible déjà validée (ssrf.ts).
//  - succès = réponse 2xx reçue dans le délai (10 s au total pour l'essai : résolution DNS, connexion, TLS, en-têtes ;
//    ici le temps qui reste après la résolution) ; tout le reste est un échec ;
//  - redirections JAMAIS suivies (3xx = échec) : une redirection pourrait viser le réseau interne ;
//  - corps de la réponse ignoré : 2 Ko lus au plus, puis la connexion est fermée ;
//  - connexion vers les adresses validées seulement (pinnedLookup), sans agent partagé ni mandataire (agent: false) ;
//  - message d'erreur en français, sans adresse IP ni contenu de la réponse (enregistré dans last_error, visible par la
//    centrale).
import http from "node:http";
import https from "node:https";
import { pinnedLookup, type WebhookTarget } from "./ssrf";

export type PostResult = { ok: boolean; statusCode: number | null; error: string | null };

export type PostOptions = {
  /** Temps laissé à la requête (connexion, TLS, en-têtes). */
  timeoutMs: number;
  maxResponseBytes: number;
  /** Délai de l'essai entier, annoncé dans le message d'échec (défaut : timeoutMs). */
  totalMs?: number;
};

/** « Délai dépassé (10 s) » (secondes à la française, une décimale au plus). */
export function timeoutMessage(ms: number): string {
  return `Délai dépassé (${String(Math.round(ms / 100) / 10).replace(".", ",")} s)`;
}

/** Verdict d'après le code HTTP reçu. */
export function resultFromStatus(code: number): PostResult {
  if (code >= 200 && code < 300) return { ok: true, statusCode: code, error: null };
  if (code >= 300 && code < 400) return { ok: false, statusCode: code, error: `Redirection non suivie (HTTP ${code})` };
  return { ok: false, statusCode: code, error: `HTTP ${code}` };
}

const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME|ERR_TLS|ERR_SSL|EPROTO/;

/** Erreur réseau → message court en français, code technique seulement (jamais l'adresse jointe). */
export function describeNetworkError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? "");
  switch (code) {
    case "ECONNREFUSED":
      return "Connexion refusée";
    case "ECONNRESET":
    case "EPIPE":
      return "Connexion interrompue";
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return "Délai de connexion dépassé";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EADDRNOTAVAIL":
      return "Hôte injoignable";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Nom d'hôte introuvable (DNS)";
  }
  if (TLS_CODE.test(code)) return `Certificat ou connexion TLS invalide (${code})`;
  const message = (error as { message?: unknown })?.message;
  if (!code && typeof message === "string" && /socket hang up/i.test(message)) return "Connexion interrompue";
  return `Erreur réseau${code ? ` (${code})` : ""}`;
}

/** POST du corps signé ; ne lève jamais (le résultat dit pourquoi l'essai a échoué). */
export function postWebhook(target: WebhookTarget, body: string, headers: Record<string, string>, opts: PostOptions): Promise<PostResult> {
  const client = target.url.protocol === "http:" ? http : https;
  const timedOut: PostResult = { ok: false, statusCode: null, error: timeoutMessage(opts.totalMs ?? opts.timeoutMs) };
  // Délai déjà épuisé (résolution DNS lente) : aucune connexion
  if (!(opts.timeoutMs > 0)) return Promise.resolve(timedOut);
  return new Promise<PostResult>((resolve) => {
    let done = false;
    let status: number | null = null;
    let req: http.ClientRequest | null = null;
    const finish = (result: PostResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
      req?.destroy();
    };
    // Délai global : sans réponse, échec ; en-têtes déjà reçus (corps qui traîne), le code HTTP fait foi
    const timer = setTimeout(() => finish(status != null ? resultFromStatus(status) : timedOut), opts.timeoutMs);
    try {
      req = client.request({
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        headers,
        agent: false,
        lookup: pinnedLookup(target.addresses),
      });
    } catch (error) {
      finish({ ok: false, statusCode: null, error: describeNetworkError(error) });
      return;
    }
    req.on("response", (res) => {
      status = res.statusCode ?? 0;
      const code = status;
      let read = 0;
      res.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read >= opts.maxResponseBytes) finish(resultFromStatus(code));
      });
      res.on("end", () => finish(resultFromStatus(code)));
      res.on("error", () => finish(resultFromStatus(code)));
      res.on("close", () => finish(resultFromStatus(code)));
    });
    req.on("error", (error) => finish(status != null ? resultFromStatus(status) : { ok: false, statusCode: null, error: describeNetworkError(error) }));
    req.end(body);
  });
}
