import type { PlatformAccount } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { ISO_DAY_RE, csvText, invoiceCycles, monthSignals, originParts, rideSettlementLabel, zeroPriceText } from "./admin-platform-format";

describe("invoiceCycles : cycles de la facture récapitulative (frais à facturer)", () => {
  it("mensuel : mois civils du fuseau, le mois en cours d'abord, fin exclue", () => {
    // 1er octobre 2026, 00:30 à Paris (30 septembre 22:30 UTC) : déjà octobre
    const c = invoiceCycles("monthly", new Date("2026-09-30T22:30:00Z"), "Europe/Paris", 3);
    expect(c).toEqual([
      { from: "2026-10-01", to: "2026-11-01", label: "Octobre 2026", current: true },
      { from: "2026-09-01", to: "2026-10-01", label: "Septembre 2026", current: false },
      { from: "2026-08-01", to: "2026-09-01", label: "Août 2026", current: false },
    ]);
    expect(invoiceCycles("monthly", new Date("2026-12-15T12:00:00Z"), "Europe/Paris", 1)[0]).toMatchObject({ from: "2026-12-01", to: "2027-01-01" });
  });

  it("hebdomadaire : du lundi au dimanche (fin exclue : lundi suivant)", () => {
    // Samedi 3 octobre 2026 : semaine du lundi 28 septembre
    const c = invoiceCycles("weekly", new Date("2026-10-03T10:00:00Z"), "Europe/Paris", 2);
    expect(c.map(({ from, to, current }) => ({ from, to, current }))).toEqual([
      { from: "2026-09-28", to: "2026-10-05", current: true },
      { from: "2026-09-21", to: "2026-09-28", current: false },
    ]);
    expect(c[0]!.label).toContain("Semaine du 28");
    // Lundi même : sa propre semaine
    expect(invoiceCycles("weekly", new Date("2026-10-05T08:00:00Z"), "Europe/Paris", 1)[0]).toMatchObject({ from: "2026-10-05", to: "2026-10-12" });
    for (const x of c) expect(ISO_DAY_RE.test(x.from) && ISO_DAY_RE.test(x.to)).toBe(true);
  });
});

describe("csvText : cellule CSV d'un texte libre (export super admin des frais)", () => {
  it("un retour chariot isolé ne coupe pas la ligne et ne fait pas passer de formule", () => {
    expect(csvText("REF-1\r=1+1")).toBe("REF-1 =1+1");
    expect(csvText("Virement effectué\r=WEBSERVICE(A1)")).toBe("Virement effectué =WEBSERVICE(A1)");
    expect(csvText("ok\r\n\r\n=2+5;x")).toBe('"ok =2+5;x"');
    expect(csvText("a\tb")).toBe("a b");
    // Ligne complète relue comme un tableur : une seule ligne, aucune cellule ne commence par « = »
    const row = ["Paiement", csvText("REF\r=1+2"), csvText("note\n@SUM(1)"), csvText("\r=3+4")].join(";");
    expect(row.split(/\r\n|\r|\n/)).toHaveLength(1);
    expect(row.split(";").some((c) => /^[=+\-@]/.test(c))).toBe(false);
  });

  it("neutralise les formules en tête et échappe « ; » et les guillemets", () => {
    expect(csvText("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText("+33 6 12")).toBe("'+33 6 12");
    expect(csvText("\t=1+1")).toBe("'=1+1");
    expect(csvText("12 rue A; Paris")).toBe('"12 rue A; Paris"');
    expect(csvText("  Course 12  ")).toBe("Course 12");
    expect(csvText(null)).toBe("");
    expect(csvText(undefined)).toBe("");
  });
});

describe("monthSignals : indicateurs du mois (super admin)", () => {
  const month = { start: "2026-09-01T00:00:00Z", fees_cents: 0, rides: 0, received_cents: 0 };
  it("prix nul ou symbolique, annulées après attribution dont client à bord", () => {
    expect(monthSignals({ month: { ...month, zero_price_rides: 2, cancelled_assigned_rides: 0 } })).toBe("2 courses à prix nul ou symbolique");
    expect(
      monthSignals({ month: { ...month, zero_price_rides: 0, cancelled_assigned_rides: 3, cancelled_onboard_rides: 1 } as never }),
    ).toBe("3 annulées après attribution (dont 1 client à bord)");
    expect(monthSignals({ month: { ...month, zero_price_rides: 0, cancelled_assigned_rides: 0 } })).toBe("");
  });

  it("flotte : courses sans prix = seule la part en % est perdue (jamais « frais nuls ou plafonnés »)", () => {
    expect(monthSignals({ dispatch_model: "fleet", month: { ...month, zero_price_rides: 3, cancelled_assigned_rides: 0 } })).toBe(
      "3 courses sans prix (part en % non due)",
    );
    expect(monthSignals({ dispatch_model: "centrale", month: { ...month, zero_price_rides: 1, cancelled_assigned_rides: 0 } })).toBe(
      "1 course à prix nul ou symbolique",
    );
    expect(zeroPriceText(1, "fleet")).toBe("1 course terminée sans prix ou à 0 € : la part en % du prix n'est pas due (les frais fixes restent dus)");
    expect(zeroPriceText(2, "centrale")).toMatch(/plafonnés au prix/);
    expect(zeroPriceText(2, undefined)).toMatch(/plafonnés au prix/);
  });
});

describe("frais Rydar des flottes (super admin)", () => {
  const base = { id: "r", number: 1, price_cents: 5000, payment_method: "cash" as const, completed_at: null, pickup: null, dropoff: null };
  it("course de flotte : « Flotte » dans la colonne du règlement ; centrale inchangée", () => {
    expect(rideSettlementLabel({ ...base, settlement_status: null, fleet_fee: { percent: 0, fixed_cents: 200 } })).toBe("Flotte");
    expect(rideSettlementLabel({ ...base, settlement_status: null, fleet_fee: null })).toBeNull();
    expect(rideSettlementLabel({ ...base, settlement_status: "paid", fleet_fee: null })).toBeTruthy();
  });

  it("ventilation : « Encaissé par la flotte » pour une flotte, « par la centrale » sinon", () => {
    const a = { posted_cents: 600, collected_by_centrale_cents: 600, with_drivers_cents: 0, waived_by_centrale_cents: 0 } as PlatformAccount;
    expect(originParts({ ...a, dispatch_model: "fleet" })[0]).toMatchObject({ label: "Encaissé par la flotte", cents: 600 });
    expect(originParts({ ...a, dispatch_model: "centrale" })[0].label).toBe("Encaissé par la centrale");
    expect(originParts(a)[0].label).toBe("Encaissé par la centrale");
    expect(originParts({ ...a, dispatch_model: "fleet" }).find((p) => p.key === "other")?.cents).toBe(0);
  });
});
