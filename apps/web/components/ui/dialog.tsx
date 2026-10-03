"use client";
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogClose = D.Close;

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
        <D.Close className="absolute right-4 top-4 grid size-8 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg">
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
        <div className="hairline-top flex items-start justify-between border-b border-line px-6 py-5">
          <div>
            <D.Title className="text-base font-semibold tracking-tight">{title}</D.Title>
            <D.Description className={cn("mt-0.5 text-[13px] text-fg-muted", !description && "sr-only")}>
              {description ?? "Panneau"}
            </D.Description>
          </div>
          <D.Close className="grid size-8 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg">
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
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <D.Title className="text-[15px] font-semibold tracking-tight">{title}</D.Title>
            <D.Description className={cn("text-[12.5px] text-fg-muted", !description && "sr-only")}>{description ?? "Fenêtre"}</D.Description>
          </div>
          <D.Close className="grid size-8 place-items-center rounded-lg text-fg-subtle hover:bg-white/5 hover:text-fg">
            <X className="size-4" />
            <span className="sr-only">Fermer</span>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </D.Content>
    </D.Portal>
  );
}
