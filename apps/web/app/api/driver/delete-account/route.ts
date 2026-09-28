import { loginSchema } from "@rydar/shared";
import { createClient, isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { driverAppCors } from "@/lib/driver-app-cors";
import { deleteDriverAccount } from "@/lib/driver-deletion";
import { DRIVER_LOGIN_WINDOW, driverLoginEmailKey, driverLoginPairKey } from "@/lib/driver-session";
import { env } from "@/lib/env";
import { rateLimit, rateLimitAll, resetRateLimit } from "@/lib/rate-limit";
import { ipBucket, ipFromHeaders } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Fenêtre de l'anti brute force par IP (15 min, comme la connexion chauffeur). */
const WINDOW = 15 * 60;
const confirmSchema = z.object({ confirm: z.literal("SUPPRIMER") });

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: driverAppCors(req) });
}

/**
 * Suppression du compte par le chauffeur, depuis l'application (App Store 5.1.1(v), Google Play).
 * Corps { confirm: "SUPPRIMER", email?, password? }. Authentification :
 *  - jeton de l'app (Bearer), vérifié par Supabase Auth ;
 *  - jeton refusé (expiré, session révoquée : compte suspendu, banni, centrale suspendue…) : e-mail + mot de passe,
 *    vérifiés par un client anonyme sans cookie ni persistance ; refus de Supabase Auth pour une autre raison que
 *    de mauvais identifiants (compte Auth banni…) : empreinte vérifiée par la base (svc_driver_password_check).
 * Anti brute force : IP (IPv6 regroupée par /64), puis MÊMES compteurs que la connexion (/api/auth/driver-login : pas
 * de second budget de mots de passe) — couple (adresse, IP) strict et plafond global plus haut de l'adresse (un tiers
 * qui connaît l'adresse ne bloque pas le chauffeur depuis une autre IP) —, puis compte (1 h).
 * Réponses :
 *  - 200 { code: "DELETED" } : tout est supprimé (données, fichiers, compte de connexion) ;
 *  - 200 { code: "DRIVER_PROFILE_DELETED", pending } : profil chauffeur supprimé, compte de gestion conservé ;
 *  - 202 { code: "DELETION_PENDING" } : données effacées, fichiers ou compte de connexion en cours de suppression
 *    (repris automatiquement par le serveur) ;
 *  - 401 UNAUTHORIZED (mot de passe à demander) / INVALID_CREDENTIALS, 404 NOT_DRIVER, 409 RIDES_ASSIGNED
 *    (message à afficher), 422, 429, 500 ;
 *  - 503 UNAVAILABLE : Supabase Auth injoignable (réseau, erreur 5xx, limite de débit) — ni « session expirée » ni
 *    « mot de passe incorrect » : rien n'a été vérifié, réessayer.
 */
export async function POST(req: Request) {
  const res = await handle(req);
  for (const [k, v] of Object.entries(driverAppCors(req))) res.headers.set(k, v);
  return res;
}

const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });
const unavailable = () =>
  NextResponse.json(
    { ok: false, code: "UNAVAILABLE", error: "Service momentanément indisponible : réessayez." },
    { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } },
  );

/** Client anonyme isolé : aucune session conservée (ni cookie, ni stockage, ni rafraîchissement). */
const isolatedClient = () =>
  createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

/**
 * Supabase Auth n'a pas répondu (réseau, 5xx, réponse illisible) ou limite son débit : aucune décision sur le jeton
 * ni sur le mot de passe. Un refus (400 session absente, 401, 403) n'en est pas un.
 */
function authUnavailable(error: AuthError) {
  return isAuthRetryableFetchError(error) || !error.status || error.status >= 500 || error.status === 429;
}

