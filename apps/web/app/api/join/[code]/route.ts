import { NextResponse } from "next/server";
import { applyWithJoinLink, loadJoinInfo } from "@/lib/join";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

// Inscription d'un chauffeur depuis l'application, par le lien d'une centrale (même logique que /rejoindre/{code}).
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Carte de la centrale affichée dans l'app avant l'inscription. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const limit = await rateLimit(`join:info:${await clientIp()}`, 60, 900);
  if (!limit.ok) return NextResponse.json({ ok: false, error: "Trop de tentatives. Réessayez dans quelques minutes." }, { status: 429, headers: NO_STORE });
  const info = await loadJoinInfo((await params).code);
  if (!info?.organization) {
    return NextResponse.json({ ok: false, error: "Ce lien d'inscription n'est plus actif. Demandez un nouveau lien à la centrale." }, { status: 404, headers: NO_STORE });
  }
  const o = info.organization;
  return NextResponse.json(
    { ok: true, autoApprove: !!info.auto_approve, organization: { name: o.name, logoUrl: o.logo_url, brandColor: o.brand_color, city: o.city, phone: o.phone } },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "Requête invalide." }, { status: 400, headers: NO_STORE });
  const result = await applyWithJoinLink((await params).code, body);
  const status = result.ok ? 200 : /Trop de tentatives/.test(result.error) ? 429 : 400;
  return NextResponse.json(result, { status, headers: NO_STORE });
}
