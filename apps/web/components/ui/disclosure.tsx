"use client";
import { ChevronRight } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Repli (docs/REFONTE-PANELS.md § 3.8) : balise native details / summary (clavier, lecteurs d'écran, recherche dans la
 * page). Titre qui dit ce qu'il y a dedans, cible de 44 px, focus visible ; fermé par défaut (`defaultOpen` sinon) ;
 * `forceOpen` (erreur ou blocage à l'intérieur) l'ouvre et le garde ouvert tant que la personne ne le referme pas ;
 * `id` : ancre — une adresse qui la vise (#id) l'ouvre. Aucun état mémorisé (pas de nouvelle clé de stockage).
 */
export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  forceOpen = false,
  id,
  className,
  summaryClassName,
  contentClassName,
  children,
}: {
  title: React.ReactNode;
  /** Précision à droite du titre (nombre d'éléments, résumé) */
  hint?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  id?: string;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen || forceOpen);
  // Erreur ou blocage apparu à l'intérieur : ouvert d'office (jamais refermé à sa disparition, la saisie reste visible)
  React.useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  // Ancre : arrivée par #id ou lien interne vers #id
  React.useEffect(() => {
    if (!id) return;
    const check = () => {
      if (window.location.hash === `#${id}`) setOpen(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [id]);
  return (
    <details
      id={id}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className={cn("group/disclosure", className)}
    >
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-[13.5px] font-medium text-fg [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        {/* Rotation selon l'état de CE repli (jamais group-open : un repli imbriqué dans un repli ouvert paraîtrait ouvert) */}
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">{title}</span>
        {hint && <span className="shrink-0 text-[12.5px] font-normal text-fg-muted">{hint}</span>}
      </summary>
      <div className={contentClassName}>{children}</div>
    </details>
  );
}
