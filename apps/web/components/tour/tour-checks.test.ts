import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

// Visite guidée (docs/TUTORIEL.md § 8) : conditions de réussite des étapes — règles pures (commission réglable,
// coordonnées de paiement de Rydar, étape faite) et lectures de loadTourChecks avec un client simulé : bonne table,
// bonnes colonnes, bons filtres, comptages `head` (attributions : existence bornée à une ligne, sur 30 jours),
// seulement les clés demandées, erreur → clé absente (« inconnue »),
// jamais d'exception. « Éditeur » et « Identité de votre entreprise » reprennent les règles existantes (adminLegalTodo,
// bookingOperatorGaps). Modules « @/ » résolus à la main.

vi.mock("@/lib/wording", async () => await import("../../lib/wording"));

const { ASSIGNED_WINDOW_DAYS, CHECK_KEYS, billingConfigured, loadTourChecks, settlementReady, stepDone } = await import("./tour-checks");
const { TOURS, tourCheckKeys } = await import("./tour-content");
type CheckKey = import("./tour-checks").CheckKey;
type TourScope = import("./tour-model").TourScope;

// ------------------------------------------------------------------------------------------------- client simulé
type Filter = [op: string, column: string, value: unknown];
type Call = { table: string; columns: string; options: unknown; filters: Filter[]; single: boolean };
type Reply = { data?: unknown; error?: unknown; count?: number | null };

