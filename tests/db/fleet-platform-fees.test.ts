// Frais Rydar des FLOTTES (20260924006400_fleet_platform_fees) : % du prix + fixe par course terminée, dus par la
// flotte à Rydar avec les mêmes règles d'argent que les centrales (registre immuable, corrections, paiements FIFO).
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
// Outils (mêmes conventions que platform-fees.test.ts)
// -----------------------------------------------------------------------------
type FDriver = { id: string; userId: string };
const NEAR = north(CHAMPS_ELYSEES, 500);
const DAY = 86_400;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY * 1000);

/** Flotte (modèle par défaut) avec des frais Rydar réglés par le super admin (colonnes réservées : accès direct). */
async function fleet(name: string, fees: { percent?: number; fixed?: number } = {}, settings: Record<string, unknown> = {}) {
  const org = await createOrg(name, { settings });
  await sql(`update public.organizations set platform_fee_percent = $2, platform_fee_fixed_cents = $3 where id = $1`, [
    org.id, fees.percent ?? 0, fees.fixed ?? 0,
  ]);
  return org;
}

/** Super admin auteur des réglages (créé une fois). */
let feeAdmin: Promise<string> | undefined;
const feeActor = () => (feeAdmin ??= superAdmin());

/**
 * Réglage des frais (et du modèle) par le super admin : action serveur → svc_platform_set_fees (service role). Ces
 * tests appliquent les taux tout de suite, sur accord écrit de l'organisation (sans accord, une hausse est annoncée
 * 30 jours à l'avance, et une hausse écrite directement par le service role est refusée : 20260924006600).
 */
async function setFees(org: Org, percent: number | null, fixed: number | null, model: "fleet" | "centrale" | null = null) {
  const sa = await feeActor();
  const [row] = await as({ role: "service_role" }, (q) =>
    q(`select public.svc_platform_set_fees($1, $2, $3, $4, $5, 'consent', null, 'Accord écrit (test)') as r`, [org.id, sa, percent, fixed, model]));
  expect(row.r.ok, JSON.stringify(row.r)).toBe(true);
  return row.r as Record<string, any>;
}

/** Modèle d'exploitation (et frais, si fournis ; sinon taux inchangés). */
const setModel = (org: Org, model: "fleet" | "centrale", fees?: { percent: number; fixed: number }) =>
  setFees(org, fees?.percent ?? null, fees?.fixed ?? null, model);

