import "server-only";
import { cookies } from "next/headers";
import { ORG_COOKIE, getSession, pickMembership } from "@/lib/auth";
import { ORG_VIEW_COOKIE } from "@/lib/org-view";

/** Variante « route handler » de requireOrg : renvoie null au lieu de rediriger. */
export async function getOrgContext() {
  const session = await getSession();
  if (!session || !session.memberships.length) return null;
  const jar = await cookies();
  const wanted = jar.get(ORG_COOKIE)?.value ?? session.profile.last_active_org_id;
  const current = pickMembership(session.memberships, wanted);
  if (current.org.status !== "active") return null;
  // Jamais au nom d'une AUTRE centrale que celle affichée par le tableau de bord : accès retiré ou centrale archivée
  // pendant la saisie → pickMembership se rabattrait sur une autre centrale du compte (course, message, réglage créés
  // chez elle). Refus ; le rechargement de la page affiche la centrale réellement accessible.
  const viewed = jar.get(ORG_VIEW_COOKIE)?.value;
  if (viewed && viewed !== current.org.id) return null;
  // Fiche chauffeur du compte DANS cette organisation (Flotte Privée : celle du propriétaire), sinon null — même règle
  // que requireOrg (une fiche d'une autre organisation du compte n'est jamais transmise)
  const driverId = session.driverOrgId === current.org.id ? session.driverId : null;
  return { ...session, org: current.org, role: current.role, driverId };
}
