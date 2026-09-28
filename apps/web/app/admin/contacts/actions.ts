"use server";
// Super admin : demandes du formulaire de contact (/contact). Lecture par RLS (pages) ; écritures par le service role
// après requireSuperAdmin(), journalisées (audit). Les e-mails sont seulement mis en file (email_outbox) : le service
// « mailer » du VPS les envoie au serveur mail local (SMTP localhost:25), avec réessais.
import { CONTACT_LIMITS, CONTACT_STATUSES, contactReplyEmail, contactReplySchema, testEmail } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth";
import { contactRecipients } from "@/lib/contact";
import { env } from "@/lib/env";
import { actionError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> };

const uuid = z.string().uuid();
const NOT_FOUND = "Demande introuvable.";

const statusSchema = z.object({
  status: z.enum(CONTACT_STATUSES, { error: "Statut invalide." }),
  note: z.string().trim().max(CONTACT_LIMITS.adminNote, "5 000 caractères au maximum."),
});
const emailSchema = z.string().trim().toLowerCase().max(254, "254 caractères au maximum.").email("Adresse e-mail invalide.");

function refresh(id?: string) {
  revalidatePath("/admin/contacts");
  if (id) revalidatePath(`/admin/contacts/${id}`);
  // Pastille « Demandes de contact » de la barre latérale
  revalidatePath("/admin", "layout");
}

/** Statut (nouvelle, en cours, traitée, indésirable) et note interne. */
export async function updateContactRequest(id: string, input: { status: string; note: string }): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(id).success) return { ok: false, error: NOT_FOUND };
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue?.path[0] ?? "");
    return { ok: false, error: issue?.message ?? "Vérifiez les champs.", fieldErrors: key ? { [key]: issue!.message } : undefined };
  }
  const { status, note } = parsed.data;
  const admin = createAdminClient();
  const { data: before, error: readError } = await admin.from("contact_requests").select("status, admin_note").eq("id", id).maybeSingle();
  if (readError) return { ok: false, error: actionError(readError, "Enregistrement impossible.") };
  if (!before) return { ok: false, error: NOT_FOUND };
  const changes: Record<string, unknown> = { status, admin_note: note || null, updated_at: new Date().toISOString() };
  // « Traitée par … le … » : auteur de la clôture (traitée ou indésirable), effacé si la demande est rouverte
  if (before.status !== status) {
    const closing = status === "done" || status === "spam";
    changes.handled_by = closing ? session.user.id : null;
    changes.handled_at = closing ? new Date().toISOString() : null;
  }
  const { error } = await admin.from("contact_requests").update(changes).eq("id", id);
  if (error) return { ok: false, error: actionError(error, "Enregistrement impossible.") };
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "contact_request.updated",
    entityType: "contact_requests",
    entityId: id,
    metadata: { from: before.status, to: status, note_changed: (before.admin_note ?? "") !== note },
  });
  refresh(id);
  return { ok: true };
}

/** Réponse au demandeur, envoyée par e-mail (file email_outbox) ; une nouvelle demande passe « en cours ». */
export async function replyToContactRequest(id: string, message: string): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(id).success) return { ok: false, error: NOT_FOUND };
  const parsed = contactReplySchema.safeParse({ message });
  if (!parsed.success) {
    const m = parsed.error.issues[0]?.message ?? "Réponse invalide.";
    return { ok: false, error: m, fieldErrors: { message: m } };
  }
  const admin = createAdminClient();
  const { data: req, error: readError } = await admin.from("contact_requests").select("id, email, status").eq("id", id).maybeSingle();
  if (readError) return { ok: false, error: actionError(readError, "Envoi impossible.") };
  if (!req) return { ok: false, error: NOT_FOUND };
  if (req.status === "spam") return { ok: false, error: "Demande classée indésirable : changez d'abord son statut." };

  const mail = contactReplyEmail(parsed.data.message, { appUrl: env.appUrl });
  // Le demandeur répond à l'adresse qui reçoit les demandes (jamais à l'expéditeur technique noreply@)
  const replyTo = (await contactRecipients())[0] ?? null;
  const { error } = await admin.from("email_outbox").insert({
    kind: "contact_reply",
    contact_request_id: id,
    to_email: req.email,
    reply_to: replyTo,
    subject: mail.subject,
    body_text: mail.text,
    created_by: session.user.id,
  });
  if (error) return { ok: false, error: actionError(error, "Envoi impossible.") };
  if (req.status === "new") {
    await admin.from("contact_requests").update({ status: "in_progress", updated_at: new Date().toISOString() }).eq("id", id);
  }
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "contact_request.replied",
    entityType: "contact_requests",
    entityId: id,
    metadata: { length: parsed.data.message.length },
  });
  refresh(id);
  return { ok: true };
}

