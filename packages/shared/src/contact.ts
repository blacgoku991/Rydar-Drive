// Formulaire de contact du site vitrine (/contact) : sujets, libellés, validation et modèles d'e-mails (texte brut).
// Enregistrement : public.svc_contact_submit (migration 20260924005700_contact_requests) ; envoi : file
// public.email_outbox, lue par le service « mailer » (SMTP du serveur mail du VPS).
// Anti-abus : l'accusé de réception part vers une adresse saisie par un inconnu → contenu FIXE, sans aucune donnée
// saisie dans le formulaire (le formulaire ne peut pas servir à écrire à un tiers).
import { z } from "zod";
import type { Tone } from "./domain";
import { normalizePhone } from "./format";

const NBSP = "\u{a0}";

// -----------------------------------------------------------------------------
// Sujets, tailles de flotte, statuts (miroir des contraintes SQL)
// -----------------------------------------------------------------------------
export const CONTACT_TOPICS = ["pricing", "question", "partnership", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** Paramètre d'URL « ?sujet= » → sujet (« Demander un tarif » : /contact?sujet=tarif, offre : &offre=<code>). */
export const CONTACT_TOPIC_PARAM = {
  tarif: "pricing",
  question: "question",
  partenariat: "partnership",
  autre: "other",
} as const satisfies Record<string, ContactTopic>;
export type ContactTopicParam = keyof typeof CONTACT_TOPIC_PARAM;

export const CONTACT_TOPIC_META: Record<ContactTopic, { label: string; param: ContactTopicParam }> = {
  pricing: { label: "Demande de tarif", param: "tarif" },
  question: { label: "Question sur Rydar Drive", param: "question" },
  partnership: { label: "Partenariat", param: "partenariat" },
  other: { label: "Autre demande", param: "autre" },
};

export const FLEET_SIZES = ["1-5", "6-20", "21-50", "51+"] as const;
export type FleetSize = (typeof FLEET_SIZES)[number];

export const FLEET_SIZE_META: Record<FleetSize, { label: string }> = {
  "1-5": { label: "1 à 5 chauffeurs" },
  "6-20": { label: "6 à 20 chauffeurs" },
  "21-50": { label: "21 à 50 chauffeurs" },
  "51+": { label: "Plus de 50 chauffeurs" },
};

export const CONTACT_STATUSES = ["new", "in_progress", "done", "spam"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_META: Record<ContactStatus, { label: string; tone: Tone }> = {
  new: { label: "Nouvelle", tone: "amber" },
  in_progress: { label: "En cours", tone: "blue" },
  done: { label: "Traitée", tone: "green" },
  spam: { label: "Indésirable", tone: "neutral" },
};

export const EMAIL_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_STATUS_META: Record<EmailStatus, { label: string; tone: Tone }> = {
  pending: { label: "En attente", tone: "amber" },
  sending: { label: "Envoi en cours", tone: "blue" },
  sent: { label: "Envoyé", tone: "green" },
  failed: { label: "Échec", tone: "red" },
};

/** Types de public.email_outbox (dernière contrainte : 20260924006600, annonces aux organisations). */
export const EMAIL_KINDS = ["contact_notify", "contact_ack", "contact_reply", "test", "platform_fee_change", "org_terms_update"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const EMAIL_KIND_META: Record<EmailKind, { label: string }> = {
  contact_notify: { label: "Notification admin" },
  contact_ack: { label: "Accusé de réception" },
  contact_reply: { label: "Réponse" },
  test: { label: "E-mail de test" },
  platform_fee_change: { label: "Frais Rydar par course" },
  org_terms_update: { label: "Nouvelles CGV" },
};

/** Longueurs maximales (contraintes de public.contact_requests et public.email_outbox) : attributs maxLength. */
export const CONTACT_LIMITS = {
  name: 120,
  company: 160,
  email: 254,
  phone: 40,
  messageMin: 10,
  message: 5000,
  planCode: 40,
  adminNote: 5000,
  reply: 10000,
  subject: 200,
  body: 20000,
} as const;

/** Ligne de public.contact_requests telle que renvoyée par supabase-js (dates ISO). Lecture : super admin. */
export type ContactRequestRow = {
  id: string;
  created_at: string;
  updated_at: string;
  topic: ContactTopic;
  plan_code: string | null;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  fleet_size: FleetSize | null;
  message: string;
  status: ContactStatus;
  admin_note: string | null;
  handled_by: string | null;
  handled_at: string | null;
  ip_hash: string | null;
};

/** Ligne de public.email_outbox telle que renvoyée par supabase-js (node-postgres renvoie l'id bigint en texte). */
export type EmailOutboxRow = {
  id: number;
  created_at: string;
  kind: EmailKind;
  contact_request_id: string | null;
  to_email: string;
  reply_to: string | null;
  subject: string;
  body_text: string;
  status: EmailStatus;
  attempts: number;
  next_attempt_at: string;
  locked_until: string | null;
  sent_at: string | null;
  last_error: string | null;
  created_by: string | null;
};

/** « ?sujet=tarif » → « pricing » ; absent ou inconnu → undefined (jamais une clé héritée comme « constructor »). */
export function contactTopicFromParam(param: string | string[] | null | undefined): ContactTopic | undefined {
  const value = (Array.isArray(param) ? param[0] : param)?.trim().toLowerCase();
  if (!value || !Object.prototype.hasOwnProperty.call(CONTACT_TOPIC_PARAM, value)) return undefined;
  return CONTACT_TOPIC_PARAM[value as ContactTopicParam];
}

const PLAN_CODE_RE = /^[a-z0-9_-]{1,40}$/;

/** Lien vers le formulaire : contactHref("pricing", "pro") → « /contact?sujet=tarif&offre=pro » (code invalide ignoré). */
export function contactHref(topic?: ContactTopic, planCode?: string | null): string {
  const params: string[] = [];
  if (topic) params.push(`sujet=${CONTACT_TOPIC_META[topic].param}`);
  const plan = planCode?.trim().toLowerCase();
  if (plan && PLAN_CODE_RE.test(plan)) params.push(`offre=${plan}`);
  return params.length ? `/contact?${params.join("&")}` : "/contact";
}

// -----------------------------------------------------------------------------
// Validation (formulaire public /contact)
// -----------------------------------------------------------------------------
/** Caractère de contrôle (C0, DEL, C1) ou séparateur de ligne Unicode : interdit dans un champ d'une ligne (même règle en SQL). */
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;
const noControlChar = (value: string) => !CONTROL_CHAR.test(value);
/** Longueur comptée comme PostgreSQL (char_length) : en caractères, pas en unités UTF-16 (un émoji = 1). */
const codePoints = (value: string) => Array.from(value).length;

/** Texte de plusieurs lignes : fins de ligne unifiées, caractères de contrôle retirés (sauf tabulation et retour à la ligne). */
function cleanMultiline(value: string): string {
  return value
    .replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
}

/** Champ facultatif d'une ligne : vide → undefined. */
const optionalLine = (max: number) =>
  z
    .string({ error: "Valeur invalide" })
    .trim()
    .max(max, `${max} caractères maximum`)
    .refine(noControlChar, "Caractères non autorisés")
    .nullish()
    .transform((v) => v || undefined);

export const contactRequestSchema = z.object({
  topic: z.enum(CONTACT_TOPICS, { error: "Choisissez le sujet de votre demande" }),
  /** Offre choisie sur /tarifs (paramètre « offre » de l'URL, champ caché) : ignorée si invalide. */
  planCode: z.string().trim().toLowerCase().regex(PLAN_CODE_RE).optional().catch(undefined),
  name: z
    .string({ error: "Indiquez votre nom" })
    .trim()
    .min(1, "Indiquez votre nom")
    .refine((v) => codePoints(v) >= 2, "2 caractères minimum")
    .max(CONTACT_LIMITS.name, `${CONTACT_LIMITS.name} caractères maximum`)
    .refine(noControlChar, "Caractères non autorisés"),
  company: optionalLine(CONTACT_LIMITS.company),
  email: z
    .string({ error: "Indiquez votre adresse e-mail" })
    .trim()
    .min(1, "Indiquez votre adresse e-mail")
    .max(CONTACT_LIMITS.email, `${CONTACT_LIMITS.email} caractères maximum`)
    .toLowerCase()
    .pipe(z.email("Adresse e-mail invalide")),
  /** Facultatif ; enregistré au format international (+33612345678). */
  phone: z
    .string({ error: "Numéro de téléphone invalide" })
    .trim()
    .max(CONTACT_LIMITS.phone, `${CONTACT_LIMITS.phone} caractères maximum`)
    .nullish()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const e164 = normalizePhone(value);
      if (!e164) {
        ctx.addIssue({ code: "custom", message: "Numéro de téléphone invalide" });
        return z.NEVER;
      }
      return e164;
    }),
  fleetSize: z
    .union([z.enum(FLEET_SIZES), z.literal("")], { error: "Choisissez la taille de votre flotte" })
    .nullish()
    .transform((v) => v || undefined),
  message: z
    .string({ error: "Écrivez votre message" })
    .transform(cleanMultiline)
    .pipe(
      z
        .string()
        .min(1, "Écrivez votre message")
        .refine((v) => codePoints(v) >= CONTACT_LIMITS.messageMin, "Message trop court (10 caractères minimum)")
        .max(CONTACT_LIMITS.message, `${CONTACT_LIMITS.message} caractères maximum`),
    ),
  /** Piège à robots (champ caché, laissé vide par un humain) : rempli → le web répond « envoyé » sans rien enregistrer. */
  website: z
    .string()
    .nullish()
    .transform((v) => v?.trim().slice(0, 200) || undefined),
});
export type ContactRequestInput = z.input<typeof contactRequestSchema>;
export type ContactRequestData = z.output<typeof contactRequestSchema>;

/** Réponse du super admin à une demande (/admin/contacts/<id>) : envoyée telle quelle, suivie de la signature. */
export const contactReplySchema = z.object({
  message: z
    .string({ error: "Écrivez votre réponse" })
    .transform(cleanMultiline)
    .pipe(
      z
        .string()
        .min(1, "Écrivez votre réponse")
        .max(CONTACT_LIMITS.reply, `${CONTACT_LIMITS.reply} caractères maximum`),
    ),
});

// -----------------------------------------------------------------------------
// E-mails (texte brut, typographie française)
// -----------------------------------------------------------------------------
export type EmailContent = { subject: string; text: string };

/** Demande enregistrée : sortie de contactRequestSchema + identifiant choisi par le web (lien de la notification). */
export type ContactNotifyRequest = {
  id: string;
  topic: ContactTopic;
  name: string;
  email: string;
  message: string;
  planCode?: string | null;
  company?: string | null;
  phone?: string | null;
  fleetSize?: FleetSize | null;
};

export const CONTACT_REPLY_SUBJECT = "Votre demande à Rydar Drive";

/**
 * Texte sûr pour un en-tête ou un sujet d'e-mail : retours à la ligne, tabulations et caractères de contrôle remplacés
 * par une espace (aucun en-tête injecté), marques de direction du texte retirées, espaces répétées réduites, puis
 * tronqué à `max` caractères (« … » final). Les espaces insécables sont gardées.
 */
export function sanitizeHeaderText(value: string | null | undefined, max: number = CONTACT_LIMITS.subject): string {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu, " ")
    .replace(/[\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  if (max < 1) return "";
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Adresse du site sans barre finale (« https://app.rydar.app/ » → « https://app.rydar.app »). */
const siteUrl = (appUrl: string) => appUrl.trim().replace(/\/+$/, "");

/** Corps d'e-mail borné (public.email_outbox.body_text : 20 000 caractères). */
function clipBody(text: string): string {
  const chars = Array.from(text);
  return chars.length <= CONTACT_LIMITS.body ? text : `${chars.slice(0, CONTACT_LIMITS.body - 1).join("")}…`;
}

/**
 * Notification au super admin (destinataire : CONTACT_NOTIFY_EMAIL, une boîte de messagerie hors du serveur, que la
 * purge des demandes n'atteint pas) : AUCUNE donnée personnelle de la demande (ni nom, ni société, ni e-mail, ni
 * téléphone, ni message), seulement le sujet, l'offre visée, une référence et le lien vers la demande dans
 * /admin/contacts, où l'on lit et répond (minimisation, RGPD art. 5.1.c et 5.1.e). Sujet distinct par demande
 * (référence courte) : les messageries ne regroupent pas des demandes différentes dans une même conversation. Le web
 * l'envoie sans Reply-To.
 */
export function contactNotifyEmail(
  req: Pick<ContactNotifyRequest, "id" | "topic"> & Partial<Pick<ContactNotifyRequest, "planCode">>,
  opts: { appUrl: string; planName?: string | null },
): EmailContent {
  const topic = CONTACT_TOPIC_META[req.topic]?.label ?? "Autre demande";
  const ref = sanitizeHeaderText(req.id, 64).replace(/[^0-9a-z]/gi, "").slice(0, 8);
  const subject = sanitizeHeaderText(`Nouvelle demande de contact — ${topic}${ref ? ` (réf. ${ref})` : ""}`);
  const plan = sanitizeHeaderText(opts.planName, 120) || sanitizeHeaderText(req.planCode, CONTACT_LIMITS.planCode);
  const field = (label: string, value: string | undefined) => `${label}${NBSP}: ${value || "—"}`;
  const text = [
    "Nouvelle demande de contact reçue sur le site Rydar Drive.",
    "",
    field("Sujet", topic),
    field("Offre", plan),
    field("Référence", ref),
    "",
    `Lire la demande et y répondre${NBSP}:`,
    `${siteUrl(opts.appUrl)}/admin/contacts/${encodeURIComponent(req.id)}`,
    "",
    `Les coordonnées et le message ne figurent pas dans cet e-mail${NBSP}: ils restent dans l'espace d'administration, supprimés avec la demande. Répondez depuis cet espace.`,
    "",
    "-- ",
    "E-mail automatique du formulaire de contact de Rydar Drive.",
  ].join("\n");
  return { subject, text: clipBody(text) };
}

/** Accusé de réception au demandeur : contenu FIXE (aucune donnée saisie), un seul par adresse et par 24 h (SQL). */
export function contactAckEmail(opts: { appUrl: string }): EmailContent {
  return {
    subject: "Votre demande à Rydar Drive a bien été reçue",
    text: [
      "Bonjour,",
      "",
      `Merci pour votre message${NBSP}: nous l'avons bien reçu et notre équipe vous répondra à cette adresse dans les meilleurs délais.`,
      "",
      "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.",
      "",
      "L'équipe Rydar Drive",
      siteUrl(opts.appUrl),
      "",
      "Ce message a été envoyé automatiquement.",
    ].join("\n"),
  };
}

/** Réponse du super admin : son texte (fins de ligne unifiées) suivi de la signature. */
export function contactReplyEmail(message: string, opts: { appUrl: string }): EmailContent {
  return {
    subject: CONTACT_REPLY_SUBJECT,
    text: clipBody([cleanMultiline(message), "", "-- ", "L'équipe Rydar Drive", siteUrl(opts.appUrl)].join("\n")),
  };
}

/** E-mail de test (/admin/contacts) : vérifie la chaîne d'envoi (file, mailer, serveur mail du VPS). */
export function testEmail(opts: { appUrl: string }): EmailContent {
  return {
    subject: "E-mail de test — Rydar Drive",
    text: [
      "Bonjour,",
      "",
      "Ceci est un e-mail de test envoyé depuis le panneau d'administration de Rydar Drive.",
      "",
      `S'il vous est parvenu, l'envoi des e-mails fonctionne${NBSP}: notifications des demandes de contact, accusés de réception et réponses partent par le même serveur d'envoi.`,
      "",
      `Demandes de contact${NBSP}: ${siteUrl(opts.appUrl)}/admin/contacts`,
      "",
      "L'équipe Rydar Drive",
    ].join("\n"),
  };
}
