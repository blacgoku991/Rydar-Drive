// Test d'éligibilité Flotte Privée (eligibilite.<domaine>, /eligibilite) : piège à robots → validation → limites de
// débit → demande de contact (sujet « eligibility ») et e-mails mis en file, en une transaction (svc_contact_submit,
// comme le formulaire /contact). Aucun e-mail ne part d'ici : le service « mailer » lit la file (email_outbox).
import "server-only";
import { randomUUID } from "node:crypto";
import {
  contactAckEmail,
  contactNotifyEmail,
  eligibilityMessage,
  eligibilitySchema,
  eligibilityVerdict,
  extractErrorCode,
  fieldErrors,
  humanizeError,
  type EligibilityInput,
  type EligibilityVerdict,
} from "@rydar/shared";
import { contactRecipients, ipHash, type QueuedEmail } from "@/lib/contact";
import { env } from "@/lib/env";
import { rateLimit, rateLimitAll } from "@/lib/rate-limit";
import { clientIp, ipBucket } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

export type EligibilityFormInput = EligibilityInput & { website?: string };
export type EligibilityResult =
  | { ok: true; verdict: EligibilityVerdict }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const UNAVAILABLE = "Envoi impossible pour le moment. Réessaie dans un instant.";
const TOO_MANY = "Trop de demandes envoyées. Réessaie un peu plus tard.";
/** Accusés de réception par heure, toutes demandes confondues (même règle que /contact). */
const ACK_PER_HOUR = 30;

export async function submitEligibility(input: EligibilityFormInput): Promise<EligibilityResult> {
  // Piège à robots : champ caché rempli → faux succès, rien n'est enregistré ni envoyé
  if (typeof input?.website === "string" && input.website.trim() !== "") return { ok: true, verdict: "to_discuss" };

  const parsed = eligibilitySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifie les champs signalés.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const { verdict } = eligibilityVerdict(v);

  // Limites : par adresse IP, par adresse e-mail, puis plafond global
  const ip = await clientIp();
  const limit = await rateLimitAll([
    { key: `eligibility:ip:${ipBucket(ip)}`, limit: 5, windowSec: 3600 },
    { key: `eligibility:email:${v.email}`, limit: 3, windowSec: 86_400 },
    { key: "eligibility:all", limit: 200, windowSec: 3600 },
  ]);
  if (!limit.ok) return { ok: false, error: TOO_MANY };

  const id = randomUUID();
  // Adresse du site : configuration (NEXT_PUBLIC_APP_URL), jamais l'en-tête Host de la requête
  const appUrl = env.appUrl;
  const recipients = await contactRecipients();
  const emails: QueuedEmail[] = [];
  if (recipients.length) {
    // Notification sans donnée personnelle (sujet, référence, lien vers /admin/contacts)
    const notify = contactNotifyEmail({ id, topic: "eligibility" }, { appUrl });
    for (const to of recipients) {
      emails.push({ kind: "contact_notify", to_email: to, reply_to: null, subject: notify.subject, body_text: notify.text });
    }
  } else {
    console.warn("[eligibilite] aucun destinataire valide : renseignez CONTACT_NOTIFY_EMAIL ou l'e-mail de contact dans /admin/legal");
  }
  // Accusé de réception au contenu fixe (aucune donnée saisie)
  if ((await rateLimit("contact:ack", ACK_PER_HOUR, 3600)).ok) {
    const ack = contactAckEmail({ appUrl });
    emails.push({ kind: "contact_ack", to_email: v.email, reply_to: recipients[0] ?? null, subject: ack.subject, body_text: ack.text });
  }

  const request = {
    id,
    topic: "eligibility",
    plan_code: null,
    name: v.name,
    company: null,
    email: v.email,
    phone: v.phone,
    fleet_size: null,
    message: eligibilityMessage(v),
    ip_hash: ipHash(ip),
  };
  try {
    const { data, error } = await createAdminClient().rpc("svc_contact_submit", { p_request: request, p_emails: emails });
    if (error) {
      if (extractErrorCode(error.message) === "CONTACT_BUSY") return { ok: false, error: humanizeError(error.message, TOO_MANY) };
      console.error("[eligibilite] enregistrement impossible", error.message);
      return { ok: false, error: UNAVAILABLE };
    }
    const res = (data ?? {}) as { ok?: boolean };
    if (!res.ok) return { ok: false, error: UNAVAILABLE };
    return { ok: true, verdict };
  } catch (e) {
    console.error("[eligibilite] enregistrement impossible", e instanceof Error ? e.message : e);
    return { ok: false, error: UNAVAILABLE };
  }
}
