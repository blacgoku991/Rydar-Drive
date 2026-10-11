// Visite guidée (docs/TUTORIEL.md § 6.3, § 6.4) : aides DOM du moteur, navigateur seulement (appelées dans des effets
// ou des gestionnaires, jamais au rendu serveur). La règle de placement est pure : dockedRect (tour-model.ts).
import {
  dockedRect,
  dockedTop,
  focusCovered,
  pickFocus,
  revealScroll,
  revealWithin,
  type AvoidBox,
  type CoverRule,
  type DockRect,
  type FocusCandidate,
  type TourBox,
} from "./tour-model";

/** Éléments focalisables d'une cible (« Y aller », § 6.4). */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Commandes d'une zone (« Y aller ») : boutons, champs, listes et éléments à rôle de commande. */
const CONTROL =
  'button, input, select, textarea, summary, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="textbox"], [role="menuitem"], [role="option"]';
const LINK = 'a[href], [role="link"]';

/** Élément affiché : une boîte au moins, aucun ancêtre `hidden` ni `inert`. */
export function isVisible(el: Element): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  return !el.closest("[hidden], [inert]");
}

/** Ancre d'une étape : premier `[data-tour="<id>"]` visible (une page peut en rendre une par largeur d'écran). */
export function findAnchor(id: string): HTMLElement | null {
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${escaped}"]`)) if (isVisible(el)) return el;
  return null;
}

/**
 * Élément à focaliser dans une zone (pickFocus, § 6.4) : parmi ses éléments focalisables visibles (atteignables au Tab
 * de préférence), [data-tour-focus], puis le filtre ou l'onglet affiché ([aria-current="page"]), puis la première
 * commande, et seulement ensuite le premier lien.
 */
function zoneFocus(zone: HTMLElement): HTMLElement | null {
  const visible = [...zone.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
  const reachable = visible.filter((el) => el.tabIndex >= 0);
  const candidates = (reachable.length ? reachable : visible).map((el) => {
    const mark = el.closest("[data-tour-focus]");
    const candidate: FocusCandidate & { el: HTMLElement } = {
      el,
      marked: !!mark && (mark === zone || zone.contains(mark)),
      current: el.getAttribute("aria-current") === "page",
      kind: el.matches(CONTROL) ? "control" : el.matches(LINK) ? "link" : "other",
    };
    return candidate;
  });
  return pickFocus(candidates)?.el ?? null;
}

/**
 * « Y aller » : focus sur la cible si elle est focalisable, sinon sur l'élément préféré de la zone (zoneFocus : jamais
 * un lien de navigation quand une commande existe), sinon sur la cible elle-même avec un tabIndex -1 temporaire
 * (retiré quand elle perd le focus). Sans défilement (le moteur fait défiler ensuite) ; renvoie l'élément focalisé.
 */
export function focusTarget(el: HTMLElement): HTMLElement {
  const inner = el.matches(FOCUSABLE) ? el : zoneFocus(el);
  if (inner) {
    inner.focus({ preventScroll: true });
    return inner;
  }
  if (!el.hasAttribute("tabindex")) {
    el.tabIndex = -1;
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
  }
  el.focus({ preventScroll: true });
  return el;
}

const box = (r: DOMRect): TourBox => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });

/**
 * Barres à ne jamais recouvrir ([data-tour-avoid] : barres « Enregistrer » collantes, compositeur des messages,
 * panneau d'En direct sous lg, légende de la carte du super admin). Barre collante en bas (position: sticky, `bottom`
 * en pixels) : aussi sa place collée au bas de l'écran (`stuck`), fixe quel que soit le défilement.
 */
export function avoidBoxes(): AvoidBox[] {
  const { height } = viewportSize();
  return [...document.querySelectorAll<HTMLElement>("[data-tour-avoid]")].filter(isVisible).map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const offset = style.position === "sticky" ? Number.parseFloat(style.bottom) : Number.NaN;
    return Number.isFinite(offset) ? { ...box(r), stuck: { top: height - offset - r.height, bottom: height - offset } } : box(r);
  });
}

/** Contenu principal des deux coquilles (main#contenu). */
export const mainElement = () => document.getElementById("contenu");

/** Taille de la fenêtre du navigateur, barre de défilement exclue en largeur. */
export const viewportSize = () => ({ width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight });

const mainSpan = () => {
  const main = mainElement()?.getBoundingClientRect();
  return main ? { left: main.left, right: main.right } : null;
};

/**
 * Repli centré lu à l'instant (dockedRect sur les mesures du DOM) ; `margin` : 16 px pour la pastille ; `height` :
 * hauteur de la fenêtre ou de la pastille (une barre entièrement au-dessus d'elle ne la fait pas remonter).
 */
export function dockRectNow(o: { margin?: number; height?: number } = {}): DockRect {
  return dockedRect({ viewport: viewportSize(), main: mainSpan(), avoid: avoidBoxes(), ...o });
}

