// Suppression du compte avec des commissions dues (audit sql-rpc-argent#1) : le chauffeur est prévenu du montant.
import { describe, expect, it } from "vitest";
import { openDebt, openDebtNotice } from "./debt";

const NBSP = " ";

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
    expect(openDebt(settlements(2600, 1200))).toEqual({ cents: 3800, declaredCents: 1200, currency: "EUR", organization: "Taxi Bleu" });
  });

  it("rien de dû, ou lecture impossible : aucun avertissement", () => {
    expect(openDebt(settlements(0, 0))).toBeNull();
    expect(openDebt(null)).toBeNull();
  });
});

describe("openDebtNotice", () => {
  it("montant, dette maintenue et empreintes conservées", () => {
    const n = openDebtNotice(openDebt(settlements(3800, 0))!);
    expect(n.title).toBe(`Commissions dues : 38${NBSP}€`);
    expect(n.message).toContain("elle reste due à Taxi Bleu");
    expect(n.message).toContain("empreintes");
    expect(n.message).not.toContain("signalé");
    expect(n.confirm).toBe(`Les commissions dues (38${NBSP}€) restent à régler à Taxi Bleu.`);
  });

  it("part signalée payée, en attente de confirmation", () => {
    expect(openDebtNotice(openDebt(settlements(2600, 1200))!).message).toMatch(/^Dont 12 € signalés payés/);
    expect(openDebtNotice(openDebt(settlements(0, 1200))!).message).toMatch(/^Paiement signalé/);
  });
});
