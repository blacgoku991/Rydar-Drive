"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { ORG_COOKIE, isAdminRole, requireUser } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { LEGAL_VERSION, ORG_LEGAL_VERSION } from "@/lib/legal";
import { getOrgContext } from "@/lib/org-context";

export async function switchOrganization(orgId: string) {
  const session = await requireUser();
  if (!session.memberships.some((m) => m.org.id === orgId)) return;
  const jar = await cookies();
  jar.set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  await session.supabase.from("users").update({ last_active_org_id: orgId }).eq("id", session.user.id);
}

type AcceptResult = { ok: true } | { ok: false; error: string };

/** Au nom de l'organisation (owner / admin) : CGV + accord de traitement, version ORG_LEGAL_VERSION. */
const ORG_DOCUMENTS = ["cgv", "dpa"];
/** À titre personnel (tout membre) : CGU + politique de confidentialité, version LEGAL_VERSION. */
const USER_DOCUMENTS = ["cgu", "privacy"];

/**
 * accept_legal_documents pour une version, au nom de la centrale active (idempotent : une acceptation déjà
 * enregistrée garde sa date).
 */
async function acceptDocuments(
  ctx: NonNullable<Awaited<ReturnType<typeof getOrgContext>>>,
  documents: string[],
  version: string,
): Promise<AcceptResult> {
  const { data, error } = await ctx.supabase.rpc("accept_legal_documents", {
    p_documents: documents,
    p_version: version,
    p_org: ctx.org.id,
    p_source: "web",
  });
  if (error) return { ok: false, error: actionError(error, "Acceptation impossible pour le moment.") };
  const res = (data ?? {}) as { ok?: boolean; message?: string };
  if (!res.ok) return { ok: false, error: res.message ?? "Acceptation impossible." };
  return { ok: true };
}

/**
 * Owner / admin : CGV et accord de traitement des données au nom de la centrale (ORG_LEGAL_VERSION), puis CGU et
 * politique de confidentialité à titre personnel (LEGAL_VERSION). Deux versions, donc deux appels idempotents : un
 * échec du second laisse le premier enregistré (le bandeau des CGU prend alors le relais).
 */
export async function acceptOrgTerms(): Promise<AcceptResult> {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return { ok: false, error: "Réservé au propriétaire et aux administrateurs." };
  const org = await acceptDocuments(ctx, ORG_DOCUMENTS, ORG_LEGAL_VERSION);
  if (!org.ok) return org;
  const personal = await acceptDocuments(ctx, USER_DOCUMENTS, LEGAL_VERSION);
  revalidatePath("/dashboard", "layout");
  return personal;
}

/** Tout membre (dispatcher compris) : CGU et politique de confidentialité acceptées à titre personnel (LEGAL_VERSION). */
export async function acceptUserTerms(): Promise<AcceptResult> {
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const res = await acceptDocuments(ctx, USER_DOCUMENTS, LEGAL_VERSION);
  if (res.ok) revalidatePath("/dashboard", "layout");
  return res;
}
