"use server";
import { apiKeyCreateSchema, BROWSER_KEY_SCOPES, describeError, ERROR_MESSAGES, humanizeError, webhookUpsertSchema, type WebhookEvent } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE, webhookRpc, type WebhookRpc } from "@/lib/webhooks";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function adminCtx() {
  const ctx = await getOrgContext();
  return ctx && isAdminRole(ctx.role) ? ctx : null;
}

async function insertKey(
  orgId: string,
  userId: string,
  input: { name: string; scopes: string[]; rateLimitPerMinute: number; allowedOrigins: string[]; expiresAt: string | null; rotatedFrom?: string },
) {
  const admin = createAdminClient();
  const { key, prefix, last4 } = generateApiKey("live");
  const hash = hashApiKey(key, serverEnv().apiKeyPepper);
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      organization_id: orgId,
      name: input.name,
      prefix,
      last4,
      scopes: input.scopes,
      rate_limit_per_minute: input.rateLimitPerMinute,
      allowed_origins: input.allowedOrigins,
      expires_at: input.expiresAt,
      created_by: userId,
      rotated_from_id: input.rotatedFrom ?? null,
    } as never)
    .select("id")
    .single();
  if (error || !data) return { error };
  const { error: sErr } = await admin.from("api_key_secrets").insert({ api_key_id: (data as { id: string }).id, key_hash: hash } as never);
  if (sErr) {
    await admin.from("api_keys").delete().eq("id", (data as { id: string }).id);
    return { error: sErr };
  }
  return { id: (data as { id: string }).id, key, prefix };
}

/** Crée une clé : la valeur complète n'est renvoyée qu'UNE fois. */
export async function createApiKey(input: z.input<typeof apiKeyCreateSchema>): Promise<Result<{ key: string; prefix: string }>> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const parsed = apiKeyCreateSchema.safeParse(input);
  if (!parsed.success) {
    // Règle des clés « navigateur » : message explicite ; le reste est guidé par le formulaire
    return { ok: false, error: parsed.error.issues.find((i) => i.code === "custom")?.message ?? "Paramètres invalides." };
  }
  const v = parsed.data;
  const res = await insertKey(ctx.org.id, ctx.user.id, {
    name: v.name,
    scopes: v.scopes,
    rateLimitPerMinute: v.rateLimitPerMinute,
    allowedOrigins: v.allowedOrigins,
    expiresAt: v.expiresInDays ? new Date(Date.now() + v.expiresInDays * 86_400_000).toISOString() : null,
  });
  if (!("key" in res) || !res.key) return { ok: false, error: humanizeError(res.error?.message, "Impossible de créer la clé.") };
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "api_key.created", entityType: "api_keys", entityId: res.id, metadata: { prefix: res.prefix, scopes: v.scopes } });
  revalidatePath("/dashboard/integrations");
  return { ok: true, key: res.key, prefix: res.prefix };
}

export async function revokeApiKey(id: string): Promise<Result> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.user.id } as never)
    .eq("id", id)
    .eq("organization_id", ctx.org.id)
    .is("revoked_at", null)
    .select("prefix")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Clé introuvable ou déjà révoquée." };
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "api_key.revoked", entityType: "api_keys", entityId: id, severity: "warning", metadata: { prefix: (data as { prefix: string }).prefix } });
  revalidatePath("/dashboard/integrations");
  return { ok: true };
}

/** Rotation : nouvelle clé immédiate, l'ancienne reste valide 24 h pour la bascule. */
export async function rotateApiKey(id: string): Promise<Result<{ key: string; prefix: string }>> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  const admin = createAdminClient();
  const { data: old } = await admin
    .from("api_keys")
    .select("id, name, scopes, rate_limit_per_minute, allowed_origins, expires_at")
    .eq("id", id)
    .eq("organization_id", ctx.org.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (!old) return { ok: false, error: "Clé introuvable." };
  const o = old as any;
  // Clé « navigateur » (origines autorisées) : la nouvelle clé n'a que la création de courses
  const browser = ((o.allowed_origins ?? []) as string[]).length > 0;
  const scopes = browser ? (o.scopes as string[]).filter((s) => (BROWSER_KEY_SCOPES as readonly string[]).includes(s)) : (o.scopes as string[]);
  if (!scopes.length) return { ok: false, error: "Clé utilisée depuis le navigateur sans permission de création : créez une nouvelle clé." };
  const res = await insertKey(ctx.org.id, ctx.user.id, {
    name: o.name,
    scopes,
    rateLimitPerMinute: o.rate_limit_per_minute,
    allowedOrigins: o.allowed_origins,
    expiresAt: o.expires_at,
    rotatedFrom: o.id,
  });
  if (!("key" in res) || !res.key) return { ok: false, error: "Rotation impossible." };
  const grace = new Date(Date.now() + 24 * 3600_000).toISOString();
  await admin.from("api_keys").update({ expires_at: o.expires_at && o.expires_at < grace ? o.expires_at : grace } as never).eq("id", o.id);
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "api_key.rotated", entityType: "api_keys", entityId: o.id, severity: "warning", metadata: { new_prefix: res.prefix } });
  revalidatePath("/dashboard/integrations");
  return { ok: true, key: res.key, prefix: res.prefix };
}

