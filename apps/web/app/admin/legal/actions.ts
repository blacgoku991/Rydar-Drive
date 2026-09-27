"use server";
// Super admin : identité légale de l'éditeur et hébergeurs (pages légales publiques). Écriture par le service role
// après requireSuperAdmin() ; svc_platform_legal_update revérifie l'auteur et écrit audit_logs.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
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
  for (const p of ["/admin/legal", "/mentions-legales", "/confidentialite", "/cgu", "/cgv", "/cookies", "/dpa", "/suppression-compte"]) revalidatePath(p);
  return { ok: true };
}
