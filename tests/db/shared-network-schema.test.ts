// Réseau partagé, lot 2 — schéma, gardes et droits (20260924006700_shared_network_schema).
//
// Aucune fonction ne propose ni n'accepte encore de course partagée (dispatch : lot 006800) : les étapes du futur
// dispatch sont reproduites ici par des écritures directes (rôle propriétaire, comme une fonction security definer),
// pour vérifier que la base elle-même (clés étrangères, gardes G1-G13, policies, droits) n'autorise que les cas
// prévus — et qu'interrupteur coupé, rien n'est exploitable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  NETWORK_COUNTERPARTIES, NETWORK_EXECUTION_END_REASONS, NETWORK_ORG_REASONS, NETWORK_PARAMS, NETWORK_SHARE_CLOSED_REASONS,
  NETWORK_SHARE_STATUSES, NETWORK_SUSPECT_REASONS, NETWORK_TERMS_VERSION,
} from "../../packages/shared/src/network";
import {
  acceptDriverTerms, approveNetwork, as, CHAMPS_ELYSEES, createDriver, createMember, createOrg, createRideAsOwner,
  enableNetwork, expectPgError, insertRideBypass, networkTermsJson, networkTermsVersion, north, pingApp, pool,
  setSharedNetwork, sql, type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

beforeEach(async () => {
  await setSharedNetwork(true);
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
type Q = <R = any>(text: string, params?: unknown[]) => Promise<R[]>;

/** Transaction en rôle propriétaire (réglages locaux rydar.* compris), comme une fonction security definer. */
async function ownerTx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const tag = () => randomUUID().slice(0, 6);

type Pair = { A: Org; B: Org; partner: Driver };

/** A (donneuse, flotte par défaut) partage, B reçoit ; validées ; un chauffeur partenaire chez B. */
async function networkPair(opts: { model?: "fleet" | "centrale" } = {}): Promise<Pair> {
  const A = await createOrg(`Donneuse ${tag()}`);
  const B = await createOrg(`Executante ${tag()}`);
  if (opts.model === "centrale") {
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [A.id]);
  }
  await enableNetwork(A, { out: true });
  await approveNetwork(A);
  await enableNetwork(B, { in: true });
  await approveNetwork(B);
  const partner = await createDriver(B, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 800) });
  await acceptDriverTerms(partner);
  await pingApp(partner);
  return { A, B, partner };
}

/** Course de A proposée au réseau (le dispatch du lot 006800 pose network_at après les vagues propres). */
async function rideInNetwork(A: Org, overrides: Record<string, unknown> = {}) {
  const ride = await createRideAsOwner(A, overrides);
  await sql(`update public.rides set network_at = now() where id = $1`, [ride.id]);
  return ride;
}

const TERMS = networkTermsJson({ price: 7200, fee: 720 });

async function offerTo(rideId: string, A: Org, driver: Driver, opts: { status?: string; terms?: unknown; reason?: string } = {}) {
  const [o] = await sql(
    `insert into public.ride_offers (organization_id, ride_id, driver_id, driver_org_id, status, mode, wave, expires_at,
       network_terms, closed_reason)
     values ($1, $2, $3, $1, $4, 'geo', 7, now() + interval '30 seconds', $5, $6)
     returning id, driver_org_id, is_network`,
    [A.id, rideId, driver.id, opts.status ?? "pending", opts.terms === undefined ? TERMS : opts.terms, opts.reason ?? null],
  );
  return o as { id: string; driver_org_id: string; is_network: boolean };
}

/** Acceptation par le partenaire, comme accept_ride_offer (lot 006800) : chauffeur posé, attribution, exécution figée. */
async function acceptAsPartner(rideId: string, p: Pair, offerId: string) {
  return ownerTx(async (q) => {
    await q(
      `update public.rides set driver_id = $2, vehicle_id = $3, status = 'ACCEPTED', accepted_at = now(), next_dispatch_at = null
        where id = $1`,
      [rideId, p.partner.id, p.partner.vehicleId],
    );
    await q(
      `insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, offer_id, method)
       values ($1, $2, $3, $4, $5, 'accepted')`,
      [p.A.id, rideId, p.partner.id, p.partner.vehicleId, offerId],
    );
    await q(`update public.ride_offers set status = 'accepted', responded_at = now() where id = $1`, [offerId]);
    const version = await networkTermsVersion();
    const [e] = await q(
      `insert into public.ride_network_executions (ride_id, organization_id, executor_org_id, executor_driver_id, offer_id,
         driver_label, operator, vehicle, checks, terms, giver_terms_version, executor_terms_version, driver_terms_version)
       values ($1, $2, $3, $4, $5, 'Karim T.', '{"name": "Exécutante"}', '{"plate": "AA-123-BB"}', '{"vtc_card_number": "X1"}',
         $6, $7, $7, $7)
       returning id`,
      [rideId, p.A.id, p.B.id, p.partner.id, offerId, TERMS, version],
    );
    return e.id as string;
  });
}

/** Course de A acceptée par le partenaire (réseau ouvert, offre, acceptation). */
async function partnerRide(p: Pair, overrides: Record<string, unknown> = {}) {
  const ride = await rideInNetwork(p.A, overrides);
  const offer = await offerTo(ride.id, p.A, p.partner);
  const executionId = await acceptAsPartner(ride.id, p, offer.id);
  return { ride, offer, executionId };
}

/** Retrait du partenaire, comme unassign_network_ride (lot 006800) : marqueur, motif, chauffeur et réseau retirés. */
async function removePartner(rideId: string, p: Pair, reason: string) {
  await ownerTx(async (q) => {
    await q(`select set_config('rydar.network_reason', $1, true)`, [reason]);
    await q(`update public.ride_assignments set is_active = false, released_at = now(), release_reason = $2 where ride_id = $1 and is_active`, [
      rideId, reason,
    ]);
    await q(
      `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, sent_at, expires_at, responded_at,
         closed_reason, network_terms)
       values ($1, $2, $3, 'closed', 'geo', 0, now(), now(), now(), 'removed_by_dispatch', $4)`,
      [p.A.id, rideId, p.partner.id, TERMS],
    );
    await q(
      `update public.rides set driver_id = null, vehicle_id = null, status = 'SEARCHING_DRIVER', accepted_at = null,
         network_at = null, dispatch_wave = 0 where id = $1`,
      [rideId],
    );
  });
}

/**
 * Ligne de règlement réseau : créée par le lot argent (20260924006900, private.sync_network_settlement) quand la course
 * passe COMPLETED — reprise telle quelle (mêmes termes : TERMS) ; écrite directement si la course n'est pas terminée.
 */
async function networkSettlement(rideId: string, p: Pair, executionId: string, status = "due") {
  const [made] = await sql(`select id from public.ride_settlements where ride_id = $1 and network_execution_id = $2`, [rideId, executionId]);
  if (made) {
    if (status !== "due") await sql(`update public.ride_settlements set status = $2 where id = $1`, [made.id, status]);
    return made.id as string;
  }
  const [s] = await sql(
    `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents,
       price_cents, commission_cents, platform_fee_cents, driver_payout_cents, payment_method, reference, due_at,
       network_driver_id, network_driver_org_id, network_execution_id, network_counterparty, status)
     values ($1, $2, null, 'Karim T. · Exécutante', 'driver_owes', 720, 7200, 0, 720, 6480, 'card', 'R1', now() + interval '2 days',
       $3, $4, $5, 'driver', $6)
     returning id`,
    [p.A.id, rideId, p.partner.id, p.B.id, executionId, status],
  );
  return s.id as string;
}

const share = async (rideId: string) => (await sql(`select * from public.ride_network_shares where ride_id = $1`, [rideId]))[0];
const executions = (rideId: string) =>
  sql(`select id, ended_at, end_reason from public.ride_network_executions where ride_id = $1 order by accepted_at`, [rideId]);
const ride = async (rideId: string) => (await sql(`select * from public.rides where id = $1`, [rideId]))[0];

/** Colonnes (dans l'ordre) d'une contrainte. */
async function constraintCols(conname: string) {
  const rows = await sql(
    `select a.attname
       from pg_constraint c
       cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.conname = $1
      order by k.ord`,
    [conname],
  );
  return rows.map((r) => r.attname as string);
}

// -----------------------------------------------------------------------------
describe("Schéma : clés étrangères (pg_constraint), contrôles et index", () => {
  it("une seule clé rides → drivers et rides → vehicles, même nom, sur l'organisation du chauffeur (embed PostgREST non ambigu)", async () => {
    const fks = await sql(
      `select c.conname, c.confrelid::regclass::text as target, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.contype = 'f' and c.conrelid = 'public.rides'::regclass
          and c.confrelid in ('public.drivers'::regclass, 'public.vehicles'::regclass)
        order by 1`,
    );
    expect(fks.map((f) => [f.conname, f.target])).toEqual([
      ["rides_organization_id_driver_id_fkey", "drivers"],
      ["rides_organization_id_vehicle_id_fkey", "vehicles"],
    ]);
    expect(await constraintCols("rides_organization_id_driver_id_fkey")).toEqual(["driver_org_id", "driver_id"]);
    expect(await constraintCols("rides_organization_id_vehicle_id_fkey")).toEqual(["driver_org_id", "vehicle_id"]);
    expect(fks[0].def).toContain("ON DELETE SET NULL");
    // Aucune clé non validée ne reste
    const unvalidated = await sql(
      `select conname from pg_constraint where not convalidated and connamespace in ('public'::regnamespace, 'private'::regnamespace)`,
    );
    expect(unvalidated).toEqual([]);
  });

  it("tables filles : une clé vers drivers chacune, remplacée sous le même nom par (driver_org_id, driver_id)", async () => {
    for (const [table, conname] of [
      ["ride_offers", "ride_offers_organization_id_driver_id_fkey"],
      ["ride_assignments", "ride_assignments_organization_id_driver_id_fkey"],
      ["notifications", "notifications_organization_id_driver_id_fkey"],
      ["ride_alerts", "ride_alerts_organization_id_driver_id_fkey"],
    ]) {
      const fks = await sql(
        `select conname from pg_constraint where contype = 'f' and conrelid = $1::regclass and confrelid = 'public.drivers'::regclass`,
        [`public.${table}`],
      );
      expect(fks.map((f) => f.conname), table).toEqual([conname]);
      expect(await constraintCols(conname!), table).toEqual(["driver_org_id", "driver_id"]);
      // La course reste dans le tenant de A : clé (organization_id, ride_id) inchangée
      expect(await constraintCols(`${table}_organization_id_ride_id_fkey`), table).toEqual(["organization_id", "ride_id"]);
    }
    // Règlements : clé propre inchangée + clé réseau NOMMÉE (tout embed vers drivers doit nommer la sienne)
    const settlementFks = await sql(
      `select conname from pg_constraint where contype = 'f' and conrelid = 'public.ride_settlements'::regclass
          and confrelid = 'public.drivers'::regclass order by 1`,
    );
    expect(settlementFks.map((f) => f.conname)).toEqual(["ride_settlements_network_driver_fkey", "ride_settlements_organization_id_driver_id_fkey"]);
    expect(await constraintCols("ride_settlements_organization_id_driver_id_fkey")).toEqual(["organization_id", "driver_id"]);
    expect(await constraintCols("ride_settlements_network_driver_fkey")).toEqual(["network_driver_org_id", "network_driver_id"]);
    // Course en cours : clé SIMPLE vers rides(id), même nom
    expect(await constraintCols("drivers_current_ride_fk")).toEqual(["current_ride_id"]);
    const [cur] = await sql(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'drivers_current_ride_fk'`);
    expect(cur.def).toBe("FOREIGN KEY (current_ride_id) REFERENCES rides(id) ON DELETE SET NULL");
  });

  it("contrôles, contrepartie toujours « driver », index réseau et d'identités", async () => {
    const checks = await sql(
      `select conname from pg_constraint where contype = 'c' and conname = any ($1::text[]) order by 1`,
      [[
        "rides_driver_org_check", "ride_offers_network_check", "ride_offers_network_terms_check", "notifications_driver_org_check",
        "ride_alerts_driver_org_check", "ride_settlements_network_check", "ride_settlements_network_columns_check",
        "ride_settlements_network_counterparty_check", "ride_network_executions_counterparty_check",
        "ride_network_executions_terms_check",
      ]],
    );
    expect(checks).toHaveLength(10);
    const [cp] = await sql(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ride_network_executions_counterparty_check'`);
    expect(cp.def).toBe("CHECK ((counterparty = 'driver'::text))");
    const indexes = await sql(
      `select indexname from pg_indexes where indexname = any ($1::text[]) order by 1`,
      [[
        "rides_network_exec_idx", "rides_network_open_idx", "ride_offers_network_idx", "ride_settlements_network_driver_idx",
        "ride_settlements_network_org_idx", "ride_settlements_network_exec_org_idx", "ride_network_executions_open_idx",
        "driver_identity_keys_lookup_idx", "network_exclusions_excluded_idx", "drivers_current_ride_idx", "rides_vehicle_idx",
      ]],
    );
    expect(indexes).toHaveLength(11);
    // Toutes les nouvelles tables : RLS activée
    const rls = await sql(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relrowsecurity and (n.nspname, c.relname) in (('public', 'network_memberships'), ('public', 'network_exclusions'),
          ('public', 'ride_network_shares'), ('public', 'ride_network_executions'), ('public', 'driver_network_settings'),
          ('public', 'driver_payout_details'), ('private', 'driver_identity_keys'), ('private', 'network_driver_exclusions'),
          ('private', 'network_debtor_identities'))`,
    );
    expect(rls).toHaveLength(9);
  });

  it("empreinte du RIB : sur l'exécution (aucune lecture client), jamais dans ride_settlements (lu par tout membre de A)", async () => {
    const cols = await sql(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name like 'payout_iban%' order by 1, 2`,
    );
    expect(cols).toEqual([
      { table_name: "ride_network_executions", column_name: "payout_iban_at" },
      { table_name: "ride_network_executions", column_name: "payout_iban_hash" },
    ]);
    // Termes : jamais une contrainte CHECK appelant network_terms_complete (réévaluée à chaque UPDATE de la ligne)
    const checks = await sql(
      `select conname from pg_constraint where contype = 'c' and pg_get_constraintdef(oid) like '%network_terms_complete%'`,
    );
    expect(checks).toEqual([]);
  });

  it("convention : version par défaut = NETWORK_TERMS_VERSION ; interrupteur coupé par la migration", async () => {
    const [d] = await sql(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'platform_settings' and column_name = 'network_terms_version'`,
    );
    expect(d.column_default).toBe(`'${NETWORK_TERMS_VERSION}'::text`);
    const [def] = await sql(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'platform_settings' and column_name = 'shared_network_enabled'`,
    );
    expect(def.column_default).toBe("false");
  });
});

