export type PushTarget = { token: string; provider: "expo" | "fcm" | "apns"; platform: "ios" | "android" | "web" };

export type PushPayload = {
  title: string;
  body: string;
  type: string;
  data: Record<string, unknown>;
  priority: "high" | "normal";
};

/**
 * Résultat par token : ok, ou erreur (invalid = token à désactiver, retryable = réessayer).
 * receiptId : identifiant du ticket Expo, à vérifier plus tard (accusé de réception).
 */
export type PushResult = { token: string; ok: boolean; messageId?: string; receiptId?: string; error?: string; invalid?: boolean; retryable?: boolean };

export interface PushProvider {
  name: "expo" | "fcm" | "apns";
  send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]>;
}

/** Noms partagés avec l'app chauffeur (canal Android + sonnerie des offres). */
export const RIDE_OFFER_CHANNEL = "ride-offers-v2";
export const RIDE_OFFER_SOUND_IOS = "ride_offer_v2.wav";
export const RIDE_OFFER_SOUND_ANDROID = "ride_offer_v2";
/** Offres planifiées : canal distinct (importance HIGH, sans « Ne pas déranger ») et son court. */
export const SCHEDULED_OFFER_CHANNEL = "ride-offers-scheduled";
export const SCHEDULED_OFFER_SOUND_IOS = "ride_offer.wav";
export const SCHEDULED_OFFER_SOUND_ANDROID = "ride_offer";

/**
 * TTL push d'une offre : jusqu'à son expiration (data.expires_at), au moins 1 s, au plus
 * max (600 s = offer_timeout_seconds max) ; fallback si expires_at est absent ou illisible.
 * Inutile de livrer une offre déjà expirée à un téléphone qui se reconnecte.
 */
export function offerTtlSeconds(expiresAt: unknown, now = Date.now(), max = 600, fallback = 60) {
  const at = typeof expiresAt === "string" || typeof expiresAt === "number" ? new Date(expiresAt).getTime() : Number.NaN;
  if (!Number.isFinite(at)) return fallback;
  return Math.min(max, Math.max(1, Math.ceil((at - now) / 1000)));
}

function ttlSeconds(payload: PushPayload, now: number) {
  // offre instantanée : sans réponse elle reste ouverte deux délais (prolongée à la vague suivante,
  // puis fermée « ignorée ») → TTL = 2 × temps restant, 600 s max
  if (payload.type === "ride_offer") {
    const left = offerTtlSeconds(payload.data.expires_at, now, 600, Number.NaN);
    return Number.isNaN(left) ? 60 : Math.min(600, 2 * left);
  }
  // offre planifiée : fenêtre longue (jusqu'à T-lead), 1 h max comme les autres notifications
  if (payload.type === "ride_offer_scheduled") return offerTtlSeconds(payload.data.expires_at, now, 3600, 3600);
  return 3600;
}

/**
 * Réglages de présentation communs : catégorie actionnable (ACCEPTER / Refuser) pour toutes les
 * offres. L'offre instantanée sonne 10 s sur le canal MAX et perce le mode Concentration iOS
 * (time-sensitive) ; l'offre planifiée a son canal et un son court : elle peut attendre.
 */
export function presentation(payload: PushPayload, now = Date.now()) {
  const instant = payload.type === "ride_offer";
  const scheduled = payload.type === "ride_offer_scheduled";
  const isOffer = instant || scheduled;
  const urgent = instant || payload.type === "ride_cancelled" || payload.type === "ride_assigned";
  return {
    sound: instant ? RIDE_OFFER_SOUND_IOS : scheduled ? SCHEDULED_OFFER_SOUND_IOS : "default",
    androidSound: instant ? RIDE_OFFER_SOUND_ANDROID : scheduled ? SCHEDULED_OFFER_SOUND_ANDROID : "default",
    channelId: instant ? RIDE_OFFER_CHANNEL : scheduled ? SCHEDULED_OFFER_CHANNEL : urgent ? "ride-updates" : "default",
    categoryId: isOffer ? "ride_offer" : undefined,
    interruptionLevel: urgent ? ("time-sensitive" as const) : ("active" as const),
    ttlSeconds: ttlSeconds(payload, now),
  };
}

/** Données métier exposées à l'app (content.data côté expo-notifications). */
export function appData(payload: PushPayload): Record<string, unknown> {
  return { ...payload.data, type: payload.type };
}

/** FCM / APNs n'acceptent que des chaînes dans « data ». */
export function stringifyData(data: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
}
