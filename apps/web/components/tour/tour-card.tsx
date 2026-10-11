"use client";
// Visite guidée (docs/TUTORIEL.md § 6.3 à § 6.8) : la fenêtre, chargée à la demande (next/dynamic, ssr: false, par
// tour-provider.tsx). Radix Popover NON modal, ouverture contrôlée, ancre virtuelle :
//  - ancrée à côté de l'élément de l'étape (ancre « control » visible, écran ≥ 640 px) ;
//  - sinon repli centré en bas de main#contenu, remonté au-dessus des barres [data-tour-avoid] (dockedRect) ;
//  - réduite : pastille de 44 px en bas à gauche de main#contenu.
// Elle ne se ferme jamais d'elle-même (clics, focus ailleurs : ignorés) ; Échap seulement focus dedans ; Tab en sort,
// jamais vers une garde de focus invisible de Radix. Surlignage de l'élément (data-tour-highlight), défilement
// seulement après un clic dans la fenêtre ou le menu, focus sur le titre après une action. En repli : place prise en
// bas (--tour-dock, notifications au-dessus) ; hors vues pleine hauteur, réserve de défilement (--tour-reserve) et marge
// de défilement du bas de <html> ; un focus au clavier entièrement caché dessous fait défiler la page, sinon réduit la
// fenêtre (WCAG 2.2, 2.4.11). Aucune animation.
import { Compass } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Popover as P } from "radix-ui";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { stepDone, type TourChecks } from "./tour-checks";
import type { TourDef } from "./tour-content";
import {
  cardBoxNow,
  dockRectNow,
  dockSignature,
  findAnchor,
  firstPageTabbable,
  focusTarget,
  fullHeightView,
  hiddenByCard,
  isVisible,
  mainElement,
  reserveTopNow,
  setTourDock,
  setTourReserve,
  tabbables,
  viewportSize,
} from "./tour-dom";
import {
  TOUR_INTENT_MS,
  TOUR_UI,
  TOUR_WIDE_MIN,
  dockReserve,
  dockScrollPadding,
  dockSpace,
  dockedTop,
  guardTarget,
  revealScroll,
  tourFooter,
  type FooterButton,
  type TourEvent,
  type TourIntent,
  type TourRequest,
  type TourState,
} from "./tour-model";
import { TourPanel, tourPanelIds } from "./tour-panel";

export type TourCardProps = {
  def: TourDef;
  state: TourState;
  checks: TourChecks;
  request: TourRequest;
  act: (event: TourEvent | null, intent?: TourIntent) => void;
  /** Adresse affichée (chemin et paramètres) : relecture des conditions par le fournisseur */
  onLocation: (location: string) => void;
};

/** Regroupement des changements du DOM (élément de l'étape remonté par React, barres à éviter qui apparaissent). */
const OBSERVE_MS = 150;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Écran ≥ 640 px (fenêtre ancrable), suivi par matchMedia. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(`(min-width: ${TOUR_WIDE_MIN}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${TOUR_WIDE_MIN}px)`);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return wide;
}

/** Élément visible à l'écran (IntersectionObserver) : la fenêtre ne s'ancre pas à un élément sorti de l'écran. */
function useInView(el: HTMLElement | null): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting), { threshold: 0 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return inView;
}

/** Hauteur de la pastille (h-11). */
const PILL_HEIGHT = 44;

/** Pastille : en bas à gauche de main#contenu (16 px), remontée au-dessus des barres à éviter. */
function usePillPosition(active: boolean): { left: number; bottom: number } {
  const [pos, setPos] = useState({ left: 16, bottom: 16 });
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const main = mainElement()?.getBoundingClientRect();
        const left = Math.max(0, main?.left ?? 0) + 16;
        const bottom = Math.max(16, Math.round(viewportSize().height - dockRectNow({ margin: 16, height: PILL_HEIGHT }).y));
        setPos((p) => (p.left === left && p.bottom === bottom ? p : { left, bottom }));
      });
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return pos;
}

