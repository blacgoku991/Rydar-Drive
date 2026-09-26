import { driverResetConfirmSchema, NEW_PASSWORD_MAX, NEW_PASSWORD_MIN } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { driverAppCors } from "@/lib/driver-app-cors";
import { checkDriverAccount, DRIVER_DENIED, DRIVER_LOGIN_WINDOW, driverLoginEmailKey, isAuthBanned } from "@/lib/driver-session";
import { env } from "@/lib/env";
import { rateLimitAll, resetRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

const WINDOW = 15 * 60;

/** Premier champ refusé → message affiché par l'application. */
const INVALID: Record<string, string> = {
  email: "Adresse e-mail invalide.",
  code: "Code invalide : saisissez les chiffres reçus par e-mail.",
  password: `Mot de passe : entre ${NEW_PASSWORD_MIN} et ${NEW_PASSWORD_MAX} caractères.`,
};

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: driverAppCors(req) });
}

/**
 * « Mot de passe oublié » de l'application chauffeur, étape 2 : le chauffeur saisit dans l'app le code
 * reçu par e-mail ({{ .Token }} du modèle « Reset password ») et son nouveau mot de passe.
 *  - 200 { access_token, refresh_token, expires_at, state } : mot de passe changé, session ouverte
 *    (l'app l'installe via auth.setSession(), comme après /api/auth/driver-login) ; Supabase Auth révoque
 *    les autres sessions du compte ;
 *  - 400 INVALID_INPUT | OTP_INVALID (code faux, expiré ou déjà utilisé) ;
 *  - 422 SAME_PASSWORD | WEAK_PASSWORD | PASSWORD_UPDATE_FAILED : code valide mais mot de passe refusé par
 *    Supabase Auth (le code a été consommé : l'app propose d'en demander un nouveau) ;
 *  - 403 { code, error } : mêmes refus que driver-login (BANNED, REJECTED, INACTIVE, ORGANIZATION_SUSPENDED,
 *    NOT_DRIVER) — le mot de passe est changé, mais aucune session n'est remise ;
 *  - 429 RATE_LIMITED (par IP puis par adresse), 503 UNAVAILABLE.
 * Le lien du même e-mail ({{ .ConfirmationURL }} → /auth/set-password?app=driver) reste utilisable en secours.
 */
export async function POST(req: Request) {
  const res = await confirm(req);
  for (const [k, v] of Object.entries(driverAppCors(req))) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

async function confirm(req: Request): Promise<NextResponse> {
  const parsed = driverResetConfirmSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return NextResponse.json({ code: "INVALID_INPUT", error: INVALID[field] ?? "Demande invalide.", field: field || null }, { status: 400 });
  }
  const { email, code, password } = parsed.data;

  // IP d'abord : une requête refusée pour son IP ne consomme pas le quota de l'adresse visée.
  // 8 essais / 15 min / adresse : deviner un code à 6 chiffres pendant sa durée de validité reste hors de portée.
  const limit = await rateLimitAll([
    { key: `dresetc:ip:${await clientIp()}`, limit: 20, windowSec: WINDOW },
    { key: `dresetc:email:${email}`, limit: 8, windowSec: WINDOW },
  ]);
  if (!limit.ok) {
    const minutes = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60_000));
    return NextResponse.json(
      { code: "RATE_LIMITED", error: `Trop de tentatives. Réessayez dans ${minutes} min.` },
      { status: 429, headers: { "Retry-After": String(minutes * 60) } },
    );
  }

  const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await auth.auth.verifyOtp({ email, token: code, type: "recovery" });
  if (isAuthBanned(error)) return NextResponse.json({ code: "BANNED", error: DRIVER_DENIED.BANNED }, { status: 403 });
  if (error?.status === 429 || error?.code === "over_request_rate_limit") {
    return NextResponse.json({ code: "RATE_LIMITED", error: "Trop de tentatives. Réessayez dans quelques minutes." }, { status: 429 });
  }
  if (error && (!error.status || error.status >= 500)) {
    // Supabase Auth injoignable ou en erreur : ce n'est pas le code qui est en cause
    console.error(`[driver-password-reset/confirm] verifyOtp ${error.status ?? ""} ${error.code ?? ""} ${error.message}`);
    return NextResponse.json({ code: "UNAVAILABLE", error: "Service indisponible pour le moment. Réessayez." }, { status: 503 });
  }
  if (error || !data.session || !data.user) {
    return NextResponse.json({ code: "OTP_INVALID", error: "Code incorrect ou expiré." }, { status: 400 });
  }

  const { error: updateError } = await auth.auth.updateUser({ password });
  if (updateError) {
    // Session de réinitialisation jamais remise à l'app : révoquée (celle-ci seulement)
    await auth.auth.signOut({ scope: "local" }).catch(() => undefined);
    if (updateError.code === "same_password") {
      return NextResponse.json({ code: "SAME_PASSWORD", error: "Choisissez un mot de passe différent de l'ancien." }, { status: 422 });
    }
    if (updateError.code === "weak_password") {
      return NextResponse.json({ code: "WEAK_PASSWORD", error: "Mot de passe trop simple : mélangez lettres, chiffres et symboles." }, { status: 422 });
    }
    console.error(`[driver-password-reset/confirm] updateUser ${updateError.status ?? ""} ${updateError.code ?? ""} ${updateError.message}`);
    return NextResponse.json(
      { code: "PASSWORD_UPDATE_FAILED", error: "Impossible d'enregistrer le mot de passe. Demandez un nouveau code." },
      { status: 422 },
    );
  }

  // Mot de passe changé : Supabase Auth a déjà révoqué les autres sessions du compte (autres appareils)
  const check = await checkDriverAccount(auth, data.user.id);
  if (!check.ok) return NextResponse.json({ code: check.code, error: check.error }, { status: check.status });

  // Propriété de l'adresse prouvée : les échecs de connexion passés ne bloquent plus le compte
  await resetRateLimit(driverLoginEmailKey(email), DRIVER_LOGIN_WINDOW);
  await resetRateLimit(`dresetc:email:${email}`, WINDOW);
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    state: check.state,
  });
}