// -----------------------------------------------------------------------------
// Webhooks : owner / admin seulement (contrôlé ici), puis RPC svc_webhook_* (service role) qui revérifient
// l'appartenance à la centrale et écrivent elles-mêmes audit_logs. Même accès d'offre que l'API (api_access).
// -----------------------------------------------------------------------------
const WEBHOOK_FIELD_LABELS = { url: "Adresse", description: "Description", events: "Événements" };

/**
 * Contexte owner / admin ; `needApi` : l'offre doit inclure l'API (ajout, réactivation, test, nouvel envoi).
 * Couper, supprimer ou changer le secret reste possible sans l'API (une centrale qui change d'offre fait le ménage).
 */
async function webhookCtx(needApi: boolean): Promise<{ ok: true; ctx: NonNullable<Awaited<ReturnType<typeof adminCtx>>> } | { ok: false; error: string }> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, error: "Réservé aux administrateurs." };
  if (needApi) {
    const { data } = await ctx.supabase.rpc("org_usage", { p_org: ctx.org.id });
    if (!(data as { limits?: { api_access?: boolean } } | null)?.limits?.api_access) {
      return { ok: false, error: ERROR_MESSAGES.PLAN_FEATURE_API ?? "L'API n'est pas incluse dans votre offre." };
    }
  }
  return { ok: true, ctx };
}

async function runWebhookRpc(fn: WebhookRpc, needApi: boolean, args: Record<string, unknown>): Promise<Result<{ data: Record<string, any> }>> {
  const c = await webhookCtx(needApi);
  if (!c.ok) return { ok: false, error: c.error };
  const res = await webhookRpc(fn, c.ctx.org.id, { type: "user", id: c.ctx.user.id }, args);
  if (!res.ok) return { ok: false, error: res.message };
  revalidatePath("/dashboard/integrations");
  return { ok: true, data: res.data };
}

const NOT_FOUND = "Webhook introuvable.";

/** Ajoute une adresse (ou met à jour celle qui existe déjà) ; le secret généré n'est renvoyé qu'à la création. */
export async function createWebhook(input: { url: string; description?: string; events?: WebhookEvent[] }): Promise<Result<{ created: boolean; secret: string | null }>> {
  // Pas de secret choisi depuis le dashboard : Rydar le génère (affiché une seule fois)
  const parsed = webhookUpsertSchema.safeParse({ url: input.url, description: input.description, events: input.events });
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, WEBHOOK_FIELD_LABELS) };
  const v = parsed.data;
  const res = await runWebhookRpc("svc_webhook_upsert", true, { p_url: v.url, p_description: v.description, p_events: v.events, p_secret: null });
  if (!res.ok) return res;
  const created = res.data.created === true;
  return { ok: true, created, secret: created ? ((res.data.secret as string | null) ?? null) : null };
}

export async function deleteWebhook(id: string): Promise<Result> {
  if (!UUID_RE.test(id)) return { ok: false, error: NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_delete", false, { p_id: id });
  return res.ok ? { ok: true } : res;
}

/** Réactiver remet à zéro le compteur d'échecs et le motif de désactivation automatique. */
export async function setWebhookEnabled(id: string, enabled: boolean): Promise<Result> {
  if (!UUID_RE.test(id)) return { ok: false, error: NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_set_enabled", enabled === true, { p_id: id, p_enabled: enabled === true });
  return res.ok ? { ok: true } : res;
}

/** Nouveau secret immédiat (l'ancien cesse de signer) : renvoyé une seule fois. */
export async function rotateWebhookSecret(id: string): Promise<Result<{ secret: string }>> {
  if (!UUID_RE.test(id)) return { ok: false, error: NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_rotate_secret", false, { p_id: id });
  if (!res.ok) return res;
  const secret = res.data.secret;
  return typeof secret === "string" && secret ? { ok: true, secret } : { ok: false, error: "Secret non renouvelé. Réessayez." };
}

/** Envoi de test (événement « ping ») : part dans les secondes qui suivent, résultat dans « Derniers envois ». */
export async function testWebhook(id: string): Promise<Result> {
  if (!UUID_RE.test(id)) return { ok: false, error: NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_ping", true, { p_id: id });
  return res.ok ? { ok: true } : res;
}

/** Renvoie un envoi livré ou en échec (nouvelle tentative immédiate, compteur remis à zéro). */
export async function redeliverWebhook(deliveryId: string): Promise<Result> {
  if (!UUID_RE.test(deliveryId)) return { ok: false, error: ERROR_MESSAGES.WEBHOOK_DELIVERY_NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_redeliver", true, { p_delivery_id: deliveryId });
  return res.ok ? { ok: true } : res;
}
