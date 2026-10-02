// Webhooks sortants : à chaque changement de statut d'une course, Rydar Drive envoie un événement JSON signé
// (HMAC-SHA256) aux adresses enregistrées par l'organisation. Tables, détection des événements et RPC svc_webhook_* :
// migration 20260924006000_webhooks ; envoi : worker (garde SSRF, nouveaux essais) ; gestion : API v1
// (/api/v1/webhooks, permission « webhooks:manage ») et Dashboard → Intégrations. Documentation : docs/API.md.
import { z } from "zod";
import type { Tone } from "./domain";

/** Version du format des événements (champ « api_version » de chaque envoi). */
export const WEBHOOK_API_VERSION = "2026-10-01";

/** Événements auxquels une adresse peut s'abonner (liste vide = tous). Miroir de la migration 006000. */
export const WEBHOOK_EVENTS = [
  "ride.created",
  "ride.accepted",
  "ride.driver_unassigned",
  "ride.driver_en_route",
  "ride.driver_arrived",
  "ride.passenger_onboard",
  "ride.in_progress",
  "ride.completed",
  "ride.cancelled",
  "ride.no_driver_found",
  "ride.rescheduled",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Envoi de test (bouton « Tester », POST /api/v1/webhooks/{id}/test) : jamais abonnable, data = {}. */
export const WEBHOOK_PING_EVENT = "ping";
export type WebhookEventType = WebhookEvent | typeof WEBHOOK_PING_EVENT;

export const WEBHOOK_EVENT_META: Record<WebhookEvent, { label: string; description: string }> = {
  "ride.created": { label: "Course créée", description: "Nouvelle course (dashboard, API, mini-site)." },
  "ride.accepted": { label: "Chauffeur attribué", description: "Un chauffeur a accepté la course, ou un autre chauffeur l'a reprise." },
  "ride.driver_unassigned": { label: "Chauffeur retiré", description: "La course n'a plus de chauffeur et repart en recherche." },
  "ride.driver_en_route": { label: "Chauffeur en route", description: "Le chauffeur se dirige vers le point de départ." },
  "ride.driver_arrived": { label: "Chauffeur arrivé", description: "Le chauffeur attend le client au point de départ." },
  "ride.passenger_onboard": { label: "Client à bord", description: "Le client est monté dans le véhicule." },
  "ride.in_progress": { label: "Course en cours", description: "Trajet vers la destination." },
  "ride.completed": { label: "Course terminée", description: "Le client est arrivé à destination." },
  "ride.cancelled": { label: "Course annulée", description: "Annulation par la centrale, l'API ou le système." },
  "ride.no_driver_found": { label: "Aucun chauffeur trouvé", description: "La recherche s'est terminée sans chauffeur." },
  "ride.rescheduled": { label: "Horaire modifié", description: "L'heure de prise en charge a changé." },
};

export function webhookEventLabel(type: string): string {
  if (type === WEBHOOK_PING_EVENT) return "Test";
  return WEBHOOK_EVENT_META[type as WebhookEvent]?.label ?? type;
}

/** Au plus 10 adresses par organisation (WEBHOOK_LIMIT au-delà). */
export const WEBHOOK_MAX_ENDPOINTS = 10;
export const WEBHOOK_URL_MAX = 500;
export const WEBHOOK_DESCRIPTION_MAX = 120;
export const WEBHOOK_SECRET_MIN = 32;
export const WEBHOOK_SECRET_MAX = 200;
/** Secret généré par Rydar : « whsec_ » + 48 caractères hexadécimaux. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/** Délai avant le nouvel essai qui suit l'échec n° n (secondes) ; après le 9ᵉ échec, l'envoi est abandonné. */
export const WEBHOOK_RETRY_DELAYS_S = [60, 300, 900, 3600, 10_800, 21_600, 43_200, 86_400] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_S.length + 1;
/** Réponse 2xx attendue dans ce délai ; les redirections ne sont pas suivies. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Écart toléré par le destinataire entre X-Rydar-Timestamp et son horloge (secondes). */
export const WEBHOOK_SIGNATURE_TOLERANCE_S = 300;
export const WEBHOOK_USER_AGENT = "RydarDrive-Webhooks/1.0";
export const WEBHOOK_HEADERS = {
  event: "X-Rydar-Event",
  delivery: "X-Rydar-Delivery",
  timestamp: "X-Rydar-Timestamp",
  signature: "X-Rydar-Signature",
} as const;

/** Texte signé : « <X-Rydar-Timestamp>.<corps brut> » ; signature = v1=<HMAC-SHA256 hexadécimal minuscule>. */
export function webhookSignedContent(timestamp: number | string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "sending", "delivered", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
export const WEBHOOK_DELIVERY_STATUS_META: Record<WebhookDeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: "En attente", tone: "blue" },
  sending: { label: "Envoi en cours", tone: "cyan" },
  delivered: { label: "Livré", tone: "green" },
  failed: { label: "Échec", tone: "red" },
};

/** Adresse enregistrée telle que renvoyée par l'API et les RPC (jamais le secret). */
export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEvent[];
  enabled: boolean;
  disabled_reason: string | null;
  created_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
};

