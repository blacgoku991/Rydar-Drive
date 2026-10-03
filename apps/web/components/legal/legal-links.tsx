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
 */
export function LegalLinks({
  className,
  withDeletion,
  only,
  prefetch,
}: {
  className?: string;
  withDeletion?: boolean;
  only?: (typeof LEGAL_LINKS)[number]["href"][];
  prefetch?: false;
}) {
  const links = [
    ...LEGAL_LINKS.filter((l) => !only || only.includes(l.href)),
    ...(withDeletion ? [{ href: "/suppression-compte", label: "Supprimer son compte" }] : []),
  ];
  return (
    <nav aria-label="Informations légales" className={cn("flex flex-wrap gap-x-4 gap-y-1.5 text-fg-muted", className)}>
      {links.map((l) => (
        <Link key={l.href} href={l.href} prefetch={prefetch} className="hover:text-fg">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
