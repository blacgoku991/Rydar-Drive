import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Section d'un long formulaire (création d'un client) : fieldset et légende (« 1 Client »), qui nomment le groupe pour
 * les lecteurs d'écran ; le numéro d'étape est décoratif. Aucune bordure : les champs gardent leurs propres libellés
 * (Field), la section ne fait que regrouper et ordonner.
 */
export function FormSection({
  step,
  title,
  description,
  className,
  children,
}: {
  /** Numéro de l'étape (1, 2, 3…) ; absent : légende seule */
  step?: number;
  title: React.ReactNode;
  /** Une phrase sous la légende */
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className={cn("min-w-0 space-y-4", className)}>
      <legend className="mb-3 w-full">
        <span className="flex items-center gap-2.5 text-[14px] font-semibold text-fg">
          {step !== undefined && (
            <span aria-hidden className="num grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-ink-700 text-[12px] font-semibold text-fg-muted">
              {step}
            </span>
          )}
          {title}
        </span>
      </legend>
      {description && <p className="text-[13px] leading-relaxed text-fg-muted">{description}</p>}
      {children}
    </fieldset>
  );
}
