import { describe, expect, it } from "vitest";
import { payLinkHint, payNowDetails, payNowSummary, type PayNowAccount } from "./pay-now";

// Un seul montant « à payer » des frais Rydar (docs/REFONTE-PANELS.md, R9) : même phrase sur la carte, le bandeau et la
// fenêtre « J'ai payé », à partir des montants lus en base (private.platform_account), sans aucun calcul d'argent nouveau.

const NOW = Date.parse("2026-10-10T10:00:00Z");
const NOV_5 = "2026-11-05T22:59:59+00:00";
const nb = (t: string | null) => (t ?? "").replace(/[\u00a0\u202f]/g, " ");

/** Centrale Express de la base de recette : 330 € de solde, 95 € échus depuis 4 jours, 10 € déclarés. */
const express: PayNowAccount = {
  balance_cents: 33000,
  due_cents: 9500,
  declared_cents: 1000,
  next_due_cents: 33000,
  next_due_at: NOV_5,
  days_overdue: 4,
  blocked: false,
  currency: "EUR",
};

describe("payNowSummary : un seul montant à payer", () => {
  it("échu non couvert : « À payer maintenant », en rouge, avec le solde, le déclaré et la prochaine échéance", () => {
    const p = payNowSummary(express, NOW, "Europe/Paris");
    expect(p.kind).toBe("now");
    expect(p.tone).toBe("red");
    expect(p.amountCents).toBe(8500);
    expect(nb(p.text)).toBe("À payer maintenant : 85 € · en retard depuis 4 jours");
    expect(nb(p.balance)).toBe("Solde : 330 €");
    expect(nb(p.declared)).toBe("Déjà déclaré 10 €, Rydar doit confirmer");
    // Part de la prochaine échéance en plus de l'échu (330 − 95)
    expect(nb(p.next)).toBe("Prochaine échéance : 5 nov. · 235 €");
    expect(p.blocked).toBe(false);
    // Espaces insécables avant les deux-points
    expect(p.text).toContain("maintenant\u00a0: ");
    expect(p.balance).toContain("Solde\u00a0: ");
  });

  it("échéance dépassée le jour même : « échéance dépassée aujourd'hui »", () => {
    const p = payNowSummary({ ...express, days_overdue: 0 }, NOW);
    expect(nb(p.text)).toBe("À payer maintenant : 85 € · échéance dépassée aujourd'hui");
  });

  it("rien d'échu : « À régler avant le … » en ambre, montant de la prochaine échéance", () => {
    const p = payNowSummary({ ...express, due_cents: 0, declared_cents: 0, balance_cents: 23500, next_due_cents: 23500, days_overdue: 0 }, NOW);
    expect(p.kind).toBe("before");
    expect(p.tone).toBe("amber");
    expect(nb(p.text)).toBe("À régler avant le 5 nov. : 235 €");
    expect(nb(p.balance)).toBe("Solde : 235 €");
    expect(p.declared).toBeNull();
    expect(p.next).toBeNull();
    // Solde plus élevé que l'échéance (frais du cycle en cours) : seul le montant de l'échéance est « à régler »
    const split = payNowSummary({ ...express, due_cents: 0, declared_cents: 0, balance_cents: 16500, next_due_cents: 11500, days_overdue: 0 }, NOW);
    expect(nb(split.text)).toBe("À régler avant le 5 nov. : 115 €");
    expect(nb(split.balance)).toBe("Solde : 165 €");
  });

  it("ligne en petit (payNowDetails) : échéance, solde, déclaré ; solde omis quand il répète le montant principal", () => {
    expect(nb(payNowDetails(payNowSummary(express, NOW)))).toBe("Prochaine échéance : 5 nov. · 235 € · Solde : 330 € · Déjà déclaré 10 €, Rydar doit confirmer");
    // Fenêtre « J'ai payé » : sans la prochaine échéance
    expect(nb(payNowDetails(payNowSummary(express, NOW), false))).toBe("Solde : 330 € · Déjà déclaré 10 €, Rydar doit confirmer");
    // Tout le solde tombe à la prochaine échéance : « À régler avant le 5 nov. : 235 € », sans « Solde : 235 € »
    const all = payNowSummary({ ...express, due_cents: 0, declared_cents: 0, balance_cents: 23500, next_due_cents: 23500, days_overdue: 0 }, NOW);
    expect(all.balanceRepeats).toBe(true);
    expect(payNowDetails(all)).toBe("");
    // Tout est échu, rien de déclaré : le solde n'est pas répété non plus
    const late = payNowSummary({ ...express, declared_cents: 0, due_cents: 33000, next_due_cents: 33000 }, NOW);
    expect(nb(late.text)).toBe("À payer maintenant : 330 € · en retard depuis 4 jours");
    expect(payNowDetails(late)).toBe("");
    // Rien à régler : le solde (ou l'avance) reste affiché
    const none = payNowSummary({ ...express, balance_cents: -2000, due_cents: 0, declared_cents: 0, next_due_cents: 0, next_due_at: null, days_overdue: 0 }, NOW);
    expect(nb(payNowDetails(none))).toBe("Avance en votre faveur : 20 €");
  });

  it("déclaré supérieur à l'échu : plus rien en retard, le reste avant la prochaine échéance", () => {
    const p = payNowSummary({ ...express, declared_cents: 12000 }, NOW);
    expect(p.kind).toBe("before");
    expect(nb(p.text)).toBe("À régler avant le 5 nov. : 210 €");
    expect(nb(p.declared)).toBe("Déjà déclaré 120 €, Rydar doit confirmer");
    // Tout le solde déclaré : rien à régler, la confirmation de Rydar est attendue
    const all = payNowSummary({ ...express, declared_cents: 33000 }, NOW);
    expect(all.kind).toBe("nothing");
    expect(all.tone).toBe("green");
    expect(all.text).toBe("Rien à régler");
    expect(nb(all.balance)).toBe("Solde : 330 €");
    expect(nb(all.declared)).toBe("Déjà déclaré 330 €, Rydar doit confirmer");
  });

  it("avance (solde négatif) : « Rien à régler » et « Avance en votre faveur »", () => {
    const p = payNowSummary({ ...express, balance_cents: -2000, due_cents: 0, declared_cents: 0, next_due_cents: 0, next_due_at: null, days_overdue: 0 }, NOW);
    expect(p.kind).toBe("nothing");
    expect(p.tone).toBe("green");
    expect(p.amountCents).toBeNull();
    expect(nb(p.balance)).toBe("Avance en votre faveur : 20 €");
    // Solde nul : affiché tel quel (le solde est toujours visible, CGV art. 5)
    expect(nb(payNowSummary({ ...express, balance_cents: 0, due_cents: 0, declared_cents: 0, next_due_cents: 0, next_due_at: null, days_overdue: 0 }, NOW).balance)).toBe("Solde : 0 €");
  });

  it("blocage : « À payer maintenant » en rouge, même avec une déclaration qui ne suspend plus le blocage", () => {
    const blocked = payNowSummary({ ...express, declared_cents: 0, days_overdue: 12, blocked: true }, NOW);
    expect(blocked.kind).toBe("now");
    expect(blocked.blocked).toBe(true);
    expect(nb(blocked.text)).toBe("À payer maintenant : 95 € · en retard depuis 12 jours");
    // Déclaration ancienne (plus de 7 jours, private.platform_position) : le blocage reste, l'échu aussi
    const stale = payNowSummary({ ...express, declared_cents: 9500, days_overdue: 12, blocked: true }, NOW);
    expect(stale.kind).toBe("now");
    expect(nb(stale.text)).toBe("À payer maintenant : 95 € · en retard depuis 12 jours");
    expect(nb(stale.declared)).toBe("Déjà déclaré 95 €, Rydar doit confirmer");
  });

  it("flotte : mêmes montants, même phrase, aucun mot propre aux centrales", () => {
    const fleet = { ...express, dispatch_model: "fleet" as const };
    const a = payNowSummary(fleet, NOW);
    expect(a.text).toBe(payNowSummary(express, NOW).text);
    for (const t of [a.text, a.balance, a.declared, a.next]) expect(t ?? "").not.toMatch(/commission|centrale|chauffeur/i);
  });

  it("page restée ouverte après la prochaine échéance : le montant devient « à payer maintenant »", () => {
    const before = { ...express, due_cents: 0, declared_cents: 0, balance_cents: 23500, next_due_cents: 23500, days_overdue: 0 };
    const later = Date.parse("2026-11-06T08:00:00Z");
    const p = payNowSummary(before, later);
    expect(p.kind).toBe("now");
    expect(nb(p.text)).toBe("À payer maintenant : 235 € · échéance dépassée aujourd'hui");
  });
});

describe("payLinkHint : montant du lien de paiement (calculé en base) et montant à indiquer", () => {
  it("paiement déjà déclaré : la page propose l'échu, on indique le reste", () => {
    const p = payNowSummary(express, NOW);
    expect(nb(payLinkHint(9500, p, 1000))).toBe("La page de paiement propose 95 € : indiquez 85 € (10 € déjà déclarés).");
  });

  it("même montant, rien à régler ou lien vide : aucune aide", () => {
    const p = payNowSummary({ ...express, declared_cents: 0 }, NOW);
    expect(payLinkHint(9500, p, 0)).toBeNull();
    expect(payLinkHint(0, p, 0)).toBeNull();
    expect(payLinkHint(9500, { amountCents: null }, 0)).toBeNull();
  });
});
