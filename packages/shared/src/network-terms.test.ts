// networkTerms() = miroir TS de private.network_terms (spec réseau partagé §10.1, Q1 recommandé) : mêmes montants et
// mêmes arrondis que le SQL des commissions (private.compute_ride_split) et des frais de flotte
// (private.fleet_platform_fee, 20260924006400). Un test base (lot argent) comparera aussi au SQL réel.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  networkMoneyLine, networkShareExample, networkTerms, percentOfCents, type NetworkTermsGiverInput,
} from "./network";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

/** Q1 : centrale qui prend 15 % à ses chauffeurs, 10 % de frais Rydar. */
const CENTRALE: NetworkTermsGiverInput = {
  dispatch_model: "centrale", platform_fee_percent: 10, platform_fee_fixed_cents: 0,
  driver_commission_percent: 15, driver_commission_fixed_cents: 0,
};
/** Q1 : flotte, 10 % de frais Rydar (une flotte ne prend pas de commission). */
const FLEET: NetworkTermsGiverInput = { dispatch_model: "fleet", platform_fee_percent: 10, platform_fee_fixed_cents: 0 };

/** round(prix × % / 100) de PostgreSQL sur numeric, calculé en entiers exacts depuis le texte du pourcentage. */
function sqlRoundPercent(price: number, percent: string): number {
  const [int = "0", frac = ""] = percent.split(".");
  const hundredths = BigInt(int) * 100n + BigInt((frac + "00").slice(0, 2));
  const n = BigInt(price) * hundredths;
  const q = n / 10_000n;
  const r = n % 10_000n;
  return Number(q + (r * 2n >= 10_000n ? 1n : 0n));
}