// -----------------------------------------------------------------------------
describe("G1 : organisation du chauffeur posée par la base, jamais par l'appelant", () => {
  it("offre, attribution, notification, alerte d'un chauffeur propre : driver_org_id = organisation, is_network faux", async () => {
    const A = await createOrg(`G1 ${tag()}`);
    const other = await createOrg(`G1 autre ${tag()}`);
    const d = await createDriver(A, { at: CHAMPS_ELYSEES });
    const r = await createRideAsOwner(A);
    // Valeurs fournies par l'appelant ignorées (service role compris)
    const [o] = await as({ role: "service_role" }, (q) =>
      q(
        `insert into public.ride_offers (organization_id, ride_id, driver_id, driver_org_id, is_network, status, mode)
         values ($1, $2, $3, $4, true, 'closed', 'geo') returning driver_org_id, is_network`,
        [A.id, r.id, d.id, other.id],
      ));
    expect(o).toEqual({ driver_org_id: A.id, is_network: false });
    const [n] = await sql(
      `insert into public.notifications (organization_id, driver_id, driver_org_id, ride_id, type, title, body)
       values ($1, $2, $3, $4, 'test', 'T', 'B') returning driver_org_id`,
      [A.id, d.id, other.id, r.id],
    );
    expect(n.driver_org_id).toBe(A.id);
    const [nu] = await sql(
      `insert into public.notifications (organization_id, driver_org_id, type, title, body) values ($1, $2, 'test', 'T', 'B') returning driver_org_id`,
      [A.id, other.id],
    );
    expect(nu.driver_org_id).toBeNull();
    const [al] = await sql(
      `insert into public.ride_alerts (organization_id, ride_id, driver_id, driver_org_id, kind, message) values ($1, $2, $3, $4, 'late', 'Retard') returning driver_org_id`,
      [A.id, r.id, d.id, other.id],
    );
    expect(al.driver_org_id).toBe(A.id);
    // Chauffeur inconnu : la clé étrangère le refuse, comme avant
    const e = await expectPgError(
      sql(`insert into public.ride_assignments (organization_id, ride_id, driver_id, method) values ($1, $2, $3, 'manual')`, [A.id, r.id, randomUUID()]),
    );
    expect(e.code).toBe("23503");
  });

  it("parcours propre inchangé : dispatch, acceptation → course, offre et attribution sur l'organisation", async () => {
    const A = await createOrg(`G1 parcours ${tag()}`);
    const d = await createDriver(A, { at: north(CHAMPS_ELYSEES, 300) });
    const r = await createRideAsOwner(A);
    const [offer] = await sql(`select id, driver_org_id, is_network from public.ride_offers where ride_id = $1 and driver_id = $2`, [r.id, d.id]);
    expect(offer).toMatchObject({ driver_org_id: A.id, is_network: false });
    const [res] = await as({ sub: d.userId }, (q) => q(`select public.accept_ride_offer($1) as r`, [offer.id]));
    expect(res.r.ok).toBe(true);
    const x = await ride(r.id);
    expect(x).toMatchObject({ driver_id: d.id, driver_org_id: A.id, vehicle_id: d.vehicleId, network_at: null });
    const [a] = await sql(`select driver_org_id from public.ride_assignments where ride_id = $1`, [r.id]);
    expect(a.driver_org_id).toBe(A.id);
    expect(await share(r.id)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe("G2 : colonnes figées", () => {
  it("organisation et chauffeur d'une offre, d'une attribution ; termes d'une offre ; passage à NULL seulement où une clé le fait", async () => {
    const p = await networkPair();
    const { ride: r, offer, executionId } = await partnerRide(p);
    const other = await createDriver(p.B);
    for (const [stmt, params] of [
      [`update public.ride_offers set driver_org_id = $2 where id = $1`, [offer.id, p.A.id]],
      [`update public.ride_offers set driver_id = $2 where id = $1`, [offer.id, other.id]],
      [`update public.ride_offers set is_network = false where id = $1`, [offer.id]],
      [`update public.ride_offers set network_terms = $2 where id = $1`, [offer.id, networkTermsJson({ price: 7200, fee: 100 })]],
      [`update public.ride_assignments set driver_id = $2 where ride_id = $1`, [r.id, other.id]],
      [`update public.ride_network_executions set terms = $2 where id = $1`, [executionId, networkTermsJson({ price: 7200, fee: 100 })]],
      [`update public.ride_network_executions set executor_org_id = $2 where id = $1`, [executionId, p.A.id]],
      [`update public.ride_network_shares set ride_id = gen_random_uuid() where ride_id = $1`, [r.id]],
    ] as const) {
      const e = await expectPgError(sql(stmt, [...params]));
      expect(e.code, stmt).toBe("42501");
      expect(e.message, stmt).toContain("FORBIDDEN_TENANT_CHANGE");
    }
    // Règlement réseau : chauffeur → NULL permis, exécution / organisation / contrepartie figées
    const sid = await networkSettlement(r.id, p, executionId);
    for (const stmt of [
      `update public.ride_settlements set network_driver_org_id = organization_id where id = $1`,
      `update public.ride_settlements set network_counterparty = null where id = $1`,
      `update public.ride_settlements set network_execution_id = null where id = $1`,
    ]) {
      expect((await expectPgError(sql(stmt, [sid]))).code, stmt).toBe("42501");
    }
    await sql(`update public.ride_settlements set network_driver_id = null where id = $1`, [sid]);
    // Exécution : chauffeur retiré par la clé « on delete set null » → passage à NULL permis
    await sql(`update public.ride_network_executions set executor_driver_id = null where id = $1`, [executionId]);
  });

  it("notification d'un partenaire : jamais de passage à NULL (clé « on delete cascade »), sinon lisible par tout A", async () => {
    const p = await networkPair();
    const { ride: r } = await partnerRide(p);
    const dispatcher = await createMember(p.A, "dispatcher");
    const [n] = await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body)
       values ($1, $2, $3, 'ride_reminder', 'RAPPEL', '12 avenue des Champs-Élysées') returning id`,
      [p.A.id, p.partner.id, r.id],
    );
    for (const set of ["driver_id = null, driver_org_id = null", "driver_id = null", "driver_org_id = null"]) {
      const e = await expectPgError(sql(`update public.notifications set ${set} where id = $1`, [n.id]));
      expect(e.code, set).toBe("42501");
      expect(e.message, set).toContain("FORBIDDEN_TENANT_CHANGE");
    }
    expect(await as({ sub: dispatcher }, (q) => q(`select id from public.notifications where id = $1`, [n.id]))).toEqual([]);
  });

  it("exécution : étiquette et contrôles figés (effacement des traces seul) ; empreinte du RIB posée une fois", async () => {
    const p = await networkPair();
    const { executionId } = await partnerRide(p);
    for (const set of [`checks = '{"vtc_card_number": "Y2"}'`, `driver_label = 'Autre N.'`, `operator = '{"name": "Autre"}'`]) {
      const e = await expectPgError(sql(`update public.ride_network_executions set ${set} where id = $1`, [executionId]));
      expect(e.code, set).toBe("42501");
    }
    // Effacement des traces d'un compte supprimé (lot administration) : réglage local rydar.network_scrub…
    await ownerTx(async (q) => {
      await q(`select set_config('rydar.network_scrub', 'on', true)`);
      await q(`update public.ride_network_executions set driver_label = 'Chauffeur supprimé · Exécutante', checks = '{}' where id = $1`, [
        executionId,
      ]);
    });
    // … qui ne touche ni aux termes, ni à l'exploitant
    for (const set of [`operator = '{}'`, `vehicle = '{}'`]) {
      const e = await expectPgError(ownerTx(async (q) => {
        await q(`select set_config('rydar.network_scrub', 'on', true)`);
        await q(`update public.ride_network_executions set ${set} where id = $1`, [executionId]);
      }));
      expect(e.code, set).toBe("42501");
    }
    // Empreinte du RIB : les deux colonnes ensemble, posées une fois, jamais changées ni effacées
    expect((await expectPgError(sql(`update public.ride_network_executions set payout_iban_hash = repeat('a', 64) where id = $1`, [executionId]))).code)
      .toBe("23514");
    await sql(`update public.ride_network_executions set payout_iban_hash = repeat('a', 64), payout_iban_at = now() where id = $1`, [executionId]);
    for (const set of [`payout_iban_hash = repeat('b', 64)`, `payout_iban_hash = null, payout_iban_at = null`, `payout_iban_at = now() + interval '1 day'`]) {
      expect((await expectPgError(sql(`update public.ride_network_executions set ${set} where id = $1`, [executionId]))).code, set).toBe("42501");
    }
  });
});

// -----------------------------------------------------------------------------
describe("G3 : chauffeur d'une autre organisation posé sur une course", () => {
  it("insertion : network_at et driver_org_id jamais fournis, service role compris", async () => {
    const A = await createOrg(`G3 insert ${tag()}`);
    const other = await createOrg(`G3 autre ${tag()}`);
    const [r] = await as({ role: "service_role" }, (q) =>
      q(
        `insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name,
           customer_phone, price_cents, network_at, driver_org_id)
         values ($1, 'api', '1 rue de Rivoli, 75001 Paris', 48.86, 2.34, 'Orly', 'Client', '+33611223344', 5000, now(), $2)
         returning network_at, driver_org_id`,
        [A.id, other.id],
      ));
    expect(r).toEqual({ network_at: null, driver_org_id: null });
  });

  it("refusé (42501) sans réseau ouvert, sans offre, avec une offre d'un cycle précédent, ou une organisation non éligible", async () => {
    const p = await networkPair();
    const attempt = (rideId: string) =>
      expectPgError(sql(`update public.rides set driver_id = $2, vehicle_id = $3, status = 'ACCEPTED' where id = $1`, [rideId, p.partner.id, p.partner.vehicleId]));

    // Réseau pas ouvert pour la course
    const r1 = await createRideAsOwner(p.A);
    expect((await attempt(r1.id)).code).toBe("42501");
    // Réseau ouvert, sans offre
    await sql(`update public.rides set network_at = now() where id = $1`, [r1.id]);
    expect((await attempt(r1.id)).message).toContain("FORBIDDEN_TENANT");
    // Offre du cycle PRÉCÉDENT (envoyée avant la réouverture)
    await offerTo(r1.id, p.A, p.partner, { status: "pending" });
    await sql(`update public.rides set network_at = now() + interval '1 second' where id = $1`, [r1.id]);
    expect((await attempt(r1.id)).code).toBe("42501");
    // Offre refusée par le chauffeur : ne compte pas
    const r2 = await rideInNetwork(p.A);
    const o2 = await offerTo(r2.id, p.A, p.partner);
    await sql(`update public.ride_offers set status = 'declined' where id = $1`, [o2.id]);
    expect((await attempt(r2.id)).code).toBe("42501");

    // Offre valable mais organisation non éligible au moment de l'acceptation
    const cases: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ["exclue par A", () => sql(`insert into public.network_exclusions (organization_id, excluded_org_id) values ($1, $2)`, [p.A.id, p.B.id]),
        () => sql(`delete from public.network_exclusions where organization_id = $1`, [p.A.id])],
      ["exclut A", () => sql(`insert into public.network_exclusions (organization_id, excluded_org_id) values ($1, $2)`, [p.B.id, p.A.id]),
        () => sql(`delete from public.network_exclusions where organization_id = $1`, [p.B.id])],
      ["B non validée", () => sql(`update public.network_memberships set approved_at = null where organization_id = $1`, [p.B.id]),
        () => approveNetwork(p.B)],
      ["B ne reçoit plus", () => sql(`update public.network_memberships set share_in = false where organization_id = $1`, [p.B.id]),
        () => sql(`update public.network_memberships set share_in = true where organization_id = $1`, [p.B.id])],
      ["A suspendue du réseau", () => sql(`update public.network_memberships set suspended_at = now(), suspended_reason = 'Manquement' where organization_id = $1`, [p.A.id]),
        () => sql(`update public.network_memberships set suspended_at = null, suspended_reason = null where organization_id = $1`, [p.A.id])],
      ["interrupteur coupé", () => setSharedNetwork(false), () => setSharedNetwork(true)],
    ];
    for (const [label, cut, restore] of cases) {
      const r = await rideInNetwork(p.A);
      await offerTo(r.id, p.A, p.partner);
      await cut();
      const e = await attempt(r.id);
      expect(e.code, label).toBe("42501");
      await restore();
      // Rétabli : l'acceptation passe (même offre, même cycle)
      await sql(`update public.rides set driver_id = $2, vehicle_id = $3, status = 'ACCEPTED' where id = $1`, [r.id, p.partner.id, p.partner.vehicleId]);
      expect((await ride(r.id)).driver_org_id, label).toBe(p.B.id);
    }
  });

  it("organisation non adhérente ou sans adhésion : jamais, même avec une offre fabriquée", async () => {
    const p = await networkPair();
    const C = await createOrg(`G3 non adhérente ${tag()}`);
    const stranger = await createDriver(C);
    const r = await rideInNetwork(p.A);
    // L'offre elle-même est refusée (G4) ; et la course, même sans offre
    expect((await expectPgError(offerTo(r.id, p.A, stranger))).code).toBe("42501");
    const e = await expectPgError(sql(`update public.rides set driver_id = $2, status = 'ACCEPTED' where id = $1`, [r.id, stranger.id]));
    expect(e.code).toBe("42501");
  });

  it("course tenue par un partenaire : network_at figé (il ne change qu'avec le chauffeur : retrait, réattribution)", async () => {
    const p = await networkPair();
    const { ride: r, executionId } = await partnerRide(p);
    for (const set of ["network_at = null", "network_at = now() + interval '1 second'"]) {
      const e = await expectPgError(sql(`update public.rides set ${set} where id = $1`, [r.id]));
      expect(e.code, set).toBe("42501");
      expect(e.message, set).toContain("FORBIDDEN_TENANT_CHANGE");
    }
    expect(await share(r.id)).toMatchObject({ status: "accepted", cycle: 1 });
    expect(await executions(r.id)).toEqual([expect.objectContaining({ id: executionId, ended_at: null })]);
    // Retrait (chauffeur et réseau dans la même instruction) : permis
    await removePartner(r.id, p, "removed_by_giver");
    expect(await ride(r.id)).toMatchObject({ driver_id: null, network_at: null });
    // Course terminée par le partenaire : figé aussi
    const { ride: done } = await partnerRide(p);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [done.id]);
    expect((await expectPgError(sql(`update public.rides set network_at = null where id = $1`, [done.id]))).code).toBe("42501");
  });

  it("véhicule (ancienne clé (organization_id, vehicle_id)) : course sans chauffeur → véhicule de son organisation, détaché à la suppression", async () => {
    const p = await networkPair();
    // Course propre, chauffeur supprimé par son organisation : le véhicule reste (comme avant) ; véhicule supprimé : détaché
    const own = await createDriver(p.A);
    const rideId = await insertRideBypass(p.A, { status: "CANCELLED", cancelled_at: new Date(), driver_id: own.id, vehicle_id: own.vehicleId });
    await as({ sub: p.A.ownerId }, (q) => q(`delete from public.drivers where id = $1`, [own.id]));
    expect(await ride(rideId)).toMatchObject({ driver_id: null, driver_org_id: null, vehicle_id: own.vehicleId });
    await as({ sub: p.A.ownerId }, (q) => q(`delete from public.vehicles where id = $1`, [own.vehicleId]));
    expect((await ride(rideId)).vehicle_id).toBeNull();
    // Course sans chauffeur : véhicule d'une autre organisation ou inexistant refusé (23503), le sien permis
    const r = await createRideAsOwner(p.A);
    const foreign = await createDriver(p.B);
    for (const vehicle of [foreign.vehicleId, randomUUID()]) {
      const e = await expectPgError(sql(`update public.rides set vehicle_id = $2 where id = $1`, [r.id, vehicle]));
      expect(e.code).toBe("23503");
    }
    const mine = await createDriver(p.A);
    await sql(`update public.rides set vehicle_id = $2 where id = $1`, [r.id, mine.vehicleId]);
    // Partenaire retiré sans que l'appelant vide le véhicule : son véhicule part avec lui
    const { ride: held } = await partnerRide(p);
    await sql(`update public.rides set driver_id = null, network_at = null, status = 'SEARCHING_DRIVER' where id = $1`, [held.id]);
    expect(await ride(held.id)).toMatchObject({ driver_id: null, vehicle_id: null });
  });

  it("accepté : driver_org_id = B ; jamais falsifiable ensuite", async () => {
    const p = await networkPair();
    const { ride: r } = await partnerRide(p);
    expect(await ride(r.id)).toMatchObject({ driver_id: p.partner.id, driver_org_id: p.B.id, vehicle_id: p.partner.vehicleId });
    await sql(`update public.rides set driver_org_id = organization_id where id = $1`, [r.id]);
    expect((await ride(r.id)).driver_org_id).toBe(p.B.id);
    // Véhicule d'une autre organisation que celle du chauffeur : clé étrangère
    const otherVehicle = await createDriver(p.A);
    const e = await expectPgError(sql(`update public.rides set vehicle_id = $2 where id = $1`, [r.id, otherVehicle.vehicleId]));
    expect(e.code).toBe("23503");
  });
});

// -----------------------------------------------------------------------------
describe("G4 : lignes filles d'un chauffeur partenaire (dont C1, C2)", () => {
  it("offre réseau en attente : réseau ouvert, paire éligible, termes complets ; sinon refusée", async () => {
    const p = await networkPair();
    const r = await createRideAsOwner(p.A);
    // Réseau pas ouvert
    expect((await expectPgError(offerTo(r.id, p.A, p.partner))).code).toBe("42501");
    await sql(`update public.rides set network_at = now() where id = $1`, [r.id]);
    // Termes absents ou incohérents : contrôle de la base
    expect((await expectPgError(offerTo(r.id, p.A, p.partner, { terms: null }))).code).toBe("23514");
    expect((await expectPgError(offerTo(r.id, p.A, p.partner, { terms: { ...TERMS, driver_payout_cents: 1 } }))).code).toBe("23514");
    // Interrupteur coupé
    await setSharedNetwork(false);
    expect((await expectPgError(offerTo(r.id, p.A, p.partner))).code).toBe("42501");
    await setSharedNetwork(true);
    const o = await offerTo(r.id, p.A, p.partner);
    expect(o).toMatchObject({ driver_org_id: p.B.id, is_network: true });
    // Offre « propre » portant des termes : refusée (termes réservés aux offres réseau)
    const own = await createDriver(p.A);
    expect((await expectPgError(offerTo(r.id, p.A, own))).code).toBe("23514");
  });

  it("C1 : marqueur « retiré » d'un partenaire qui tient la course, permis même après coupure, exclusion ou suspension", async () => {
    for (const cut of ["switch", "exclusion", "suspension"] as const) {
      const p = await networkPair();
      const { ride: r } = await partnerRide(p);
      if (cut === "switch") await setSharedNetwork(false);
      if (cut === "exclusion") await sql(`insert into public.network_exclusions (organization_id, excluded_org_id) values ($1, $2)`, [p.A.id, p.B.id]);
      if (cut === "suspension") {
        await sql(`update public.network_memberships set suspended_at = now(), suspended_reason = 'Manquement' where organization_id = $1`, [p.B.id]);
      }
      // Une nouvelle offre en attente n'est plus possible…
      const stranger = await createDriver(p.B);
      const refused = await expectPgError(offerTo(r.id, p.A, stranger));
      expect(refused.code, cut).toBe("42501");
      // … mais le retrait du partenaire qui tient la course passe (marqueur, attribution, notification, alerte)
      await removePartner(r.id, p, "executor_released");
      const [marker] = await sql(
        `select status, closed_reason, is_network from public.ride_offers where ride_id = $1 and closed_reason = 'removed_by_dispatch'`,
        [r.id],
      );
      expect(marker, cut).toEqual({ status: "closed", closed_reason: "removed_by_dispatch", is_network: true });
      await sql(
        `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body) values ($1, $2, $3, 'ride_unassigned', 'COURSE RETIRÉE', 'x')`,
        [p.A.id, p.partner.id, r.id],
      );
      await setSharedNetwork(true);
    }
  });

  it("marqueur, attribution, alerte : refusés pour un partenaire qui ne tient pas la course", async () => {
    const p = await networkPair();
    const r = await rideInNetwork(p.A);
    await offerTo(r.id, p.A, p.partner);
    const e1 = await expectPgError(offerTo(r.id, p.A, p.partner, { status: "closed", reason: "removed_by_dispatch" }));
    expect(e1.code).toBe("42501");
    const e2 = await expectPgError(
      sql(`insert into public.ride_assignments (organization_id, ride_id, driver_id, method) values ($1, $2, $3, 'manual')`, [p.A.id, r.id, p.partner.id]),
    );
    expect(e2.code).toBe("42501");
    const e3 = await expectPgError(
      sql(`insert into public.ride_alerts (organization_id, ride_id, driver_id, kind, message) values ($1, $2, $3, 'late', 'Retard')`, [p.A.id, r.id, p.partner.id]),
    );
    expect(e3.code).toBe("42501");
    // Tenue par lui : alerte permise
    const { ride: held } = await partnerRide(p);
    const [al] = await sql(
      `insert into public.ride_alerts (organization_id, ride_id, driver_id, kind, message) values ($1, $2, $3, 'late', 'Retard') returning driver_org_id`,
      [p.A.id, held.id, p.partner.id],
    );
    expect(al.driver_org_id).toBe(p.B.id);
  });

  it("notifications : course liée au chauffeur ; sans course, une ligne réseau quel que soit son statut (C2)", async () => {
    const p = await networkPair();
    const notify = (rideId: string | null, driver: Driver = p.partner) =>
      sql(
        `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body) values ($1, $2, $3, 'test', 'T', 'B') returning driver_org_id`,
        [p.A.id, driver.id, rideId],
      );
    const unrelated = await rideInNetwork(p.A);
    expect((await expectPgError(notify(unrelated.id))).code).toBe("42501");
    expect((await expectPgError(notify(null))).code).toBe("42501");
    // Offre (même fermée) : liée
    await offerTo(unrelated.id, p.A, p.partner);
    expect((await notify(unrelated.id))[0].driver_org_id).toBe(p.B.id);
    // Sans course : seulement s'il existe une ligne réseau entre A et ce chauffeur, même réglée (dernière confirmation)
    const { ride: r, executionId } = await partnerRide(p);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [r.id]);
    const sid = await networkSettlement(r.id, p, executionId);
    await sql(`update public.ride_settlements set status = 'paid', settled_at = now(), settled_method = 'link' where id = $1`, [sid]);
    expect((await notify(null))[0].driver_org_id).toBe(p.B.id);
    const otherPartner = await createDriver(p.B);
    expect((await expectPgError(notify(null, otherPartner))).code).toBe("42501");
  });
});

// -----------------------------------------------------------------------------
describe("G5 : règlement réseau", () => {
  it("exécution de cette course, même chauffeur et organisations ; contrepartie « driver » ; driver_id NULL", async () => {
    const p = await networkPair();
    const { ride: r, executionId } = await partnerRide(p);
    const { executionId: otherExecution } = await partnerRide(p);
    // Exécution d'une autre course
    expect((await expectPgError(networkSettlement(r.id, p, otherExecution))).code).toBe("42501");
    // Contrepartie organisation (lot 4b supprimé) : refusée (garde, puis contrôle de colonne)
    const e = await expectPgError(
      sql(
        `insert into public.ride_settlements (organization_id, ride_id, driver_label, direction, amount_cents, price_cents, commission_cents,
           driver_payout_cents, payment_method, reference, due_at, network_driver_id, network_driver_org_id, network_execution_id, network_counterparty)
         values ($1, $2, 'X', 'driver_owes', 720, 7200, 0, 6480, 'card', 'R1', now(), $3, $4, $5, 'organization')`,
        [p.A.id, r.id, p.partner.id, p.B.id, executionId],
      ),
    );
    expect(["42501", "23514"]).toContain(e.code);
    const [cp] = await sql(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ride_settlements_network_counterparty_check'`);
    expect(cp.def).toBe("CHECK (((network_counterparty IS NULL) OR (network_counterparty = 'driver'::text)))");
    // driver_id renseigné sur une ligne réseau : refusé (identification par network_driver_org_id)
    const e2 = await expectPgError(
      sql(
        `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
           commission_cents, driver_payout_cents, payment_method, reference, due_at, network_driver_id, network_driver_org_id,
           network_execution_id, network_counterparty)
         values ($1, $2, $3, 'X', 'driver_owes', 720, 7200, 0, 6480, 'card', 'R1', now(), $3, $4, $5, 'driver')`,
        [p.A.id, r.id, p.partner.id, p.B.id, executionId],
      ),
    );
    expect(["23503", "23514"]).toContain(e2.code);
    // Correcte
    const sid = await networkSettlement(r.id, p, executionId);
    const [s] = await sql(`select driver_id, network_driver_org_id, network_counterparty from public.ride_settlements where id = $1`, [sid]);
    expect(s).toEqual({ driver_id: null, network_driver_org_id: p.B.id, network_counterparty: "driver" });
  });

  it("course supprimée (purge) : exécution et règlement partent ensemble ; exécution seule : refusée tant qu'un règlement la cite", async () => {
    const p = await networkPair();
    const { ride: r, executionId } = await partnerRide(p);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [r.id]);
    await networkSettlement(r.id, p, executionId);
    expect((await expectPgError(sql(`delete from public.ride_network_executions where id = $1`, [executionId]))).code).toBe("23503");
    await sql(`delete from public.rides where id = $1`, [r.id]);
    expect(await sql(`select 1 from public.ride_network_executions where id = $1`, [executionId])).toHaveLength(0);
    expect(await sql(`select 1 from public.ride_settlements where ride_id = $1`, [r.id])).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe("G6 : course confiée verrouillée (NETWORK_RIDE_LOCKED)", () => {
  it("prix, paiement, commission, adresses, heure, catégorie, passagers : refusés (owner et dispatcher) ; commentaire permis", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const { ride: r } = await partnerRide(p);
    for (const [who, set] of [
      [p.A.ownerId, "price_cents = 8000"],
      [p.A.ownerId, "payment_method = 'cash'"],
      [dispatcher, "pickup_address = '5 rue de la Paix, 75002 Paris'"],
      [dispatcher, "dropoff_lat = 48.9"],
      [dispatcher, "passengers = 3"],
      // Bagages (élément de l'offre) ; n° de vol (le suivi de vol déplacerait l'heure selon le retard du nouveau vol)
      [dispatcher, "luggage = 3"],
      [dispatcher, "flight_number = 'AF1234'"],
    ] as const) {
      const e = await expectPgError(as({ sub: who }, (q) => q(`update public.rides set ${set} where id = $1`, [r.id])));
      expect(e.code, set).toBe("55000");
      expect(e.message, set).toContain("NETWORK_RIDE_LOCKED");
    }
    // Heure et catégorie (fonctions serveur seulement) : même verrou, quel que soit le rôle
    for (const set of ["pickup_at = now() + interval '2 hours'", "vehicle_category = 'van'"]) {
      const e = await expectPgError(sql(`update public.rides set ${set} where id = $1`, [r.id]));
      expect(e.code, set).toBe("55000");
    }
    await as({ sub: dispatcher }, (q) => q(`update public.rides set comment = 'Portail bleu', customer_phone = '+33699887766' where id = $1`, [r.id]));
    // Valeur inchangée renvoyée par le formulaire : acceptée
    await as({ sub: p.A.ownerId }, (q) => q(`update public.rides set price_cents = 7200 where id = $1`, [r.id]));
    // Vol retardé (réglage local du suivi de vol) : heure permise
    await ownerTx(async (q) => {
      await q(`select set_config('rydar.network_flight_update', 'on', true)`);
      await q(`update public.rides set pickup_at = pickup_at + interval '20 minutes' where id = $1`, [r.id]);
    });
    // … mais pas un autre champ sous le même réglage, n° de vol compris
    for (const set of ["pickup_at = pickup_at + interval '5 minutes', price_cents = 9000", "flight_number = 'AF1234'", "luggage = 2"]) {
      const e = await expectPgError(ownerTx(async (q) => {
        await q(`select set_config('rydar.network_flight_update', 'on', true)`);
        await q(`update public.rides set ${set} where id = $1`, [r.id]);
      }));
      expect(e.code, set).toBe("55000");
    }
  });

  it("centrale : commission saisie refusée ; changement de modèle (répartition recalculée) permis ; course terminée verrouillée ; retirée : modifiable", async () => {
    const p = await networkPair();
    const { ride: r } = await partnerRide(p);
    // A passe de flotte à centrale : répartition calculée pour la course tenue par le partenaire (termes figés à part)
    await as({ role: "service_role" }, (q) => q(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [p.A.id]));
    expect((await ride(r.id)).driver_payout_cents).not.toBeNull();
    const e = await expectPgError(as({ sub: p.A.ownerId }, (q) => q(`update public.rides set commission_cents = 500 where id = $1`, [r.id])));
    expect(e.message).toContain("NETWORK_RIDE_LOCKED");
    // Retrait au partenaire : de nouveau modifiable
    await removePartner(r.id, p, "removed_by_giver");
    await as({ sub: p.A.ownerId }, (q) =>
      q(`update public.rides set price_cents = 8000, pickup_address = '9 rue Royale, 75008 Paris', flight_number = 'AF1234', luggage = 2 where id = $1`, [r.id]));

    // Course terminée par un partenaire (A flotte) : verrouillée
    const q2 = await networkPair();
    const { ride: done } = await partnerRide(q2);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [done.id]);
    for (const set of ["price_cents = 100", "flight_number = 'AF1234'", "luggage = 4"]) {
      expect((await expectPgError(as({ sub: q2.A.ownerId }, (q) => q(`update public.rides set ${set} where id = $1`, [done.id])))).code, set)
        .toBe("55000");
    }
  });

  it("course propre ou annulée : aucune différence", async () => {
    const A = await createOrg(`G6 propre ${tag()}`);
    const r = await createRideAsOwner(A);
    await as({ sub: A.ownerId }, (q) => q(`update public.rides set price_cents = 9100, passengers = 3 where id = $1`, [r.id]));
    const p = await networkPair();
    const { ride: cancelled } = await partnerRide(p);
    await sql(`select private.cancel_ride_internal($1, 'Client absent', 'user', null)`, [cancelled.id]);
    await as({ sub: p.A.ownerId }, (q) => q(`update public.rides set passengers = 4 where id = $1`, [cancelled.id]));
  });
});

// -----------------------------------------------------------------------------
describe("G7 : fiche avec des obligations réseau", () => {
  it("B ne supprime pas un chauffeur qui tient une course de A ou doit / attend un règlement réseau ; ensuite, si", async () => {
    const p = await networkPair();
    const { ride: r, executionId } = await partnerRide(p);
    const remove = () => as({ sub: p.B.ownerId }, (q) => q(`delete from public.drivers where id = $1 returning id`, [p.partner.id]));
    let e = await expectPgError(remove());
    expect(e.code).toBe("55000");
    expect(e.message).toContain("DRIVER_HAS_NETWORK_OBLIGATIONS");
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [r.id]);
    const sid = await networkSettlement(r.id, p, executionId);
    e = await expectPgError(remove());
    expect(e.message).toContain("DRIVER_HAS_NETWORK_OBLIGATIONS");
    await sql(`update public.ride_settlements set status = 'disputed' where id = $1`, [sid]);
    expect((await expectPgError(remove())).code).toBe("55000");
    await sql(`update public.ride_settlements set status = 'paid', settled_at = now(), settled_method = 'cash' where id = $1`, [sid]);
    expect(await remove()).toHaveLength(1);
    // Traces chez A conservées sans la fiche : course sans chauffeur ni véhicule de B, exécution et règlement détachés
    expect(await ride(r.id)).toMatchObject({ driver_id: null, driver_org_id: null, vehicle_id: null });
    const [x] = await sql(`select executor_driver_id, end_reason from public.ride_network_executions where id = $1`, [executionId]);
    expect(x).toEqual({ executor_driver_id: null, end_reason: "completed" });
    const [s] = await sql(`select network_driver_id, network_driver_org_id from public.ride_settlements where id = $1`, [sid]);
    expect(s).toEqual({ network_driver_id: null, network_driver_org_id: p.B.id });
  });

  it("B ne retire pas DIRECTEMENT le statut actif d'un chauffeur qui tient une course de A (droit par colonne) ; ensuite, si", async () => {
    const p = await networkPair();
    const admin = await createMember(p.B, "admin");
    const { ride: r } = await partnerRide(p);
    const setStatus = (who: string, status: string) =>
      as({ sub: who }, (q) => q(`update public.drivers set status = $2 where id = $1 returning id`, [p.partner.id, status]));
    for (const [who, status] of [[p.B.ownerId, "inactive"], [admin, "suspended"], [p.B.ownerId, "invited"]] as const) {
      const e = await expectPgError(setStatus(who, status));
      expect(e.code, status).toBe("55000");
      expect(e.message, status).toContain("DRIVER_HAS_NETWORK_OBLIGATIONS");
    }
    // Client à bord : de même
    await sql(`update public.rides set status = 'IN_PROGRESS', started_at = now() where id = $1`, [r.id]);
    expect((await expectPgError(setStatus(p.B.ownerId, "suspended"))).code).toBe("55000");
    // Autres colonnes de la fiche : inchangé
    await as({ sub: p.B.ownerId }, (q) => q(`update public.drivers set notes = 'RAS' where id = $1`, [p.partner.id]));
    expect((await sql(`select status from public.drivers where id = $1`, [p.partner.id]))[0].status).toBe("active");
    // Course terminée : statut de nouveau libre
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [r.id]);
    expect(await setStatus(p.B.ownerId, "inactive")).toHaveLength(1);
    // Chauffeur sans course partenaire : inchangé
    const mate = await createDriver(p.B);
    expect(await as({ sub: admin }, (q) => q(`update public.drivers set status = 'suspended' where id = $1 returning id`, [mate.id])))
      .toHaveLength(1);
  });

  it("fiche sans lien réseau : suppression inchangée", async () => {
    const B = await createOrg(`G7 libre ${tag()}`);
    const d = await createDriver(B);
    expect(await as({ sub: B.ownerId }, (q) => q(`delete from public.drivers where id = $1 returning id`, [d.id]))).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
describe("G8 : course en cours d'un chauffeur (clé simple)", () => {
  it("course de son organisation (comme avant) ou course d'une autre organisation qu'il tient ; sinon 42501", async () => {
    const p = await networkPair();
    const own = await createRideAsOwner(p.B);
    await sql(`update public.drivers set current_ride_id = $2 where id = $1`, [p.partner.id, own.id]);
    const notHeld = await rideInNetwork(p.A);
    const e = await expectPgError(sql(`update public.drivers set current_ride_id = $2 where id = $1`, [p.partner.id, notHeld.id]));
    expect(e.code).toBe("42501");
    const { ride: held } = await partnerRide(p);
    await sql(`update public.drivers set current_ride_id = $2 where id = $1`, [p.partner.id, held.id]);
    await sql(`update public.drivers set current_ride_id = null where id = $1`, [p.partner.id]);
    // Course inexistante : refusée
    expect((await expectPgError(sql(`update public.drivers set current_ride_id = gen_random_uuid() where id = $1`, [p.partner.id]))).code).toBe("42501");
  });
});

// -----------------------------------------------------------------------------
describe("G9 : termes modifiés pendant la recherche réseau", () => {
  it("offres réseau en attente fermées « terms_changed », notifications d'offre supprimées, chauffeur libéré ; offre propre intacte", async () => {
    const p = await networkPair();
    const own = await createDriver(p.A, { at: north(CHAMPS_ELYSEES, 5000) });
    const r = await rideInNetwork(p.A);
    const o = await offerTo(r.id, p.A, p.partner);
    await sql(`update public.drivers set presence = 'offered' where id = $1`, [p.partner.id]);
    await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, offer_id, type, title, body) values ($1, $2, $3, $4, 'ride_offer', 'COURSE PARTENAIRE', 'x')`,
      [p.A.id, p.partner.id, r.id, o.id],
    );
    const [ownOffer] = await sql(
      `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, expires_at) values ($1, $2, $3, 'pending', 'geo', 7, now() + interval '30 seconds') returning id`,
      [p.A.id, r.id, own.id],
    );
    await as({ sub: p.A.ownerId }, (q) => q(`update public.rides set comment = 'Code 1234' where id = $1`, [r.id]));
    expect((await sql(`select status from public.ride_offers where id = $1`, [o.id]))[0].status).toBe("pending");
    await as({ sub: p.A.ownerId }, (q) => q(`update public.rides set price_cents = 8000 where id = $1`, [r.id]));
    const [closed] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [o.id]);
    expect(closed).toEqual({ status: "closed", closed_reason: "terms_changed" });
    expect(await sql(`select 1 from public.notifications where ride_id = $1 and driver_id = $2`, [r.id, p.partner.id])).toHaveLength(0);
    expect((await sql(`select presence from public.drivers where id = $1`, [p.partner.id]))[0].presence).toBe("available");
    expect((await sql(`select status from public.ride_offers where id = $1`, [ownOffer.id]))[0].status).toBe("pending");
    // Reproposable avec les nouveaux termes (une offre « terms_changed » n'exclut pas le chauffeur)
    await offerTo(r.id, p.A, p.partner, { terms: networkTermsJson({ price: 8000, fee: 800 }) });
  });

  it("une seule course : les offres réseau des autres courses de A restent ouvertes (close_network_offers, filtre course)", async () => {
    const p = await networkPair();
    const r1 = await rideInNetwork(p.A);
    const o1 = await offerTo(r1.id, p.A, p.partner);
    const r2 = await rideInNetwork(p.A);
    const o2 = await offerTo(r2.id, p.A, p.partner);
    await as({ sub: p.A.ownerId }, (q) => q(`update public.rides set passengers = 3 where id = $1`, [r1.id]));
    const status = async (id: string) => (await sql(`select status, closed_reason from public.ride_offers where id = $1`, [id]))[0];
    expect(await status(o1.id)).toEqual({ status: "closed", closed_reason: "terms_changed" });
    expect(await status(o2.id)).toEqual({ status: "pending", closed_reason: null });
    // Vol retardé (lot dispatch) : même portée
    const [{ n }] = await sql(`select private.close_network_offers($1, null, null, 'flight_rescheduled', $2) as n`, [p.A.id, r2.id]);
    expect(n).toBe(1);
    expect(await status(o2.id)).toEqual({ status: "closed", closed_reason: "flight_rescheduled" });
  });
});

// -----------------------------------------------------------------------------
describe("G10 : état du partage et fin d'exécution (seul endroit)", () => {
  it("ouverture, acceptation, retrait motivé, réouverture (cycle 2), chauffeur propre ; diffusion org:{A} / org:{B} par ids seulement", async () => {
    const p = await networkPair();
    const before = (await sql(`select coalesce(max(id), 0) as id from realtime.messages`))[0].id;
    const r = await rideInNetwork(p.A);
    let s = await share(r.id);
    expect(s).toMatchObject({ organization_id: p.A.id, status: "open", cycle: 1, opened_stage: "instant", partners_offered: 0, closed_reason: null });
    expect(s.giver_terms_version).toBe(await networkTermsVersion());
    const offer = await offerTo(r.id, p.A, p.partner);
    const executionId = await acceptAsPartner(r.id, p, offer.id);
    expect((await share(r.id)).status).toBe("accepted");

    await removePartner(r.id, p, "executor_released");
    s = await share(r.id);
    expect(s).toMatchObject({ status: "closed", closed_reason: "executor_released" });
    expect(await executions(r.id)).toEqual([expect.objectContaining({ id: executionId, end_reason: "executor_released" })]);

    await sql(`update public.ride_network_shares set partners_offered = 4, errors = 1 where ride_id = $1`, [r.id]);
    await sql(`update public.rides set network_at = now() where id = $1`, [r.id]);
    s = await share(r.id);
    expect(s).toMatchObject({ status: "open", cycle: 2, partners_offered: 0, errors: 0, closed_at: null, closed_reason: null });

    // Un chauffeur de A se libère et accepte pendant la phase réseau
    const own = await createDriver(p.A);
    await sql(`update public.rides set driver_id = $2, vehicle_id = $3, status = 'ACCEPTED' where id = $1`, [r.id, own.id, own.vehicleId]);
    expect(await share(r.id)).toMatchObject({ status: "closed", closed_reason: "reassigned_own" });

    const msgs = await sql(`select topic, event, payload from realtime.messages where id > $1 and event = 'network.updated' order by id`, [before]);
    const toA = msgs.filter((m) => m.topic === `org:${p.A.id}`);
    const toB = msgs.filter((m) => m.topic === `org:${p.B.id}`);
    expect(toA.length).toBeGreaterThanOrEqual(4);
    for (const m of toA) expect(m.payload).toEqual({ ride_id: r.id });
    expect(toB.length).toBeGreaterThanOrEqual(2);
    for (const m of toB) expect(m.payload).toEqual({ execution_id: executionId });
  });

  it("fin de course : exécution « completed » avant règlement et frais ; annulation, non effectuée, aucun chauffeur", async () => {
    const p = await networkPair();
    const { ride: done, executionId } = await partnerRide(p);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [done.id]);
    expect(await executions(done.id)).toEqual([expect.objectContaining({ id: executionId, end_reason: "completed" })]);
    expect(await share(done.id)).toMatchObject({ status: "completed", closed_reason: null });
    expect((await share(done.id)).closed_at).not.toBeNull();

    const { ride: cancelled } = await partnerRide(p);
    expect((await sql(`select private.cancel_ride_internal($1, 'Client absent', 'user', null) as r`, [cancelled.id]))[0].r.ok).toBe(true);
    expect((await executions(cancelled.id))[0].end_reason).toBe("cancelled_by_giver");
    expect(await share(cancelled.id)).toMatchObject({ status: "closed", closed_reason: "cancelled" });

    // Planifiée acceptée jamais démarrée : clôturée « Non effectuée » par private.expire_unstarted_rides (C24)
    const late = await rideInNetwork(p.A, { pickup_at: new Date(Date.now() + 3 * 3600_000).toISOString() });
    await sql(`update public.rides set pickup_at = now() - interval '7 hours' where id = $1`, [late.id]);
    await acceptAsPartner(late.id, p, (await offerTo(late.id, p.A, p.partner)).id);
    expect((await ride(late.id)).type).toBe("scheduled");
    await sql(`select private.expire_unstarted_rides()`);
    expect((await executions(late.id))[0].end_reason).toBe("not_performed");
    expect(await share(late.id)).toMatchObject({ status: "closed", closed_reason: "not_performed" });

    // Clôture par A (close_network_ride, lot dispatch) : « completed » comme toute fin (motif dans suspect_reasons)
    const { ride: closed, executionId: closedExecution } = await partnerRide(p);
    await ownerTx(async (q) => {
      await q(`select set_config('rydar.network_reason', 'closed_by_giver', true)`);
      await q(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [closed.id]);
    });
    expect((await executions(closed.id))[0].end_reason).toBe("completed");
    expect(await share(closed.id)).toMatchObject({ status: "completed" });
    const e = await expectPgError(sql(`update public.ride_network_executions set end_reason = 'closed_by_giver' where id = $1`, [closedExecution]));
    expect(e.code).toBe("23514");
    await sql(`update public.ride_network_executions set suspect_reasons = array['closed_by_giver'] where id = $1`, [closedExecution]);

    const nobody = await rideInNetwork(p.A);
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND', no_driver_at = now(), next_dispatch_at = null where id = $1`, [nobody.id]);
    expect(await share(nobody.id)).toMatchObject({ status: "closed", closed_reason: "no_driver" });

    // Réseau refermé sans motif (relance) / avec motif
    const relaunched = await rideInNetwork(p.A);
    await sql(`update public.rides set network_at = null where id = $1`, [relaunched.id]);
    expect(await share(relaunched.id)).toMatchObject({ status: "closed", closed_reason: "redispatch" });
    const windowed = await rideInNetwork(p.A);
    await ownerTx(async (q) => {
      await q(`select set_config('rydar.network_reason', 'window_elapsed', true)`);
      await q(`update public.rides set network_at = null where id = $1`, [windowed.id]);
    });
    expect(await share(windowed.id)).toMatchObject({ status: "closed", closed_reason: "window_elapsed" });
  });

  it("planifiée : étape « scheduled_window » avant prise en charge − délai de A, « scheduled_geo » ensuite", async () => {
    const p = await networkPair();
    const far = await rideInNetwork(p.A, { pickup_at: new Date(Date.now() + 5 * 3600_000).toISOString() });
    expect((await share(far.id)).opened_stage).toBe("scheduled_window");
    const near = await rideInNetwork(p.A, { pickup_at: new Date(Date.now() + 50 * 60_000).toISOString() });
    expect((await ride(near.id)).type).toBe("scheduled");
    expect((await share(near.id)).opened_stage).toBe("scheduled_geo");
  });

  it("interrupteur coupé, aucune course réseau : rien n'est écrit ni diffusé", async () => {
    await setSharedNetwork(false);
    const A = await createOrg(`G10 coupé ${tag()}`);
    const d = await createDriver(A, { at: north(CHAMPS_ELYSEES, 300) });
    const before = (await sql(`select coalesce(max(id), 0) as id from realtime.messages`))[0].id;
    const r = await createRideAsOwner(A);
    const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2`, [r.id, d.id]);
    await as({ sub: d.userId }, (q) => q(`select public.accept_ride_offer($1)`, [offer.id]));
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      const [res] = await as({ sub: d.userId }, (q) => q(`select public.driver_update_ride_status($1, $2::public.ride_status) as r`, [r.id, s]));
      expect(res.r.ok, s).toBe(true);
    }
    expect(await share(r.id)).toBeUndefined();
    expect(await sql(`select 1 from realtime.messages where id > $1 and event = 'network.updated'`, [before])).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe("G11 : identité de l'organisation modifiée", () => {
  it("nom, raison sociale, SIRET ou n° VTC : validation perdue, offres réseau fermées (deux sens), audit ; autre champ : rien", async () => {
    const p = await networkPair();
    // B partage aussi : offre de B à un chauffeur de A
    await enableNetwork(p.B, { out: true, in: true });
    await enableNetwork(p.A, { out: true, in: true });
    const aDriver = await createDriver(p.A);
    const given = await rideInNetwork(p.A);
    const givenOffer = await offerTo(given.id, p.A, p.partner);
    const received = await rideInNetwork(p.B);
    const receivedOffer = await offerTo(received.id, p.B, aDriver);

    await as({ sub: p.A.ownerId }, (q) => q(`update public.organizations set phone = '+33140000000' where id = $1`, [p.A.id]));
    expect((await sql(`select approved_at from public.network_memberships where organization_id = $1`, [p.A.id]))[0].approved_at).not.toBeNull();

    await as({ sub: p.A.ownerId }, (q) => q(`update public.organizations set legal_name = 'Nouvelle Raison SAS' where id = $1`, [p.A.id]));
    const [m] = await sql(`select approved_at, approved_legal_name from public.network_memberships where organization_id = $1`, [p.A.id]);
    expect(m.approved_at).toBeNull();
    expect(m.approved_legal_name).not.toBeNull(); // instantané gardé : « nouvelle vérification nécessaire »
    for (const id of [givenOffer.id, receivedOffer.id]) {
      expect((await sql(`select status, closed_reason from public.ride_offers where id = $1`, [id]))[0]).toEqual({ status: "closed", closed_reason: "sharing_stopped" });
    }
    const [audit] = await sql(
      `select actor_type, actor_user_id, metadata from public.audit_logs where organization_id = $1 and action = 'network.approval_lost'`,
      [p.A.id],
    );
    expect(audit).toMatchObject({ actor_type: "user", actor_user_id: p.A.ownerId, metadata: { fields: ["legal_name"], closed_offers: 2 } });
    // Organisation non validée : rien
    const C = await createOrg(`G11 libre ${tag()}`);
    await as({ sub: C.ownerId }, (q) => q(`update public.organizations set name = 'Autre nom' where id = $1`, [C.id]));
    expect(await sql(`select 1 from public.audit_logs where organization_id = $1 and action = 'network.approval_lost'`, [C.id])).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe("G12 : moyens de paiement pendant le partage", () => {
  it("dernier moyen en ligne retiré : refusé si partage demandé et réseau ouvert ; sinon permis", async () => {
    const p = await networkPair();
    const admin = await createMember(p.A, "admin");
    const setMethods = (methods: string[], extra = "") =>
      as({ sub: admin }, (q) => q(`update public.organization_settings set settlement_methods = $2${extra} where organization_id = $1`, [p.A.id, methods]));
    const e = await expectPgError(setMethods(["cash"]));
    expect(e.code).toBe("55000");
    expect(e.message).toContain("NETWORK_PAYMENT_METHODS_REQUIRED");
    // Lien retiré mais virement proposé : permis
    await as({ sub: admin }, (q) =>
      q(`update public.organization_settings set settlement_iban = 'FR7630006000011234567890189', settlement_payee_name = 'Donneuse SAS' where organization_id = $1`, [p.A.id]));
    await setMethods(["transfer", "cash"]);
    // Réseau fermé : permis
    await setSharedNetwork(false);
    await setMethods(["cash"]);
    await setSharedNetwork(true);
    // Aucun moyen en ligne avant : autres changements permis
    await as({ sub: admin }, (q) => q(`update public.organization_settings set settlement_instructions = 'Espèces au bureau' where organization_id = $1`, [p.A.id]));
    // Partage non demandé : permis
    const B = await createOrg(`G12 réception ${tag()}`);
    await enableNetwork(B, { in: true });
    await as({ sub: B.ownerId }, (q) => q(`update public.organization_settings set settlement_methods = '{cash}' where organization_id = $1`, [B.id]));
  });
});

// -----------------------------------------------------------------------------
describe("G13 : index d'identités", () => {
  const keys = async (driverId: string) =>
    (await sql(`select kind, value_hash from private.driver_identity_keys where driver_id = $1 order by kind, value_hash`, [driverId]))
      .map((k) => `${k.kind}:${k.value_hash}`);

  it("fiche créée, téléphone, e-mail, carte VTC, compte ; e-mail du compte ; fiche supprimée : aucune empreinte", async () => {
    const B = await createOrg(`G13 ${tag()}`);
    const d = await createDriver(B);
    const initial = await keys(d.id);
    const [{ phones }] = await sql(`select private.identity_hashes('phone', '+33600000000') as phones`);
    for (const h of phones as string[]) expect(initial).toContain(`phone:${h}`);
    const [{ acc }] = await sql(`select private.account_identity_hash($1) as acc`, [d.userId]);
    expect(initial).toContain(`account:${acc}`);
    expect(initial.filter((k) => k.startsWith("email:"))).toHaveLength(1);

    await as({ sub: B.ownerId }, (q) => q(`update public.drivers set phone = '06 12 34 56 78', vtc_card_number = 'EVTC-123-456', email = 'karim@exemple.fr' where id = $1`, [d.id]));
    const changed = await keys(d.id);
    const [{ vtc }] = await sql(`select private.identity_hash('vtc_card', 'EVTC123456') as vtc`);
    expect(changed).toContain(`vtc_card:${vtc}`);
    const [{ newPhone }] = await sql(`select private.identity_hash('phone', '+33612345678') as "newPhone"`);
    expect(changed).toContain(`phone:${newPhone}`);
    expect(changed.filter((k) => k.startsWith("email:"))).toHaveLength(2);
    for (const h of phones as string[]) expect(changed).not.toContain(`phone:${h}`);

    await sql(`update public.users set email = 'nouveau-compte@exemple.fr' where id = $1`, [d.userId]);
    const [{ mail }] = await sql(`select private.identity_hash('email', 'nouveau-compte@exemple.fr') as mail`);
    expect(await keys(d.id)).toContain(`email:${mail}`);

    await sql(`update public.drivers set deleted_at = now(), phone = '', email = null, vtc_card_number = null, user_id = null where id = $1`, [d.id]);
    expect(await keys(d.id)).toEqual([]);
  });

  it("jamais lisible ni modifiable par un client, ni par le service role", async () => {
    const B = await createOrg(`G13 droits ${tag()}`);
    for (const who of [{ sub: B.ownerId }, { role: "service_role" as const }, { role: "anon" as const }]) {
      for (const table of ["private.driver_identity_keys", "private.network_driver_exclusions", "private.network_debtor_identities"]) {
        const e = await expectPgError(as(who, (q) => q(`select * from ${table} limit 1`)));
        expect(e.code, `${table} ${JSON.stringify(who)}`).toBe("42501");
      }
    }
  });
});

// -----------------------------------------------------------------------------
describe("Policies : aucune lecture croisée entre organisations", () => {
  it("membres de B (tous rôles) : rien de la course de A ; chauffeur partenaire : course illisible, son offre sans les termes", async () => {
    const p = await networkPair();
    const { ride: r, executionId } = await partnerRide(p);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [r.id]);
    await networkSettlement(r.id, p, executionId);
    await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body) values ($1, $2, $3, 'test', 'T', 'B')`,
      [p.A.id, p.partner.id, r.id],
    );
    const bAdmin = await createMember(p.B, "admin");
    const bDispatcher = await createMember(p.B, "dispatcher");
    for (const who of [p.B.ownerId, bAdmin, bDispatcher]) {
      const rows = await as({ sub: who }, async (q) => ({
        rides: await q(`select id from public.rides where id = $1`, [r.id]),
        events: await q(`select id from public.ride_events where ride_id = $1`, [r.id]),
        offers: await q(`select id from public.ride_offers where ride_id = $1`, [r.id]),
        assignments: await q(`select id from public.ride_assignments where ride_id = $1`, [r.id]),
        notifications: await q(`select id from public.notifications where ride_id = $1`, [r.id]),
        settlements: await q(`select id from public.ride_settlements where ride_id = $1`, [r.id]),
      }));
      expect(rows, who).toEqual({ rides: [], events: [], offers: [], assignments: [], notifications: [], settlements: [] });
      for (const table of ["ride_network_shares", "ride_network_executions", "driver_payout_details"]) {
        expect((await expectPgError(as({ sub: who }, (q) => q(`select * from public.${table} limit 1`)))).code, table).toBe("42501");
      }
    }
    // Chauffeur partenaire
    const mine = await as({ sub: p.partner.userId }, async (q) => ({
      rides: await q(`select id from public.rides where id = $1`, [r.id]),
      offers: await q(`select id, status, is_network from public.ride_offers where ride_id = $1`, [r.id]),
      notifications: await q(`select type from public.notifications where ride_id = $1 order by type`, [r.id]),
      settlements: await q(`select id from public.ride_settlements where ride_id = $1`, [r.id]),
    }));
    expect(mine.rides).toEqual([]);
    expect(mine.offers).toEqual([expect.objectContaining({ status: "accepted", is_network: true })]);
    // Ses notifications de la course : la sienne (test) et « À RÉGLER À {A} » du règlement réseau (lot argent, 006900)
    expect(mine.notifications).toEqual([{ type: "settlement_due" }, { type: "test" }]);
    expect(mine.settlements).toEqual([]);
    for (const stmt of [`select network_terms from public.ride_offers`, `select * from public.ride_offers`]) {
      expect((await expectPgError(as({ sub: p.partner.userId }, (q) => q(stmt)))).code, stmt).toBe("42501");
    }
  });

  it("membres de A : offres réseau, attributions et notifications du partenaire invisibles ; course et règlement visibles", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const own = await createDriver(p.A, { at: north(CHAMPS_ELYSEES, 5000) });
    const r = await rideInNetwork(p.A);
    await sql(
      `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave) values ($1, $2, $3, 'expired', 'geo', 1)`,
      [p.A.id, r.id, own.id],
    );
    const offer = await offerTo(r.id, p.A, p.partner);
    await acceptAsPartner(r.id, p, offer.id);
    await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body) values ($1, $2, $3, 'ride_reminder', 'T', 'B')`,
      [p.A.id, p.partner.id, r.id],
    );
    for (const who of [p.A.ownerId, dispatcher]) {
      const rows = await as({ sub: who }, async (q) => ({
        ride: await q(`select driver_id, driver_org_id from public.rides where id = $1`, [r.id]),
        offers: await q(`select driver_id from public.ride_offers where ride_id = $1`, [r.id]),
        assignments: await q(`select id from public.ride_assignments where ride_id = $1`, [r.id]),
        notifications: await q(`select id from public.notifications where ride_id = $1 and driver_id is not null`, [r.id]),
        partner: await q(`select id from public.drivers where id = $1`, [p.partner.id]),
      }));
      expect(rows.ride).toEqual([{ driver_id: p.partner.id, driver_org_id: p.B.id }]);
      expect(rows.offers).toEqual([{ driver_id: own.id }]);
      expect(rows.assignments).toEqual([]);
      expect(rows.notifications).toEqual([]);
      expect(rows.partner).toEqual([]);
    }
  });

  it("position (Q5) : masquée à B pendant la course partenaire en cours, visible avant et après ; historique de la course invisible", async () => {
    const p = await networkPair();
    const bDispatcher = await createMember(p.B, "dispatcher");
    const visible = async (who: string) =>
      (await as({ sub: who }, (q) => q(`select driver_id from public.driver_locations where driver_id = $1`, [p.partner.id]))).length;
    expect(await visible(bDispatcher)).toBe(1);
    const { ride: r } = await partnerRide(p);
    // Acceptée mais pas encore sa course en cours (planifiée) : visible
    expect(await visible(bDispatcher)).toBe(1);
    await sql(`update public.drivers set current_ride_id = $2, presence = 'en_route' where id = $1`, [p.partner.id, r.id]);
    await sql(`update public.rides set status = 'DRIVER_EN_ROUTE' where id = $1`, [r.id]);
    expect(await visible(bDispatcher)).toBe(0);
    expect(await visible(p.B.ownerId)).toBe(0);
    expect(await visible(p.partner.userId)).toBe(1);
    // Même règle pour les diffusions (lot accès) ; l'autre chauffeur de B reste visible
    expect((await sql(`select private.driver_on_foreign_ride($1) as on`, [p.partner.id]))[0].on).toBe(true);
    const mate = await createDriver(p.B, { at: north(CHAMPS_ELYSEES, 900) });
    expect((await as({ sub: bDispatcher }, (q) => q(`select driver_id from public.driver_locations where organization_id = $1`, [p.B.id])))
      .map((x) => x.driver_id)).toEqual([mate.id]);
    // Points de la course (organisation de la course ≠ B) : invisibles pour B, visibles pour le chauffeur
    await sql(
      `insert into public.driver_location_history (organization_id, driver_id, ride_id, ride_org_id, lat, lng)
       values ($1, $2, $3, $4, 48.87, 2.30), ($1, $2, null, null, 48.88, 2.31), ($1, $2, null, $1, 48.89, 2.32)`,
      [p.B.id, p.partner.id, r.id, p.A.id],
    );
    const history = (who: string) => as({ sub: who }, (q) => q(`select ride_org_id from public.driver_location_history where driver_id = $1 order by lat`, [p.partner.id]));
    expect(await history(bDispatcher)).toEqual([{ ride_org_id: null }, { ride_org_id: p.B.id }]);
    expect(await history(p.partner.userId)).toHaveLength(3);
    // Fin de course : de nouveau visible
    await sql(`update public.drivers set current_ride_id = null, presence = 'available' where id = $1`, [p.partner.id]);
    expect(await visible(bDispatcher)).toBe(1);
    expect((await sql(`select private.driver_on_foreign_ride($1) as on`, [p.partner.id]))[0].on).toBe(false);
  });

  it("réglages réseau : chaque organisation ne lit que ses lignes ; l'exclue ne voit jamais l'exclusion", async () => {
    const p = await networkPair();
    const aDispatcher = await createMember(p.A, "dispatcher");
    await sql(`insert into public.network_exclusions (organization_id, excluded_org_id, created_by) values ($1, $2, $3)`, [p.A.id, p.B.id, p.A.ownerId]);
    const read = (who: string) =>
      as({ sub: who }, async (q) => ({
        memberships: (await q(`select organization_id from public.network_memberships`)).map((x) => x.organization_id),
        exclusions: (await q(`select organization_id from public.network_exclusions`)).map((x) => x.organization_id),
        settings: (await q(`select driver_id from public.driver_network_settings`)).map((x) => x.driver_id),
      }));
    expect(await read(aDispatcher)).toEqual({ memberships: [p.A.id], exclusions: [p.A.id], settings: [] });
    expect(await read(p.B.ownerId)).toEqual({ memberships: [p.B.id], exclusions: [], settings: [p.partner.id] });
    expect(await read(p.partner.userId)).toEqual({ memberships: [], exclusions: [], settings: [p.partner.id] });
    for (const table of ["network_memberships", "network_exclusions", "driver_network_settings"]) {
      expect((await expectPgError(as({ role: "anon" }, (q) => q(`select * from public.${table}`)))).code, table).toBe("42501");
    }
  });
});

// -----------------------------------------------------------------------------
describe("Droits : écritures réseau par les fonctions seulement", () => {
  it("aucune écriture client sur les tables et colonnes réseau ; aides private inaccessibles", async () => {
    const p = await networkPair();
    const r = await createRideAsOwner(p.A);
    const denied: [string, string, unknown[]][] = [
      [p.A.ownerId, `update public.rides set network_at = now() where id = $1`, [r.id]],
      [p.A.ownerId, `update public.rides set driver_org_id = $2 where id = $1`, [r.id, p.B.id]],
      [p.A.ownerId, `update public.network_memberships set share_out = true where organization_id = $1`, [p.A.id]],
      [p.A.ownerId, `insert into public.network_exclusions (organization_id, excluded_org_id) values ($1, $2)`, [p.A.id, p.B.id]],
      [p.B.ownerId, `update public.driver_network_settings set org_allowed = false where driver_id = $1`, [p.partner.id]],
      [p.partner.userId, `update public.driver_network_settings set enabled = false where driver_id = $1`, [p.partner.id]],
      [p.partner.userId, `insert into public.driver_payout_details (driver_id, organization_id, payee_name, iban, iban_hash) values ($1, $2, 'K', 'FR7630006000011234567890189', repeat('a', 64))`, [p.partner.id, p.B.id]],
      [p.A.ownerId, `select private.network_pair_ok($1, $2)`, [p.A.id, p.B.id]],
      [p.A.ownerId, `select private.network_org_reason($1, 'out')`, [p.A.id]],
      [p.A.ownerId, `select private.close_network_offers($1, null, null, 'sharing_stopped')`, [p.A.id]],
      // Répond pour n'importe quel chauffeur : fonctions serveur seulement (la policy passe par member_drivers_on_foreign_ride)
      [p.A.ownerId, `select private.driver_on_foreign_ride($1)`, [p.partner.id]],
      [p.B.ownerId, `select private.driver_on_foreign_ride($1)`, [p.partner.id]],
    ];
    for (const [who, stmt, params] of denied) {
      const e = await expectPgError(as({ sub: who }, (q) => q(stmt, params)));
      expect(e.code, stmt).toBe("42501");
    }
    expect((await expectPgError(as({ role: "anon" }, (q) => q(`select public.shared_network_enabled()`)))).code).toBe("42501");
    expect((await as({ sub: p.A.ownerId }, (q) => q(`select public.shared_network_enabled() as on`)))[0].on).toBe(true);
  });

  it("n° d'exploitant VTC d'un chauffeur : owner / admin seulement, 3 à 80 caractères", async () => {
    const B = await createOrg(`Exploitant ${tag()}`);
    const admin = await createMember(B, "admin");
    const dispatcher = await createMember(B, "dispatcher");
    const d = await createDriver(B);
    const set = (who: string, value: string) =>
      as({ sub: who }, (q) => q(`update public.drivers set vtc_operator_registration = $2 where id = $1 returning id`, [d.id, value]));
    const e = await expectPgError(set(dispatcher, "EVTC075123456"));
    expect(e.code).toBe("42501");
    expect(e.message).toContain("FORBIDDEN_ROLE");
    expect(await set(admin, "EVTC075123456")).toHaveLength(1);
    expect(await set(B.ownerId, "EVTC075654321")).toHaveLength(1);
    expect((await expectPgError(set(B.ownerId, "AB"))).code).toBe("23514");
    // Le chauffeur lit sa fiche, mais ne la modifie pas
    expect(await set(d.userId, "EVTC000000000")).toHaveLength(0);
    expect((await sql(`select vtc_operator_registration from public.drivers where id = $1`, [d.id]))[0].vtc_operator_registration).toBe("EVTC075654321");
  });
});

// -----------------------------------------------------------------------------
describe("Éligibilité et convention (aides du lot 2, contrats du lot 0)", () => {
  it("network_org_reason : chaque raison de NETWORK_ORG_REASONS, dans l'ordre ; network_pair_ok", async () => {
    const reason = async (org: Org, dir: "out" | "in") =>
      (await sql(`select private.network_org_reason($1, $2) as r`, [org.id, dir]))[0].r as string | null;
    const p = await networkPair();
    const seen = new Set<string>();
    const expectReason = async (org: Org, dir: "out" | "in", expected: string | null) => {
      const r = await reason(org, dir);
      expect(r, `${dir} → ${expected}`).toBe(expected);
      if (r) seen.add(r);
    };
    await expectReason(p.A, "out", null);
    await expectReason(p.B, "in", null);
    expect((await sql(`select private.network_pair_ok($1, $2) as ok`, [p.A.id, p.B.id]))[0].ok).toBe(true);
    expect((await sql(`select private.network_pair_ok($1, $2) as ok`, [p.B.id, p.A.id]))[0].ok).toBe(false);
    expect((await sql(`select private.network_pair_ok($1, $1) as ok`, [p.A.id]))[0].ok).toBe(false);

    await expectReason(p.A, "in", "not_receiving");
    await expectReason(p.B, "out", "not_sharing");
    const none = await createOrg(`Sans adhésion ${tag()}`);
    await expectReason(none, "out", "not_sharing");
    await expectReason(none, "in", "not_receiving");

    // Partage : moyen en ligne (retiré pendant une fermeture du réseau, G12), frais Rydar (ou dérogation), versement
    // réseau en retard
    await setSharedNetwork(false);
    await sql(`update public.organization_settings set settlement_methods = '{cash}' where organization_id = $1`, [p.A.id]);
    await setSharedNetwork(true);
    await expectReason(p.A, "out", "online_payment_method");
    await sql(`update public.organization_settings set settlement_methods = '{link,cash}' where organization_id = $1`, [p.A.id]);
    await sql(`update public.organizations set platform_fee_percent = 0, platform_fee_fixed_cents = 0 where id = $1`, [p.A.id]);
    await expectReason(p.A, "out", "platform_fee");
    await sql(`update public.network_memberships set fee_waiver = true where organization_id = $1`, [p.A.id]);
    await expectReason(p.A, "out", null);
    const { ride: r, executionId } = await partnerRide(p);
    await sql(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [r.id]);
    const sid = await networkSettlement(r.id, p, executionId);
    await sql(`update public.ride_settlements set direction = 'centrale_owes', amount_cents = 6480, due_at = now() - interval '8 days' where id = $1`, [sid]);
    await expectReason(p.A, "out", "payouts_overdue");
    await sql(`update public.ride_settlements set due_at = now() - interval '6 days' where id = $1`, [sid]);
    await expectReason(p.A, "out", null);
    // Réception : assurance
    await sql(`update public.network_memberships set insurance_confirmed_at = null where organization_id = $1`, [p.B.id]);
    await expectReason(p.B, "in", "insurance");
    // Convention périmée, validation, suspension, organisation, interrupteur (ordre : le premier manque l'emporte)
    await sql(`update public.network_memberships set terms_version = '2020-01-01' where organization_id = $1`, [p.B.id]);
    await expectReason(p.B, "in", "terms");
    await sql(`update public.network_memberships set suspended_at = now(), suspended_reason = 'Manquement' where organization_id = $1`, [p.B.id]);
    await expectReason(p.B, "in", "suspended");
    await sql(`update public.network_memberships set approved_at = null where organization_id = $1`, [p.B.id]);
    await expectReason(p.B, "in", "approval_pending");
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [p.B.id]);
    await expectReason(p.B, "in", "org_inactive");
    await setSharedNetwork(false);
    await expectReason(p.A, "out", "network_off");
    expect([...seen].sort()).toEqual([...NETWORK_ORG_REASONS].sort());
  });

  it("network_terms_ok : version courante ; précédente pendant la grâce seulement", async () => {
    const ok = async (v: string | null) => (await sql(`select private.network_terms_ok($1) as ok`, [v]))[0].ok as boolean;
    const current = await networkTermsVersion();
    expect(current).toBe(NETWORK_TERMS_VERSION);
    expect(await ok(current)).toBe(true);
    expect(await ok("2026-01-01")).toBe(false);
    expect(await ok(null)).toBe(false);
    try {
      await sql(`update public.platform_settings set network_terms_min_version = '2026-01-01', network_terms_grace_until = now() + interval '1 day' where id`);
      expect(await ok("2026-01-01")).toBe(true);
      await sql(`update public.platform_settings set network_terms_grace_until = now() - interval '1 second' where id`);
      expect(await ok("2026-01-01")).toBe(false);
      // Version précédente sans date de fin de grâce : refusé par contrôle
      expect((await expectPgError(sql(`update public.platform_settings set network_terms_grace_until = null where id`))).code).toBe("23514");
    } finally {
      await sql(`update public.platform_settings set network_terms_min_version = null, network_terms_grace_until = null where id`);
    }
  });

  it("network_terms_complete : termes du contrat NetworkTerms seulement", async () => {
    const complete = async (t: unknown) => (await sql(`select private.network_terms_complete($1::jsonb) as ok`, [JSON.stringify(t)]))[0].ok as boolean;
    expect(await complete(networkTermsJson({ price: 5000, fee: 500, commission: 750 }))).toBe(true);
    expect(await complete(networkTermsJson({ price: 5000, method: "online", fee: 500 }))).toBe(true);
    expect(await complete({ ...networkTermsJson({ price: 5000, fee: 500 }), direction: "centrale_owes" })).toBe(false);
    expect(await complete({ ...networkTermsJson({ price: 5000, fee: 500 }), amount_cents: 4500 })).toBe(false);
    expect(await complete({ ...networkTermsJson({ price: 5000, fee: 500 }), platform_fee_cents: 500.5 })).toBe(false);
    expect(await complete(networkTermsJson({ price: 500, fee: 500 }))).toBe(false); // part du chauffeur nulle
    const { price_cents: _ignored, ...withoutPrice } = networkTermsJson({ price: 5000, fee: 500 });
    expect(await complete(withoutPrice)).toBe(false);
    expect(await complete({ ...networkTermsJson({ price: 5000, fee: 500 }), price_cents: "5000" })).toBe(false);
  });

  it("preuves d'acceptation : convention (signataire recopié) et conditions chauffeur ; accept_legal_documents les refuse", async () => {
    const p = await networkPair();
    const version = await networkTermsVersion();
    await as({ role: "service_role" }, (q) =>
      q(`insert into public.legal_acceptances (user_id, organization_id, document, version, source) values ($1, $2, 'network', $3, 'web'), ($4, $5, 'network_driver', $3, 'app')`, [
        p.A.ownerId, p.A.id, version, p.partner.userId, p.B.id,
      ]));
    const rows = await sql(
      `select document, accepted_by_email is not null as signed from public.legal_acceptances where organization_id = any ($1::uuid[]) and document like 'network%' order by document`,
      [[p.A.id, p.B.id]],
    );
    expect(rows).toEqual([{ document: "network", signed: true }, { document: "network_driver", signed: false }]);
    const [res] = await as({ sub: p.A.ownerId }, (q) =>
      q(`select public.accept_legal_documents(array['network'], '2026-10-01', $1) as r`, [p.A.id]));
    expect(res.r.code).toBe("INVALID");
    expect((await expectPgError(sql(`insert into public.legal_acceptances (user_id, document, version) values ($1, 'autre', 'v1')`, [p.A.ownerId]))).code).toBe("23514");
  });
});

// -----------------------------------------------------------------------------
describe("Contrats du lot 0 (@rydar/shared/network.ts) : mêmes valeurs que le SQL", () => {
  /** Valeurs texte d'une contrainte CHECK (… = ANY (ARRAY['a', 'b'])). */
  const checkValues = async (conname: string) => {
    const [c] = await sql(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [conname]);
    return [...String(c.def).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
  };
  const columns = async (table: string) =>
    (await sql(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name`,
      [table],
    )).map((r) => r.column_name as string);

  it("états du partage, raisons de clôture, fins d'exécution, contrôles de fin, contrepartie", async () => {
    expect(await checkValues("ride_network_shares_status_check")).toEqual([...NETWORK_SHARE_STATUSES].sort());
    expect(await checkValues("ride_network_shares_closed_reason_check")).toEqual([...NETWORK_SHARE_CLOSED_REASONS].sort());
    expect(await checkValues("ride_network_shares_opened_stage_check")).toEqual(["instant", "scheduled_geo", "scheduled_window"]);
    expect(await checkValues("ride_network_executions_end_reason_check")).toEqual([...NETWORK_EXECUTION_END_REASONS].sort());
    expect(await checkValues("ride_network_executions_suspect_reasons_check")).toEqual([...NETWORK_SUSPECT_REASONS].sort());
    expect(await checkValues("ride_network_executions_counterparty_check")).toEqual([...NETWORK_COUNTERPARTIES].sort());
    expect(await checkValues("ride_settlements_network_counterparty_check")).toEqual([...NETWORK_COUNTERPARTIES].sort());
  });

  it("lignes lisibles par le client : colonnes de NetworkMembership, NetworkExclusion, DriverNetworkSettings", async () => {
    expect(await columns("network_memberships")).toEqual([
      "approved_at", "approved_by", "approved_legal_name", "approved_siret", "approved_vtc_registration", "created_at",
      "executor_credit_limit_cents", "fee_waiver", "insurance_confirmed_at", "insurance_confirmed_by", "organization_id",
      "refused_reason", "requested_at", "share_in", "share_out", "suspended_at", "suspended_by", "suspended_reason",
      "terms_accepted_at", "terms_accepted_by", "terms_version", "updated_at", "updated_by",
    ]);
    expect(await columns("network_exclusions")).toEqual(["created_at", "created_by", "excluded_org_id", "organization_id"]);
    expect(await columns("driver_network_settings")).toEqual([
      "accepted_at", "accepted_version", "capable_at", "driver_id", "enabled", "excluded_until", "org_allowed",
      "org_updated_at", "org_updated_by", "organization_id", "updated_at",
    ]);
    // Plafond par chauffeur : défaut et bornes de NETWORK_PARAMS
    const [d] = await sql(
      `select column_default from information_schema.columns where table_schema = 'public' and table_name = 'network_memberships' and column_name = 'executor_credit_limit_cents'`,
    );
    expect(Number(d.column_default)).toBe(NETWORK_PARAMS.executorCreditLimitDefaultCents);
    const [c] = await sql(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'network_memberships_executor_credit_limit_cents_check'`);
    expect(c.def).toContain(`<= ${NETWORK_PARAMS.executorCreditLimitMaxCents}`);
  });

  it("motifs de fermeture des offres réseau (NetworkOfferClosedReason) ; motif inconnu refusé ; motif d'une course sans sa course refusé", async () => {
    const [rideId, driverId] = [randomUUID(), randomUUID()];
    for (const reason of ["network_unavailable", "sharing_stopped"]) {
      await sql(`select private.close_network_offers(gen_random_uuid(), null, null, $1)`, [reason]);
      await sql(`select private.close_network_offers(null, null, null, $1, $2)`, [reason, rideId]);
    }
    for (const reason of ["terms_changed", "flight_rescheduled"]) {
      await sql(`select private.close_network_offers(gen_random_uuid(), null, null, $1, $2)`, [reason, rideId]);
      expect((await expectPgError(sql(`select private.close_network_offers(gen_random_uuid(), null, null, $1)`, [reason]))).code, reason)
        .toBe("22023");
    }
    await sql(`select private.close_network_offers(null, null, $1, 'driver_busy', $2)`, [driverId, rideId]);
    for (const args of [[null, rideId], [driverId, null]]) {
      expect((await expectPgError(sql(`select private.close_network_offers(null, null, $1, 'driver_busy', $2)`, args))).code).toBe("22023");
    }
    expect((await expectPgError(sql(`select private.close_network_offers(null, null, null, 'autre')`))).code).toBe("22023");
  });

  it("termes validés à l'insertion seulement : une fonction de contrôle durcie plus tard ne bloque ni l'expiration d'une offre ni la fin d'une course", async () => {
    const p = await networkPair();
    const r = await rideInNetwork(p.A);
    const pending = await offerTo(r.id, p.A, p.partner);
    const { ride: held, executionId } = await partnerRide(p);
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Contrôle durci (clé « currency » exigée) : plus aucune ligne existante ne le satisfait
      await client.query(
        `create or replace function private.network_terms_complete(p jsonb) returns boolean language sql immutable
           set search_path = '' as $f$ select p ? 'currency' $f$`,
      );
      await client.query(`update public.ride_offers set status = 'expired', responded_at = now() where id = $1`, [pending.id]);
      await client.query(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [held.id]);
      const { rows } = await client.query(`select end_reason from public.ride_network_executions where id = $1`, [executionId]);
      expect(rows[0].end_reason).toBe("completed");
      // … mais toute nouvelle offre réseau est contrôlée
      const e = await expectPgError(
        client.query(
          `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, expires_at, network_terms)
           values ($1, $2, $3, 'pending', 'geo', 8, now() + interval '30 seconds', $4)`,
          [p.A.id, r.id, p.partner.id, TERMS],
        ),
      );
      expect(e.code).toBe("23514");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("exécution : la lecture des données client par le partenaire n'est pas diffusée", async () => {
    const p = await networkPair();
    const { executionId } = await partnerRide(p);
    const before = (await sql(`select coalesce(max(id), 0) as id from realtime.messages`))[0].id;
    await sql(
      `update public.ride_network_executions
          set client_data_reads = client_data_reads + 1, client_data_first_read_at = now(), client_data_last_read_at = now()
        where id = $1`,
      [executionId],
    );
    expect(await sql(`select 1 from realtime.messages where id > $1 and event = 'network.updated'`, [before])).toHaveLength(0);
    await sql(`update public.ride_network_executions set hold_until = now() + interval '72 hours' where id = $1`, [executionId]);
    const msgs = await sql(`select topic, payload from realtime.messages where id > $1 and event = 'network.updated' order by id`, [before]);
    expect(msgs).toEqual([
      { topic: `org:${p.A.id}`, payload: { ride_id: expect.any(String) } },
      { topic: `org:${p.B.id}`, payload: { execution_id: executionId } },
    ]);
  });
});
