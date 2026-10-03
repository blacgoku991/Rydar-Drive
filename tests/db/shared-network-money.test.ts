// Réseau partagé, lot 4 — argent (20260924006900_shared_network_money). Partie 4a : règlement réseau à la fin de course
// (termes figés de l'exécution, contrepartie toujours le chauffeur), côté chauffeur (règlements partenaires par
// organisation, « J'ai payé » avec les seuls moyens de A, « Je conteste », coordonnées de versement), accueil et gains
// (net par course aux termes figés). Scénarios §14.1 n° 16, 17 et 19 (côté chauffeur) de la spécification.
// Réglages du réseau écrits directement (helpers de tests/db/helpers.ts). L'interrupteur est rouvert avant chaque test et
// recoupé à la fin du fichier.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../../packages/shared/src/domain";
import {
  NETWORK_PARAMS, networkTerms, type DriverNetworkSettlementItem, type DriverNetworkSettlements, type DriverPayoutInfo,
} from "../../packages/shared/src/network";
import {
  acceptDriverTerms, approveNetwork, as, CDG, createDriver, createMember, createOrg, createRideAsOwner, enableNetwork,
  expectPgError, inMinutes, insertRideBypass, north, pingApp, pool, setSharedNetwork, sql, type Driver, type Org,
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
const tag = () => randomUUID().slice(0, 6);
/** Téléphone propre à un chauffeur (empreintes d'identité : createDriver donne le même numéro à tous). */
const uniquePhone = () => `+3362${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/**
 * Lieu propre à chaque paire (≈ 39 km d'écart, plus que le rayon réseau maximal) et loin des lieux du fichier du
 * dispatch (latitudes 42,5 et au-delà) : les partenaires des autres tests ne sont jamais à proximité.
 */
let sites = 0;
const nextSite = (): [number, number] => [20 + ++sites * 0.35, 2.35];

const IBAN_FR = "FR7630006000011234567890189";
const IBAN_DE = "DE89370400440532013000";

/** Chauffeur partenaire prêt : position, téléphone, carte VTC, n° d'exploitant, 4 documents valides, conditions, app à jour. */
async function readyPartner(B: Org, opts: { firstName?: string; at: [number, number] }): Promise<Driver> {
  const d = await createDriver(B, { firstName: opts.firstName ?? "Karim", at: opts.at });
  await sql(
    `update public.drivers set phone = $2, vtc_card_number = $3, last_name = 'Tazi', vtc_operator_registration = 'EVTC075990001'
      where id = $1`,
    [d.id, uniquePhone(), `VTC${tag()}`],
  );
  for (const type of ["vtc_card", "insurance", "vehicle_registration", "driving_license"]) {
    await sql(
      `insert into public.driver_documents (organization_id, driver_id, type, status, expires_at, reviewed_at)
       select organization_id, id, $2, 'valid', current_date + 365, now() from public.drivers where id = $1`,
      [d.id, type],
    );
  }
  await acceptDriverTerms(d);
  await pingApp(d);
  return d;
}

type Model = "fleet" | "centrale";
type Pair = { A: Org; B: Org; partner: Driver; site: [number, number]; aName: string; bName: string };

/** Organisation qui confie ses courses (10 % de frais Rydar ; centrale : 15 % de commission), partage validé. */
async function giver(name: string, model: Model = "fleet"): Promise<Org> {
  const A = await createOrg(`${name} ${tag()}`);
  if (model === "centrale") {
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [A.id]);
    await sql(`update public.organization_settings set driver_commission_percent = 15 where organization_id = $1`, [A.id]);
  }
  await enableNetwork(A, { out: true });
  await approveNetwork(A);
  return A;
}

/** A (donneuse) partage, B (flotte par défaut) reçoit ; validées ; un partenaire prêt chez B. */
async function networkPair(opts: { giver?: Model; executor?: Model } = {}): Promise<Pair> {
  const A = await giver("Donneuse", opts.giver ?? "fleet");
  const B = await createOrg(`Executante ${tag()}`);
  if (opts.executor === "centrale") await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [B.id]);
  await enableNetwork(B, { in: true });
  await approveNetwork(B);
  const site = nextSite();
  const partner = await readyPartner(B, { at: north(site, 800) });
  return { A, B, partner, site, aName: await orgName(A), bName: await orgName(B) };
}

async function orgName(org: Org): Promise<string> {
  const [o] = await sql(`select name from public.organizations where id = $1`, [org.id]);
  return o.name;
}

/** Position du chauffeur (reçue il y a ageSeconds). */
async function moveTo(driverId: string, at: [number, number], ageSeconds = 0) {
  await sql(
    `update public.driver_locations
        set lat = $2, lng = $3, recorded_at = now() - make_interval(secs => $4), updated_at = now() - make_interval(secs => $4)
      where driver_id = $1`,
    [driverId, at[0], at[1], ageSeconds],
  );
}

/** Course de A acceptée par le partenaire : étape réseau réelle (après les vagues propres) + accept_ride_offer. */
async function partnerAccepts(p: Pair, partner: Driver, overrides: Record<string, unknown> = {}, A: Org = p.A) {
  await moveTo(partner.id, north(p.site, 800));
  await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [partner.id]);
  const ride = await createRideAsOwner(A, { pickup_lat: p.site[0], pickup_lng: p.site[1], price_cents: 5000, ...overrides });
  await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
  await sql("select private.dispatch_tick()");
  const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [
    ride.id, partner.id,
  ]);
  expect(offer, "offre réseau envoyée").toBeTruthy();
  const res = await as({ sub: partner.userId }, async (q) => (await q("select public.accept_ride_offer($1) as r", [offer.id]))[0].r);
  expect(res).toMatchObject({ ok: true, code: "ACCEPTED" });
  const [execution] = await sql(`select * from public.ride_network_executions where ride_id = $1 and ended_at is null`, [ride.id]);
  return { ride, execution };
}

/** Étape déclarée par le chauffeur (application). */
async function stepAs(driver: Driver, rideId: string, status: string) {
  return as({ sub: driver.userId }, async (q) => (await q("select public.driver_update_ride_status($1, $2) as r", [rideId, status]))[0].r);
}

/**
 * Course menue jusqu'au bout par le chauffeur : positions fraîches au départ puis à l'arrivée (aucune raison « à
 * vérifier ») ; gps: false → position périmée à la fin (no_gps : course « à vérifier », versement prépayé retenu 72 h).
 */
async function finish(driver: Driver, rideId: string, site: [number, number], opts: { gps?: boolean } = {}) {
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
    await moveTo(driver.id, site);
    expect(await stepAs(driver, rideId, s), s).toMatchObject({ ok: true });
  }
  await moveTo(driver.id, CDG, opts.gps === false ? 600 : 0);
  expect(await stepAs(driver, rideId, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
}

/** Course partagée faite de bout en bout ; renvoie la course, l'exécution et la ligne réseau créée. */
async function sharedRide(p: Pair, overrides: Record<string, unknown> = {}, opts: { partner?: Driver; A?: Org; gps?: boolean } = {}) {
  const partner = opts.partner ?? p.partner;
  const { ride, execution } = await partnerAccepts(p, partner, overrides, opts.A ?? p.A);
  await finish(partner, ride.id, p.site, { gps: opts.gps });
  const [settlement] = await sql(`select * from public.ride_settlements where ride_id = $1`, [ride.id]);
  return { ride, execution, settlement };
}

const rpc = async (who: string, fn: string, args: unknown[] = []) =>
  as({ sub: who }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0].r);

/** Messages temps réel d'un règlement sur un sujet. */
const messagesOf = (topic: string, settlementId: string) =>
  sql(
    `select payload from realtime.messages
      where topic = $1 and event = 'settlement.updated'
        and (payload -> 'item' ->> 'id' = $2 or payload -> 'settlement' ->> 'id' = $2)
      order by id`,
    [topic, settlementId],
  );

/** Règlement propre « à régler » d'un chauffeur de centrale (commission due, non échue). */
async function ownLine(org: Org, driverId: string, amount = 1500) {
  const rideId = await insertRideBypass(org, { driver_id: driverId, status: "COMPLETED", completed_at: new Date() });
  const [x] = await sql(
    `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
       commission_cents, driver_payout_cents, payment_method, reference, status, due_at)
     values ($1, $2, $3, 'Karim Tazi (#1)', 'driver_owes', $4, 5000, $4, 5000 - $4, 'cash', 'C-OWN', 'due', now() + interval '1 day')
     returning id`,
    [org.id, rideId, driverId, amount],
  );
  return x.id as string;
}

// =============================================================================
// n° 16 — Montants (Q1) : centrale et flotte × payé à bord / prépayé, termes figés
// =============================================================================
describe("Règlement réseau à la fin de course (§10.3, §14.1 n° 16)", () => {
  // Tableau Q1 de la spécification : course de 50 €, 10 % de frais Rydar pour A, centrale à 15 % de commission
  const Q1: Array<{ giver: Model; method: "cash" | "online"; direction: string; amount: number; commission: number; fee: number; part: number }> = [
    { giver: "centrale", method: "cash", direction: "driver_owes", amount: 1250, commission: 750, fee: 500, part: 3750 },
    { giver: "centrale", method: "online", direction: "centrale_owes", amount: 3750, commission: 750, fee: 500, part: 3750 },
    { giver: "fleet", method: "cash", direction: "driver_owes", amount: 500, commission: 0, fee: 500, part: 4500 },
    { giver: "fleet", method: "online", direction: "centrale_owes", amount: 4500, commission: 0, fee: 500, part: 4500 },
  ];

  for (const c of Q1) {
    it(`A ${c.giver === "centrale" ? "centrale (15 %)" : "flotte"}, ${c.method === "cash" ? "payé à bord" : "prépayé"} : montants du tableau Q1, ligne réseau complète`, async () => {
      const p = await networkPair({ giver: c.giver });
      const { ride, execution, settlement } = await sharedRide(p, { payment_method: c.method });

      // Miroir TS (aperçu de l'onglet) : mêmes montants que les termes figés et que le tableau Q1
      const mirror = networkTerms(
        { price_cents: 5000, payment_method: c.method, commission_cents: c.giver === "centrale" ? 750 : null, platform_fee_cents: c.giver === "centrale" ? 500 : null },
        { dispatch_model: c.giver, platform_fee_percent: "10.00", platform_fee_fixed_cents: 0, driver_commission_percent: c.giver === "centrale" ? "15.00" : null },
      );
      expect(mirror.ok && mirror.terms.amount_cents).toBe(c.amount);
      expect(execution.terms).toMatchObject({ amount_cents: c.amount, direction: c.direction, driver_payout_cents: c.part });

      expect(settlement).toMatchObject({
        organization_id: p.A.id, driver_id: null, network_driver_id: p.partner.id, network_driver_org_id: p.B.id,
        network_execution_id: execution.id, network_counterparty: "driver", direction: c.direction, amount_cents: c.amount,
        price_cents: 5000, commission_cents: c.commission, platform_fee_cents: c.fee, driver_payout_cents: c.part,
        payment_method: c.method, reference: `R${ride.number}`, status: "due", driver_label: `Karim T. · ${p.bName}`,
      });
      // Échéance : délai de A (24 h ici) porté à 48 h pour un reversement ; 7 jours pour un versement
      const [due] = await sql(
        `select extract(epoch from (due_at - created_at))::integer as s from public.ride_settlements where id = $1`,
        [settlement.id],
      );
      const expected = c.direction === "driver_owes" ? NETWORK_PARAMS.minDriverGraceHours * 3600 : NETWORK_PARAMS.payoutDays * 86400;
      expect(Math.abs(due.s - expected)).toBeLessThan(60);
      // Une seule ligne, aucune chez B
      expect(await sql(`select 1 from public.ride_settlements where organization_id = $1`, [p.B.id])).toEqual([]);
      expect((await sql(`select count(*)::int as n from public.ride_settlements where ride_id = $1`, [ride.id]))[0].n).toBe(1);
    });
  }

  it("termes figés : A passe de flotte à centrale pendant la course, le règlement garde les termes acceptés", async () => {
    const p = await networkPair({ giver: "fleet" });
    const { ride, execution } = await partnerAccepts(p, p.partner, { payment_method: "cash" });
    expect(execution.terms).toMatchObject({ commission_cents: 0, platform_fee_cents: 500, amount_cents: 500 });
    await sql(`update public.organization_settings set driver_commission_percent = 15 where organization_id = $1`, [p.A.id]);
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [p.A.id]);
    // La répartition vivante de la course est maintenant celle des chauffeurs de la centrale A…
    const [live] = await sql(`select commission_cents, driver_payout_cents from public.rides where id = $1`, [ride.id]);
    expect(live).toEqual({ commission_cents: 750, driver_payout_cents: 3750 });
    await finish(p.partner, ride.id, p.site);
    // … mais le règlement suit les termes figés à l'acceptation
    const [x] = await sql(`select * from public.ride_settlements where ride_id = $1`, [ride.id]);
    expect(x).toMatchObject({ direction: "driver_owes", amount_cents: 500, commission_cents: 0, platform_fee_cents: 500, driver_payout_cents: 4500 });
    const e = await rpc(p.partner.userId, "driver_earnings", [7]);
    const r = e.recent.find((y: any) => y.id === ride.id);
    expect(r).toMatchObject({ net_cents: 4500, price_cents: 5000, commission_cents: null, platform_fee_cents: null });
  });

  it("part du chauffeur nulle : course jamais partagée, aucune ligne réseau", async () => {
    const p = await networkPair({ giver: "fleet" });
    await sql(`update public.organizations set platform_fee_fixed_cents = 5000 where id = $1`, [p.A.id]);
    const ride = await createRideAsOwner(p.A, { pickup_lat: p.site[0], pickup_lng: p.site[1], price_cents: 5000 });
    const [t] = await sql(`select private.network_terms(r) as t from public.rides r where id = $1`, [ride.id]);
    expect(t.t).toBeNull();
    await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
    await sql("select private.dispatch_tick()");
    expect(await sql(`select 1 from public.ride_offers where ride_id = $1 and is_network`, [ride.id])).toEqual([]);
  });

  it("notification au chauffeur (ligne chez A, data.network, aucun montant interne), journal de A sans identifiant, diffusions", async () => {
    const p = await networkPair({ giver: "centrale" });
    const { ride, settlement } = await sharedRide(p, { payment_method: "cash" });
    const notes = await sql(
      `select organization_id, driver_org_id, type, title, body, data from public.notifications
        where ride_id = $1 and driver_id = $2 and type like 'settlement%'`,
      [ride.id, p.partner.id],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      organization_id: p.A.id, driver_org_id: p.B.id, type: "settlement_due", title: `À RÉGLER À ${p.aName}`,
      data: { type: "settlement_due", network: true, settlement_id: settlement.id, ride_id: ride.id, amount_cents: 1250 },
    });
    expect(notes[0].body).toContain(`Course #${ride.number} · 12,50 € à régler à ${p.aName} avant `);
    for (const key of ["commission_cents", "platform_fee_cents", "driver_payout_cents"]) expect(notes[0].data).not.toHaveProperty(key);

    const [ev] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'settlement.due'`, [ride.id]);
    expect(ev).toMatchObject({ actor_type: "system", actor_id: null });
    expect(ev.message).toContain(`12,50 € à reverser par le chauffeur partenaire Karim T. · ${p.bName}`);
    expect(ev.data).toMatchObject({ network: true, settlement_id: settlement.id, commission_cents: 750, platform_fee_cents: 500 });
    const text = JSON.stringify(await sql(`select message, data from public.ride_events where ride_id = $1`, [ride.id]));
    expect(text).not.toContain(p.partner.id);
    expect(text).not.toContain("Tazi");

    // A : settlement_json avec son bloc « network » ; le chauffeur : son élément (un montant par sens) ; rien pour B
    const [toA] = await messagesOf(`org:${p.A.id}`, settlement.id);
    expect(toA.payload).toMatchObject({
      action: "created",
      settlement: {
        id: settlement.id, driver_id: null, commission_cents: 750, platform_fee_cents: 500,
        network: { counterparty: "driver", partner_name: p.bName, driver_label: "Karim T.", on_hold: false, driver_disputed: false, payout_configured: null },
      },
    });
    const [toDriver] = await messagesOf(`driver:${p.partner.id}`, settlement.id);
    expect(toDriver.payload).toMatchObject({
      action: "created", network: true,
      item: { id: settlement.id, direction: "driver_owes", amount_cents: 1250, giver_part_cents: 1250, driver_part_cents: 3750, status: "due" },
    });
    expect(toDriver.payload).not.toHaveProperty("settlement");
    expect(JSON.stringify(toDriver.payload)).not.toMatch(/commission|platform_fee/);
    expect(await sql(`select 1 from realtime.messages where topic = $1 and event = 'settlement.updated'`, [`org:${p.B.id}`])).toEqual([]);
  });

  it("A centrale qui clôture une course partagée (client à bord, partenaire sans position) : règlement réseau, versement retenu", async () => {
    const p = await networkPair({ giver: "centrale" });
    const { ride, execution } = await partnerAccepts(p, p.partner, { payment_method: "online" });
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
      await moveTo(p.partner.id, p.site);
      await stepAs(p.partner, ride.id, s);
    }
    await moveTo(p.partner.id, p.site, 35 * 60);
    expect(await rpc(p.A.ownerId, "close_network_ride", [ride.id])).toMatchObject({ ok: true, status: "COMPLETED" });
    const [x] = await sql(`select * from public.ride_settlements where ride_id = $1`, [ride.id]);
    expect(x).toMatchObject({ direction: "centrale_owes", amount_cents: 3750, network_execution_id: execution.id, status: "due" });
    const [e] = await sql(`select hold_until from public.ride_network_executions where id = $1`, [execution.id]);
    const [item] = await sql(`select private.network_settlement_item(x) as i from public.ride_settlements x where id = $1`, [x.id]);
    expect(item.i).toMatchObject({ on_hold: true, can_dispute: false });
    expect(new Date(item.i.hold_until).getTime()).toBe(new Date(e.hold_until).getTime());
    const [ev] = await sql(`select message, data from public.ride_events where ride_id = $1 and type = 'settlement.payout_due'`, [ride.id]);
    expect(ev.message).toContain("course à vérifier : versement retenu jusqu'au ");
    expect(ev.data).toMatchObject({ network: true, on_hold: true });
  });
});

// =============================================================================
// n° 17 — Deux organisations créancières, chacune ses moyens ; règlements propres séparés
// =============================================================================
describe("Règlements partenaires du chauffeur (§10.4, §14.1 n° 17)", () => {
  it("deux blocs (A et C) avec leurs moyens ; « J'ai payé » limité aux moyens de A, une organisation à la fois ; règlements propres séparés", async () => {
    const p = await networkPair({ executor: "centrale" });
    await sql(
      `update public.organization_settings
          set settlement_link = 'https://Pay.Example.com/a?montant={montant}&ref={reference}', settlement_grace_hours = 72
        where organization_id = $1`,
      [p.A.id],
    );
    const C = await giver("Autre donneuse");
    await sql(
      `update public.organization_settings
          set settlement_methods = '{transfer,cash}', settlement_iban = $2, settlement_payee_name = 'Autre SAS',
              settlement_bic = 'BNPAFRPPXXX', settlement_link = null, settlement_instructions = 'Virement sous 48 h'
        where organization_id = $1`,
      [C.id, IBAN_FR],
    );
    const cName = await orgName(C);
    const ownId = await ownLine(p.B, p.partner.id);

    const a1 = await sharedRide(p, { payment_method: "cash" });
    const a2 = await sharedRide(p, { payment_method: "card", price_cents: 6000 });
    const c1 = await sharedRide(p, { payment_method: "cash", price_cents: 4000 }, { A: C });
    const c2 = await sharedRide(p, { payment_method: "online", price_cents: 3000 }, { A: C });

    const net: DriverNetworkSettlements = await rpc(p.partner.userId, "driver_network_settlements");
    expect(net.currency).toBe("EUR");
    expect(net.summary).toEqual({ owed_cents: 500 + 600 + 400, overdue_cents: 0, declared_cents: 0, payout_due_cents: 2700, on_hold_cents: 0 });
    expect(net.organizations.map((o) => o.organization.id)).toEqual([p.A.id, C.id]);
    const [blockA, blockC] = net.organizations;
    expect(blockA).toMatchObject({
      organization: { id: p.A.id, name: p.aName },
      currency: "EUR", grace_hours: 72,
      summary: { owed_cents: 1100, overdue_cents: 0, declared_cents: 0, payout_due_cents: 0, on_hold_cents: 0 },
      pay: {
        amount_cents: 1100, count: 2, settlement_ids: [a1.settlement.id, a2.settlement.id], methods: ["link", "cash"], bank: null,
        link_domain: "pay.example.com", instructions: null,
      },
      blocked: null, blocked_message: null,
    });
    expect(blockA.pay!.reference).toMatch(/^RP-[0-9A-F]{4}-\d{4}$/);
    expect(blockA.pay!.link).toBe(`https://Pay.Example.com/a?montant=11.00&ref=${blockA.pay!.reference}`);
    expect(blockC).toMatchObject({
      organization: { id: C.id, name: cName },
      grace_hours: NETWORK_PARAMS.minDriverGraceHours,
      summary: { owed_cents: 400, payout_due_cents: 2700, on_hold_cents: 0 },
      pay: {
        amount_cents: 400, count: 1, settlement_ids: [c1.settlement.id], reference: `R${c1.ride.number}`, link: null,
        link_domain: null, methods: ["transfer", "cash"], bank: { payee_name: "Autre SAS", iban: IBAN_FR, bic: "BNPAFRPPXXX" },
        instructions: "Virement sous 48 h",
      },
    });
    // Lignes : un montant par sens, jamais commission ni frais Rydar, communes seulement
    const itemC2 = blockC.items.find((i) => i.id === c2.settlement.id)!;
    expect(itemC2).toMatchObject({
      reference: `R${c2.ride.number}`, direction: "centrale_owes", amount_cents: 2700, price_cents: 3000, driver_part_cents: 2700,
      giver_part_cents: 300, payment_method: "online", status: "due", overdue: false, on_hold: false, hold_until: null,
      can_dispute: false, ride: { number: Number(c2.ride.number), pickup: "75008 Paris", dropoff: "—" },
    });
    for (const block of net.organizations) {
      for (const item of block.items) {
        expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
        expect(JSON.stringify(item)).not.toMatch(/commission|platform_fee|Champs/);
      }
    }
    // Le téléphone de l'organisation, tant qu'une ligne est ouverte
    const [phoneA] = await sql(`select phone from public.organizations where id = $1`, [p.A.id]);
    expect(blockA.organization.phone).toBe(phoneA.phone);

    // « J'ai payé » : moyen non proposé par A, lignes de deux organisations, puis lien de A
    const declare = (org: string, ids: string[], method: string, note: string | null = null) =>
      rpc(p.partner.userId, "driver_declare_network_payment", [org, ids, method, note]);
    expect(await declare(p.A.id, [a1.settlement.id], "transfer")).toEqual({
      ok: false, code: "INVALID_METHOD", message: `Moyen de paiement non accepté par ${p.aName}.`,
    });
    const mixed = await expectPgError(declare(p.A.id, [a1.settlement.id, c1.settlement.id], "link"));
    expect([mixed.code, mixed.message]).toEqual(["42501", expect.stringContaining("FORBIDDEN_TENANT")]);
    expect(await declare(C.id, [c1.settlement.id], "link")).toMatchObject({ ok: false, code: "INVALID_METHOD" });
    // Lignes d'une autre organisation que p_org : même refus ; identifiants inconnus ou d'un autre chauffeur : rien à déclarer
    expect((await expectPgError(declare(p.A.id, [c1.settlement.id], "cash"))).code).toBe("42501");
    expect(await declare(p.A.id, [randomUUID()], "cash")).toMatchObject({ ok: false, code: "NOTHING_TO_DECLARE" });
    expect((await sql(`select count(*)::int as n from public.ride_settlements where status <> 'due' and id = any ($1)`, [
      [a1.settlement.id, a2.settlement.id, c1.settlement.id],
    ]))[0].n).toBe(0);

    const ok = await declare(p.A.id, [a1.settlement.id, a2.settlement.id], "link", "  Payé par lien  ");
    expect(ok).toEqual({
      ok: true, code: "DECLARED", count: 2, amount_cents: 1100, settlement_ids: expect.arrayContaining([a1.settlement.id, a2.settlement.id]),
      message: `Paiement signalé : ${p.aName} va le confirmer.`,
    });
    const [declared] = await sql(`select status, declared_method, declared_note from public.ride_settlements where id = $1`, [a1.settlement.id]);
    expect(declared).toEqual({ status: "declared", declared_method: "link", declared_note: "Payé par lien" });
    // Ligne de C intouchée (autre organisation, prépayée)
    expect((await sql(`select status from public.ride_settlements where id = $1`, [c2.settlement.id]))[0].status).toBe("due");
    // Journal de A : libellé court, sans identifiant du chauffeur
    const [ev] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'settlement.declared'`, [a1.ride.id]);
    expect(ev).toMatchObject({ actor_type: "driver", actor_id: null, level: "info" });
    expect(ev.message).toBe(`Le chauffeur partenaire Karim T. · ${p.bName} signale avoir réglé 5 € (lien de paiement)`);
    const [msg] = (await messagesOf(`driver:${p.partner.id}`, a1.settlement.id)).slice(-1);
    expect(msg.payload).toMatchObject({ action: "declared", network: true, item: { status: "declared", declared_method: "link" } });
    // Déjà déclarée : rien à déclarer
    expect(await declare(p.A.id, [a1.settlement.id], "cash")).toMatchObject({ ok: false, code: "NOTHING_TO_DECLARE" });

    // Règlements propres (B centrale) : jamais une ligne réseau, et l'ancienne déclaration ne les touche pas
    const own = await rpc(p.partner.userId, "driver_settlements", [50]);
    expect(own.items.map((i: any) => i.id)).toEqual([ownId]);
    expect(own.summary.owed_cents).toBe(1500);
    expect(own.pay.settlement_ids).toEqual([ownId]);
    expect(await rpc(p.partner.userId, "driver_declare_payment", [[c1.settlement.id], "cash", null])).toMatchObject({
      ok: false, code: "NOTHING_TO_DECLARE",
    });
    // Accueil : règlements propres d'un côté, courses partenaires de l'autre
    const home = await rpc(p.partner.userId, "driver_home");
    expect(home.settlement).toMatchObject({ owed_cents: 1500, open_count: 1 });
    expect(home.network).toMatchObject({ owed_cents: 400, overdue_cents: 0, payout_due_cents: 2700 });
    expect(home.network.creditors).toEqual([
      { id: C.id, name: cName, owed_cents: 400, overdue_cents: 0, blocked: null },
      { id: p.A.id, name: p.aName, owed_cents: 0, overdue_cents: 0, blocked: null },
    ]);
    expect(home.network.readiness).toMatchObject({ ready: true, missing: [], warnings: [] });
  });

  it("blocage et lisibilité : impayé échu envers A (A seulement), plafond de B ; retard et « Pas reçu » dans le bloc de A", async () => {
    const p = await networkPair();
    const C = await giver("Troisième");
    const a1 = await sharedRide(p, { payment_method: "cash" });
    await sharedRide(p, { payment_method: "cash" }, { A: C });
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = $1`, [a1.settlement.id]);

    let home = await rpc(p.partner.userId, "driver_home");
    expect(home.network).toMatchObject({ owed_cents: 1000, overdue_cents: 500 });
    expect(home.network.creditors).toEqual([
      { id: p.A.id, name: p.aName, owed_cents: 500, overdue_cents: 500, blocked: "giver_unpaid" },
      expect.objectContaining({ id: C.id, owed_cents: 500, overdue_cents: 0, blocked: null }),
    ]);
    let net: DriverNetworkSettlements = await rpc(p.partner.userId, "driver_network_settlements");
    const blockA = net.organizations.find((o) => o.organization.id === p.A.id)!;
    expect(blockA).toMatchObject({
      summary: { owed_cents: 500, overdue_cents: 500 }, blocked: "giver_unpaid",
      blocked_message: `Un impayé envers ${p.aName} bloque seulement les courses de ${p.aName} : réglez-le pour en recevoir à nouveau.`,
    });
    expect(blockA.items[0]).toMatchObject({ overdue: true, can_dispute: false });

    // « Pas reçu » de A sur sa ligne : le chauffeur peut contester (« j'ai bien payé »)
    expect(await rpc(p.A.ownerId, "dispute_settlement", [a1.settlement.id, "Rien reçu"])).toMatchObject({ ok: true });
    net = await rpc(p.partner.userId, "driver_network_settlements");
    const item = net.organizations.find((o) => o.organization.id === p.A.id)!.items[0];
    expect(item).toMatchObject({ status: "disputed", can_dispute: true });
    expect(item.disputed_at).not.toBeNull();

    // Plafond de B (toutes donneuses) : lisibilité « blocked:executor_limit »
    await sql(`update public.network_memberships set executor_credit_limit_cents = 900 where organization_id = $1`, [p.B.id]);
    home = await rpc(p.partner.userId, "driver_home");
    expect(home.network.readiness.missing).toEqual(["blocked:executor_limit"]);
    expect(home.network.readiness.ready).toBe(false);
  });

  it("lisibilité du chauffeur : toutes les conditions manquantes, dans l'ordre du contrat ; grâce des conditions", async () => {
    const B = await createOrg(`Lisibilite ${tag()}`);
    const d = await createDriver(B, { firstName: "Lina" });
    const readiness = async () => (await sql(`select private.network_driver_readiness($1) as r`, [d.id]))[0].r;
    expect(await readiness()).toEqual({
      ready: false,
      missing: ["org_reception_off", "driver_off", "terms", "app_update", "vtc_card", "insurance", "vehicle_registration", "driving_license", "vtc_card_number"],
      warnings: [], terms_grace_until: null, excluded_until: null,
    });
    await setSharedNetwork(false);
    expect((await readiness()).missing.slice(0, 2)).toEqual(["network_off", "driver_off"]);
    await setSharedNetwork(true);

    await enableNetwork(B, { in: true });
    await approveNetwork(B);
    const ready = await readyPartner(B, { at: nextSite() });
    const r2 = async () => (await sql(`select private.network_driver_readiness($1) as r`, [ready.id]))[0].r;
    expect(await r2()).toMatchObject({ ready: true, missing: [], warnings: [] });
    // Conditions précédentes encore valables (grâce) : avertissement, pas un manque
    const [ps] = await sql(`select network_terms_version as v from public.platform_settings where id`);
    await sql(
      `update public.platform_settings set network_terms_version = '2099-01-01', network_terms_min_version = $1,
              network_terms_grace_until = now() + interval '10 days' where id`,
      [ps.v],
    );
    try {
      const r = await r2();
      expect(r).toMatchObject({ ready: true, missing: [], warnings: ["terms_grace"] });
      expect(r.terms_grace_until).not.toBeNull();
    } finally {
      await sql(
        `update public.platform_settings set network_terms_version = $1, network_terms_min_version = null, network_terms_grace_until = null where id`,
        [ps.v],
      );
    }
    // Exclusion temporaire, retrait par B, B centrale sans n° d'exploitant
    await sql(`update public.driver_network_settings set excluded_until = now() + interval '3 days', org_allowed = false where driver_id = $1`, [ready.id]);
    const r3 = await r2();
    expect(r3.missing).toEqual(["org_disallowed", "excluded_until"]);
    expect(r3.excluded_until).not.toBeNull();
  });
});

