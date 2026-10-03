// Audit « argent » (20260924004400_audit_argent) : règlements chauffeur du mode centrale et frais plateforme.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createOrg, createRideAsOwner, expectPgError, insertRideBypass, north, pool, sql,
  type Org, type PgError,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils (mêmes conventions que centrale.test.ts / platform-fees.test.ts)
// -----------------------------------------------------------------------------
type CDriver = { id: string; userId: string };
const NEAR = north(CHAMPS_ELYSEES, 500);
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

async function centrale(name: string, settings: Record<string, unknown> = {}, orgFields: Record<string, unknown> = {}) {
  const org = await createOrg(name, { settings: { settlement_methods: "{link,cash,transfer}", ...settings } });
  const fields = { dispatch_model: "centrale", platform_fee_fixed_cents: 500, ...orgFields };
  const keys = Object.keys(fields);
  await sql(`update public.organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [
    org.id, ...Object.values(fields),
  ]);
  return org;
}

async function driverIn(org: Org, opts: { trust?: "new" | "trusted" } = {}): Promise<CDriver> {
  const phone = `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const userId = await createAuthUser(`chauffeur-${randomUUID().slice(0, 8)}@test.dev`, "Chauffeur Argent");
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, `AR-${randomUUID().slice(0, 6)}`.toUpperCase()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id, trust_level)
     values ($1, $2, 'Karim', 'Test', $3, 'active', 'available', $4, $5) returning id`,
    [org.id, userId, phone, v.id, opts.trust ?? "trusted"],
  );
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at) values ($1, $2, $3, $4, now(), now())`,
    [d.id, org.id, NEAR[0], NEAR[1]],
  );
  return { id: d.id, userId };
}

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};

async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}

const pendingOffer = async (rideId: string, driverId: string) =>
  (await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, driverId]))[0]?.id as
    | string
    | undefined;