/** Client simulé : chaque `from()` est noté (colonnes, options, filtres, maybeSingle) ; la réponse vient de `reply`. */
function fakeClient(reply: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, columns: "", options: undefined, filters: [], single: false };
      calls.push(call);
      const builder = {
        select(columns: string, options?: unknown) {
          call.columns = columns;
          call.options = options;
          return builder;
        },
        eq: (column: string, value: unknown) => (call.filters.push(["eq", column, value]), builder),
        neq: (column: string, value: unknown) => (call.filters.push(["neq", column, value]), builder),
        is: (column: string, value: unknown) => (call.filters.push(["is", column, value]), builder),
        not: (column: string, op: string, value: unknown) => (call.filters.push([`not.${op}`, column, value]), builder),
        gte: (column: string, value: unknown) => (call.filters.push(["gte", column, value]), builder),
        limit: (count: number) => (call.filters.push(["limit", "", count]), builder),
        maybeSingle() {
          call.single = true;
          return builder;
        },
        then<A, B>(resolve: (r: Reply) => A, reject?: (e: unknown) => B) {
          return Promise.resolve()
            .then(() => reply(call))
            .then(resolve, reject);
        },
      };
      return builder;
    },
    // Toute autre méthode (rpc, auth…) : interdite ici
    rpc: () => {
      throw new Error("rpc inattendu");
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const SCOPE: TourScope = { userId: "u-1", orgId: "org-1", driverId: "drv-1" };
const HEAD = { count: "exact", head: true };
/** Borne de date « maintenant − 30 jours » des attributions (voir normalized) */
const SINCE_30_DAYS = "<maintenant − 30 jours>";
const ok = (count: number): Reply => ({ data: null, error: null, count });
const row = (data: unknown): Reply => ({ data, error: null });
const fail: Reply = { data: null, error: { code: "42501", message: "permission denied" }, count: null };

const IDENTITY_OK = {
  legal_name: "Taxi Lumière SAS",
  siret: "123 456 789 00012",
  address: "12 rue des Lilas",
  postal_code: "75011",
  city: "Paris",
  vtc_registration: "EVTC075230001",
};

/** Lecture attendue de chaque clé (§ 8) : table, colonnes, options, filtres, maybeSingle. */
const EXPECTED: Record<CheckKey, Omit<Call, "options"> & { head: boolean }> = {
  legal_editor: { table: "platform_legal", columns: "company_name, address, registration", filters: [], single: true, head: false },
  platform_billing: { table: "platform_billing", columns: "iban, payment_link", filters: [], single: true, head: false },
  plans: { table: "plans", columns: "id", filters: [["eq", "is_active", true]], single: false, head: true },
  clients: { table: "organizations", columns: "id", filters: [["neq", "status", "archived"]], single: false, head: true },
  org_identity: {
    table: "organizations",
    columns: "legal_name, siret, address, postal_code, city, vtc_registration",
    filters: [["eq", "id", "org-1"]],
    single: true,
    head: false,
  },
  pricing: { table: "pricing_rules", columns: "id", filters: [["eq", "organization_id", "org-1"], ["eq", "is_active", true]], single: false, head: true },
  drivers: { table: "drivers", columns: "id", filters: [["eq", "organization_id", "org-1"], ["is", "deleted_at", null]], single: false, head: true },
  join_link: { table: "organizations", columns: "join_code, join_enabled", filters: [["eq", "id", "org-1"]], single: true, head: false },
  settlement: {
    table: "organization_settings",
    columns: "settlement_methods, settlement_link, settlement_iban, settlement_instructions",
    filters: [["eq", "organization_id", "org-1"]],
    single: true,
    head: false,
  },
  first_ride: { table: "rides", columns: "id", filters: [["eq", "organization_id", "org-1"]], single: false, head: true },
  team: { table: "organization_users", columns: "id", filters: [["eq", "organization_id", "org-1"]], single: false, head: true },
  my_ride: { table: "rides", columns: "id", filters: [["eq", "organization_id", "org-1"], ["eq", "created_by", "u-1"]], single: false, head: true },
  // Attributions manuelles faites par l'utilisateur, 30 derniers jours, existence (une ligne au plus), jamais un comptage
  my_ride_assigned: {
    table: "ride_events",
    columns: "id",
    filters: [
      ["eq", "organization_id", "org-1"],
      ["eq", "type", "ride.assigned_manually"],
      ["eq", "actor_id", "u-1"],
      ["gte", "created_at", SINCE_30_DAYS],
      ["limit", "", 1],
    ],
    single: false,
    head: false,
  },
  fp_taken: { table: "rides", columns: "id", filters: [["eq", "organization_id", "org-1"], ["eq", "driver_id", "drv-1"]], single: false, head: true },
};

/** Réponse « faite » pour chaque clé (le seuil compris : au moins 2 membres pour l'équipe). */
const DONE: Record<CheckKey, Reply> = {
  legal_editor: row({ company_name: "Rydar SAS", address: "1 rue de la Paix, 75002 Paris", registration: "RCS Paris 900 000 000" }),
  platform_billing: row({ iban: "FR7630006000011234567890189", payment_link: null }),
  plans: ok(1),
  clients: ok(1),
  org_identity: row(IDENTITY_OK),
  pricing: ok(1),
  drivers: ok(1),
  join_link: row({ join_code: "abc123", join_enabled: true }),
  settlement: row({ settlement_methods: ["link", "cash"], settlement_link: "https://pay.exemple.fr/{reference}", settlement_iban: null, settlement_instructions: null }),
  first_ride: ok(1),
  team: ok(2),
  my_ride: ok(1),
  my_ride_assigned: row([{ id: 4242 }]),
  fp_taken: ok(3),
};

/** Réponse « pas encore faite » pour chaque clé. */
const NOT_DONE: Record<CheckKey, Reply> = {
  legal_editor: row({ company_name: "Rydar SAS", address: "  ", registration: "RCS Paris 900 000 000" }),
  platform_billing: row({ iban: null, payment_link: null }),
  plans: ok(0),
  clients: ok(0),
  org_identity: row({ ...IDENTITY_OK, siret: "1234567890001" }),
  pricing: ok(0),
  drivers: ok(0),
  join_link: row({ join_code: "abc123", join_enabled: false }),
  settlement: row({ settlement_methods: ["link", "cash"], settlement_link: null, settlement_iban: null, settlement_instructions: null }),
  first_ride: ok(0),
  team: ok(1),
  my_ride: ok(0),
  my_ride_assigned: row([]),
  fp_taken: ok(0),
};

/**
 * Filtres d'un appel, borne de date remplacée par SINCE_30_DAYS si elle vaut « maintenant − 30 jours » (à la minute
 * près, horodatage ISO) : sinon gardée telle quelle (et la comparaison échoue).
 */
function normalized(filters: Filter[]): Filter[] {
  return filters.map(([op, column, value]): Filter => {
    if (op !== "gte" || column !== "created_at" || typeof value !== "string") return [op, column, value];
    const at = Date.parse(value);
    const expected = Date.now() - ASSIGNED_WINDOW_DAYS * 86_400_000;
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Math.abs(at - expected) < 60_000 ? [op, column, SINCE_30_DAYS] : [op, column, value];
  });
}

/** Clé lue par un appel (table + colonnes + filtres : unique par clé). */
const keyOf = (call: Call): CheckKey => {
  const key = CHECK_KEYS.find((k) => {
    const e = EXPECTED[k];
    return e.table === call.table && e.columns === call.columns && JSON.stringify(e.filters) === JSON.stringify(normalized(call.filters));
  });
  if (!key) throw new Error(`lecture inattendue : ${call.table} (${call.columns}) ${JSON.stringify(call.filters)}`);
  return key;
};

// ------------------------------------------------------------------------------------------------- règles pures
describe("settlementReady (commission réglable par les chauffeurs)", () => {
  const s = (methods: string[] | null, more: { link?: string | null; iban?: string | null; instructions?: string | null } = {}) => ({
    settlement_methods: methods,
    settlement_link: more.link ?? null,
    settlement_iban: more.iban ?? null,
    settlement_instructions: more.instructions ?? null,
  });

  it("réglage par défaut (lien + espèces, sans lien) : non", () => {
    expect(settlementReady(s(["link", "cash"]))).toBe(false);
  });
  it("lien de paiement renseigné : oui (seul ou avec les espèces)", () => {
    expect(settlementReady(s(["link", "cash"], { link: "https://pay.exemple.fr/{reference}" }))).toBe(true);
    expect(settlementReady(s(["link"], { link: "https://pay.exemple.fr" }))).toBe(true);
  });
  it("virement avec IBAN : oui ; sans IBAN : non ; avec consignes seules (réglages antérieurs, comme la base) : oui", () => {
    expect(settlementReady(s(["transfer"], { iban: "FR7630006000011234567890189" }))).toBe(true);
    expect(settlementReady(s(["transfer", "cash"]))).toBe(false);
    expect(settlementReady(s(["transfer"], { instructions: "Virement au RIB transmis par e-mail" }))).toBe(true);
  });
  it("autre moyen décrit : oui ; sans consignes : non", () => {
    expect(settlementReady(s(["other"], { instructions: "Wero au 06 12 34 56 78" }))).toBe(true);
    expect(settlementReady(s(["other", "cash"]))).toBe(false);
  });
  it("espèces seules choisies : oui", () => {
    expect(settlementReady(s(["cash"]))).toBe(true);
  });
  it("un moyen renseigné mais non coché ne compte pas", () => {
    expect(settlementReady(s(["cash", "link"], { iban: "FR7630006000011234567890189", instructions: "Wero" }))).toBe(false);
  });
  it("ligne absente ou moyens absents : non", () => {
    expect(settlementReady(null)).toBe(false);
    expect(settlementReady(undefined)).toBe(false);
    expect(settlementReady(s(null))).toBe(false);
    expect(settlementReady(s([]))).toBe(false);
  });
});

describe("billingConfigured (coordonnées de paiement de Rydar, comme BillingCard)", () => {
  it("IBAN ou lien de paiement : oui ; ni l'un ni l'autre : non", () => {
    expect(billingConfigured({ iban: "FR7630006000011234567890189", payment_link: null })).toBe(true);
    expect(billingConfigured({ iban: null, payment_link: "https://pay.rydar.app/{reference}" })).toBe(true);
    expect(billingConfigured({ iban: null, payment_link: null })).toBe(false);
    expect(billingConfigured({ iban: "", payment_link: "" })).toBe(false);
    expect(billingConfigured(null)).toBe(false);
  });
  it("même règle que la carte du super admin (admin-billing.tsx)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dirname, "..", "platform-fees", "admin-billing.tsx"), "utf8");
    expect(src).toContain("const configured = !!(billing.iban || billing.payment_link);");
  });
});

