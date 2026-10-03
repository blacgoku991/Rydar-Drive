import { describe, expect, it } from "vitest";
import {
  addIsoDays, centralePlatformFee, fleetPlatformFee, isoDayLabel, percentOfCents, platformFeeChangeKind, platformFeeNoticeDates,
  platformFeeScopeText, platformFeeSettingSchema,
} from "./platform-fees";

// Référence : round(cents * percent / 100) de PostgreSQL sur des numeric (calcul exact, arrondi « demi loin de zéro »),
// pourcentage en centièmes entiers (numeric(5,2)).
function pgRound(cents: number, hundredths: number): number {
  const n = BigInt(cents) * BigInt(hundredths);
  const abs = n < 0n ? -n : n;
  const q = abs / 10_000n + (abs % 10_000n >= 5_000n ? 1n : 0n);
  return Number(n < 0n ? -q : q);
}

describe("frais Rydar : arrondi identique à la base (décision 6)", () => {
  it("30 € à 1,15 % = 35 c comme PostgreSQL (34 c en virgule flottante)", () => {
    expect(percentOfCents(3000, 1.15)).toBe(35);
    expect(fleetPlatformFee(3000, 1.15, 0)).toBe(35);
    expect(centralePlatformFee(3000, 1.15, 0)).toBe(35);
    // Demi loin de zéro : 0,5 c → 1 c, 1,5 c → 2 c (round(5 * 10 / 100) = 1, round(150 * 1 / 100) = 2)
    expect(percentOfCents(5, 10)).toBe(1);
    expect(percentOfCents(150, 1)).toBe(2);
    expect(percentOfCents(1234, 2.5)).toBe(31);
    // Taux reçu en texte (numeric de PostgREST) ou à 3 décimales : arrondi au centième comme numeric(5,2)
    expect(percentOfCents(10_000, "1.15" as unknown as number)).toBe(115);
    expect(percentOfCents(10_000, 2.675)).toBe(268);
    expect(percentOfCents(-3000, 1.15)).toBe(-35);
  });

  it("aucun écart avec la référence exacte sur 200 000 couples prix / taux", () => {
    let x = 42; // xorshift32 : suite reproductible
    const rand = (n: number) => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) % n;
    };
    for (let i = 0; i < 200_000; i++) {
      const price = rand(2_000_000);
      const hundredths = rand(5_001);
      expect(percentOfCents(price, hundredths / 100)).toBe(pgRound(price, hundredths));
    }
    // Tous les taux à deux décimales sur des prix « ronds » (cas où la virgule flottante tombe juste sous le demi)
    for (let h = 0; h <= 5_000; h++) {
      for (const price of [100, 1000, 3000, 5900, 12_345, 99_999]) expect(percentOfCents(price, h / 100)).toBe(pgRound(price, h));
    }
  });

  it("flotte : % + fixe sans plafond ; centrale : plafonnés au prix", () => {
    expect(fleetPlatformFee(100, 5, 200)).toBe(205);
    expect(fleetPlatformFee(null, 1.15, 200)).toBe(200);
    expect(fleetPlatformFee(100_000_000, 50, 100_000)).toBe(10_000_000);
    expect(centralePlatformFee(100, 5, 200)).toBe(100);
    expect(centralePlatformFee(5900, 10, 0)).toBe(590);
    expect(centralePlatformFee(0, 10, 200)).toBe(0);
  });
});

