import { loginSchema } from "@rydar/shared";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const WINDOW = 15 * 60;

/** Refus de connexion (403) : code stable lu par l'application + message FR prêt à afficher. */
type DriverLoginDenied = "BANNED" | "REJECTED" | "INACTIVE" | "ORGANIZATION_SUSPENDED" | "NOT_DRIVER";
/** Connexion acceptée : chauffeur actif, ou candidat inscrit par lien en attente de validation (écran d'attente + documents). */
type DriverLoginState = "active" | "pending";

const DENIED: Record<DriverLoginDenied, string> = {
  BANNED: "Accès refusé : ce compte a été banni par la centrale.",
  REJECTED: "Votre candidature n'a pas été retenue.",
  INACTIVE: "Compte chauffeur inactif : contactez votre centrale.",
  ORGANIZATION_SUSPENDED: "Votre centrale est suspendue sur Rydar Drive : connexion impossible pour le moment.",
  NOT_DRIVER: "Ce compte n'est pas un compte chauffeur.",
};

type DriverRow = {
  id: string;
  status: string;
  application_status: string | null;
  banned_at: string | null;
  organization: { status: string } | { status: string }[] | null;
};

// L'app mobile n'est pas concernée par le CORS ; seules les origines listées
// (aperçu web de l'app chauffeur, ex. http://localhost:8081) sont autorisées.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = (process.env.DRIVER_APP_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
}

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

/**
 * Connexion de l'application chauffeur : anti brute force (IP + compte), puis contrôle du compte.
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
  for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
  return res;
}

/** Compte Auth banni (bannissement plateforme / centrale répercuté sur Supabase Auth). */
function isAuthBanned(error: { message?: string; code?: string } | null) {
  if (!error) return false;
  return error.code === "user_banned" || /banned/i.test(error.message ?? "");
}

async function login(req: Request): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "0.0.0.0";
  const parsed = loginSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_INPUT", error: "Identifiants invalides." }, { status: 400 });
  const { email, password } = parsed.data;

  const [byIp, byEmail] = await Promise.all([rateLimit(`dlogin:ip:${ip}`, 30, WINDOW), rateLimit(`dlogin:email:${email}`, 6, WINDOW)]);
  if (!byIp.ok || !byEmail.ok) {
    return NextResponse.json(
      { code: "RATE_LIMITED", error: "Trop de tentatives. Réessayez dans quelques minutes." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  // Mot de passe juste mais compte Auth banni : Supabase refuse la connexion (user_banned)
  if (isAuthBanned(error)) return NextResponse.json({ code: "BANNED", error: DENIED.BANNED }, { status: 403 });
  if (error || !data.session) {
    return NextResponse.json({ code: "INVALID_CREDENTIALS", error: "E-mail ou mot de passe incorrect." }, { status: 401 });
  }

  const deny = async (code: DriverLoginDenied) => {
    // Session ouverte par la vérification du mot de passe : révoquée aussitôt
    await auth.auth.signOut().catch(() => undefined);
    return NextResponse.json({ code, error: DENIED[code] }, { status: 403 });
  };

  const { data: row, error: rowError } = await createAdminClient()
    .from("drivers")
    .select("id, status, application_status, banned_at, organization:organizations(status)")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (rowError) {
    await auth.auth.signOut().catch(() => undefined);
    return NextResponse.json({ code: "UNAVAILABLE", error: "Connexion impossible pour le moment. Réessayez." }, { status: 503 });
  }
  const driver = row as DriverRow | null;
  if (!driver) return deny("NOT_DRIVER");
  const org = Array.isArray(driver.organization) ? driver.organization[0] : driver.organization;

  let state: DriverLoginState;
  if (driver.banned_at) return deny("BANNED");
  if (org?.status !== "active") return deny("ORGANIZATION_SUSPENDED");
  if (driver.application_status === "pending" && (driver.status === "inactive" || driver.status === "active")) state = "pending";
  else if (driver.application_status === "rejected") return deny("REJECTED");
  else if (driver.status === "active") state = "active";
  else return deny("INACTIVE");

  await resetRateLimit(`dlogin:email:${email}`, WINDOW);
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    state,
  });
}
