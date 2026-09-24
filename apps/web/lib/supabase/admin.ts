import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, serverEnv } from "@/lib/env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let admin: SupabaseClient<any, any, any> | null = null;

/**
 * Client service_role (bypass RLS). À n'utiliser QUE côté serveur, après
 * contrôle explicite des droits (rôle, tenant) et avec journalisation.
 */
export function createAdminClient(): SupabaseClient<any, any, any> {
  if (admin) return admin;
  const key = serverEnv().serviceRoleKey;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante");
  admin = createClient(env.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-rydar-client": "web-server" } },
  });
  return admin;
}
