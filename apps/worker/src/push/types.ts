export type PushTarget = { token: string; provider: "expo" | "fcm" | "apns"; platform: "ios" | "android" | "web" };

export type PushPayload = {
  title: string;
  body: string;
  type: string;
  data: Record<string, unknown>;
  priority: "high" | "normal";
};

/** Résultat par token : ok, ou erreur (invalid = token à désactiver, retryable = réessayer). */
export type PushResult = { token: string; ok: boolean; messageId?: string; error?: string; invalid?: boolean; retryable?: boolean };

export interface PushProvider {
  name: "expo" | "fcm" | "apns";
  send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]>;
}

/** Réglages de présentation communs : son + canal + catégorie actionnable pour les offres. */
export function presentation(payload: PushPayload) {
  const isOffer = payload.type === "ride_offer" || payload.type === "ride_offer_scheduled";
  const urgent = isOffer || payload.type === "ride_cancelled" || payload.type === "ride_assigned";
  return {
    sound: isOffer ? "ride_offer.wav" : "default",
    androidSound: isOffer ? "ride_offer" : "default",
    channelId: isOffer ? "ride-offers" : urgent ? "ride-updates" : "default",
    categoryId: payload.type === "ride_offer" ? "ride_offer" : undefined,
    interruptionLevel: urgent ? ("time-sensitive" as const) : ("active" as const),
    ttlSeconds: payload.type === "ride_offer" ? 60 : 3600,
  };
}

/** FCM / APNs n'acceptent que des chaînes dans « data ». */
export function stringifyData(data: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
}
