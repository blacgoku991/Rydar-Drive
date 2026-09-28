"use server";
import { loginSchema } from "@rydar/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ORG_COOKIE } from "@/lib/auth";
import { LOGIN_WINDOW, loginEmailKey, loginLimits, loginPairKey } from "@/lib/login-limits";
import { rateLimitAll, resetRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string; email?: string };

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) return { error: "Adresse e-mail ou mot de passe invalide.", email };

  // Protection brute force : IP, couple (adresse, IP), puis plafond global de l'adresse (lib/login-limits.ts)
  const ip = await clientIp();
  const limit = await rateLimitAll(loginLimits(parsed.data.email, ip));
  if (!limit.ok) {
    const minutes = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60_000));
    return { error: `Trop de tentatives. Réessayez dans ${minutes} min.`, email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: "Identifiants incorrects.", email };
  }
  await resetRateLimit(loginPairKey(parsed.data.email, ip), LOGIN_WINDOW);
  await resetRateLimit(loginEmailKey(parsed.data.email), LOGIN_WINDOW);

  redirect(safeNext(formData.get("next")));
}

/**
 * Déconnexion de CE navigateur seulement (l'application chauffeur et les autres postes restent connectés) ;
 * la centrale choisie est oubliée (un autre compte sur ce navigateur ne l'hérite pas).
 */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(ORG_COOKIE);
  redirect("/login");
}