describe("stepDone (étape faite)", () => {
  it("sans condition : inconnue", () => {
    expect(stepDone(undefined, { pricing: true })).toBeUndefined();
    expect(stepDone({ any: [] }, { pricing: true })).toBeUndefined();
  });
  it("clés inconnues : inconnue ; une clé vraie : faite ; clés lues et fausses : pas faite", () => {
    expect(stepDone({ any: ["drivers", "join_link"] }, {})).toBeUndefined();
    expect(stepDone({ any: ["drivers", "join_link"] }, { join_link: true })).toBe(true);
    expect(stepDone({ any: ["drivers", "join_link"] }, { drivers: false })).toBe(false);
    expect(stepDone({ any: ["drivers", "join_link"] }, { drivers: false, join_link: false })).toBe(false);
    expect(stepDone({ any: ["drivers", "join_link"] }, { drivers: true, join_link: false })).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------- lectures
describe("loadTourChecks : lectures du § 8", () => {
  it("chaque clé : sa table, ses colonnes, ses filtres ; comptages en head, lignes uniques par maybeSingle", async () => {
    for (const key of CHECK_KEYS) {
      const { client, calls } = fakeClient(() => DONE[key]);
      await loadTourChecks(client, [key], SCOPE);
      expect(calls, key).toHaveLength(1);
      const [call] = calls;
      const expected = EXPECTED[key];
      expect({ table: call!.table, columns: call!.columns, filters: normalized(call!.filters), single: call!.single }, key).toEqual({
        table: expected.table,
        columns: expected.columns,
        filters: expected.filters,
        single: expected.single,
      });
      if (expected.head) expect(call!.options, key).toEqual(HEAD);
      else expect(call!.options, key).toBeUndefined();
    }
  });

  it("faites → vrai ; pas encore faites → faux (seuils compris : 1 course, 2 membres)", async () => {
    for (const [replies, want] of [
      [DONE, true],
      [NOT_DONE, false],
    ] as const) {
      const { client } = fakeClient((call) => replies[keyOf(call)]);
      const checks = await loadTourChecks(client, CHECK_KEYS, SCOPE);
      expect(Object.keys(checks).sort()).toEqual([...CHECK_KEYS].sort());
      for (const key of CHECK_KEYS) expect(checks[key], key).toBe(want);
    }
  });

  it("règles existantes reprises : éditeur (« À traiter »), identité (pastille « À compléter », SIRET à 14 chiffres)", async () => {
    const run = async (key: CheckKey, reply: Reply) => (await loadTourChecks(fakeClient(() => reply).client, [key], SCOPE))[key];
    // Éditeur : aucune ligne ou un champ vide → à faire
    expect(await run("legal_editor", row(null))).toBe(false);
    expect(await run("legal_editor", row({ company_name: "Rydar SAS", address: "Paris", registration: null }))).toBe(false);
    // Identité : chaque manque compte
    expect(await run("org_identity", row(null))).toBe(false);
    for (const field of Object.keys(IDENTITY_OK)) {
      expect(await run("org_identity", row({ ...IDENTITY_OK, [field]: "" })), field).toBe(false);
    }
    // Lien d'inscription : code sans activation, activation sans code
    expect(await run("join_link", row({ join_code: null, join_enabled: true }))).toBe(false);
    expect(await run("join_link", row(null))).toBe(false);
  });

  it("« Attribuer une course » : l'attribution manuelle elle-même (ride_events), par l'utilisateur, sur 30 jours, quel que soit l'auteur de la course", async () => {
    const run = async (reply: Reply) => {
      const { client, calls } = fakeClient(() => reply);
      return { checks: await loadTourChecks(client, ["my_ride_assigned"], SCOPE), calls };
    };
    // Une attribution trouvée (course créée par le gérant, attribuée par le dispatcher : constat de la revue) → faite
    const one = await run(row([{ id: 1 }]));
    expect(one.checks).toEqual({ my_ride_assigned: true });
    // Lecture d'existence : jamais les courses (auteur, chauffeur), jamais un comptage de tous les événements
    expect(one.calls.map((c) => c.table)).toEqual(["ride_events"]);
    expect(one.calls[0]!.options).toBeUndefined();
    expect(one.calls[0]!.filters).toContainEqual(["limit", "", 1]);
    const since = one.calls[0]!.filters.find(([op]) => op === "gte")![2] as string;
    expect(Math.abs(Date.parse(since) - (Date.now() - 30 * 86_400_000))).toBeLessThan(60_000);
    // Aucune attribution (course créée puis acceptée par un chauffeur : rien dans ride_events) → pas faite
    expect((await run(row([]))).checks).toEqual({ my_ride_assigned: false });
    // Erreur ou réponse sans liste → inconnue
    expect((await run(fail)).checks).toEqual({});
    expect((await run(row(null))).checks).toEqual({});
  });

  it("lecture en erreur, nombre absent ou exception : clé absente, jamais d'exception ; les autres clés sont rendues", async () => {
    const { client } = fakeClient((call) => {
      const key = keyOf(call);
      if (key === "pricing") return fail;
      if (key === "drivers") return { data: null, error: null, count: null };
      if (key === "settlement") throw new Error("réseau coupé");
      if (key === "org_identity") return Promise.reject(new Error("requête interrompue"));
      if (key === "join_link") return { data: { join_code: "abc123", join_enabled: true }, error: fail.error };
      return DONE[key];
    });
    const keys = tourCheckKeys(TOURS.centrale);
    const checks = await loadTourChecks(client, keys, SCOPE);
    expect(checks).toEqual({ first_ride: true });
    expect("pricing" in checks).toBe(false);
    // Ligne unique en erreur (même avec des données) : inconnue, pas « pas faite »
    const single = await loadTourChecks(fakeClient(() => ({ data: null, error: fail.error })).client, ["legal_editor", "platform_billing", "settlement"], SCOPE);
    expect(single).toEqual({});
  });

  it("seulement les clés demandées, chacune une fois (doublons ignorés) ; aucune clé : aucune lecture", async () => {
    const { client, calls } = fakeClient((call) => DONE[keyOf(call)]);
    const checks = await loadTourChecks(client, ["pricing", "first_ride", "pricing"], SCOPE);
    expect(calls.map(keyOf).sort()).toEqual(["first_ride", "pricing"]);
    expect(checks).toEqual({ pricing: true, first_ride: true });
    const none = fakeClient(() => ok(1));
    expect(await loadTourChecks(none.client, [], SCOPE)).toEqual({});
    expect(none.calls).toHaveLength(0);
  });

  it("chaque parcours ne lit que ses propres clés (§ 7)", async () => {
    for (const def of Object.values(TOURS)) {
      const keys = tourCheckKeys(def);
      const { client, calls } = fakeClient((call) => DONE[keyOf(call)]);
      const checks = await loadTourChecks(client, keys, SCOPE);
      expect(calls.map(keyOf).sort(), def.key).toEqual([...keys].sort());
      expect(Object.keys(checks).sort(), def.key).toEqual([...keys].sort());
    }
  });

  it("organisation, compte ou fiche absents : clés concernées inconnues, sans lecture", async () => {
    const { client, calls } = fakeClient((call) => DONE[keyOf(call)]);
    const noOrg = await loadTourChecks(client, CHECK_KEYS, { userId: "u-1", orgId: null, driverId: null });
    // Super admin : seules les lectures de la plateforme
    expect(Object.keys(noOrg).sort()).toEqual(["clients", "legal_editor", "plans", "platform_billing"]);
    expect(calls.map((c) => c.table).sort()).toEqual(["organizations", "plans", "platform_billing", "platform_legal"]);
    // Sans fiche chauffeur (organisation standard) : « fp_taken » inconnue, le reste lu
    const noDriver = fakeClient((call) => DONE[keyOf(call)]);
    const checks = await loadTourChecks(noDriver.client, ["fp_taken", "first_ride"], { userId: "u-1", orgId: "org-1", driverId: null });
    expect(checks).toEqual({ first_ride: true });
    expect(noDriver.calls.map(keyOf)).toEqual(["first_ride"]);
  });

  it("lectures en parallèle (aucune n'attend la précédente)", async () => {
    let pending = 0;
    let most = 0;
    const { client } = fakeClient(async (call) => {
      pending++;
      most = Math.max(most, pending);
      await new Promise((r) => setTimeout(r, 5));
      pending--;
      return DONE[keyOf(call)];
    });
    await loadTourChecks(client, tourCheckKeys(TOURS.fleet), SCOPE);
    expect(most).toBe(tourCheckKeys(TOURS.fleet).length);
  });
});

describe("relecture des conditions (§ 6.9, fournisseur)", () => {
  it("après un enregistrement : envoi de formulaire ou clic sur un bouton de la page (hors visite), 1,5 s puis 5 s après", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dirname, "tour-provider.tsx"), "utf8");
    const sync = src.slice(src.indexOf("function TourChecksSync"));
    expect(sync).toContain('document.addEventListener("submit", settle, true);');
    expect(sync).toContain('document.addEventListener("click", onClick, true);');
    expect(sync).toContain(`closest("button, [role='menuitem']")`);
    expect(sync).toContain('!button.closest("[data-tour-card], [data-tour-pill]")');
    expect(sync).toMatch(/setTimeout\(reload, 1500\)[\s\S]*setTimeout\(reload, 5000\)/);
    // Lectures par le client du navigateur seulement (RLS de l'utilisateur), jamais d'écriture
    expect(sync).toContain("loadTourChecks(getBrowserClient(), keys,");
  });
});

describe("conditions des parcours (§ 7, § 8)", () => {
  it("chaque clé de condition est connue et chaque clé est utilisée par au moins un parcours", () => {
    const used = new Set(Object.values(TOURS).flatMap((def) => tourCheckKeys(def)));
    for (const key of used) expect(CHECK_KEYS).toContain(key);
    expect([...used].sort()).toEqual([...CHECK_KEYS].sort());
  });
  it("conditions attendues par étape (§ 7.2 à § 7.6)", () => {
    const byStep = Object.fromEntries(Object.values(TOURS).flatMap((def) => def.steps.map((s) => [s.id, s.check?.any ?? []])));
    expect(byStep).toEqual({
      "sa-legal": ["legal_editor"],
      "sa-billing": ["platform_billing"],
      "sa-plans": ["plans"],
      "sa-client": ["clients"],
      "sa-daily": [],
      "fl-identity": ["org_identity"],
      "fl-pricing": ["pricing"],
      "fl-drivers": ["drivers"],
      "fl-ride": ["first_ride"],
      "fl-team": ["team"],
      "ce-identity": ["org_identity"],
      "ce-pricing": ["pricing"],
      "ce-commission": ["settlement"],
      "ce-drivers": ["drivers", "join_link"],
      "ce-ride": ["first_ride"],
      "di-live": [],
      "di-new": ["my_ride"],
      "di-assign": ["my_ride_assigned"],
      "di-messages": [],
      "di-journal": [],
      "fp-first-steps": [],
      "fp-confirm": ["fp_taken"],
      "fp-delays": [],
      "fp-agenda": [],
      "fp-site": [],
    });
  });
});
