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

export function LegalLinks({ className, withDeletion, only }: { className?: string; withDeletion?: boolean; only?: (typeof LEGAL_LINKS)[number]["href"][] }) {
  const links = [
    ...LEGAL_LINKS.filter((l) => !only || only.includes(l.href)),
    ...(withDeletion ? [{ href: "/suppression-compte", label: "Supprimer son compte" }] : []),
  ];
  return (
    <nav aria-label="Informations légales" className={cn("flex flex-wrap gap-x-4 gap-y-1.5 text-fg-muted", className)}>
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="hover:text-fg">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
