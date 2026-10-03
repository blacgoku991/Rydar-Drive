import { ERROR_MESSAGES } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Onglet « Réseau partagé » : vraies actions serveur de app/dashboard/reseau-partage/actions.ts, Supabase simulé.
// Rôles : réglages et argent réseau = owner / admin (refus avant tout appel pour un dispatcher) ; « Relancer » = tout
// membre. Noms et paramètres des RPC = contrat de packages/shared/src/network.ts (NetworkRpcs).

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  ctx: null as any,
  rpcCalls: [] as { fn: string; args: Row }[],
  rpcReply: {} as Record<string, { data?: unknown; error?: { code?: string; message?: string } | null }>,
  updates: [] as { table: string; values: Row; filters: [string, unknown][] }[],
  updateReply: { data: { id: "x" } as unknown, error: null as { code?: string; message?: string } | null },
  revalidated: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void h.revalidated.push(p) }));
vi.mock("@/lib/auth", () => ({ isAdminRole: (role: string) => role === "owner" || role === "admin" }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));

const A = await import("../app/dashboard/reseau-partage/actions");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RIDE = "11111111-1111-4111-8111-111111111111";
const EXEC = "22222222-2222-4222-8222-222222222222";
const DRIVER = "33333333-3333-4333-8333-333333333333";
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";

function context(role = "owner", model: "fleet" | "centrale" = "fleet") {
  return {
    org: { id: ORG, dispatch_model: model, name: "Taxi A" },
    role,
    user: { id: "manager-1" },
    supabase: {
      async rpc(fn: string, args: Row) {
        h.rpcCalls.push({ fn, args });
        const r = h.rpcReply[fn] ?? {};
        return { data: r.data ?? null, error: r.error ?? null };
      },
      from(table: string) {
        const entry = { table, values: {} as Row, filters: [] as [string, unknown][] };
        const b: any = {
          update(values: Row) {
            entry.values = values;
            h.updates.push(entry);
            return b;
          },
          eq(col: string, v: unknown) {
            entry.filters.push([col, v]);
            return b;
          },
          select: () => b,
          maybeSingle: async () => h.updateReply,
          then: (resolve: (v: unknown) => void) => resolve({ error: h.updateReply.error }),
        };
        return b;
      },
    },
  };
}

const settingsReply = (readiness: Row) => ({ data: { ok: true, membership: {}, readiness, closed_offers: 0 } });

beforeEach(() => {
  h.ctx = context();
  h.rpcCalls = [];
  h.updates = [];
  h.revalidated = [];
  h.updateReply = { data: { id: DRIVER }, error: null };
  h.rpcReply = {
    set_network_settings: settingsReply({
      share_out: { active: false, missing: ["approval_pending"], warnings: [] },
      share_in: { active: false, missing: ["not_receiving"], warnings: [] },
    }),
    confirm_settlements: { data: { ok: true, code: "CONFIRMED", count: 1, amount_cents: 1250 } },
    dispute_settlement: { data: { ok: true, code: "DISPUTED" } },
    waive_settlement: { data: { ok: true, code: "WAIVED" } },
    reopen_settlement: { data: { ok: true, code: "REOPENED" } },
    org_network_payout_info: {
      data: { settlement_id: SETTLEMENT, amount_cents: 3750, currency: "EUR", reference: "R1783", payee_name: "Karim Benali", iban: "FR7630006000011234567890189", bic: null, updated_at: "2026-09-01T10:00:00Z", warnings: [] },
    },
    validate_network_ride: { data: { ok: true, ride_id: RIDE, settlement: null } },
    contest_network_ride: { data: { ok: true, ride_id: RIDE, settlement: null, fee_reduction: { entry_id: "e-1", amount_cents: 500 } } },
    exclude_network_driver: { data: { ok: true, exclusion: {}, closed_offers: 0 } },
    lift_network_driver_exclusion: { data: { ok: true } },
    set_network_exclusion: { data: { ok: true } },
    set_driver_network_allowed: { data: { ok: true, driver_id: DRIVER, allowed: false, closed_offers: 2 } },
    remind_network_driver: { data: { ok: true, code: "REMINDED" } },
  };
});

