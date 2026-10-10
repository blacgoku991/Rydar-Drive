import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Composants communs de la refonte (docs/REFONTE-PANELS.md § 3.12, R1) : rendu serveur de chaque brique, contrat
// d'accessibilité (rôles, noms, aria-current, liens sans préchargement) et règles de design (12 px au moins, aucune
// couleur en dur, retour à la ligne des en-têtes de carte).

vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/components/ui/button", async () => await import("./button"));
vi.mock("@/components/ui/misc", async () => await import("./misc"));
// ConfirmDialog : fenêtre rendue en ligne (le portail de Radix ne s'affiche pas côté serveur)
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) =>
    createElement("div", { role: "dialog" }, createElement("h2", null, title), createElement("p", null, description), children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("div", { "data-footer": "" }, createElement("button", null, "Retour"), children),
}));

const html = (node: ReactNode) => renderToStaticMarkup(node as never).replace(/&#x27;/g, "'");
const UI = import.meta.dirname;
const source = (file: string) => readFileSync(join(UI, file), "utf8");

const { Callout } = await import("./callout");
const { Disclosure } = await import("./disclosure");
const { FilterTabs } = await import("./filter-tabs");
const { Pagination, pageBounds, PAGE_SIZE } = await import("./pagination");
const { SearchField, searchClearHref } = await import("./search-field");
const { SwitchRow } = await import("./switch-row");
const { CopyButton } = await import("./copy-button");
const { ConfirmDialog } = await import("./confirm-dialog");
const { MobileList, DesktopTable, ListCard } = await import("./table");
const { EmptyState } = await import("./misc");
const { CardHeader } = await import("./card");
const { Badge } = await import("./badge");
const { Dialog, DialogFooter } = await import("./dialog");
const { PageHeader, PageBody, StatCard } = await import("../layout/page-header");

describe("Callout", () => {
  it("rôle selon l'urgence : status par défaut, alert pour danger, aucun sur demande", () => {
    expect(html(createElement(Callout, { title: "Info" }, "Texte"))).toMatch(/^<div role="status"/);
    expect(html(createElement(Callout, { tone: "danger", title: "Bloqué" }))).toMatch(/^<div role="alert"/);
    expect(html(createElement(Callout, { tone: "warning", role: null }, "x"))).not.toMatch(/role=/);
  });

  it("titre en fg, texte en fg-muted (jamais la couleur du ton sur le texte), icône décorative", () => {
    const out = html(createElement(Callout, { tone: "warning", title: "Les e-mails ne partent pas", action: createElement("a", { href: "/x" }, "Voir") }, "Détail"));
    expect(out).toContain('<p class="font-medium text-fg">Les e-mails ne partent pas</p>');
    expect(out).toContain("text-fg-muted");
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("border-amber/30");
    expect(out).toContain('href="/x"');
  });
});

describe("Disclosure", () => {
  it("details / summary natifs, fermé par défaut, cible de 44 px", () => {
    const out = html(createElement(Disclosure, { title: "Réglages avancés", children: "Contenu" }));
    expect(out).toMatch(/^<details class="group\/disclosure"><summary class="[^"]*min-h-11/);
    expect(out).not.toMatch(/<details[^>]*\bopen/);
    expect(out).toContain("Réglages avancés");
  });

  it("ouvert d'office (defaultOpen, forceOpen : erreur à l'intérieur) ; ancre id", () => {
    expect(html(createElement(Disclosure, { title: "A", defaultOpen: true, children: "x" }))).toMatch(/<details[^>]*\bopen/);
    expect(html(createElement(Disclosure, { title: "A", forceOpen: true, children: "x" }))).toMatch(/<details[^>]*\bopen/);
    expect(html(createElement(Disclosure, { title: "A", id: "frais", children: "x" }))).toContain('id="frais"');
  });

  it("aucun état mémorisé (pas de nouvelle clé de stockage)", () => {
    expect(source("disclosure.tsx")).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("FilterTabs", () => {
  const items = [
    { href: "/dashboard/rides?filter=all", label: "Toutes", active: true, count: 12 },
    { href: "/dashboard/rides?filter=no_driver", label: "Sans chauffeur", count: 3, alert: true },
    { href: "/dashboard/rides?filter=cancelled", label: "Annulées", count: 0 },
  ];

  it("des liens dans une nav nommée, aria-current sur l'onglet actif, compteurs", () => {
    const out = html(createElement(FilterTabs, { items, label: "Filtres des courses" }));
    expect(out).toMatch(/^<nav aria-label="Filtres des courses"/);
    expect(out.match(/<a /g)).toHaveLength(3);
    expect(out).toMatch(/<a [^>]*aria-current="page"[^>]*>Toutes/);
    expect(out.match(/aria-current/g)).toHaveLength(1);
    expect(out).toContain(">12<");
  });

  it("alerte en rouge au-dessus de zéro ; zéro grisé sauf l'onglet actif", () => {
    const out = html(createElement(FilterTabs, { items, label: "Filtres" }));
    const alert = out.slice(out.indexOf("Sans chauffeur"), out.indexOf("</a>", out.indexOf("Sans chauffeur")));
    expect(alert).toContain("text-red");
    const zero = out.slice(out.lastIndexOf("<a "), out.lastIndexOf("</a>"));
    expect(zero).toContain("text-fg-subtle");
    const active = html(createElement(FilterTabs, { items: [{ href: "/a", label: "Vide", active: true, count: 0 }], label: "F" }));
    expect(active).not.toMatch(/bg-transparent font-normal text-fg-subtle/);
  });

  it("rubriques soulignées ; retour à la ligne possible ; liens sans préchargement", () => {
    const out = html(createElement(FilterTabs, { items, label: "Rubriques", variant: "rubriques", wrap: true }));
    expect(out).toContain("border-b-2");
    expect(out).toContain("flex-wrap");
    expect(source("filter-tabs.tsx")).toMatch(/<Link[\s\S]*?prefetch=\{false\}/);
  });
});

describe("Pagination", () => {
  it("rien sur une seule page ; bornes de la page demandée", () => {
    expect(html(createElement(Pagination, { page: 1, pages: 1, href: (p: number) => `/x?page=${p}` }))).toBe("");
    expect(PAGE_SIZE).toBe(50);
    expect(pageBounds(230, "2")).toEqual({ page: 2, pages: 5 });
    expect(pageBounds(230, "99")).toEqual({ page: 5, pages: 5 });
    expect(pageBounds(230, "abc")).toEqual({ page: 1, pages: 5 });
    expect(pageBounds(0, undefined)).toEqual({ page: 1, pages: 1 });
    expect(pageBounds(null, "-3")).toEqual({ page: 1, pages: 1 });
  });

  it("« Page 2 / 5 · 230 courses », Précédent / Suivant en liens ; bouton inactif en bout de liste", () => {
    const mid = html(createElement(Pagination, { page: 2, pages: 5, total: 230, noun: "courses", href: (p: number) => `/dashboard/rides?page=${p}` }));
    expect(mid.replace(/<[^>]+>/g, "")).toContain("Page 2 / 5 · 230 courses");
    expect(mid).toContain('href="/dashboard/rides?page=1"');
    expect(mid).toContain('href="/dashboard/rides?page=3"');
    const first = html(createElement(Pagination, { page: 1, pages: 5, href: (p: number) => `/x?page=${p}` }));
    expect(first).toMatch(/<button[^>]*disabled[^>]*>.*Précédent/);
    expect(first).toContain('href="/x?page=2"');
  });
});

describe("SearchField", () => {
  it("formulaire GET vers la page, champ search « q », autres paramètres conservés (ni q ni page)", () => {
    const out = html(createElement(SearchField, { action: "/dashboard/rides", label: "Rechercher une course", defaultValue: "", params: { filter: "no_driver", page: "3", q: "old" } }));
    const form = /<form [^>]*>/.exec(out)![0];
    expect(form).toContain('role="search"');
    expect(form).toContain('action="/dashboard/rides"');
    expect(form).toContain('method="get"');
    expect(out).toContain('<input type="hidden" name="filter" value="no_driver"/>');
    expect(out).not.toContain('name="page"');
    const input = /<input type="search"[^>]*>/.exec(out)![0];
    expect(input).toContain('name="q"');
    expect(input).toContain('aria-label="Rechercher une course"');
    expect(out).toMatch(/<button [^>]*type="submit"[^>]*>.*Rechercher.*<\/button>/);
    expect(out).not.toContain("Effacer");
  });

  it("recherche en cours : lien « Effacer » vers la page sans la recherche, filtre gardé", () => {
    const out = html(createElement(SearchField, { action: "/dashboard/drivers", label: "Rechercher un chauffeur", defaultValue: "Karim", params: { filter: "online" } }));
    expect(out).toContain('value="Karim"');
    const clear = /<a [^>]*aria-label="Effacer la recherche"[^>]*>/.exec(out)![0];
    expect(clear).toContain('href="/dashboard/drivers?filter=online"');
    expect(searchClearHref("/admin/organizations", { q: "x", type: "flotte-privee", page: "" })).toBe("/admin/organizations?type=flotte-privee");
    expect(searchClearHref("/admin/organizations")).toBe("/admin/organizations");
  });
});

describe("SwitchRow", () => {
  it("toute la ligne est un libellé ; nom = titre, aide de l'état courant en description", () => {
    const on = html(createElement(SwitchRow, { title: "Lien actif", hintOn: "Les chauffeurs peuvent postuler", hintOff: "Personne ne peut postuler", checked: true, onCheckedChange: () => undefined }));
    expect(on).toMatch(/^<label/);
    expect(on).toContain("Les chauffeurs peuvent postuler");
    expect(on).not.toContain("Personne ne peut postuler");
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
    const titleId = /<span id="([^"]+)" class="block text-\[13.5px\]/.exec(on)![1];
    expect(on).toContain(`aria-labelledby="${titleId}"`);
    const off = html(createElement(SwitchRow, { title: "Lien actif", hintOn: "A", hintOff: "Personne ne peut postuler", checked: false, onCheckedChange: () => undefined }));
    expect(off).toContain("Personne ne peut postuler");
    expect(off).toMatch(/aria-describedby="[^"]+-hint"/);
  });
});

describe("CopyButton", () => {
  it("« Copier » au repos, nom précis avec `what`, résultat annoncé (role=status)", () => {
    const out = html(createElement(CopyButton, { value: "FR76…", what: "l'IBAN" }));
    expect(out).toContain('aria-label="Copier l\'IBAN"');
    expect(out).toContain("Copier</");
    expect(out).toContain('role="status"');
    const icon = html(createElement(CopyButton, { value: "x", what: "la clé", iconOnly: true }));
    expect(icon).toContain('aria-label="Copier la clé"');
    expect(icon).toContain('title="Copier la clé"');
  });
});

describe("ConfirmDialog et DialogFooter", () => {
  it("question, conséquence, « Retour » puis l'action qui nomme le geste (ton danger)", () => {
    const out = html(
      createElement(ConfirmDialog, {
        open: true,
        onOpenChange: () => undefined,
        title: "Révoquer la clé « Site web » ?",
        consequence: "Votre site ne pourra plus envoyer de réservations.",
        confirmLabel: "Révoquer la clé",
        onConfirm: () => undefined,
      }),
    );
    expect(out).toContain("Révoquer la clé « Site web » ?");
    expect(out).toContain("Votre site ne pourra plus envoyer de réservations.");
    expect(out.indexOf("Retour")).toBeLessThan(out.indexOf(">Révoquer la clé<"));
    expect(out).toContain("text-red");
    expect(out).not.toMatch(/>OK</);
    expect(html(createElement(ConfirmDialog, { open: false, onOpenChange: () => undefined, title: "T", consequence: "C", confirmLabel: "Faire", onConfirm: () => undefined }))).toBe("");
  });

  it("pied : « Retour » ferme sans rien faire, empilés sous 640 px (action en haut), collé en bas sur téléphone", () => {
    const out = html(createElement(Dialog, { open: true }, createElement(DialogFooter, { sticky: true }, createElement("button", { type: "button" }, "Enregistrer"))));
    expect(out).toMatch(/^<div class="[^"]*flex-col-reverse[^"]*sm:flex-row/);
    expect(out).toContain("max-sm:sticky");
    expect(out.indexOf(">Retour<")).toBeLessThan(out.indexOf(">Enregistrer<"));
    const plain = html(createElement(Dialog, { open: true }, createElement(DialogFooter, { hideBack: true }, "x")));
    expect(plain).not.toContain("Retour");
  });
});

describe("listes : cartes sous md, tableau au-delà", () => {
  it("MobileList masquée dès md, DesktopTable masquée en dessous", () => {
    expect(html(createElement(MobileList, null, createElement("li", null, "a")))).toMatch(/^<ul class="[^"]*md:hidden/);
    expect(html(createElement(DesktopTable, null, "t"))).toMatch(/^<div class="max-md:hidden/);
  });

  it("ListCard : toute la carte est un seul lien, statut jamais coupé, trois lignes au plus", () => {
    const out = html(
      createElement(ListCard, {
        href: "/dashboard/rides/1",
        title: "Course n° 1676 · mar. 13/10 11:00",
        status: createElement("span", null, "Planifiée"),
        lines: ["Orly → Paris", null, "", "Client · Business · 54 €", "Ligne 4", "Ligne 5"],
      }),
    );
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toMatch(/^<li><a [^>]*href="\/dashboard\/rides\/1"/);
    expect(out).toContain("whitespace-nowrap");
    expect(out).toContain("Ligne 4");
    expect(out).not.toContain("Ligne 5");
    expect(html(createElement(ListCard, { title: "Sans lien" }))).not.toContain("<a ");
  });
});

describe("états vides, en-têtes de carte, badges", () => {
  it("EmptyState compact : une ligne (titre puis explication), pas de grande carte", () => {
    const out = html(createElement(EmptyState, { size: "compact", title: "Aucun signalement.", description: "Rien à examiner pour l'instant." }));
    expect(out).not.toContain("py-14");
    expect(out.replace(/<[^>]+>/g, "")).toBe("Aucun signalement. Rien à examiner pour l'instant.");
  });

  it("CardHeader : retour à la ligne, titre d'au moins min(100 %, 14rem), action sous le titre si trop large", () => {
    const out = html(createElement(CardHeader, { title: "Flotte Privée", description: "Un chauffeur indépendant", action: createElement("button", null, "Passer en flotte standard") }));
    expect(out).toMatch(/^<div class="flex flex-wrap/);
    expect(out).toContain("min-w-[min(100%,14rem)] flex-1");
    expect(out).toContain('<div class="max-w-full shrink-0">');
  });

  it("textes de 12 px au moins (badge, « optionnel »)", () => {
    expect(html(createElement(Badge, null, "Actif"))).toContain("text-[12px]");
    expect(source("input.tsx")).toContain('text-[12px] font-normal text-fg-subtle">optionnel');
  });
});

describe("PageHeader, PageBody, StatCard", () => {
  it("aucun sur-titre texte ; marges téléphone px-4 pt-5", () => {
    const out = html(createElement(PageHeader, { title: "Courses", eyebrow: "Opérations", description: "Vos courses." }));
    expect(out).not.toContain("Opérations");
    expect(out).toContain("px-4 pb-5 pt-5 sm:px-6 sm:pt-7 lg:px-10");
    expect(html(createElement(PageBody, null, "x"))).toContain("px-4 py-6 sm:px-6 sm:py-8 lg:px-10");
  });

  it("fiche : lien de retour (« ← Courses », nom distinct du menu), badges à côté du h1, ligne d'informations", () => {
    const out = html(
      createElement(PageHeader, {
        title: "Course n° 1676",
        back: { href: "/dashboard/rides", label: "Courses" },
        badges: createElement("span", null, "Planifiée"),
        meta: "contact@exemple.fr · Paris",
      }),
    );
    const back = /<a [^>]*aria-label="Retour\u00a0: Courses"[^>]*>/.exec(out)![0];
    expect(back).toContain('href="/dashboard/rides"');
    expect(out.indexOf("<h1")).toBeLessThan(out.indexOf("Planifiée"));
    expect(out).toContain("[overflow-wrap:anywhere]");
    expect(out).toContain("contact@exemple.fr · Paris");
  });

  it("transition : un lien de retour passé en eyebrow (élément) reste affiché", () => {
    const out = html(createElement(PageHeader, { title: "Relevé", eyebrow: createElement("a", { href: "/dashboard/settlements" }, "Encaissements") }));
    expect(out).toContain('href="/dashboard/settlements"');
  });

  it("StatCard : lien vers sa liste (aria-current quand elle est affichée), sinon simple carte", () => {
    const link = html(createElement(StatCard, { label: "En retard", value: 3, href: "/dashboard/settlements?filter=overdue", active: true }));
    expect(link).toMatch(/^<a [^>]*href="\/dashboard\/settlements\?filter=overdue"/);
    expect(link).toContain('aria-current="page"');
    expect(html(createElement(StatCard, { label: "Total", value: 3 }))).toMatch(/^<div class="surface/);
  });
});

describe("règles de design des nouveaux fichiers", () => {
  it("aucune couleur en dur, aucune taille sous 12 px, aucun stockage local", () => {
    for (const file of ["callout.tsx", "disclosure.tsx", "filter-tabs.tsx", "pagination.tsx", "copy-button.tsx", "search-field.tsx", "switch-row.tsx", "confirm-dialog.tsx"]) {
      const src = source(file);
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, file).not.toMatch(/text-\[(10|10\.5|11|11\.5)px\]/);
      expect(src, file).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
