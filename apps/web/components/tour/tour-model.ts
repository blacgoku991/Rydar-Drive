// Visite guidée de première connexion (docs/TUTORIEL.md § 5.4, § 6) : modèle PUR du moteur, ni « use client » ni
// « server-only » (testé : tour-model.test.ts). États et événements, démarrage, écritures, entrée du menu du compte,
// boutons de la fenêtre, repli centré en bas d'écran, textes du moteur. Rien ici ne lit le DOM ni la base.
import { type TourKey, type TourSaved, type TourStatus } from "@rydar/shared";
import { fr } from "../marketing/typo";

/** Personne et organisation de la visite (relecture des conditions de réussite, § 6.9). */
export type TourScope = { userId: string; orgId: string | null; driverId: string | null };

/**
 * Départ de la visite, posé par la mise en page (app/dashboard/layout.tsx, app/admin/layout.tsx) :
 * - `saved` : progression lue en base (`undefined` : lecture impossible ; `null` : jamais vue) ;
 * - `blocked` : écran ou bandeau d'acceptation des CGU / CGV affiché → ni fenêtre, ni entrée de menu (§ 5.3) ;
 * - `urgent` : action urgente affichée → pas d'ouverture d'office, entrée de menu gardée (§ 5.3).
 */
export type TourBoot = { key: TourKey; saved: TourSaved | null | undefined; blocked: boolean; urgent: boolean; scope: TourScope };

export type TourView = "closed" | "intro" | "step";

/**
 * État de la visite dans la page. `step` compte à partir de 0 (base : 0 à 4 ; écran : « étape 1 sur 5 » = 0) ;
 * `status` null : aucune ligne en base ; `shown` : visite déjà ouverte une fois (shown_at) ; `minimized` : pastille
 * (état d'écran, jamais enregistré).
 */
export type TourState = { view: TourView; status: TourStatus | null; step: number; shown: boolean; minimized: boolean };

/** Événements du § 6.2. */
export type TourEvent = {
  type: "shown" | "start" | "later" | "next" | "prev" | "finish" | "close" | "minimize" | "expand" | "resume" | "autostart";
};

/**
 * Suite d'un clic dans la fenêtre ou du menu du compte (§ 6.4, § 6.6) : focus sur le titre, défilement unique jusqu'à
 * l'élément de l'étape quand il est trouvé. Jamais au simple changement de page.
 */
export type TourIntent = { focus?: boolean; scroll?: boolean };
/** Dernière demande (numérotée) transmise à la fenêtre ; `at` : heure de la demande (ms), au-delà de TOUR_INTENT_MS ignorée. */
export type TourRequest = { seq: number; focus: boolean; scroll: boolean; at: number };
/** Durée de validité d'une demande de focus ou de défilement (changement de page et chargement compris). */
export const TOUR_INTENT_MS = 6000;

/** Largeur à partir de laquelle la fenêtre peut s'ancrer à un contrôle (en dessous : repli centré, § 6.7). */
export const TOUR_WIDE_MIN = 640;
/** Écart entre la fenêtre en repli et une barre à éviter ([data-tour-avoid]). */
export const TOUR_DOCK_GAP = 12;

/** Textes du moteur (§ 6.10), typographie française par fr(). */
export const TOUR_UI = {
  name: "Visite guidée",
  counter: (n: number, total: number) => `Visite guidée · étape ${n} sur ${total}`,
  resume: "Reprendre la visite",
  replay: "Revoir la visite",
  start: "Commencer",
  later: "Plus tard",
  prev: "Précédent",
  skip: "Passer l'étape",
  next: "Suivant",
  finish: "Terminer",
  goto: "Y aller",
  done: "C'est fait.",
  minimize: "Réduire la visite guidée",
  close: "Fermer la visite guidée",
  expand: (n: number, total: number) => `Afficher la visite guidée, étape ${n} sur ${total}`,
  pill: (n: number, total: number) => `Visite guidée · ${n}/${total}`,
  paused: fr("Visite en pause : reprenez-la depuis votre nom, en bas du menu."),
  finished: fr("Visite terminée : vous pouvez la revoir depuis votre nom, en bas du menu."),
  saveError: fr("Progression de la visite non enregistrée : elle pourra revenir plus tard."),
} as const;

/** Étape ramenée dans les bornes du parcours (une étape retirée plus tard ne casse rien, § 3). */
export function clampStep(step: number, total: number): number {
  const last = Math.max(total - 1, 0);
  return Number.isInteger(step) ? Math.min(Math.max(step, 0), last) : 0;
}

/** État au chargement, avant toute ouverture d'office : celui de la base, fenêtre fermée (§ 6.2, initialisation). */
export function savedTourState(saved: TourSaved | null | undefined, total: number): TourState {
  return {
    view: "closed",
    status: saved?.status ?? null,
    step: clampStep(saved?.step ?? 0, total),
    shown: saved?.shown ?? false,
    minimized: false,
  };
}

