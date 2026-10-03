// Formulaire de contact public (/contact) : piège à robots → validation → limites de débit → demande enregistrée et
// e-mails mis en file, en une transaction (svc_contact_submit, service role). Aucun e-mail ne part d'ici : le service
// « mailer » du VPS lit la file (email_outbox) et l'envoie au serveur mail local (SMTP localhost:25).
import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import {
  contactAckEmail,
  contactNotifyEmail,
  contactRequestSchema,
  extractErrorCode,
  fieldErrors,
  humanizeError,
  type ContactRequestInput,
} from "@rydar/shared";
import { env, serverEnv } from "@/lib/env";
import { getLegalInfo } from "@/lib/legal";
import { rateLimit, rateLimitAll } from "@/lib/rate-limit";
import { clientIp, ipBucket } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

export type ContactInput = ContactRequestInput;
export type ContactResult =
  | { ok: true; ackQueued: boolean }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Offre publique proposée dans le formulaire (bouton « Choisir l'offre » de /tarifs). */
export type ContactPlan = { code: string; name: string };

const UNAVAILABLE = "Envoi impossible pour le moment. Réessayez dans un instant.";
const TOO_MANY = "Trop de demandes envoyées. Réessayez un peu plus tard.";
/** Destinataires de la notification au plus (liste d'adresses dans CONTACT_NOTIFY_EMAIL). */
const MAX_RECIPIENTS = 5;
/**
 * Accusés de réception par heure, toutes demandes confondues : ils partent vers des adresses saisies par des inconnus
 * (réputation de l'adresse IP du VPS). Au-delà, la demande est enregistrée et notifiée, sans accusé.
 */
const ACK_PER_HOUR = 30;

// Même règle que les contraintes de public.email_outbox (to_email, reply_to) : une seule adresse, sans espace, caractère
// de contrôle ni séparateur. Une adresse refusée par la base ferait échouer TOUTE la demande (enregistrement unique).
const OUTBOX_EMAIL = /^[^@]+@[^@]+\.[^@]+$/;
const OUTBOX_FORBIDDEN = /[\u{1}-\u{20}\u{7f}-\u{a0}\u{2028}\u{2029},;:<>()"\\]/u;

/** Adresse acceptée par la file d'envoi (public.email_outbox). */
export function isOutboxEmail(value: string): boolean {
  return value.length <= 254 && OUTBOX_EMAIL.test(value) && !OUTBOX_FORBIDDEN.test(value);
}

/**
 * Destinataires de la notification à partir d'une valeur de configuration : adresse seule, « Nom <adresse> » ou liste
 * séparée par des virgules ou points-virgules. Adresses invalides ignorées, doublons retirés, 5 au plus.
 */
export function parseRecipients(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(value ?? "").split(/[,;]/)) {
    const bracket = /<([^<>]*)>/.exec(part);
    const address = (bracket ? bracket[1]! : part).trim().toLowerCase();
    if (address && isOutboxEmail(address) && !out.includes(address)) out.push(address);
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

/**
 * Offres publiques et actives (code, nom), pour le choix de l'offre et le nom affiché dans la notification. Base
 * injoignable ou lente (4 s au plus) : aucune offre, le formulaire reste utilisable.
 */
export async function loadContactPlans(): Promise<ContactPlan[]> {
  try {
    const { data, error } = await createAdminClient()
      .from("plans")
      .select("code, name")
      .eq("is_active", true)
      .eq("is_public", true)
      .order("sort_order")
      .abortSignal(AbortSignal.timeout(4000));
    if (error) return [];
    return ((data ?? []) as ContactPlan[]).filter((p) => typeof p.code === "string" && typeof p.name === "string");
  } catch {
    return [];
  }
}

/**
 * Destinataires des demandes : CONTACT_NOTIFY_EMAIL, sinon e-mail de contact (/admin/legal, puis LEGAL_EMAIL).
 * Configuration invalide : liste vide (la demande reste enregistrée et visible dans /admin/contacts).
 */
export async function contactRecipients(): Promise<string[]> {
  const configured = parseRecipients(serverEnv().contactNotifyEmail);
  if (configured.length) return configured;
  const legal = await getLegalInfo().catch(() => null);
  return parseRecipients(legal?.email);
}

/** Empreinte de l'adresse IP (seau IPv4 / IPv6 /64) : repérer les abus sans garder l'adresse en clair. */
function ipHash(ip: string): string {
  const key = serverEnv().apiKeyPepper || "rydar-contact";
  return createHmac("sha256", key).update(`contact:${ipBucket(ip)}`).digest("hex");
}

type QueuedEmail = { kind: "contact_notify" | "contact_ack"; to_email: string; reply_to: string | null; subject: string; body_text: string };

export async function submitContactRequest(input: ContactInput): Promise<ContactResult> {
  // Piège à robots : champ caché rempli → faux succès, rien n'est enregistré ni envoyé
  if (typeof input?.website === "string" && input.website.trim() !== "") return { ok: true, ackQueued: false };

  const parsed = contactRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs signalés.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;

  // Limites : par adresse IP, par adresse e-mail, puis plafond global (dans cet ordre : une IP bloquée n'use pas le reste)
  const ip = await clientIp();
  const limit = await rateLimitAll([
    { key: `contact:ip:${ipBucket(ip)}`, limit: 5, windowSec: 3600 },
    { key: `contact:email:${v.email}`, limit: 3, windowSec: 86_400 },
    { key: "contact:all", limit: 200, windowSec: 3600 },
  ]);
  if (!limit.ok) return { ok: false, error: TOO_MANY };

  // Offre visée : seulement une offre publique et active (sinon ignorée) ; taille de flotte : demandes de tarif
  let planCode: string | null = null;
  let planName: string | undefined;
  if (v.topic === "pricing" && v.planCode) {
    const plan = (await loadContactPlans()).find((p) => p.code === v.planCode);
    if (plan) {
      planCode = plan.code;
      planName = plan.name;
    }
  }
  const fleetSize = v.topic === "pricing" ? v.fleetSize ?? null : null;

  const id = randomUUID();
  // Adresse du site : configuration (NEXT_PUBLIC_APP_URL), jamais l'en-tête Host de la requête
  const appUrl = env.appUrl;
  const recipients = await contactRecipients();
  const emails: QueuedEmail[] = [];
  if (recipients.length) {
    // Notification sans donnée personnelle (sujet, offre, lien) ni Reply-To : la demande se lit et se traite dans
    // /admin/contacts, d'où partent les réponses (purgées avec elle) ; rien de la demande dans la messagerie de l'admin
    const notify = contactNotifyEmail({ id, topic: v.topic, planCode }, { appUrl, planName });
    for (const to of recipients) {
      emails.push({ kind: "contact_notify", to_email: to, reply_to: null, subject: notify.subject, body_text: notify.text });
    }
  } else {
    console.warn("[contact] aucun destinataire valide : renseignez CONTACT_NOTIFY_EMAIL ou l'e-mail de contact dans /admin/legal");
  }
  // Accusé de réception au contenu fixe (aucune donnée saisie) : le formulaire ne peut pas servir à écrire à un tiers.
  // Au-delà du plafond horaire, la demande part sans accusé.
  if ((await rateLimit("contact:ack", ACK_PER_HOUR, 3600)).ok) {
    const ack = contactAckEmail({ appUrl });
    emails.push({ kind: "contact_ack", to_email: v.email, reply_to: recipients[0] ?? null, subject: ack.subject, body_text: ack.text });
  }

  const request = {
    id,
    topic: v.topic,
    plan_code: planCode,
    name: v.name,
    company: v.company ?? null,
    email: v.email,
    phone: v.phone ?? null,
    fleet_size: fleetSize,
    message: v.message,
    ip_hash: ipHash(ip),
  };
  try {
    const { data, error } = await createAdminClient().rpc("svc_contact_submit", { p_request: request, p_emails: emails });
    if (error) {
      if (extractErrorCode(error.message) === "CONTACT_BUSY") return { ok: false, error: humanizeError(error.message, TOO_MANY) };
      // CONTACT_INVALID malgré la validation ci-dessus : configuration (destinataire) ou contrainte à revoir
      console.error("[contact] enregistrement impossible", error.message);
      return { ok: false, error: UNAVAILABLE };
    }
    const res = (data ?? {}) as { ok?: boolean; ack_queued?: boolean };
    if (!res.ok) return { ok: false, error: UNAVAILABLE };
    return { ok: true, ackQueued: !!res.ack_queued };
  } catch (e) {
    console.error("[contact] enregistrement impossible", e instanceof Error ? e.message : e);
    return { ok: false, error: UNAVAILABLE };
  }
}
