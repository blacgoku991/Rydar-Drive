import { formatPrice, networkTerms } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { networkSearchDelayText, networkSearchExtraSeconds, shareExampleText } from "./example";
import { CENTRALE_15_10, FLEET_10 } from "./test-fixtures";

// Exemple chiffré de la carte « Partager mes courses non prises » : calculé avec les VRAIS taux de l'organisation par
// networkShareExample (miroir de private.network_terms), donc égal au montant SQL. Tableau Q1 de la spec (50 €).

const eur = (cents: number) => formatPrice(cents, "EUR");

describe("exemple chiffré du partage (taux réels de l'organisation)", () => {
  it("centrale à 15 % de commission + 10 % de frais : 12,50 € reversés à bord, 37,50 € versés si déjà payée", () => {
    const ex = shareExampleText(CENTRALE_15_10);
    expect(ex.amounts).toEqual({ onBoardCents: 1250, prepaidCents: 3750 });
    expect(ex.onBoard).toBe(`Course de ${eur(5000)} payée à bord → le chauffeur vous reverse ${eur(1250)}`);
    expect(ex.prepaid).toBe(`Course de ${eur(5000)} déjà payée → vous lui versez ${eur(3750)}`);
    expect(ex.none).toBeNull();
  });

  it("flotte à 10 % de frais : 5 € reversés à bord, 45 € versés si déjà payée (aucune commission)", () => {
    const ex = shareExampleText(FLEET_10);
    expect(ex.amounts).toEqual({ onBoardCents: 500, prepaidCents: 4500 });
    expect(ex.onBoard).toContain(`reverse ${eur(500)}`);
    expect(ex.prepaid).toContain(`versez ${eur(4500)}`);
  });

  it("montants identiques à networkTerms (miroir du SQL), quels que soient les taux", () => {
    const rates = [
      CENTRALE_15_10,
      FLEET_10,
      { dispatch_model: "centrale" as const, platform_fee_percent: 1.15, platform_fee_fixed_cents: 30, driver_commission_percent: 12.5, driver_commission_fixed_cents: 100 },
      { dispatch_model: "fleet" as const, platform_fee_percent: "7.25", platform_fee_fixed_cents: 99 },
    ];
    for (const giver of rates) {
      for (const price of [5000, 3000, 1234, 99_900]) {
        const ex = shareExampleText(giver, "EUR", price);
        const cash = networkTerms({ price_cents: price, payment_method: "cash" }, giver);
        const online = networkTerms({ price_cents: price, payment_method: "online" }, giver);
        expect(ex.amounts.onBoardCents).toBe(cash.ok ? cash.terms.amount_cents : null);
        expect(ex.amounts.prepaidCents).toBe(online.ok ? online.terms.amount_cents : null);
        if (cash.ok) expect(ex.amounts.onBoardCents).toBe(cash.terms.commission_cents + cash.terms.platform_fee_cents);
        if (online.ok) expect(ex.amounts.prepaidCents).toBe(price - online.terms.giver_cut_cents);
      }
    }
  });

  it("part du chauffeur nulle avec ces taux : la course ne serait pas proposée, message explicite", () => {
    const ex = shareExampleText({ dispatch_model: "centrale", platform_fee_percent: 50, platform_fee_fixed_cents: 0, driver_commission_percent: 50, driver_commission_fixed_cents: 0 });
    expect(ex.onBoard).toBeNull();
    expect(ex.prepaid).toBeNull();
    expect(ex.none).toMatch(/ne laisse rien au chauffeur/);
  });
});

describe("délai annoncé quand un partenaire est proche", () => {
  it("une vague réseau par rayon du premier passage, chacune pendant le délai de réponse", () => {
    expect(networkSearchExtraSeconds([4000, 8000, 12000, 16000], 30)).toBe(120);
    expect(networkSearchDelayText([4000, 8000, 12000, 16000], 30)).toBe("La recherche peut durer 2 min de plus quand un partenaire est proche.");
    expect(networkSearchDelayText([4000, 8000], 45)).toBe("La recherche peut durer 2 min de plus quand un partenaire est proche.");
    expect(networkSearchDelayText([4000], 20)).toBe("La recherche peut durer 20 s de plus quand un partenaire est proche.");
  });

  it("réglages absents : défauts du dispatch (4 rayons, 30 s)", () => {
    expect(networkSearchExtraSeconds(null, null)).toBe(120);
    expect(networkSearchExtraSeconds([], 0)).toBe(120);
  });
});
