import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env, serverEnv } from "@/lib/env";

let admin: ReturnType<typeof createClient> | null = null;

/**
 * Client service_role (bypass RLS). À n'utiliser QUE côté serveur, après
 * contrôle explicite des droits (rôle, tenant) et avec journalisation.
 */
export function createAdminClient() {
  if (admin) return admin;
  const key = serverEnv().serviceRoleKey;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante");
  admin = createClient(env.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-rydar-client": "web-server" } },
  });
  return admin;
}
