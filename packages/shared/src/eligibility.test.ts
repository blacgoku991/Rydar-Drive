import { describe, expect, it } from "vitest";
import { eligibilityMessage, eligibilitySchema, eligibilityVerdict, simulate, SIMULATOR } from "./eligibility";

describe("test d'éligibilité", () => {
  it("verdict : sans budget pub, pas encore ; 5 points ou plus, éligible ; sinon à étudier", () => {
    expect(eligibilityVerdict({ revenue: "gt7k", budget: "none", zone: "idf" }).verdict).toBe("not_yet");
    expect(eligibilityVerdict({ revenue: "4k-7k", budget: "300-800", zone: "metropole" })).toEqual({ score: 6, max: 9, verdict: "eligible" });
    expect(eligibilityVerdict({ revenue: "lt2k", budget: "150-300", zone: "rural" }).verdict).toBe("to_discuss");
    expect(eligibilityVerdict({ revenue: "2k-4k", budget: "150-300", zone: "idf" }).verdict).toBe("eligible");
  });

  it("validation : téléphone normalisé, e-mail en minuscules, consentement obligatoire", () => {
    const ok = eligibilitySchema.safeParse({
      revenue: "4k-7k", budget: "300-800", zone: "idf", name: "Karim B.", phone: "06 12 34 56 78", email: "Karim@Exemple.fr", consent: true, simBudget: 600,
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.phone).toBe("+33612345678");
      expect(ok.data.email).toBe("karim@exemple.fr");
      expect(eligibilityMessage(ok.data)).toContain("Île‑de‑France");
      expect(eligibilityMessage(ok.data)).toContain("600 €");
    }
    const ko = eligibilitySchema.safeParse({ revenue: "x", budget: "none", zone: "idf", name: "A", phone: "12", email: "pas-un-mail", consent: false });
    expect(ko.success).toBe(false);
    if (!ko.success) {
      const keys = ko.error.issues.map((i) => i.path[0]);
      for (const k of ["revenue", "name", "phone", "email", "consent"]) expect(keys).toContain(k);
    }
  });

  it("simulateur : 600 € de pub → 240 clics, 60 réservations, 3 420 €", () => {
    const s = simulate({ budget: 600 });
    expect(s.clicks).toBe(240);
    expect(s.bookings).toBe(60);
    expect(s.revenue).toBe(3420);
    expect(s.net).toBe(2820);
    expect(s.roi).toBeCloseTo(5.7, 5);
    // même montant sur les applis : course moyenne 18,50 €, commission 25 % → 13,875 € gardés par course
    expect(s.appRides).toBe(Math.ceil(2820 / (SIMULATOR.app.fare * 0.75)));
    expect(simulate({ budget: 0 })).toMatchObject({ clicks: 0, bookings: 0, revenue: 0, roi: 0, appRides: 0 });
  });
});

describe("sujet « eligibility » des demandes", () => {
  it("libellé dédié, jamais proposé dans le formulaire /contact", async () => {
    const { CONTACT_TOPICS, CONTACT_REQUEST_TOPICS, contactRequestTopicLabel } = await import("./contact-links");
    expect(CONTACT_REQUEST_TOPICS).toContain("eligibility");
    expect(CONTACT_TOPICS as readonly string[]).not.toContain("eligibility");
    expect(contactRequestTopicLabel("eligibility")).toBe("Test d’éligibilité Flotte Privée");
    expect(contactRequestTopicLabel("pricing")).toBe("Demande de tarif");
    expect(contactRequestTopicLabel("constructor")).toBe("Autre demande");
  });
});
