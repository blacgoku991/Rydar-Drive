import { describe, expect, it } from "vitest";
import { givenEndedAt, givenProgress, givenRowActions, givenToCheck, suspectText } from "./given";
import { givenItem } from "./test-fixtures";

// « Courses confiées » : boutons montrés selon le rôle (argent réseau = owner / admin ; « Relancer » = tout membre),
// le règlement et les délais. La base revérifie tout (assert_network_creditor, délais, statuts).

const END = Date.parse("2026-09-20T10:00:00.000Z");
const DAY = 86_400_000;
const owner = { canManage: true, now: END + DAY };
const dispatcher = { canManage: false, now: END + DAY };

const enabled = (a: ReturnType<typeof givenRowActions>) =>
  Object.entries(a)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();

describe("rôles", () => {
  it("dispatcher : lecture seule, sauf « Relancer » un chauffeur qui doit encore de l'argent", () => {
    expect(enabled(givenRowActions(givenItem({ payment: "cash" }), dispatcher))).toEqual(["remind"]);
    expect(enabled(givenRowActions(givenItem({ payment: "cash", settlement: "disputed" }), dispatcher))).toEqual(["remind"]);
    // Rien à relancer : versement au chauffeur, paiement déjà déclaré, réglé
    expect(enabled(givenRowActions(givenItem({ payment: "online" }), dispatcher))).toEqual([]);
    expect(enabled(givenRowActions(givenItem({ payment: "cash", settlement: "declared" }), dispatcher))).toEqual([]);
    expect(enabled(givenRowActions(givenItem({ payment: "cash", settlement: "paid" }), dispatcher))).toEqual([]);
  });

  it("owner / admin, course payée à bord : Reçu, Pas reçu, Annuler, Relancer, Contester, exclusions", () => {
    expect(enabled(givenRowActions(givenItem({ payment: "cash" }), owner))).toEqual(
      ["confirm", "contest", "dispute", "excludeDriver", "excludePartner", "remind", "waive"].sort(),
    );
  });

  it("owner / admin, course déjà payée : Versé (jamais Annuler : seule « Contester la course » annule un versement)", () => {
    const a = givenRowActions(givenItem({ payment: "online" }), owner);
    expect(a.payout).toBe(true);
    expect(a.waive).toBe(false);
    expect(a.confirm).toBe(false);
    expect(a.dispute).toBe(false);
  });
});

describe("course « à vérifier » et versement retenu", () => {
  it("versement retenu : « Valider » au lieu de « Versé »", () => {
    const a = givenRowActions(givenItem({ payment: "online", onHold: true, suspect: ["no_gps"] }), owner);
    expect(a.validate).toBe(true);
    expect(a.payout).toBe(false);
  });

  it("« à vérifier » : signalée, ni validée ni contestée (validated_at facultatif dans le contrat)", () => {
    expect(givenToCheck(givenItem({ suspect: ["too_fast"], payment: "cash" }))).toBe(false); // sans validated_at : retenue seule
    expect(givenToCheck(givenItem({ suspect: ["too_fast"], payment: "online", onHold: true }))).toBe(true);
    expect(givenToCheck(givenItem({ suspect: ["too_fast"], payment: "cash", validatedAt: null }))).toBe(true);
    expect(givenToCheck(givenItem({ suspect: ["too_fast"], payment: "cash", validatedAt: "2026-09-21T08:00:00.000Z" }))).toBe(false);
    expect(givenToCheck(givenItem({ suspect: ["too_fast"], payment: "online", onHold: true, contested: true }))).toBe(false);
    expect(givenToCheck(givenItem({ payment: "online", onHold: false }))).toBe(false);
    expect(suspectText(givenItem({ suspect: ["no_gps", "too_fast"] }))).toBe("Position absente pendant la course · Durée très inférieure à l'estimation");
  });

  it("contrôle relevé pendant la course (pas encore terminée) : jamais « à vérifier » ni « Valider » (la base refuse avant la fin)", () => {
    const enCours = givenItem({ status: "DRIVER_ARRIVED", suspect: ["far_from_pickup"], validatedAt: null, settlement: null });
    expect(enCours.execution.end_reason).toBeNull();
    expect(givenToCheck(enCours)).toBe(false);
    expect(givenRowActions(enCours, owner).validate).toBe(false);
    // Course retirée au partenaire avec un contrôle relevé : pas davantage
    const retiree = givenItem({ status: "SEARCHING_DRIVER", suspect: ["no_gps"], validatedAt: null, settlement: null,
      endedAt: "2026-09-20T09:40:00.000Z", endReason: "removed_by_giver" });
    expect(givenToCheck(retiree)).toBe(false);
  });

  it("« Valider » proposé pour une course payée à bord signalée, si la base dit qu'elle n'est pas validée", () => {
    expect(givenRowActions(givenItem({ suspect: ["far_from_dropoff"], validatedAt: null }), owner).validate).toBe(true);
    expect(givenRowActions(givenItem({ suspect: ["far_from_dropoff"] }), owner).validate).toBe(false);
  });
});

describe("délais et états", () => {
  it("« Contester la course » : course terminée, dans les 7 jours, une seule fois", () => {
    expect(givenRowActions(givenItem(), { canManage: true, now: END + 7 * DAY - 1 }).contest).toBe(true);
    expect(givenRowActions(givenItem(), { canManage: true, now: END + 7 * DAY + 60_000 }).contest).toBe(false);
    expect(givenRowActions(givenItem({ contested: true }), owner).contest).toBe(false);
    expect(givenRowActions(givenItem({ status: "IN_PROGRESS" }), owner).contest).toBe(false);
    expect(givenEndedAt(givenItem())).toBe("2026-09-20T10:00:00.000Z");
  });

  it("« Rouvrir » après un règlement soldé ou annulé (pas après une contestation)", () => {
    expect(givenRowActions(givenItem({ settlement: "paid" }), owner).reopen).toBe(true);
    expect(givenRowActions(givenItem({ settlement: "waived" }), owner).reopen).toBe(true);
    expect(givenRowActions(givenItem({ settlement: "waived", contested: true }), owner).reopen).toBe(false);
    expect(givenRowActions(givenItem({ settlement: "due" }), owner).reopen).toBe(false);
  });

  it("exclusions masquées quand elles sont déjà posées", () => {
    expect(givenRowActions(givenItem({ driverExcluded: true }), owner).excludeDriver).toBe(false);
    expect(givenRowActions(givenItem(), { ...owner, partnerExcluded: true }).excludePartner).toBe(false);
  });

  it("sans règlement : étape de la course, fin d'exécution ou « Terminée »", () => {
    expect(givenProgress(givenItem({ status: "DRIVER_EN_ROUTE" }))).toEqual({ label: "En route", tone: "blue" });
    expect(givenProgress(givenItem({ status: "SEARCHING_DRIVER", endedAt: "2026-09-20T09:40:00.000Z", endReason: "executor_released", settlement: null }))).toEqual({
      label: "Retirée par l'organisation du chauffeur",
      tone: "neutral",
    });
    expect(givenProgress(givenItem({ settlement: null }))).toEqual({ label: "Terminée", tone: "green" });
    expect(givenProgress(givenItem())).toBeNull();
  });
});