/** Suppression définitive (droit à l'effacement) : la demande et ses e-mails. */
export async function deleteContactRequest(id: string): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!uuid.safeParse(id).success) return { ok: false, error: NOT_FOUND };
  const admin = createAdminClient();
  const { data, error } = await admin.from("contact_requests").delete().eq("id", id).select("topic, status");
  if (error) return { ok: false, error: actionError(error, "Suppression impossible.") };
  const row = (data ?? [])[0] as { topic?: string; status?: string } | undefined;
  if (!row) return { ok: false, error: NOT_FOUND };
  // Journal sans donnée personnelle (le contenu vient d'être effacé)
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "contact_request.deleted",
    entityType: "contact_requests",
    entityId: id,
    severity: "warning",
    metadata: { topic: row.topic, status: row.status },
  });
  refresh(id);
  return { ok: true };
}

/** E-mail en échec définitif : remis en file, avec un nouveau cycle complet d'essais (le premier, immédiat). */
export async function retryEmail(emailId: number, contactRequestId?: string): Promise<Result> {
  const session = await requireSuperAdmin();
  if (!Number.isSafeInteger(emailId) || emailId <= 0) return { ok: false, error: "E-mail introuvable." };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_outbox")
    .update({ status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), locked_until: null, last_error: null })
    .eq("id", emailId)
    .eq("status", "failed")
    .select("id, kind");
  if (error) return { ok: false, error: actionError(error, "Nouvel essai impossible.") };
  const row = (data ?? [])[0] as { id: number; kind: string } | undefined;
  if (!row) return { ok: false, error: "Cet e-mail n'est plus en échec (déjà renvoyé ?)." };
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "email.retry",
    entityType: "email_outbox",
    entityId: String(emailId),
    metadata: { kind: row.kind },
  });
  refresh(contactRequestId && uuid.safeParse(contactRequestId).success ? contactRequestId : undefined);
  return { ok: true };
}

/** E-mail de test : vérifie de bout en bout l'envoi par le serveur mail du VPS. */
export async function sendTestEmail(to: string): Promise<Result> {
  const session = await requireSuperAdmin();
  const parsed = emailSchema.safeParse(to);
  if (!parsed.success) {
    const m = parsed.error.issues[0]?.message ?? "Adresse e-mail invalide.";
    return { ok: false, error: m, fieldErrors: { to: m } };
  }
  const mail = testEmail({ appUrl: env.appUrl });
  const { error } = await createAdminClient().from("email_outbox").insert({
    kind: "test",
    to_email: parsed.data,
    subject: mail.subject,
    body_text: mail.text,
    created_by: session.user.id,
  });
  if (error) return { ok: false, error: actionError(error, "Envoi impossible.") };
  await audit({
    actorUserId: session.user.id,
    actorType: "super_admin",
    action: "email.test_sent",
    entityType: "email_outbox",
    metadata: { domain: parsed.data.split("@")[1] ?? "" },
  });
  refresh();
  return { ok: true };
}
