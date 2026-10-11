import { TOUR_KEYS, TOUR_MAX_STEPS, type TourSaved } from "@rydar/shared";
import { describe, expect, it, vi } from "vitest";
import { stepDone } from "./tour-checks";
import { TOURS } from "./tour-content";
import {
  TOUR_DOCK_GAP,
  TOUR_TOAST_TOP,
  TOUR_TOAST_ZONE,
  TOUR_UI,
  autostartView,
  clampStep,
  dockReserve,
  dockScrollPadding,
  dockSpace,
  dockedRect,
  dockedTop,
  focusCovered,
  hiddenUnder,
  initialTourState,
  pickFocus,
  revealScroll,
  revealWithin,
  samePage,
  savedTourState,
  tourFooter,
  tourEscape,
  tourMenuItem,
  tourPersist,
  tourReducer,
  tourVisible,
  type FocusCandidate,
  type FooterStep,
  type TourEvent,
  type TourState,
} from "./tour-model";

// Visite guidée (docs/TUTORIEL.md) : modèle pur du moteur — table de démarrage (§ 5.4), fenêtre rendue pendant une
// acceptation (§ 5.3), événements et écritures (§ 6.2), menu du compte (§ 10), même écran et boutons de la fenêtre
// (§ 6.5), repli centré, sa marge du bas et le focus caché dessous (§ 6.3), Échap et élément visé par « Y aller »
// (§ 6.4, § 6.6), textes (§ 6.10).

// tour-checks.ts reprend la règle « Éditeur » de « À traiter » (components/admin/admin-todo.ts, qui importe
// « @/lib/wording ») : module résolu à la main (lot T3)
vi.mock("@/lib/wording", async () => await import("../../lib/wording"));

const NBSP = " ";
const TOTAL = 5;
const saved = (status: TourSaved["status"], step = 0, shown = true): TourSaved => ({ status, step, shown });
const ev = (type: TourEvent["type"]): TourEvent => ({ type });
const reduce = (state: TourState, ...types: TourEvent["type"][]) => types.reduce((s, t) => tourReducer(s, ev(t), TOTAL), state);
const open = (step: number, status: TourState["status"] = "active"): TourState => ({ view: "step", status, step, shown: true, minimized: false });

describe("démarrage (table du § 5.4)", () => {
  const boot = (s: TourSaved | null | undefined, blocked = false, urgent = false) => ({ saved: s, blocked, urgent });
  const menu = (b: ReturnType<typeof boot>) => tourMenuItem(initialTourState(b, TOTAL), b.blocked)?.label ?? null;

  it("acceptation en cours (bloquée) : fenêtre fermée et aucune entrée de menu, quelle que soit la progression", () => {
    for (const s of [undefined, null, saved("active", 2), saved("paused"), saved("completed", 4)]) {
      for (const urgent of [false, true]) {
        const b = boot(s, true, urgent);
        expect(initialTourState(b, TOTAL).view).toBe("closed");
        expect(menu(b)).toBeNull();
      }
    }
  });

  it("lecture impossible (undefined) : fermée, « Reprendre la visite »", () => {
    for (const urgent of [false, true]) {
      const b = boot(undefined, false, urgent);
      expect(initialTourState(b, TOTAL)).toEqual({ view: "closed", status: null, step: 0, shown: false, minimized: false });
      expect(menu(b)).toBe("Reprendre la visite");
    }
  });

  it("jamais vue (null), rien d'urgent : accueil, et l'écriture active / étape 0 (shown_at)", () => {
    const b = boot(null);
    const state = initialTourState(b, TOTAL);
    expect(state).toEqual({ view: "intro", status: "active", step: 0, shown: true, minimized: false });
    expect(tourPersist(savedTourState(null, TOTAL), state)).toEqual({ status: "active", step: 0 });
    expect(menu(b)).toBe("Reprendre la visite");
  });

  it("jamais vue (null) avec une action urgente : fermée (ouverture différée), « Reprendre la visite »", () => {
    const b = boot(null, false, true);
    expect(initialTourState(b, TOTAL).view).toBe("closed");
    expect(menu(b)).toBe("Reprendre la visite");
  });

  it("en cours (active), rien d'urgent : l'étape enregistrée, sans écriture", () => {
    const b = boot(saved("active", 3));
    const state = initialTourState(b, TOTAL);
    expect(state).toEqual(open(3));
    expect(tourPersist(savedTourState(b.saved, TOTAL), state)).toBeNull();
    expect(menu(b)).toBe("Reprendre la visite");
  });

  it("en cours (active) avec une action urgente : fermée, « Reprendre la visite »", () => {
    const b = boot(saved("active", 3), false, true);
    expect(initialTourState(b, TOTAL).view).toBe("closed");
    expect(menu(b)).toBe("Reprendre la visite");
  });

  it("en pause : fermée (urgent ou non), « Reprendre la visite »", () => {
    for (const urgent of [false, true]) {
      const b = boot(saved("paused", 1), false, urgent);
      expect(initialTourState(b, TOTAL).view).toBe("closed");
      expect(menu(b)).toBe("Reprendre la visite");
    }
  });

  it("terminée : fermée, « Revoir la visite »", () => {
    for (const urgent of [false, true]) {
      const b = boot(saved("completed", 4), false, urgent);
      expect(initialTourState(b, TOTAL).view).toBe("closed");
      expect(menu(b)).toBe("Revoir la visite");
    }
  });

  it("étape lue hors du parcours (étape retirée) : ramenée dans les bornes", () => {
    expect(savedTourState(saved("active", 4), 3).step).toBe(2);
    expect(initialTourState({ saved: saved("active", 4), blocked: false, urgent: false }, 3)).toEqual(open(2));
    expect(clampStep(-1, 5)).toBe(0);
    expect(clampStep(1.5, 5)).toBe(0);
    expect(clampStep(7, 0)).toBe(0);
  });

  it("autostartView : ouverture d'office seulement sans blocage, lecture réussie, rien d'urgent, fenêtre fermée", () => {
    const fresh = savedTourState(null, TOTAL);
    const ok = { readable: true, blocked: false, urgent: false };
    expect(autostartView(fresh, ok)).toBe("intro");
    expect(autostartView(fresh, { ...ok, readable: false })).toBeNull();
    expect(autostartView(fresh, { ...ok, blocked: true })).toBeNull();
    expect(autostartView(fresh, { ...ok, urgent: true })).toBeNull();
    expect(autostartView({ ...fresh, view: "intro" }, ok)).toBeNull();
    expect(autostartView(savedTourState(saved("active", 2), TOTAL), ok)).toBe("step");
    // Ligne « active » sans première ouverture (impossible par la RPC) : l'accueil
    expect(autostartView(savedTourState(saved("active", 2, false), TOTAL), ok)).toBe("intro");
    expect(autostartView(savedTourState(saved("paused", 2), TOTAL), ok)).toBeNull();
    // Compte rattrapé par la migration (en pause, jamais ouverte) : jamais d'office
    expect(autostartView(savedTourState(saved("paused", 0, false), TOTAL), ok)).toBeNull();
    expect(autostartView(savedTourState(saved("completed", 4), TOTAL), ok)).toBeNull();
  });
});

