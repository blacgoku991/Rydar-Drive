// Webhooks sortants : corps de l'événement et signature (docs/API.md, « Webhooks »).
//  - corps JSON compact, UTF-8 : { id, type, created_at, api_version, data } ; « data.ride » = état de la course AU
//    MOMENT DE L'ENVOI (publicRide de @rydar/shared, comme GET /api/v1/rides/{id}, plus « updated_at »),
//    « data.status » / « data.previous_status » = transition qui a causé l'événement ; ping : data = {} ;
//  - signature : X-Rydar-Signature: v1=<HMAC-SHA256 hexadécimal minuscule(secret, "<X-Rydar-Timestamp>.<corps brut>")>,
//    horodatage (secondes Unix) de CET essai : le destinataire refuse un écart de plus de 5 min et dédoublonne sur « id ».
import { createHmac } from "node:crypto";
import { publicRide } from "@rydar/shared";

/** Version du format des événements (en-tête du corps « api_version »). */
export const WEBHOOK_API_VERSION = "2026-10-01";
export const WEBHOOK_USER_AGENT = "RydarDrive-Webhooks/1.0";

/** Ligne réservée par private.claim_webhook_deliveries (le secret ne quitte jamais ce processus, jamais journalisé). */
export type ClaimedWebhook = {
  id: string;
  organization_id: string;
  endpoint_id: string;
  url: string;
  secret: string;
  event_type: string;
  event_status: string | null;
  previous_status: string | null;
  occurred_at: Date | string;
  attempts: number;
  /** État ACTUEL de la course (colonnes de PUBLIC_RIDE_SELECT + updated_at) ; null : ping ou course supprimée. */
  ride: Record<string, unknown> | null;
};

/** Date ISO 8601 (UTC) : pg renvoie un timestamptz en Date, le JSON d'une course en texte. */
function iso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** Événement envoyé (objet), clés dans l'ordre du contrat. */
export function buildWebhookEvent(d: ClaimedWebhook, appUrl: string) {
  const head = { id: d.id, type: d.event_type, created_at: iso(d.occurred_at), api_version: WEBHOOK_API_VERSION };
  if (d.event_type === "ping") return { ...head, data: {} };
  const ride = d.ride ? { ...publicRide(d.ride, appUrl), updated_at: d.ride.updated_at ?? null } : null;
  return { ...head, data: { ride, status: d.event_status ?? null, previous_status: d.previous_status ?? null } };
}

/** Corps brut (JSON compact) : c'est CETTE chaîne qui est signée puis envoyée telle quelle. */
export function buildWebhookBody(d: ClaimedWebhook, appUrl: string): string {
  return JSON.stringify(buildWebhookEvent(d, appUrl));
}

/** Valeur de X-Rydar-Signature : « v1= » + HMAC-SHA256 hexadécimal minuscule de « <horodatage>.<corps> ». */
export function signWebhook(secret: string, timestamp: number | string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

/** En-têtes d'un essai ; `now` (ms) fixe l'horodatage signé (secondes Unix de CET essai). */
export function webhookHeaders(d: Pick<ClaimedWebhook, "id" | "event_type" | "secret">, body: string, now = Date.now()): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "User-Agent": WEBHOOK_USER_AGENT,
    "X-Rydar-Event": d.event_type,
    "X-Rydar-Delivery": d.id,
    "X-Rydar-Timestamp": String(timestamp),
    "X-Rydar-Signature": signWebhook(d.secret, timestamp, body),
  };
}
