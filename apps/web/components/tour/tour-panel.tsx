// Visite guidée (docs/TUTORIEL.md § 6.5, § 6.6) : contenu de la fenêtre, SANS logique ni état (testé par
// renderToStaticMarkup : tour-panel.test.ts) — en-tête (compteur, « Réduire », « Fermer »), titre focalisable, texte,
// liste des étapes (accueil), « C'est fait. » annoncé, boutons. Les boutons qui changent d'écran sont de vrais liens
// sans préchargement (la garde de saisie non enregistrée s'applique) ; un seul bouton plein, en haut sous 640 px.
import { Check, Minus, X } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TOUR_UI, type FooterButton } from "./tour-model";

export type TourPanelProps = {
  view: "intro" | "step";
  /** Préfixe des identifiants (compteur, titre, texte : aria-labelledby / aria-describedby de la fenêtre) */
  idBase: string;
  /** « Visite guidée · étape 2 sur 5 » ; accueil : « Visite guidée » */
  counter: string;
  title: string;
  text: string;
  /** Accueil : titres des étapes, dans l'ordre */
  stepTitles?: readonly string[];
  /** Condition de réussite : vrai → « C'est fait. » */
  done: boolean | undefined;
  buttons: readonly FooterButton[];
  /** « Réduire » proposé (étapes ; l'accueil se ferme par « Plus tard ») */
  canMinimize: boolean;
  titleRef?: React.Ref<HTMLHeadingElement>;
  onAction: (button: FooterButton, event: React.MouseEvent<HTMLElement>) => void;
  onMinimize: () => void;
  onClose: () => void;
};

/** Identifiants des éléments nommant la fenêtre. */
export const tourPanelIds = (idBase: string) => ({ counter: `${idBase}-compteur`, title: `${idBase}-titre`, text: `${idBase}-texte` });

// Boutons-icônes : 44 px au toucher sous 640 px, 32 px au-delà
const ICON_BUTTON =
  "grid size-11 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-white/[0.06] hover:text-fg sm:size-8";

export function TourPanel({ view, idBase, counter, title, text, stepTitles, done, buttons, canMinimize, titleRef, onAction, onMinimize, onClose }: TourPanelProps) {
  const ids = tourPanelIds(idBase);
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <p id={ids.counter} className="pt-1.5 text-[12px] font-medium text-fg-muted sm:pt-1">
          {counter}
        </p>
        <div className="-mr-2 -mt-2 flex shrink-0 items-center sm:-mr-1 sm:-mt-1">
          {canMinimize && (
            <button type="button" className={ICON_BUTTON} onClick={onMinimize}>
              <Minus aria-hidden className="size-4" />
              <span className="sr-only">{TOUR_UI.minimize}</span>
            </button>
          )}
          <button type="button" className={ICON_BUTTON} onClick={onClose}>
            <X aria-hidden className="size-4" />
            <span className="sr-only">{TOUR_UI.close}</span>
          </button>
        </div>
      </div>
      {/* Focus placé par le moteur (ouverture, changement d'étape, « Reprendre ») : souligné lime plutôt qu'un cadre, le
          titre n'est pas un champ */}
      <h2
        id={ids.title}
        ref={titleRef}
        tabIndex={-1}
        className="mt-1 text-[16px] font-semibold leading-snug tracking-tight text-fg outline-none focus-visible:underline focus-visible:decoration-brand focus-visible:decoration-2 focus-visible:underline-offset-4"
      >
        {title}
      </h2>
      <p id={ids.text} className="mt-2 text-[14px] leading-relaxed text-fg-muted">
        {text}
      </p>
      {view === "intro" && !!stepTitles?.length && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13.5px] text-fg marker:text-fg-subtle">
          {stepTitles.map((stepTitle, i) => (
            <li key={i}>{stepTitle}</li>
          ))}
        </ol>
      )}
      {/* Toujours présent (vide sinon) : annoncé quand l'action aboutit */}
      <p aria-live="polite" className="mt-3 flex min-h-5 items-center gap-1.5 text-[13.5px] font-medium text-green empty:mt-0 empty:min-h-0">
        {done === true ? (
          <>
            <Check aria-hidden className="size-4 shrink-0" />
            {TOUR_UI.done}
          </>
        ) : null}
      </p>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {buttons.map((button) => {
          const className = cn(
            buttonVariants({ variant: button.variant, size: "md" }),
            // 44 px au toucher et pleine largeur sous 640 px ; « Précédent » (discret) à gauche au-delà
            "h-auto min-h-11 w-full whitespace-normal py-2 text-center sm:min-h-9 sm:w-auto",
            button.variant === "ghost" && "sm:mr-auto",
          );
          const content = (
            <>
              {button.label}
              {button.srLabel && <span className="sr-only">{button.srLabel}</span>}
            </>
          );
          return button.href ? (
            <Link
              key={button.action}
              href={button.href}
              prefetch={false}
              className={className}
              data-tour-action={button.action}
              onClick={(event) => onAction(button, event)}
            >
              {content}
            </Link>
          ) : (
            <button key={button.action} type="button" className={className} data-tour-action={button.action} onClick={(event) => onAction(button, event)}>
              {content}
            </button>
          );
        })}
      </div>
    </>
  );
}
