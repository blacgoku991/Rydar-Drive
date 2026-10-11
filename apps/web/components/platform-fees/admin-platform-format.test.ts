import type { PlatformAccount, PlatformEntry } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  ISO_DAY_RE, NETWORK_CONTEST_NOTE, STATEMENT_FIRST_LINES, accountIsEmpty, accountStateBadge, aheadDeclaredNote, balanceLabel, csvText,
  declaredSplit, formatDay, formatDayTime, invoiceCycles, isNetworkContest, lastMonths, lateDeclaredNote, monthKey, monthLabel, monthSignals,
  moreLinesLabel, nextDueInfo, originParts, pendingReductionsDescription, rideSettlementLabel, termsSummary, visibleOriginParts, zeroPriceText,
} from "./admin-platform-format";
import { payNowSummary } from "./pay-now";

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

describe("baisses de frais à valider : contestation d'une course partagée (réseau partagé)", () => {
  const nb = (t: string) => t.replace(/\u00a0/g, " ");
  type Reduction = Pick<PlatformEntry, "amount_cents" | "network_contest">;
  const price: Reduction = { amount_cents: -100 };
  const contest: Reduction = { amount_cents: -500, network_contest: { contested_at: "2026-10-01T10:00:00Z" } };

  it("sans contestation : texte d'avant (corrections de prix, acceptées au bout de 30 jours)", () => {
    expect(nb(pendingReductionsDescription([price]))).toBe(
      "Prix corrigé à la baisse après la course : 1 € de frais en moins si vous acceptez tout. Refus seulement si la correction ne correspond pas à la course réellement effectuée et payée, avec un motif (affiché à l'organisation) ; sans décision dans les 30 jours, la baisse est acceptée automatiquement (CGV, article 5).",
    );
    expect(pendingReductionsDescription([])).toMatch(/^Quand une centrale ou une flotte baisse le prix/);
    expect(isNetworkContest(price)).toBe(false);
    expect(isNetworkContest({ network_contest: null })).toBe(false);
  });

  it("contestation : jamais « acceptée automatiquement » pour elle, frais dus tant que Rydar n'a pas décidé", () => {
    expect(isNetworkContest(contest)).toBe(true);
    const only = nb(pendingReductionsDescription([contest]));
    expect(only).toBe(
      "5 € de frais en moins si vous acceptez tout. Course partagée contestée : à vous de décider, jamais acceptée automatiquement ; les frais restent dus tant que vous ne l'avez pas acceptée.",
    );
    expect(only).not.toContain("30 jours");
    const mixed = nb(pendingReductionsDescription([price, contest]));
    expect(mixed).toContain("6 € de frais en moins si vous acceptez tout.");
    expect(mixed).toContain("Prix corrigé à la baisse après la course : refus seulement si la correction ne correspond pas");
    expect(mixed).toContain("sans décision dans les 30 jours, la baisse est acceptée automatiquement (CGV, article 5).");
    expect(mixed).toMatch(/Course partagée contestée : à vous de décider, jamais acceptée automatiquement/);
    expect(nb(NETWORK_CONTEST_NOTE)).toBe("Course partagée contestée : jamais acceptée automatiquement, décision requise");
  });
});