async function advance(d: CDriver, rideId: string, until = "COMPLETED") {
  const offer = await pendingOffer(rideId, d.id);
  expect(offer, "offre en attente").toBeTruthy();
  expect((await rpc(d.userId, "accept_ride_offer", [offer])).code).toBe("ACCEPTED");
  const steps = ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"];
  for (const s of steps.slice(0, steps.indexOf(until) + 1)) {
    const r = await rpc(d.userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

const settlementOf = async (rideId: string) => (await sql(`select * from public.ride_settlements where ride_id = $1`, [rideId]))[0];
const blockedOf = async (d: CDriver) => (await rpc(d.userId, "driver_home")).settlement.blocked as string | null;
const entriesOf = (rideId: string) =>
  sql(`select kind, amount_cents, status from public.platform_fee_entries where ride_id = $1 order by created_at, id`, [rideId]);
const account = async (org: Org) => (await rpc(org.ownerId, "org_platform_account", [org.id])).account as Record<string, any>;
const notifCount = async (driverId: string, type: string) =>
  (await sql(`select count(*)::int as n from public.notifications where driver_id = $1 and type = $2`, [driverId, type]))[0].n as number;

/** Course 59 € (14 € de commission saisie, 5 € de frais) : 19 € dus par le chauffeur en espèces, 40 € à lui verser en ligne. */
const ride59 = (org: Org, extra: Record<string, unknown> = {}) =>
  createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash", ...extra });

/** Course « API » sans prix (tolérée en mode centrale), comme POST /api/v1/rides sans tarif. */
async function apiRideWithoutPrice(org: Org, payment: "cash" | "invoice" = "cash") {
  const [row] = await as({ role: "service_role" }, (q) =>
    q(
      `insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name,
         customer_phone, vehicle_category, payment_method)
       values ($1, 'api', '1 Rue de Rivoli, 75001 Paris', $2, $3, 'Gare du Nord, 75010 Paris', 'Client API', '+33600000009', 'business', $4)
       returning id`,
      [org.id, CHAMPS_ELYSEES[0], CHAMPS_ELYSEES[1], payment],
    ),
  );
  return row.id as string;
}

// -----------------------------------------------------------------------------
describe("Règlements chauffeur : blocage et plafond d'encours", () => {
  it("« J'ai payé » fictif : débloque une fois ; après « Pas reçu », redéclarer ne débloque plus ; seul « Reçu » débloque", async () => {
    const org = await centrale("Argent Boucle");
    const d = await driverIn(org);
    const a = await ride59(org);
    await advance(d, a.id);
    const s = await settlementOf(a.id);
    await sql(`update public.ride_settlements set due_at = now() - interval '1 minute' where id = $1`, [s.id]);
    expect(await blockedOf(d)).toBe("unpaid");

    // Première déclaration : le chauffeur honnête est débloqué en attendant la confirmation
    expect((await rpc(d.userId, "driver_declare_payment", [[s.id], "cash", null])).code).toBe("DECLARED");
    expect(await blockedOf(d)).toBeNull();

    // « Pas reçu » : bloqué, contestation mémorisée
    expect((await rpc(org.ownerId, "dispute_settlement", [s.id, "Rien reçu"])).code).toBe("DISPUTED");
    expect((await settlementOf(a.id)).disputed_at).not.toBeNull();
    expect(await blockedOf(d)).toBe("unpaid");

    // Redéclaration (l'app propose « réglez-le de nouveau ») : acceptée, mais le blocage reste
    expect((await rpc(d.userId, "driver_declare_payment", [[s.id], "cash", null])).code).toBe("DECLARED");
    const home = await rpc(d.userId, "driver_home");
    expect(home.settlement.blocked).toBe("unpaid");
    expect(home.settlement.blocked_message).toMatch(/réglez-la/);
    expect(home.settlement.blocked_message).toMatch(/contestée/);
    const mine = await rpc(d.userId, "driver_settlements");
    expect(mine.items.find((i: any) => i.id === s.id)).toMatchObject({ status: "declared", blocking: true });
    const b = await ride59(org);
    expect(await pendingOffer(b.id, d.id)).toBeUndefined();

    // « Reçu » : débloqué et l'offre suivante arrive
    expect((await rpc(org.ownerId, "confirm_settlements", [[s.id], null, null])).code).toBe("CONFIRMED");
    expect(await blockedOf(d)).toBeNull();
    await sql(`select private.run_geo_wave($1)`, [b.id]);
    expect(await pendingOffer(b.id, d.id)).toBeTruthy();

    // Réouverture (erreur de saisie) : la contestation est oubliée
    expect((await rpc(org.ownerId, "reopen_settlement", [s.id])).code).toBe("REOPENED");
    expect(await settlementOf(a.id)).toMatchObject({ status: "due", disputed_at: null });
  });

  it("plafond d'encours : un paiement signalé compte une fois la déclaration vieille de 72 h", async () => {
    const org = await centrale("Argent Plafond", { settlement_credit_limit_cents: 3000 });
    const d = await driverIn(org);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await ride59(org);
      await advance(d, r.id);
      ids.push((await settlementOf(r.id)).id);
    }
    // 2 × 19 € = 38 € à régler > 30 €
    expect(await blockedOf(d)).toBe("credit_limit");

    expect((await rpc(d.userId, "driver_declare_payment", [ids, "cash", null])).code).toBe("DECLARED");
    // Déclaration récente : pas de blocage le temps que la centrale confirme
    expect(await blockedOf(d)).toBeNull();

    // Toujours pas confirmée 72 h plus tard : comptée dans l'encours
    await sql(`update public.ride_settlements set declared_at = now() - interval '73 hours' where id = any ($1::uuid[])`, [ids]);
    const home = await rpc(d.userId, "driver_home");
    expect(home.settlement.blocked).toBe("credit_limit");
    expect(home.settlement.blocked_message).toMatch(/attendez leur confirmation/);
    const next = await ride59(org);
    expect(await pendingOffer(next.id, d.id)).toBeUndefined();

    // La centrale confirme : débloqué
    await rpc(org.ownerId, "confirm_settlements", [ids, null, null]);
    expect(await blockedOf(d)).toBeNull();
  });

  it("prix modifié pendant une déclaration non encore validée : la modification attend puis est refusée", async () => {
    const org = await centrale("Argent Concurrence");
    const d = await driverIn(org);
    const ride = await ride59(org);
    await advance(d, ride.id);
    const s = await settlementOf(ride.id);

    const drv = await pool.connect();
    let outcome: { ok: true } | { ok: false; error: PgError };
    try {
      await drv.query("begin");
      await drv.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: d.userId, role: "authenticated" })]);
      await drv.query("set local role authenticated");
      const { rows } = await drv.query(`select public.driver_declare_payment($1, 'cash', null) as r`, [[s.id]]);
      expect(rows[0].r.code).toBe("DECLARED");

      let done = false;
      const update = as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 8900 where id = $1`, [ride.id]))
        .then(() => ({ ok: true as const }), (error: PgError) => ({ ok: false as const, error }))
        .finally(() => {
          done = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(done, "la correction attend la déclaration concurrente").toBe(false);
      await drv.query("commit");
      outcome = await update;
    } finally {
      drv.release();
    }
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/SETTLEMENT_LOCKED/);
    const [r] = await sql(`select price_cents, driver_payout_cents from public.rides where id = $1`, [ride.id]);
    expect(r).toEqual({ price_cents: 5900, driver_payout_cents: 4000 });
    expect(await settlementOf(ride.id)).toMatchObject({ status: "declared", price_cents: 5900, amount_cents: 1900 });
  });

  it("prix corrigé à 0 € : annulé d'office puis recalculé si le prix est corrigé ; réouverture à 0 € refusée ; 0 € jamais bloquant", async () => {
    const org = await centrale("Argent Zéro", { driver_commission_percent: 20 });
    const d = await driverIn(org);
    const ride = await createRideAsOwner(org, { price_cents: 5900, payment_method: "cash" });
    await advance(d, ride.id);
    const s = await settlementOf(ride.id);
    expect(s).toMatchObject({ status: "due", amount_cents: 1680 });

    await as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 0 where id = $1`, [ride.id]));
    expect(await settlementOf(ride.id)).toMatchObject({ status: "waived", amount_cents: 0, settled_at: null, note: "Montant nul après correction" });
    const zero = await rpc(org.ownerId, "reopen_settlement", [s.id]);
    expect(zero).toMatchObject({ ok: false, code: "ZERO_AMOUNT" });
    expect(zero.message).toMatch(/corrigez le prix/);

    // Prix corrigé de nouveau (échéance d'origine passée) : à régler, nouvelle échéance, chauffeur prévenu
    await sql(`update public.ride_settlements set due_at = now() - interval '2 days' where id = $1`, [s.id]);
    const before = await notifCount(d.id, "settlement_due");
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 5900 where id = $1`, [ride.id]));
    const again = await settlementOf(ride.id);
    expect(again).toMatchObject({ status: "due", amount_cents: 1680, note: null, reminders_sent: 0 });
    expect(new Date(again.due_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await notifCount(d.id, "settlement_due")).toBe(before + 1);
    expect(await blockedOf(d)).toBeNull();

    // Règlement « à régler » de 0 € échu (réouverture d'avant ce correctif) : jamais bloquant
    await sql(`update public.ride_settlements set amount_cents = 0, due_at = now() - interval '1 day' where id = $1`, [s.id]);
    expect(await blockedOf(d)).toBeNull();
  });

  it("nouveau chauffeur : une course sans prix (API) n'est proposée qu'aux chauffeurs confirmés", async () => {
    const org = await centrale("Argent Sans Prix", { new_driver_max_price_cents: 3000 });
    const fresh = await driverIn(org, { trust: "new" });
    const trusted = await driverIn(org);
    const rideId = await apiRideWithoutPrice(org);
    expect(await pendingOffer(rideId, trusted.id)).toBeTruthy();
    expect(await pendingOffer(rideId, fresh.id)).toBeUndefined();
    // Hors course (accueil, Commissions) : jamais « réservée aux confirmés »
    expect(await blockedOf(fresh)).toBeNull();
    expect((await rpc(fresh.userId, "driver_settlements")).blocked).toBeNull();
  });

  it("encaissement corrigé (en ligne → espèces) après l'échéance : nouvelle échéance, relances remises à zéro, chauffeur prévenu", async () => {
    const org = await centrale("Argent Sens", { settlement_grace_hours: 24 });
    const d = await driverIn(org);
    const ride = await ride59(org, { payment_method: "online" });
    await advance(d, ride.id);
    const s = await settlementOf(ride.id);
    expect(s).toMatchObject({ direction: "centrale_owes", amount_cents: 4000 });
    await sql(`update public.ride_settlements set due_at = now() - interval '1 day', reminders_sent = 2, last_reminded_at = now() where id = $1`, [s.id]);

    const before = await notifCount(d.id, "settlement_due");
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set payment_method = 'cash' where id = $1`, [ride.id]));
    const after = await settlementOf(ride.id);
    expect(after).toMatchObject({ direction: "driver_owes", amount_cents: 1900, status: "due", reminders_sent: 0, last_reminded_at: null });
    const hours = (new Date(after.due_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.5);
    expect(hours).toBeLessThan(24.5);
    expect(await blockedOf(d)).toBeNull();
    expect(await notifCount(d.id, "settlement_due")).toBe(before + 1);
    const [push] = await sql(
      `select title, body from public.notifications where driver_id = $1 and type = 'settlement_due' order by created_at desc limit 1`,
      [d.id],
    );
    expect(push.title).toBe("COMMISSION À RÉGLER");
    expect(push.body).toContain("corrigée");
    expect(push.body).toContain("19 € à régler");
  });

  it("part chauffeur annulée puis rouverte : le chauffeur est prévenu", async () => {
    const org = await centrale("Argent Versement Annulé");
    const d = await driverIn(org);
    const ride = await ride59(org, { payment_method: "online" });
    await advance(d, ride.id);
    const s = await settlementOf(ride.id);

    expect((await rpc(org.ownerId, "waive_settlement", [s.id, "Client remboursé"])).code).toBe("WAIVED");
    const [cancelled] = await sql(`select title, body from public.notifications where driver_id = $1 and type = 'settlement_payout_cancelled'`, [d.id]);
    expect(cancelled.title).toBe("VERSEMENT ANNULÉ");
    expect(cancelled.body).toContain("40 €");
    expect(cancelled.body).toContain("Client remboursé");

    const before = await notifCount(d.id, "settlement_payout");
    expect((await rpc(org.ownerId, "reopen_settlement", [s.id])).code).toBe("REOPENED");
    expect(await notifCount(d.id, "settlement_payout")).toBe(before + 1);
  });

  it("confirmation groupée mêlant commissions et parts chauffeur : reçus et versés séparés", async () => {
    const org = await centrale("Argent Mixte");
    const d = await driverIn(org);
    const cash = await ride59(org);
    await advance(d, cash.id);
    const online = await ride59(org, { payment_method: "online" });
    await advance(d, online.id);
    const ids = [(await settlementOf(cash.id)).id, (await settlementOf(online.id)).id];
    const res = await rpc(org.ownerId, "confirm_settlements", [ids, "cash", null]);
    expect(res).toMatchObject({ ok: true, count: 2, amount_cents: 5900, received_cents: 1900, paid_out_cents: 4000 });
  });

  it("retour au mode flotte refusé tant qu'il reste des règlements ouverts", async () => {
    const org = await centrale("Argent Retour Flotte");
    const d = await driverIn(org);
    const ride = await ride59(org);
    await advance(d, ride.id);

    // Action du super admin (service role) : refusée
    const err = await expectPgError(
      as({ role: "service_role" }, (q) => q(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id])),
    );
    expect(err.message).toMatch(/SETTLEMENTS_OPEN: 1 /);
    expect((await sql(`select dispatch_model from public.organizations where id = $1`, [org.id]))[0].dispatch_model).toBe("centrale");

    // Soldé (ici annulé) : bascule possible, lien d'inscription coupé
    await rpc(org.ownerId, "waive_settlement", [(await settlementOf(ride.id)).id, "Geste commercial"]);
    await as({ role: "service_role" }, (q) => q(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id]));
    expect((await sql(`select dispatch_model from public.organizations where id = $1`, [org.id]))[0].dispatch_model).toBe("fleet");
  });
});