// =============================================================================
// n° 19 (côté chauffeur) — Prépayé : coordonnées de versement, « Versé », « Je conteste »
// =============================================================================
describe("Versements prépayés côté chauffeur (§10.4, §14.1 n° 19)", () => {
  it("RIB : saisie contrôlée et masquée, empreinte figée au règlement, suppression refusée tant qu'un versement est attendu", async () => {
    const p = await networkPair();
    const info = (): Promise<DriverPayoutInfo> => rpc(p.partner.userId, "driver_payout_info");
    const set = (payee: string, iban: string, bic: string | null = null) =>
      rpc(p.partner.userId, "driver_set_payout_details", [payee, iban, bic]);
    expect(await info()).toEqual({ configured: false, payee_name: null, iban_last4: null, bic: null, updated_at: null, in_use: false });

    for (const [payee, iban, bic] of [
      ["Karim Tazi", "FR7630006000011234567890188", null], // clé fausse
      ["Karim Tazi", "FR76", null],
      ["K", IBAN_FR, null], // titulaire trop court
      ["Karim Tazi", IBAN_FR, "BNP"], // BIC invalide
    ] as const) {
      const err = await expectPgError(set(payee, iban, bic));
      expect([err.code, err.message]).toEqual(["22023", expect.stringContaining("PAYOUT_DETAILS_INVALID")]);
    }
    const saved = await set("  Karim   Tazi ", "fr76 3000 6000 0112 3456 7890 189", "bnpa frpp");
    expect(saved).toMatchObject({ configured: true, payee_name: "Karim Tazi", iban_last4: "0189", bic: "BNPAFRPP", in_use: false });
    expect(JSON.stringify(saved)).not.toContain("30006000");
    const [row] = await sql(`select iban, iban_hash, updated_at from public.driver_payout_details where driver_id = $1`, [p.partner.id]);
    expect(row.iban).toBe(IBAN_FR);
    const [audit] = await sql(`select organization_id, actor_type, metadata from public.audit_logs where action = 'driver.payout_details_updated' and entity_id = $1`, [p.partner.id]);
    expect(audit).toMatchObject({ organization_id: p.B.id, actor_type: "driver", metadata: { created: true, iban_changed: false } });
    expect(JSON.stringify(audit)).not.toContain("30006000");
    // Même saisie : rien ne change (pas de fausse alerte « RIB modifié »)
    await set("Karim Tazi", IBAN_FR, "BNPAFRPP");
    const [same] = await sql(`select updated_at from public.driver_payout_details where driver_id = $1`, [p.partner.id]);
    expect(same.updated_at).toEqual(row.updated_at);

    // Course prépayée : empreinte du RIB posée sur l'exécution, versement en cours
    const { settlement, execution } = await sharedRide(p, { payment_method: "online" });
    const [e] = await sql(`select payout_iban_hash, payout_iban_at from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e.payout_iban_hash).toBe(row.iban_hash);
    expect(e.payout_iban_at).not.toBeNull();
    expect(await info()).toMatchObject({ configured: true, in_use: true });
    const [json] = await sql(`select private.settlement_json(x) as j from public.ride_settlements x where id = $1`, [settlement.id]);
    expect(json.j.network).toMatchObject({ payout_configured: true, on_hold: false });
    expect(JSON.stringify(json.j)).not.toContain(row.iban_hash);
    const del = await expectPgError(rpc(p.partner.userId, "driver_delete_payout_details"));
    expect([del.code, del.message]).toEqual(["55000", expect.stringContaining("PAYOUT_DETAILS_IN_USE")]);
    expect(ERROR_MESSAGES.PAYOUT_DETAILS_IN_USE).toBeTruthy();

    // Modification permise : nouvelle empreinte (≠ celle du règlement : alerte « IBAN modifié » chez A), audit « warning »
    expect(await set("Karim Tazi", IBAN_DE)).toMatchObject({ iban_last4: "3000", bic: null, in_use: true });
    const [changed] = await sql(`select iban_hash from public.driver_payout_details where driver_id = $1`, [p.partner.id]);
    expect(changed.iban_hash).not.toBe(e.payout_iban_hash);
    const [warn] = await sql(
      `select severity, metadata from public.audit_logs where action = 'driver.payout_details_updated' and entity_id = $1 order by id desc limit 1`,
      [p.partner.id],
    );
    expect(warn).toMatchObject({ severity: "warning", metadata: { iban_changed: true, payout_in_progress: true } });
    const [e2] = await sql(`select payout_iban_hash from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e2.payout_iban_hash).toBe(e.payout_iban_hash);

    // « Versé » par A : suppression possible ensuite
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "transfer", null])).toMatchObject({ ok: true });
    expect(await rpc(p.partner.userId, "driver_delete_payout_details")).toEqual({
      configured: false, payee_name: null, iban_last4: null, bic: null, updated_at: null, in_use: false,
    });
    expect(await sql(`select 1 from public.driver_payout_details where driver_id = $1`, [p.partner.id])).toEqual([]);
    // Aucune lecture directe des coordonnées ni des lignes réseau côté client
    for (const who of [p.partner.userId, p.B.ownerId, p.A.ownerId]) {
      const err = await expectPgError(as({ sub: who }, (q) => q(`select * from public.driver_payout_details`)));
      expect(err.code).toBe("42501");
    }
    expect(await as({ sub: p.partner.userId }, (q) => q(`select id from public.ride_settlements where id = $1`, [settlement.id]))).toEqual([]);
    expect(await as({ sub: p.B.ownerId }, (q) => q(`select id from public.ride_settlements where id = $1`, [settlement.id]))).toEqual([]);
  });

  it("« Versé » puis « Je conteste » : une fois par ligne, sans changer le statut ; refusé sur une ligne à jour ou d'un autre", async () => {
    const p = await networkPair();
    const other = await readyPartner(p.B, { firstName: "Samir", at: north(p.site, 900) });
    const { settlement, ride, execution } = await sharedRide(p, { payment_method: "online" });
    const dispute = (who: Driver, id: string, reason: string) => rpc(who.userId, "driver_dispute_network_settlement", [id, reason]);

    // Versement pas encore échu : rien à contester
    let err = await expectPgError(dispute(p.partner, settlement.id, "Pas encore reçu"));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_DISPUTE_NOT_ALLOWED")]);
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "transfer", null])).toMatchObject({ ok: true });
    const [paidMsg] = (await messagesOf(`driver:${p.partner.id}`, settlement.id)).slice(-1);
    expect(paidMsg.payload).toMatchObject({ action: "paid", item: { status: "paid", can_dispute: true } });

    err = await expectPgError(dispute(other, settlement.id, "Pas reçu sur mon compte"));
    expect([err.code, err.message]).toEqual(["P0002", expect.stringContaining("NETWORK_DISPUTE_NOT_ALLOWED")]);
    err = await expectPgError(dispute(p.partner, settlement.id, "non"));
    expect([err.code, err.message]).toEqual(["22023", expect.stringContaining("NETWORK_DISPUTE_REASON_INVALID")]);

    const res = await dispute(p.partner, settlement.id, "  Rien reçu sur mon compte  ");
    expect(res.ok).toBe(true);
    const item: DriverNetworkSettlementItem = res.item;
    expect(item).toMatchObject({ status: "paid", driver_dispute_reason: "Rien reçu sur mon compte", can_dispute: false });
    expect(item.driver_disputed_at).not.toBeNull();
    const [x] = await sql(`select status, driver_disputed_at, driver_dispute_reason from public.ride_settlements where id = $1`, [settlement.id]);
    expect(x).toMatchObject({ status: "paid", driver_dispute_reason: "Rien reçu sur mon compte" });
    const [e] = await sql(`select driver_dispute_reason from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e.driver_dispute_reason).toBe("Rien reçu sur mon compte");
    // Visible chez A (settlement_json, journal sans identifiant)
    const [json] = await sql(`select private.settlement_json(x) as j from public.ride_settlements x where id = $1`, [settlement.id]);
    expect(json.j.network).toMatchObject({ driver_disputed: true, driver_dispute_reason: "Rien reçu sur mon compte" });
    const [ev] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'settlement.driver_disputed'`, [ride.id]);
    expect(ev).toMatchObject({ actor_type: "driver", actor_id: null, level: "warning" });
    expect(ev.message).toBe(`Le chauffeur partenaire Karim T. · ${p.bName} conteste (versement non reçu) : Rien reçu sur mon compte`);
    // Une fois par ligne
    err = await expectPgError(dispute(p.partner, settlement.id, "Toujours rien reçu"));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_DISPUTE_NOT_ALLOWED")]);
    // Libellés des codes
    for (const code of ["NETWORK_DISPUTE_NOT_ALLOWED", "NETWORK_DISPUTE_REASON_INVALID", "PAYOUT_DETAILS_INVALID"]) {
      expect(ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });

  it("course « à vérifier » prépayée : versement retenu (à recevoir après vérification), échéance après la retenue", async () => {
    const p = await networkPair();
    const { settlement, execution } = await sharedRide(p, { payment_method: "online" }, { gps: false });
    const [e] = await sql(`select suspect_reasons, hold_until from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e.suspect_reasons).toContain("no_gps");
    expect(e.hold_until).not.toBeNull();
    const [x] = await sql(`select due_at >= $2::timestamptz as after_hold from public.ride_settlements where id = $1`, [settlement.id, e.hold_until]);
    expect(x.after_hold).toBe(true);
    const net: DriverNetworkSettlements = await rpc(p.partner.userId, "driver_network_settlements");
    expect(net.summary).toMatchObject({ payout_due_cents: 0, on_hold_cents: 4500 });
    expect(net.organizations[0]!.items[0]).toMatchObject({ on_hold: true, can_dispute: false });
    const home = await rpc(p.partner.userId, "driver_home");
    expect(home.network).toMatchObject({ owed_cents: 0, payout_due_cents: 0 });
    expect(home.network.creditors).toEqual([{ id: p.A.id, name: p.aName, owed_cents: 0, overdue_cents: 0, blocked: null }]);
    const notes = await sql(`select title, body from public.notifications where driver_id = $1 and type = 'settlement_payout'`, [p.partner.id]);
    expect(notes).toEqual([{ title: `GAIN À RECEVOIR DE ${p.aName}`, body: expect.stringContaining("45 € vous seront versés par") }]);
    expect(notes[0].body).toContain("après vérification de la course");
  });
});

// =============================================================================
// Accueil et gains : net par course aux termes figés
// =============================================================================
describe("Accueil et gains du chauffeur partenaire (§11.2)", () => {
  it("gains : sa part par course partenaire, jamais commission ni frais de A ; accueil d'un chauffeur de centrale", async () => {
    const p = await networkPair({ giver: "centrale", executor: "centrale" });
    await sql(`update public.organization_settings set driver_commission_percent = 20 where organization_id = $1`, [p.B.id]);
    const cash = await sharedRide(p, { payment_method: "cash" });
    const online = await sharedRide(p, { payment_method: "online", price_cents: 8000 });
    // Course propre de B (centrale, 20 %) terminée aujourd'hui
    await insertRideBypass(p.B, { driver_id: p.partner.id, completed_at: new Date(), price_cents: 1000, payment_method: "cash" });

    const e = await rpc(p.partner.userId, "driver_earnings", [7]);
    const rc = e.recent.find((r: any) => r.id === cash.ride.id);
    expect(rc).toMatchObject({
      net_cents: 3750, price_cents: 5000, commission_cents: null, platform_fee_cents: null, network_giver: p.aName,
      settlement_status: "due", settlement_direction: "driver_owes", pickup: "75008 Paris", dropoff: "—",
    });
    const ro = e.recent.find((r: any) => r.id === online.ride.id);
    expect(ro).toMatchObject({ net_cents: 6000, network_giver: p.aName, settlement_direction: "centrale_owes" });
    const own = e.recent.find((r: any) => r.price_cents === 1000);
    expect(own).not.toHaveProperty("network_giver");
    expect(own).toMatchObject({ net_cents: 800, pickup: "Place de l'Opéra", dropoff: "Gare de Lyon" });
    // Période : part du chauffeur (termes figés) + course propre (20 %)
    expect(e.today).toMatchObject({ rides: 3, revenue_cents: 14000, net_cents: 3750 + 6000 + 800 });
    const home = await rpc(p.partner.userId, "driver_home");
    expect(home.today).toMatchObject({ rides: 3, revenue_cents: 14000 });

    // Planifiée acceptée : prochaine course avec sa part figée, à venir
    const ride = await createRideAsOwner(p.A, { pickup_lat: p.site[0], pickup_lng: p.site[1], price_cents: 5000, pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes', next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
    await moveTo(p.partner.id, north(p.site, 800));
    await sql("select private.dispatch_tick()");
    const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [ride.id, p.partner.id]);
    expect(offer).toBeTruthy();
    expect(await as({ sub: p.partner.userId }, async (q) => (await q("select public.accept_ride_offer($1) as r", [offer.id]))[0].r)).toMatchObject({ ok: true });
    const home2 = await rpc(p.partner.userId, "driver_home");
    expect(home2.next_scheduled).toMatchObject({ id: ride.id, driver_payout_cents: 3750 });
    const e2 = await rpc(p.partner.userId, "driver_earnings", [7]);
    expect(e2.upcoming).toEqual({ rides: 1, revenue_cents: 5000, net_cents: 3750 });
  });

  it("interrupteur coupé : sommes en cours toujours réglables ; sans somme ni réseau, accueil inchangé (pas de clé « network »)", async () => {
    const p = await networkPair();
    const { settlement } = await sharedRide(p, { payment_method: "cash" });
    await setSharedNetwork(false);
    const home = await rpc(p.partner.userId, "driver_home");
    expect(home.network).toMatchObject({ owed_cents: 500, payout_due_cents: 0 });
    expect(home.network.readiness.missing[0]).toBe("network_off");
    const net: DriverNetworkSettlements = await rpc(p.partner.userId, "driver_network_settlements");
    expect(net.organizations).toHaveLength(1);
    expect(await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [settlement.id], "cash", null])).toMatchObject({
      ok: true, code: "DECLARED",
    });
    expect(await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null])).toMatchObject({ configured: true });

    // Chauffeur sans aucune somme partenaire, réseau coupé : réponse d'avant
    const lone = await createDriver(p.B, { firstName: "Solo" });
    const plain = await rpc(lone.userId, "driver_home");
    expect(plain).not.toHaveProperty("network");
    const earnings = await rpc(lone.userId, "driver_earnings", [7]);
    expect(earnings.recent).toEqual([]);
    expect(await rpc(lone.userId, "driver_network_settlements")).toEqual({
      currency: "EUR", summary: { owed_cents: 0, overdue_cents: 0, declared_cents: 0, payout_due_cents: 0, on_hold_cents: 0 }, organizations: [],
    });
  });
});

// =============================================================================
// Droits
// =============================================================================
describe("Droits des fonctions de la partie 4a", () => {
  it("RPC chauffeur : chauffeur actif seulement (ni membre d'organisation, ni anonyme) ; aides : serveur seulement", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const calls: Array<[string, unknown[]]> = [
      ["driver_payout_info", []],
      ["driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]],
      ["driver_delete_payout_details", []],
      ["driver_network_settlements", []],
      ["driver_declare_network_payment", [p.A.id, [randomUUID()], "cash", null]],
      ["driver_dispute_network_settlement", [randomUUID(), "Rien reçu du tout"]],
    ];
    for (const [fn, args] of calls) {
      for (const who of [p.A.ownerId, dispatcher, p.B.ownerId]) {
        const err = await expectPgError(rpc(who, fn, args));
        expect(err.code, `${fn} (${who})`).toBe("42501");
      }
      const anon = await expectPgError(as({ role: "anon" }, (q) => q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args)));
      expect(anon.code, `${fn} anon`).toBe("42501");
    }
    const rows = await sql(
      `select n.nspname, p.proname, p.prosecdef as definer, 'search_path=""' = any (p.proconfig) as empty_path,
              has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'public' and p.proname in ('driver_payout_info', 'driver_set_payout_details', 'driver_delete_payout_details',
                 'driver_network_settlements', 'driver_declare_network_payment', 'driver_dispute_network_settlement'))
           or (n.nspname = 'private' and p.proname in ('network_grace_hours', 'network_driver_part', 'iban_ok', 'payout_iban_hash',
                 'network_settlement_disputable', 'network_settlement_item', 'driver_payout_json', 'network_driver_readiness',
                 'driver_home_network', 'sync_network_settlement'))
        order by 1`,
    );
    expect(rows).toHaveLength(16);
    for (const r of rows) {
      const isPublic = r.nspname === "public";
      expect(r, r.proname).toMatchObject({ definer: isPublic, empty_path: true, auth: isPublic, anon: false });
    }
  });
});

/** Clés exactes d'un élément (contrat DriverNetworkSettlementItem). */
const ITEM_KEYS = [
  "amount_cents", "can_dispute", "currency", "declared_at", "declared_method", "direction", "disputed_at", "driver_dispute_reason",
  "driver_disputed_at", "driver_part_cents", "due_at", "giver_part_cents", "hold_until", "id", "on_hold", "overdue",
  "payment_method", "price_cents", "reference", "ride", "ride_id", "settled_at", "settled_method", "status",
].sort();
