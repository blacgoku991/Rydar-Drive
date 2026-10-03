/**
 * Lien qui s'ouvre dans un nouvel onglet (target="_blank") : l'annonce aux lecteurs d'écran (RGAA 13.2, WCAG 3.2.5),
 * sans changer l'affichage. À placer à la fin du texte du lien ; une flèche « ↗ » visible reste aria-hidden.
 * Masquage SANS position absolue (contrairement à sr-only) : dans un lien tronqué (truncate) non positionné, un texte
 * en position absolue sortait de la boîte et faisait défiler la page à 320 px (WCAG 1.4.10).
 */
export function NewTabHint() {
  return <span className="-m-px inline-block size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]"> (nouvel onglet)</span>;
}
