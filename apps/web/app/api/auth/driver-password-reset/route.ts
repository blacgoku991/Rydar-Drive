import { driverPasswordResetSchema } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { after, NextResponse } from "next/server";
import { driverAppCors } from "@/lib/driver-app-cors";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

const HOUR = 60 * 60;
const NO_STORE = { "Cache-Control": "no-store" };

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: driverAppCors(req) });
}

/**
 * « Mot de passe oublié » de l'application chauffeur.
 *  - 200 { ok: true } dans tous les cas où l'adresse est valide : la réponse ne dit jamais si un compte
 *    existe (anti-énumération), et l'e-mail part APRÈS la réponse (after) pour que le temps de réponse
 *    ne le trahisse pas non plus ;
 *  - 400 INVALID_INPUT (adresse invalide), 429 RATE_LIMITED (par IP et par adresse).
 * Le lien du mail ouvre /auth/set-password?app=driver : flux implicite (jetons dans le fragment de l'URL),
 * car la demande ne vient pas du navigateur qui ouvrira le lien (un code PKCE y serait inutilisable).
 * Redirection acceptée par Supabase sans réglage : même domaine que la « Site URL ».
 */
export async function POST(req: Request) {
  const res = await requestReset(req);
  for (const [k, v] of Object.entries(driverAppCors(req))) res.headers.set(k, v);
  return res;
}

async function requestReset(req: Request): Promise<NextResponse> {
  const parsed = driverPasswordResetSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_INPUT", error: "Adresse e-mail invalide." }, { status: 400, headers: NO_STORE });
  }
  const { email } = parsed.data;

  const [byIp, byEmail] = await Promise.all([rateLimit(`dreset:ip:${await clientIp()}`, 10, HOUR), rateLimit(`dreset:email:${email}`, 3, HOUR)]);
  if (!byIp.ok || !byEmail.ok) {
    const minutes = Math.max(1, Math.ceil((Math.max(byIp.resetAt, byEmail.resetAt) - Date.now()) / 60_000));
    return NextResponse.json(
      { ok: false, code: "RATE_LIMITED", error: `Trop de demandes. Réessayez dans ${minutes} min.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(minutes * 60) } },
    );
  }

  after(async () => {
    const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
    });
    const { error } = await auth.auth.resetPasswordForEmail(email, { redirectTo: `${env.appUrl}/auth/set-password?app=driver` });
    // Journal serveur seulement (SMTP absent ou refusé, limite Supabase…) : jamais renvoyé à l'app
    if (error) console.error(`[driver-password-reset] ${error.status ?? ""} ${error.code ?? ""} ${error.message}`);
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
