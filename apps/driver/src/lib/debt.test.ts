// Suppression du compte avec des commissions dues (audit sql-rpc-argent#1) : le chauffeur est prévenu du montant.
import { describe, expect, it } from "vitest";
import { debtFromSettlements, debtTotal, openDebt, openDebtNotice } from "./debt";

const NBSP = " ";

/** Réponse de driver_deletion_debt / de l'aperçu de la suppression. */
const debt = (owed: number, declared: number) => ({ owed_cents: owed, declared_cents: declared, currency: "EUR", organization: "Taxi Bleu" });

const settlements = (owed: number, declared: number) => ({
  currency: "EUR",
  organization: { name: "Taxi Bleu", phone: null },
  summary: {
    owed_cents: owed, overdue_cents: 0, declared_cents: declared, to_receive_cents: 0,
    paid_month_cents: 0, received_month_cents: 0, next_due_at: null,
  },
});

describe("openDebt", () => {
  it("à régler + contesté + signalé payé non confirmé (périmètre de private.driver_open_debt)", () => {
    expect(openDebt(debt(2600, 1200))).toEqual({ cents: 3800, declaredCents: 1200, currency: "EUR", organization: "Taxi Bleu" });
  });

  it("rien de dû, ou lecture impossible : aucun avertissement", () => {
    expect(openDebt(debt(0, 0))).toBeNull();
    expect(openDebt(null)).toBeNull();
  });

  it("serveur antérieur : mêmes montants tirés du relevé des commissions", () => {
    expect(debtFromSettlements(settlements(2600, 1200))).toEqual(debt(2600, 1200));
    expect(openDebt(debtFromSettlements(settlements(2600, 1200)))).toEqual(openDebt(debt(2600, 1200)));
    expect(debtFromSettlements(null)).toBeNull();
  });
});

describe("openDebtNotice", () => {
  it("montant, dette maintenue et empreintes conservées", () => {
    const n = openDebtNotice(openDebt(debt(3800, 0))!);
    expect(n.title).toBe(`Commissions dues : 38${NBSP}€`);
    expect(n.message).toContain("elle reste due à Taxi Bleu");
    expect(n.message).toContain("empreintes");
    expect(n.message).not.toContain("signalé");
    expect(n.confirm).toBe(`Les commissions dues (38${NBSP}€) restent à régler à Taxi Bleu.`);
  });

  it("part signalée payée, en attente de confirmation", () => {
    expect(openDebtNotice(openDebt(debt(2600, 1200))!).message).toMatch(/^Dont 12 € signalés payés/);
    expect(openDebtNotice(openDebt(debt(0, 1200))!).message).toMatch(/^Paiement signalé/);
  });
});

describe("dettes envers les organisations partenaires (réseau partagé)", () => {
  const network = (owed: number, declared = 0, organization = "Taxi Alpha") => ({ organization, owed_cents: owed, declared_cents: declared });
  const withNetwork = (own: number, list: ReturnType<typeof network>[]) => ({ ...debt(own, 0), network: list });

  it("seules les organisations qui attendent une somme ; total pour la confirmation", () => {
    const d = openDebt(withNetwork(0, [network(1250), network(0, 0, "Taxi Gamma"), network(0, 500, "Taxi Delta")]))!;
    expect(d.cents).toBe(0);
    expect(d.network).toEqual([
      { organization: "Taxi Alpha", cents: 1250, declaredCents: 0 },
      { organization: "Taxi Delta", cents: 500, declaredCents: 500 },
    ]);
    expect(debtTotal(d)).toBe(1750);
    expect(openDebt(withNetwork(0, [network(0)]))).toBeNull();
  });

  it("courses partenaires seules : chaque organisation listée, empreintes gardées pour chacune", () => {
    const n = openDebtNotice(openDebt(withNetwork(0, [network(1250), network(500, 0, "Taxi Gamma")]))!);
    expect(n.title).toBe(`Courses partenaires : 17,50${NBSP}€ dus`);
    expect(n.message).toContain(`Courses partenaires : 12,50${NBSP}€ à Taxi Alpha, 5${NBSP}€ à Taxi Gamma.`);
    expect(n.message).toContain("pour chaque organisation concernée");
    expect(n.confirm).toBe(`Les sommes dues aux organisations partenaires (17,50${NBSP}€) restent à régler : 12,50${NBSP}€ à Taxi Alpha, 5${NBSP}€ à Taxi Gamma.`);
  });

  it("commissions de la centrale et courses partenaires : total et détail", () => {
    // 12,50 € signalés payés à Taxi Alpha, pas encore confirmés : toujours dus
    const n = openDebtNotice(openDebt(withNetwork(3800, [network(0, 1250)]))!);
    expect(n.title).toBe(`Sommes dues : 50,50${NBSP}€`);
    expect(n.message).toMatch(/^Commissions : 38\s€ à Taxi Bleu\. Courses partenaires : 12,50\s€ à Taxi Alpha\. Dont 12,50\s€ signalés payés/);
    expect(n.confirm).toBe(`Les sommes dues (50,50${NBSP}€) restent à régler : 38${NBSP}€ à Taxi Bleu, 12,50${NBSP}€ à Taxi Alpha.`);
  });

  it("sans dette partenaire : avertissement des commissions inchangé", () => {
    expect(openDebt(withNetwork(3800, []))).toEqual(openDebt(debt(3800, 0)));
  });
});
