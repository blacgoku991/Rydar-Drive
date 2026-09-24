import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { presentation, type PushPayload, type PushProvider, type PushResult, type PushTarget } from "./types";

/** Expo Push (recommandé) : relaie vers FCM (Android) et APNs (iOS). */
export function expoProvider(accessToken?: string): PushProvider {
  const expo = new Expo({ accessToken });
  return {
    name: "expo",
    async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
      const p = presentation(payload);
      const valid = targets.filter((t) => Expo.isExpoPushToken(t.token));
      const results: PushResult[] = targets
        .filter((t) => !Expo.isExpoPushToken(t.token))
        .map((t) => ({ token: t.token, ok: false, error: "InvalidExpoToken", invalid: true }));
      const messages: ExpoPushMessage[] = valid.map((t) => ({
        to: t.token,
        title: payload.title,
        body: payload.body,
        data: { ...payload.data, type: payload.type },
        sound: p.sound === "default" ? "default" : { name: p.sound, critical: false, volume: 1 },
        channelId: p.channelId,
        priority: payload.priority === "high" ? "high" : "default",
        categoryId: p.categoryId,
        interruptionLevel: p.interruptionLevel,
        ttl: p.ttlSeconds,
      }));
      for (const chunk of expo.chunkPushNotifications(messages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          tickets.forEach((ticket, i) => {
            const token = String(chunk[i]!.to);
            if (ticket.status === "ok") results.push({ token, ok: true, messageId: ticket.id });
            else {
              const code = ticket.details?.error ?? "ExpoError";
              results.push({ token, ok: false, error: `${code}: ${ticket.message}`, invalid: code === "DeviceNotRegistered", retryable: code === "MessageRateExceeded" });
            }
          });
        } catch (error) {
          for (const m of chunk) results.push({ token: String(m.to), ok: false, error: (error as Error).message, retryable: true });
        }
      }
      return results;
    },
  };
}
