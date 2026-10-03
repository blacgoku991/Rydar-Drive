import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createMember, createOrg, createRideAsOwner, expectPgError, insertRideBypass, north, pool, sql,
  type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils (mêmes conventions que centrale.test.ts)
// -----------------------------------------------------------------------------
type CDriver = { id: string; userId: string };
const NEAR = north(CHAMPS_ELYSEES, 500);
const DAY = 86_400;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY * 1000);

async function centrale(name: string, orgFields: Record<string, unknown> = {}) {
  const org = await createOrg(name, { settings: { settlement_methods: "{link,cash,transfer}" } });
  const fields = { dispatch_model: "centrale", platform_fee_fixed_cents: 500, ...orgFields };
  const keys = Object.keys(fields);
  await sql(`update public.organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [
    org.id, ...Object.values(fields),
  ]);
  return org;
}

async function driverIn(org: Org): Promise<CDriver> {
  const phone = `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const userId = await createAuthUser(`chauffeur-${randomUUID().slice(0, 8)}@test.dev`, "Chauffeur Centrale");
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, `PF-${randomUUID().slice(0, 6)}`.toUpperCase()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id, trust_level)
     values ($1, $2, 'Karim', 'Test', $3, 'active', 'available', $4, 'trusted') returning id`,
    [org.id, userId, phone, v.id],
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

async function acceptAndComplete(d: CDriver, rideId: string) {
  const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, d.id]);
  expect(offer, "offre en attente").toBeTruthy();
  expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
    const r = await rpc(d.userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

/** Course 59 € espèces (14 € de commission, 5 € de frais plateforme), menée jusqu'au bout. */
async function completedRide(org: Org, d: CDriver, extra: Record<string, unknown> = {}) {
  const ride = await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash", ...extra });
  await acceptAndComplete(d, ride.id);
  return ride;
}

const entriesOf = (rideId: string) =>
  sql(`select kind, amount_cents, status, label from public.platform_fee_entries where ride_id = $1 order by created_at, id`, [rideId]);
const account = async (org: Org) => (await rpc(org.ownerId, "org_platform_account", [org.id])).account as Record<string, any>;
const setPrice = (org: Org, rideId: string, price: number) =>
  as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = $2 where id = $1`, [rideId, price]));