/** Corps de la DERNIÈRE définition d'une fonction SQL dans les migrations. */
function lastSqlDefinition(signature: string): string {
  let body: string | null = null;
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${MIGRATIONS}${f}`, "utf8");
    const at = sql.lastIndexOf(`function ${signature}(`);
    if (at === -1) continue;
    body = sql.slice(at, sql.indexOf("$$;", at));
  }
  if (!body) throw new Error(`${signature} introuvable`);
  return body.replace(/\s+/g, " ");
}

describe("networkTerms : tableau Q1 (course de 50 €)", () => {
  it("centrale, client payé à bord : le chauffeur garde 37,50 € et reverse 12,50 € (7,50 € de commission + 5 € de frais)", () => {
    const res = networkTerms({ price_cents: 5_000, payment_method: "cash" }, CENTRALE);
    expect(res).toEqual({
      ok: true,
      terms: {
        price_cents: 5_000, payment_method: "cash", collects: true, commission_cents: 750, platform_fee_cents: 500,
        giver_cut_cents: 1_250, driver_payout_cents: 3_750, direction: "driver_owes", amount_cents: 1_250,
      },
    });
  });

  it("centrale, client prépayé : la centrale verse 37,50 € au chauffeur", () => {
    const res = networkTerms({ price_cents: 5_000, payment_method: "online" }, CENTRALE);
    expect(res.ok && res.terms).toMatchObject({
      collects: false, giver_cut_cents: 1_250, driver_payout_cents: 3_750, direction: "centrale_owes", amount_cents: 3_750,
    });
  });

  it("flotte, client payé à bord : le chauffeur garde 45 € et reverse 5 € (frais Rydar seuls)", () => {
    const res = networkTerms({ price_cents: 5_000, payment_method: "card" }, FLEET);
    expect(res).toEqual({
      ok: true,
      terms: {
        price_cents: 5_000, payment_method: "card", collects: true, commission_cents: 0, platform_fee_cents: 500,
        giver_cut_cents: 500, driver_payout_cents: 4_500, direction: "driver_owes", amount_cents: 500,
      },
    });
  });

  it("flotte, client prépayé : la flotte verse 45 €", () => {
    const res = networkTerms({ price_cents: 5_000, payment_method: "invoice" }, FLEET);
    expect(res.ok && res.terms).toMatchObject({ giver_cut_cents: 500, driver_payout_cents: 4_500, direction: "centrale_owes", amount_cents: 4_500 });
  });

  it("répartition stockée sur la course (centrale) : prioritaire, comme rides.commission_cents / platform_fee_cents en SQL", () => {
    // Même résultat quand la course porte la répartition calculée par rides_centrale_split…
    const stored = networkTerms({ price_cents: 5_000, payment_method: "cash", commission_cents: 750, platform_fee_cents: 500 }, CENTRALE);
    expect(stored.ok && stored.terms.giver_cut_cents).toBe(1_250);
    // … et une commission saisie à la course l'emporte sur les réglages
    const manual = networkTerms({ price_cents: 5_000, payment_method: "cash", commission_cents: 1_000, platform_fee_cents: 500 }, CENTRALE);
    expect(manual.ok && manual.terms).toMatchObject({ commission_cents: 1_000, giver_cut_cents: 1_500, driver_payout_cents: 3_500 });
    // Repli champ par champ (compute_ride_split) quand un seul est stocké
    const partial = networkTerms({ price_cents: 5_000, payment_method: "cash", commission_cents: null, platform_fee_cents: 300 }, CENTRALE);
    expect(partial.ok && partial.terms).toMatchObject({ commission_cents: 750, platform_fee_cents: 300, giver_cut_cents: 1_050 });
  });

  it("flotte : règle des flottes (rides.platform_fee_cents, hérité d'un passage en centrale, n'est pas lu)", () => {
    const res = networkTerms({ price_cents: 5_000, payment_method: "cash", platform_fee_cents: 1_234, commission_cents: 99 }, FLEET);
    expect(res.ok && res.terms).toMatchObject({ commission_cents: 0, platform_fee_cents: 500, giver_cut_cents: 500 });
  });
});

describe("networkTerms : montant fixe, prix absent, part nulle", () => {
  it("2 € fixes sans % : dus en plus de la commission (centrale) ou seuls (flotte)", () => {
    const fleet = networkTerms({ price_cents: 5_000, payment_method: "cash" }, { dispatch_model: "fleet", platform_fee_percent: 0, platform_fee_fixed_cents: 200 });
    expect(fleet.ok && fleet.terms).toMatchObject({ commission_cents: 0, platform_fee_cents: 200, giver_cut_cents: 200, driver_payout_cents: 4_800, amount_cents: 200 });
    const centrale = networkTerms({ price_cents: 5_000, payment_method: "online" },
      { ...CENTRALE, platform_fee_percent: 0, platform_fee_fixed_cents: 200 });
    expect(centrale.ok && centrale.terms).toMatchObject({
      commission_cents: 750, platform_fee_cents: 200, giver_cut_cents: 950, driver_payout_cents: 4_050, amount_cents: 4_050,
    });
  });

  it("% et fixe ensemble : 5 % + 1 € sur 40 € = 3 € (exemple du propriétaire)", () => {
    const res = networkTerms({ price_cents: 4_000, payment_method: "cash" }, { dispatch_model: "fleet", platform_fee_percent: 5, platform_fee_fixed_cents: 100 });
    expect(res.ok && res.terms.platform_fee_cents).toBe(300);
  });

  it("prix absent : non partageable (no_price), quel que soit le modèle", () => {
    for (const giver of [CENTRALE, FLEET]) {
      expect(networkTerms({ price_cents: null, payment_method: "cash" }, giver)).toEqual({ ok: false, reason: "no_price" });
      expect(networkTerms({ price_cents: undefined, payment_method: "online" }, giver)).toEqual({ ok: false, reason: "no_price" });
    }
  });

  it("prix nul : non partageable (part du chauffeur nulle ou négative → no_payout)", () => {
    expect(networkTerms({ price_cents: 0, payment_method: "cash" }, CENTRALE)).toEqual({ ok: false, reason: "no_payout" });
    expect(networkTerms({ price_cents: 0, payment_method: "cash" }, { ...FLEET, platform_fee_fixed_cents: 200 }))
      .toEqual({ ok: false, reason: "no_payout" });
    // Flotte sans aucun frais : part = prix = 0 → pas partageable non plus
    expect(networkTerms({ price_cents: 0, payment_method: "online" }, { ...FLEET, platform_fee_percent: 0 }))
      .toEqual({ ok: false, reason: "no_payout" });
  });

  it("part du chauffeur ≤ 0 : jamais partagée", () => {
    // Centrale : commission à 100 % → part 0
    expect(networkTerms({ price_cents: 5_000, payment_method: "cash" }, { ...CENTRALE, driver_commission_percent: 100 }))
      .toEqual({ ok: false, reason: "no_payout" });
    // Centrale : frais plafonnés au prix (least(prix, …)) → part 0
    expect(networkTerms({ price_cents: 1_000, payment_method: "cash" }, { ...CENTRALE, platform_fee_percent: 50, platform_fee_fixed_cents: 100_000 }))
      .toEqual({ ok: false, reason: "no_payout" });
    // Flotte : frais non plafonnés au prix (facturés à la flotte) → part négative
    expect(networkTerms({ price_cents: 1_000, payment_method: "online" }, { dispatch_model: "fleet", platform_fee_percent: 50, platform_fee_fixed_cents: 1_000 }))
      .toEqual({ ok: false, reason: "no_payout" });
    // Un centime de part suffit
    const tight = networkTerms({ price_cents: 1_001, payment_method: "online" }, { dispatch_model: "fleet", platform_fee_percent: 0, platform_fee_fixed_cents: 1_000 });
    expect(tight.ok && tight.terms.driver_payout_cents).toBe(1);
  });

  it("sens selon le paiement : espèces / carte → le chauffeur reverse ; en ligne / facture / compte → l'organisation verse", () => {
    const dir = (payment_method: "cash" | "card" | "online" | "invoice" | "account") => {
      const r = networkTerms({ price_cents: 5_000, payment_method }, CENTRALE);
      return r.ok ? [r.terms.collects, r.terms.direction] : null;
    };
    expect(dir("cash")).toEqual([true, "driver_owes"]);
    expect(dir("card")).toEqual([true, "driver_owes"]);
    expect(dir("online")).toEqual([false, "centrale_owes"]);
    expect(dir("invoice")).toEqual([false, "centrale_owes"]);
    expect(dir("account")).toEqual([false, "centrale_owes"]);
  });
});

describe("arrondis identiques au SQL", () => {
  const PERCENTS = ["0", "0.5", "1.15", "2.05", "2.5", "4.35", "7.25", "10", "12.5", "14.35", "15", "33.33", "49.99", "50", "99.99", "100"];

  it("percentOfCents = round(prix × % / 100) de PostgreSQL (numeric exact, demi-centime loin de zéro)", () => {
    for (const p of PERCENTS) {
      for (let price = 0; price <= 20_000; price += 1) {
        const expected = sqlRoundPercent(price, p);
        if (percentOfCents(price, Number(p)) !== expected || percentOfCents(price, p) !== expected) {
          throw new Error(`${price} × ${p} % : attendu ${expected}, obtenu ${percentOfCents(price, Number(p))}`);
        }
      }
    }
  });

  it("cas où l'arrondi flottant naïf se trompe : 30 € × 1,15 % = 34,5 c → 35", () => {
    expect(Math.round((3_000 * 1.15) / 100)).toBe(34);
    expect(percentOfCents(3_000, 1.15)).toBe(35);
    expect(percentOfCents(1, 50)).toBe(1);
    expect(percentOfCents(10_000_000, 50)).toBe(5_000_000);
  });

  it("frais et commission sur des prix et taux variés = calcul SQL", () => {
    for (const fee of ["0", "1.15", "4.35", "10"]) {
      for (const com of ["0", "2.05", "15", "33.33"]) {
        for (let price = 1; price <= 9_000; price += 7) {
          const giver: NetworkTermsGiverInput = {
            dispatch_model: "centrale", platform_fee_percent: fee, platform_fee_fixed_cents: 30,
            driver_commission_percent: com, driver_commission_fixed_cents: 20,
          };
          const sqlFee = Math.min(price, sqlRoundPercent(price, fee) + 30);
          const sqlCommission = Math.min(price - sqlFee, sqlRoundPercent(price, com) + 20);
          const payout = price - sqlFee - sqlCommission;
          const res = networkTerms({ price_cents: price, payment_method: "cash" }, giver);
          if (payout <= 0) expect(res).toEqual({ ok: false, reason: "no_payout" });
          else expect(res.ok && [res.terms.platform_fee_cents, res.terms.commission_cents, res.terms.driver_payout_cents]).toEqual([sqlFee, sqlCommission, payout]);

          const fleetFee = Math.min(10_000_000, sqlRoundPercent(price, fee) + 30);
          const fleet = networkTerms({ price_cents: price, payment_method: "online" }, { ...giver, dispatch_model: "fleet" });
          if (price - fleetFee <= 0) expect(fleet).toEqual({ ok: false, reason: "no_payout" });
          else expect(fleet.ok && fleet.terms.platform_fee_cents).toBe(fleetFee);
        }
      }
    }
  });

  it("formules SQL miroitées inchangées (sinon : mettre networkTerms à jour en même temps)", () => {
    const split = lastSqlDefinition("private.compute_ride_split");
    expect(split).toContain("platform_fee_cents := least(p_price, round(p_price * coalesce(v_fee_pct, 0) / 100)::integer + coalesce(v_fee_fixed, 0));");
    expect(split).toContain("commission_cents := least(p_price - platform_fee_cents, round(p_price * coalesce(v_pct, 0) / 100)::integer + coalesce(v_fixed, 0));");
    expect(split).toContain("driver_payout_cents := p_price - commission_cents - platform_fee_cents;");
    expect(lastSqlDefinition("private.fleet_platform_fee")).toContain(
      "least(10000000, round(greatest(coalesce(p_price, 0), 0) * coalesce(p_percent, 0) / 100)::integer + coalesce(p_fixed, 0))",
    );
  });
});

describe("présentation au chauffeur et à l'organisation", () => {
  it("exemple chiffré de la carte « Partager » : 12,50 € reversés à bord, 37,50 € versés si prépayé", () => {
    const ex = networkShareExample(CENTRALE);
    expect(ex.onBoard?.amount_cents).toBe(1_250);
    expect(ex.prepaid?.amount_cents).toBe(3_750);
    const fleet = networkShareExample(FLEET);
    expect([fleet.onBoard?.amount_cents, fleet.prepaid?.amount_cents]).toEqual([500, 4_500]);
  });

  it("un seul montant par sens, jamais commission ni frais Rydar", () => {
    const nbsp = (s: string) => s.replace(/[  ]/g, " ");
    const base = { price_cents: 5_000, currency: "EUR", driver_part_cents: 3_750, giver_part_cents: 1_250 };
    expect(nbsp(networkMoneyLine({ ...base, collects: true }, "Taxi Bleu"))).toBe("Le client vous paie 50 € à bord · vous reverserez 12,50 € à Taxi Bleu");
    expect(nbsp(networkMoneyLine({ ...base, collects: false }, "Taxi Bleu"))).toBe("Course déjà payée à Taxi Bleu · Taxi Bleu vous versera 37,50 €");
  });
});