// -----------------------------------------------------------------------------
describe("Frais plateforme", () => {
  it("blocage : déclarer de nouveau, ou retirer puis redéclarer, ne relance pas la suspension de 7 jours", async () => {
    const org = await centrale("Argent Redéclaration");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: daysAgo(75) }); // 5 € échus depuis longtemps
    await svc("svc_platform_terms", [org.id, sa, "monthly", 5, 1, "Accord écrit (test)"]);
    expect(await account(org)).toMatchObject({ blocked: true });

    const d1 = await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null]);
    expect(await account(org)).toMatchObject({ blocked: false, block_suspended: true });
    await sql(`update public.platform_payments set declared_at = now() - interval '8 days' where organization_id = $1`, [org.id]);
    expect((await account(org)).blocked).toBe(true);

    // Nouvelle déclaration sans retrait : toujours bloquée
    const d2 = await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null]);
    expect(d2.code).toBe("DECLARED");
    expect(await account(org)).toMatchObject({ blocked: true, block_suspended: false });
    await expectPgError(ride59(org));

    // Retrait des déclarations puis nouvelle déclaration : toujours bloquée
    expect((await rpc(org.ownerId, "cancel_platform_payment", [d1.id])).code).toBe("CANCELLED");
    expect((await rpc(org.ownerId, "cancel_platform_payment", [d2.id])).code).toBe("CANCELLED");
    await sql(`update public.platform_payments set declared_at = declared_at - interval '1 minute' where id = $1`, [d2.id]);
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null])).code).toBe("DECLARED");
    expect(await account(org)).toMatchObject({ blocked: true, block_suspended: false });

    // Plus aucune déclaration dans les 30 derniers jours : une nouvelle déclaration suspend de nouveau (7 jours)
    await sql(`update public.platform_payments set declared_at = now() - interval '31 days' where organization_id = $1`, [org.id]);
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null])).code).toBe("DECLARED");
    expect(await account(org)).toMatchObject({ blocked: false, block_suspended: true });
  });

  it("passage flotte → centrale : les courses ouvertes reçoivent leur répartition et leurs frais sont dus à Rydar", async () => {
    const settings = { driver_commission_percent: 20, settlement_methods: "{link,cash,transfer}" };
    const org = await createOrg("Argent Flotte Centrale", { settings });
    const d = await driverIn(org);
    const ride = await createRideAsOwner(org, { price_cents: 10000, payment_method: "cash" });
    expect((await sql(`select platform_fee_cents from public.rides where id = $1`, [ride.id]))[0].platform_fee_cents).toBeNull();

    // Action serveur du super admin (svc_platform_set_fees) : passage en centrale à 10 %, appliqué tout de suite sur
    // accord écrit (une hausse écrite directement par le service role est refusée : 20260924006600)
    const sa = await superAdmin();
    expect(await svc("svc_platform_set_fees", [org.id, sa, 10, 0, "centrale", "consent", null, "Accord écrit (test)"]))
      .toMatchObject({ ok: true, code: "APPLIED", dispatch_model: "centrale", fee_percent: 10 });
    const [split] = await sql(`select commission_cents, platform_fee_cents, driver_payout_cents from public.rides where id = $1`, [ride.id]);
    expect(split).toEqual({ commission_cents: 2000, platform_fee_cents: 1000, driver_payout_cents: 7000 });
    await advance(d, ride.id);
    expect(await settlementOf(ride.id)).toMatchObject({ direction: "driver_owes", amount_cents: 3000, platform_fee_cents: 1000 });
    expect(await entriesOf(ride.id)).toEqual([{ kind: "ride", amount_cents: 1000, status: "posted" }]);

    // Course restée sans répartition (bascule concurrente) : frais du règlement chauffeur
    const org2 = await createOrg("Argent Flotte Centrale Bis", { settings });
    const d2 = await driverIn(org2);
    const ride2 = await createRideAsOwner(org2, { price_cents: 10000, payment_method: "cash" });
    await sql(`alter table public.organizations disable trigger organizations_centrale_split`);
    try {
      await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_percent = 10 where id = $1`, [org2.id]);
    } finally {
      await sql(`alter table public.organizations enable trigger organizations_centrale_split`);
    }
    await advance(d2, ride2.id);
    expect((await sql(`select platform_fee_cents from public.rides where id = $1`, [ride2.id]))[0].platform_fee_cents).toBeNull();
    expect(await entriesOf(ride2.id)).toEqual([{ kind: "ride", amount_cents: 1000, status: "posted" }]);
  });

  it("rattrapage : course terminée avec règlement chauffeur mais sans écriture de frais, sans échéance rétroactive", async () => {
    const org = await createOrg("Argent Rattrapage Flotte", { settings: { driver_commission_percent: 20 } });
    const d = await driverIn(org);
    const ride = await createRideAsOwner(org, { price_cents: 10000, payment_method: "cash" });
    await sql(`alter table public.organizations disable trigger organizations_centrale_split`);
    try {
      await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_percent = 10 where id = $1`, [org.id]);
    } finally {
      await sql(`alter table public.organizations enable trigger organizations_centrale_split`);
    }
    await sql(`alter table public.rides disable trigger rides_e_platform_fee`);
    try {
      await advance(d, ride.id);
    } finally {
      await sql(`alter table public.rides enable trigger rides_e_platform_fee`);
    }
    await sql(`update public.rides set completed_at = now() - interval '60 days' where id = $1`, [ride.id]);
    expect(await entriesOf(ride.id)).toHaveLength(0);

    const [{ n }] = await sql(`select private.platform_backfill_settlements() as n`);
    expect(n).toBeGreaterThanOrEqual(1);
    const [e] = await sql(`select amount_cents, occurred_at, due_at from public.platform_fee_entries where ride_id = $1 and kind = 'ride'`, [ride.id]);
    expect(e.amount_cents).toBe(1000);
    expect(new Date(e.occurred_at).getTime()).toBeLessThan(daysAgo(59).getTime());
    expect(new Date(e.due_at).getTime()).toBeGreaterThan(Date.now());
    expect((await sql(`select private.platform_backfill_settlements() as n`))[0].n).toBe(0);
    const denied = await expectPgError(as({ role: "service_role" }, (q) => q(`select private.platform_backfill_settlements()`)));
    expect(denied.code).toBe("42501");
  });

  it("prix fixé après la fin de la course : échéance à partir de maintenant, jamais rétroactive", async () => {
    const org = await centrale("Argent Prix Tardif");
    const sa = await superAdmin();
    await svc("svc_platform_terms", [org.id, sa, "monthly", 5, 1, "Accord écrit (test)"]);
    const d = await driverIn(org);
    const rideId = await apiRideWithoutPrice(org, "invoice");
    await advance(d, rideId);
    await sql(`update public.rides set completed_at = now() - interval '62 days' where id = $1`, [rideId]);
    expect(await entriesOf(rideId)).toHaveLength(0);

    await as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 12000 where id = $1`, [rideId]));
    const [e] = await sql(`select amount_cents, occurred_at, due_at from public.platform_fee_entries where ride_id = $1 and kind = 'ride'`, [rideId]);
    expect(e.amount_cents).toBe(500);
    expect(new Date(e.occurred_at).getTime()).toBeLessThan(daysAgo(61).getTime());
    expect(new Date(e.due_at).getTime()).toBeGreaterThan(Date.now());
    expect(await account(org)).toMatchObject({ due_cents: 0, overdue_since: null, blocked: false });
    await ride59(org); // création de course toujours possible
  });

  it("indicateurs du super admin : prix symbolique compté avec les prix nuls ; annulation après la prise en charge du client", async () => {
    const org = await centrale("Argent Indicateurs");
    const sa = await superAdmin();
    const d = await driverIn(org);

    // 1 centime : frais plafonnés au prix (1 centime au lieu de 5 €)
    const cheap = await createRideAsOwner(org, { price_cents: 1, payment_method: "invoice" });
    await advance(d, cheap.id);
    expect(await entriesOf(cheap.id)).toEqual([{ kind: "ride", amount_cents: 1, status: "posted" }]);
    let acc = (await rpc(sa, "admin_platform_account", [org.id, null])).account;
    expect(acc.month).toMatchObject({ zero_price_rides: 1, cancelled_assigned_rides: 0, cancelled_onboard_rides: 0 });

    // Course annulée client à bord : aucun frais, signalée au super admin
    const onboard = await ride59(org);
    await advance(d, onboard.id, "PASSENGER_ONBOARD");
    expect((await rpc(org.ownerId, "cancel_ride", [onboard.id, "Client déposé"])).code).toBe("CANCELLED");
    expect(await entriesOf(onboard.id)).toHaveLength(0);
    acc = (await rpc(sa, "admin_platform_account", [org.id, null])).account;
    expect(acc.month).toMatchObject({ zero_price_rides: 1, cancelled_assigned_rides: 1, cancelled_onboard_rides: 1 });
  });
});
