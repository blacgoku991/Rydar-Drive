import { describe, expect, it } from "vitest";
import tsupConfig from "../tsup.config";
import { simulatorRefusal } from "./simulator-guard";

describe("worker — simulateur de flotte hors production", () => {
  it("refusé quand NODE_ENV=production (image du worker)", () => {
    expect(simulatorRefusal({ NODE_ENV: "production", SIM_ORG: "centrale-reelle" })).toMatch(/interdit en production/);
    expect(simulatorRefusal({ NODE_ENV: "production", SIM_ALLOW_PRODUCTION: "true" })).toMatch(/interdit en production/);
  });
  it("permis en développement, ou en recette sur demande explicite", () => {
    expect(simulatorRefusal({})).toBeNull();
    expect(simulatorRefusal({ NODE_ENV: "development" })).toBeNull();
    expect(simulatorRefusal({ NODE_ENV: "production", SIM_ALLOW_PRODUCTION: "1" })).toBeNull();
  });
  it("n'est pas construit dans dist/ (donc absent de l'image Docker)", () => {
    const entry = (tsupConfig as { entry: string[] }).entry;
    expect(entry).toContain("src/index.ts");
    expect(entry).not.toContain("src/simulator.ts");
  });
});
