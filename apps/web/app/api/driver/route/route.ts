import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { driverAppCors } from "@/lib/driver-app-cors";
import { env } from "@/lib/env";
import { lruCache } from "@/lib/geo/cache";
import { computeNavRoute } from "@/lib/geo/routing";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const schema = z.object({ from: point, to: point });
/**
 * Jeton déjà vérifié → utilisateur chauffeur (évite un appel à Supabase Auth à chaque recalcul). 60 s seulement : un
 * chauffeur suspendu ou banni (sessions révoquées) perd vite le guidage.
 */
const drivers = lruCache<string>(2000, 60_000);

export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: driverAppCors(req) });
}

/**
 * Utilisateur du jeton d'accès de l'app, s'il est chauffeur ACTIF (driver_account_state : non banni, centrale active,
 * fiche active, candidature validée). Candidat en attente ou refusé, fiche désactivée ou supprimée : refusé.
 */
async function driverUser(req: Request): Promise<string | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token || token.length > 8192) return null;
  const k = createHash("sha256").update(token).digest("base64url");
  const cached = drivers.get(k);
  if (cached) return cached;
  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: user } = await client.auth.getUser(token);
  if (!user.user) return null;
  const { data: account } = await client.rpc("driver_account_state");
  if ((account as { state?: string } | null)?.state !== "active") return null;
  drivers.set(k, user.user.id);
  return user.user.id;
}

/**
 * Guidage de l'app chauffeur : itinéraire routier (tracé encodé) + étapes en français, pour afficher le trajet
 * et la prochaine manœuvre sur la carte de l'app (Waze / Plans restent proposés).
 */
export async function POST(req: Request) {
  const res = await handle(req);
  for (const [k, v] of Object.entries(driverAppCors(req))) res.headers.set(k, v);
  return res;
}

async function handle(req: Request): Promise<NextResponse> {
  const uid = await driverUser(req);
  if (!uid) return NextResponse.json({ error: "Accès refusé." }, { status: 401, headers: NO_STORE });
  const limit = await rateLimit(`droute:${uid}`, 30, 60);
  if (!limit.ok) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429, headers: NO_STORE });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 422, headers: NO_STORE });
  const r = await computeNavRoute(parsed.data.from, parsed.data.to);
  return NextResponse.json(
    { distanceM: r.distanceM, durationS: r.durationS, polyline: r.polyline, approximate: r.approximate, steps: r.steps },
    { headers: NO_STORE },
  );
}
