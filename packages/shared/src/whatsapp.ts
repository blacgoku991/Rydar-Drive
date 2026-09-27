// WhatsApp Business Cloud API (Meta) : envoi de messages « modèles » (templates) validés par Meta.
// Utilisé par le worker (relances automatiques) et par le web (vérification du numéro, message test).
// Aucune dépendance : fetch standard (Node 18+, navigateurs, React Native).
import { z } from "zod";

/** Version de l'API Graph (surchargeable : WHATSAPP_API_VERSION). */
export const WHATSAPP_API_VERSION = "v23.0";
export const WHATSAPP_GRAPH_URL = "https://graph.facebook.com";

/** Modèles à créer dans le Gestionnaire WhatsApp (catégorie Utilité, langue Français) — textes : docs/WHATSAPP.md */
export const WHATSAPP_TEMPLATES = {
  /** Centrale → chauffeur : {{1}} prénom, {{2}} montant, {{3}} centrale, {{4}} « 2 courses » */
  driver: {
    name: "rappel_commission",
    variables: 4,
    text: "Bonjour {{1}}, vous avez {{2}} de commission à régler à {{3}} ({{4}}). Réglez depuis l'application Rydar Drive, onglet Commissions.",
    sample: ["Karim", "19 €", "NovaLink", "2 courses"],
  },
  /** Rydar → propriétaire de la centrale : {{1}} centrale, {{2}} montant, {{3}} échéance */
  platform: {
    name: "rappel_frais_plateforme",
    variables: 3,
    text: "Bonjour, les frais plateforme Rydar Drive de {{1}} s'élèvent à {{2}} (échéance {{3}}). Détails et paiement : tableau de bord, onglet Encaissements.",
    sample: ["NovaLink", "182,40 €", "05/10/2026"],
  },
} as const;

export type WhatsAppSendInput = {
  phoneNumberId: string;
  token: string;
  /** Chiffres avec indicatif, sans « + » (33612345678) */
  to: string;
  template: string;
  language: string;
  params: string[];
  apiVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type WhatsAppFailure = { ok: false; status: number; code: number | null; error: string; retryable: boolean };
export type WhatsAppSendResult = { ok: true; messageId: string | null } | WhatsAppFailure;
export type WhatsAppNumberInfo = { ok: true; displayPhone: string | null; verifiedName: string | null; quality: string | null } | WhatsAppFailure;

/** Une variable de modèle : ni retour à la ligne, ni tabulation, ni plus de 4 espaces consécutifs. */
export function whatsappParam(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200) || "-";
}

/** Corps de la requête « envoyer un modèle ». */
export function whatsappTemplatePayload(to: string, template: string, language: string, params: string[]) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: language },
      ...(params.length
        ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: whatsappParam(p) })) }] }
        : {}),
    },
  };
}

// Codes d'erreur Meta : https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
const ERROR_MESSAGES: Record<number, string> = {
  0: "Authentification refusée : vérifiez le jeton d'accès",
  3: "Autorisation manquante sur le jeton (whatsapp_business_messaging)",
  10: "Autorisation refusée : le jeton n'a pas accès à ce numéro",
  100: "Paramètre refusé par Meta : vérifiez l'identifiant du numéro (Phone Number ID)",
  190: "Jeton d'accès expiré ou invalide : créez un jeton permanent (utilisateur système)",
  200: "Autorisation refusée : le jeton n'a pas accès à ce numéro",
  368: "Compte temporairement bloqué par Meta (règles de la plateforme)",
  131026: "Message non remis : le destinataire n'a peut-être pas WhatsApp",
  131030: "Numéro destinataire non autorisé : en mode test, ajoutez-le à la liste des destinataires dans Meta",
  131031: "Compte WhatsApp Business bloqué ou désactivé par Meta",
  131042: "Problème de paiement du compte WhatsApp Business (moyen de paiement Meta)",
  131045: "Numéro non enregistré : certificat du numéro manquant",
  131047: "Fenêtre de 24 h dépassée : seul un modèle validé peut être envoyé",
  131051: "Type de message non pris en charge",
  132000: "Nombre de variables incorrect : le modèle doit avoir exactement les variables prévues",
  132001: "Modèle introuvable : vérifiez son nom, sa langue et qu'il est approuvé par Meta",
  132005: "Texte du modèle trop long une fois les variables remplacées",
  132007: "Modèle refusé par Meta (contenu non conforme)",
  132012: "Format des variables du modèle incorrect",
  132015: "Modèle mis en pause par Meta (qualité faible)",
  132016: "Modèle désactivé par Meta",
  133010: "Numéro WhatsApp Business non enregistré sur l'API Cloud",
  1: "Erreur temporaire de Meta : nouvel essai automatique",
  2: "Service Meta momentanément indisponible : nouvel essai automatique",
  4: "Limite d'appels atteinte : nouvel essai automatique",
  80007: "Limite d'envoi atteinte : nouvel essai automatique",
  130429: "Limite de débit atteinte : nouvel essai automatique",
  131048: "Limite anti-spam atteinte : nouvel essai automatique",
  131056: "Trop de messages vers ce numéro : nouvel essai automatique",
};

