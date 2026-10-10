import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Documents légaux publics (pieds de page du site, du mini-site, des pages de connexion et d'inscription).
 * Liens relatifs : sur un mini-site (sous-domaine), proxy.ts sert ces pages sans les réécrire.
 */
export const LEGAL_LINKS = [
  { href: "/mentions-legales", label: "Mentions légales" },
  { href: "/cgu", label: "CGU" },
  { href: "/cgv", label: "CGV" },
  { href: "/confidentialite", label: "Confidentialité" },
  { href: "/cookies", label: "Cookies" },
  { href: "/dpa", label: "Traitement des données (RGPD)" },
  { href: "/abonnement-resiliation", label: "Résiliation et remboursement" },
  // État de conformité dans l'intitulé du lien (usage du RGAA) : « non conforme » tant qu'aucun audit n'a été réalisé
  { href: "/accessibilite", label: "Accessibilité : non conforme" },
] as const;

/**
 * `prefetch={false}` dans le tableau de bord (règle du dépôt : aucun préchargement des liens qui y sont affichés en
 * permanence).
 *
 * Variante `compact` (barre latérale et menu mobile des espaces connectés) : 12 px, liens séparés par « · » (le
 * séparateur reste collé au lien qui le précède : jamais en début de ligne), chaque lien en cible de 24 px de haut
 * (WCAG 2.5.8) ; les 8 liens restent visibles, à un clic.
 */
export function LegalLinks({
  className,
  withDeletion,
  only,
  prefetch,
  linkClassName,
  variant = "default",
}: {
  className?: string;
  withDeletion?: boolean;
  only?: (typeof LEGAL_LINKS)[number]["href"][];
  prefetch?: false;
  /** Classe de chaque lien (ex. cible de 24 px de haut quand la liste est serrée : WCAG 2.5.8) */
  linkClassName?: string;
  variant?: "default" | "compact";
}) {
  const links = [
    ...LEGAL_LINKS.filter((l) => !only || only.includes(l.href)),
    ...(withDeletion ? [{ href: "/suppression-compte", label: "Supprimer son compte" }] : []),
  ];
  if (variant === "compact") {
    return (
      <nav aria-label="Informations légales" className={cn("text-[12px] leading-6 text-fg-subtle", className)}>
        {links.map((l, i) => (
          <span key={l.href}>
            <Link href={l.href} prefetch={prefetch} className={cn("inline-flex min-h-6 items-center hover:text-fg", linkClassName)}>
              {l.label}
            </Link>
            {i < links.length - 1 && (
              <>
                <span aria-hidden>{"\u00a0·"}</span>{" "}
              </>
            )}
          </span>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label="Informations légales" className={cn("flex flex-wrap gap-x-4 gap-y-1.5 text-fg-muted", className)}>
      {links.map((l) => (
        <Link key={l.href} href={l.href} prefetch={prefetch} className={cn("hover:text-fg", linkClassName)}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
