import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { LegalLinks } from "@/components/legal/legal-links";
import { PRICING_HREF, QUESTION_HREF } from "./contact";
import { NAV_LINKS } from "./nav";
import { fr } from "./typo";

const heading = "text-[12px] font-semibold uppercase tracking-[0.16em] text-fg";
const item = "text-[13.5px] text-fg-muted transition-colors hover:text-fg";

/** Pages produit du pied de page : celles de l'en-tête (sauf Contact, dans sa propre colonne) et le fonctionnement. */
const PRODUCT_LINKS = [
  ...NAV_LINKS.filter((l) => l.href !== "/contact").slice(0, 2),
  { href: "/services#fonctionnement", label: "Fonctionnement" },
  ...NAV_LINKS.filter((l) => l.href !== "/contact").slice(2),
];

const CONTACT_LINKS = [
  { href: PRICING_HREF, label: "Demander un tarif" },
  { href: QUESTION_HREF, label: "Poser une question" },
  { href: "/contact", label: "Contact" },
];

export function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-line bg-ink-950/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="sm:col-span-2 md:col-span-1">
          <Logo size={26} />
          <p className="mt-4 max-w-sm text-[13.5px] leading-relaxed text-fg-muted">
            {fr("Logiciel de dispatch VTC pour centrales et flottes. Les courses, les clients et les prix appartiennent à votre centrale.")}
          </p>
        </div>
        <nav aria-label="Pied de page : produit">
          <p className={heading}>Produit</p>
          <ul className="mt-4 space-y-2.5">
            {PRODUCT_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={item}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Pied de page : contact">
          <p className={heading}>Contact</p>
          <ul className="mt-4 space-y-2.5">
            {CONTACT_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={item}>
                  {l.label}
                </Link>
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
              <Link href="/forgot-password" className={item}>
                Mot de passe oublié
              </Link>
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