// -----------------------------------------------------------------------------
describe("Frais plateforme : dus par la centrale dès la fin de la course", () => {
  it("une écriture par course terminée, échéance fin du mois + 5 jours, même si la centrale annule la dette du chauffeur", async () => {
    const org = await centrale("Centrale Frais A");
    const d = await driverIn(org);
    const ride = await completedRide(org, d);

    expect(await entriesOf(ride.id)).toEqual([{ kind: "ride", amount_cents: 500, status: "posted", label: `Course ${ride.number}` }]);
    // Échéance : dernière seconde du 5 du mois suivant (fuseau de la centrale)
    const [due] = await sql(
      `select to_char(e.due_at at time zone 'Europe/Paris', 'DD HH24:MI:SS') as d,
              to_char(date_trunc('month', now() at time zone 'Europe/Paris') + interval '1 month', 'MM') as next_month,
              to_char(e.due_at at time zone 'Europe/Paris', 'MM') as due_month
       from public.platform_fee_entries e where e.ride_id = $1`,
      [ride.id],
    );
    expect(due).toMatchObject({ d: "05 23:59:59" });
    expect(due.due_month).toBe(due.next_month);

    let acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 500, due_cents: 0, overdue_since: null, next_due_cents: 500, with_drivers_cents: 500,
      collected_by_centrale_cents: 0, held_by_centrale_cents: 0, blocked: false });
    expect(acc.reference).toMatch(/^RYD-[A-Z0-9]{1,12}$/);

    // La centrale encaisse le chauffeur (19 € dont 5 € de frais) → elle détient les frais
    const [s] = await sql(`select id from public.ride_settlements where ride_id = $1`, [ride.id]);
    expect((await rpc(org.ownerId, "confirm_settlements", [[s.id], "cash", null])).ok).toBe(true);
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 500, collected_by_centrale_cents: 500, held_by_centrale_cents: 500, with_drivers_cents: 0 });

    // Deuxième course : la centrale annule la dette du chauffeur → les frais restent dus à Rydar
    const ride2 = await completedRide(org, d);
    const [s2] = await sql(`select id from public.ride_settlements where ride_id = $1`, [ride2.id]);
    expect((await rpc(org.ownerId, "waive_settlement", [s2.id, "Geste commercial"])).ok).toBe(true);
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 1000, waived_by_centrale_cents: 500, posted_cents: 1000 });
  });

  it("aucun frais en mode flotte, ni sans frais configurés ; course payée en ligne : frais encaissés par la centrale", async () => {
    const fleet = await createOrg("Flotte Sans Frais");
    const fleetRide = await insertRideBypass(fleet, { completed_at: new Date() });
    expect(await entriesOf(fleetRide)).toHaveLength(0);
    expect((await rpc(fleet.ownerId, "org_platform_account", [fleet.id])).enabled).toBe(false);

    const free = await centrale("Centrale Sans Frais", { platform_fee_fixed_cents: 0 });
    const freeRide = await insertRideBypass(free, { completed_at: new Date() });
    expect(await entriesOf(freeRide)).toHaveLength(0);

    // Commission + frais = prix : part chauffeur nulle, aucun règlement chauffeur… mais les frais sont dus
    const org = await centrale("Centrale En Ligne");
    const d = await driverIn(org);
    const ride = await completedRide(org, d, { price_cents: 2000, commission_cents: 1500, payment_method: "online" });
    expect(await sql(`select id from public.ride_settlements where ride_id = $1`, [ride.id])).toHaveLength(0);
    expect(await entriesOf(ride.id)).toMatchObject([{ kind: "ride", amount_cents: 500 }]);
    expect(await account(org)).toMatchObject({ balance_cents: 500, collected_by_centrale_cents: 500, held_by_centrale_cents: 500 });
  });

  it("prix corrigé après la course : hausse comptée tout de suite, baisse en attente du super admin", async () => {
    const org = await centrale("Centrale Corrections", { platform_fee_percent: 10, platform_fee_fixed_cents: 0 });
    const d = await driverIn(org);
    const sa = await superAdmin();
    const ride = await completedRide(org, d, { price_cents: 5000, commission_cents: 1000 });
    expect(await entriesOf(ride.id)).toMatchObject([{ kind: "ride", amount_cents: 500, status: "posted" }]);

    await setPrice(org, ride.id, 8000);
    expect(await entriesOf(ride.id)).toMatchObject([{ amount_cents: 500 }, { kind: "correction", amount_cents: 300, status: "posted" }]);
    expect((await account(org)).balance_cents).toBe(800);

    // Baisse à 20 € : frais 2 € → écriture de -6 € EN ATTENTE, le solde ne bouge pas
    await setPrice(org, ride.id, 2000);
    const pending = await entriesOf(ride.id);
    expect(pending[2]).toMatchObject({ kind: "correction", amount_cents: -600, status: "pending" });
    let acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 800, pending_reductions_cents: -600, pending_reductions_count: 1 });

    const [entry] = await sql(`select id from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]);
    expect((await svc("svc_platform_review_entry", [entry.id, sa, false, null])).code).toBe("REASON_REQUIRED");
    expect((await svc("svc_platform_review_entry", [entry.id, sa, true, "Erreur de saisie confirmée"])).code).toBe("APPROVED");
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 200, pending_reductions_count: 0 });
    expect((await svc("svc_platform_review_entry", [entry.id, sa, true, null])).code).toBe("NOT_PENDING");

    // Nouvelle baisse refusée : les frais restent dus
    await setPrice(org, ride.id, 1500);
    const [p2] = await sql(`select id, amount_cents from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]);
    expect(p2.amount_cents).toBe(-50);
    expect((await svc("svc_platform_review_entry", [p2.id, sa, false, "Course réellement facturée"])).code).toBe("REJECTED");
    expect((await account(org)).balance_cents).toBe(200);
    const refused = (await rpc(org.ownerId, "org_platform_account", [org.id])).entries.find((x: any) => x.id === p2.id);
    expect(refused).toMatchObject({ status: "rejected", superseded: false });
  });

  it("registre immuable : ni modification ni suppression, même avec l'organisation (elle s'archive)", async () => {
    const org = await centrale("Centrale Immuable");
    const rideId = await insertRideBypass(org, { completed_at: new Date() });
    const [e] = await sql(`select id from public.platform_fee_entries where ride_id = $1`, [rideId]);
    expect(e).toBeTruthy();
    const upd = await expectPgError(sql(`update public.platform_fee_entries set amount_cents = 1 where id = $1`, [e.id]));
    expect(upd.message).toContain("PLATFORM_LEDGER_IMMUTABLE");
    const del = await expectPgError(sql(`delete from public.platform_fee_entries where id = $1`, [e.id]));
    expect(del.message).toContain("PLATFORM_LEDGER_IMMUTABLE");
    const status = await expectPgError(sql(`update public.platform_fee_entries set status = 'rejected' where id = $1`, [e.id]));
    expect(status.message).toContain("PLATFORM_LEDGER_IMMUTABLE");
    // Aucune écriture directe pour un rattacheur
    const ins = await expectPgError(as({ sub: org.ownerId }, (q) =>
      q(`insert into public.platform_payments (organization_id, amount_cents, method, status, received_cents) values ($1, 500, 'cash', 'confirmed', 500)`, [org.id])));
    expect(ins.code).toBe("42501");
    // Suppression de l'organisation refusée, même en accès direct : registre de Rydar conservé (fin de contrat :
    // archivage)
    const drop = await expectPgError(sql(`delete from public.organizations where id = $1`, [org.id]));
    expect(drop.code).toBe("23503");
    expect(drop.message).toContain("platform_fee_entries");
    expect(await sql(`select id from public.platform_fee_entries where organization_id = $1`, [org.id])).toHaveLength(1);
    expect(await sql(`select id from public.organizations where id = $1`, [org.id])).toHaveLength(1);

    // Paiements seuls (aucune écriture) : conservés de même
    const paid = await centrale("Centrale Paiement Seul");
    await sql(`insert into public.platform_payments (organization_id, amount_cents, method) values ($1, 500, 'transfer')`, [paid.id]);
    const dropPaid = await expectPgError(sql(`delete from public.organizations where id = $1`, [paid.id]));
    expect(dropPaid.code).toBe("23503");
    expect(dropPaid.message).toContain("platform_payments");
    // Sans registre ni paiement (création annulée par le super admin) : suppression toujours possible
    const empty = await centrale("Centrale Création Annulée");
    await sql(`delete from public.organizations where id = $1`, [empty.id]);
    expect(await sql(`select id from public.organizations where id = $1`, [empty.id])).toHaveLength(0);
  });

  it("course purgée au bout de 10 ans (ménage) : son écriture reste au registre, sans lien vers la course", async () => {
    const org = await centrale("Centrale Dix Ans");
    const [{ limit }] = await sql(`select date_trunc('year', now() - interval '10 years') as limit`);
    const old = new Date((limit as Date).getTime() - DAY * 1000);
    const rideId = await insertRideBypass(org, { pickup_at: old, completed_at: old });
    const [entry] = await sql(`select id, amount_cents from public.platform_fee_entries where ride_id = $1`, [rideId]);
    expect(entry).toBeTruthy();
    const [{ r }] = await sql(`select private.housekeeping() as r`);
    expect(r.errors).toBeUndefined();
    expect(r.rides_purged).toBeGreaterThanOrEqual(1);
    expect(await sql(`select id from public.rides where id = $1`, [rideId])).toHaveLength(0);
    expect(await sql(`select ride_id, amount_cents from public.platform_fee_entries where id = $1`, [entry.id])).toEqual([
      { ride_id: null, amount_cents: entry.amount_cents },
    ]);
    expect((await account(org)).balance_cents).toBe(entry.amount_cents);
  });
});

