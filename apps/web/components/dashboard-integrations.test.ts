import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_KEY_SCOPES } from "@rydar/shared";
import { describe, expect, it } from "vitest";

// Intégrations (tableau de bord) : les textes d'une clé « navigateur » disent ce que l'API lui permet
// (BROWSER_KEY_SCOPES : création de courses ET devis depuis la Flotte Privée) — recette L7 : ils disaient encore
// « création de courses uniquement ».

const src = readFileSync(join(import.meta.dirname, "dashboard-integrations.tsx"), "utf8");

describe("clé navigateur : textes conformes à BROWSER_KEY_SCOPES", () => {
  it("portées permises : création de courses et devis", () => {
    expect([...BROWSER_KEY_SCOPES]).toEqual(["rides:create", "rides:quote"]);
  });

  it("aucun texte ne réduit la clé navigateur à la seule création de courses", () => {
    expect(src).not.toMatch(/création de courses uniquement/);
    expect(src).not.toMatch(/ne peut que créer des courses \(/);
    expect(src).not.toMatch(/création de courses seule\b/);
  });

  it("aide des permissions et des origines : création de courses et devis", () => {
    expect(src).toContain("Clé utilisée depuis le navigateur : création de courses et devis uniquement.");
    expect(src).toContain("elle ne peut que créer des courses et demander des devis (prix et paiement fixés par votre grille)");
  });
});
