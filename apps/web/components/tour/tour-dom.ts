// Visite guidée (docs/TUTORIEL.md § 6.3, § 6.4) : aides DOM du moteur, navigateur seulement (appelées dans des effets
// ou des gestionnaires, jamais au rendu serveur). La règle de placement est pure : dockedRect (tour-model.ts).
import { dockedRect, dockedTop, hiddenUnder, pickFocus, type AvoidBox, type DockRect, type FocusCandidate, type TourBox } from "./tour-model";

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
 * (retiré quand elle perd le focus). Sans défilement : la cible a déjà été amenée à l'écran.
 */
export function focusTarget(el: HTMLElement): void {
  const inner = el.matches(FOCUSABLE) ? el : zoneFocus(el);
  if (inner) {
    inner.focus({ preventScroll: true });
    return;
  }
  if (!el.hasAttribute("tabindex")) {
    el.tabIndex = -1;
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
  }
  el.focus({ preventScroll: true });
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
 * Élément entièrement caché par la fenêtre (focus au clavier, WCAG 2.2, 2.4.11) : son rectangle dans celui de la
 * fenêtre (`card` : cardBoxNow), hors des calques qui passent au-dessus d'elle.
 */
export function hiddenByCard(el: Element, card: TourBox): boolean {
  return !el.closest(ABOVE_CARD) && hiddenUnder(box(el.getBoundingClientRect()), card);
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