async function driverIn(org: Org): Promise<FDriver> {
  const phone = `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const userId = await createAuthUser(`chauffeur-${randomUUID().slice(0, 8)}@test.dev`, "Chauffeur Flotte");
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, `FL-${randomUUID().slice(0, 6)}`.toUpperCase()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id, trust_level)
     values ($1, $2, 'Nadia', 'Test', $3, 'active', 'available', $4, 'trusted') returning id`,
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

const STEPS = ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"];

/** Le chauffeur accepte l'offre et mène la course jusqu'à `until` (défaut : terminée). */
async function advance(d: FDriver, rideId: string, until = "COMPLETED") {
  const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, d.id]);
  expect(offer, "offre en attente").toBeTruthy();
  expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
  await continueTo(d, rideId, until);
}
async function continueTo(d: FDriver, rideId: string, until = "COMPLETED", from?: string) {
  const start = from ? STEPS.indexOf(from) + 1 : 0;
  for (const s of STEPS.slice(start, STEPS.indexOf(until) + 1)) {
    const r = await rpc(d.userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

/** Course de flotte menée jusqu'au bout (prix au choix, null = sans prix). */
async function completedRide(org: Org, d: FDriver, price: number | null, extra: Record<string, unknown> = {}) {
  const ride = await createRideAsOwner(org, { price_cents: price, payment_method: "cash", ...extra });
  await advance(d, ride.id);
  return ride;
}

const entriesOf = (rideId: string) =>
  sql(`select kind, amount_cents, status from public.platform_fee_entries where ride_id = $1 order by created_at, id`, [rideId]);
const sumOf = async (rideId: string) =>
  Number((await sql(`select coalesce(sum(amount_cents) filter (where status = 'posted'), 0) as s from public.platform_fee_entries where ride_id = $1`, [rideId]))[0].s);
const basisOf = async (rideId: string) =>
  (await sql(`select fee_percent::float8 as percent, fee_fixed_cents as fixed from private.fleet_fee_basis where ride_id = $1`, [rideId]))[0] ?? null;
const account = async (org: Org) => (await rpc(org.ownerId, "org_platform_account", [org.id])).account as Record<string, any>;
const setPrice = (org: Org, rideId: string, price: number | null) =>
  as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = $2 where id = $1`, [rideId, price]));

// -----------------------------------------------------------------------------
describe("Frais Rydar des flottes : dus par la flotte dès la fin de la course", () => {
  it("% seul, € seul, les deux : % du prix + fixe, sans plafond au prix ; rien sur la course ni pour le chauffeur", async () => {
    const pct = await fleet("Flotte Pourcent", { percent: 10 });
    const dp = await driverIn(pct);
    const r1 = await completedRide(pct, dp, 5900);
    expect(await entriesOf(r1.id)).toEqual([{ kind: "ride", amount_cents: 590, status: "posted" }]);
    expect(await basisOf(r1.id)).toEqual({ percent: 10, fixed: 0 });

    const fixed = await fleet("Flotte Fixe", { fixed: 200 });
    const df = await driverIn(fixed);
    const r2 = await completedRide(fixed, df, 5900);
    expect(await entriesOf(r2.id)).toEqual([{ kind: "ride", amount_cents: 200, status: "posted" }]);

    // 5 % + 2 € sur une course à 1 € : 2,05 € (facturés à la flotte, pas prélevés sur le prix → aucun plafond)
    const both = await fleet("Flotte Mixte", { percent: 5, fixed: 200 });
    const db = await driverIn(both);
    const r3 = await completedRide(both, db, 100);
    expect(await entriesOf(r3.id)).toEqual([{ kind: "ride", amount_cents: 205, status: "posted" }]);

    // Échéance comme en centrale : dernière seconde du 5 du mois suivant (fuseau de l'organisation)
    const [due] = await sql(
      `select to_char(e.due_at at time zone 'Europe/Paris', 'DD HH24:MI:SS') as d from public.platform_fee_entries e where e.ride_id = $1`, [r3.id]);
    expect(due.d).toBe("05 23:59:59");

    // Course : aucune répartition, aucun règlement ; le chauffeur ne voit aucun frais Rydar
    expect((await sql(`select commission_cents, platform_fee_cents, driver_payout_cents from public.rides where id = $1`, [r3.id]))[0]).toEqual({
      commission_cents: null, platform_fee_cents: null, driver_payout_cents: null,
    });
    expect(await sql(`select id from public.ride_settlements where ride_id = $1`, [r3.id])).toHaveLength(0);
    const [seen] = await as({ sub: db.userId }, (q) => q(`select platform_fee_cents from public.rides where id = $1`, [r3.id]));
    expect(seen).toEqual({ platform_fee_cents: null });

    // Compte : modèle flotte, frais « encaissés par l'organisation » (jamais « chez les chauffeurs », même payée en espèces)
    expect(await account(both)).toMatchObject({
      dispatch_model: "fleet", balance_cents: 205, posted_cents: 205, collected_by_centrale_cents: 205, with_drivers_cents: 0,
      waived_by_centrale_cents: 0, fee_percent: 5, fee_fixed_cents: 200,
    });
    const full = await rpc(both.ownerId, "org_platform_account", [both.id]);
    expect(full).toMatchObject({ enabled: true, organization: { dispatch_model: "fleet" } });
    expect(full.entries[0].ride).toMatchObject({ number: Number(r3.number), settlement_status: null, fleet_fee: { percent: 5, fixed_cents: 200 } });
  });

  it("sans prix : seul le fixe est dû ; prix fixé ensuite → part en % ajoutée ; baisse en attente du super admin", async () => {
    const org = await fleet("Flotte Sans Prix", { percent: 10, fixed: 200 });
    const d = await driverIn(org);
    const sa = await superAdmin();
    const ride = await completedRide(org, d, null);
    expect(await entriesOf(ride.id)).toEqual([{ kind: "ride", amount_cents: 200, status: "posted" }]);

    await setPrice(org, ride.id, 5000);
    expect(await entriesOf(ride.id)).toEqual([
      { kind: "ride", amount_cents: 200, status: "posted" },
      { kind: "correction", amount_cents: 500, status: "posted" },
    ]);
    const [corr] = await sql(`select label, reason from public.platform_fee_entries where ride_id = $1 and kind = 'correction'`, [ride.id]);
    expect(corr.reason).toMatch(/^Prix modifié après la course/);

    // Baisse (50 € → 30 €) : -2 € EN ATTENTE, le solde ne bouge pas tant que Rydar n'a pas accepté
    await setPrice(org, ride.id, 3000);
    const [pending] = await sql(`select id, amount_cents from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]);
    expect(pending.amount_cents).toBe(-200);
    expect(await account(org)).toMatchObject({ balance_cents: 700, pending_reductions_cents: -200, pending_reductions_count: 1 });
    expect((await svc("svc_platform_review_entry", [pending.id, sa, true, "Prix corrigé, justifié"])).code).toBe("APPROVED");
    expect((await account(org)).balance_cents).toBe(500);

    // Prix retiré : seul le fixe reste (baisse en attente)
    await setPrice(org, ride.id, null);
    expect((await sql(`select amount_cents from public.platform_fee_entries where ride_id = $1 and status = 'pending'`, [ride.id]))[0].amount_cents).toBe(-300);

    // Signal « à surveiller » du super admin : courses sans prix dont la part en % est perdue (le fixe reste dû)
    const sansPrix = await completedRide(org, d, null);
    expect(await sumOf(sansPrix.id)).toBe(200);
    expect((await account(org)).month.zero_price_rides).toBe(2); // celle-ci + la première, dont le prix a été retiré
    const fixedOnly = await fleet("Flotte Fixe Sans Prix", { fixed: 200 });
    const df = await driverIn(fixedOnly);
    await completedRide(fixedOnly, df, null);
    expect((await account(fixedOnly)).month.zero_price_rides).toBe(0); // fixe seul : rien de perdu sans prix

    // % seul et course sans prix : rien à la fin ; le prix fixé plus tard crée l'écriture, sans échéance rétroactive
    const pctOnly = await fleet("Flotte Pourcent Sans Prix", { percent: 10 });
    const d2 = await driverIn(pctOnly);
    await svc("svc_platform_terms", [pctOnly.id, sa, "monthly", 5, 1]);
    const late = await completedRide(pctOnly, d2, null);
    expect(await entriesOf(late.id)).toHaveLength(0);
    await sql(`update public.rides set completed_at = now() - interval '62 days' where id = $1`, [late.id]);
    await setPrice(pctOnly, late.id, 8000);
    const [e] = await sql(`select kind, amount_cents, due_at from public.platform_fee_entries where ride_id = $1`, [late.id]);
    expect(e).toMatchObject({ kind: "ride", amount_cents: 800 });
    expect(new Date(e.due_at).getTime()).toBeGreaterThan(Date.now());
    expect(await account(pctOnly)).toMatchObject({ due_cents: 0, overdue_since: null, blocked: false });
  });

  it("course annulée : aucun frais ; flotte sans frais : ni écriture, ni base, ni écran", async () => {
    const org = await fleet("Flotte Annulation", { fixed: 200 });
    const d = await driverIn(org);
    const ride = await createRideAsOwner(org, { price_cents: 4000, payment_method: "cash" });
    await advance(d, ride.id, "PASSENGER_ONBOARD");
    expect((await rpc(org.ownerId, "cancel_ride", [ride.id, "Client parti"])).code).toBe("CANCELLED");
    expect(await entriesOf(ride.id)).toHaveLength(0);
    expect(await basisOf(ride.id)).toBeNull();
    expect((await account(org)).month).toMatchObject({ cancelled_assigned_rides: 1, cancelled_onboard_rides: 1 });

    const free = await fleet("Flotte Sans Frais Rydar");
    const df = await driverIn(free);
    const r = await completedRide(free, df, 5000);
    expect(await entriesOf(r.id)).toHaveLength(0);
    expect(await basisOf(r.id)).toBeNull();
    expect(await rpc(free.ownerId, "org_platform_account", [free.id])).toEqual({ enabled: false });
    expect(await rpc(free.ownerId, "org_platform_status", [free.id])).toEqual({ enabled: false });
    const sa = await superAdmin();
    expect((await rpc(sa, "admin_platform_overview")).organizations.some((o: any) => o.id === free.id)).toBe(false);
  });

  it("changement de réglage : seules les courses terminées après lui ; un prix corrigé garde les taux de SA course", async () => {
    // Course terminée quand la flotte n'avait aucun frais : jamais facturée, même corrigée après coup
    const org = await fleet("Flotte Réglages");
    const d = await driverIn(org);
    const before = await completedRide(org, d, 5000);
    expect(await basisOf(before.id)).toBeNull();

    await setFees(org, 5, 200);
    await setPrice(org, before.id, 9000);
    expect(await entriesOf(before.id)).toHaveLength(0);

    // Course terminée sous 5 % + 2 € : 4,50 €
    const r1 = await completedRide(org, d, 5000);
    expect(await sumOf(r1.id)).toBe(450);

    // Course en cours pendant le changement : terminée après → nouveaux taux (fin de course)
    const d2 = await driverIn(org);
    const inflight = await createRideAsOwner(org, { price_cents: 5000, payment_method: "cash" });
    await advance(d2, inflight.id, "IN_PROGRESS");
    await setFees(org, 10, 300);
    await continueTo(d2, inflight.id, "COMPLETED", "IN_PROGRESS");
    expect(await sumOf(inflight.id)).toBe(800);

    // r1 corrigée à 60 € : recalcul avec SES taux (5 % + 2 € = 5 €), pas les nouveaux (10 % + 3 € = 9 €)
    await setPrice(org, r1.id, 6000);
    expect(await entriesOf(r1.id)).toEqual([
      { kind: "ride", amount_cents: 450, status: "posted" },
      { kind: "correction", amount_cents: 50, status: "posted" },
    ]);
    // Frais remis à 0 : les courses déjà terminées restent dues, l'écran reste ouvert (historique)
    await setFees(org, 0, 0);
    const r2 = await completedRide(org, d, 5000);
    expect(await entriesOf(r2.id)).toHaveLength(0);
    expect(await account(org)).toMatchObject({ balance_cents: 500 + 800, fee_percent: 0, fee_fixed_cents: 0 });
  });
});

