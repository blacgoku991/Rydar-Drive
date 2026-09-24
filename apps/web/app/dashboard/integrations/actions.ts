"use server";
import { apiKeyCreateSchema, humanizeError } from "@rydar/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";

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
  if (!parsed.success) return { ok: false, error: "Paramètres invalides." };
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
  const res = await insertKey(ctx.org.id, ctx.user.id, {
    name: o.name,
    scopes: o.scopes,
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
