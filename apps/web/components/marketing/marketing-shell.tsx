import type { ReactNode } from "react";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

/**
 * Fond du haut de page : grille radar et lueur lime. « hero » : grand fond de l'accueil (globe) ; « page » : fond
 * plus court des autres pages ; « none » : aucun.
 */
export type MarketingBackdrop = "hero" | "page" | "none";

/**
 * Mise en page commune des pages du site vitrine : lien d'évitement, en-tête, contenu principal (#contenu) et pied
 * de page. Chaque page déclare ses propres métadonnées (voir seo.ts).
 */
export function MarketingShell({ children, backdrop = "page" }: { children: ReactNode; backdrop?: MarketingBackdrop }) {
  return (
    <>
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-brand-fg"
      >
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" className="relative overflow-x-clip">
        {backdrop === "hero" && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[1100px]">
            <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_70%_20%,black_15%,transparent_65%)]" />
            <div className="absolute right-[-12%] top-[-14%] size-[980px] rounded-full bg-brand/[0.06] blur-[170px]" />
          </div>
        )}
        {backdrop === "page" && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[720px]">
            <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_50%_0%,black_10%,transparent_62%)]" />
            <div className="absolute left-1/2 top-[-420px] size-[900px] -translate-x-1/2 rounded-full bg-brand/[0.05] blur-[160px]" />
          </div>
        )}
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
