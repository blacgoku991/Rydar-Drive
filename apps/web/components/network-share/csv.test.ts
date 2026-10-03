import { describe, expect, it } from "vitest";
import {
  CSV_BOM, STATEMENT_HEADER, csvCell, csvLine, euros, networkStatementCsv, statementFileName, statementRowsFromGiven,
  statementRowsFromReceived, statementState, statementTotals,
} from "./csv";
import { CENTRALE_15_10, FLEET_10, givenItem, receivedFromGiven } from "./test-fixtures";

// Relevé mensuel du réseau partagé : format du dépôt (BOM, « ; », formules neutralisées) et MÊMES chiffres chez
// l'organisation qui confie et chez celle du chauffeur (termes figés de chaque course).

describe("cellules CSV", () => {
  it("montants « 12,50 », négatifs conservés", () => {
    expect(euros(1250)).toBe("12,50");
    expect(euros(5)).toBe("0,05");
    expect(euros(-200)).toBe("-2,00");
    expect(euros(null)).toBe("");
  });

  it("formules neutralisées (=, +, -, @, tabulation, retour chariot), montant négatif intact", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+33612345678")).toBe("'+33612345678");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe(`"'\rx"`);
    expect(csvCell("-2,00")).toBe("-2,00");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvLine(["a", 1, null, "b\nc"])).toBe('a;1;;"b\nc"');
  });
});

describe("relevé mensuel : mêmes colonnes et totaux des deux côtés", () => {
  const given = [
    givenItem({ payment: "cash", number: 101 }),
    givenItem({ payment: "online", number: 102, settlement: "paid" }),
    givenItem({ payment: "card", number: 103, giver: FLEET_10, settlement: "declared" }),
    givenItem({ payment: "invoice", number: 104, onHold: true, suspect: ["too_fast"] }),
    // En cours et retirée : hors relevé (aucun montant)
    givenItem({ status: "DRIVER_EN_ROUTE", number: 105 }),
    givenItem({ status: "SEARCHING_DRIVER", endedAt: "2026-09-20T09:40:00.000Z", endReason: "removed_by_giver", settlement: null, number: 106 }),
  ];
  const received = given.map((g) => receivedFromGiven(g, "Taxi A"));

  it("lignes identiques chez A et chez B (référence, organisations, chauffeur, montants, sens, état)", () => {
    const a = statementRowsFromGiven(given, "Taxi A").map((r) => ({ ...r, executor: "Flotte B" }));
    const b = statementRowsFromReceived(received, "Flotte B");
    expect(a.map((r) => r.reference)).toEqual(["R101", "R102", "R103", "R104"]);
    expect(b).toEqual(a);
    expect(statementTotals(a)).toEqual(statementTotals(b));
  });

  it("totaux : parts de l'organisation qui confie et des chauffeurs, reversements et versements séparés", () => {
    const t = statementTotals(statementRowsFromGiven(given, "Taxi A"));
    // 4 courses à 50 € : centrale 15 % + 10 % (3) et flotte 10 % (1)
    expect(t).toEqual({ rides: 4, priceCents: 20_000, giverPartCents: 1250 * 3 + 500, driverPartCents: 3750 * 3 + 4500, driverOwesCents: 1250 + 500, payoutCents: 3750 * 2 });
  });

  it("états du règlement avec les mêmes mots des deux côtés", () => {
    expect(statementState(null)).toBe("Sans règlement");
    expect(statementState({ status: "due", direction: "driver_owes", overdue: false, on_hold: false })).toBe("À reverser");
    expect(statementState({ status: "due", direction: "centrale_owes", overdue: false, on_hold: false })).toBe("À verser");
    expect(statementState({ status: "due", direction: "centrale_owes", overdue: false, on_hold: true })).toBe("Retenu (à vérifier)");
    expect(statementState({ status: "due", direction: "driver_owes", overdue: true, on_hold: false })).toBe("En retard");
    expect(statementState({ status: "declared", direction: "driver_owes", overdue: false, on_hold: false })).toBe("Déclaré payé");
    expect(statementState({ status: "paid", direction: "centrale_owes", overdue: false, on_hold: false })).toBe("Réglé");
    expect(statementState({ status: "disputed", direction: "driver_owes", overdue: false, on_hold: false })).toBe("Contesté");
    expect(statementState({ status: "waived", direction: "driver_owes", overdue: false, on_hold: false })).toBe("Annulé");
  });

  it("fichier : BOM UTF-8, séparateur « ; », fins de ligne CRLF, en-tête puis courses dans l'ordre chronologique", () => {
    const rows = statementRowsFromGiven([givenItem({ number: 2, endedAt: "2026-09-21T08:00:00.000Z" }), givenItem({ number: 1 })], "Taxi A");
    const csv = networkStatementCsv({ view: "confiees", orgName: "Taxi A", month: "2026-09", partnerName: "Flotte B", rows, timeZone: "Europe/Paris" });
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Relevé du réseau partagé — courses confiées;Taxi A;Mois 2026-09;Partenaire Flotte B");
    expect(lines).toContain(STATEMENT_HEADER.join(";"));
    const body = lines.slice(lines.indexOf(STATEMENT_HEADER.join(";")) + 1).filter(Boolean);
    expect(body.map((l) => l.split(";")[1])).toEqual(["R1", "R2"]);
    expect(body[0]).toBe("20/09/2026 12:00;R1;Taxi A;Flotte B;Karim B.;50,00;12,50;37,50;Payée à bord : le chauffeur reverse;12,50;À reverser");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("vue « reçues » : même corps de fichier que la vue « confiées » de l'autre organisation", () => {
    const one = [givenItem({ number: 7 })];
    const a = networkStatementCsv({ view: "confiees", orgName: "Taxi A", month: "2026-09", partnerName: null, rows: statementRowsFromGiven(one, "Taxi A").map((r) => ({ ...r, executor: "Flotte B" })), timeZone: "Europe/Paris" });
    const b = networkStatementCsv({ view: "recues", orgName: "Flotte B", month: "2026-09", partnerName: null, rows: statementRowsFromReceived(one.map((g) => receivedFromGiven(g)), "Flotte B"), timeZone: "Europe/Paris" });
    const body = (csv: string) => csv.split("\r\n").slice(1);
    expect(body(a)).toEqual(body(b));
  });

  it("nom de fichier sans caractère dangereux", () => {
    expect(statementFileName("confiees", "taxi-sud", "2026-09")).toBe("rydar-reseau-partage-confiees-taxi-sud-2026-09.csv");
    expect(statementFileName("recues", "../../x\"y", "2026-09")).toBe("rydar-reseau-partage-recues-xy-2026-09.csv");
    expect(statementFileName("recues", null, "2026-09")).toBe("rydar-reseau-partage-recues-organisation-2026-09.csv");
  });

  it("le centrale de l'exemple est bien le cas Q1 de la spec (12,50 € reversés à bord)", () => {
    const r = statementRowsFromGiven([givenItem({ giver: CENTRALE_15_10 })], "Taxi A")[0]!;
    expect([r.priceCents, r.giverPartCents, r.driverPartCents, r.amountCents]).toEqual([5000, 1250, 3750, 1250]);
  });
});