// Fournisseur (TourEngine) : sa garde de rendu est tourVisible — passage à une organisation du même parcours (même clé,
// état gardé) qui n'a jamais accepté les CGV : la mise en page passe `blocked`, seule cette règle cache la visite ouverte
describe("fenêtre rendue pendant une acceptation (tourVisible, § 5.3)", () => {
  it("bloquée (écran ou bandeau d'acceptation) : rien, même visite ouverte ou réduite ; et aucune entrée de menu", () => {
    for (const state of [open(2), { ...open(2), minimized: true }, reduce(savedTourState(null, TOTAL), "autostart")]) {
      expect(tourVisible({ blocked: true, view: state.view })).toBe(false);
      expect(tourMenuItem(state, true)).toBeNull();
    }
  });

  it("acceptation faite : la visite ouverte avant revient, à son étape ; fermée : rien", () => {
    expect(tourVisible({ blocked: false, view: "step" })).toBe(true);
    expect(tourVisible({ blocked: false, view: "intro" })).toBe(true);
    expect(tourVisible({ blocked: false, view: "closed" })).toBe(false);
    expect(tourVisible({ blocked: true, view: "closed" })).toBe(false);
  });
});

describe("événements (§ 6.2)", () => {
  const intro = initialTourState({ saved: null, blocked: false, urgent: false }, TOTAL);

  it("shown : accueil, active / étape 0, première ouverture", () => {
    const before = savedTourState(saved("paused", 3, false), TOTAL);
    const after = reduce(before, "shown");
    expect(after).toEqual({ view: "intro", status: "active", step: 0, shown: true, minimized: false });
    expect(tourPersist(before, after)).toEqual({ status: "active", step: 0 });
  });

  it("start (« Commencer ») : étape 1, rien à écrire (déjà active, 0)", () => {
    const after = reduce(intro, "start");
    expect(after).toEqual(open(0));
    expect(tourPersist(intro, after)).toBeNull();
    // Sans accueil affiché : aucun effet
    expect(reduce(open(2), "start")).toEqual(open(2));
  });

  it("later (« Plus tard » / Échap / × sur l'accueil) : fermée, en pause, étape 0", () => {
    const after = reduce(intro, "later");
    expect(after).toEqual({ view: "closed", status: "paused", step: 0, shown: true, minimized: false });
    expect(tourPersist(intro, after)).toEqual({ status: "paused", step: 0 });
    expect(reduce(after, "later")).toBe(after);
  });

  it("next (« Suivant » / « Passer l'étape ») : étape n + 1, active ; jamais au-delà de la dernière", () => {
    const after = reduce(open(1), "next");
    expect(after).toEqual(open(2));
    expect(tourPersist(open(1), after)).toEqual({ status: "active", step: 2 });
    expect(reduce(open(4), "next")).toEqual(open(4));
    expect(tourPersist(open(4), reduce(open(4), "next"))).toBeNull();
    // Accueil ou fenêtre fermée : aucun effet
    expect(reduce(intro, "next")).toBe(intro);
  });

  it("prev (« Précédent ») : étape n − 1 ; jamais avant la première", () => {
    expect(reduce(open(3), "prev")).toEqual(open(2));
    expect(tourPersist(open(3), reduce(open(3), "prev"))).toEqual({ status: "active", step: 2 });
    expect(reduce(open(0), "prev")).toEqual(open(0));
  });

  it("finish (« Terminer ») : fermée, terminée, étape gardée", () => {
    const after = reduce(open(4), "finish");
    expect(after).toEqual({ view: "closed", status: "completed", step: 4, shown: true, minimized: false });
    expect(tourPersist(open(4), after)).toEqual({ status: "completed", step: 4 });
    expect(reduce(intro, "finish")).toBe(intro);
  });

  it("close (× ou Échap, focus dans la fenêtre) : fermée, en pause, étape gardée", () => {
    const after = reduce(open(2), "close");
    expect(after).toEqual({ view: "closed", status: "paused", step: 2, shown: true, minimized: false });
    expect(tourPersist(open(2), after)).toEqual({ status: "paused", step: 2 });
    // Réduite puis fermée : idem
    expect(reduce(open(2), "minimize", "close")).toEqual(after);
  });

  it("minimize / expand : pastille puis même étape, rien d'enregistré", () => {
    const small = reduce(open(2), "minimize");
    expect(small).toEqual({ ...open(2), minimized: true });
    expect(tourPersist(open(2), small)).toBeNull();
    const back = reduce(small, "expand");
    expect(back).toEqual(open(2));
    expect(tourPersist(small, back)).toBeNull();
    // Fenêtre fermée : aucun effet
    const closed = savedTourState(saved("paused", 2), TOTAL);
    expect(reduce(closed, "minimize")).toBe(closed);
    expect(reduce(closed, "expand")).toBe(closed);
  });

  it("resume (menu du compte) : accueil si jamais ouverte (compte rattrapé, lecture impossible), avec l'écriture active / 0", () => {
    for (const before of [savedTourState(saved("paused", 0, false), TOTAL), savedTourState(undefined, TOTAL), savedTourState(null, TOTAL)]) {
      const after = reduce(before, "resume");
      expect(after.view).toBe("intro");
      expect(tourPersist(before, after)).toEqual({ status: "active", step: 0 });
    }
  });

  it("resume : visite en pause → l'étape enregistrée, active", () => {
    const before = savedTourState(saved("paused", 3), TOTAL);
    const after = reduce(before, "resume");
    expect(after).toEqual(open(3));
    expect(tourPersist(before, after)).toEqual({ status: "active", step: 3 });
  });

  it("resume : visite terminée → « Revoir » depuis l'étape 1, active", () => {
    const before = savedTourState(saved("completed", 4), TOTAL);
    const after = reduce(before, "resume");
    expect(after).toEqual(open(0));
    expect(tourPersist(before, after)).toEqual({ status: "active", step: 0 });
  });

  it("resume : fenêtre déjà ouverte → dépliée, même étape, rien à écrire", () => {
    const small = reduce(open(2), "minimize");
    expect(reduce(small, "resume")).toEqual(open(2));
    expect(reduce(open(2), "resume")).toEqual(open(2));
    expect(reduce(intro, "resume")).toEqual(intro);
    // Différée (urgence) puis demandée : étape enregistrée, sans écriture
    const deferred = savedTourState(saved("active", 1), TOTAL);
    expect(reduce(deferred, "resume")).toEqual(open(1));
    expect(tourPersist(deferred, reduce(deferred, "resume"))).toBeNull();
  });

  it("autostart : accueil (jamais vue) ou étape enregistrée ; jamais une visite en pause ou terminée", () => {
    expect(reduce(savedTourState(null, TOTAL), "autostart")).toEqual(intro);
    expect(reduce(savedTourState(saved("active", 2), TOTAL), "autostart")).toEqual(open(2));
    const paused = savedTourState(saved("paused", 2), TOTAL);
    expect(reduce(paused, "autostart")).toBe(paused);
    const done = savedTourState(saved("completed", 4), TOTAL);
    expect(reduce(done, "autostart")).toBe(done);
    // Déjà ouverte : aucun effet
    expect(reduce(open(3), "autostart")).toEqual(open(3));
  });

  it("parcours complet : accueil → 5 étapes → terminée ; écritures dans l'ordre", () => {
    const writes: unknown[] = [];
    let state = savedTourState(null, TOTAL);
    for (const type of ["autostart", "start", "next", "next", "prev", "next", "next", "next", "finish"] as const) {
      const next = reduce(state, type);
      const w = tourPersist(state, next);
      if (w) writes.push(w);
      state = next;
    }
    expect(writes).toEqual([
      { status: "active", step: 0 },
      { status: "active", step: 1 },
      { status: "active", step: 2 },
      { status: "active", step: 1 },
      { status: "active", step: 2 },
      { status: "active", step: 3 },
      { status: "active", step: 4 },
      { status: "completed", step: 4 },
    ]);
    expect(tourMenuItem(state, false)).toEqual({ kind: "replay", label: "Revoir la visite" });
  });

  it("tourPersist : rien sans ligne ni changement", () => {
    const fresh = savedTourState(null, TOTAL);
    expect(tourPersist(fresh, fresh)).toBeNull();
    expect(tourPersist(fresh, { ...fresh, minimized: true })).toBeNull();
    expect(tourPersist(open(2), { ...open(2), view: "closed" })).toBeNull();
  });
});

