import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://api.rydar.example", appUrl: "https://app.rydar.example" } }));
const { platformImageUrl } = await import("./public-image");

// Revue de conformité (cookies, tiers) : une image d'une centrale n'est chargée sur une page publique que si la
// plateforme la sert elle-même, jamais chez un tiers (adresse IP du visiteur, cookies d'un tiers).
describe("platformImageUrl", () => {
  it("stockage public de l'installation ou domaine de l'application : affichée", () => {
    expect(platformImageUrl("https://api.rydar.example/storage/v1/object/public/logos/a.png")).toBe(
      "https://api.rydar.example/storage/v1/object/public/logos/a.png",
    );
    expect(platformImageUrl("https://app.rydar.example/logo.png")).toBe("https://app.rydar.example/logo.png");
  });

  it("autre site, stockage privé, adresse invalide ou autre protocole : jamais chargée", () => {
    for (const url of [
      "https://cdn.tiers.example/logo.png",
      "https://api.rydar.example/storage/v1/object/sign/logos/a.png",
      "https://api.rydar.example/rest/v1/organizations",
      "https://app.rydar.example.tiers.example/logo.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "pas une adresse",
      "",
      null,
    ]) {
      expect(platformImageUrl(url), String(url)).toBeNull();
    }
  });
});