describe("frais Rydar : hausses annoncées (miroir de svc_platform_set_fees)", () => {
  const rates = (percent: number | string, fixed_cents: number) => ({ percent, fixed_cents });

  it("hausse dès que l'un des deux taux augmente, y compris 0 → plus de 0", () => {
    expect(platformFeeChangeKind(rates(0, 0), rates(0, 200))).toBe("increase");
    expect(platformFeeChangeKind(rates(0, 0), rates(0.01, 0))).toBe("increase");
    expect(platformFeeChangeKind(rates(10, 0), rates(5, 50))).toBe("increase"); // % en baisse, fixe en hausse
    expect(platformFeeChangeKind(rates(10, 200), rates(5, 200))).toBe("decrease");
    expect(platformFeeChangeKind(rates(10, 200), rates(10, 0))).toBe("decrease");
    expect(platformFeeChangeKind(rates("1.10", 200), rates(1.1, 200))).toBe("unchanged");
    expect(platformFeeChangeKind(rates(0.1 + 0.2, 0), rates(0.3, 0))).toBe("unchanged"); // pas d'écart de virgule flottante
  });

  const schedule = (scheduled: { percent: number; fixed_cents: number; effective_on: string } | null) => ({
    min_effective_on: "2026-11-06",
    min_reason: "terms_effective" as const,
    scheduled,
  });

  it("date au plus tôt : celle de la base, ou la date déjà annoncée pour une hausse égale ou moindre", () => {
    // Aucune hausse annoncée : le minimum, proposé par défaut
    expect(platformFeeNoticeDates(schedule(null), rates(0, 200))).toEqual({ min: "2026-11-06", reason: "terms_effective", defaultOn: "2026-11-06" });
    // Hausse annoncée pour le 2026-11-03 (avant le minimum actuel) : une hausse égale ou moindre peut garder cette date
    const announced = schedule({ percent: 0, fixed_cents: 200, effective_on: "2026-11-03" });
    expect(platformFeeNoticeDates(announced, rates(0, 200))).toEqual({ min: "2026-11-03", reason: "already_announced", defaultOn: "2026-11-03" });
    expect(platformFeeNoticeDates(announced, rates(0, 150))).toEqual({ min: "2026-11-03", reason: "already_announced", defaultOn: "2026-11-03" });
    // … pas une hausse plus forte (nouvelle annonce : nouveau préavis)
    expect(platformFeeNoticeDates(announced, rates(0, 250))).toEqual({ min: "2026-11-06", reason: "terms_effective", defaultOn: "2026-11-06" });
    expect(platformFeeNoticeDates(announced, rates(1, 200))).toEqual({ min: "2026-11-06", reason: "terms_effective", defaultOn: "2026-11-06" });
    // Date annoncée plus lointaine que le minimum : proposée par défaut (remplacement sans avancer la date)
    const later = schedule({ percent: 0, fixed_cents: 200, effective_on: "2026-12-01" });
    expect(platformFeeNoticeDates(later, rates(0, 300))).toEqual({ min: "2026-11-06", reason: "terms_effective", defaultOn: "2026-12-01" });
  });

  it("dates « AAAA-MM-JJ » : libellé JJ/MM/AAAA et calendrier sans fuseau", () => {
    expect(isoDayLabel("2026-11-05")).toBe("05/11/2026");
    expect(isoDayLabel(null)).toBe("—");
    expect(addIsoDays("2026-10-03", 366)).toBe("2027-10-04");
    expect(addIsoDays("2026-10-25", 1)).toBe("2026-10-26"); // changement d'heure : jour calendaire
    expect(addIsoDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("règle des taux appliqués selon le modèle (texte de l'alerte et de l'encart)", () => {
    expect(platformFeeScopeText("fleet", "now")).toBe(
      "Ils s'appliquent aux courses terminées à partir de maintenant ; une course déjà terminée garde ses frais.",
    );
    expect(platformFeeScopeText("centrale", "date")).toContain("répartitions du prix calculées à partir de cette date");
    expect(platformFeeScopeText("centrale", "now")).toContain("y compris une course déjà terminée");
    expect(platformFeeScopeText("centrale", "now")).not.toContain("garde ses frais");
  });

  it("réglage du super admin : les deux taux ou aucun, accord écrit avec sa note", () => {
    const base = { dispatchModel: "fleet" as const };
    expect(platformFeeSettingSchema.parse(base)).toMatchObject({ platformFeePercent: null, platformFeeFixedCents: null, mode: "notice", effectiveOn: null });
    expect(platformFeeSettingSchema.parse({ ...base, platformFeePercent: 1.155, platformFeeFixedCents: 200, effectiveOn: "2026-11-06" })).toMatchObject({
      platformFeePercent: 1.16,
      platformFeeFixedCents: 200,
      effectiveOn: "2026-11-06",
    });
    const half = platformFeeSettingSchema.safeParse({ ...base, platformFeePercent: 2 });
    expect(half.success).toBe(false);
    expect(half.error?.issues[0]?.path).toEqual(["platformFeeFixedCents"]);
    const consent = platformFeeSettingSchema.safeParse({ ...base, platformFeePercent: 0, platformFeeFixedCents: 200, mode: "consent", consentNote: " " });
    expect(consent.success).toBe(false);
    expect(consent.error?.issues[0]?.path).toEqual(["consentNote"]);
    expect(
      platformFeeSettingSchema.parse({ ...base, platformFeePercent: 0, platformFeeFixedCents: 200, mode: "consent", consentNote: "  E-mail du 3 octobre  " })
        .consentNote,
    ).toBe("E-mail du 3 octobre");
    expect(platformFeeSettingSchema.safeParse({ ...base, platformFeePercent: 51, platformFeeFixedCents: 0 }).success).toBe(false);
    expect(platformFeeSettingSchema.safeParse({ ...base, platformFeePercent: 0, platformFeeFixedCents: 100_001 }).success).toBe(false);
    expect(platformFeeSettingSchema.safeParse({ ...base, platformFeePercent: 0, platformFeeFixedCents: 0, effectiveOn: "05/11/2026" }).success).toBe(false);
  });
});
