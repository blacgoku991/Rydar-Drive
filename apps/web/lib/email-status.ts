// Suivi d'un e-mail de la file (public.email_outbox) en une ligne, pour /admin/contacts et la fiche d'une demande.
import { formatDate, formatTime } from "@rydar/shared";

export type OutboxEmailRow = {
  status: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string | null;
};

const dateTime = (d: string) => `${formatDate(d)} à ${formatTime(d)}`;
const tries = (n: number) => `${n} essai${n > 1 ? "s" : ""}`;

/** « Envoyé le … », « 2 essais · prochain le … », « En file depuis le … »… */
export function emailProgress(e: OutboxEmailRow, now = Date.now()): string {
  if (e.status === "sent") return e.sent_at ? `Envoyé le ${dateTime(e.sent_at)}` : "Envoyé";
  if (e.status === "failed") return `Échec après ${tries(e.attempts)}`;
  if (e.status === "sending") return "Envoi en cours";
  const next = e.next_attempt_at ? new Date(e.next_attempt_at).getTime() : 0;
  if (e.attempts > 0) {
    return next > now ? `${tries(e.attempts)} · prochain le ${dateTime(e.next_attempt_at!)}` : `${tries(e.attempts)} · nouvel essai dès que possible`;
  }
  return `En file depuis le ${dateTime(e.created_at)}`;
}
