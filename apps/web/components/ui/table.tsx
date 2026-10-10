import { ChevronRight } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { cn } from "@/lib/utils";

// Convention des listes (docs/REFONTE-PANELS.md § 3.4) : sous 768 px (md), une liste de cartes (MobileList + ListCard :
// titre, statut à droite, une à trois lignes, toute la carte est un seul lien) ; à partir de md, le tableau
// (DesktopTable). Les deux rendus coexistent, l'un masqué par CSS (display: none : jamais lu deux fois par un lecteur
// d'écran). Seul le lien de la ligne est rendu deux fois : aucun bouton d'action dupliqué entre la carte et le tableau
// (les actions restent dans un seul rendu, ou sur la fiche). Statut et prix ne se coupent jamais (whitespace-nowrap) ;
// trajet et client se tronquent avec le texte entier en title. Liste longue : 50 lignes au plus par page (Pagination).

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}
export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("h-10 whitespace-nowrap px-4 text-left align-middle text-[12px] font-medium text-fg-subtle", className)}
      {...props}
    />
  );
}
export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-line/70 transition-colors last:border-0 hover:bg-white/[0.02]", className)} {...props} />;
}
export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("h-14 px-4 align-middle text-fg", className)} {...props} />;
}

/** Rendu téléphone d'une liste (sous md) : cartes empilées, séparées par un filet. */
export function MobileList({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn("divide-y divide-line/70 md:hidden", className)} {...props} />;
}

/** Rendu bureau d'une liste (à partir de md) : le tableau habituel, masqué sur téléphone. */
export function DesktopTable({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("max-md:hidden", className)} {...props} />;
}

/**
 * Carte d'une liste sur téléphone (dans MobileList) : titre, statut à droite (jamais coupé), une à trois lignes
 * d'informations ; avec `href`, toute la carte est un seul lien (sans préchargement), chevron à droite.
 */
export function ListCard({
  href,
  title,
  status,
  lines,
  className,
  "aria-label": ariaLabel,
}: {
  href?: string;
  title: React.ReactNode;
  status?: React.ReactNode;
  /** Une à trois lignes d'informations (les vides sont ignorées) */
  lines?: React.ReactNode[];
  className?: string;
  /** Nom du lien quand le titre seul ne suffit pas */
  "aria-label"?: string;
}) {
  const rows = (lines ?? []).filter((l) => l !== null && l !== undefined && l !== false && l !== "").slice(0, 3);
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 text-[14px] font-medium text-fg [overflow-wrap:anywhere]">{title}</div>
          {status && <div className="shrink-0 whitespace-nowrap">{status}</div>}
        </div>
        {rows.map((line, i) => (
          <div key={i} className="mt-1 min-w-0 truncate text-[13px] text-fg-muted">
            {line}
          </div>
        ))}
      </div>
      {href && <ChevronRight aria-hidden className="size-4 shrink-0 self-center text-fg-subtle" />}
    </>
  );
  const box = "flex items-start gap-3 px-4 py-3";
  return (
    <li className={className}>
      {href ? (
        <Link href={href} prefetch={false} aria-label={ariaLabel} className={cn(box, "transition-colors hover:bg-white/[0.03]")}>
          {body}
        </Link>
      ) : (
        <div className={box}>{body}</div>
      )}
    </li>
  );
}
