import { describe, expect, it } from "vitest";
import { minutesLabel, nearestChoice, secondsLabel } from "./private-booking";

// Réglages › Réservations de la Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : libellés des délais proposés.

describe("délais proposés", () => {
  it("minutes : « 30 min », puis en heures", () => {
    expect(minutesLabel(30)).toBe("30\u00a0min");
    expect(minutesLabel(60)).toBe("1\u00a0h");
    expect(minutesLabel(120)).toBe("2\u00a0h");
    expect(minutesLabel(1440)).toBe("24\u00a0h");
  });

  it("secondes : « 1 min », « 1 min 30 », « 5 min »", () => {
    expect(secondsLabel(60)).toBe("1\u00a0min");
    expect(secondsLabel(90)).toBe("1\u00a0min\u00a030");
    expect(secondsLabel(65)).toBe("1\u00a0min\u00a005");
    expect(secondsLabel(300)).toBe("5\u00a0min");
  });

  it("valeur hors des choix : le plus proche (le premier à égalité)", () => {
    const choices = [15, 30, 60, 120];
    expect(nearestChoice(30, choices)).toBe(30);
    expect(nearestChoice(40, choices)).toBe(30);
    expect(nearestChoice(50, choices)).toBe(60);
    expect(nearestChoice(45, choices)).toBe(30);
    expect(nearestChoice(5, choices)).toBe(15);
    expect(nearestChoice(1000, choices)).toBe(120);
  });
});