/** Toutes les actions réservées au propriétaire et aux administrateurs, appelées avec des arguments valides. */
const ADMIN_ONLY: [string, () => Promise<{ ok: boolean }>][] = [
  ["setNetworkSharing", () => A.setNetworkSharing({ side: "out", enabled: true, termsVersion: "2026-11-01" })],
  ["acceptNetworkTerms", () => A.acceptNetworkTerms("2026-11-01")],
  ["setNetworkInsurance", () => A.setNetworkInsurance(true)],
  ["setExecutorCreditLimit", () => A.setExecutorCreditLimit({ amount: "150" })],
  ["setNetworkPartnerExcluded", () => A.setNetworkPartnerExcluded(PARTNER, true)],
  ["setDriverNetworkAllowed", () => A.setDriverNetworkAllowed(DRIVER, false)],
  ["setDriverOperatorRegistration", () => A.setDriverOperatorRegistration(DRIVER, "EVTC075120001")],
  ["updateNetworkPaymentMethods", () => A.updateNetworkPaymentMethods({ methods: ["cash", "link"], link: "https://revolut.me/taxi/{montant}" })],
  ["confirmNetworkSettlement", () => A.confirmNetworkSettlement(SETTLEMENT, "cash")],
  ["disputeNetworkSettlement", () => A.disputeNetworkSettlement(SETTLEMENT, "Rien reçu")],
  ["waiveNetworkSettlement", () => A.waiveNetworkSettlement(SETTLEMENT, "Geste commercial")],
  ["reopenNetworkSettlement", () => A.reopenNetworkSettlement(SETTLEMENT)],
  ["getNetworkPayoutInfo", () => A.getNetworkPayoutInfo(SETTLEMENT)],
  ["validateNetworkRide", () => A.validateNetworkRide(RIDE)],
  ["contestNetworkRide", () => A.contestNetworkRide(RIDE, "Course non effectuée")],
  ["excludeNetworkDriver", () => A.excludeNetworkDriver(EXEC, "Retards")],
  ["liftNetworkDriverExclusion", () => A.liftNetworkDriverExclusion(EXEC)],
];