describe("menu du compte (§ 10)", () => {
  it("absent pendant une acceptation ; « Revoir » une fois terminée ; sinon « Reprendre »", () => {
    expect(tourMenuItem({ status: "completed" }, true)).toBeNull();
    expect(tourMenuItem({ status: null }, true)).toBeNull();
    expect(tourMenuItem({ status: "completed" }, false)).toEqual({ kind: "replay", label: "Revoir la visite" });
    for (const status of [null, "active", "paused"] as const) {
      expect(tourMenuItem({ status }, false)).toEqual({ kind: "resume", label: "Reprendre la visite" });
    }
  });
});

describe("même écran (samePage)", () => {
  it("même chemin, paramètres de l'étape présents avec la même valeur", () => {
    expect(samePage("/dashboard/settings?tab=org", "/dashboard/settings", "?tab=org")).toBe(true);
    expect(samePage("/dashboard/settings?tab=org", "/dashboard/settings", "tab=org")).toBe(true);
    expect(samePage("/dashboard/settings?tab=org", "/dashboard/settings", "?tab=pricing")).toBe(false);
    expect(samePage("/dashboard/settings?tab=org", "/dashboard/settings", "")).toBe(false);
    expect(samePage("/dashboard/settings?tab=org", "/dashboard/drivers", "?tab=org")).toBe(false);
    expect(samePage("/dashboard", "/dashboard", "")).toBe(true);
    expect(samePage("/dashboard", "/dashboard/rides", "")).toBe(false);
  });

  it("ordre indifférent, paramètre en plus dans la page ignoré, barre finale ignorée", () => {
    expect(samePage("/dashboard/rides?filter=no_driver&view=list", "/dashboard/rides", "?view=list&filter=no_driver")).toBe(true);
    expect(samePage("/dashboard/rides?filter=no_driver", "/dashboard/rides", "?filter=no_driver&page=2")).toBe(true);
    expect(samePage("/dashboard/rides?filter=no_driver&view=list", "/dashboard/rides", "?filter=no_driver")).toBe(false);
    expect(samePage("/admin/legal", "/admin/legal/", "")).toBe(true);
    expect(samePage("/dashboard", "/dashboard", "?tab=x")).toBe(true);
  });
});

