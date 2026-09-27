import { describe, expect, it } from "vitest";
import { statsPeriodStart, zonedDay } from "./stats-period";

const PARIS = "Europe/Paris";

describe("période des statistiques (fuseau de la centrale)", () => {
  // 01/10/2026 00:30 à Paris = 30/09/2026 22:30 UTC : le serveur (UTC) est encore en septembre
  const justAfterMidnight = new Date("2026-09-30T22:30:00Z");

  it("jour civil dans le fuseau, pas celui du serveur", () => {
    expect(zonedDay(justAfterMidnight, PARIS)).toBe("2026-10-01");
    expect(zonedDay(justAfterMidnight, "UTC")).toBe("2026-09-30");
  });

  it("« Mois en cours » commence le 1er à minuit, heure de Paris", () => {
    expect(statsPeriodStart(justAfterMidnight, "mtd", PARIS).toISOString()).toBe("2026-09-30T22:00:00.000Z");
    // En hiver (UTC+1)
    expect(statsPeriodStart(new Date("2026-12-15T12:00:00Z"), "mtd", PARIS).toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });

  it("« 7 derniers jours » = 7 jours civils, aujourd'hui compris, depuis minuit heure de Paris", () => {
    expect(statsPeriodStart(justAfterMidnight, 7, PARIS).toISOString()).toBe("2026-09-24T22:00:00.000Z");
    expect(statsPeriodStart(new Date("2026-09-15T10:00:00Z"), 7, PARIS).toISOString()).toBe("2026-09-08T22:00:00.000Z");
  });

  it("traverse le changement d'heure (minuit local de chaque côté)", () => {
    // 30 derniers jours au 10/11/2026 : départ le 12/10 (heure d'été, UTC+2)
    expect(statsPeriodStart(new Date("2026-11-10T12:00:00Z"), 30, PARIS).toISOString()).toBe("2026-10-11T22:00:00.000Z");
    // 90 jours au 15/01/2027 : départ le 18/10/2026
    expect(statsPeriodStart(new Date("2027-01-15T12:00:00Z"), 90, PARIS).toISOString()).toBe("2026-10-17T22:00:00.000Z");
  });

  it("autre fuseau (centrale hors de France)", () => {
    expect(statsPeriodStart(new Date("2026-09-15T10:00:00Z"), 1, "America/Martinique").toISOString()).toBe("2026-09-15T04:00:00.000Z");
  });
});