/**
 * Fenêtre à ouvrir d'office (§ 5.2, § 5.4) : jamais si l'acceptation est en cours (`blocked`), si la lecture a échoué
 * (`readable` faux) ou si une action urgente est affichée ; sinon l'accueil pour une visite jamais vue (aucune ligne)
 * et l'étape enregistrée d'une visite « active ». Visite en pause ou terminée, ou fenêtre déjà ouverte : rien.
 */
export function autostartView(
  state: TourState,
  gates: { readable: boolean; blocked: boolean; urgent: boolean },
): "intro" | "step" | null {
  if (gates.blocked || !gates.readable || gates.urgent || state.view !== "closed") return null;
  if (state.status === null) return "intro";
  if (state.status === "active") return state.shown ? "step" : "intro";
  return null;
}

/**
 * Table du § 5.4 : état de la visite une fois le chargement fait (ouverture d'office comprise, écriture de l'accueil
 * comprise : tourPersist). Le fournisseur y arrive en deux temps (état de la base, puis `autostart` après ~400 ms).
 */
export function initialTourState(boot: Pick<TourBoot, "saved" | "blocked" | "urgent">, total: number): TourState {
  const base = savedTourState(boot.saved, total);
  const view = autostartView(base, { readable: boot.saved !== undefined, blocked: boot.blocked, urgent: boot.urgent });
  return view ? tourReducer(base, { type: "autostart" }, total) : base;
}

/** Événements du § 6.2 (pur). `total` : nombre d'étapes du parcours. */
export function tourReducer(state: TourState, event: TourEvent, total: number): TourState {
  const last = Math.max(total - 1, 0);
  switch (event.type) {
    // Accueil affiché (ouverture d'office ou « Reprendre » d'une visite jamais ouverte) : active, étape 0
    case "shown":
      return { view: "intro", status: "active", step: 0, shown: true, minimized: false };
    // Ouverture d'office (le fournisseur la demande seulement si autostartView le permet) : jamais pour une visite en
    // pause ou terminée
    case "autostart":
      if (state.view !== "closed" || state.status === "paused" || state.status === "completed") return state;
      if (state.status === null || !state.shown) return tourReducer(state, { type: "shown" }, total);
      return { ...state, view: "step", minimized: false };
    case "start":
      if (state.view !== "intro") return state;
      return { ...state, view: "step", status: "active", step: 0, minimized: false };
    // « Plus tard » (accueil), « × » ou Échap : en pause, étape gardée
    case "later":
    case "close":
      if (state.view === "closed") return state;
      return { ...state, view: "closed", status: "paused", minimized: false };
    case "next":
      if (state.view !== "step" || state.step >= last) return state;
      return { ...state, status: "active", step: state.step + 1, minimized: false };
    case "prev":
      if (state.view !== "step" || state.step <= 0) return state;
      return { ...state, status: "active", step: state.step - 1, minimized: false };
    case "finish":
      if (state.view !== "step") return state;
      return { ...state, view: "closed", status: "completed", minimized: false };
    case "minimize":
      if (state.view === "closed" || state.minimized) return state;
      return { ...state, minimized: true };
    case "expand":
      if (state.view === "closed" || !state.minimized) return state;
      return { ...state, minimized: false };
    // Menu du compte : accueil si jamais ouverte ; fenêtre déjà ouverte → dépliée ; terminée → étape 1 ; sinon l'étape
    case "resume":
      if (state.status === null || !state.shown) return tourReducer(state, { type: "shown" }, total);
      if (state.view !== "closed") return state.minimized ? { ...state, minimized: false } : state;
      if (state.status === "completed") return { ...state, view: "step", status: "active", step: 0, minimized: false };
      return { ...state, view: "step", status: "active", minimized: false };
  }
}

/** Écriture à faire après un changement d'état (save_user_tour), ou null si l'état enregistré n'a pas changé. */
export function tourPersist(prev: TourState, next: TourState): { status: TourStatus; step: number } | null {
  if (next.status === null) return null;
  if (prev.status === next.status && prev.step === next.step && prev.shown === next.shown) return null;
  return { status: next.status, step: next.step };
}

/** Entrée du menu du compte (§ 10) : absente pendant une acceptation ; « Revoir » une fois terminée. */
export function tourMenuItem(state: Pick<TourState, "status">, blocked: boolean): { kind: "resume" | "replay"; label: string } | null {
  if (blocked) return null;
  return state.status === "completed" ? { kind: "replay", label: TOUR_UI.replay } : { kind: "resume", label: TOUR_UI.resume };
}

const normalizePath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * Même écran (§ 6.5) : même chemin, et chaque paramètre de l'adresse de l'étape présent avec la même valeur (ordre
 * indifférent, paramètres en plus de la page ignorés).
 */
export function samePage(href: string, pathname: string, search: string): boolean {
  let target: URL;
  try {
    target = new URL(href, "http://visite.invalid");
  } catch {
    return false;
  }
  if (normalizePath(target.pathname) !== normalizePath(pathname)) return false;
  const current = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, value] of target.searchParams) if (current.get(key) !== value) return false;
  return true;
}

export type FooterAction = "later" | "start" | "prev" | "skip" | "next" | "finish" | "open" | "goto";

