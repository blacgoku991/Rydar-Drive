"use client";
import Link from "next/link";
import * as React from "react";
import { cn } from "@/lib/utils";

export type FilterTab = {
  /** Adresse de l'onglet : les clés d'URL existantes (?filter=, ?tab=, ?type=…) ne changent jamais */
  href: string;
  label: React.ReactNode;
  /** Onglet affiché (aria-current="page") */
  active?: boolean;
  /** Compteur facultatif (filtres) ; null : inconnu, rien d'affiché */
  count?: number | null;
  /** Compteur au-dessus de zéro en rouge (retard, échec, blocage) */
  alert?: boolean;
  /** Nom du compteur pour les lecteurs d'écran (« 3 courses ») ; défaut : le nombre seul */
  countLabel?: string;
};

/**
 * Onglets et filtres (docs/REFONTE-PANELS.md § 3.5) : des liens (sans préchargement, aria-current="page"), jamais des
 * boutons qui effacent la saisie. Deux apparences : `rubriques` (soulignées, dans l'en-tête : Réglages, Supervision) et
 * `filtres` (pastilles, compteur facultatif, rouge si alerte, grisé à zéro sauf l'onglet actif). La barre défile
 * horizontalement (ou passe à la ligne : `wrap`) ; l'onglet actif est ramené dans la partie visible, sans faire défiler
 * la page ; un fondu signale un bord qui déborde.
 */
export function FilterTabs({
  items,
  label,
  variant = "filtres",
  wrap = false,
  className,
}: {
  items: FilterTab[];
  /** Nom de la barre (nav) : « Filtres des courses », « Rubriques des réglages »… */
  label: string;
  variant?: "rubriques" | "filtres";
  /** Passer à la ligne au lieu de défiler (tous les onglets visibles, ex. Réglages sur téléphone) */
  wrap?: boolean;
  className?: string;
}) {
  const bar = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const activeIndex = items.findIndex((i) => i.active);

  React.useEffect(() => {
    const el = bar.current;
    if (!el || wrap) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
    };
    // Onglet actif ramené dans la partie visible de la barre (jamais de défilement vertical de la page)
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      const b = el.getBoundingClientRect();
      const a = active.getBoundingClientRect();
      if (a.right > b.right || a.left < b.left) el.scrollLeft += a.left - b.left - 16;
    }
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [activeIndex, items.length, wrap]);

  // Fondu des bords qui débordent (masque : ne dépend pas de la couleur du fond)
  const fade =
    edges.left && edges.right
      ? "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]"
      : edges.right
        ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
        : edges.left
          ? "[mask-image:linear-gradient(to_right,transparent,black_24px)]"
          : "";

  return (
    <nav aria-label={label} className={cn("min-w-0", className)}>
      <div
        ref={bar}
        className={cn(
          "flex",
          wrap ? "flex-wrap" : "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          variant === "rubriques" ? (wrap ? "gap-x-1" : "-mb-px gap-1") : "gap-1.5 py-0.5",
          !wrap && fade,
        )}
      >
        {items.map((item) => {
          const count = item.count ?? null;
          const zero = count === 0 && !item.active;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors",
                variant === "rubriques"
                  ? cn(
                      "min-h-11 border-b-2 px-3 text-[13.5px] sm:min-h-10",
                      item.active ? "border-brand font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
                    )
                  : cn(
                      // 44 px au toucher sous 640 px (principe 7)
                      "h-11 rounded-full border px-3.5 text-[13px] sm:h-9",
                      item.active
                        ? "border-line-strong bg-ink-600 font-medium text-fg"
                        : zero
                          ? "border-line text-fg-subtle hover:text-fg-muted"
                          : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                    ),
              )}
            >
              {item.label}
              {count !== null && (
                <span
                  className={cn(
                    "min-w-5 rounded-full px-1.5 text-center text-[12px] font-semibold leading-5 tabular-nums",
                    // Alerte : fond rouge plein, texte encre (5,97:1 ; le rouge sur fond rouge pâle tombait à 4,05:1 sur
                    // l'onglet actif)
                    item.alert && count > 0 ? "bg-red text-ink-950" : item.active ? "bg-white/[0.08] text-fg" : "bg-white/[0.05] text-fg-muted",
                    zero && "bg-transparent font-normal text-fg-subtle",
                  )}
                >
                  {item.countLabel ? (
                    <>
                      <span aria-hidden>{count}</span>
                      {/* Masqué SANS position absolue (comme NewTabHint) : dans une barre qui défile, un texte en
                          position absolue sortait de la barre et faisait défiler la page */}
                      <span className="-m-px inline-block size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">{item.countLabel}</span>
                    </>
                  ) : (
                    count
                  )}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
