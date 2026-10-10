import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { isValidElement } from "react";
import { cn } from "@/lib/utils";

/**
 * En-tête de page (docs/REFONTE-PANELS.md § 3.2) : un seul h1, sans sur-titre ; description d'une phrase. Fiches :
 * `back` (« ← Courses »), `badges` à côté du titre, `meta` (ligne d'informations sous le titre). Action principale à
 * droite (première dans l'ordre du code).
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  back,
  badges,
  meta,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * @deprecated Sur-titre plus affiché (il répétait la section du menu, parfois à tort) ; propriété retirée en R11.
   * Un lien de retour passé ici (élément, pas un texte) reste affiché à la place de `back` jusqu'à ce que son écran
   * passe à `back`.
   */
  eyebrow?: React.ReactNode;
  /** Lien de retour de la fiche (« ← Courses »), sans préchargement */
  back?: { href: string; label: string };
  /** Badges à côté du titre (statut, type) */
  badges?: React.ReactNode;
  /** Ligne d'informations sous le titre (e-mail · ville · identifiant…) ; un texte long passe à la ligne */
  meta?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  // Transition : seuls les liens de retour passés par `eyebrow` (éléments) restent visibles ; un texte ne l'est plus
  const legacyBack = !back && isValidElement(eyebrow) ? eyebrow : null;
  return (
    <header className={cn("relative border-b border-line", className)}>
      <div className="relative mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-x-4 gap-y-3 px-4 pb-5 pt-5 sm:px-6 sm:pt-7 lg:px-10">
        <div className="min-w-0 max-w-full">
          {back ? (
            <Link
              href={back.href}
              prefetch={false}
              // Nom distinct de l'entrée du menu du même nom (« Courses »), libellé visible compris
              aria-label={`Retour\u00a0: ${back.label}`}
              className="mb-2 inline-flex min-h-6 items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg"
            >
              <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
              {back.label}
            </Link>
          ) : legacyBack ? (
            <div className="mb-2 text-[13px] text-fg-muted">{legacyBack}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="min-w-0 text-[22px] font-semibold tracking-tight text-fg [overflow-wrap:anywhere] sm:text-[24px]">{title}</h1>
            {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
          </div>
          {meta && <div className="mt-1.5 text-[13px] text-fg-muted [overflow-wrap:anywhere]">{meta}</div>}
          {description && <p className="mt-1.5 max-w-2xl text-[14px] text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="relative mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-10">{children}</div>}
    </header>
  );
}

export function PageBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10", className)}>{children}</div>;
}

/**
 * Chiffre clé (§ 3.3) : chiffre en couleur neutre, couleur réservée à ce qui demande une action (`tone`). Un chiffre qui
 * mène à une liste est un lien (`href`, sans préchargement) ; `active` : la liste affichée est celle de ce chiffre
 * (filtre en cours, aria-current="page").
 */
export function StatCard({
  label,
  value,
  sub,
  tone,
  icon,
  href,
  active,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "brand" | "amber" | "red" | "cyan" | "blue";
  icon?: React.ReactNode;
  href?: string;
  active?: boolean;
  className?: string;
}) {
  const color = { brand: "text-brand", amber: "text-amber", red: "text-red", cyan: "text-cyan", blue: "text-blue" }[tone ?? "brand"];
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] text-fg-subtle">{label}</span>
        {icon && <span aria-hidden className="text-fg-subtle [&_svg]:size-4">{icon}</span>}
      </div>
      <div className={cn("mt-1.5 text-[24px] font-semibold leading-none tracking-tight", tone ? color : "text-fg")}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-fg-subtle">{sub}</div>}
    </>
  );
  const box = "surface relative overflow-hidden rounded-xl px-4 py-3.5";
  if (!href) return <div className={cn(box, className)}>{body}</div>;
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        box,
        "block transition-colors hover:bg-ink-700",
        // Liste affichée : liseré lime (ring : ne dépend pas de l'ordre des classes de `surface`)
        active && "ring-1 ring-inset ring-brand/50",
        className,
      )}
    >
      {body}
    </Link>
  );
}
