"use server";
import { driverPasswordResetSchema } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { env } from "@/lib/env";
import { rateLimitAll } from "@/lib/rate-limit";
import { clientIp, ipBucket } from "@/lib/request";
import { serverFetch } from "@/lib/server-fetch";

export type PasswordResetResult = { ok: true } | { ok: false; error: string };

const HOUR = 60 * 60;

/**
 * « Mot de passe oublié » du tableau de bord, par le serveur (calqué sur /api/auth/driver-password-reset ; audit p5,
 * admin-public-2) : le navigateur n'appelle plus /auth/v1/recover de Supabase Auth, dont les réponses (429 au second
 * envoi seulement si le compte existe) révélaient l'existence d'un compte, sans limite par adresse IP.
 *  - réponse IDENTIQUE que l'adresse ait un compte ou non, e-mail envoyé APRÈS la réponse (after) : ni le contenu ni
 *    le temps de réponse ne le trahissent ;
 *  - limites par IP puis par adresse (même règle que l'app chauffeur) ;
 *  - flux implicite vers /auth/set-password (jetons dans le fragment, comme les invitations de l'équipe) : la demande ne
 *    vient pas forcément du navigateur qui ouvrira le lien.
 */
export async function requestPasswordReset(input: { email: string }): Promise<PasswordResetResult> {
  const parsed = driverPasswordResetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Adresse e-mail invalide." };
  const { email } = parsed.data;

  const ip = ipBucket(await clientIp());
  const limit = await rateLimitAll([
    { key: `reset:ip:${ip}`, limit: 10, windowSec: HOUR },
    { key: `resetip:${ip}:${email}`, limit: 3, windowSec: HOUR },
    { key: `reset:email:${email}`, limit: 20, windowSec: HOUR },
  ]);
  if (!limit.ok) {
    const minutes = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60_000));
    return { ok: false, error: `Trop de demandes. Réessayez dans ${minutes} min.` };
  }

  after(async () => {
    const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
      global: { fetch: serverFetch },
    });
    const { error } = await auth.auth.resetPasswordForEmail(email, { redirectTo: `${env.appUrl}/auth/set-password` });
    // Journal serveur seulement (SMTP absent ou refusé, limite Supabase…), jamais l'adresse
    if (error) console.error(`[password-reset] ${error.status ?? ""} ${error.code ?? ""} ${error.message}`);
  });
  return { ok: true };
}
