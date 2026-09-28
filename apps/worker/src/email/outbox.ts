// File des e-mails (public.email_outbox, migration 20260924005700) : private.claim_emails réserve un lot (SKIP LOCKED,
// bail de 5 min repris si l'expéditeur tombe), chaque ligne part en SMTP, private.complete_email enregistre le
// résultat. Réessais espacés côté SQL (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h) ; échec définitif au 8e essai ou
// sur un refus définitif de l'expéditeur, du destinataire ou du message (5xx), visible dans /admin/contacts.
// Envoi interrompu à répétition (expéditeur arrêté pendant l'envoi) : réglé en SQL, private.claim_emails passe la ligne
// en échec au lieu de la reprendre une 9e fois. Toute ligne réservée part donc ici, y compris un e-mail en échec remis
// en file par le super admin (nouvel essai, son compteur peut dépasser 8).
// Journal : identifiant, type et domaine du destinataire seulement — jamais l'objet, le corps ni l'adresse complète.
import { log } from "../config";
import type { Classified, OutboxEmail } from "./smtp";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** Lignes réservées par passage (private.claim_emails). */
export const CLAIM_BATCH = 10;
/** Même plafond que private.complete_email : à partir du 8e essai, un échec passe la ligne en « failed ». */
export const MAX_ATTEMPTS = 8;

export type Outcome =
  | { ok: true }
  | { ok: false; permanent: boolean; smtpDown: boolean; error: string; /** plus aucun essai (status 'failed') */ final: boolean };

export type CycleDeps = {
  query: QueryFn;
  send: (email: OutboxEmail) => Promise<unknown>;
  classify: (error: unknown) => Classified;
  /** Arrêt demandé : plus de nouveau lot (le lot réservé se termine). */
  shouldStop?: () => boolean;
  onOutcome?: (email: OutboxEmail, outcome: Outcome) => void;
};

export type CycleResult = { claimed: number; sent: number; retried: number; failed: number };

/** Domaine du destinataire, seule partie de l'adresse écrite au journal. */
export function recipientDomain(address: string): string {
  const at = (address || "").lastIndexOf("@");
  return at < 0 ? "?" : address.slice(at + 1).trim().toLowerCase() || "?";
}

/** Adresses masquées dans un texte destiné au journal (une réponse SMTP cite souvent le destinataire refusé). */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s<>()[\]"',;:@]+@(?=[^\s@])/g, "***@");
}

/** Envoie une ligne réservée puis enregistre le résultat ; une erreur de la base remonte (lot interrompu). */
export async function deliverEmail(email: OutboxEmail, deps: CycleDeps): Promise<Outcome> {
  const attempt = Number(email.attempts) || 0;
  let outcome: Outcome;
  try {
    await deps.send(email);
    outcome = { ok: true };
  } catch (error) {
    const c = deps.classify(error);
    outcome = { ok: false, permanent: c.permanent, smtpDown: c.smtpDown, error: c.message.slice(0, 500), final: c.permanent || attempt >= MAX_ATTEMPTS };
  }
  await deps.query("select private.complete_email($1::bigint, $2::boolean, $3::text, $4::boolean)", [
    email.id,
    outcome.ok,
    outcome.ok ? null : outcome.error,
    outcome.ok ? false : outcome.permanent,
  ]);
  const meta = { id: String(email.id), kind: email.kind, to_domain: recipientDomain(email.to_email), attempt };
  if (outcome.ok) log("info", "email sent", meta);
  else if (outcome.final) log("error", "email failed, no more retries", { ...meta, permanent: outcome.permanent, error: redactAddresses(outcome.error) });
  else log("warn", "email not sent, retry scheduled", { ...meta, error: redactAddresses(outcome.error) });
  deps.onOutcome?.(email, outcome);
  return outcome;
}

/** Un cycle : lots successifs jusqu'à vider la file des lignes prêtes (ou arrêt demandé). */
export async function runMailCycle(deps: CycleDeps): Promise<CycleResult> {
  const result: CycleResult = { claimed: 0, sent: 0, retried: 0, failed: 0 };
  while (!deps.shouldStop?.()) {
    const { rows } = await deps.query("select * from private.claim_emails($1::int)", [CLAIM_BATCH]);
    const emails = rows as OutboxEmail[];
    if (!emails.length) break;
    result.claimed += emails.length;
    // Envoi séquentiel : quelques e-mails par jour, et un serveur local qui n'aime pas les rafales
    for (const email of emails) {
      const outcome = await deliverEmail(email, deps);
      if (outcome.ok) result.sent++;
      else if (outcome.final) result.failed++;
      else result.retried++;
    }
    if (emails.length < CLAIM_BATCH) break;
  }
  return result;
}
