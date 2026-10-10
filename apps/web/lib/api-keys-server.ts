import "server-only";
// Création d'une clé API (service role) : tableau de bord (Intégrations : création, rotation) et super admin (clé du
// site d'un client Flotte Privée). Seuls le préfixe, les 4 derniers caractères et un HMAC-SHA256 poivré sont stockés ;
// la clé complète n'est renvoyée qu'à l'appelant, qui l'affiche UNE fois. La garde api_keys_plan_limit
// (PLAN_FEATURE_API) s'applique à l'insertion.
import { generateApiKey, hashApiKey } from "@/lib/api-keys";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export type NewApiKey = {
  name: string;
  scopes: string[];
  rateLimitPerMinute: number;
  /** Non vide : clé « navigateur » (portées BROWSER_KEY_SCOPES seulement, contrôlées par l'API) */
  allowedOrigins: string[];
  expiresAt: string | null;
  /** Rotation : clé remplacée */
  rotatedFrom?: string;
};

/**
 * Clé puis son secret (table api_key_secrets, service role seul). Secret refusé : la clé est retirée. Renvoie
 * l'identifiant, la clé complète et son préfixe, ou l'erreur de la base.
 */
export async function insertKey(orgId: string, userId: string, input: NewApiKey) {
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
