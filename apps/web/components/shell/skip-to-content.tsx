/** Lien d'évitement (clavier, lecteur d'écran) : saute la barre latérale vers le contenu principal (#contenu). */
export function SkipToContent() {
  return (
    <a
      href="#contenu"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-brand-fg"
    >
      Aller au contenu
    </a>
  );
}