// -----------------------------------------------------------------------------
describe("Frais Rydar : passage flotte ↔ centrale sans double frais ni frais perdus", () => {
  it("flotte → centrale → flotte : chaque course garde la règle du modèle de sa fin de course", async () => {
    const org = await fleet("Flotte Bascule", { fixed: 200 }, { driver_commission_percent: 20, settlement_methods: "{link,cash,transfer}" });
    const d = await driverIn(org);
    const d2 = await driverIn(org);

    // Terminée en flotte : 2 €
    const rideF = await completedRide(org, d, 5000);
    expect(await sumOf(rideF.id)).toBe(200);

    // En cours pendant le passage en centrale (10 % + 2 €) : répartition calculée, frais de centrale à la fin
    const inflightC = await createRideAsOwner(org, { price_cents: 5000, payment_method: "cash" });
    await advance(d2, inflightC.id, "IN_PROGRESS");
    await setModel(org, "centrale", { percent: 10, fixed: 200 });
    expect(await sumOf(rideF.id)).toBe(200); // rien de recalculé au changement de modèle
    await continueTo(d2, inflightC.id, "COMPLETED", "IN_PROGRESS");
    expect(await entriesOf(inflightC.id)).toEqual([{ kind: "ride", amount_cents: 700, status: "posted" }]);
    expect(await basisOf(inflightC.id)).toBeNull();
    expect((await sql(`select platform_fee_cents from public.ride_settlements where ride_id = $1`, [inflightC.id]))[0].platform_fee_cents).toBe(700);

    // Course de flotte corrigée APRÈS le passage en centrale : répartition + règlement chauffeur (logique existante) →
    // la règle centrale reprend la main, par correction (total = frais de la répartition, jamais 2 € + 7 €)
    await setPrice(org, rideF.id, 6000);
    const [split] = await sql(`select platform_fee_cents from public.rides where id = $1`, [rideF.id]);
    expect(split.platform_fee_cents).toBe(800);
    expect(await sumOf(rideF.id)).toBe(800);
    expect(await entriesOf(rideF.id)).toEqual([
      { kind: "ride", amount_cents: 200, status: "posted" },
      { kind: "correction", amount_cents: 600, status: "posted" },
    ]);

    // Retour en flotte (règlements soldés) avec 1 € par course
    for (const x of await sql(`select id from public.ride_settlements where organization_id = $1 and status in ('due', 'declared', 'disputed')`, [org.id])) {
      expect((await rpc(org.ownerId, "waive_settlement", [x.id, "Fin du mode centrale"])).ok).toBe(true);
    }
    const inflightF = await createRideAsOwner(org, { price_cents: 5000, payment_method: "cash" });
    await advance(d, inflightF.id, "IN_PROGRESS");
    expect((await sql(`select platform_fee_cents from public.rides where id = $1`, [inflightF.id]))[0].platform_fee_cents).toBe(700);
    await setModel(org, "fleet", { percent: 0, fixed: 100 });
    await continueTo(d, inflightF.id, "COMPLETED", "IN_PROGRESS");
    // Terminée en flotte : frais de flotte (1 €), pas la répartition héritée (7 €) ; aucun règlement chauffeur
    expect(await entriesOf(inflightF.id)).toEqual([{ kind: "ride", amount_cents: 100, status: "posted" }]);
    expect(await sql(`select id from public.ride_settlements where ride_id = $1`, [inflightF.id])).toHaveLength(0);

    // Course terminée en centrale, corrigée en flotte : sa répartition reste figée (règle centrale inchangée)
    await setPrice(org, inflightC.id, 9000);
    expect(await sumOf(inflightC.id)).toBe(700);

    // Solde = somme exacte des frais de chaque course
    expect((await account(org)).balance_cents).toBe(800 + 700 + 100);
    const [{ n }] = await sql(`select count(*)::int as n from public.platform_fee_entries where organization_id = $1 and kind = 'ride'`, [org.id]);
    expect(n).toBe(3);
  });

  it("centrale avec frais repassée en flotte sans frais : historique suivi, aucun nouveau frais", async () => {
    const org = await createOrg("Centrale Redevenue Flotte", { settings: { settlement_methods: "{link,cash,transfer}" } });
    await setModel(org, "centrale", { percent: 0, fixed: 500 });
    await insertRideBypass(org, { completed_at: new Date(), payment_method: "invoice" });
    const d = await driverIn(org);
    // Créée en centrale (répartition : 5 € de frais), terminée après le retour en flotte sans frais : rien n'est dû
    const inflight = await createRideAsOwner(org, { price_cents: 5000, payment_method: "invoice" });
    await advance(d, inflight.id, "IN_PROGRESS");
    await setModel(org, "fleet", { percent: 0, fixed: 0 });
    await continueTo(d, inflight.id, "COMPLETED", "IN_PROGRESS");
    expect((await sql(`select platform_fee_cents from public.rides where id = $1`, [inflight.id]))[0].platform_fee_cents).toBe(500);
    expect(await basisOf(inflight.id)).toEqual({ percent: 0, fixed: 0 });
    expect(await entriesOf(inflight.id)).toHaveLength(0);
    const r = await completedRide(org, d, 5000);
    expect(await entriesOf(r.id)).toHaveLength(0);
    const acc = await rpc(org.ownerId, "org_platform_account", [org.id]);
    expect(acc).toMatchObject({ enabled: true, organization: { dispatch_model: "fleet" }, account: { balance_cents: 500 } });
  });
});

