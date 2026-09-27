"use server";
import { loginSchema } from "@rydar/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ORG_COOKIE } from "@/lib/auth";
import { rateLimitAll, resetRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string; email?: string };

const WINDOW = 15 * 60;

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) return { error: "Adresse e-mail ou mot de passe invalide.", email };

  // Protection brute force : par IP et par compte
  const ip = await clientIp();
  const limit = await rateLimitAll([
    { key: `login:ip:${ip}`, limit: 30, windowSec: WINDOW },
    { key: `login:email:${parsed.data.email}`, limit: 6, windowSec: WINDOW },
  ]);
  if (!limit.ok) {
    const minutes = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60_000));
    return { error: `Trop de tentatives. Réessayez dans ${minutes} min.`, email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: "Identifiants incorrects.", email };
  }
  await resetRateLimit(`login:email:${parsed.data.email}`, WINDOW);

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
