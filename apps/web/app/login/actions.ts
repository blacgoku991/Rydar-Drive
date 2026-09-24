"use server";
import { loginSchema } from "@rydar/shared";
import { redirect } from "next/navigation";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string; email?: string };

const WINDOW = 15 * 60;

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) return { error: "Adresse e-mail ou mot de passe invalide.", email };

  // Protection brute force : par IP et par compte
  const ip = await clientIp();
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`login:ip:${ip}`, 30, WINDOW),
    rateLimit(`login:email:${parsed.data.email}`, 6, WINDOW),
  ]);
  if (!byIp.ok || !byEmail.ok) {
    const minutes = Math.ceil((Math.max(byIp.resetAt, byEmail.resetAt) - Date.now()) / 60_000);
    return { error: `Trop de tentatives. Réessayez dans ${minutes} min.`, email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: "Identifiants incorrects.", email };
  }
  await resetRateLimit(`login:email:${parsed.data.email}`, WINDOW);

  const next = String(formData.get("next") ?? "");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