export function TourCard({ def, state, checks, request, act, onLocation }: TourCardProps) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  useEffect(() => onLocation(`${pathname}?${search}`), [pathname, search, onLocation]);

  const idBase = `visite-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ids = tourPanelIds(idBase);
  const total = def.steps.length;
  const expanded = state.view !== "closed" && !state.minimized;
  const stepDef = state.view === "step" ? def.steps[state.step] : undefined;
  const anchorId = stepDef?.anchor.id ?? null;
  const wide = useWide();

  // ------------------------------------------------------------------------- élément de l'étape et changements du DOM
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState(() => dockSignature());
  const refresh = useCallback(() => {
    setAnchor(expanded && anchorId ? findAnchor(anchorId) : null);
    const signature = dockSignature();
    setLayout((s) => (s === signature ? s : signature));
  }, [expanded, anchorId]);
  // Changement d'étape ou d'adresse : recherche immédiate ; puis à chaque changement du DOM (regroupé), fenêtre dépliée.
  // Avant l'affichage (layout effect) : après un changement de page, jamais un rendu avec l'élément de la page quittée
  // (« Y aller » montré un instant au lieu de « Ouvrir … », recette T3)
  useLayoutEffect(() => {
    refresh();
    if (!expanded) return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, OBSERVE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", refresh);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", refresh);
    };
  }, [refresh, expanded, pathname, search]);
  const inView = useInView(anchor);

  // Surlignage de l'élément de l'étape, tant que la fenêtre est dépliée sur elle
  useEffect(() => {
    if (!anchor || !expanded) return;
    anchor.setAttribute("data-tour-highlight", "");
    return () => anchor.removeAttribute("data-tour-highlight");
  }, [anchor, expanded]);

  // ------------------------------------------------------------------------------------------------ mode et position
  const anchored = !!anchor && inView && wide && stepDef?.anchor.kind === "control";
  const fullHeight = layout.startsWith("plein");
  /** Fenêtre (Popover.Content) : hauteur lue par le repli, focus, sortie au clavier */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const virtualRef = useMemo(() => {
    const target = anchored ? anchor : null;
    const main = mainElement();
    return {
      current: target
        ? { getBoundingClientRect: () => target.getBoundingClientRect(), contextElement: target }
        : {
            // Relu à chaque calcul de position (défilement, taille) : barres à éviter et hauteur de la fenêtre du moment
            getBoundingClientRect: () => {
              const r = dockRectNow({ height: contentRef.current?.offsetHeight });
              return new DOMRect(r.x, r.y, 0, 0);
            },
            contextElement: main ?? undefined,
          },
    };
    // `layout` : barres à éviter apparues ou disparues → nouvel objet, position recalculée
  }, [anchored, anchor, layout]);

  // Repli centré déplié : place prise en bas de l'écran (--tour-dock, vues pleine hauteur comprises : les
  // notifications passent au-dessus) ; hors vues pleine hauteur, réserve de défilement de main#contenu (--tour-reserve,
  // jusqu'à la fenêtre remontée au-dessus des barres collantes : la fin de la page passe au-dessus d'elle) et marge de
  // défilement du bas de <html> jusqu'au haut RÉEL de la fenêtre (barre évitée comprise), pour qu'un élément qui reçoit
  // le focus au clavier passe au-dessus d'elle (WCAG 2.2, 2.4.11). Relu à chaque changement de taille, de barres et au
  // défilement (une barre collante passe la moitié de l'écran) ; tout est retiré, la marge d'origine rendue, à la
  // réduction, à la fermeture et au démontage
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!contentEl || !expanded || anchored) return;
    const root = document.documentElement;
    const previousPadding = root.style.scrollPaddingBottom;
    const basePadding = parseFloat(getComputedStyle(root).scrollPaddingBottom) || 0;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      const { height } = viewportSize();
      const cardHeight = contentEl.offsetHeight;
      const dock = dockRectNow({ height: cardHeight });
      const top = dockedTop(dock, cardHeight);
      setTourDock(dockSpace(height, top, dock.y));
      if (fullHeight) return;
      setTourReserve(dockReserve(height, reserveTopNow(cardHeight)));
      const padding = `${dockScrollPadding(height, top, basePadding)}px`;
      if (root.style.scrollPaddingBottom !== padding) root.style.scrollPaddingBottom = padding;
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(contentEl);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", onScroll, { capture: true });
      setTourReserve(null);
      setTourDock(null);
      root.style.scrollPaddingBottom = previousPadding;
    };
    // `layout` : barres à éviter apparues ou disparues → haut de la fenêtre relu
  }, [contentEl, expanded, anchored, fullHeight, layout]);

  // ------------------------------------------------------------------------------------- focus et défilement (§ 6.4)
  const titleEl = useRef<HTMLHeadingElement | null>(null);
  const pillEl = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef(false);
  const pendingPill = useRef(false);
  const pendingScroll = useRef(0);
  const applyFocus = useCallback(() => {
    const title = titleEl.current;
    if (!pendingFocus.current || !title) return;
    pendingFocus.current = false;
    title.focus({ preventScroll: true });
    // Un menu ou une fenêtre qui se ferme au même moment peut reprendre le focus puis le perdre (<body>) : il revient
    // au titre (jamais repris à un élément que la personne a choisi entre-temps)
    for (const ms of [60, 250, 600]) {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (title.isConnected && (!active || active === document.body)) title.focus({ preventScroll: true });
      }, ms);
    }
  }, []);
  const titleRef = useCallback(
    (el: HTMLHeadingElement | null) => {
      titleEl.current = el;
      applyFocus();
    },
    [applyFocus],
  );
  const pillRef = useCallback((el: HTMLButtonElement | null) => {
    pillEl.current = el;
    if (el && pendingPill.current) {
      pendingPill.current = false;
      el.focus({ preventScroll: true });
    }
  }, []);
  // Nouvelle demande (clic dans la fenêtre, menu du compte, ouverture d'office de l'accueil)
  useEffect(() => {
    if (!request.seq || Date.now() - request.at > TOUR_INTENT_MS) return;
    if (request.focus) pendingFocus.current = true;
    if (request.scroll) pendingScroll.current = request.at;
    applyFocus();
  }, [request, applyFocus]);
  // Défilement unique jusqu'à l'élément, dès qu'il est trouvé (après le changement de page s'il y en a un)
  const scrollTo = useCallback(
    (el: HTMLElement) => {
      el.scrollIntoView({ block: stepDef?.anchor.kind === "zone" ? "start" : "center", behavior: reducedMotion() ? "auto" : "smooth" });
    },
    [stepDef?.anchor.kind],
  );
  useEffect(() => {
    // Élément de l'étape demandée seulement (au changement d'étape, l'ancien élément est encore retenu un instant)
    if (!anchor || !expanded || !pendingScroll.current || anchor.getAttribute("data-tour") !== anchorId) return;
    if (Date.now() - pendingScroll.current <= TOUR_INTENT_MS) scrollTo(anchor);
    pendingScroll.current = 0;
  }, [anchor, anchorId, expanded, scrollTo, request]);

  // Dernier élément focalisé hors de la fenêtre : rendu le focus à la fermeture (sinon main#contenu)
  const lastOutside = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || t === document.body || t.hasAttribute("data-radix-focus-guard")) return;
      if (contentRef.current?.contains(t) || pillEl.current?.contains(t)) return;
      lastOutside.current = t;
    };
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) lastOutside.current = active;
    document.addEventListener("focusin", remember, true);
    return () => document.removeEventListener("focusin", remember, true);
  }, []);
  const restoreOnUnmount = useRef(false);
  useEffect(
    () => () => {
      if (!restoreOnUnmount.current) return;
      const target = lastOutside.current;
      if (target && isVisible(target)) target.focus({ preventScroll: true });
      else mainElement()?.focus({ preventScroll: true });
    },
    [],
  );
  /** Fermeture depuis la fenêtre : focus rendu à la page s'il était dedans. */
  const closeWith = useCallback(
    (type: "later" | "close" | "finish") => {
      if (contentRef.current?.contains(document.activeElement) || document.activeElement === document.body) restoreOnUnmount.current = true;
      act({ type });
    },
    [act],
  );

  // Focus au clavier (ou rendu par un composant de la page) sur un élément entièrement caché sous la fenêtre (WCAG 2.2,
  // 2.4.11), vérifié une image plus tard (le navigateur a déjà fait défiler, marge du bas comprise) : en repli, la
  // page défile pour l'amener au-dessus (place prévue de la fenêtre : elle peut se replacer quand une barre collante
  // passe la moitié de l'écran, d'où quelques essais) ; si rien ne défile (vue pleine hauteur, conteneur interne) ou si
  // la fenêtre est ancrée (elle suit son élément), elle passe en pastille, focus inchangé. Hors focus de « Y aller ».
  const selfFocus = useRef(false);
  useEffect(() => {
    if (!expanded) return;
    let frame = 0;
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target;
      if (selfFocus.current || !(el instanceof HTMLElement) || el === document.body || el.hasAttribute("data-radix-focus-guard")) return;
      if (contentRef.current?.contains(el) || pillEl.current?.contains(el)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const card = contentRef.current;
        const docked = !anchored;
        if (!card?.isConnected || document.activeElement !== el || !hiddenByCard(el, cardBoxNow(card, docked))) return;
        if (docked) {
          for (let tries = 0; tries < 3; tries++) {
            const before = window.scrollY;
            window.scrollBy({ top: revealScroll(el.getBoundingClientRect(), cardBoxNow(card, true).top), behavior: "instant" });
            if (window.scrollY === before) break;
            if (!hiddenByCard(el, cardBoxNow(card, true))) return;
          }
        }
        act({ type: "minimize" });
      });
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [expanded, anchored, act]);

  // Gardes de focus de Radix (span[data-radix-focus-guard], tabindex 0, invisibles : début et fin de <body>, posées
  // par le Popover même non modal, tant que la fenêtre est dépliée) : jamais d'arrêt invisible. Garde du début atteinte
  // en entrant dans la page (premier Tab) → premier élément de la page ; depuis la page (Maj+Tab), ou garde de fin →
  // dernier élément de la fenêtre (guardTarget)
  useEffect(() => {
    if (!expanded) return;
    const onGuard = (event: FocusEvent) => {
      const guard = event.target;
      const card = contentRef.current;
      if (!(guard instanceof HTMLElement) || !guard.hasAttribute("data-radix-focus-guard") || !card?.isConnected) return;
      const start = (guard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const from = event.relatedTarget;
      const fromPage = from instanceof Element && from.isConnected;
      const next = guardTarget({ start, fromPage }) === "page" ? firstPageTabbable(card) : (tabbables(card).at(-1) ?? null);
      next?.focus();
    };
    document.addEventListener("focusin", onGuard, true);
    return () => document.removeEventListener("focusin", onGuard, true);
  }, [expanded]);

  // --------------------------------------------------------------------------------------------- boutons (§ 6.5)
  const done = stepDef ? stepDone(stepDef.check, checks) : undefined;
  const steps = useMemo(() => def.steps.map((s) => ({ href: s.href, linkLabel: s.linkLabel, title: s.title, hasCheck: !!s.check })), [def]);
  const buttons =
    state.view === "closed" ? [] : tourFooter({ view: state.view, step: state.step, steps, pathname, search, anchorVisible: !!anchor, done });

  const onAction = (button: FooterButton, event: React.MouseEvent<HTMLElement>) => {
    // Lien ouvert dans un autre onglet (Ctrl, Cmd, Maj, clic du milieu) : rien ne change ici
    if (button.href && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
    const intent = { focus: true, scroll: true };
    switch (button.action) {
      case "later":
      case "finish":
        closeWith(button.action);
        return;
      case "start":
        act({ type: "start" }, intent);
        return;
      case "next":
      case "skip":
        act({ type: "next" }, intent);
        return;
      case "prev":
        act({ type: "prev" }, intent);
        return;
      // « Ouvrir … » : vrai lien ; la fenêtre suit la page, focus sur le titre, puis défilement jusqu'à l'élément
      case "open":
        act(null, intent);
        return;
      // « Y aller » : défilement puis focus dans l'élément (déjà amené à l'écran : pas de contrôle « caché dessous »)
      case "goto": {
        const target = anchor ?? (anchorId ? findAnchor(anchorId) : null);
        if (!target) return;
        scrollTo(target);
        selfFocus.current = true;
        try {
          focusTarget(target);
        } finally {
          selfFocus.current = false;
        }
        return;
      }
    }
  };

  // Tab sur le dernier élément : sortie vers la page (Radix bouclerait dans la fenêtre) ; Maj+Tab sur le premier : retour
  // à l'élément précédent de la page (ordre du document)
  const onKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = tabbables(event.currentTarget);
    const active = document.activeElement;
    if (!list.length || !(active instanceof HTMLElement)) return;
    if (!event.shiftKey && active === list[list.length - 1]) {
      const next = firstPageTabbable(event.currentTarget);
      event.stopPropagation();
      if (next) {
        event.preventDefault();
        next.focus();
      }
    } else if (event.shiftKey && active === list[0]) {
      event.stopPropagation();
    }
  };

  const setContentRefs = useCallback((el: HTMLDivElement | null) => {
    contentRef.current = el;
    setContentEl(el);
  }, []);

  const pill = usePillPosition(state.minimized);
  const n = state.step + 1;
  const isIntro = state.view === "intro";
  const side = anchored ? (stepDef?.anchor.side ?? "bottom") : "top";
  const align = anchored ? (stepDef?.anchor.align ?? "start") : "center";

  return (
    <>
      <P.Root
        open={expanded}
        onOpenChange={(open) => {
          // Seule fermeture laissée à Radix : Échap, focus dans la fenêtre (le reste est empêché ci-dessous)
          if (!open) closeWith(isIntro ? "later" : "close");
        }}
      >
        <P.Anchor virtualRef={virtualRef} />
        <P.Portal>
          <P.Content
            ref={setContentRefs}
            data-tour-card=""
            aria-labelledby={`${ids.counter} ${ids.title}`}
            aria-describedby={ids.text}
            side={side}
            align={align}
            sideOffset={anchored ? 12 : 0}
            collisionPadding={16}
            avoidCollisions={anchored}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => e.preventDefault()}
            onFocusOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => {
              // Échap reste à la page (désélection, champ) quand le focus n'est pas dans la fenêtre
              if (!contentRef.current?.contains(document.activeElement)) e.preventDefault();
            }}
            onKeyDownCapture={onKeyDownCapture}
            // Hauteur : 32rem au plus, 70 % de l'écran, et la place disponible du côté choisi (Radix) : jamais coupée en haut
            className="z-40 max-h-[min(32rem,70dvh,var(--radix-popover-content-available-height,70dvh))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl border border-line-strong bg-ink-700 p-4 shadow-float outline-none"
          >
            <TourPanel
              view={isIntro ? "intro" : "step"}
              idBase={idBase}
              counter={isIntro ? TOUR_UI.name : TOUR_UI.counter(n, total)}
              title={isIntro ? def.intro.title : (stepDef?.title ?? "")}
              text={isIntro ? def.intro.text : (stepDef?.text ?? "")}
              stepTitles={isIntro ? def.steps.map((s) => s.title) : undefined}
              done={isIntro ? undefined : done}
              buttons={buttons}
              canMinimize={!isIntro}
              titleRef={titleRef}
              onAction={onAction}
              onMinimize={() => {
                pendingPill.current = true;
                act({ type: "minimize" });
              }}
              onClose={() => closeWith(isIntro ? "later" : "close")}
            />
          </P.Content>
        </P.Portal>
      </P.Root>
      {state.minimized && state.view !== "closed" && (
        <button
          ref={pillRef}
          type="button"
          data-tour-pill=""
          aria-expanded="false"
          aria-label={TOUR_UI.expand(n, total)}
          className="fixed z-40 inline-flex h-11 items-center gap-2 rounded-full border border-line-strong bg-ink-700 px-4 text-[13px] font-medium text-fg shadow-float hover:bg-ink-600"
          style={{ left: pill.left, bottom: pill.bottom }}
          onClick={() => act({ type: "expand" }, { focus: true })}
        >
          <Compass aria-hidden className="size-4 text-brand" />
          {TOUR_UI.pill(n, total)}
        </button>
      )}
    </>
  );
}
