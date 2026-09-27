import { SignJWT, importPKCS8 } from "jose";
import { appData, presentation, stringifyData, type PushPayload, type PushProvider, type PushResult, type PushTarget } from "./types";

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

/**
 * Message FCM HTTP v1 au format lu par expo-notifications Android (NotificationData.kt : title,
 * message, body = JSON des données, channelId, categoryId, sound).
 * - Offres : « data only » — en arrière-plan expo-notifications affiche la notification avec le canal
 *   et les boutons ACCEPTER / Refuser ; au premier plan l'app ouvre l'écran d'offre (temps réel + sonnerie).
 * - Autres types : bloc « notification » en plus, sinon expo-notifications ignore le message au premier
 *   plan (isDataOnly) et l'annulation / l'attribution passerait sans bannière ni son.
 */
export function fcmMessage(token: string, payload: PushPayload, now = Date.now()) {
  const p = presentation(payload, now);
  const dataOnly = !!p.categoryId;
  return {
    token,
    ...(dataOnly ? {} : { notification: { title: payload.title, body: payload.body } }),
    data: stringifyData({
      title: payload.title,
      message: payload.body,
      body: JSON.stringify(appData(payload)),
      channelId: p.channelId,
      ...(p.categoryId ? { categoryId: p.categoryId } : {}),
      sound: p.androidSound,
    }),
    android: {
      priority: payload.priority === "high" ? "HIGH" : "NORMAL",
      ttl: `${p.ttlSeconds}s`,
      ...(dataOnly ? {} : { notification: { channel_id: p.channelId, sound: p.androidSound } }),
    },
  };
}

type FcmError = { error?: { status?: string; message?: string; details?: { "@type"?: string; errorCode?: string }[] } };

/** Seuls UNREGISTERED / NOT_FOUND signifient un jeton mort (INVALID_ARGUMENT = message mal formé). */
export function fcmFailure(token: string, httpStatus: number, err: FcmError): PushResult {
  const status = err.error?.status ?? `HTTP_${httpStatus}`;
  const code = err.error?.details?.find((d) => d.errorCode)?.errorCode;
  const reason = code && code !== status ? `${status}/${code}` : status;
  return {
    token,
    ok: false,
    error: `${reason}: ${err.error?.message ?? ""}`,
    invalid: code === "UNREGISTERED" || status === "UNREGISTERED" || status === "NOT_FOUND",
    retryable: httpStatus === 0 || httpStatus === 429 || httpStatus >= 500,
  };
}

/** Envoi direct Firebase Cloud Messaging (HTTP v1) pour des jetons FCM natifs (build spécifique, provider « fcm »). */
export function fcmProvider(sa: ServiceAccount): PushProvider {
  let cached: { token: string; exp: number } | null = null;

  async function accessToken() {
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const key = await importPKCS8(sa.private_key, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) throw new Error(`FCM_OAUTH_${json.error ?? res.status}`);
    cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    name: "fcm",
    async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
      let bearer: string;
      try {
        bearer = await accessToken();
      } catch (error) {
        return targets.map((t) => ({ token: t.token, ok: false, error: (error as Error).message, retryable: true }));
      }
      return Promise.all(
        targets.map(async (t): Promise<PushResult> => {
          let res: Response;
          try {
            res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
              method: "POST",
              headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
              body: JSON.stringify({ message: fcmMessage(t.token, payload) }),
            });
          } catch (error) {
            return { token: t.token, ok: false, error: (error as Error).message, retryable: true };
          }
          if (res.ok) {
            const json = (await res.json().catch(() => ({}))) as { name?: string };
            return { token: t.token, ok: true, messageId: json.name };
          }
          return fcmFailure(t.token, res.status, (await res.json().catch(() => ({}))) as FcmError);
        }),
      );
    },
  };
}
