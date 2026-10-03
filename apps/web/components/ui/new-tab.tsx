/**
 * Lien qui s'ouvre dans un nouvel onglet (target="_blank") : l'annonce aux lecteurs d'écran (RGAA 13.2, WCAG 3.2.5),
 * sans changer l'affichage. À placer à la fin du texte du lien ; une flèche « ↗ » visible reste aria-hidden.
 */
export function NewTabHint() {
  return <span className="sr-only"> (nouvel onglet)</span>;
}
