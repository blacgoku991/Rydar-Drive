import type { PlatformEntry, PlatformStatement } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { feeTermsText, frSpaces, rideSettlementText, scheduledFeeChangeText, showSettlementColumn } from "./org-platform-format";

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

describe("hausse des frais par course annoncée (encart « Frais Rydar » / « Encaissements », bandeau, alerte)", () => {
  const account = {
    fee_percent: 0,
    fee_fixed_cents: 0,
    currency: "EUR",
    scheduled_change: {
      id: "c1", percent: 0, fixed_cents: 200, from_percent: 0, from_fixed_cents: 0,
      effective_at: "2026-11-04T23:00:00Z", effective_on: "2026-11-05", announced_at: "2026-10-03T08:00:00Z",
    },
  };
  const nb = (t: string) => t.replace(/\u00a0/g, " ").replace(/\u202f/g, " ");

  it("« À partir du JJ/MM/AAAA : … par course » avec les frais actuels et la date de l'annonce", () => {
    const t = scheduledFeeChangeText(account, "fleet", "Europe/Paris")!;
    expect(t.title).toBe("Vos frais par course changent le 05/11/2026");
    expect(nb(t.next)).toBe("À partir du 05/11/2026 : 2 € par course terminée (actuellement : aucuns frais par course).");
    expect(nb(t.body)).toContain("Annoncé le 03/10/2026, au moins 30 jours à l'avance : si vous ne l'acceptez pas, vous pouvez résilier sans frais avant cette date.");
    // Espaces insécables avant les deux-points
    expect(t.next).toContain("05/11/2026\u00a0: 2");
    expect(scheduledFeeChangeText({ ...account, scheduled_change: null }, "fleet")).toBeNull();
  });

  it("hausse annoncée remplacée par une hausse moindre à la date déjà annoncée : jamais « au moins 30 jours » si c'est faux", () => {
    // Annonce du 20/10 pour le 05/11 (16 jours) : seulement possible en remplacement d'une hausse plus forte déjà annoncée
    const replaced = { ...account, scheduled_change: { ...account.scheduled_change, announced_at: "2026-10-20T08:00:00Z" } };
    const body = nb(scheduledFeeChangeText(replaced, "fleet", "Europe/Paris")!.body);
    expect(body).not.toContain("au moins 30 jours");
    expect(body).toContain("Annoncé le 20/10/2026, en remplacement d'une annonce précédente (frais moins élevés ou date plus tardive) : si vous ne l'acceptez pas, vous pouvez résilier sans frais avant cette date.");
    // Exactement 30 jours avant la date d'effet (minuit) : « au moins 30 jours »
    const exact = { ...account, scheduled_change: { ...account.scheduled_change, announced_at: "2026-10-05T23:00:00Z" } };
    expect(nb(scheduledFeeChangeText(exact, "fleet", "Europe/Paris")!.body)).toContain("au moins 30 jours à l'avance");
  });

  it("règle des taux appliqués selon le modèle : flotte = fin de course ; centrale = calcul de la répartition", () => {
    expect(nb(scheduledFeeChangeText(account, "fleet")!.body)).toContain("aux courses terminées à partir de cette date ; une course déjà terminée garde ses frais.");
    const centrale = nb(scheduledFeeChangeText({ ...account, fee_percent: 5 }, "centrale")!.body);
    expect(centrale).toContain("(actuellement : 5 % du prix de chaque course terminée)");
    expect(centrale).toContain("aux répartitions du prix calculées à partir de cette date");
    expect(centrale).toContain("y compris une course déjà terminée");
    expect(centrale).not.toContain("garde ses frais");
  });

  it("texte sans frais au choix ; espaces insécables", () => {
    expect(feeTermsText({ fee_percent: 0, fee_fixed_cents: 0, currency: "EUR" }, "aucuns frais par course")).toBe("aucuns frais par course");
    expect(frSpaces("Désormais : 2 € ; merci !")).toBe("Désormais\u00a0: 2 €\u00a0; merci\u00a0!");
  });
});
