import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Pages introuvables des espaces connectés (docs/REFONTE-PANELS.md, R1) : rendues dans la mise en page (la barre
// latérale reste ; avant, notFound() sortait vers la 404 du site vitrine), SANS <main> (la coquille le porte : un seul
// repère principal), texte français, « Page précédente » et retour à l'accueil de l'espace. La 404 neutre
// (app/not-found.tsx, mini-sites) ne change pas (lib/not-found-page.test.ts).

vi.mock("@/lib/utils", async () => await import("./utils"));
vi.mock("@/components/ui/button", async () => await import("../components/ui/button"));

const dashboard = await import("../app/dashboard/not-found");
const admin = await import("../app/admin/not-found");

const WEB = join(import.meta.dirname, "..");
const cases = [
  { name: "tableau de bord", page: dashboard, file: "app/dashboard/not-found.tsx", home: "/dashboard", homeLabel: "Retour au tableau de bord" },
  { name: "super admin", page: admin, file: "app/admin/not-found.tsx", home: "/admin", homeLabel: "Retour à la vue d'ensemble" },
] as const;

describe.each(cases)("page introuvable : $name", ({ page, file, home, homeLabel }) => {
  const html = renderToStaticMarkup(createElement(page.default)).replace(/&#x27;/g, "'");

  it("titre, explication et deux sorties : page précédente et accueil de l'espace", () => {
    expect(html).toMatch(/<h1[^>]*>Page introuvable<\/h1>/);
    expect(html).toContain("Cette page n'existe pas ou plus.");
    expect(html).toContain("Page précédente");
    expect(html).toMatch(new RegExp(`<a[^>]*href="${home}"[^>]*>.*${homeLabel}`));
    expect(html).not.toMatch(/could not be found|not found/i);
  });

  it("dans la mise en page : aucun <main> (celui de la coquille suffit), un seul h1", () => {
    expect(html).not.toContain("<main");
    expect(html.match(/<h1/g)).toHaveLength(1);
    // Code (commentaires exclus) : jamais de balise main
    const code = readFileSync(join(WEB, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/<main\b/);
  });

  it("titre de l'onglet « Page introuvable » ; jetons du thème, aucune couleur en dur ; lien sans préchargement", () => {
    expect(page.metadata).toEqual({ title: "Page introuvable" });
    expect(html).toContain("text-fg");
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(readFileSync(join(WEB, file), "utf8")).toMatch(/<Link href="[^"]+" prefetch=\{false\}>/);
  });
});
