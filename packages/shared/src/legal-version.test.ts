import { describe, expect, it } from "vitest";
import { LEGAL_VERSION, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, legalAcceptanceState } from "./features";

const realDate = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

// accept_legal_documents (20260924004300) refuse une version hors format AAAA-MM-JJ ou postérieure au lendemain
// (heure de Paris) : une version future rendrait l'acceptation impossible (bandeaux web, écran de l'app).
describe.each([
  ["LEGAL_VERSION (CGU + politique de confidentialité)", LEGAL_VERSION],
  ["ORG_LEGAL_VERSION (CGV + accord de traitement)", ORG_LEGAL_VERSION],
])("%s", (_name, version) => {
  it("date AAAA-MM-JJ réelle, jamais dans le futur", () => {
    expect(realDate(version)).toBe(true);
    const tomorrowParis = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + 86_400_000));
    expect(version <= tomorrowParis).toBe(true);
  });
});

describe("versions séparées (CGV du 2 octobre 2026)", () => {
  it("CGU + politique de confidentialité inchangées : aucun chauffeur ni dispatcher n'a rien à ré-accepter", () => {
    // Changer LEGAL_VERSION = nouvel écran d'acceptation pour CHAQUE chauffeur, après une mise à jour à distance de
    // l'app qui embarque la valeur (docs/STORES.md § 10), et nouveau bandeau pour chaque membre du tableau de bord.
    expect(LEGAL_VERSION).toBe("2026-09-27");
    expect(legalAcceptanceState(["2026-09-27"], LEGAL_VERSION)).toBe("accepted");
  });

  it("CGV + accord de traitement : une organisation qui avait accepté le 27/09 voit une mise à jour", () => {
    expect(legalAcceptanceState(["2026-09-27"], ORG_LEGAL_VERSION)).toBe("updated");
    expect(legalAcceptanceState([], ORG_LEGAL_VERSION)).toBe("pending");
    expect(legalAcceptanceState(["2026-09-27", ORG_LEGAL_VERSION], ORG_LEGAL_VERSION)).toBe("accepted");
  });

  it("entrée en vigueur pour une organisation déjà cliente : date réelle, au moins 30 jours après la version", () => {
    // CGV art. 16 : modification défavorable annoncée au moins 30 jours à l'avance (à revoir avec chaque version)
    expect(realDate(ORG_LEGAL_EFFECTIVE_AT)).toBe(true);
    expect(ORG_LEGAL_EFFECTIVE_AT).toBe("2026-11-05");
    expect(day(ORG_LEGAL_EFFECTIVE_AT) - day(ORG_LEGAL_VERSION)).toBeGreaterThanOrEqual(30);
  });
});
