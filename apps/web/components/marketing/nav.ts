/** Pages du site vitrine (en-tête et pied de page). */
export const NAV_LINKS = [
  { href: "/services", label: "Services" },
  { href: "/avantages", label: "Avantages" },
  { href: "/tarifs", label: "Tarifs" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
] as const;

/** Lien de navigation correspondant à la page affichée (la page elle-même ou l'une de ses sous-pages). */
export function isCurrentPage(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Anciennes ancres de la page d'accueil unique (liens partagés, favoris) → pages qui ont repris ces sections.
 * `null` : ancre inconnue ou toujours valable sur l'accueil (lien d'évitement #contenu…).
 */
const LEGACY_ANCHORS = new Map<string, string>([
  ["#services", "/services"],
  ["#avantages", "/avantages"],
  ["#fonctionnement", "/services#fonctionnement"],
  ["#tarifs", "/tarifs"],
  ["#faq", "/faq"],
]);

export function legacyAnchorTarget(hash: string): string | null {
  return LEGACY_ANCHORS.get(hash) ?? null;
}
