import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Visite guidée (docs/TUTORIEL.md § 6.5, § 6.6) : contenu de la fenêtre rendu tel quel — accueil (liste des étapes,
// « Plus tard », « Commencer »), étape (compteur, titre h2 focalisable, « C'est fait. » annoncé), vrais liens vers les
// écrans, boutons-icônes nommés, un seul bouton plein, aucune couleur en dur, aucun texte sous 12 px, espaces
// insécables. Modules « @/ » résolus à la main.

vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/components/ui/button", async () => await import("../ui/button"));

const { TourPanel, tourPanelIds } = await import("./tour-panel");
const { TOURS } = await import("./tour-content");
const { TOUR_UI, tourFooter } = await import("./tour-model");

const NBSP = " ";
const noop = () => undefined;
const fleet = TOURS.fleet;
const steps = fleet.steps.map((s) => ({ href: s.href, linkLabel: s.linkLabel, title: s.title, hasCheck: !!s.check }));

type PanelProps = Parameters<typeof TourPanel>[0];
const render = (props: Partial<PanelProps>) =>
  renderToStaticMarkup(
    createElement(TourPanel, {
      view: "step",
      idBase: "visite-t",
      counter: TOUR_UI.counter(1, 5),
      title: fleet.steps[0]!.title,
      text: fleet.steps[0]!.text,
      done: undefined,
      buttons: [],
      canMinimize: true,
      onAction: noop,
      onMinimize: noop,
      onClose: noop,
      ...props,
    }),
  );

/** Texte visible (balises retirées, entités décodées). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
/** Liens rendus : adresse et texte. */
const links = (html: string) =>
  [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ href: /href="([^"]*)"/.exec(m[1]!)?.[1] ?? null, text: text(m[2]!).trim() }));
