"use client";
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogClose = D.Close;

/**
 * Pied de fenêtre (docs/REFONTE-PANELS.md § 3.6) : « Retour » (ferme sans rien faire) puis l'action ; côte à côte à
 * droite à partir de 640 px, empilés pleine largeur en dessous, action en haut, 44 px de haut au moins sous 640 px
 * (principe 7 : cible tactile). `sticky` : collé en bas des longues fenêtres sur téléphone (l'action reste à portée sans
 * tout faire défiler). « Annuler » n'est jamais un bouton de fermeture : c'est une action métier suivie de son objet
 * (« Annuler la course »).
 */
export function DialogFooter({
  children,
  backLabel = "Retour",
  hideBack = false,
  backDisabled = false,
  sticky = false,
  className,
}: {
  /** L'action (ou les actions), après « Retour » */
  children?: React.ReactNode;
  backLabel?: string;
  /** Sans bouton « Retour » (fenêtre d'information qui n'a qu'un bouton de fermeture) */
  hideBack?: boolean;
  /** Envoi en cours : « Retour » inactif (la croix et Échap ferment toujours) */
  backDisabled?: boolean;
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Enfants directs = les boutons (Retour, puis l'action) : 44 px au moins au toucher
        "mt-6 flex flex-col-reverse gap-2 max-sm:*:min-h-11 sm:flex-row sm:justify-end",
        sticky && "max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-6 max-sm:-mb-6 max-sm:border-t max-sm:border-line max-sm:bg-ink-850 max-sm:px-6 max-sm:pb-6 max-sm:pt-4",
        className,
      )}
    >
      {!hideBack && (
        <D.Close asChild>
          <Button type="button" variant="secondary" disabled={backDisabled}>
            {backLabel}
          </Button>
        </D.Close>
      )}
      {children}
    </div>
  );
}

type ContentProps = React.ComponentProps<typeof D.Content>;

/**
 * Dernier élément focalisé HORS d'une fenêtre : repli quand le focus est déjà entré dans la fenêtre au moment où elle
 * s'ouvre (champ autoFocus, focalisé par React avant Radix, qui n'appelle alors pas onOpenAutoFocus).
 */
let lastOutsideFocus: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && !t.closest("[role=dialog],[role=alertdialog]")) lastOutsideFocus = t;
    },
    true,
  );
}

/**
 * Focus et Échap des fenêtres (motif ARIA « dialog ») :
 *  - à la fermeture, le focus revient à l'élément qui l'avait à l'ouverture (bouton ordinaire, sans Dialog.Trigger :
 *    Radix ne sait le rendre qu'à son déclencheur et le laissait sinon sur <body>, WCAG 2.4.3) ;
 *  - Échap dans une liste de suggestions ouverte (combobox, AddressInput) ferme la liste seule, jamais la fenêtre et
 *    sa saisie (Radix écoute Échap en phase de capture, avant le champ).
 * Les gestionnaires passés par l'appelant passent d'abord ; event.preventDefault() de leur part garde le comportement
 * de Radix.
 */
function useDialogFocus({ onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown }: ContentProps) {
  const opener = React.useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (e: Event) => {
      // Appelé avant que Radix ne place le focus : l'élément actif est celui qui a ouvert la fenêtre, sauf si un champ
      // autoFocus de la fenêtre l'a déjà pris (repli : dernier élément focalisé hors d'une fenêtre)
      const active = document.activeElement;
      const content = e.currentTarget instanceof Node ? e.currentTarget : null;
      opener.current =
        active instanceof HTMLElement && active !== document.body && !content?.contains(active) ? active : lastOutsideFocus;
      onOpenAutoFocus?.(e);
    },
    onCloseAutoFocus: (e: Event) => {
      onCloseAutoFocus?.(e);
      if (e.defaultPrevented) return;
      // Fenêtre dont un champ autoFocus a pris le focus dès l'ouverture : Radix n'appelle pas onOpenAutoFocus
      const el = opener.current ?? lastOutsideFocus;
      opener.current = null;
      if (el?.isConnected) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      }
    },
    onEscapeKeyDown: (e: KeyboardEvent) => {
      onEscapeKeyDown?.(e);
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.getAttribute("role") === "combobox" && t.getAttribute("aria-expanded") === "true") e.preventDefault();
    },
  };
}

export function DialogContent({
  className,
  children,
  title,
  description,
  size = "md",
  ...props
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; size?: "sm" | "md" | "lg" }) {
  const focus = useDialogFocus(props);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <D.Content
        className={cn(
          "glass fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl p-6 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          size === "sm" && "max-w-md",
          size === "md" && "max-w-lg",
          size === "lg" && "max-w-3xl",
          className,
        )}
        {...props}
        {...focus}
      >
        <div className="mb-5 pr-8">
          <D.Title className="text-lg font-semibold tracking-tight">{title}</D.Title>
          {description ? (
            <D.Description className="mt-1 text-sm text-fg-muted">{description}</D.Description>
          ) : (
            <D.Description className="sr-only">{typeof title === "string" ? title : "Fenêtre"}</D.Description>
          )}
        </div>
        {children}
        {/* Croix : 44 px sous 640 px (cible tactile), au même endroit à l'œil (coin décalé de la moitié de l'écart) */}
        <D.Close className="absolute right-2 top-2 grid size-11 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg sm:right-4 sm:top-4 sm:size-8">
          <X className="size-4" />
          <span className="sr-only">Fermer</span>
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}

/** Panneau latéral (création rapide). */
export function SheetContent({
  className,
  children,
  title,
  description,
  side = "right",
  ...props
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; side?: "right" | "left" }) {
  const focus = useDialogFocus(props);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <D.Content
        className={cn(
          "fixed inset-y-2 z-50 flex w-[calc(100vw-1rem)] max-w-xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-ink-850 shadow-float data-[state=open]:animate-in data-[state=closed]:animate-out",
          side === "right"
            ? "right-2 data-[state=open]:slide-in-from-right-8 data-[state=closed]:slide-out-to-right-8"
            : "left-2 data-[state=open]:slide-in-from-left-8",
          className,
        )}
        {...props}
        {...focus}
      >
        {/* Titre en min-w-0 et croix en shrink-0 : un long titre passe à la ligne au lieu d'écraser la croix (44 px sous
            640 px, cible tactile) */}
        <div className="hairline-top flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <D.Title className="text-base font-semibold tracking-tight">{title}</D.Title>
            <D.Description className={cn("mt-0.5 text-[13px] text-fg-muted", !description && "sr-only")}>
              {description ?? "Panneau"}
            </D.Description>
          </div>
          <D.Close className="-mr-2 -mt-1.5 grid size-11 shrink-0 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg sm:mr-0 sm:mt-0 sm:size-8">
            <X className="size-4" />
            <span className="sr-only">Fermer</span>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

/** Grande fenêtre de travail (création de course avec carte). */
export function WorkspaceContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode }) {
  const focus = useDialogFocus(props);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <D.Content
        className={cn(
          "fixed inset-2 z-50 mx-auto flex max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] sm:inset-4 lg:inset-6",
          className,
        )}
        {...props}
        {...focus}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <D.Title className="text-[15px] font-semibold tracking-tight">{title}</D.Title>
            <D.Description className={cn("text-[12.5px] text-fg-muted", !description && "sr-only")}>{description ?? "Fenêtre"}</D.Description>
          </div>
          <D.Close className="-my-1.5 -mr-2 grid size-11 shrink-0 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg sm:my-0 sm:mr-0 sm:size-8">
            <X className="size-4" />
            <span className="sr-only">Fermer</span>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </D.Content>
    </D.Portal>
  );
}
