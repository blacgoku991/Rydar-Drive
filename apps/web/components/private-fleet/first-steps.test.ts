import { describe, expect, it } from "vitest";
import { firstSteps, pendingFirstSteps, type FirstStepsInput } from "./first-steps";

// « Premiers pas » de l'Accueil (docs/FLOTTE-PRIVEE.md § 7.3) : liste calculée à chaque affichage, sans stockage,
// masquée une fois complète.

const done: FirstStepsInput = {
  org: { legal_name: "Taxi Karim SASU", siret: "12345678900012", vtc_registration: "EVTC075230001" },
  activePricingRules: 1,
  vtcCardValid: true,
  insuranceValid: true,
  appSeenAt: "2026-10-19T18:00:00Z",
  siteKeyActive: true,
  siteBookings: 1,
};

const doneKeys = (i: FirstStepsInput) => firstSteps(i).filter((s) => s.done).map((s) => s.key);

describe("premiers pas", () => {
  it("cinq étapes, dans l'ordre, avec leur lien (l'application n'en a pas)", () => {
    expect(firstSteps(done).map((s) => [s.key, s.label, s.href])).toEqual([
      ["company", "Entreprise complète", "/dashboard/settings?tab=org"],
      ["pricing", "Tarifs actifs", "/dashboard/settings?tab=pricing"],
      ["documents", "Carte VTC et assurance valides", "/dashboard/profil"],
      ["app", "Application utilisée", null],
      ["site", "Site relié", "/dashboard/site"],
    ]);
  });

  it("tout est fait : la carte disparaît", () => {
    expect(pendingFirstSteps(done)).toBeNull();
  });

  it("une étape manquante : la liste entière reste, l'étape non cochée", () => {
    const steps = pendingFirstSteps({ ...done, appSeenAt: null });
    expect(steps).toHaveLength(5);
    expect(steps!.filter((s) => !s.done).map((s) => s.key)).toEqual(["app"]);
  });

  it("entreprise : raison sociale, SIRET et n° VTC renseignés (espaces seuls refusés)", () => {
    expect(doneKeys({ ...done, org: { ...done.org!, siret: "   " } })).not.toContain("company");
    expect(doneKeys({ ...done, org: { ...done.org!, vtc_registration: null } })).not.toContain("company");
    expect(doneKeys({ ...done, org: null })).not.toContain("company");
  });

  it("tarifs actifs, carte VTC ET assurance, clé du site active ET première réservation reçue", () => {
    expect(doneKeys({ ...done, activePricingRules: 0 })).not.toContain("pricing");
    expect(doneKeys({ ...done, insuranceValid: false })).not.toContain("documents");
    expect(doneKeys({ ...done, vtcCardValid: false })).not.toContain("documents");
    expect(doneKeys({ ...done, siteBookings: 0 })).not.toContain("site");
    expect(doneKeys({ ...done, siteKeyActive: false })).not.toContain("site");
  });
});
