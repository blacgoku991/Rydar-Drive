"use server";
// Super admin : identité légale de l'éditeur et hébergeurs (pages légales publiques). Écriture par le service role
// après requireSuperAdmin() ; svc_platform_legal_update revérifie l'auteur et écrit audit_logs.
import { ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, type OrgTermsNotifyResult } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { actionError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";

const text = (max: number) => z.string().trim().max(max, `${max} caractères au maximum`).optional().default("");
const email = z.union([z.literal(""), z.string().trim().toLowerCase().max(254).email("Adresse e-mail invalide")]).optional().default("");

const legalInfoSchema = z.object({
  company_name: text(160),
  legal_form: text(60),
  share_capital: text(60),
  address: text(300),
  registration: text(120),
  vat_number: text(40),
  publication_director: text(120),
  email,
  phone: text(40),
  privacy_email: email,
  host_name: text(160),
  host_address: text(300),
  host_phone: text(40),
  data_host: text(300),
});
export type LegalInfoInput = z.input<typeof legalInfoSchema>;

export async function updateLegalInfo(input: LegalInfoInput): Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> }> {
  const session = await requireSuperAdmin();
  const parsed = legalInfoSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue?.path[0] ?? "");
    return { ok: false, error: issue?.message ?? "Vérifiez les champs.", fieldErrors: key ? { [key]: issue!.message } : undefined };
  }
  const { data, error } = await createAdminClient().rpc("svc_platform_legal_update", { p_actor: session.user.id, p_info: parsed.data });
  if (error) return { ok: false, error: actionError(error, "Enregistrement impossible.") };
  const res = (data ?? {}) as { ok?: boolean; message?: string };
  if (!res.ok) return { ok: false, error: res.message ?? "Enregistrement impossible." };
  for (const p of ["/admin/legal", "/mentions-legales", "/confidentialite", "/cgu", "/cgv", "/cookies", "/dpa", "/suppression-compte", "/abonnement-resiliation", "/accessibilite"]) {
    revalidatePath(p);
  }
  return { ok: true };
}

/**
 * « Prévenir par e-mail » : annonce des CGV en vigueur (ORG_LEGAL_VERSION) aux propriétaires des organisations actives
 * ou suspendues qui ne les ont pas acceptées (svc_org_terms_notify : contenu fixe mis en file email_outbox, une seule
 * fois par organisation et par version, journal d'audit en base ; refusé une fois l'entrée en vigueur atteinte). Le web
 * n'envoie aucun e-mail lui-même : le service mailer du VPS vide la file.
 */
export async function notifyOrgTerms(): Promise<
  | { ok: true; message: string; organizations: number; emails: number; alreadyNotified: number; withoutEmail: number }
  | { ok: false; error: string }
> {
  const session = await requireSuperAdmin();
  const { data, error } = await createAdminClient().rpc("svc_org_terms_notify", {
    p_actor: session.user.id,
    p_version: ORG_LEGAL_VERSION,
    p_effective_on: ORG_LEGAL_EFFECTIVE_AT,
    p_app_url: env.appUrl || null,
  });
  if (error) return { ok: false, error: actionError(error, "Envoi impossible.") };
  const res = (data ?? null) as OrgTermsNotifyResult | null;
  if (!res) return { ok: false, error: "Envoi impossible." };
  if (!res.ok) return { ok: false, error: res.message };
  revalidatePath("/admin/legal");
  return {
    ok: true,
    message: res.message,
    organizations: res.organizations,
    emails: res.emails,
    alreadyNotified: res.already_notified,
    withoutEmail: res.without_email,
  };
}