/**
 * Haut de la fenêtre pour la réserve de défilement (dockReserve) : remontée au-dessus de toutes les barres collantes
 * affichées, chacune à sa place collée au bas de l'écran, où qu'elle soit dans la page — ne dépend pas du défilement.
 */
export function reserveTopNow(height: number): number {
  const stuck = avoidBoxes().flatMap((b) => (b.stuck ? [{ ...b.stuck, left: b.left, right: b.right }] : []));
  return dockedTop(dockedRect({ viewport: viewportSize(), main: mainSpan(), avoid: stuck, height }), height);
}

/**
 * Rectangle de la fenêtre à l'instant : en repli, sa place prévue (dockedRect sur les mesures du DOM, sans attendre
 * que Radix la replace après un défilement) ; ancrée, son rectangle affiché.
 */
export function cardBoxNow(card: HTMLElement, docked: boolean): TourBox {
  const r = card.getBoundingClientRect();
  if (!docked) return box(r);
  const height = card.offsetHeight;
  const y = dockRectNow({ height }).y;
  return { top: y - height, bottom: y, left: r.left, right: r.right };
}

/** Signature de ce qui place la fenêtre en repli (barres à éviter, vue pleine hauteur) : relayout seulement si elle change. */
export function dockSignature(): string {
  const bars = avoidBoxes().map((b) => `${Math.round(b.top)}:${Math.round(b.bottom)}`);
  return `${fullHeightView() ? "plein" : "page"}|${bars.join(",")}`;
}

/** Vue pleine hauteur affichée (En direct, Messages : [data-tour-fullheight]) : aucune réserve de défilement. */
export const fullHeightView = () => !!document.querySelector("[data-tour-fullheight]");

/** Variable de <html> en pixels (retirée si nulle) ; écrite seulement si elle change (relue à chaque image au défilement). */
function setRootPx(name: string, px: number | null): void {
  const style = document.documentElement.style;
  const value = px && px > 0 ? `${Math.ceil(px)}px` : "";
  if (style.getPropertyValue(name) === value) return;
  if (value) style.setProperty(name, value);
  else style.removeProperty(name);
}

/** Variable de la réserve de défilement de main#contenu (pb-[var(--tour-reserve,0px)] des deux coquilles). */
export const setTourReserve = (px: number | null): void => setRootPx("--tour-reserve", px);

/**
 * Place prise en bas de l'écran par la fenêtre en repli, dépliée (--tour-dock, vues pleine hauteur comprises) : les
 * notifications (sonner, app/layout.tsx : offset et mobileOffset du bas) s'affichent au-dessus d'elle.
 */
export const setTourDock = (px: number | null): void => setRootPx("--tour-dock", px);

/** Calques au-dessus de la fenêtre de visite (z-40) : fenêtres et tiroirs (z-50), menus et listes (z-60), notifications. */
const ABOVE_CARD = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sonner-toaster]';

/**
 * Calques ouverts qui passent avant la visite (§ 6.8) : fenêtres et tiroirs (Radix Dialog : role « dialog », sans
 * aria-modal — les fenêtres non modales d'En direct et de la cloche comprises), fenêtres d'alerte, menus ; jamais la
 * fenêtre de visite elle-même. Une fenêtre qui se ferme compte jusqu'à son retrait du DOM (elle rend alors le focus à
 * son déclencheur).
 */
const OPEN_LAYER = '[role="dialog"]:not([data-tour-card]), [role="alertdialog"], [role="menu"]';

/** Un calque est ouvert : la visite ne s'ouvre pas d'office et ne s'affiche pas par-dessus (§ 5.3, § 6.8). */
export const layerOpen = (): boolean => document.querySelector(OPEN_LAYER) !== null;

/** Attente après la fermeture du dernier calque : le focus qu'il rend à son déclencheur passe avant la visite. */
export const LAYER_SETTLE_MS = 150;

/**
 * `ready` appelé une fois quand aucun calque n'est ouvert : tout de suite s'il n'y en a aucun, sinon `settleMs` après
 * la fermeture du dernier (un calque rouvert entre-temps fait attendre de nouveau ; les autres changements de la page,
 * En direct compris, ne repoussent pas l'attente). Renvoie l'annulation.
 */