// -----------------------------------------------------------------------------
describe("Frais plateforme : paiements déclarés par la centrale, confirmés par le super admin", () => {
  it("« J'ai payé » → à confirmer ; reçu partiel ; pas reçu ; rouvert ; paiement saisi ; avoir", async () => {
    const org = await centrale("Centrale Paiements");
    const sa = await superAdmin();
    for (let i = 0; i < 4; i++) await insertRideBypass(org, { completed_at: new Date() }); // 4 × 5 € = 20 €
    expect((await account(org)).balance_cents).toBe(2000);

    // Validations
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 0, "transfer", null, null, null])).code).toBe("INVALID_AMOUNT");
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "bitcoin", null, null, null])).code).toBe("INVALID_METHOD");
    const future = new Date(Date.now() + 3 * DAY * 1000).toISOString().slice(0, 10);
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, future])).code).toBe("INVALID_DATE");

    const dec = await rpc(org.ownerId, "declare_platform_payment", [org.id, 2000, "transfer", "VIR RYD", "Virement du jour", null]);
    expect(dec).toMatchObject({ ok: true, code: "DECLARED", amount_cents: 2000 });
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 100, "cash", null, null, null])).code).toBe("RATE_LIMITED");
    let acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 2000, declared_cents: 2000, declared_count: 1 });
    // Diffusion temps réel à la centrale
    const msgs = await as({ sub: org.ownerId }, (q) =>
      q(`select payload from realtime.messages where topic = $1 and event = 'platform.updated' order by id desc limit 1`, [`org:${org.id}`]),
      { topic: `org:${org.id}` });
    expect(msgs[0]?.payload).toMatchObject({ action: "declared", organization_id: org.id, payment_id: dec.id });
    // Canal lisible par tous les membres (dispatchers compris) : ni montant, ni note, ni nom dans l'événement
    expect(Object.keys(msgs[0]!.payload).sort()).toEqual(["action", "organization_id", "payment_id"]);

    // Reçu partiel : 15 € sur 20 € → reste 5 €
    const conf = await svc("svc_platform_confirm_payment", [dec.id, sa, 1500, "Virement reçu incomplet"]);
    expect(conf).toMatchObject({ ok: true, code: "CONFIRMED", received_cents: 1500 });
    expect((await svc("svc_platform_confirm_payment", [dec.id, sa, null, null])).code).toBe("NOT_PENDING");
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 500, received_cents: 1500, declared_cents: 0 });
    const [audit] = await sql(`select severity, metadata from public.audit_logs where action = 'platform_payment.confirmed' and entity_id = $1`, [dec.id]);
    expect(audit).toMatchObject({ severity: "warning", metadata: { declared_cents: 2000, received_cents: 1500 } });

    // Erreur de saisie : rouvert (motif obligatoire) puis confirmé en entier
    expect((await svc("svc_platform_reopen_payment", [dec.id, sa, ""])).code).toBe("REASON_REQUIRED");
    expect((await svc("svc_platform_reopen_payment", [dec.id, sa, "Relevé bancaire vérifié"])).code).toBe("REOPENED");
    expect((await account(org)).balance_cents).toBe(2000);
    expect((await svc("svc_platform_confirm_payment", [dec.id, sa, null, null])).received_cents).toBe(2000);
    expect((await account(org)).balance_cents).toBe(0);

    // Déclaration fantaisiste : « Pas reçu » (motif obligatoire), le solde ne bouge pas
    await insertRideBypass(org, { completed_at: new Date() });
    await sql(`update public.platform_payments set declared_at = now() - interval '1 minute' where organization_id = $1`, [org.id]);
    const fake = await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "cash", null, null, null]);
    expect((await svc("svc_platform_reject_payment", [fake.id, sa, " "])).code).toBe("REASON_REQUIRED");
    expect((await svc("svc_platform_reject_payment", [fake.id, sa, "Aucun virement reçu"])).code).toBe("REJECTED");
    expect(await account(org)).toMatchObject({ balance_cents: 500, declared_cents: 0 });
    expect((await rpc(org.ownerId, "cancel_platform_payment", [fake.id])).code).toBe("NOT_CANCELLABLE");

    // Paiement reçu directement par Rydar, puis avoir de 2 € → crédit de 2 € en faveur de la centrale
    const rec = await svc("svc_platform_record_payment", [org.id, sa, 500, "cash", null, "Remis en main propre", null]);
    expect(rec.code).toBe("RECORDED");
    expect((await svc("svc_platform_adjust", [org.id, sa, -200, ""])).code).toBe("REASON_REQUIRED");
    expect((await svc("svc_platform_adjust", [org.id, sa, -200, "Geste commercial"])).code).toBe("ADJUSTED");
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: -200, due_cents: 0 });

    // La centrale retire une déclaration non traitée
    await sql(`update public.platform_payments set declared_at = now() - interval '1 minute' where organization_id = $1`, [org.id]);
    const oops = await rpc(org.ownerId, "declare_platform_payment", [org.id, 999, "link", null, null, null]);
    expect((await rpc(org.ownerId, "cancel_platform_payment", [oops.id])).code).toBe("CANCELLED");
    expect((await account(org)).declared_count).toBe(0);
  });

  it("droits : owner / admin seulement, isolation des centrales, fonctions super admin réservées", async () => {
    const org = await centrale("Centrale Droits A");
    const other = await centrale("Centrale Droits B");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: new Date() });

    const dispatcher = await createMember(org, "dispatcher");
    expect((await expectPgError(rpc(dispatcher, "org_platform_account", [org.id]))).code).toBe("42501");
    expect((await expectPgError(rpc(dispatcher, "declare_platform_payment", [org.id, 500, "cash", null, null, null]))).code).toBe("42501");
    expect((await expectPgError(rpc(other.ownerId, "org_platform_account", [org.id]))).code).toBe("42501");
    const admin = await createMember(org, "admin");
    expect((await rpc(admin, "org_platform_account", [org.id])).enabled).toBe(true);
    // Bandeau : rien pour un dispatcher ou une autre centrale, l'état du compte pour owner / admin
    expect(await rpc(dispatcher, "org_platform_status", [org.id])).toEqual({ enabled: false });
    expect(await rpc(other.ownerId, "org_platform_status", [org.id])).toEqual({ enabled: false });
    expect((await rpc(admin, "org_platform_status", [org.id])).account.balance_cents).toBe(500);

    // RLS : le dispatcher et l'autre centrale ne voient rien ; le super admin voit tout
    const read = (sub: string) => as({ sub }, (q) => q(`select id from public.platform_fee_entries where organization_id = $1`, [org.id]));
    expect(await read(dispatcher)).toHaveLength(0);
    expect(await read(other.ownerId)).toHaveLength(0);
    expect(await read(org.ownerId)).toHaveLength(1);
    expect(await read(sa)).toHaveLength(1);

    // Fonctions svc_* : service role uniquement, auteur super admin obligatoire
    expect((await expectPgError(rpc(org.ownerId, "svc_platform_adjust", [org.id, org.ownerId, -500, "Je m'offre un avoir"]))).code).toBe("42501");
    expect((await expectPgError(svc("svc_platform_adjust", [org.id, org.ownerId, -500, "Auteur non super admin"]))).code).toBe("42501");
    expect((await expectPgError(rpc(org.ownerId, "admin_platform_overview"))).code).toBe("42501");
    // Conditions et coordonnées : colonnes réservées au super admin
    const upd = await expectPgError(as({ sub: org.ownerId }, (q) =>
      q(`update public.organizations set platform_block_after_days = null, platform_payment_days = 60 where id = $1`, [org.id])));
    expect(upd.code).toBe("42501");

    // Centrale suspendue : elle voit encore sa dette et peut déclarer un paiement
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [org.id]);
    expect((await rpc(org.ownerId, "org_platform_account", [org.id])).account.balance_cents).toBe(500);
    expect((await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null])).code).toBe("DECLARED");
    await sql(`update public.organizations set status = 'active' where id = $1`, [org.id]);
  });
});