describe("rôles", () => {
  it("dispatcher : toute action de réglage ou d'argent réseau refusée sans appel à la base", async () => {
    h.ctx = context("dispatcher");
    for (const [name, run] of ADMIN_ONLY) {
      const res = await run();
      expect(res, name).toMatchObject({ ok: false, error: "Réservé au propriétaire et aux administrateurs de l'organisation." });
    }
    expect(h.rpcCalls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("dispatcher : « Relancer » permis (application seulement), envers l'organisation courante", async () => {
    h.ctx = context("dispatcher");
    expect(await A.remindNetworkDriver(SETTLEMENT)).toMatchObject({ ok: true, code: "REMINDED" });
    expect(h.rpcCalls).toEqual([{ fn: "remind_network_driver", args: { p_org: ORG, p_settlement: SETTLEMENT } }]);
  });

  it("admin : toutes les actions passent (rôle revérifié en base)", async () => {
    h.ctx = context("admin");
    for (const [name, run] of ADMIN_ONLY) expect((await run()).ok, name).toBe(true);
  });

  it("sans session ni organisation active : refus", async () => {
    h.ctx = null;
    expect(await A.remindNetworkDriver(SETTLEMENT)).toMatchObject({ ok: false });
    expect(await A.setNetworkInsurance(true)).toMatchObject({ ok: false });
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("réglages : set_network_settings (paramètres NULL = inchangés)", () => {
  it("première activation du partage : convention acceptée, tous les paramètres transmis", async () => {
    const res = await A.setNetworkSharing({ side: "out", enabled: true, termsVersion: "2026-11-01" });
    expect(h.rpcCalls).toEqual([
      {
        fn: "set_network_settings",
        args: { p_org: ORG, p_share_out: true, p_share_in: null, p_terms_version: "2026-11-01", p_insurance_confirmed: null, p_executor_credit_limit_cents: null },
      },
    ]);
    expect(res).toMatchObject({ ok: true, message: "Demande enregistrée : en attente de validation par Rydar." });
    expect(h.revalidated).toEqual(["/dashboard/reseau-partage", "/dashboard"]);
  });

  it("coupure de la réception : offres retirées annoncées, courses acceptées au bout", async () => {
    h.rpcReply.set_network_settings = { data: { ok: true, membership: {}, readiness: null, closed_offers: 2 } };
    const res = await A.setNetworkSharing({ side: "in", enabled: false });
    expect(h.rpcCalls[0]!.args).toMatchObject({ p_share_in: false, p_share_out: null, p_terms_version: null });
    expect(res).toMatchObject({ ok: true, message: "Réception des courses du réseau désactivée · 2 offres en attente retirées. Les courses déjà acceptées vont à leur terme." });
  });

  it("plafond par chauffeur : euros → centimes, borné à 1 000 €", async () => {
    expect(await A.setExecutorCreditLimit({ amount: "150,50" })).toMatchObject({ ok: true, cents: 15_050 });
    expect(h.rpcCalls[0]!.args.p_executor_credit_limit_cents).toBe(15_050);
    const tooHigh = await A.setExecutorCreditLimit({ amount: "2000" });
    expect(tooHigh).toMatchObject({ ok: false, fieldErrors: { amount: "Entre 0 et 1 000 €" } });
    const invalid = await A.setExecutorCreditLimit({ amount: "abc" });
    expect(invalid).toMatchObject({ ok: false, error: "Plafond par chauffeur : montant invalide (ex. 150)" });
    expect(h.rpcCalls).toHaveLength(1);
  });

  it("erreur métier de la base → message lisible (ERROR_MESSAGES)", async () => {
    h.rpcReply.set_network_settings = { error: { code: "P0001", message: "NETWORK_TERMS_REQUIRED" } };
    expect(await A.setNetworkSharing({ side: "out", enabled: true })).toEqual({ ok: false, error: ERROR_MESSAGES.NETWORK_TERMS_REQUIRED });
    h.rpcReply.set_network_settings = { error: { code: "42501", message: "FORBIDDEN" } };
    expect(await A.setNetworkSharing({ side: "out", enabled: true })).toEqual({ ok: false, error: "Accès refusé." });
  });

  it("version de convention invalide refusée sans appel", async () => {
    expect(await A.acceptNetworkTerms("")).toMatchObject({ ok: false });
    expect(await A.setNetworkSharing({ side: "out", enabled: true, termsVersion: "x".repeat(41) })).toMatchObject({ ok: false });
    expect(h.rpcCalls).toEqual([]);
  });

  it("n° d'exploitant VTC : écrit sur la fiche de l'organisation seulement, vide = retiré, trop court refusé", async () => {
    expect(await A.setDriverOperatorRegistration(DRIVER, "  EVTC075120001 ")).toMatchObject({ ok: true });
    expect(h.updates[0]).toEqual({ table: "drivers", values: { vtc_operator_registration: "EVTC075120001" }, filters: [["id", DRIVER], ["organization_id", ORG]] });
    expect(await A.setDriverOperatorRegistration(DRIVER, "")).toMatchObject({ ok: true, message: "N° d'exploitant VTC retiré." });
    expect(await A.setDriverOperatorRegistration(DRIVER, "ab")).toMatchObject({ ok: false, fieldErrors: { value: "3 caractères au minimum" } });
    h.updateReply = { data: null, error: null };
    expect(await A.setDriverOperatorRegistration(DRIVER, "EVTC1")).toEqual({ ok: false, error: "Chauffeur introuvable." });
  });
});

describe("moyens de paiement (flotte) : même schéma que « Commission & encaissement »", () => {
  it("flotte : colonnes settlement_* écrites, IBAN normalisé", async () => {
    const res = await A.updateNetworkPaymentMethods({ methods: ["transfer", "cash"], iban: "fr76 3000 6000 0112 3456 7890 189", payeeName: "Taxi A SAS", bic: "agrifrpp" });
    expect(res).toMatchObject({ ok: true });
    expect(h.updates[0]).toEqual({
      table: "organization_settings",
      values: {
        settlement_methods: ["transfer", "cash"], settlement_link: null, settlement_instructions: null, settlement_payee_name: "Taxi A SAS",
        settlement_iban: "FR7630006000011234567890189", settlement_bic: "AGRIFRPP",
      },
      filters: [["organization_id", ORG]],
    });
  });

  it("moyen coché sans ses coordonnées : erreur par champ, rien d'écrit", async () => {
    const res = await A.updateNetworkPaymentMethods({ methods: ["transfer"] });
    expect(res).toMatchObject({ ok: false, fieldErrors: { iban: "Ajoutez votre IBAN (ou retirez « Virement »)" } });
    expect(h.updates).toEqual([]);
  });

  it("centrale : une seule source (Réglages › Commission & encaissement)", async () => {
    h.ctx = context("owner", "centrale");
    expect(await A.updateNetworkPaymentMethods({ methods: ["cash"] })).toMatchObject({ ok: false });
    expect(h.updates).toEqual([]);
  });

  it("dernier moyen en ligne retiré pendant le partage : refus de la base traduit", async () => {
    h.updateReply = { data: null, error: { code: "55000", message: "NETWORK_PAYMENT_METHODS_REQUIRED" } };
    expect(await A.updateNetworkPaymentMethods({ methods: ["cash"] })).toEqual({ ok: false, error: ERROR_MESSAGES.NETWORK_PAYMENT_METHODS_REQUIRED });
  });
});

describe("courses confiées : règlements et décisions", () => {
  it("« Reçu » / « Versé » : confirm_settlements sur la seule ligne, note nettoyée", async () => {
    expect(await A.confirmNetworkSettlement(SETTLEMENT, "transfer", "  ")).toMatchObject({ ok: true, amountCents: 1250 });
    expect(h.rpcCalls).toEqual([{ fn: "confirm_settlements", args: { p_ids: [SETTLEMENT], p_method: "transfer", p_note: null } }]);
  });

  it("refus en base renvoyé tel quel (ex. versement retenu)", async () => {
    h.rpcReply.confirm_settlements = { error: { code: "55000", message: "NETWORK_PAYOUT_ON_HOLD" } };
    expect(await A.confirmNetworkSettlement(SETTLEMENT, null)).toEqual({ ok: false, error: ERROR_MESSAGES.NETWORK_PAYOUT_ON_HOLD });
    h.rpcReply.waive_settlement = { error: { code: "42501", message: "NETWORK_SETTLEMENT_ACTION_FORBIDDEN" } };
    expect(await A.waiveNetworkSettlement(SETTLEMENT, "Geste")).toEqual({ ok: false, error: ERROR_MESSAGES.NETWORK_SETTLEMENT_ACTION_FORBIDDEN });
  });

  it("arguments invalides refusés sans appel", async () => {
    expect(await A.confirmNetworkSettlement("pas-un-uuid", "cash")).toMatchObject({ ok: false });
    expect(await A.confirmNetworkSettlement(SETTLEMENT, "bitcoin" as never)).toMatchObject({ ok: false });
    expect(await A.disputeNetworkSettlement(SETTLEMENT, " a ")).toMatchObject({ ok: false });
    expect(await A.contestNetworkRide(RIDE, "trop")).toMatchObject({ ok: false });
    expect(await A.excludeNetworkDriver("x")).toMatchObject({ ok: false });
    expect(h.rpcCalls).toEqual([]);
  });

  it("« Contester la course » : motif borné à 300 caractères, baisse des frais annoncée", async () => {
    const res = await A.contestNetworkRide(RIDE, "Le client n'a jamais été pris en charge. ".repeat(20));
    expect(res).toMatchObject({ ok: true, feeReductionCents: 500 });
    expect((h.rpcCalls[0]!.args.p_reason as string).length).toBeLessThanOrEqual(300);
  });

  it("RIB pour un versement : org_network_payout_info (consultation journalisée en base)", async () => {
    const res = await A.getNetworkPayoutInfo(SETTLEMENT);
    expect(res).toMatchObject({ ok: true, info: { reference: "R1783", payee_name: "Karim Benali" } });
    expect(h.rpcCalls).toEqual([{ fn: "org_network_payout_info", args: { p_settlement: SETTLEMENT } }]);
  });

  it("exclusions : chauffeur (par exécution), organisation (symétrique), levée", async () => {
    await A.excludeNetworkDriver(EXEC, "");
    await A.setNetworkPartnerExcluded(PARTNER, true);
    await A.liftNetworkDriverExclusion(EXEC);
    await A.setDriverNetworkAllowed(DRIVER, false);
    expect(h.rpcCalls).toEqual([
      { fn: "exclude_network_driver", args: { p_execution: EXEC, p_reason: null } },
      { fn: "set_network_exclusion", args: { p_org: ORG, p_partner: PARTNER, p_excluded: true } },
      { fn: "lift_network_driver_exclusion", args: { p_org: ORG, p_id: EXEC } },
      { fn: "set_driver_network_allowed", args: { p_driver: DRIVER, p_allowed: false } },
    ]);
  });

  it("« Relancer » trop tôt : message clair", async () => {
    h.rpcReply.remind_network_driver = { data: { ok: false, code: "TOO_SOON" } };
    expect(await A.remindNetworkDriver(SETTLEMENT)).toEqual({ ok: false, error: "Déjà relancé il y a moins de 30 minutes." });
  });
});