export function whenNoLayer(ready: () => void, settleMs: number = LAYER_SETTLE_MS): () => void {
  if (!layerOpen()) {
    ready();
    return () => undefined;
  }
  let timer = 0;
  const observer = new MutationObserver(() => {
    if (layerOpen()) {
      window.clearTimeout(timer);
      timer = 0;
    } else if (!timer) {
      timer = window.setTimeout(() => {
        timer = 0;
        if (layerOpen()) return;
        observer.disconnect();
        ready();
      }, settleMs);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
  };
}

/**
 * Élément focalisé couvert par la fenêtre selon la règle (focusCovered : « hidden », entièrement caché dessous, focus
 * au clavier ; « overlap », touché même en partie, « Y aller ») : `card` = cardBoxNow ; jamais dans un calque qui
 * passe au-dessus d'elle.
 */
export function coveredByCard(el: Element, card: TourBox, rule: CoverRule): boolean {
  return !el.closest(ABOVE_CARD) && focusCovered(box(el.getBoundingClientRect()), card, rule);
}

/**
 * Défilement d'un seul coup : « auto » suit `scroll-behavior`, jamais « smooth » dans l'application (globals.css :
 * valeur initiale, « auto » forcé sous « Réduire les animations ») ; « instant » lève une TypeError dans les
 * navigateurs qui ne connaissent pas cette valeur.
 */
export const JUMP: ScrollBehavior = "auto";

/** Haut utile de l'écran : marge de défilement du haut de <html> (barre du haut collante et son écart, globals.css). */
export const topInsetNow = () => Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;

/**
 * Fenêtre en repli : défilement d'un seul coup (JUMP) de la page qui amène l'élément focalisé au-dessus de la place
 * prévue de la fenêtre (cardBoxNow : Radix ne la replace qu'à l'image suivante), 3 essais au plus (elle peut se
 * replacer quand une barre collante passe la moitié de l'écran) ; règle « overlap » : seulement s'il y tient sous la
 * barre du haut (revealWithin). Vrai si l'élément n'est plus couvert ; faux si rien ne défile (vue pleine hauteur,
 * conteneur interne) ou s'il n'y tient pas.
 */
export function revealAboveCard(el: Element, card: HTMLElement, rule: CoverRule): boolean {
  for (let tries = 0; tries < 3; tries++) {
    const place = cardBoxNow(card, true);
    if (!coveredByCard(el, place, rule)) return true;
    const rect = el.getBoundingClientRect();
    const scroll = rule === "overlap" ? revealWithin(rect, place.top, topInsetNow()) : revealScroll(rect, place.top);
    if (scroll === null) return false;
    const before = window.scrollY;
    window.scrollBy({ top: scroll, behavior: JUMP });
    if (window.scrollY === before) return false;
  }
  return !coveredByCard(el, cardBoxNow(card, true), rule);
}

/** Images de suite sans défilement : défilement terminé ou arrêté (rien à faire défiler compris). */
const SCROLL_STILL_FRAMES = 12;
/** Attente la plus longue. */
const SCROLL_MAX_MS = 2000;
/**
 * La personne reprend la main (molette, toucher, clic) : plus rien à vérifier. Une touche n'annule rien : Tab déplace
 * le focus (la vérification ne vise que l'élément encore focalisé, le filet prend le nouveau), une saisie est vérifiée
 * à la fin du défilement.
 */
const TAKE_OVER = ["wheel", "touchstart", "pointerdown"] as const;

/**
 * Fin du défilement lancé par « Y aller », suivie image par image (jamais par les évènements de défilement : les sauts
 * du calcul de la position finale émettent eux aussi scroll et scrollend) : position finale `to` atteinte (à 1 px
 * près), sinon SCROLL_STILL_FRAMES images sans défilement, SCROLL_MAX_MS au plus ; `instant` : défilement déjà fait
 * (animations réduites). `done` est appelé deux images plus tard (fenêtre replacée), une fois, et jamais si la personne
 * reprend la main entre-temps. Renvoie l'annulation.
 */
export function afterScroll(done: () => void, o: { instant?: boolean; to?: { left: number; top: number } } = {}): () => void {
  let frame = 0;
  let still = 0;
  let last = { left: window.scrollX, top: window.scrollY };
  const deadline = Date.now() + SCROLL_MAX_MS;
  const detach = () => {
    for (const type of TAKE_OVER) window.removeEventListener(type, cancel, true);
  };
  function cancel() {
    detach();
    cancelAnimationFrame(frame);
  }
  const finish = () => {
    detach();
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(done);
    });
  };
  const poll = () => {
    const now = { left: window.scrollX, top: window.scrollY };
    const arrived = !!o.to && Math.abs(now.left - o.to.left) <= 1 && Math.abs(now.top - o.to.top) <= 1;
    still = now.left === last.left && now.top === last.top ? still + 1 : 0;
    last = now;
    if (arrived || still >= SCROLL_STILL_FRAMES || Date.now() >= deadline) finish();
    else frame = requestAnimationFrame(poll);
  };
  if (o.instant) {
    finish();
    return cancel;
  }
  for (const type of TAKE_OVER) window.addEventListener(type, cancel, { capture: true, passive: true });
  frame = requestAnimationFrame(poll);
  return cancel;
}

/**
 * Sortie de la fenêtre au clavier (Tab sur son dernier élément) : premier élément focalisable de la page, hors
 * fenêtre et hors gardes de focus de Radix (invisibles) — en général « Aller au contenu ».
 */
export function firstPageTabbable(exclude: Element | null): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.hasAttribute("data-radix-focus-guard") || (exclude && exclude.contains(el))) continue;
    if (el.tabIndex < 0 || !isVisible(el)) continue;
    return el;
  }
  return null;
}

/** Éléments atteignables au Tab dans un conteneur (premier et dernier : sortie de la fenêtre). */
export function tabbables(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && isVisible(el));
}
