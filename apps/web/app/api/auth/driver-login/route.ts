import { loginSchema } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const WINDOW = 15 * 60;

// L'app mobile n'est pas concernée par le CORS ; seules les origines listées
// (aperçu web de l'app chauffeur, ex. http://localhost:8081) sont autorisées.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = (process.env.DRIVER_APP_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
}

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

/**
 * Connexion de l'application chauffeur : anti brute force (IP + compte), puis
 * vérification que le compte est un chauffeur ACTIF d'une organisation active.
 * Renvoie les jetons Supabase que l'app installe via auth.setSession().
 */
export async function POST(req: Request) {
  const res = await login(req);
  for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
  return res;
}

async function login(req: Request): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "0.0.0.0";
  const parsed = loginSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Identifiants invalides." }, { status: 400 });
  const { email, password } = parsed.data;

  const [byIp, byEmail] = await Promise.all([rateLimit(`dlogin:ip:${ip}`, 30, WINDOW), rateLimit(`dlogin:email:${email}`, 6, WINDOW)]);
  if (!byIp.ok || !byEmail.ok) {
    return NextResponse.json({ error: "Trop de tentatives. Réessayez dans quelques minutes." }, { status: 429, headers: { "Retry-After": "900" } });
  }

  const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.session) return NextResponse.json({ error: "E-mail ou mot de passe incorrect." }, { status: 401 });

  const { data: driver } = await createAdminClient()
    .from("drivers")
    .select("id, status, organization:organizations(status)")
    .eq("user_id", data.user.id)
    .maybeSingle();
  const org = driver ? (Array.isArray((driver as any).organization) ? (driver as any).organization[0] : (driver as any).organization) : null;
  if (!driver || (driver as any).status !== "active" || org?.status !== "active") {
    await auth.auth.signOut().catch(() => undefined);
    return NextResponse.json(
      { error: !driver ? "Ce compte n'est pas un compte chauffeur." : "Compte chauffeur inactif : contactez votre centrale." },
      { status: 403 },
    );
  }
  await resetRateLimit(`dlogin:email:${email}`, WINDOW);
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
}