// -----------------------------------------------------------------------------
describe("Frais Rydar des flottes : paiements, échéances, droits", () => {
  it("« J'ai payé », reçu partiel, échéances les plus anciennes d'abord, blocage, relevé", async () => {
    const org = await fleet("Flotte Paiements", { fixed: 200 });
    const sa = await superAdmin();
    await insertRideBypass(org, { completed_at: daysAgo(75) }); // échue depuis longtemps
    await insertRideBypass(org, { completed_at: daysAgo(45) });
    await insertRideBypass(org, { completed_at: new Date() }); // pas encore échue
    const [dues] = await sql(`select array_agg(due_at order by due_at) as d from public.platform_fee_entries where organization_id = $1`, [org.id]);
    const [first, second, third] = dues.d as Date[];
    let acc = await account(org);
    expect(acc.balance_cents).toBe(600);
    expect(acc.due_cents).toBe(new Date(second).getTime() <= Date.now() ? 400 : 200);
    expect(new Date(acc.overdue_since).getTime()).toBe(new Date(first).getTime());
    expect(new Date(acc.next_due_at).getTime()).toBe(new Date(third).getTime());

    // Levier du super admin : création de courses refusée après 1 jour de retard (flotte comme centrale)
    expect((await svc("svc_platform_terms", [org.id, sa, "monthly", 5, 1])).code).toBe("SAVED");
    expect((await expectPgError(createRideAsOwner(org, { price_cents: 3000 }))).message).toContain("PLATFORM_FEES_OVERDUE");

    // « J'ai payé » de l'échu : blocage suspendu ; reçu en partie (2 €) → la plus ancienne échéance est soldée
    const dec = await rpc(org.ownerId, "declare_platform_payment", [org.id, 400, "transfer", "VIR FLOTTE", null, null]);
    expect(dec).toMatchObject({ ok: true, code: "DECLARED" });
    expect((await account(org)).blocked).toBe(false);
    expect((await svc("svc_platform_confirm_payment", [dec.id, sa, 200, "Reçu en partie"])).received_cents).toBe(200);
    acc = await account(org);
    expect(acc).toMatchObject({ balance_cents: 400, received_cents: 200 });
    expect(new Date(acc.overdue_since ?? 0).getTime()).toBe(new Date(second).getTime() <= Date.now() ? new Date(second).getTime() : 0);

    // Paiement reçu directement + avoir : plus rien d'échu, création de courses rétablie
    await svc("svc_platform_record_payment", [org.id, sa, 200, "transfer", "VIR-2", null, null]);
    expect((await svc("svc_platform_adjust", [org.id, sa, -100, "Geste commercial"])).code).toBe("ADJUSTED");
    acc = await account(org);
    expect(acc).toMatchObject({ due_cents: 0, overdue_since: null, blocked: false, balance_cents: 100 });
    await createRideAsOwner(org, { price_cents: 3000 });

    // Relevé du mois : flotte, écritures de courses de flotte, ouverture + frais − reçu = clôture
    const month = (await sql(`select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM') as m`))[0].m;
    const st = await rpc(org.ownerId, "org_platform_statement", [org.id, month]);
    expect(st.organization).toMatchObject({ dispatch_model: "fleet" });
    expect(st.opening_cents + st.fees_cents - st.received_cents).toBe(st.closing_cents);
    expect(st.closing_cents).toBe(100);
    const rideEntry = st.entries.find((e: any) => e.kind === "ride");
    expect(rideEntry.ride.fleet_fee).toEqual({ percent: 0, fixed_cents: 200 });

    // Vue du super admin : la flotte est listée, avec son modèle
    const ov = await rpc(sa, "admin_platform_overview");
    expect(ov.organizations.find((o: any) => o.id === org.id)).toMatchObject({ dispatch_model: "fleet", balance_cents: 100 });
    const detail = await rpc(sa, "admin_platform_account", [org.id, null]);
    expect(detail).toMatchObject({ organization: { dispatch_model: "fleet" }, account: { balance_cents: 100 } });
    // Relance du super admin : affichée à la flotte (messages au nom de la flotte, pas de « la centrale »)
    expect(await svc("svc_platform_remind", [org.id, sa, "Merci de régler"])).toMatchObject({
      code: "REMINDED", message: "Relance affichée à la flotte.",
    });
    expect(await account(org)).toMatchObject({ reminder_note: "Merci de régler" });
    const empty = await fleet("Flotte Rien À Régler", { fixed: 200 });
    expect(await svc("svc_platform_remind", [empty.id, sa, null])).toMatchObject({ code: "NOTHING_DUE", message: "Rien à régler pour cette flotte." });
    const centrale = await createOrg("Centrale Rien À Régler");
    await setModel(centrale, "centrale", { percent: 0, fixed: 200 });
    expect((await svc("svc_platform_remind", [centrale.id, sa, null])).message).toBe("Rien à régler pour cette centrale.");
  });

  it("flotte avec frais réglés mais aucune course : écran ouvert et listée chez le super admin", async () => {
    const org = await fleet("Flotte Frais Neufs", { fixed: 200 });
    const sa = await superAdmin();
    expect(await rpc(org.ownerId, "org_platform_account", [org.id])).toMatchObject({ enabled: true, account: { balance_cents: 0 } });
    expect(await rpc(org.ownerId, "org_platform_status", [org.id])).toMatchObject({ enabled: true });
    expect((await rpc(sa, "admin_platform_overview")).organizations.some((o: any) => o.id === org.id)).toBe(true);
  });

  it("droits : owner / admin de la flotte lisent et déclarent ; dispatcher, chauffeur, autre organisation : rien", async () => {
    const org = await fleet("Flotte Droits", { fixed: 200 });
    const other = await fleet("Flotte Droits Autre", { fixed: 200 });
    const d = await driverIn(org);
    const ride = await completedRide(org, d, 4000);
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");

    expect((await rpc(admin, "org_platform_account", [org.id])).enabled).toBe(true);
    expect((await rpc(admin, "org_platform_status", [org.id])).account.balance_cents).toBe(200);
    expect((await rpc(admin, "declare_platform_payment", [org.id, 200, "transfer", null, null, null])).code).toBe("DECLARED");

    for (const sub of [dispatcher, d.userId, other.ownerId]) {
      expect((await expectPgError(rpc(sub, "org_platform_account", [org.id]))).code).toBe("42501");
      expect((await expectPgError(rpc(sub, "org_platform_statement", [org.id, null]))).code).toBe("42501");
      expect((await expectPgError(rpc(sub, "declare_platform_payment", [org.id, 100, "cash", null, null, null]))).code).toBe("42501");
      expect(await rpc(sub, "org_platform_status", [org.id])).toEqual({ enabled: false });
      const entries = await as({ sub }, (q) => q(`select id from public.platform_fee_entries where organization_id = $1`, [org.id]));
      expect(entries).toHaveLength(0);
      const payments = await as({ sub }, (q) => q(`select id from public.platform_payments where organization_id = $1`, [org.id]));
      expect(payments).toHaveLength(0);
    }
    // Le chauffeur lit sa course : aucun frais Rydar
    const [seen] = await as({ sub: d.userId }, (q) => q(`select platform_fee_cents, commission_cents from public.rides where id = $1`, [ride.id]));
    expect(seen).toEqual({ platform_fee_cents: null, commission_cents: null });
    // Base figée : illisible hors des fonctions (ni client, ni service role), fonctions internes fermées
    for (const role of ["authenticated", "service_role"] as const) {
      const denied = await expectPgError(as({ sub: org.ownerId, role }, (q) => q(`select * from private.fleet_fee_basis`)));
      expect(denied.code).toBe("42501");
    }
    const fn = await expectPgError(as({ sub: org.ownerId }, (q) => q(`select private.platform_fees_enabled($1)`, [org.id])));
    expect(fn.code).toBe("42501");
    // Réglage des frais : colonnes réservées au super admin
    const upd = await expectPgError(as({ sub: org.ownerId }, (q) =>
      q(`update public.organizations set platform_fee_fixed_cents = 0 where id = $1`, [org.id])));
    expect(upd.code).toBe("42501");
  });

  it("calcul : % arrondi, sans prix = fixe seul, prix négatif ignoré, plafond du registre", async () => {
    const calc = async (price: number | null, pct: number, fixed: number) =>
      (await sql(`select private.fleet_platform_fee($1, $2, $3) as v`, [price, pct, fixed]))[0].v as number;
    expect(await calc(5900, 10, 0)).toBe(590);
    expect(await calc(1234, 2.5, 0)).toBe(31); // 30,85 → 31
    expect(await calc(null, 10, 200)).toBe(200);
    expect(await calc(0, 10, 200)).toBe(200);
    expect(await calc(-500, 10, 200)).toBe(200);
    expect(await calc(100_000_000, 50, 100_000)).toBe(10_000_000);
  });
});

