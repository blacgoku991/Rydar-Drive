// Enchaînement (audit flux-course#5) : l'instantanée attribuée pendant une course apparaît dans le Planning.
import { describe, expect, it } from "vitest";
import { myRides, waitsForCurrentRide } from "./planning";

type R = Parameters<typeof myRides>[0][number];
const ride = (id: string, type: "instant" | "scheduled", status: string, driverId = "moi") =>
  ({ id, type, status, driver_id: driverId }) as R;

describe("myRides", () => {
  it("planifiées attribuées (à venir ou en cours) et instantanées attribuées pas encore démarrées", () => {
    const list = [
      ride("en-cours", "instant", "IN_PROGRESS"),
      ride("suivante", "instant", "ACCEPTED"),
      ride("demain", "scheduled", "ACCEPTED"),
      ride("planifiee-en-route", "scheduled", "DRIVER_EN_ROUTE"),
    ];
    expect(myRides(list, "moi").map((r) => r.id)).toEqual(["suivante", "demain", "planifiee-en-route"]);
  });

  it("seulement les courses du chauffeur (gérant qui roule : il lit toutes celles de sa centrale)", () => {
    const list = [ride("autre-instant", "instant", "ACCEPTED", "autre"), ride("autre-planifiee", "scheduled", "ACCEPTED", "autre")];
    expect(myRides(list, "moi")).toEqual([]);
  });
});

describe("waitsForCurrentRide", () => {
  it("instantanée attribuée pendant une autre course : à démarrer après", () => {
    expect(waitsForCurrentRide(ride("suivante", "instant", "ACCEPTED"), "en-cours")).toBe(true);
  });

  it("course en cours elle-même, planifiée, ou aucune course en cours : non", () => {
    expect(waitsForCurrentRide(ride("suivante", "instant", "ACCEPTED"), "suivante")).toBe(false);
    expect(waitsForCurrentRide(ride("demain", "scheduled", "ACCEPTED"), "en-cours")).toBe(false);
    expect(waitsForCurrentRide(ride("suivante", "instant", "ACCEPTED"), null)).toBe(false);
  });
});