/**
 * Bouton de la fenêtre : `href` = vrai lien (Link sans préchargement) vers l'écran visé, sinon bouton. Un seul
 * `primary` par fenêtre, toujours le dernier (ordre du code : secondaires puis principal).
 */
export type FooterButton = {
  action: FooterAction;
  label: string;
  variant: "primary" | "secondary" | "ghost";
  href: string | null;
  /** Complément pour les lecteurs d'écran (« Y aller » : « : titre de l'étape ») */
  srLabel?: string;
};

/** Ce que les boutons ont besoin de savoir d'une étape. */
export type FooterStep = { href: string; linkLabel: string; title: string; hasCheck: boolean };

/**
 * Boutons de la fenêtre (§ 6.5). « Bon écran » = ancre visible, ou même adresse que l'étape (samePage).
 * « Commencer », « Suivant », « Passer l'étape » et « Précédent » sont des liens vers l'écran de l'étape visée quand il
 * diffère de l'écran actuel (un seul clic : on avance ET on y va), sinon des boutons ; « Ouvrir … » est toujours un lien.
 */
export function tourFooter(i: {
  view: "intro" | "step";
  step: number;
  steps: readonly FooterStep[];
  pathname: string;
  search: string;
  /** Ancre de l'étape trouvée et visible dans la page */
  anchorVisible: boolean;
  /** Condition de réussite : vrai (« C'est fait. »), faux, ou inconnue / sans condition (undefined) */
  done: boolean | undefined;
}): FooterButton[] {
  const linkTo = (index: number): string | null => {
    const target = i.steps[index];
    return target && !samePage(target.href, i.pathname, i.search) ? target.href : null;
  };
  if (i.view === "intro") {
    return [
      { action: "later", label: TOUR_UI.later, variant: "secondary", href: null },
      { action: "start", label: TOUR_UI.start, variant: "primary", href: linkTo(0) },
    ];
  }
  const step = clampStep(i.step, i.steps.length);
  const current = i.steps[step];
  if (!current) return [];
  const last = step >= i.steps.length - 1;
  const prev: FooterButton[] = step > 0 ? [{ action: "prev", label: TOUR_UI.prev, variant: "ghost", href: linkTo(step - 1) }] : [];
  // Avancer : « Suivant » (principal) ou « Passer l'étape » (secondaire) ; « Terminer » à la dernière étape
  const forward = (variant: "primary" | "secondary"): FooterButton =>
    last
      ? { action: "finish", label: TOUR_UI.finish, variant, href: null }
      : variant === "primary"
        ? { action: "next", label: TOUR_UI.next, variant, href: linkTo(step + 1) }
        : { action: "skip", label: TOUR_UI.skip, variant, href: linkTo(step + 1) };
  // Étape faite (« C'est fait. ») : on avance
  if (i.done === true) return [...prev, forward("primary")];
  const onScreen = i.anchorVisible || samePage(current.href, i.pathname, i.search);
  // Pas sur le bon écran : y aller
  if (!onScreen) return [...prev, forward("secondary"), { action: "open", label: current.linkLabel, variant: "primary", href: current.href }];
  // Bon écran, élément visible, action pas encore faite (ou inconnue) : désigner l'élément
  if (i.anchorVisible && current.hasCheck) {
    return [...prev, forward("secondary"), { action: "goto", label: TOUR_UI.goto, variant: "primary", href: null, srLabel: fr(` : ${current.title}`) }];
  }
  // Bon écran sans condition, ou élément introuvable
  return [...prev, forward("primary")];
}

/** Rectangle à l'écran (coordonnées de la fenêtre du navigateur). */
export type TourBox = { top: number; bottom: number; left: number; right: number };
/** Rectangle virtuel compatible avec getBoundingClientRect (Radix Popper / Floating UI). */
export type DockRect = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number };

/**
 * Repli centré (§ 6.3) : rectangle virtuel de largeur nulle, centré horizontalement sur main#contenu (à défaut la
 * fenêtre du navigateur), à 16 px (< 640 px) ou 24 px (≥ 640 px) du bas — ou `margin` —, remonté au-dessus de toute
 * barre à éviter ([data-tour-avoid]) visible dont le haut est dans la moitié basse de l'écran. La fenêtre se place
 * au-dessus (side « top ») : son bas est `y`.
 */
export function dockedRect(i: {
  viewport: { width: number; height: number };
  main: Pick<TourBox, "left" | "right"> | null;
  avoid: readonly TourBox[];
  margin?: number;
}): DockRect {
  const { width, height } = i.viewport;
  const margin = i.margin ?? (width < TOUR_WIDE_MIN ? 16 : 24);
  const left = Math.max(0, i.main?.left ?? 0);
  const right = Math.min(width, i.main?.right ?? width);
  const x = right > left ? (left + right) / 2 : width / 2;
  let y = height - margin;
  for (const box of i.avoid) {
    // Vide, hors de l'écran, ou en haut de l'écran : ignorée
    if (box.bottom <= box.top || box.top >= height || box.bottom <= 0 || box.top < height / 2) continue;
    y = Math.min(y, box.top - TOUR_DOCK_GAP);
  }
  return { x, y, width: 0, height: 0, top: y, bottom: y, left: x, right: x };
}