// Refonte R5 (docs/REFONTE-PANELS.md) : formateurs mémorisés (mêmes sorties qu'avec un formateur construit à chaque
// appel), résumés de la page d'un compte, état vide, lignes de « D'où vient l'argent », relevé.
describe("dates et mois : mêmes sorties avec les formateurs mémorisés de @rydar/shared", () => {
  const nb = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");
  it("jour, jour et heure, mois", () => {
    expect(formatDay("2026-10-05")).toBe("5 oct. 2026");
    expect(formatDay("2026-10-05", "America/New_York", false)).toBe("5 oct.");
    // Instant lu dans le fuseau du client : 23:30 UTC le 31 octobre = 1er novembre à Paris
    expect(formatDay("2026-10-31T23:30:00Z", "Europe/Paris")).toBe("1 nov. 2026");
    expect(formatDay(null)).toBe("—");
    expect(nb(formatDayTime("2026-10-01T08:08:00Z", "Europe/Paris"))).toBe("01/10 10:08");
    expect(formatDayTime(undefined)).toBe("—");
    expect(monthKey(new Date("2026-09-30T22:30:00Z"))).toBe("2026-10");
    expect(monthKey(new Date("2026-09-30T22:30:00Z"), "UTC")).toBe("2026-09");
    expect(monthLabel("2026-08")).toBe("août 2026");
    expect(lastMonths("2026-01", 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });
});

describe("page d'un compte : résumés", () => {
  const nb = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");
  it("conditions en une ligne : cycle, délai, blocage", () => {
    expect(nb(termsSummary({ cycle: "monthly", payment_days: 5, block_after_days: null }))).toBe("Mensuel · 5 jours de délai · blocage désactivé");
    expect(nb(termsSummary({ cycle: "weekly", payment_days: 1, block_after_days: 15 }))).toBe(
      "Hebdomadaire · 1 jour de délai · courses bloquées après 15 jours de retard",
    );
    expect(nb(termsSummary({ cycle: "monthly", payment_days: 0, block_after_days: 1 }))).toBe("Mensuel · 0 jour de délai · courses bloquées après 1 jour de retard");
  });

  it("état du compte vu par Rydar : retard, échéance, avance du client (jamais « en votre faveur »), rien à régler", () => {
    const base = { balance_cents: 0, due_cents: 0, days_overdue: 0, overdue_since: null, next_due_at: null };
    expect(accountStateBadge({ ...base, balance_cents: 33000, due_cents: 9500, days_overdue: 4, overdue_since: "2026-10-06T00:00:00Z" })).toEqual({
      text: "En retard depuis 4\u00a0jours",
      tone: "red",
    });
    expect(accountStateBadge({ ...base, balance_cents: 500, due_cents: 500, overdue_since: "2026-10-10T00:00:00Z" }).text).toBe("Échéance dépassée aujourd'hui");
    expect(accountStateBadge({ ...base, balance_cents: 23500, next_due_at: "2026-11-05T22:59:59Z" }, "Europe/Paris")).toEqual({
      text: "À régler au plus tard le 5 novembre",
      tone: "amber",
    });
    expect(accountStateBadge({ ...base, balance_cents: -500 })).toEqual({ text: "Avance du client", tone: "green" });
    expect(accountStateBadge(base)).toEqual({ text: "Rien à régler", tone: "green" });
    for (const a of [{ ...base, balance_cents: -500 }, base]) expect(accountStateBadge(a).text).not.toMatch(/votre/);
  });

  it("retard et prochaine échéance : mêmes montants que ceux que lit le client (payNowSummary)", () => {
    // Centrale Express : solde 320 €, 55 € en retard, 10 € déclarés ; le client lit « À payer maintenant : 45 € » et
    // « Prochaine échéance : 5 nov. · 265 € »
    const a = { due_cents: 5500, declared_cents: 1000, next_due_at: "2026-11-05T22:59:59Z", next_due_cents: 32000 };
    expect(declaredSplit(a)).toEqual({ onLate: 1000, ahead: 0 });
    expect(nb(lateDeclaredNote(a)!)).toBe("dont 10 € déclarés, à confirmer");
    expect(aheadDeclaredNote(a)).toBeNull();
    const pay = payNowSummary({ ...a, balance_cents: 32000, days_overdue: 6, blocked: false }, Date.parse("2026-10-11T10:00:00Z"));
    expect(a.due_cents - declaredSplit(a).onLate).toBe(pay.amountCents);
    const next = nextDueInfo(a, "Europe/Paris")!;
    expect(nb(next.text)).toBe("Prochaine échéance : 5 nov. · 265 € (320 € avec le retard)");
    expect(nb(pay.next!)).toBe(nb(`Prochaine échéance : ${next.day} · ${next.amount}`));
    // Déclaré au-delà du retard : le reste est déclaré d'avance (le client ne voit plus rien « à payer maintenant »)
    expect(declaredSplit({ due_cents: 5500, declared_cents: 7000 })).toEqual({ onLate: 5500, ahead: 1500 });
    expect(nb(aheadDeclaredNote({ due_cents: 5500, declared_cents: 7000 })!)).toBe("15 € déclarés d'avance, à confirmer");
    expect(nb(lateDeclaredNote({ due_cents: 5500, declared_cents: 150 })!)).toBe("dont 1,50 € déclaré, à confirmer");
    // Sans retard : rien « dont », tout est d'avance ; l'échéance n'a pas de cumul avec le retard
    expect(lateDeclaredNote({ due_cents: 0, declared_cents: 1000 })).toBeNull();
    expect(nb(nextDueInfo({ due_cents: 0, next_due_at: "2026-11-05T22:59:59Z", next_due_cents: 23500 })!.text)).toBe("Prochaine échéance : 5 nov. · 235 €");
    expect(nextDueInfo({ due_cents: 5500, next_due_at: null, next_due_cents: 0 })).toBeNull();
  });

  it("compte sans frais ni historique : état vide ; un taux, un montant, une hausse annoncée ou un paiement suffisent à l'éviter", () => {
    const zero = {
      fee_percent: 0, fee_fixed_cents: 0, posted_cents: 0, received_cents: 0, declared_cents: 0, declared_count: 0, balance_cents: 0,
      pending_reductions_count: 0, scheduled_change: null,
    };
    expect(accountIsEmpty(zero, 0)).toBe(true);
    // Taux lu en texte (numeric de PostgreSQL) : « 0.00 » reste un taux nul
    expect(accountIsEmpty({ ...zero, fee_percent: "0.00" as unknown as number }, 0)).toBe(true);
    expect(accountIsEmpty({ ...zero, fee_fixed_cents: 500 }, 0)).toBe(false);
    expect(accountIsEmpty({ ...zero, fee_percent: 2.5 }, 0)).toBe(false);
    expect(accountIsEmpty({ ...zero, posted_cents: 500 }, 0)).toBe(false);
    expect(accountIsEmpty({ ...zero, received_cents: 1000, balance_cents: -1000 }, 1)).toBe(false);
    expect(accountIsEmpty({ ...zero, declared_count: 1, declared_cents: 1000 }, 1)).toBe(false);
    expect(accountIsEmpty(zero, 1)).toBe(false);
    expect(
      accountIsEmpty(
        { ...zero, scheduled_change: { id: "c", percent: 0, fixed_cents: 500, from_percent: 0, from_fixed_cents: 0, effective_at: "", effective_on: "2026-11-12", announced_at: "" } },
        0,
      ),
    ).toBe(false);
  });

  it("d'où vient l'argent : flotte sans les lignes des centrales restées à zéro ; centrale inchangée", () => {
    const a = { posted_cents: 600, collected_by_centrale_cents: 600, with_drivers_cents: 0, waived_by_centrale_cents: 0 } as PlatformAccount;
    expect(visibleOriginParts({ ...a, dispatch_model: "fleet" }).map((p) => p.key)).toEqual(["collected"]);
    expect(visibleOriginParts({ ...a, dispatch_model: "centrale" }).map((p) => p.key)).toEqual(["collected", "drivers", "waived"]);
    // Flotte passée par le modèle centrale : ses montants hérités restent affichés
    expect(visibleOriginParts({ ...a, posted_cents: 900, with_drivers_cents: 300, dispatch_model: "fleet" }).map((p) => p.key)).toEqual(["collected", "drivers"]);
    // Ajustements seulement s'il y en a (comme avant)
    expect(visibleOriginParts({ ...a, posted_cents: 400, dispatch_model: "centrale" }).map((p) => p.key)).toEqual(["collected", "drivers", "waived", "other"]);
  });

  it("relevé : 15 lignes d'emblée, repli des suivantes, reste dû ou avance du client", () => {
    expect(STATEMENT_FIRST_LINES).toBe(15);
    expect(moreLinesLabel(32)).toBe("Afficher les 32 autres lignes");
    expect(moreLinesLabel(1)).toBe("Afficher la dernière ligne");
    expect(balanceLabel(11500, "au 1er octobre 2026")).toBe("Reste dû au 1er octobre 2026");
    expect(balanceLabel(0, "à ce jour")).toBe("Reste dû à ce jour");
    expect(balanceLabel(-500, "fin septembre 2026")).toBe("Avance du client fin septembre 2026");
  });
});