// -----------------------------------------------------------------------------
describe("Frais plateforme : échéances, retard, blocage, relevé, super admin", () => {
  it("les paiements soldent les échéances les plus anciennes ; blocage après N jours sauf paiement déclaré", async () => {
    const org = await centrale("Centrale Retard");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: daysAgo(75) }); // échéance le 5 du mois suivant : dépassée
    await insertRideBypass(org, { completed_at: daysAgo(45) });
    await insertRideBypass(org, { completed_at: new Date() }); // pas encore échue
    const [dues] = await sql(
      `select array_agg(due_at order by due_at) as d from public.platform_fee_entries where organization_id = $1`, [org.id]);
    const [first, second, third] = dues.d as Date[];

    let acc = await account(org);
    expect(acc.balance_cents).toBe(1500);
    expect(acc.due_cents).toBe(new Date(second).getTime() <= Date.now() ? 1000 : 500);
    expect(new Date(acc.overdue_since).getTime()).toBe(new Date(first).getTime());
    expect(acc.days_overdue).toBeGreaterThan(0);
    expect(new Date(acc.next_due_at).getTime()).toBe(new Date(third).getTime());

    // Sans levier : pas de blocage
    expect(acc.blocked).toBe(false);
    await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" });

    // Levier : 1 jour de retard → création refusée
    expect((await svc("svc_platform_terms", [org.id, sa, "monthly", 5, 1, "Accord écrit (test)"])).code).toBe("SAVED");
    expect((await svc("svc_platform_terms", [org.id, sa, "daily", 5, 1])).code).toBe("INVALID_CYCLE");
    const blocked = await expectPgError(createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" }));
    expect(blocked.message).toContain("PLATFORM_FEES_OVERDUE");
    expect((await account(org)).blocked).toBe(true);
    // API (service role) : même refus
    const api = await expectPgError(as({ role: "service_role" }, (q) =>
      q(`insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, pickup_at, customer_name, customer_phone,
           passengers, vehicle_category) values ($1, 'api', 'Opéra', 48.87, 2.33, now() + interval '10 minutes', 'Client', '+33600000002', 1, 'business')`,
        [org.id])));
    expect(api.message).toContain("PLATFORM_FEES_OVERDUE");

    // Paiement déclaré couvrant l'échu : blocage suspendu en attendant la confirmation
    const dec = await rpc(org.ownerId, "declare_platform_payment", [org.id, 1000, "transfer", null, null, null]);
    expect((await account(org)).blocked).toBe(false);
    await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
    // Refusé : blocage rétabli
    expect((await svc("svc_platform_reject_payment", [dec.id, sa, "Rien reçu"])).ok).toBe(true);
    expect((await account(org)).blocked).toBe(true);
    // Paiement reçu (le plus ancien d'abord) : plus rien d'échu, le retard disparaît
    await svc("svc_platform_record_payment", [org.id, sa, 1000, "transfer", "VIR-123", null, null]);
    acc = await account(org);
    expect(acc).toMatchObject({ due_cents: 0, overdue_since: null, blocked: false, balance_cents: 500 });
    await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
  });

  it("relevé mensuel : solde d'ouverture + frais − reçu = solde de clôture", async () => {
    const org = await centrale("Centrale Relevé");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: daysAgo(40) });
    await insertRideBypass(org, { completed_at: new Date() });
    await insertRideBypass(org, { completed_at: new Date() });
    await svc("svc_platform_record_payment", [org.id, sa, 300, "cash", null, null, null]);

    const month = (await sql(`select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM') as m`))[0].m;
    const st = await rpc(org.ownerId, "org_platform_statement", [org.id, month]);
    expect(st.month).toBe(month);
    expect(st.fees_cents).toBe(1000);
    expect(st.received_cents).toBe(300);
    expect(st.opening_cents + st.fees_cents - st.received_cents).toBe(st.closing_cents);
    expect(st.closing_cents).toBe((await account(org)).balance_cents);
    expect(st.entries).toHaveLength(2);
    expect(st.payments).toHaveLength(1);
    // Mois invalide : mois courant
    expect((await rpc(org.ownerId, "org_platform_statement", [org.id, "2026-13"])).month).toBe(month);
  });

  it("vue super admin : dettes par centrale, paiements à confirmer, baisses à valider ; mois borné", async () => {
    const org = await centrale("Centrale Vue Admin");
    const d = await driverIn(org);
    const sa = await superAdmin();
    const [prev] = await sql(
      `select (date_trunc('month', now() at time zone 'Europe/Paris') - interval '1 month') at time zone 'Europe/Paris' as f`);
    await insertRideBypass(org, { completed_at: new Date(new Date(prev.f).getTime() + 10 * DAY * 1000) });
    const ride = await completedRide(org, d);
    await setPrice(org, ride.id, 5000); // frais fixes : inchangés → aucune correction
    expect(await entriesOf(ride.id)).toHaveLength(1);
    await sql(`update public.organizations set platform_fee_percent = 10 where id = $1`, [org.id]);
    await setPrice(org, ride.id, 3000); // recalcul : 5 € + 10 % de 30 € = 8 € → hausse de 3 €
    await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", "VIR", null, null]);

    const ov = await rpc(sa, "admin_platform_overview");
    const row = ov.organizations.find((o: any) => o.id === org.id);
    expect(row).toMatchObject({ name: "Centrale Vue Admin", balance_cents: 1300, declared_cents: 500, dispatch_model: "centrale" });
    expect(ov.payments_to_confirm.some((p: any) => p.organization_id === org.id && p.organization_name === "Centrale Vue Admin")).toBe(true);
    expect(ov.totals.declared_count).toBeGreaterThanOrEqual(1);

    const detail = await rpc(sa, "admin_platform_account", [org.id, null]);
    expect(detail.account.balance_cents).toBe(1300);
    expect(detail.statement.entries.length).toBeGreaterThanOrEqual(2);

    // admin_centrale_overview : dette envers Rydar + mois choisi seulement (la course du jour n'est pas comptée dans le mois précédent)
    const past = await rpc(sa, "admin_centrale_overview", [prev.f]);
    const pastRow = past.organizations.find((o: any) => o.id === org.id);
    const now = await rpc(sa, "admin_centrale_overview", [null]);
    const nowRow = now.organizations.find((o: any) => o.id === org.id);
    expect(nowRow.rides).toBe(1);
    expect(pastRow.rides).toBe(1);
    expect(nowRow).toMatchObject({ platform_balance_cents: 1300, platform_declared_cents: 500 });
  });

  it("coordonnées de paiement de Rydar : validées, affichées à la centrale avec un lien prérempli", async () => {
    const org = await centrale("Centrale Coordonnées");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: new Date() });
    expect((await svc("svc_platform_billing_update", [sa, "Rydar SAS", "FR76 1234", null, null, null])).code).toBe("INVALID_IBAN");
    expect((await svc("svc_platform_billing_update", [sa, "Rydar SAS", null, null, "http://pay.me", null])).code).toBe("INVALID_LINK");
    const ok = await svc("svc_platform_billing_update", [
      sa, "Rydar SAS", "fr76 3000 6000 0112 3456 7890 189", "agrifrpp", "https://pay.rydar.app/{montant}?ref={reference}", "Indiquez la référence.",
    ]);
    expect(ok.code).toBe("SAVED");
    const res = await rpc(org.ownerId, "org_platform_account", [org.id]);
    expect(res.pay).toMatchObject({ amount_cents: 500, payee_name: "Rydar SAS", iban: "FR7630006000011234567890189", bic: "AGRIFRPP", configured: true });
    expect(res.pay.link).toBe(`https://pay.rydar.app/5.00?ref=${res.account.reference}`);
    // La table n'est pas lisible directement par la centrale
    expect(await as({ sub: org.ownerId }, (q) => q(`select iban from public.platform_billing`))).toHaveLength(0);
    const [log] = await sql(`select metadata from public.audit_logs where action = 'platform_billing.updated' order by id desc limit 1`);
    expect(log.metadata.iban_end).toBe("0189");
  });

  it("relance du super admin : affichée à la centrale, une par heure au plus", async () => {
    const org = await centrale("Centrale Relance");
    const sa = await superAdmin();
    expect((await svc("svc_platform_remind", [org.id, sa, null])).code).toBe("NOTHING_DUE");
    await insertRideBypass(org, { completed_at: new Date() });
    expect((await svc("svc_platform_remind", [org.id, sa, "Merci de régler avant vendredi"])).code).toBe("REMINDED");
    expect((await svc("svc_platform_remind", [org.id, sa, null])).code).toBe("RATE_LIMITED");
    expect(await account(org)).toMatchObject({ reminder_note: "Merci de régler avant vendredi" });
    expect((await account(org)).reminded_at).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// Revue SQL (argent) : chaque cas ci-dessous faussait un solde ou contournait un contrôle
// -----------------------------------------------------------------------------
describe("Frais plateforme : revue SQL (soldes justes, contrôles sans contournement)", () => {
  it("baisse en attente puis nouveau prix : la baisse est remplacée (la refuser ensuite ne compte pas la hausse deux fois)", async () => {
    const org = await centrale("Centrale Baisse Remplacée", { platform_fee_percent: 10, platform_fee_fixed_cents: 0 });
    const d = await driverIn(org);
    const sa = await superAdmin();
    const ride = await completedRide(org, d, { price_cents: 5000, commission_cents: 0 });

    await setPrice(org, ride.id, 2000); // frais 5 € → 2 € : −3 € en attente
    const [old] = await sql(`select id from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]);
    await setPrice(org, ride.id, 5000); // retour au prix initial : plus rien à corriger
    let acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 500, pending_reductions_count: 0, pending_reductions_cents: 0 });
    // L'ancienne baisse n'est plus à valider : la refuser ne peut plus rajouter 3 €
    expect((await svc("svc_platform_review_entry", [old.id, sa, false, "Course réellement facturée"])).code).toBe("NOT_PENDING");
    expect((await account(org)).balance_cents).toBe(500);
    const [superseded] = await sql(`select status, review_note, reviewed_by from public.platform_fee_entries where id = $1`, [old.id]);
    expect(superseded).toMatchObject({ status: "rejected", reviewed_by: null });
    expect(superseded.review_note).toMatch(/remplacée/i);
    const listed = (await rpc(org.ownerId, "org_platform_account", [org.id])).entries.find((x: any) => x.id === old.id);
    expect(listed).toMatchObject({ status: "rejected", superseded: true });

    // Deux baisses successives : une seule en attente, calculée sur les frais comptabilisés
    await setPrice(org, ride.id, 2000);
    await setPrice(org, ride.id, 1000);
    const pend = await sql(`select id, amount_cents from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]);
    expect(pend).toHaveLength(1);
    expect(pend[0].amount_cents).toBe(-400);
    expect((await svc("svc_platform_review_entry", [pend[0].id, sa, true, "Prix corrigé"])).code).toBe("APPROVED");
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 100, posted_cents: 100 });

    // Baisse en attente puis hausse au-delà du prix initial : la baisse est remplacée, la hausse comptée
    await setPrice(org, ride.id, 500); // 1 € → 0,50 € : −0,50 € en attente
    await setPrice(org, ride.id, 3000); // 3 € : +2 € par rapport aux frais comptabilisés
    expect((await account(org))).toMatchObject({ balance_cents: 300, pending_reductions_count: 0 });
    // Paiement ou encaissement changé sans effet sur les frais : la baisse en attente reste en attente
    await setPrice(org, ride.id, 1000);
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set payment_method = 'card' where id = $1`, [ride.id]));
    expect((await account(org))).toMatchObject({ pending_reductions_count: 1, pending_reductions_cents: -200 });
  });

  it("concurrence : baisse refusée pendant que la centrale remet le prix initial → frais comptés une seule fois", async () => {
    const org = await centrale("Centrale Course Concurrente", { platform_fee_percent: 10, platform_fee_fixed_cents: 0 });
    const d = await driverIn(org);
    const sa = await superAdmin();
    const ride = await completedRide(org, d, { price_cents: 5000, commission_cents: 0 });
    await setPrice(org, ride.id, 2000);
    const [pending] = await sql(`select id from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]);

    // Le super admin refuse la baisse (transaction ouverte) pendant que la centrale remet 50 €
    const admin = await pool.connect();
    try {
      await admin.query("begin");
      await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await admin.query("set local role service_role");
      const { rows } = await admin.query(`select public.svc_platform_review_entry($1, $2, false, 'Pas de remise') as r`, [pending.id, sa]);
      expect(rows[0].r.code).toBe("REJECTED");
      let done = false;
      const update = setPrice(org, ride.id, 5000).then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(done, "la correction attend la décision du super admin").toBe(false);
      await admin.query("commit");
      await update;
    } finally {
      admin.release();
    }
    expect(await account(org)).toMatchObject({ balance_cents: 500, posted_cents: 500, pending_reductions_count: 0 });
  });

  it("avoir ou baisse acceptée : l'échu, le retard et le blocage baissent tout de suite", async () => {
    const org = await centrale("Centrale Avoir Échu");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: daysAgo(75) }); // 5 € échus depuis longtemps
    expect((await svc("svc_platform_terms", [org.id, sa, "monthly", 5, 1, "Accord écrit (test)"])).code).toBe("SAVED");
    expect((await account(org))).toMatchObject({ due_cents: 500, blocked: true });

    expect((await svc("svc_platform_adjust", [org.id, sa, -500, "Geste commercial"])).code).toBe("ADJUSTED");
    const acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 0, due_cents: 0, overdue_since: null, days_overdue: 0, blocked: false });
    await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" });

    // Baisse acceptée sur une course échue : l'échu suit
    const pct = await centrale("Centrale Baisse Échue", { platform_fee_percent: 10, platform_fee_fixed_cents: 0 });
    const rideId = await insertRideBypass(pct, { completed_at: daysAgo(75), price_cents: 5000 });
    expect((await account(pct)).due_cents).toBe(500);
    await setPrice(pct, rideId, 0);
    const [entry] = await sql(`select id from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [rideId]);
    expect((await svc("svc_platform_review_entry", [entry.id, sa, true, "Course offerte au client"])).code).toBe("APPROVED");
    expect(await account(pct)).toMatchObject({ balance_cents: 0, due_cents: 0, overdue_since: null });

    // Avoir partiel : il solde d'abord la plus ancienne échéance
    const part = await centrale("Centrale Avoir Partiel");
    await insertRideBypass(part, { completed_at: daysAgo(75) });
    await insertRideBypass(part, { completed_at: new Date() });
    await svc("svc_platform_adjust", [part.id, sa, -300, "Geste commercial"]);
    expect(await account(part)).toMatchObject({ balance_cents: 700, due_cents: 200, next_due_cents: 700 });
  });

  it("blocage : une déclaration « J'ai payé » ne le suspend ni après un refus récent ni au-delà de 7 jours", async () => {
    const org = await centrale("Centrale Déclarations En Boucle");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: daysAgo(75) });
    await svc("svc_platform_terms", [org.id, sa, "monthly", 5, 1, "Accord écrit (test)"]);
    expect((await account(org))).toMatchObject({ blocked: true, block_suspended: false });

    const first = await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null]);
    expect((await account(org))).toMatchObject({ blocked: false, block_suspended: true });
    expect((await svc("svc_platform_reject_payment", [first.id, sa, "Aucun virement reçu"])).code).toBe("REJECTED");
    // Nouvelle déclaration juste après un refus : le blocage reste
    await sql(`update public.platform_payments set declared_at = now() - interval '1 minute' where organization_id = $1`, [org.id]);
    const again = await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null]);
    expect(again.code).toBe("DECLARED");
    expect((await account(org))).toMatchObject({ blocked: true, block_suspended: false });
    await expectPgError(createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" }));
    // Rydar confirme la réception : plus rien d'échu
    expect((await svc("svc_platform_confirm_payment", [again.id, sa, null, null])).code).toBe("CONFIRMED");
    expect((await account(org))).toMatchObject({ blocked: false, due_cents: 0 });

    // Déclaration jamais traitée : elle ne suspend le blocage que 7 jours
    const stale = await centrale("Centrale Déclaration Ancienne");
    await insertRideBypass(stale, { completed_at: daysAgo(75) });
    await svc("svc_platform_terms", [stale.id, sa, "monthly", 5, 1, "Accord écrit (test)"]);
    await rpc(stale.ownerId, "declare_platform_payment", [stale.id, 500, "transfer", null, null, null]);
    expect((await account(stale)).blocked).toBe(false);
    await sql(`update public.platform_payments set declared_at = now() - interval '8 days' where organization_id = $1`, [stale.id]);
    expect((await account(stale))).toMatchObject({ blocked: true, declared_count: 1 });
  });

  it("centrale archivée qui doit encore des frais : toujours suivie par le super admin", async () => {
    const org = await centrale("Centrale Archivée Débitrice");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: new Date() });
    await sql(`update public.organizations set status = 'archived' where id = $1`, [org.id]);
    const ov = await rpc(sa, "admin_platform_overview");
    expect(ov.organizations.find((o: any) => o.id === org.id)).toMatchObject({ balance_cents: 500, status: "archived" });
    // Soldée : elle sort de la liste
    await svc("svc_platform_record_payment", [org.id, sa, 500, "transfer", null, null, null]);
    const after = await rpc(sa, "admin_platform_overview");
    expect(after.organizations.find((o: any) => o.id === org.id)).toBeUndefined();
  });

  it("paiement rouvert par Rydar : la centrale ne peut plus retirer sa déclaration", async () => {
    const org = await centrale("Centrale Paiement Rouvert");
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: new Date() });
    const dec = await rpc(org.ownerId, "declare_platform_payment", [org.id, 500, "transfer", null, null, null]);
    await svc("svc_platform_confirm_payment", [dec.id, sa, null, null]);
    expect((await svc("svc_platform_reopen_payment", [dec.id, sa, "Montant à vérifier"])).code).toBe("REOPENED");
    expect((await rpc(org.ownerId, "cancel_platform_payment", [dec.id])).code).toBe("NOT_CANCELLABLE");
    const [p] = await sql(`select status from public.platform_payments where id = $1`, [dec.id]);
    expect(p.status).toBe("declared");
  });

  it("relevé : un mois hors limites donne le mois courant au lieu d'une erreur", async () => {
    const org = await centrale("Centrale Relevé Hors Limites");
    const month = (await sql(`select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM') as m`))[0].m;
    expect((await rpc(org.ownerId, "org_platform_statement", [org.id, "0000-01"])).month).toBe(month);
  });

  it("rattrapage des courses déjà terminées : montant dû, mais aucune échéance rétroactive", async () => {
    const org = await centrale("Centrale Rattrapage");
    await sql(`alter table public.rides disable trigger rides_e_platform_fee`);
    let rideId: string;
    try {
      rideId = await insertRideBypass(org, { completed_at: daysAgo(120) });
    } finally {
      await sql(`alter table public.rides enable trigger rides_e_platform_fee`);
    }
    expect(await entriesOf(rideId)).toHaveLength(0);
    const [{ n }] = await sql(`select private.platform_backfill() as n`);
    expect(n).toBeGreaterThanOrEqual(1);
    const [e] = await sql(`select occurred_at, due_at from public.platform_fee_entries where ride_id = $1 and kind = 'ride'`, [rideId]);
    expect(new Date(e.occurred_at).getTime()).toBeLessThan(daysAgo(119).getTime());
    expect(new Date(e.due_at).getTime()).toBeGreaterThan(Date.now());
    expect(await account(org)).toMatchObject({ balance_cents: 500, due_cents: 0, overdue_since: null });
    // Idempotent
    expect((await sql(`select private.platform_backfill() as n`))[0].n).toBe(0);
    // Fonction interne : jamais exposée
    const denied = await expectPgError(as({ role: "service_role" }, (q) => q(`select private.platform_backfill()`)));
    expect(denied.code).toBe("42501");
  });
});
