import "server-only";
// WhatsApp Business (Meta) côté serveur : vérification du numéro avant enregistrement, message test.
// Le jeton d'accès ne quitte jamais le serveur : lu par le service role (tables *_whatsapp_secrets).
import {
  WHATSAPP_TEMPLATES, checkWhatsAppNumber, normalizePhone, sendWhatsAppTemplate, whatsappConfigSchema, type WhatsAppConfigInput,
} from "@rydar/shared";
import { z } from "zod";
import { actionError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type WhatsAppActionResult = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** null = numéro de Rydar (super admin) */
type Scope = string | null;

const apiVersion = () => process.env.WHATSAPP_API_VERSION || undefined;

async function storedToken(org: Scope): Promise<string | null> {
  const db = createAdminClient();
  const { data } = org
    ? await db.from("org_whatsapp_secrets").select("access_token").eq("organization_id", org).maybeSingle()
    : await db.from("platform_whatsapp_secrets").select("access_token").maybeSingle();
  return (data as { access_token?: string } | null)?.access_token ?? null;
}

async function storedConfig(org: Scope) {
  const db = createAdminClient();
  const { data } = org
    ? await db.from("org_whatsapp").select("phone_number_id, template, language, enabled").eq("organization_id", org).maybeSingle()
    : await db.from("platform_whatsapp").select("phone_number_id, template, language, enabled").maybeSingle();
  return data as { phone_number_id: string; template: string; language: string; enabled: boolean } | null;
}

const LABELS: Record<string, string> = { phoneNumberId: "Identifiant du numéro", token: "Jeton d'accès", template: "Modèle", language: "Langue" };

/** Vérifie le numéro auprès de Meta (jeton saisi, ou jeton déjà enregistré) puis enregistre. */
export async function saveWhatsApp(org: Scope, actor: string, input: z.input<typeof whatsappConfigSchema>): Promise<WhatsAppActionResult> {
  const parsed = whatsappConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue?.path[0] ?? "");
    return { ok: false, error: issue ? issue.message : "Vérifiez les champs.", fieldErrors: key ? { [key]: issue!.message } : undefined };
  }
  const v: WhatsAppConfigInput = parsed.data;
  const limit = await rateLimit(`wa-save:${org ?? "platform"}`, 10, 600);
  if (!limit.ok) return { ok: false, error: "Trop d'essais : réessayez dans quelques minutes." };
  const token = v.token ?? (await storedToken(org));
  if (!token) return { ok: false, error: `${LABELS.token} : requis.`, fieldErrors: { token: "Requis" } };

  const check = await checkWhatsAppNumber({ phoneNumberId: v.phoneNumberId, token, apiVersion: apiVersion() });
  if (!check.ok) {
    const field = check.code === 190 || check.code === 0 ? "token" : check.code === 100 ? "phoneNumberId" : undefined;
    return { ok: false, error: `Meta refuse ce numéro : ${check.error}`, fieldErrors: field ? { [field]: check.error } : undefined };
  }
  const { data, error } = await createAdminClient().rpc("svc_whatsapp_save", {
    p_org: org,
    p_actor: actor,
    p_phone_number_id: v.phoneNumberId,
    p_token: v.token,
    p_display_phone: check.displayPhone,
    p_verified_name: check.verifiedName,
    p_template: v.template,
    p_language: v.language,
    p_enabled: v.enabled,
  });
  if (error) return { ok: false, error: actionError(error, "Enregistrement impossible.") };
  const res = (data ?? {}) as { ok?: boolean; message?: string };
  if (!res.ok) return { ok: false, error: res.message ?? "Enregistrement impossible." };
  return { ok: true, message: `WhatsApp relié : ${check.verifiedName ?? check.displayPhone ?? v.phoneNumberId}.` };
}

export async function removeWhatsApp(org: Scope, actor: string): Promise<WhatsAppActionResult> {
  const { data, error } = await createAdminClient().rpc("svc_whatsapp_remove", { p_org: org, p_actor: actor });
  if (error) return { ok: false, error: actionError(error, "Déconnexion impossible.") };
  const res = (data ?? {}) as { ok?: boolean; message?: string };
  return res.ok ? { ok: true, message: res.message ?? "WhatsApp déconnecté." } : { ok: false, error: res.message ?? "Déconnexion impossible." };
}

/** Message test (modèle configuré, valeurs d'exemple) envoyé tout de suite au numéro indiqué. */
export async function testWhatsApp(org: Scope, orgName: string, to: string): Promise<WhatsAppActionResult> {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: "Numéro de téléphone invalide.", fieldErrors: { to: "Numéro invalide" } };
  const limit = await rateLimit(`wa-test:${org ?? "platform"}`, 5, 600);
  if (!limit.ok) return { ok: false, error: "5 messages test par 10 minutes au plus : réessayez plus tard." };
  const [cfg, token] = await Promise.all([storedConfig(org), storedToken(org)]);
  if (!cfg || !token) return { ok: false, error: "Enregistrez d'abord le numéro WhatsApp." };
  const d = WHATSAPP_TEMPLATES.driver.sample;
  const p = WHATSAPP_TEMPLATES.platform.sample;
  const params: string[] = org ? [d[0], d[1], orgName, d[3]] : [orgName, p[1], p[2]];
  const res = await sendWhatsAppTemplate({
    phoneNumberId: cfg.phone_number_id,
    token,
    to: phone.slice(1),
    template: cfg.template,
    language: cfg.language,
    params,
    apiVersion: apiVersion(),
  });
  await createAdminClient().rpc("svc_whatsapp_record", { p_org: org, p_ok: res.ok, p_error: res.ok ? null : res.error });
  return res.ok
    ? { ok: true, message: `Message test envoyé à ${phone}. Il arrive en quelques secondes s'il est accepté par Meta.` }
    : { ok: false, error: res.error };
}
