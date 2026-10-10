import { formatNumber } from "@rydar/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Lignes par page d'une liste longue (docs/REFONTE-PANELS.md § 3.4 : 50 au plus, jamais 120 ou 200 d'un bloc). */
export const PAGE_SIZE = 50;

/** Nombre de pages (au moins 1) et page demandée ramenée dans les bornes (`?page=` absent, invalide ou trop grand). */
export function pageBounds(total: number | null | undefined, requested: unknown, size = PAGE_SIZE): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(Math.max(0, total ?? 0) / size));
  const n = Math.floor(Number(requested));
  return { page: Number.isFinite(n) && n >= 1 ? Math.min(n, pages) : 1, pages };
}

/**
 * Pagination d'une liste (liens GET, sans préchargement) : « Page 2 / 5 · 230 courses », Précédent / Suivant. Première
 * ou dernière page : bouton désactivé (jamais un lien atteignable au clavier vers une page vide). Rien sur une seule page.
 */
export function Pagination({
  page,
  pages,
  href,
  total,
  noun,
  label = "Pagination",
  className,
}: {
  page: number;
  pages: number;
  /** Adresse d'une page (les autres paramètres de la liste conservés par l'appelant) */
  href: (page: number) => string;
  /** Nombre total d'éléments (facultatif), affiché avec `noun` (« 230 courses ») */
  total?: number | null;
  /** Nom des éléments au pluriel (« courses »), avec `total` */
  noun?: string;
  label?: string;
  className?: string;
}) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className={cn("mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px] text-fg-muted", className)}>
      <span>
        Page <span className="num text-fg">{formatNumber(page)}</span> / <span className="num">{formatNumber(pages)}</span>
        {total !== null && total !== undefined && noun ? (
          <>
            {" "}
            · <span className="num">{formatNumber(total)}</span> {noun}
          </>
        ) : null}
      </span>
      <div className="flex gap-2">
        {page <= 1 ? (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft /> Précédent
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link href={href(page - 1)} prefetch={false} rel="prev">
              <ChevronLeft /> Précédent
            </Link>
          </Button>
        )}
        {page >= pages ? (
          <Button variant="outline" size="sm" disabled>
            Suivant <ChevronRight />
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link href={href(page + 1)} prefetch={false} rel="next">
              Suivant <ChevronRight />
            </Link>
          </Button>
        )}
      </div>
    </nav>
  );
}
