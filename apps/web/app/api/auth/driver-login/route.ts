import { loginSchema } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { driverAppCors } from "@/lib/driver-app-cors";
import {
  checkDriverAccount, DRIVER_DENIED, DRIVER_LOGIN_WINDOW, driverAccountDecision, driverLoginEmailKey, driverLoginPairKey, isAuthBanned,
} from "@/lib/driver-session";
import { env } from "@/lib/env";
import { rateLimitAll, resetRateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

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

  // IP, puis couple (adresse, IP) strict, puis plafond global de l'adresse (remis à zéro par une connexion réussie) :
  // un tiers qui connaît l'adresse ne bloque plus le chauffeur depuis une autre IP en 6 essais
  const limit = await rateLimitAll([
    { key: `dlogin:ip:${ip}`, limit: 30, windowSec: WINDOW },
    { key: driverLoginPairKey(email, ip), limit: 6, windowSec: WINDOW },
    { key: driverLoginEmailKey(email), limit: 50, windowSec: WINDOW },
  ]);
  if (!limit.ok) {
    return NextResponse.json(
      { code: "RATE_LIMITED", error: "Trop de tentatives. Réessayez dans quelques minutes." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  // Compte Auth banni : Supabase refuse AVANT de vérifier le mot de passe (user_banned, bon ou mauvais mot de passe)
  if (isAuthBanned(error)) return bannedAccount(email, password);
  if (error || !data.session) return invalidCredentials();

  const check = await checkDriverAccount(auth, data.user.id);
  if (!check.ok) return NextResponse.json({ code: check.code, error: check.error }, { status: check.status });

  await resetRateLimit(driverLoginPairKey(email, ip), WINDOW);
  await resetRateLimit(driverLoginEmailKey(email), WINDOW);
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    state: check.state,
  });
}

function invalidCredentials() {
  return NextResponse.json({ code: "INVALID_CREDENTIALS", error: "E-mail ou mot de passe incorrect." }, { status: 401 });
}

/**
 * Compte Auth banni : le mot de passe est vérifié ici (empreinte de Supabase Auth, comme la suppression de compte).
 * Faux → même réponse qu'un mauvais mot de passe (aucun oracle « ce compte chauffeur est sanctionné ») ; juste → le
 * vrai motif lu sur la fiche (inactif, centrale suspendue, candidature refusée…), BANNED si la fiche ne l'explique pas
 * (bannissement plateforme). Aucune session n'est ouverte.
 */
async function bannedAccount(email: string, password: string): Promise<NextResponse> {
  const { data: userId, error } = await createAdminClient().rpc("svc_driver_password_check", { p_email: email, p_password: password });
  if (error) return NextResponse.json({ code: "UNAVAILABLE", error: "Connexion impossible pour le moment. Réessayez." }, { status: 503 });
  if (!userId) return invalidCredentials();
  const decision = await driverAccountDecision(String(userId));
  if (decision.ok) return NextResponse.json({ code: "BANNED", error: DRIVER_DENIED.BANNED }, { status: 403 });
  return NextResponse.json({ code: decision.code, error: decision.error }, { status: decision.status });
}
