import { connect, constants, type ClientHttp2Session } from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { appData, presentation, type PushPayload, type PushProvider, type PushResult, type PushTarget } from "./types";

type ApnsConfig = {
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  production: boolean;
  /** Tests : serveur HTTP/2 local à la place d'Apple. */
  host?: string;
  /** Délai maximal d'une requête (APNs répond en moins d'une seconde). */
  timeoutMs?: number;
};

/**
 * Charge utile APNs au format lu par expo-notifications iOS : les données de l'app sous
 * « body » (userInfo["body"] → content.data), la présentation dans « aps ».
 */
export function apnsPayload(payload: PushPayload, now = Date.now()) {
  const p = presentation(payload, now);
  return {
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: p.sound,
      ...(p.categoryId ? { category: p.categoryId } : {}),
      "interruption-level": p.interruptionLevel,
      "thread-id": p.threadId,
    },
    body: appData(payload),
  };
}

/** Envoi direct Apple Push Notification service (HTTP/2, jeton .p8) pour des jetons APNs natifs (build spécifique, provider « apns »). */
export function apnsProvider(cfg: ApnsConfig): PushProvider {
  const host = cfg.host || (cfg.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com");
  const timeoutMs = cfg.timeoutMs || 10_000;
  let session: ClientHttp2Session | null = null;
  let jwt: { token: string; iat: number } | null = null;

  async function bearer() {
    const now = Math.floor(Date.now() / 1000);
    if (jwt && now - jwt.iat < 50 * 60) return jwt.token;
    const key = await importPKCS8(cfg.key, "ES256");
    const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: cfg.keyId }).setIssuer(cfg.teamId).setIssuedAt(now).sign(key);
    jwt = { token, iat: now };
    return token;
  }

  function client() {
    if (!session || session.closed || session.destroyed) {
      session = connect(host);
      session.on("error", () => {
        session = null;
      });
    }
    return session;
  }

  /** Toujours résolue (le premier événement l'emporte) : réponse, erreur, flux fermé ou délai dépassé (status 0 → réessai). */
  function post(token: string, headers: Record<string, string>, body: string) {
    return new Promise<{ status: number; body: string; id?: string }>((resolve) => {
      const s = client();
      const req = s.request({ ":method": "POST", ":path": `/3/device/${token}`, ...headers });
      let data = "";
      let status = 0;
      let id: string | undefined;
      req.setTimeout(timeoutMs, () => {
        resolve({ status: 0, body: JSON.stringify({ reason: "APNS_TIMEOUT" }) });
        req.close(constants.NGHTTP2_CANCEL);
        // Connexion sans doute morte (coupure sans RST) : la requête suivante repart d'une session neuve
        if (session === s) session = null;
        s.destroy();
      });
      req.on("response", (h) => {
        status = Number(h[":status"]);
        id = h["apns-id"] as string | undefined;
      });
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve({ status, body: data, id }));
      req.on("close", () => resolve({ status, body: data || JSON.stringify({ reason: "APNS_STREAM_CLOSED" }), id }));
      req.on("error", (e) => resolve({ status: 0, body: JSON.stringify({ reason: e.message }) }));
      req.end(body);
    });
  }

  return {
    name: "apns",
    async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
      const p = presentation(payload);
      let auth: string;
      try {
        auth = await bearer();
      } catch (error) {
        return targets.map((t) => ({ token: t.token, ok: false, error: `APNS_AUTH: ${(error as Error).message}`, retryable: false }));
      }
      const body = JSON.stringify(apnsPayload(payload));
      return Promise.all(
        targets.map(async (t): Promise<PushResult> => {
          const res = await post(t.token, {
            authorization: `bearer ${auth}`,
            "apns-topic": cfg.bundleId,
            "apns-push-type": "alert",
            "apns-priority": payload.priority === "high" ? "10" : "5",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + p.ttlSeconds),
          }, body);
          if (res.status === 200) return { token: t.token, ok: true, messageId: res.id };
          const reason = parseReason(res.body) ?? `HTTP_${res.status}`;
          return {
            token: t.token,
            ok: false,
            error: reason,
            invalid: res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
            retryable: res.status === 0 || res.status >= 500 || res.status === 429,
          };
        }),
      );
    },
  };
}

function parseReason(body: string) {
  try {
    return (JSON.parse(body || "{}") as { reason?: string }).reason;
  } catch {
    return undefined;
  }
}
