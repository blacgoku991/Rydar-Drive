import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Page 404 (app/not-found.tsx) : en français, au design du projet, neutre (aucun logo ni nom de plateforme : elle
// s'affiche aussi sur les mini-sites des centrales en marque blanche) — e2e D2 : page par défaut de Next, en anglais.

vi.mock("@/lib/utils", async () => await import("./utils"));
vi.mock("@/components/ui/button", async () => await import("../components/ui/button"));

const page = await import("../app/not-found");

describe("page 404", () => {
  const html = renderToStaticMarkup(createElement(page.default));

  it("texte français, retour à l'accueil du site consulté et page précédente", () => {
    expect(html).toContain("<h1");
    expect(html).toContain("Page introuvable");
    expect(html).toContain("Erreur 404");
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>.*Revenir à l(&#x27;|')accueil/);
    expect(html).toContain("Page précédente");
    expect(html).not.toMatch(/could not be found|not found/i);
  });

  it("neutre pour les mini-sites : ni logo ni nom de la plateforme, titre sans suffixe", () => {
    expect(html).not.toMatch(/rydar/i);
    expect(html).not.toContain("<img");
    expect(page.metadata).toEqual({ title: { absolute: "Page introuvable" } });
  });

  it("jetons du thème (globals.css), aucune couleur en dur", () => {
    expect(html).toContain("text-fg");
    expect(html).toContain("bg-ink-700");
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
