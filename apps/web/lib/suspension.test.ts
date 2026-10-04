import { describe, expect, it } from "vitest";
import { suspensionReason } from "./suspension";

// Suspension d'une centrale (CGV, article 7) : fondement et motif obligatoires, mise en demeure de 8 jours au moins.

const NOW = new Date("2026-10-04T10:00:00Z");

describe("suspensionReason", () => {
  it("motif trop court ou absent : refus", () => {
    expect(suspensionReason("", { kind: "urgent" }, NOW).ok).toBe(false);
    expect(suspensionReason("Impayé", { kind: "urgent" }, NOW).ok).toBe(false);
  });

  it("fondement absent : refus", () => {
    expect(suspensionReason("Frais impayés depuis trois mois", null, NOW)).toMatchObject({ ok: false });
  });

  it("mise en demeure : date obligatoire, 8 jours au moins avant la suspension", () => {
    expect(suspensionReason("Frais impayés depuis trois mois", { kind: "notice" }, NOW)).toMatchObject({ ok: false });
    expect(suspensionReason("Frais impayés depuis trois mois", { kind: "notice", noticeDate: "2026-09-30" }, NOW)).toMatchObject({ ok: false });
    expect(suspensionReason("Frais impayés depuis trois mois", { kind: "notice", noticeDate: "2026-11-01" }, NOW)).toMatchObject({ ok: false });
    expect(suspensionReason("Frais impayés depuis trois mois", { kind: "notice", noticeDate: "2026-09-26" }, NOW)).toEqual({
      ok: true,
      text: "Mise en demeure du 26/09/2026 restée sans effet. Frais impayés depuis trois mois",
    });
  });

  it("urgence et demande de la centrale : fondement repris en tête du motif", () => {
    expect(suspensionReason("  Faux documents   déposés ", { kind: "urgent" }, NOW)).toEqual({ ok: true, text: "Suspension d'urgence. Faux documents déposés" });
    expect(suspensionReason("Pause pendant les travaux", { kind: "request" }, NOW)).toEqual({
      ok: true,
      text: "Suspension à la demande de la centrale. Pause pendant les travaux",
    });
  });

  it("texte borné à 500 caractères (colonne et journal d'audit)", () => {
    const res = suspensionReason("x".repeat(600), { kind: "urgent" }, NOW);
    expect(res.ok && res.text.length).toBe(500);
  });
});
