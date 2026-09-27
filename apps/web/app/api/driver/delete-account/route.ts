import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { driverAppCors } from "@/lib/driver-app-cors";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Bucket privé des justificatifs (apps/driver/src/lib/api.ts DOCUMENTS_BUCKET). */
const DOCUMENTS_BUCKET = "driver-documents";
const schema = z.object({ confirm: z.literal("SUPPRIMER") });

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: driverAppCors(req) });
}

/**
 * Suppression du compte par le chauffeur, depuis l'application (App Store 5.1.1(v), Google Play).
 * Bearer = jeton de l'app ; corps { confirm: "SUPPRIMER" }.
 *  - 200 { ok, code: "DELETED" } : données personnelles supprimées ou anonymisées (svc_delete_driver_account),
 *    justificatifs effacés du stockage, compte de connexion supprimé ;
 *  - 409 RIDES_ASSIGNED : une course lui est attribuée (message à afficher) ;
 *  - 401 / 403 / 422 / 429.
 * Un chauffeur qui est aussi membre d'une centrale (gérant, dispatcher) ou super admin garde son compte de
 * connexion : seul son profil chauffeur est supprimé (code DRIVER_PROFILE_DELETED).
 */
export async function POST(req: Request) {
  const res = await handle(req);
  for (const [k, v] of Object.entries(driverAppCors(req))) res.headers.set(k, v);
  return res;
}

async function handle(req: Request): Promise<NextResponse> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token || token.length > 8192) return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Accès refusé." }, { status: 401, headers: NO_STORE });
  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: auth } = await client.auth.getUser(token);
  const userId = auth.user?.id;
  if (!userId) return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Session expirée : reconnectez-vous." }, { status: 401, headers: NO_STORE });

  const limit = await rateLimit(`ddelete:${userId}`, 5, 3600);
  if (!limit.ok) return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Trop de tentatives : réessayez plus tard." }, { status: 429, headers: NO_STORE });
  if (!schema.safeParse(await req.json().catch(() => null)).success) {
    return NextResponse.json({ ok: false, code: "CONFIRMATION_REQUIRED", error: "Confirmez la suppression." }, { status: 422, headers: NO_STORE });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("svc_delete_driver_account", { p_user_id: userId });
  if (error) return NextResponse.json({ ok: false, code: "SERVER_ERROR", error: "Suppression impossible pour le moment. Réessayez." }, { status: 500, headers: NO_STORE });
  const r = data as { ok: boolean; code: string; message?: string; files?: string[] };
  if (!r.ok) {
    const status = r.code === "RIDES_ASSIGNED" ? 409 : 403;
    return NextResponse.json({ ok: false, code: r.code, error: r.message ?? "Suppression impossible." }, { status, headers: NO_STORE });
  }

  // Justificatifs : fichiers effacés du stockage (les lignes le sont déjà)
  const files = (r.files ?? []).filter(Boolean);
  if (files.length) await admin.storage.from(DOCUMENTS_BUCKET).remove(files).catch(() => null);

  // Compte de connexion : supprimé, sauf s'il sert aussi à gérer une centrale ou la plateforme
  const [{ count: memberships }, { data: profile }] = await Promise.all([
    admin.from("organization_users").select("id", { count: "exact", head: true }).eq("user_id", userId),
    admin.from("users").select("is_super_admin").eq("id", userId).maybeSingle(),
  ]);
  if ((memberships ?? 0) > 0 || profile?.is_super_admin) {
    return NextResponse.json({ ok: true, code: "DRIVER_PROFILE_DELETED" }, { headers: NO_STORE });
  }
  const { error: delError } = await admin.auth.admin.deleteUser(userId);
  if (delError) {
    // Profil déjà anonymisé ; la connexion est de toute façon refusée (fiche inactive, sessions révoquées)
    return NextResponse.json({ ok: true, code: "DELETED", pending: true }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, code: "DELETED" }, { headers: NO_STORE });
}