/** Boutons rendus : texte. */
const buttons = (html: string) => [...html.matchAll(/<button\s[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!).trim());

describe("fenêtre de la visite : accueil", () => {
  const html = render({
    view: "intro",
    counter: TOUR_UI.name,
    title: fleet.intro.title,
    text: fleet.intro.text,
    stepTitles: fleet.steps.map((s) => s.title),
    canMinimize: false,
    buttons: tourFooter({ view: "intro", step: 0, steps, pathname: "/dashboard", search: "", anchorVisible: false, done: undefined }),
  });

  it("titre h2 focalisable par le script, texte, liste ordonnée des 5 étapes", () => {
    const ids = tourPanelIds("visite-t");
    expect(html).toContain(`<h2 id="${ids.title}" tabindex="-1"`);
    expect(html).toContain(`id="${ids.counter}"`);
    expect(html).toContain(`id="${ids.text}"`);
    expect(html).toMatch(/<ol [^>]*>(<li>[^<]+<\/li>){5}<\/ol>/);
    for (const s of fleet.steps) expect(html).toContain(`<li>${s.title.replace(/'/g, "&#x27;")}</li>`);
    expect(text(html)).toContain("Bienvenue sur Rydar Drive");
  });

  it("« Plus tard » (bouton) puis « Commencer » (lien vers l'écran de l'étape 1, sans « Réduire »)", () => {
    expect(buttons(html)).toEqual([TOUR_UI.close, "Plus tard"]);
    expect(links(html)).toEqual([{ href: "/dashboard/settings?tab=org", text: "Commencer" }]);
    expect(html).not.toContain(TOUR_UI.minimize);
  });
});

describe("fenêtre de la visite : étape", () => {
  it("compteur, titre, texte, zone « C'est fait. » toujours présente (vide tant que rien n'est fait)", () => {
    const html = render({ buttons: tourFooter({ view: "step", step: 0, steps, pathname: "/dashboard", search: "", anchorVisible: false, done: undefined }) });
    expect(text(html)).toContain("Visite guidée · étape 1 sur 5");
    expect(html).toMatch(/<p aria-live="polite"[^>]*><\/p>/);
    expect(html).not.toContain(TOUR_UI.done.replace(/'/g, "&#x27;"));
  });

  it("« C'est fait. » annoncé quand la condition est remplie ; « Suivant » devient le bouton principal", () => {
    const html = render({ done: true, buttons: tourFooter({ view: "step", step: 0, steps, pathname: "/dashboard/settings", search: "?tab=org", anchorVisible: true, done: true }) });
    expect(html).toMatch(/<p aria-live="polite"[^>]*>.*C&#x27;est fait\.<\/p>/);
    expect(links(html)).toEqual([{ href: "/dashboard/settings?tab=pricing", text: "Suivant" }]);
  });

  it("pas sur le bon écran : « Précédent » et « Passer l'étape » (liens) puis « Ouvrir … » (lien principal)", () => {
    const html = render({
      counter: TOUR_UI.counter(2, 5),
      title: fleet.steps[1]!.title,
      text: fleet.steps[1]!.text,
      buttons: tourFooter({ view: "step", step: 1, steps, pathname: "/dashboard", search: "", anchorVisible: false, done: undefined }),
    });
    expect(links(html)).toEqual([
      { href: "/dashboard/settings?tab=org", text: "Précédent" },
      { href: "/dashboard/drivers", text: "Passer l'étape" },
      { href: "/dashboard/settings?tab=pricing", text: "Ouvrir Tarifs" },
    ]);
    // Un seul bouton plein (fond lime), le dernier
    const filled = [...html.matchAll(/<(?:a|button)\s[^>]*class="([^"]*)"[^>]*data-tour-action="([^"]+)"/g)].filter((m) => m[1]!.split(/\s+/).includes("bg-brand"));
    expect(filled.map((m) => m[2])).toEqual(["open"]);
  });

  it("« Y aller » : bouton, nom complété pour les lecteurs d'écran (« : titre de l'étape »)", () => {
    const html = render({ buttons: tourFooter({ view: "step", step: 2, steps, pathname: "/dashboard/drivers", search: "", anchorVisible: true, done: false }) });
    expect(buttons(html).filter((b) => b.startsWith("Y aller") && b.endsWith("Vos chauffeurs"))).toHaveLength(1);
    expect(html).toContain(`<span class="sr-only">${NBSP}: Vos chauffeurs</span>`);
  });

  it("boutons-icônes nommés : « Réduire la visite guidée », « Fermer la visite guidée » ; 44 px au toucher", () => {
    const html = render({});
    expect(html).toContain(`<span class="sr-only">${TOUR_UI.minimize}</span>`);
    expect(html).toContain(`<span class="sr-only">${TOUR_UI.close}</span>`);
    expect(html.match(/<button type="button" class="[^"]*\bsize-11\b[^"]*\bsm:size-8\b/g)).toHaveLength(2);
  });

  it("boutons du pied : 44 px de haut sous 640 px, principal en haut (colonne inversée)", () => {
    const html = render({ buttons: tourFooter({ view: "step", step: 1, steps, pathname: "/dashboard", search: "", anchorVisible: false, done: undefined }) });
    expect(html).toContain("flex flex-col-reverse gap-2 sm:flex-row");
    expect(html.match(/data-tour-action="/g)).toHaveLength(3);
    for (const m of html.matchAll(/<(?:a|button)\s[^>]*data-tour-action="[^"]+"[^>]*>/g)) expect(m[0]).toMatch(/\bmin-h-11\b/);
  });
});

describe("fenêtre de la visite : règles de forme", () => {
  const all = [
    render({ view: "intro", counter: TOUR_UI.name, title: fleet.intro.title, text: fleet.intro.text, stepTitles: fleet.steps.map((s) => s.title), canMinimize: false }),
    render({ done: true, buttons: tourFooter({ view: "step", step: 4, steps, pathname: "/dashboard", search: "", anchorVisible: true, done: true }) }),
  ].join("");

  it("aucune couleur en dur (rendu et sources de components/tour), aucun texte sous 12 px", () => {
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const file of readdirSync(import.meta.dirname).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))) {
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      expect(src, file).not.toMatch(/text-\[1[01](\.\d+)?px\]|text-\[\d(\.\d+)?px\]/);
    }
    const sizes = [...all.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    expect(all).not.toMatch(/\btext-\[1[01]px\]|\btext-2xs\b/);
  });

  it("textes des 5 parcours en typographie française (espace insécable avant « : ; ? ! » et dans les guillemets)", () => {
    for (const def of Object.values(TOURS)) {
      for (const t of [def.intro.title, def.intro.text, ...def.steps.flatMap((s) => [s.title, s.text, s.linkLabel])]) {
        expect(t).not.toMatch(/ [:;!?»]/);
        expect(t).not.toMatch(/« /);
      }
    }
    const html = render({ text: fleet.steps[0]!.text });
    expect(html).toContain(`VTC${NBSP}: ils figurent`);
  });

  it("source : chaque lien sans préchargement, aucun stockage du navigateur, aucune navigation par script", () => {
    const src = readFileSync(join(import.meta.dirname, "tour-panel.tsx"), "utf8");
    const linkTags = [...src.matchAll(/<Link\b[\s\S]*?>/g)].map((m) => m[0]);
    expect(linkTags.length).toBeGreaterThan(0);
    for (const tag of linkTags) expect(tag).toContain("prefetch={false}");
    // Motif assemblé : le contrôle du lot (grep sur components/tour) ne doit trouver ces mots nulle part, tests compris
    const forbidden = new RegExp(["local", "session"].map((k) => `${k}Storage`).concat(["router" + "\\.push"]).join("|"));
    expect(src).not.toMatch(forbidden);
  });
});
