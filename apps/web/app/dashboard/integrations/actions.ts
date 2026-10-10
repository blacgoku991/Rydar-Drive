"use server";
import { apiKeyCreateSchema, BROWSER_KEY_SCOPES, describeError, ERROR_MESSAGES, humanizeError, webhookUpsertSchema, type WebhookEvent } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { insertKey } from "@/lib/api-keys-server";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE, webhookRpc, webhookTestRpc, type WebhookRpc } from "@/lib/webhooks";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
type AdminCtx = NonNullable<Awaited<ReturnType<typeof getOrgContext>>>;

/**
 * Contexte owner / admin des clés et des webhooks. Flotte Privée (docs/FLOTTE-PRIVEE.md, D16) : clés API et webhooks
 * gérés par l'équipe Rydar (fiche du client, super admin), jamais depuis le tableau de bord → PRIVATE_FLEET_RESTRICTED.
 * Le drapeau est lu ici, dans organizations (grant de lecture par colonne), jamais d'après la session ; lecture
 * impossible : refus (rien n'est écrit).
 */
async function adminCtx(): Promise<{ ok: true; ctx: AdminCtx } | { ok: false; error: string }> {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return { ok: false, error: "Réservé aux administrateurs." };
  const { data, error } = await ctx.supabase.from("organizations").select("private_fleet").eq("id", ctx.org.id).maybeSingle();
  if (error || !data) return { ok: false, error: "Vérification impossible pour le moment : réessayez." };
  if ((data as { private_fleet?: boolean | null }).private_fleet === true) return { ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED };
  return { ok: true, ctx };
}

/** Crée une clé : la valeur complète n'est renvoyée qu'UNE fois. */
export async function createApiKey(input: z.input<typeof apiKeyCreateSchema>): Promise<Result<{ key: string; prefix: string }>> {
  const c = await adminCtx();
  if (!c.ok) return c;
  const { ctx } = c;
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
  const c = await adminCtx();
  if (!c.ok) return c;
  const { ctx } = c;
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
  const c = await adminCtx();
  if (!c.ok) return c;
  const { ctx } = c;
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
  // Clé « navigateur » (origines autorisées) : la nouvelle clé ne garde que les portées permises au navigateur
  // (BROWSER_KEY_SCOPES : création de courses et devis)
  const browser = ((o.allowed_origins ?? []) as string[]).length > 0;
  const scopes = browser ? (o.scopes as string[]).filter((s) => (BROWSER_KEY_SCOPES as readonly string[]).includes(s)) : (o.scopes as string[]);
  if (!scopes.length) return { ok: false, error: "Clé utilisée depuis le navigateur sans permission de création ni de devis : créez une nouvelle clé." };
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
async function webhookCtx(needApi: boolean): Promise<{ ok: true; ctx: AdminCtx } | { ok: false; error: string }> {
  const c = await adminCtx();
  if (!c.ok) return c;
  const { ctx } = c;
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
  const actor = { type: "user" as const, id: c.ctx.user.id };
  // Tests et renvois : même plafond par centrale que l'API (10 par minute), revérifié en base
  const res =
    fn === "svc_webhook_ping" || fn === "svc_webhook_redeliver"
      ? await webhookTestRpc(fn, c.ctx.org.id, actor, args)
      : await webhookRpc(fn, c.ctx.org.id, actor, args);
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

/**
 * Envoi de test (événement « ping ») : part dans les secondes qui suivent, résultat dans « Derniers envois ». Refusé
 * tant qu'un test de cette adresse attend son envoi, et au-delà de 10 tests et renvois par minute pour la centrale.
 */
export async function testWebhook(id: string): Promise<Result> {
  if (!UUID_RE.test(id)) return { ok: false, error: NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_ping", true, { p_id: id });
  return res.ok ? { ok: true } : res;
}

/** Renvoie un envoi livré ou en échec (nouvelle tentative immédiate, compteur remis à zéro) ; même plafond que les tests. */
export async function redeliverWebhook(deliveryId: string): Promise<Result> {
  if (!UUID_RE.test(deliveryId)) return { ok: false, error: ERROR_MESSAGES.WEBHOOK_DELIVERY_NOT_FOUND };
  const res = await runWebhookRpc("svc_webhook_redeliver", true, { p_delivery_id: deliveryId });
  return res.ok ? { ok: true } : res;
}
