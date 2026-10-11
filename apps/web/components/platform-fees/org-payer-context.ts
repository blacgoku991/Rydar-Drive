import "server-only";
// Frais plateforme (côté centrale) : organisation courante, y compris SUSPENDUE (elle doit pouvoir régler Rydar).
// MÊME choix que requireOrg / getOrgContext (pickMembership : cookie → dernière utilisée → première ACTIVE) : « J'ai
// payé » et l'export du relevé visent la centrale affichée, jamais une autre centrale du compte. Le rôle owner / admin
// est vérifié en base par chaque RPC (assert_platform_payer) et par les appelants avant tout appel.
import { dateTimeFormat } from "@rydar/shared";
import { cookies } from "next/headers";
import { ORG_COOKIE, getSession, isAdminRole, pickMembership } from "@/lib/auth";
import { ORG_VIEW_COOKIE } from "@/lib/org-view";

/**
 * `action` : écriture (« J'ai payé », retrait, décision réseau) → refusée si la centrale résolue diffère de la centrale
 * AFFICHÉE (cookie rd_view, comme getOrgContext) : accès retiré ou centrale archivée page ouverte, pickMembership se
 * rabattrait sinon sur une AUTRE centrale du compte et la déclaration partirait chez elle (audit p5, onglets-2).
 * Les pages (/suspended) gardent la centrale résolue : elles posent ensuite rd_view (RememberViewedOrg).
 */
export async function getPayerContext(opts: { action?: boolean } = {}) {
  const session = await getSession();
  if (!session || !session.memberships.length) return null;
  const jar = await cookies();
  const wanted = jar.get(ORG_COOKIE)?.value ?? session.profile.last_active_org_id;
  const current = pickMembership(session.memberships, wanted);
  if (current.org.status !== "active" && current.org.status !== "suspended") return null;
  if (opts.action) {
    const viewed = jar.get(ORG_VIEW_COOKIE)?.value;
    if (viewed && viewed !== current.org.id) return null;
  }
  return { ...session, org: current.org, role: current.role, canPay: isAdminRole(current.role) };
}

/** « 2026-09 » valide, sinon null. */
export function parseMonth(value: string | null | undefined): string | null {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

/** Mois courant (« YYYY-MM ») dans le fuseau de la centrale. */
export function currentMonth(timeZone: string, now = new Date()): string {
  const parts = dateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}`;
}