/** Réponse d'erreur de l'API Graph → message français, code Meta, reprise possible ou non. */
export function classifyWhatsAppError(status: number, body: unknown): WhatsAppFailure {
  const err = (body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : null) ?? null;
  const code = typeof err?.code === "number" ? err.code : null;
  const detail = typeof (err?.error_data as { details?: unknown } | undefined)?.details === "string"
    ? String((err!.error_data as { details: string }).details)
    : typeof err?.message === "string" ? String(err.message) : "";
  const retryable = status >= 500 || status === 429 || (code != null && RETRYABLE_CODES.has(code));
  const known = code != null ? ERROR_MESSAGES[code] : undefined;
  const base = known ?? (status >= 500 ? "Service Meta indisponible" : detail ? `Refus de Meta : ${detail}` : `Erreur Meta (HTTP ${status})`);
  return { ok: false, status, code, retryable, error: code != null ? `${base} (code ${code})` : base };
}

async function graph(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch): Promise<{ status: number; body: unknown } | WhatsAppFailure> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    return { ok: false, status: 0, code: null, retryable: true, error: aborted ? "Meta ne répond pas (délai dépassé)" : `Réseau : ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Envoie un modèle. Jamais d'exception : échec → { ok: false, retryable }. */
export async function sendWhatsAppTemplate(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
  const version = input.apiVersion || WHATSAPP_API_VERSION;
  const r = await graph(
    `${WHATSAPP_GRAPH_URL}/${version}/${encodeURIComponent(input.phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify(whatsappTemplatePayload(input.to, input.template, input.language, input.params)),
    },
    input.timeoutMs ?? 10_000,
    input.fetchImpl ?? fetch,
  );
  if ("ok" in r) return r;
  if (r.status >= 200 && r.status < 300) {
    const id = (r.body as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id ?? null;
    return { ok: true, messageId: id };
  }
  return classifyWhatsAppError(r.status, r.body);
}

/** Vérifie le couple identifiant du numéro + jeton (numéro affiché, nom vérifié, qualité). */
export async function checkWhatsAppNumber(input: { phoneNumberId: string; token: string; apiVersion?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<WhatsAppNumberInfo> {
  const version = input.apiVersion || WHATSAPP_API_VERSION;
  const r = await graph(
    `${WHATSAPP_GRAPH_URL}/${version}/${encodeURIComponent(input.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
    { method: "GET", headers: { authorization: `Bearer ${input.token}` } },
    input.timeoutMs ?? 8_000,
    input.fetchImpl ?? fetch,
  );
  if ("ok" in r) return r;
  if (r.status >= 200 && r.status < 300) {
    const b = (r.body ?? {}) as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
    return { ok: true, displayPhone: b.display_phone_number ?? null, verifiedName: b.verified_name ?? null, quality: b.quality_rating ?? null };
  }
  return classifyWhatsAppError(r.status, r.body);
}

/** Réglages WhatsApp (centrale ou Rydar). Jeton vide = jeton déjà enregistré conservé. */
export const whatsappConfigSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^[0-9]{5,30}$/, "Identifiant du numéro : chiffres uniquement (Phone Number ID)"),
  token: z.union([z.literal(""), z.null(), z.undefined(), z.string().trim().min(20, "Jeton d'accès trop court").max(2048)])
    .transform((v) => (v ? v : null)),
  template: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Nom du modèle : minuscules, chiffres et _ uniquement"),
  language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Langue : code Meta, ex. fr"),
  enabled: z.boolean(),
});
export type WhatsAppConfigInput = z.output<typeof whatsappConfigSchema>;

/** Canaux des relances chauffeur : application, WhatsApp, ou les deux. */
export const REMINDER_CHANNELS = ["app", "whatsapp"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];
export const reminderChannelsSchema = z.array(z.enum(REMINDER_CHANNELS)).min(1, "Choisissez au moins un canal").max(2);
