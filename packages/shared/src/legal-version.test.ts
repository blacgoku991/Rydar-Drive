import { describe, expect, it } from "vitest";
import { LEGAL_VERSION } from "./features";

// accept_legal_documents (20260924004300) refuse une version hors format AAAA-MM-JJ ou postérieure au lendemain
// (heure de Paris) : une LEGAL_VERSION future rendrait l'acceptation impossible (bandeaux web, écran de l'app).
describe("LEGAL_VERSION", () => {
  it("date AAAA-MM-JJ réelle, jamais dans le futur", () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${LEGAL_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(LEGAL_VERSION);
    const tomorrowParis = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + 86_400_000));
    expect(LEGAL_VERSION <= tomorrowParis).toBe(true);
  });
});
