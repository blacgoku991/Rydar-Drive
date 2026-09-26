import { loginSchema } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { driverAppCors } from "@/lib/driver-app-cors";
import { checkDriverAccount, DRIVER_DENIED, DRIVER_LOGIN_WINDOW, driverLoginEmailKey, isAuthBanned } from "@/lib/driver-session";
import { env } from "@/lib/env";
import { rateLimitAll, resetRateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/request";

export const dynamic = "force-dynamic";

const WINDOW = DRIVER_LOGIN_WINDOW;

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: driverAppCors(req) });
}

/**
 * Connexion de l'application chauffeur : anti brute force (IP + compte), puis contrôle du compte
 * (lib/driver-session.ts, partagé avec la réinitialisation par code).
 *  - 200 { access_token, refresh_token, expires_at, state } : chauffeur actif (state « active »)
 *    ou candidat inscrit par lien, en attente de validation (state « pending » : écran d'attente,
 *    dépôt de documents) — organisation active, compte non banni ;
 *  - 403 { code, error } : BANNED (banni par la centrale, ou compte Auth banni), REJECTED,
 *    INACTIVE (suspendu / désactivé), ORGANIZATION_SUSPENDED, NOT_DRIVER.
 * Même ordre de priorité que public.driver_account_state() (banni › centrale suspendue › candidature).
 * Renvoie les jetons Supabase que l'app installe via auth.setSession().
 */
export async function POST(req: Request) {
  const res = await login(req);
  for (const [k, v] of Object.entries(driverAppCors(req))) res.headers.set(k, v);
  return res;
}

async function login(req: Request): Promise<NextResponse> {
  const ip = ipFromHeaders(req.headers) ?? "0.0.0.0";
  const parsed = loginSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_INPUT", error: "Identifiants invalides." }, { status: 400 });
  const { email, password } = parsed.data;

  const limit = await rateLimitAll([
    { key: `dlogin:ip:${ip}`, limit: 30, windowSec: WINDOW },
    { key: driverLoginEmailKey(email), limit: 6, windowSec: WINDOW },
  ]);
  if (!limit.ok) {
    return NextResponse.json(
      { code: "RATE_LIMITED", error: "Trop de tentatives. Réessayez dans quelques minutes." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  // Mot de passe juste mais compte Auth banni : Supabase refuse la connexion (user_banned)
  if (isAuthBanned(error)) return NextResponse.json({ code: "BANNED", error: DRIVER_DENIED.BANNED }, { status: 403 });
  if (error || !data.session) {
    return NextResponse.json({ code: "INVALID_CREDENTIALS", error: "E-mail ou mot de passe incorrect." }, { status: 401 });
  }

  const check = await checkDriverAccount(auth, data.user.id);
  if (!check.ok) return NextResponse.json({ code: check.code, error: check.error }, { status: check.status });

  await resetRateLimit(driverLoginEmailKey(email), WINDOW);
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    state: check.state,
  });
}