describe("boutons de la fenêtre (§ 6.5)", () => {
  const STEPS: FooterStep[] = [
    { href: "/dashboard/settings?tab=org", linkLabel: "Ouvrir Organisation", title: "Identité de votre entreprise", hasCheck: true },
    { href: "/dashboard/settings?tab=pricing", linkLabel: "Ouvrir Tarifs", title: "Vos tarifs", hasCheck: true },
    { href: "/dashboard/drivers", linkLabel: "Ouvrir Chauffeurs", title: "Vos chauffeurs", hasCheck: true },
    { href: "/dashboard", linkLabel: "Ouvrir En direct", title: "Votre première course", hasCheck: false },
    { href: "/dashboard/settings?tab=team", linkLabel: "Ouvrir Équipe", title: "Votre équipe", hasCheck: true },
  ];
  const footer = (o: Partial<Parameters<typeof tourFooter>[0]>) =>
    tourFooter({ view: "step", step: 0, steps: STEPS, pathname: "/dashboard", search: "", anchorVisible: false, done: undefined, ...o });
  const summary = (buttons: ReturnType<typeof tourFooter>) => buttons.map((b) => [b.action, b.label, b.variant, b.href]);
  const onePrimaryLast = (buttons: ReturnType<typeof tourFooter>) => {
    expect(buttons.filter((b) => b.variant === "primary")).toHaveLength(1);
    expect(buttons.at(-1)!.variant).toBe("primary");
  };

  it("accueil : « Plus tard » puis « Commencer », lien vers l'écran de l'étape 1 s'il diffère", () => {
    const away = tourFooter({ view: "intro", step: 0, steps: STEPS, pathname: "/dashboard", search: "", anchorVisible: false, done: undefined });
    expect(summary(away)).toEqual([
      ["later", "Plus tard", "secondary", null],
      ["start", "Commencer", "primary", "/dashboard/settings?tab=org"],
    ]);
    const here = tourFooter({ view: "intro", step: 0, steps: STEPS, pathname: "/dashboard/settings", search: "?tab=org", anchorVisible: false, done: undefined });
    expect(here.at(-1)!.href).toBeNull();
    onePrimaryLast(away);
  });

  it("étape faite (« C'est fait. ») : « Précédent » (discret, absent à l'étape 1) puis « Suivant », ou « Terminer » à la dernière", () => {
    expect(summary(footer({ step: 0, done: true, pathname: "/dashboard/settings", search: "?tab=org" }))).toEqual([
      ["next", "Suivant", "primary", "/dashboard/settings?tab=pricing"],
    ]);
    expect(summary(footer({ step: 2, done: true, pathname: "/dashboard/drivers" }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard/settings?tab=pricing"],
      ["next", "Suivant", "primary", "/dashboard"],
    ]);
    // Étape suivante sur le même écran : un bouton
    const sameScreen = [STEPS[0]!, { ...STEPS[1]!, href: "/dashboard/settings?tab=org" }];
    expect(summary(footer({ step: 0, done: true, steps: sameScreen, pathname: "/dashboard/settings", search: "?tab=org" }))).toEqual([
      ["next", "Suivant", "primary", null],
    ]);
    expect(summary(footer({ step: 4, done: true, pathname: "/dashboard/settings", search: "?tab=team" }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard"],
      ["finish", "Terminer", "primary", null],
    ]);
    // Élément de l'étape visible ailleurs que sur son adresse : c'est le bon écran, pas de lien
    expect(summary(footer({ step: 2, done: true, pathname: "/dashboard/autre", anchorVisible: true }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard/settings?tab=pricing"],
      ["next", "Suivant", "primary", "/dashboard"],
    ]);
  });

  it("étape faite hors de son écran (« Revoir la visite » ailleurs) : son lien « Ouvrir … » en secondaire, puis « Suivant » ou « Terminer »", () => {
    // Étape 1 faite, rouverte depuis En direct : aucun élément surligné, l'écran de l'étape reste joignable
    const first = footer({ step: 0, done: true });
    expect(summary(first)).toEqual([
      ["open", "Ouvrir Organisation", "secondary", "/dashboard/settings?tab=org"],
      ["next", "Suivant", "primary", "/dashboard/settings?tab=pricing"],
    ]);
    onePrimaryLast(first);
    // Dernière étape faite, hors de son écran
    const last = footer({ step: 4, done: true, pathname: "/dashboard/drivers" });
    expect(summary(last)).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard"],
      ["open", "Ouvrir Équipe", "secondary", "/dashboard/settings?tab=team"],
      ["finish", "Terminer", "primary", null],
    ]);
    onePrimaryLast(last);
    // Super admin, étape 1 (« Éditeur ») faite, rouverte depuis la vue d'ensemble
    const admin = TOURS.super_admin.steps.map((s) => ({ href: s.href, linkLabel: s.linkLabel, title: s.title, hasCheck: !!s.check }));
    expect(summary(tourFooter({ view: "step", step: 0, steps: admin, pathname: "/admin", search: "", anchorVisible: false, done: true }))).toEqual([
      ["open", "Ouvrir Informations légales", "secondary", "/admin/legal"],
      ["next", "Suivant", "primary", "/admin/reglages"],
    ]);
  });

  it("pas sur le bon écran : « Précédent », « Passer l'étape » (secondaire ; « Terminer » à la dernière), « Ouvrir … » (toujours un lien)", () => {
    const b = footer({ step: 1, pathname: "/dashboard/drivers" });
    expect(summary(b)).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard/settings?tab=org"],
      ["skip", "Passer l'étape", "secondary", null],
      ["open", "Ouvrir Tarifs", "primary", "/dashboard/settings?tab=pricing"],
    ]);
    onePrimaryLast(b);
    expect(summary(footer({ step: 4, pathname: "/dashboard/drivers", done: false }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard"],
      ["finish", "Terminer", "secondary", null],
      ["open", "Ouvrir Équipe", "primary", "/dashboard/settings?tab=team"],
    ]);
    // Même chemin, autre onglet : pas le bon écran
    expect(footer({ step: 0, pathname: "/dashboard/settings", search: "?tab=pricing" }).at(-1)!.action).toBe("open");
  });

  it("bon écran, élément visible, condition non remplie ou inconnue : « Y aller » (nom complété pour les lecteurs d'écran)", () => {
    for (const done of [false, undefined]) {
      const b = footer({ step: 2, pathname: "/dashboard/drivers", anchorVisible: true, done });
      expect(summary(b)).toEqual([
        ["prev", "Précédent", "ghost", "/dashboard/settings?tab=pricing"],
        ["skip", "Passer l'étape", "secondary", "/dashboard"],
        ["goto", "Y aller", "primary", null],
      ]);
      expect(b.at(-1)!.srLabel).toBe(`${NBSP}: Vos chauffeurs`);
    }
    // Élément visible ailleurs que sur l'adresse de l'étape : c'est le bon écran
    expect(footer({ step: 2, pathname: "/dashboard/autre", anchorVisible: true }).at(-1)!.action).toBe("goto");
  });

  it("bon écran sans condition, ou élément introuvable : « Précédent » puis « Suivant » / « Terminer »", () => {
    expect(summary(footer({ step: 3, pathname: "/dashboard", anchorVisible: true }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard/drivers"],
      ["next", "Suivant", "primary", "/dashboard/settings?tab=team"],
    ]);
    expect(summary(footer({ step: 2, pathname: "/dashboard/drivers", anchorVisible: false, done: false }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard/settings?tab=pricing"],
      ["next", "Suivant", "primary", "/dashboard"],
    ]);
    expect(summary(footer({ step: 4, pathname: "/dashboard/settings", search: "?tab=team" }))).toEqual([
      ["prev", "Précédent", "ghost", "/dashboard"],
      ["finish", "Terminer", "primary", null],
    ]);
  });

  it("chaque étape des 5 parcours : un seul bouton principal, en dernier ; liens vers des adresses de l'espace", () => {
    for (const key of TOUR_KEYS) {
      const def = TOURS[key];
      const steps = def.steps.map((s) => ({ href: s.href, linkLabel: s.linkLabel, title: s.title, hasCheck: !!s.check }));
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.length).toBeLessThanOrEqual(TOUR_MAX_STEPS);
      const space = key === "super_admin" ? "/admin" : "/dashboard";
      for (let step = 0; step < steps.length; step++) {
        for (const pathname of ["/dashboard", "/admin", "/dashboard/settings"]) {
          for (const done of [true, false, undefined]) {
            for (const anchorVisible of [true, false]) {
              const b = tourFooter({ view: "step", step, steps, pathname, search: "", anchorVisible, done });
              onePrimaryLast(b);
              for (const x of b) if (x.href) expect(x.href.startsWith(space)).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe("repli centré (dockedRect)", () => {
  const desktop = { width: 1440, height: 900 };
  const phone = { width: 390, height: 844 };
  const main = { left: 232, right: 1440 };

  it("sans barre : centré sur main#contenu, 24 px du bas (bureau), largeur nulle", () => {
    expect(dockedRect({ viewport: desktop, main, avoid: [] })).toEqual({ x: 836, y: 876, width: 0, height: 0, top: 876, bottom: 876, left: 836, right: 836 });
  });

  it("téléphone : 16 px du bas, centré sur la fenêtre sans main", () => {
    const r = dockedRect({ viewport: phone, main: null, avoid: [] });
    expect([r.x, r.y]).toEqual([195, 828]);
    expect(dockedRect({ viewport: phone, main: { left: 0, right: 390 }, avoid: [] }).x).toBe(195);
  });

  it("barre à éviter dans la moitié basse : la fenêtre remonte au-dessus (écart de 12 px)", () => {
    const bar = { top: 800, bottom: 870, left: 248, right: 1424 };
    expect(dockedRect({ viewport: desktop, main, avoid: [bar] }).y).toBe(800 - TOUR_DOCK_GAP);
    // La plus haute des barres basses l'emporte
    expect(dockedRect({ viewport: desktop, main, avoid: [bar, { top: 700, bottom: 760, left: 0, right: 500 }] }).y).toBe(688);
    // Téléphone
    expect(dockedRect({ viewport: phone, main: null, avoid: [{ top: 700, bottom: 828, left: 16, right: 374 }] }).y).toBe(688);
  });

  it("barre en haut, hors de l'écran ou vide : ignorée", () => {
    const base = dockedRect({ viewport: desktop, main, avoid: [] }).y;
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 200, bottom: 260, left: 0, right: 900 }] }).y).toBe(base);
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 950, bottom: 1010, left: 0, right: 900 }] }).y).toBe(base);
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 800, bottom: 800, left: 0, right: 0 }] }).y).toBe(base);
  });

  it("marge imposée (pastille : 16 px), main hors de l'écran : centre de la fenêtre", () => {
    expect(dockedRect({ viewport: desktop, main, avoid: [], margin: 16 }).y).toBe(884);
    expect(dockedRect({ viewport: desktop, main: { left: 2000, right: 2400 }, avoid: [] }).x).toBe(720);
  });

  it("hauteur connue : seule une barre qui couperait la fenêtre la fait remonter (barre revenue à sa place en fin de page : non)", () => {
    const h = 218;
    // Barre « Enregistrer » collée en bas : elle couperait la fenêtre → au-dessus
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 826, bottom: 884, left: 248, right: 1424 }], height: h }).y).toBe(814);
    // Fin de page (barre à sa place, au-dessus de la réserve, y 560-618) : la fenêtre reste en bas (658-876), les
    // dernières lignes de la grille passent au-dessus d'elle (sinon elle suivait la barre jusqu'en 330-548)
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 560, bottom: 618, left: 248, right: 1424 }], height: h }).y).toBe(876);
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 560, bottom: 618, left: 248, right: 1424 }] }).y).toBe(548);
    // Limite : barre à l'écart près de la fenêtre (876 − 218 − 12 = 646) ; au-delà, elle la couperait
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 588, bottom: 646, left: 0, right: 900 }], height: h }).y).toBe(876);
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 589, bottom: 647, left: 0, right: 900 }], height: h }).y).toBe(577);
    // Deux barres l'une au-dessus de l'autre : au-dessus des deux si la remontée fait rencontrer la seconde
    const two = [
      { top: 700, bottom: 760, left: 0, right: 900 },
      { top: 826, bottom: 884, left: 0, right: 900 },
    ];
    expect(dockedRect({ viewport: desktop, main, avoid: two, height: h }).y).toBe(688);
    // Fenêtre basse (pastille de 40 px) entre les deux : au-dessus de la plus basse seulement
    expect(dockedRect({ viewport: desktop, main, avoid: two, height: 40 }).y).toBe(814);
  });

  it("barre collante : comptée à sa place collée au bas de l'écran, même quand elle remonte avec la page (la fenêtre ne la suit pas)", () => {
    const h = 218;
    const bar = (top: number) => ({ top, bottom: top + 58, left: 248, right: 1424, stuck: { top: 826, bottom: 884 } });
    // Collée en bas : au-dessus d'elle
    expect(dockedRect({ viewport: desktop, main, avoid: [bar(826)], height: h }).y).toBe(814);
    // Revenue à sa place en fin de formulaire, elle monte avec la page (moitié basse) : la fenêtre ne bouge pas (avant :
    // 668 puis 521, et les lignes juste au-dessus de la barre restaient sous la fenêtre)
    expect(dockedRect({ viewport: desktop, main, avoid: [bar(680)], height: h }).y).toBe(814);
    expect(dockedRect({ viewport: desktop, main, avoid: [bar(533)], height: h }).y).toBe(814);
    // Passée dans la moitié haute : ignorée, la fenêtre redescend ; hors de l'écran : ignorée
    expect(dockedRect({ viewport: desktop, main, avoid: [bar(440)], height: h }).y).toBe(876);
    expect(dockedRect({ viewport: desktop, main, avoid: [bar(950)], height: h }).y).toBe(876);
  });

  it("réserve de défilement : jusqu'au haut de la fenêtre remontée au-dessus des barres collantes, plus 8 px", () => {
    // Sans barre : hauteur de la fenêtre + marge + 8 (inchangé)
    expect(dockReserve(900, dockedTop(dockedRect({ viewport: desktop, main, avoid: [] }), 218))).toBe(218 + 24 + 8);
    expect(dockReserve(844, dockedTop(dockedRect({ viewport: phone, main: null, avoid: [] }), 336))).toBe(336 + 16 + 8);
    // Barre collante (pour la réserve : toujours à sa place collée) : la fin de la page, barre comprise, passe au-dessus
    // de la fenêtre remontée (fin du contenu à 900 − 312 = 588, haut de la fenêtre à 596)
    const top = dockedTop(dockedRect({ viewport: desktop, main, avoid: [{ top: 826, bottom: 884, left: 248, right: 1424 }], height: 218 }), 218);
    expect(top).toBe(596);
    expect(dockReserve(900, top)).toBe(312);
  });

  it("En direct sous lg : le panneau des courses (moitié basse) fait remonter la fenêtre sur la carte, pas à partir de lg", () => {
    // 390×844 : panneau à y 444 (> 422) ; bureau : panneau en haut (top-3), ignoré
    expect(dockedRect({ viewport: phone, main: null, avoid: [{ top: 444, bottom: 844, left: 0, right: 390 }] }).y).toBe(432);
    expect(dockedRect({ viewport: desktop, main, avoid: [{ top: 12, bottom: 888, left: 244, right: 636 }] }).y).toBe(876);
  });
});

