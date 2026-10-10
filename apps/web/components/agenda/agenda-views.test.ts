import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vues de l'agenda (agenda-views.tsx, composants serveur) : les noms accessibles des liens des grilles du mois et de la
// semaine viennent du modèle (agenda-model.ts, testé dans agenda-model.test.ts). Test statique : chaque lien les porte
// (WCAG 2.4.4 — ni cellule de tableau, ni titre, ni élément de liste ne situe ces liens).

const src = readFileSync(join(import.meta.dirname, "agenda-views.tsx"), "utf8");

describe("liens des grilles du mois et de la semaine", () => {
  it("« +N » : nom accessible du modèle (« +2 autres courses, mercredi 14 octobre »), seulement avec un « +N »", () => {
    const start = src.indexOf("{c.moreLabel && (");
    expect(start).toBeGreaterThan(0);
    const link = src.slice(start, src.indexOf("+{c.more}", start));
    expect(link).toContain("aria-label={c.moreLabel}");
    expect(link).toContain('href={agendaHref("day", c.day)}');
  });

  it("courses : le jour dans le nom de chaque lien, au mois comme à la semaine", () => {
    expect(src).toContain("aria-label={entryAriaLabel(entry, day)}");
    const uses = [...src.matchAll(/<EntryLink\b[^>]*\/>/g)].map((m) => m[0]);
    expect(uses).toHaveLength(2);
    for (const use of uses) expect(use).toContain("day={c.title}");
  });
});
