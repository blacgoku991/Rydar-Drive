import { describe, expect, it } from "vitest";
import { dayInZone, foreignZoneName, zonedInstant } from "./zoned-time";

// Heure saisie sur le mini-site et dans « Nouvelle course » : fuseau de la centrale, pas celui du navigateur
// (audit robustesse-web#0). Le résultat ne dépend pas du fuseau du processus (TZ).

describe("heure saisie dans le fuseau de la centrale", () => {
  it("08:00 saisi = 08:00 à Paris, quel que soit le fuseau du navigateur", () => {
    expect(zonedInstant("2026-10-01", "08:00", "Europe/Paris")?.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(zonedInstant("2026-12-01", "08:00", "Europe/Paris")?.toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(zonedInstant("2026-10-01", "23:00", "Indian/Reunion")?.toISOString()).toBe("2026-10-01T19:00:00.000Z");
  });

  it("saisie incomplète ou fuseau inconnu : null (jamais d'exception au rendu)", () => {
    expect(zonedInstant("", "08:00", "Europe/Paris")).toBeNull();
    expect(zonedInstant("2026-10-01", "", "Europe/Paris")).toBeNull();
    expect(zonedInstant("2026-10-01", "08:00", "Pas/Un_Fuseau")).toBeNull();
  });

  it("jour par défaut calculé dans le fuseau de la centrale", () => {
    // 23:30 UTC le 30 septembre = déjà le 1er octobre à Paris
    expect(dayInZone(new Date("2026-09-30T23:30:00Z"), "Europe/Paris")).toBe("2026-10-01");
    expect(dayInZone(new Date("2026-09-30T23:30:00Z"), "America/New_York")).toBe("2026-09-30");
  });

  it("indication du fuseau seulement si le navigateur est ailleurs", () => {
    expect(foreignZoneName("Europe/Paris", "Europe/Paris")).toBeNull();
    expect(foreignZoneName("Europe/Paris", "America/New_York")).toMatch(/Europe centrale/);
  });
});