// -----------------------------------------------------------------------------
describe("Frais Rydar des flottes : tous les chemins de fin de course et de correction", () => {
  it("fin de course hors app chauffeur : statut fermé au tableau de bord ; import / support (service role) → mêmes frais", async () => {
    const org = await fleet("Flotte Fin Serveur", { percent: 10, fixed: 200 });
    const d = await driverIn(org);
    const dispatcher = await createMember(org, "dispatcher");
    const ride = await createRideAsOwner(org, { price_cents: 4000, payment_method: "cash" });
    await advance(d, ride.id, "IN_PROGRESS");
    // Aucun rôle du tableau de bord ne termine une course (statut réservé au chauffeur, driver_update_ride_status)
    for (const sub of [org.ownerId, dispatcher]) {
      const denied = await expectPgError(as({ sub }, (q) => q(`update public.rides set status = 'COMPLETED' where id = $1`, [ride.id])));
      expect(denied.code).toBe("42501");
    }
    expect(await entriesOf(ride.id)).toHaveLength(0);
    // Fin écrite côté serveur (reprise, support) : même trigger, mêmes taux figés, mêmes frais
    await as({ role: "service_role" }, (q) =>
      q(`update public.rides set status = 'COMPLETED', completed_at = now() where id = $1`, [ride.id]));
    expect(await entriesOf(ride.id)).toEqual([{ kind: "ride", amount_cents: 600, status: "posted" }]);
    expect(await basisOf(ride.id)).toEqual({ percent: 10, fixed: 200 });
  });

  it("dispatcher : baisse du prix d'une course terminée (en attente) puis hausse (baisse remplacée, hausse comptée)", async () => {
    const org = await fleet("Flotte Dispatcher Prix", { percent: 10, fixed: 200 });
    const d = await driverIn(org);
    const dispatcher = await createMember(org, "dispatcher");
    const ride = await completedRide(org, d, 5000);
    expect(await sumOf(ride.id)).toBe(700);
    const byDispatcher = (price: number) =>
      as({ sub: dispatcher }, (q) => q(`update public.rides set price_cents = $2 where id = $1`, [ride.id, price]));

    await byDispatcher(3000); // 5 € : baisse de 2 € en attente du super admin
    expect(await entriesOf(ride.id)).toEqual([
      { kind: "ride", amount_cents: 700, status: "posted" },
      { kind: "correction", amount_cents: -200, status: "pending" },
    ]);
    expect(await account(org)).toMatchObject({ balance_cents: 700, pending_reductions_count: 1 });

    await byDispatcher(6000); // 8 € : la baisse est remplacée (jamais comptée deux fois), +1 € compté tout de suite
    expect(await entriesOf(ride.id)).toEqual([
      { kind: "ride", amount_cents: 700, status: "posted" },
      { kind: "correction", amount_cents: -200, status: "rejected" },
      { kind: "correction", amount_cents: 100, status: "posted" },
    ]);
    const [superseded] = await sql(
      `select review_note, reviewed_by from public.platform_fee_entries where ride_id = $1 and status = 'rejected'`, [ride.id]);
    expect(superseded).toEqual({ review_note: "Remplacée : le prix de la course a de nouveau été modifié", reviewed_by: null });
    expect(await account(org)).toMatchObject({ balance_cents: 800, pending_reductions_count: 0 });
    // Le dispatcher ne voit toujours ni le compte ni les écritures
    expect((await expectPgError(rpc(dispatcher, "org_platform_account", [org.id]))).code).toBe("42501");
  });

  it("réglage changé PENDANT la fin de course : taux validés au moment de la fin (jamais un réglage non enregistré)", async () => {
    const org = await fleet("Flotte Chevauchement", { fixed: 200 });
    const d = await driverIn(org);
    const d2 = await driverIn(org);
    const ride = await createRideAsOwner(org, { price_cents: 5000, payment_method: "cash" });
    await advance(d, ride.id, "IN_PROGRESS");
    const ride2 = await createRideAsOwner(org, { price_cents: 5000, payment_method: "cash" });
    await advance(d2, ride2.id, "IN_PROGRESS");

    // Le super admin passe à 10 % + 3 € (accord écrit) ; la course se termine avant l'enregistrement : anciens taux (2 €)
    const sa = await feeActor();
    await as({ role: "service_role" }, async (q) => {
      await q(`select public.svc_platform_set_fees($1, $2, 10, 300, null, 'consent', null, 'Accord écrit (test)')`, [org.id, sa]);
      await continueTo(d, ride.id, "COMPLETED", "IN_PROGRESS"); // autre connexion, sans attendre ce réglage
    });
    expect(await entriesOf(ride.id)).toEqual([{ kind: "ride", amount_cents: 200, status: "posted" }]);
    expect(await basisOf(ride.id)).toEqual({ percent: 0, fixed: 200 });
    // Fin après l'enregistrement : nouveaux taux (5 € + 3 €)
    await continueTo(d2, ride2.id, "COMPLETED", "IN_PROGRESS");
    expect(await entriesOf(ride2.id)).toEqual([{ kind: "ride", amount_cents: 800, status: "posted" }]);
  });

  it("course terminée en flotte, corrigée après un passage en centrale SANS règlement chauffeur : ses taux figés restent la règle", async () => {
    // Centrale à 0 % de commission et 0 € de frais : répartition nulle, aucun règlement chauffeur créé
    const org = await fleet("Flotte Puis Centrale Nulle", { percent: 10, fixed: 200 }, {
      driver_commission_percent: 0, settlement_methods: "{link,cash,transfer}",
    });
    const d = await driverIn(org);
    const ride = await completedRide(org, d, 7000);
    expect(await sumOf(ride.id)).toBe(900);
    await setModel(org, "centrale", { percent: 0, fixed: 0 });
    await setPrice(org, ride.id, 8000);
    expect(await sql(`select id from public.ride_settlements where ride_id = $1`, [ride.id])).toHaveLength(0);
    expect((await sql(`select platform_fee_cents from public.rides where id = $1`, [ride.id]))[0].platform_fee_cents).toBe(0);
    // Taux figés de la course (10 % + 2 €) : 10 € → +1 €, pas la répartition de la centrale (0 €)
    expect(await entriesOf(ride.id)).toEqual([
      { kind: "ride", amount_cents: 900, status: "posted" },
      { kind: "correction", amount_cents: 100, status: "posted" },
    ]);
    // Une nouvelle course terminée en centrale suit la règle centrale (0 € de frais : aucune écriture)
    const r2 = await createRideAsOwner(org, { price_cents: 5000, payment_method: "cash" });
    await advance(d, r2.id);
    expect(await entriesOf(r2.id)).toHaveLength(0);
    expect(await basisOf(r2.id)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe("Frais Rydar des flottes : menu et temps réel", () => {
  it("org_platform_fees_enabled : le seul booléen du menu, owner / admin seulement", async () => {
    const org = await fleet("Flotte Menu", { fixed: 200 });
    const free = await fleet("Flotte Menu Sans Frais");
    const centrale = await createOrg("Centrale Menu");
    await setModel(centrale, "centrale", { percent: 0, fixed: 0 });
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");
    const d = await driverIn(org);
    const enabled = async (sub: string, o: Org) => (await rpc(sub, "org_platform_fees_enabled", [o.id])) as unknown as boolean;

    expect(await enabled(org.ownerId, org)).toBe(true);
    expect(await enabled(admin, org)).toBe(true);
    expect(await enabled(dispatcher, org)).toBe(false);
    expect(await enabled(d.userId, org)).toBe(false);
    expect(await enabled(free.ownerId, org)).toBe(false);
    expect(await enabled(free.ownerId, free)).toBe(false);
    expect(await enabled(centrale.ownerId, centrale)).toBe(true);
    // Anonyme : fonction fermée
    const anon = await expectPgError(as({ role: "anon" }, (q) => q(`select public.org_platform_fees_enabled($1)`, [org.id])));
    expect(anon.code).toBe("42501");
  });

  it("frais ou modèle changés par le super admin : « platform.updated » (rates / model), identifiants seulement", async () => {
    const org = await fleet("Flotte Temps Réel");
    const events = async () =>
      (await sql(`select payload from realtime.messages where topic = $1 and event = 'platform.updated' order by id`, [`org:${org.id}`]))
        .map((m: any) => m.payload);
    expect(await events()).toEqual([]);
    await setFees(org, 0, 200);
    await setFees(org, 0, 200); // inchangé : rien
    await setModel(org, "centrale");
    expect(await events()).toEqual([
      { action: "rates", organization_id: org.id },
      { action: "model", organization_id: org.id },
    ]);
  });
});
