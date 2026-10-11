// Visite guidée (docs/TUTORIEL.md § 6.3, § 6.4) : aides DOM du moteur, navigateur seulement (appelées dans des effets
// ou des gestionnaires, jamais au rendu serveur). La règle de placement est pure : dockedRect (tour-model.ts).
import { dockedRect, type DockRect, type TourBox } from "./tour-model";

/** Éléments focalisables d'une cible (« Y aller », § 6.4). */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
 * « Y aller » : focus sur la cible si elle est focalisable, sinon sur son premier élément focalisable visible, sinon
 * sur la cible elle-même avec un tabIndex -1 temporaire (retiré quand elle perd le focus). Sans défilement : la cible
 * a déjà été amenée à l'écran.
 */
export function focusTarget(el: HTMLElement): void {
  const inner = el.matches(FOCUSABLE) ? el : [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find(isVisible);
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

/** Barres à ne jamais recouvrir ([data-tour-avoid] : barres « Enregistrer » collantes, compositeur des messages). */
export function avoidBoxes(): TourBox[] {
  return [...document.querySelectorAll("[data-tour-avoid]")].filter(isVisible).map((el) => box(el.getBoundingClientRect()));
}

/** Contenu principal des deux coquilles (main#contenu). */
export const mainElement = () => document.getElementById("contenu");

/** Taille de la fenêtre du navigateur, barre de défilement exclue en largeur. */
export const viewportSize = () => ({ width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight });

/** Repli centré lu à l'instant (dockedRect sur les mesures du DOM) ; `margin` : 16 px pour la pastille. */
export function dockRectNow(margin?: number): DockRect {
  const main = mainElement()?.getBoundingClientRect();
  return dockedRect({ viewport: viewportSize(), main: main ? { left: main.left, right: main.right } : null, avoid: avoidBoxes(), margin });
}

/** Signature de ce qui place la fenêtre en repli (barres à éviter, vue pleine hauteur) : relayout seulement si elle change. */
export function dockSignature(): string {
  const bars = avoidBoxes().map((b) => `${Math.round(b.top)}:${Math.round(b.bottom)}`);
  return `${fullHeightView() ? "plein" : "page"}|${bars.join(",")}`;
}

/** Vue pleine hauteur affichée (En direct, Messages : [data-tour-fullheight]) : aucune réserve de défilement. */
export const fullHeightView = () => !!document.querySelector("[data-tour-fullheight]");

/** Variable de la réserve de défilement de main#contenu (pb-[var(--tour-reserve,0px)] des deux coquilles). */
export function setTourReserve(px: number | null): void {
  const style = document.documentElement.style;
  if (px && px > 0) style.setProperty("--tour-reserve", `${Math.ceil(px)}px`);
  else style.removeProperty("--tour-reserve");
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
