import { describe, expect, it } from "vitest";
import { feeChangePlan, type FeePlanInput } from "./fee-change-plan";

// Aperçu du réglage des frais par course (super admin) : miroir de svc_platform_set_fees, qui reste seul juge.
const base: FeePlanInput = {
  current: { percent: 0, fixedCents: 0 },
  next: { percent: 0, fixedCents: 200 },
  schedule: { min_effective_on: "2026-11-06", min_reason: "terms_effective", scheduled: null },
  mode: "notice",
  effectiveOn: "",
  maxEffectiveOn: "2027-10-04",
};

describe("réglage des frais par course : ce que fera l'enregistrement", () => {
  it("hausse sans date choisie : date proposée affichée, aucune envoyée (la base prend la plus proche permise)", () => {
    const plan = feeChangePlan(base);
    expect(plan).toMatchObject({
      kind: "increase", sendRates: true, min: "2026-11-06", reason: "terms_effective", defaultOn: "2026-11-06", displayOn: "2026-11-06", sendOn: null,
      dateError: null, sameAsScheduled: false, replacesScheduled: false,
    });
  });

  it("date choisie : envoyée ; trop proche ou à plus d'un an : erreur avant l'envoi", () => {
    expect(feeChangePlan({ ...base, effectiveOn: "2026-12-01" })).toMatchObject({ displayOn: "2026-12-01", sendOn: "2026-12-01", dateError: null });
    expect(feeChangePlan({ ...base, effectiveOn: "2026-11-05" }).dateError).toBe(
      "Au plus tôt le 06/11/2026 (entrée en vigueur des CGV, pas encore acceptées par l'organisation), sauf accord écrit de l'organisation.",
    );
    expect(feeChangePlan({ ...base, effectiveOn: "2027-10-05" }).dateError).toBe("Un an au plus : le 04/10/2027 au plus tard.");
    expect(feeChangePlan({ ...base, effectiveOn: "05/11/2026" }).dateError).toBe("Date invalide.");
  });

  it("accord écrit : ni date ni erreur de date ; remplace l'annonce en cours", () => {
    const scheduled = { percent: 0, fixed_cents: 150, effective_on: "2026-11-10" };
    expect(feeChangePlan({ ...base, mode: "consent", effectiveOn: "2026-10-04", schedule: { ...base.schedule!, scheduled } })).toMatchObject({
      kind: "increase", displayOn: null, sendOn: null, dateError: null, replacesScheduled: true,
    });
  });

  it("annonce en cours : même hausse et même date = rien ne change ; hausse moindre = date annoncée gardée", () => {
    const schedule = { min_effective_on: "2026-11-06", min_reason: "notice_30_days" as const, scheduled: { percent: 0, fixed_cents: 200, effective_on: "2026-11-03" } };
    expect(feeChangePlan({ ...base, schedule })).toMatchObject({
      min: "2026-11-03", reason: "already_announced", displayOn: "2026-11-03", sameAsScheduled: true, replacesScheduled: false,
    });
    expect(feeChangePlan({ ...base, schedule, next: { percent: 0, fixedCents: 150 } })).toMatchObject({
      displayOn: "2026-11-03", sameAsScheduled: false, replacesScheduled: true, dateError: null,
    });
    // Hausse plus forte : nouveau préavis
    expect(feeChangePlan({ ...base, schedule, next: { percent: 0, fixedCents: 250 } })).toMatchObject({ min: "2026-11-06", displayOn: "2026-11-06", replacesScheduled: true });
    // Même hausse à une autre date : nouvelle annonce
    expect(feeChangePlan({ ...base, schedule, effectiveOn: "2026-12-01" })).toMatchObject({ sameAsScheduled: false, replacesScheduled: true, sendOn: "2026-12-01" });
  });

  it("baisse : tout de suite, l'annonce en cours est remplacée ; taux inchangés : modèle seul", () => {
    const schedule = { ...base.schedule!, scheduled: { percent: 0, fixed_cents: 300, effective_on: "2026-11-10" } };
    expect(feeChangePlan({ ...base, current: { percent: 0, fixedCents: 200 }, next: { percent: 0, fixedCents: 100 }, schedule })).toMatchObject({
      kind: "decrease", sendRates: true, displayOn: null, replacesScheduled: true,
    });
    expect(feeChangePlan({ ...base, current: { percent: 1.15, fixedCents: 200 }, next: { percent: 1.15, fixedCents: 200 }, schedule })).toMatchObject({
      kind: "unchanged", sendRates: false, replacesScheduled: false,
    });
    // Saisie illisible : rien n'est envoyé
    expect(feeChangePlan({ ...base, next: null })).toMatchObject({ kind: "unchanged", sendRates: false });
  });

  it("lecture du calendrier impossible : hausse envoyée sans date, la base calcule", () => {
    expect(feeChangePlan({ ...base, schedule: null })).toMatchObject({ kind: "increase", min: null, displayOn: null, sendOn: null, dateError: null });
  });
});
