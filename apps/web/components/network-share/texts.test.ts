import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NETWORK_FORBIDDEN_WORDS } from "@rydar/shared";
import { describe, expect, it } from "vitest";

// Vocabulaire du réseau partagé (spec §7.1) : Rydar est un logiciel de dispatch. Aucun des mots interdits dans les
// écrans de l'onglet, ses actions et son export. Couleur « réseau » = jeton violet, jamais de couleur en dur.

const ROOTS = [join(__dirname), join(__dirname, "../../app/dashboard/reseau-partage")];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

const sources = ROOTS.flatMap(files).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("textes de l'onglet « Réseau partagé »", () => {
  it("tous les fichiers sont lus", () => {
    expect(sources.some((s) => s.path.endsWith("settings-view.tsx"))).toBe(true);
    expect(sources.some((s) => s.path.endsWith("actions.ts"))).toBe(true);
    expect(sources.some((s) => s.path.endsWith("route.ts"))).toBe(true);
  });

  it("aucun mot interdit (mise en relation, intermédiaire, place de marché, marketplace)", () => {
    for (const { path, text } of sources) {
      const lower = text.toLowerCase();
      for (const word of NETWORK_FORBIDDEN_WORDS) expect(lower.includes(word), `${word} dans ${path}`).toBe(false);
    }
  });

  it("aucune couleur en dur : jetons du thème seulement", () => {
    for (const { path, text } of sources) expect(/#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i.test(text), path).toBe(false);
  });

  it("liens du tableau de bord sans préchargement", () => {
    for (const { path, text } of sources) {
      const links = text.match(/<Link\b[^>]*>/g) ?? [];
      for (const tag of links) expect(tag.includes("prefetch={false}"), `${path} : ${tag}`).toBe(true);
    }
  });
});
