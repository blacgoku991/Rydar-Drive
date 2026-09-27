import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { LegalLinks } from "@/components/legal/legal-links";
import { CONTACT_EMAIL, DEMO_HREF } from "./contact";
import { NAV_LINKS } from "./nav";
import { fr } from "./typo";

const heading = "text-[12px] font-semibold uppercase tracking-[0.16em] text-fg";
const item = "text-[13.5px] text-fg-muted transition-colors hover:text-fg";

export function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-line bg-ink-950/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo size={26} />
          <p className="mt-4 max-w-sm text-[13.5px] leading-relaxed text-fg-muted">
            {fr("Logiciel de dispatch VTC pour centrales et flottes. Les courses, les clients et les prix appartiennent à votre centrale.")}
          </p>
        </div>
        <nav aria-label="Pied de page : sections">
          <p className={heading}>Produit</p>
          <ul className="mt-4 space-y-2.5">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={item}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Pied de page : accès">
          <p className={heading}>Accès</p>
          <ul className="mt-4 space-y-2.5">
            <li>
              <Link href="/login" className={item}>
                Se connecter
              </Link>
            </li>
            <li>
              <a href={DEMO_HREF} className={item}>
                Demander une démo
              </a>
            </li>
            <li>
              <a href={`mailto:${CONTACT_EMAIL}`} className={item}>
                {CONTACT_EMAIL}
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 md:flex-row md:items-center md:justify-between">
          <LegalLinks className="text-[12.5px]" />
          <p className="text-[12.5px] text-fg-muted">© {new Date().getFullYear()} Rydar Drive</p>
        </div>
      </div>
    </footer>
  );
}