async function handle(req: Request): Promise<NextResponse> {
  // IP regroupée (IPv6 : préfixe /64), comme la connexion : mêmes clés de couple (adresse, IP)
  const ip = ipBucket(ipFromHeaders(req.headers));
  const body = (await req.json().catch(() => null)) as unknown;
  const credentials = loginSchema.safeParse(body);

  const limit = await rateLimitAll([
    { key: `ddelete:ip:${ip}`, limit: 20, windowSec: WINDOW },
    ...(credentials.success
      ? [
          { key: driverLoginPairKey(credentials.data.email, ip), limit: 6, windowSec: DRIVER_LOGIN_WINDOW },
          { key: driverLoginEmailKey(credentials.data.email), limit: 50, windowSec: DRIVER_LOGIN_WINDOW },
        ]
      : []),
  ]);
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, code: "RATE_LIMITED", error: "Trop de tentatives : réessayez dans quelques minutes." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(WINDOW) } },
    );
  }
  if (!confirmSchema.safeParse(body).success) {
    return reply(422, { ok: false, code: "CONFIRMATION_REQUIRED", error: "Confirmez la suppression." });
  }

  // 1) Jeton de l'application
  let userId: string | null = null;
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (token && token.length <= 8192) {
    const { data, error } = await isolatedClient().auth.getUser(token);
    if (data.user) userId = data.user.id;
    else if (error && authUnavailable(error)) return unavailable();
    // Sinon : jeton refusé (expiré, session révoquée…) → mot de passe
  }

  // 2) À défaut : e-mail + mot de passe
  if (!userId) {
    if (!credentials.success) {
      return reply(401, {
        ok: false,
        code: "UNAUTHORIZED",
        error: "Session expirée : saisissez le mot de passe de votre compte pour confirmer la suppression.",
      });
    }
    const check = await verifyPassword(credentials.data.email, credentials.data.password);
    if (check.status === "unavailable") return unavailable();
    if (check.status === "invalid") return reply(401, { ok: false, code: "INVALID_CREDENTIALS", error: "E-mail ou mot de passe incorrect." });
    userId = check.userId;
    // Mot de passe juste : compteurs de l'adresse remis à zéro, comme après une connexion réussie
    await resetRateLimit(driverLoginPairKey(credentials.data.email, ip), DRIVER_LOGIN_WINDOW);
    await resetRateLimit(driverLoginEmailKey(credentials.data.email), DRIVER_LOGIN_WINDOW);
  }

  const perAccount = await rateLimit(`ddelete:user:${userId}`, 5, 3600);
  if (!perAccount.ok) return reply(429, { ok: false, code: "RATE_LIMITED", error: "Trop de tentatives : réessayez plus tard." });

  const result = await deleteDriverAccount({ userId });
  if (!result.ok) return reply(result.status, { ok: false, code: result.code, error: result.message });
  return reply(result.code === "DELETION_PENDING" ? 202 : 200, {
    ok: true,
    code: result.code,
    pending: result.pending,
    message: result.message,
  });
}

type PasswordCheck = { status: "ok"; userId: string } | { status: "invalid" } | { status: "unavailable" };

/**
 * Vérifie e-mail + mot de passe. La session ouverte pour la vérification est aussitôt révoquée (celle-ci seulement :
 * un gérant garde ses sessions du tableau de bord).
 *  - « invalid_credentials » : identifiants incorrects ;
 *  - autre refus (compte Auth banni : suspension, bannissement, centrale suspendue…), où Supabase Auth ne dit rien
 *    du mot de passe : empreinte bcrypt vérifiée par la base (fiche chauffeur non supprimée uniquement) ;
 *  - Supabase Auth ou la base injoignable : « unavailable », jamais « incorrect ».
 */
async function verifyPassword(email: string, password: string): Promise<PasswordCheck> {
  const client = isolatedClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (!error && data.user) {
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
    return { status: "ok", userId: data.user.id };
  }
  if (!error || authUnavailable(error)) return { status: "unavailable" };
  if (error.code === "invalid_credentials" || /invalid login credentials/i.test(error.message)) return { status: "invalid" };

  const { data: id, error: checkError } = await createAdminClient().rpc("svc_driver_password_check", {
    p_email: email,
    p_password: password,
  });
  if (checkError) {
    console.error("[delete-account] vérification du mot de passe impossible", checkError.message);
    return { status: "unavailable" };
  }
  return typeof id === "string" ? { status: "ok", userId: id } : { status: "invalid" };
}
