import { describe, expect, it } from "vitest";
import { isPlatformFeesPath, platformFeesPaths } from "./org-platform-paths";

describe("platformFeesPaths : où régler les frais Rydar selon le modèle", () => {
  it("centrale : carte d'Encaissements ; flotte : entrée « Frais Rydar »", () => {
    expect(platformFeesPaths("centrale")).toEqual({
      account: "/dashboard/settlements#frais-plateforme",
      page: "/dashboard/settlements",
      statement: "/dashboard/settlements/rydar",
      back: "Encaissements",
      label: "Frais plateforme",
    });
    expect(platformFeesPaths("fleet")).toEqual({
      account: "/dashboard/rydar",
      page: "/dashboard/rydar",
      statement: "/dashboard/rydar/releve",
      back: "Frais Rydar",
      label: "Frais Rydar",
    });
    // Modèle inconnu (ancienne session) : flotte, le modèle par défaut
    expect(platformFeesPaths(undefined).page).toBe("/dashboard/rydar");
  });

  it("pages relues à chaque mise à jour des frais", () => {
    expect(isPlatformFeesPath("/dashboard/settlements")).toBe(true);
    expect(isPlatformFeesPath("/dashboard/settlements/rydar")).toBe(true);
    expect(isPlatformFeesPath("/dashboard/rydar")).toBe(true);
    expect(isPlatformFeesPath("/dashboard/rydar/releve")).toBe(true);
    expect(isPlatformFeesPath("/dashboard/rydarx")).toBe(false);
    expect(isPlatformFeesPath("/dashboard/rides")).toBe(false);
  });
});
