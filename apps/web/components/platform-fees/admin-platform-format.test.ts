import { describe, expect, it } from "vitest";
import { csvText, monthSignals } from "./admin-platform-format";

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
});