describe("repli : marge du bas, place prise et focus caché dessous (WCAG 2.2, 2.4.11)", () => {
  const phone = { width: 390, height: 844 };

  it("haut réel de la fenêtre : son bas est le y du repli, remontée au-dessus d'une barre comprise", () => {
    expect(dockedTop(dockedRect({ viewport: phone, main: null, avoid: [] }), 300)).toBe(528);
    const lifted = dockedRect({ viewport: phone, main: null, avoid: [{ top: 700, bottom: 828, left: 16, right: 374 }] });
    expect(dockedTop(lifted, 300)).toBe(388);
  });

  it("marge de défilement du bas : jusqu'au haut de la fenêtre, plus l'écart ; jamais moins que celle de la page", () => {
    // Bureau, « Vos tarifs » : fenêtre de y 596 à 814 → un champ focalisé finit au-dessus de y 584
    expect(dockScrollPadding(900, 596, 96)).toBe(900 - 596 + TOUR_DOCK_GAP);
    // Remontée au-dessus d'une barre « Enregistrer » : la barre est couverte aussi
    expect(dockScrollPadding(844, 388, 96)).toBe(468);
    expect(dockScrollPadding(900, 880, 96)).toBe(96);
    expect(dockScrollPadding(900, 595.5, 96)).toBe(317);
  });

  it("place prise en bas de l'écran (--tour-dock) : notifications au-dessus de la fenêtre quand elle est dans leur bande", () => {
    // Téléphone, repli en bas (528 → 828) : au-dessus de la fenêtre
    expect(dockSpace(844, 528, 828)).toBe(316);
    expect(dockSpace(844, 527.4, 828)).toBe(317);
    // Bureau, remontée au-dessus d'une barre « Enregistrer » (596 → 814) : au-dessus de la fenêtre (et de la barre)
    expect(dockSpace(900, 596, 814)).toBe(304);
    // En direct sur téléphone, au-dessus du panneau (116 → 432) : hors de leur bande, notifications en bas
    expect(dockSpace(844, 116, 432)).toBe(0);
    expect(dockSpace(844, 528, 844 - TOUR_TOAST_ZONE)).toBe(0);
    // Écran bas (téléphone à l'horizontale, 93 → 366) : jamais au point de sortir une notification par le haut
    expect(dockSpace(390, 93, 366)).toBe(390 - TOUR_TOAST_TOP);
  });

  it("élément entièrement sous la fenêtre (rectangle compris, à 1 px près) ; partiellement visible ou vide : non", () => {
    const card = { top: 596, bottom: 814, left: 644, right: 1028 };
    // « € TTC / min » de la grille, sous la fenêtre (constat de la revue)
    expect(hiddenUnder({ top: 655, bottom: 695, left: 700, right: 900 }, card)).toBe(true);
    expect(hiddenUnder({ top: 595.5, bottom: 814.5, left: 643.5, right: 1028.5 }, card)).toBe(true);
    expect(hiddenUnder({ top: 580, bottom: 620, left: 700, right: 900 }, card)).toBe(false);
    expect(hiddenUnder({ top: 655, bottom: 695, left: 600, right: 900 }, card)).toBe(false);
    expect(hiddenUnder({ top: 700, bottom: 700, left: 700, right: 900 }, card)).toBe(false);
    expect(hiddenUnder({ top: 700, bottom: 740, left: 700, right: 700 }, card)).toBe(false);
  });

  it("défilement qui amène le bas de l'élément à 12 px au-dessus de la fenêtre", () => {
    const el = { top: 655, bottom: 695 };
    expect(revealScroll(el, 596)).toBe(111);
    expect(el.bottom - revealScroll(el, 596)).toBe(596 - TOUR_DOCK_GAP);
    expect(revealScroll({ bottom: 695.2 }, 596)).toBe(112);
  });

  // Mesures de la vérification UX-01 (téléphones courts, focus de « Y aller » après le défilement de la zone) :
  // [gauche, haut, droite, bas] de l'élément focalisé, puis de la fenêtre
  const rect = ([left, top, right, bottom]: number[]) => ({ left: left!, top: top!, right: right!, bottom: bottom! });
  const measured = {
    organisation: { el: rect([37, 389, 338, 429]), card: rect([16, 367, 359, 651]) }, // 375×667, « Nom commercial »
    tarifs: { el: rect([37, 319, 182, 359]), card: rect([16, 245, 359, 581]) }, // 375×667, « Prise en charge »
    reservation: { el: rect([37, 378, 162, 422]), card: rect([16, 292, 359, 651]) }, // 375×667, « Je la prends »
    commission: { el: rect([37, 231, 323, 271]), card: rect([16, 218, 344, 554]) }, // 360×640, « Pourcentage du prix »
    inscription: { el: rect([37, 325, 259, 361]), card: rect([16, 288, 344, 624]) }, // 360×640, « Créer le lien… »
  };

  it("règle « hidden » (filet du focus au clavier) : celle de hiddenUnder, inchangée", () => {
    const card = { top: 596, bottom: 814, left: 644, right: 1028 };
    for (const el of [
      { top: 655, bottom: 695, left: 700, right: 900 },
      { top: 580, bottom: 620, left: 700, right: 900 },
      { top: 655, bottom: 695, left: 600, right: 900 },
      { top: 700, bottom: 700, left: 700, right: 900 },
    ]) {
      expect(focusCovered(el, card, "hidden")).toBe(hiddenUnder(el, card));
    }
    for (const { el, card: c } of Object.values(measured)) expect(focusCovered(el, c, "hidden")).toBe(true);
  });

  it("règle « overlap » (« Y aller ») : touché même en partie, centre ou bord ; à 1 px près ; rectangle vide : non", () => {
    for (const { el, card } of Object.values(measured)) expect(focusCovered(el, card, "overlap")).toBe(true);
    const card = { top: 345, bottom: 651, left: 16, right: 359 };
    // Centre couvert, pas entièrement caché (2.4.11 tenu, 2.4.12 non) : couvert
    expect(focusCovered({ top: 330, bottom: 370, left: 37, right: 323 }, card, "hidden")).toBe(false);
    expect(focusCovered({ top: 330, bottom: 370, left: 37, right: 323 }, card, "overlap")).toBe(true);
    // Bord seulement (centre libre) : couvert aussi
    expect(focusCovered({ top: 300, bottom: 350, left: 37, right: 323 }, card, "overlap")).toBe(true);
    // Au-dessus, sous elle, à côté, au pixel près : non
    expect(focusCovered({ top: 293, bottom: 333, left: 37, right: 323 }, card, "overlap")).toBe(false);
    expect(focusCovered({ top: 306, bottom: 346, left: 37, right: 323 }, card, "overlap")).toBe(false);
    expect(focusCovered({ top: 306, bottom: 346.5, left: 37, right: 323 }, card, "overlap")).toBe(true);
    expect(focusCovered({ top: 650, bottom: 690, left: 37, right: 323 }, card, "overlap")).toBe(false);
    expect(focusCovered({ top: 400, bottom: 440, left: 360, right: 380 }, { ...card, right: 361 }, "overlap")).toBe(false);
    expect(focusCovered({ top: 400, bottom: 400, left: 37, right: 323 }, card, "overlap")).toBe(false);
    expect(focusCovered({ top: 400, bottom: 440, left: 37, right: 37 }, card, "overlap")).toBe(false);
  });

  it("« Y aller » : défilement qui amène l'élément entièrement au-dessus de la fenêtre, sous la barre du haut", () => {
    const top = 80; // marge de défilement du haut de <html> (5rem)
    const expected = { organisation: 74, tarifs: 126, reservation: 142, commission: 65, inscription: 85 };
    for (const [name, { el, card }] of Object.entries(measured)) {
      const scroll = revealWithin(el, card.top, top);
      expect(scroll, name).toBe(expected[name as keyof typeof expected]);
      const after = { ...el, top: el.top - scroll!, bottom: el.bottom - scroll! };
      expect(focusCovered(after, card, "overlap"), name).toBe(false);
      expect(after.bottom, name).toBe(card.top - TOUR_DOCK_GAP);
      expect(after.top, name).toBeGreaterThanOrEqual(top);
    }
  });

  it("« Y aller » : élément qui ne tient pas entre la barre du haut et la fenêtre → null (fenêtre réduite)", () => {
    // Zone focalisée elle-même, plus haute que la place libre (300 px pour 288 − 12 − 80 = 196)
    expect(revealWithin({ top: 120, bottom: 420 }, 288, 80)).toBeNull();
    // Téléphone à l'horizontale (667×375, fenêtre de 262 px dès y 89) : plus aucune place au-dessus d'elle
    expect(revealWithin({ top: 120, bottom: 160 }, 89, 80)).toBeNull();
    // Tient tout juste (au pixel près)
    expect(revealWithin({ top: 200, bottom: 396 }, 288, 80)).toBe(120);
    expect(revealWithin({ top: 199, bottom: 396 }, 288, 80)).toBe(120);
    expect(revealWithin({ top: 198, bottom: 396 }, 288, 80)).toBeNull();
  });
});