// -----------------------------------------------------------------------------
// Adresse de destination : https, publique, sans identifiants (le worker revérifie l'adresse résolue)
// -----------------------------------------------------------------------------
function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** 8 groupes de 16 bits, forme IPv4 finale acceptée (::ffff:127.0.0.1) ; null si ce n'est pas une IPv6. */
function parseIPv6(input: string): number[] | null {
  let h = input.toLowerCase();
  let tail: number[] = [];
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (v4) {
    const p = parseIPv4(v4[2]!);
    if (!p) return null;
    tail = [(p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!];
    h = v4[1]!.endsWith("::") ? v4[1]! : v4[1]!.slice(0, -1);
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN)));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const total = head.length + rest.length + tail.length;
  if (halves.length === 1) return total === 8 ? [...head, ...tail] : null;
  if (total > 7) return null;
  return [...head, ...new Array<number>(8 - total).fill(0), ...rest, ...tail];
}

/** Boucle locale, réseaux privés, lien local, CGNAT, multidiffusion, non spécifiée, 0.0.0.0/8, réservée (240/4). */
function isNonPublicIPv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224
  );
}

function embeddedIPv4(g: number[], hi: number, lo: number): number[] {
  return [g[hi]! >> 8, g[hi]! & 255, g[lo]! >> 8, g[lo]! & 255];
}

function isNonPublicIPv6(g: number[]): boolean {
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (g.every((x) => x === 0)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true; // fe80::/10, fec0::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8
  if (zeros(5) && g[5] === 0xffff) return isNonPublicIPv4(embeddedIPv4(g, 6, 7)); // ::ffff:a.b.c.d
  if (zeros(6)) return isNonPublicIPv4(embeddedIPv4(g, 6, 7)); // ::a.b.c.d (obsolète)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isNonPublicIPv4(embeddedIPv4(g, 6, 7)); // NAT64
  if (g[0] === 0x2002) return isNonPublicIPv4(embeddedIPv4(g, 1, 2)); // 6to4
  return false;
}

/** Adresse IP littérale (IPv4 ou IPv6 entre crochets) d'un réseau non public ; false pour un nom de domaine. */
export function isNonPublicIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(host);
  if (v4) return isNonPublicIPv4(v4);
  if (!host.includes(":")) return false;
  const v6 = parseIPv6(host);
  return v6 ? isNonPublicIPv6(v6) : true;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Motif du refus d'une adresse de webhook, ou null si elle est acceptable. */
export function webhookUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Adresse obligatoire";
  if (value.length > WEBHOOK_URL_MAX) return `${WEBHOOK_URL_MAX} caractères maximum`;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "L'adresse ne doit contenir ni espace ni caractère de contrôle";
  if (!/^https:\/\//i.test(value)) return "Adresse https:// obligatoire";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Adresse invalide";
  }
  if (url.protocol !== "https:") return "Adresse https:// obligatoire";
  if (url.username || url.password) return "Identifiants interdits dans l'adresse";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "Adresse invalide";
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return "Adresse publique obligatoire (ni localhost ni réseau local)";
  if (isNonPublicIpLiteral(host)) return "Adresse publique obligatoire (pas d'adresse IP privée ou réservée)";
  if (!host.startsWith("[") && !parseIPv4(host) && !host.includes(".")) return "Nom de domaine complet obligatoire (ex. www.mon-site.fr)";
  return null;
}

export const webhookUrlSchema = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const problem = webhookUrlProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const webhookSecretSchema = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9_.-]{${WEBHOOK_SECRET_MIN},${WEBHOOK_SECRET_MAX}}$`),
    `Secret : ${WEBHOOK_SECRET_MIN} à ${WEBHOOK_SECRET_MAX} caractères (lettres, chiffres, _ . -)`,
  );

/** Événements choisis, sans doublon ; absent, null ou vide = tous les événements. */
export const webhookEventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS, { error: "Événement inconnu" }))
  .max(50)
  .nullish()
  .transform((v) => [...new Set(v ?? [])]);

const webhookDescriptionSchema = z
  .string()
  .trim()
  .max(WEBHOOK_DESCRIPTION_MAX)
  .nullish()
  .transform((v) => v || null);

/**
 * Enregistrement d'une adresse (POST /api/v1/webhooks, Dashboard → Intégrations) : tout champ inconnu est refusé.
 * Même adresse déjà enregistrée : réglages mis à jour et webhook réactivé (svc_webhook_upsert).
 */
export const webhookUpsertSchema = z.strictObject({
  url: webhookUrlSchema,
  description: webhookDescriptionSchema,
  events: webhookEventsSchema,
  secret: webhookSecretSchema.nullish().transform((v) => v ?? null),
});
export type WebhookUpsertInput = z.input<typeof webhookUpsertSchema>;
export type WebhookUpsert = z.output<typeof webhookUpsertSchema>;

/** Code d'erreur de l'API selon le champ refusé (même code que la vérification en base). */
export const WEBHOOK_FIELD_ERROR_CODES: Record<string, string> = {
  url: "WEBHOOK_INVALID_URL",
  events: "WEBHOOK_INVALID_EVENTS",
  secret: "WEBHOOK_INVALID_SECRET",
};
