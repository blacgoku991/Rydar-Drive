import { SignJWT, importPKCS8 } from "jose";
import { presentation, stringifyData, type PushPayload, type PushProvider, type PushResult, type PushTarget } from "./types";

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

/** Envoi direct Firebase Cloud Messaging (HTTP v1) pour les tokens FCM natifs Android. */
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
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
    return cached.token;
  }

  return {
    name: "fcm",
    async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
      const p = presentation(payload);
      const bearer = await accessToken();
      return Promise.all(
        targets.map(async (t) => {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify({
              message: {
                token: t.token,
                notification: { title: payload.title, body: payload.body },
                data: stringifyData({ ...payload.data, type: payload.type }),
                android: {
                  priority: payload.priority === "high" ? "HIGH" : "NORMAL",
                  ttl: `${p.ttlSeconds}s`,
                  notification: { channel_id: p.channelId, sound: p.androidSound, click_action: p.categoryId },
                },
              },
            }),
          }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ error: { status: e.message } }) }) as unknown as Response);
          if (res.ok) {
            const json = (await res.json()) as { name: string };
            return { token: t.token, ok: true, messageId: json.name };
          }
          const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
          const status = err.error?.status ?? `HTTP_${res.status}`;
          return {
            token: t.token,
            ok: false,
            error: `${status}: ${err.error?.message ?? ""}`,
            invalid: status === "NOT_FOUND" || status === "UNREGISTERED" || status === "INVALID_ARGUMENT",
            retryable: res.status >= 500 || res.status === 429 || res.status === 0,
          };
        }),
      );
    },
  };
}