describe("Échap dans la fenêtre de visite (tourEscape, § 6.6)", () => {
  const esc = (view: TourState["view"], handled = false, key = "Escape") => tourEscape({ key, handled, view });

  it("accueil → « Plus tard » ; étape → pause (« × »)", () => {
    expect(esc("intro")).toBe("later");
    expect(esc("step")).toBe("close");
  });

  it("frappe déjà prise par un calque au-dessus (menu, fenêtre de Radix qui se ferme d'abord) : la visite reste ouverte", () => {
    expect(esc("intro", true)).toBeNull();
    expect(esc("step", true)).toBeNull();
  });

  it("autre touche, ou visite fermée : rien", () => {
    for (const key of ["Tab", "Enter", " ", "n", "Esc"]) expect(esc("step", false, key)).toBeNull();
    expect(esc("closed")).toBeNull();
  });
});

describe("« Y aller » dans une zone (pickFocus, § 6.4)", () => {
  type C = FocusCandidate & { id: string };
  const c = (id: string, kind: FocusCandidate["kind"], more: Partial<FocusCandidate> = {}): C => ({ id, kind, marked: false, current: false, ...more });
  const pick = (list: C[]) => pickFocus(list)?.id ?? null;

  it("dispatcher, « Attribuer une course » : le filtre affiché (« Sans chauffeur »), pas le premier lien (« Toutes »)", () => {
    expect(pick([c("Toutes", "link"), c("À traiter", "link"), c("Sans chauffeur", "link", { current: true }), c("Rechercher", "control")])).toBe("Sans chauffeur");
  });

  it("Flotte Privée, « À traiter » : « Je la prends », ni « Tout voir » ni la fiche de la réservation", () => {
    expect(pick([c("Tout voir", "link"), c("Fiche de la réservation", "link"), c("Je la prends", "control"), c("Refuser", "control"), c("Fixer le prix", "control")])).toBe("Je la prends");
  });

  it("formulaire (Organisation, Tarifs, Éditeur) : son premier champ", () => {
    expect(pick([c("Raison sociale", "control"), c("SIRET", "control"), c("Enregistrer", "control")])).toBe("Raison sociale");
  });

  it("[data-tour-focus] avant tout ; liens seulement sans commande ; zone défilante en dernier ; rien : null", () => {
    expect(pick([c("Toutes", "link", { current: true }), c("Champ", "control"), c("Marqué", "link", { marked: true })])).toBe("Marqué");
    expect(pick([c("Zone", "other"), c("Lien", "link")])).toBe("Lien");
    expect(pick([c("Zone", "other"), c("Autre zone", "other")])).toBe("Zone");
    expect(pick([])).toBeNull();
  });
});

