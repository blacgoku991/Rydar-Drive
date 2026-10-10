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

describe("vocabulaire des vues : « course » (flottes, centrales) ou « réservation » (Flotte Privée)", () => {
  it("aucun « course » écrit en dur dans les textes des vues : agendaNoun(noun) et summaryLabel(…, noun)", () => {
    expect(src).not.toMatch(/[Aa]ucune course/);
    expect(src).toContain('summaryLabel(c.summary, "EUR", noun)');
    expect(src).toContain('summaryLabel(d.summary, "EUR", noun)');
    expect((src.match(/agendaNoun\(noun\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("page : « réservation » en Flotte Privée seulement, passé à chaque vue et au modèle", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "..", "app", "dashboard", "agenda", "page.tsx"), "utf8");
    expect(page).toContain('const noun: AgendaNoun = privateFleet ? "booking" : "ride";');
    for (const use of ["monthCells(day, byDay, today, now, noun)", "weekColumns(day, byDay, today, now, noun)", "noun={noun}"]) expect(page).toContain(use);
  });
});
