// Centrale AFFICHÉE par le tableau de bord (rd_view, posé par le navigateur à chaque affichage d'une centrale) : une
// action serveur ou une route du tableau de bord est refusée si la centrale résolue côté serveur en diffère (accès
// retiré, centrale archivée : le repli de pickMembership basculerait sinon, sans prévenir, sur une AUTRE centrale du
// compte). Lisible par les scripts (posé par eux), sans donnée personnelle : l'identifiant de la centrale seulement.
export const ORG_VIEW_COOKIE = "rd_view";

/** Enregistre la centrale affichée (navigateur seulement ; cookie de session, toute l'application). */
export function rememberViewedOrg(orgId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return;
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${ORG_VIEW_COOKIE}=${orgId}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // cookies bloqués : aucun contrôle supplémentaire (comportement antérieur)
  }
}