describe("textes du moteur (§ 6.10)", () => {
  it("libellés, compteur, pastille, toasts en typographie française", () => {
    expect(TOUR_UI.counter(2, 5)).toBe("Visite guidée · étape 2 sur 5");
    expect(TOUR_UI.expand(2, 5)).toBe("Afficher la visite guidée, étape 2 sur 5");
    expect(TOUR_UI.pill(2, 5)).toBe("Visite guidée · 2/5");
    expect(TOUR_UI.paused).toBe(`Visite en pause${NBSP}: reprenez-la depuis votre nom, en bas du menu.`);
    expect(TOUR_UI.finished).toBe(`Visite terminée${NBSP}: vous pouvez la revoir depuis votre nom, en bas du menu.`);
    expect(TOUR_UI.saveError).toBe(`Progression de la visite non enregistrée${NBSP}: elle pourra revenir plus tard.`);
    expect([TOUR_UI.minimize, TOUR_UI.close, TOUR_UI.resume, TOUR_UI.replay]).toEqual([
      "Réduire la visite guidée",
      "Fermer la visite guidée",
      "Reprendre la visite",
      "Revoir la visite",
    ]);
  });
});

describe("conditions de réussite (squelette du lot T2)", () => {
  it("stepDone : sans condition ou tout inconnu → undefined ; une clé vraie → vrai ; sinon faux", () => {
    expect(stepDone(undefined, { drivers: true })).toBeUndefined();
    expect(stepDone({ any: ["drivers", "join_link"] }, {})).toBeUndefined();
    expect(stepDone({ any: ["drivers", "join_link"] }, { join_link: true })).toBe(true);
    expect(stepDone({ any: ["drivers", "join_link"] }, { drivers: false })).toBe(false);
    expect(stepDone({ any: ["drivers"] }, { drivers: false, join_link: true })).toBe(false);
  });
});
