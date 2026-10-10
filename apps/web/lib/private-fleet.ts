import "server-only";
// Flotte Privée (docs/FLOTTE-PRIVEE.md § 7) : organisation flotte d'un seul chauffeur, le propriétaire. Le tableau de
// bord n'en montre que l'espace épuré (Accueil, Agenda, Réservations, Mon site, Mon profil chauffeur, Activité, Frais
// Rydar, Réglages) : les autres pages sont redirigées ou en 404 et leurs actions serveur refusées ici. La base reste le
// dernier rempart (gardes C, D, E et org_limits de 20260924007600) ; ce module ne fait qu'expliquer et éviter des
// lectures inutiles. Drapeau lu par la session (lib/auth.ts : organizations.private_fleet, relu à chaque requête).
import { ERROR_MESSAGES } from "@rydar/shared";
import { notFound, redirect } from "next/navigation";

type OrgFlag = { id?: string; private_fleet?: boolean | null } | null | undefined;

/** Organisation en Flotte Privée (drapeau absent ou illisible : organisation standard). */
export function isPrivateFleet(org: OrgFlag): boolean {
  return org?.private_fleet === true;
}

/**
 * Page masquée en Flotte Privée : 404 (« notFound ») ou redirection vers la page qui la remplace. Organisation
 * standard : rien (la page continue). À appeler juste après requireOrg(), avant toute lecture.
 */
export function privateFleetPage(ctx: { org: OrgFlag }, action: "notFound" | { redirect: string }): void {
  if (!isPrivateFleet(ctx.org)) return;
  if (action === "notFound") notFound();
  redirect(action.redirect);
}

/**
 * Action serveur refusée en Flotte Privée (avant toute écriture, toute création de compte ou tout appel externe) :
 * réponse { ok: false, error } à renvoyer telle quelle ; null pour une organisation standard (ou sans contexte : le
 * contrôle d'accès de l'action répond alors).
 */
export function refuseInPrivateFleet(ctx: { org: OrgFlag } | null | undefined): { ok: false; error: string } | null {
  return ctx && isPrivateFleet(ctx.org) ? { ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED } : null;
}
