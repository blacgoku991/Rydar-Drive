import type { PlatformEntry, PlatformStatement } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { feeTermsText, rideSettlementText, showSettlementColumn } from "./org-platform-format";

type Ride = NonNullable<PlatformEntry["ride"]>;
const ride = (over: Partial<Ride> = {}): Ride => ({
  id: "r1", number: 1001, price_cents: 5000, payment_method: "cash", completed_at: null, pickup: null, dropoff: null, settlement_status: null, ...over,
});
const statement = (model: "fleet" | "centrale" | undefined, rides: Ride[]) =>
  ({
    organization: { id: "o", name: "O", currency: "EUR", timezone: "Europe/Paris", reference: "RYD-O", dispatch_model: model },
    entries: rides.map((r, i) => ({ id: `e${i}`, ride: r }) as PlatformEntry),
  }) as Pick<PlatformStatement, "organization" | "entries">;

describe("frais Rydar d'une flotte : relevé et libellés", () => {
  it("course de flotte : « Course de la flotte », jamais « commission »", () => {
    expect(rideSettlementText(ride({ fleet_fee: { percent: 0, fixed_cents: 200 } }))).toEqual({ text: "Course de la flotte", tone: "neutral" });
    // Course passée par le mode centrale (règlement chauffeur) : statut du règlement, comme avant
    expect(rideSettlementText(ride({ fleet_fee: null, settlement_status: "paid" }))?.text).toBe("Commission encaissée");
    expect(rideSettlementText(ride({ settlement_status: null }))?.text).toBe("Commission : aucun règlement");
    expect(rideSettlementText(null)).toBeNull();
  });

  it("colonne « Règlement chauffeur » : centrale toujours, flotte seulement avec un règlement", () => {
    const fleetRide = ride({ fleet_fee: { percent: 0, fixed_cents: 200 } });
    expect(showSettlementColumn(statement("fleet", [fleetRide]))).toBe(false);
    expect(showSettlementColumn(statement("fleet", [fleetRide, ride({ settlement_status: "paid" })]))).toBe(true);
    expect(showSettlementColumn(statement("centrale", [fleetRide]))).toBe(true);
    // Ancienne réponse sans modèle : comportement centrale inchangé
    expect(showSettlementColumn(statement(undefined, []))).toBe(true);
  });

  it("conditions affichées : % du prix et / ou fixe par course", () => {
    expect(feeTermsText({ fee_percent: 0, fee_fixed_cents: 200, currency: "EUR" })).toMatch(/^2\s€ par course terminée$/);
    expect(feeTermsText({ fee_percent: 2.5, fee_fixed_cents: 0, currency: "EUR" })).toMatch(/^2,5\s% du prix de chaque course terminée$/);
    expect(feeTermsText({ fee_percent: 0, fee_fixed_cents: 0, currency: "EUR" })).toBe("aucuns frais par course pour l'instant");
  });
});
