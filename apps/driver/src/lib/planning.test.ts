// Enchaînement (audit flux-course#5) : l'instantanée attribuée pendant une course apparaît dans le Planning.
import { describe, expect, it } from "vitest";
import { myRides, overdue, overdueHint, waitsForCurrentRide } from "./planning";

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

describe("overdue", () => {
  // 30/09/2026 12:34 à Paris (UTC+2)
  const now = Date.parse("2026-09-30T10:34:00Z");
  const planned = (pickup: string, status = "ACCEPTED", type: "scheduled" | "instant" = "scheduled") =>
    ({ type, status, pickup_at: pickup }) as Parameters<typeof overdue>[0];

  it("planifiée acceptée, heure passée : en retard, clôture automatique 6 h après l'heure prévue", () => {
    const o = overdue(planned("2026-09-30T08:00:00Z"), now);
    expect(o).toEqual({ expiresAt: new Date("2026-09-30T14:00:00Z"), expired: false });
    expect(overdueHint(o!, "Europe/Paris", new Date(now))).toBe("Sans démarrage, clôture automatique aujourd'hui 16:00.");
  });

  it("délai écoulé (serveur pas encore passé) : clôture en cours", () => {
    const o = overdue(planned("2026-09-29T04:30:00Z"), now);
    expect(o?.expired).toBe(true);
    expect(overdueHint(o!, "Europe/Paris", new Date(now))).toBe("Course non démarrée\u00A0: clôture automatique en cours.");
  });

  it("à venir, démarrée, instantanée ou close : pas en retard", () => {
    expect(overdue(planned("2026-09-30T11:00:00Z"), now)).toBeNull();
    expect(overdue(planned("2026-09-30T08:00:00Z", "DRIVER_EN_ROUTE"), now)).toBeNull();
    expect(overdue(planned("2026-09-30T08:00:00Z", "ACCEPTED", "instant"), now)).toBeNull();
    expect(overdue(planned("2026-09-29T08:00:00Z", "CANCELLED"), now)).toBeNull();
  });
});
