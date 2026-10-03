// Réseau partagé, lot 4 — argent (20260924006900_shared_network_money). Partie 4a : règlement réseau à la fin de course
// (termes figés de l'exécution, contrepartie toujours le chauffeur), côté chauffeur (règlements partenaires par
// organisation, « J'ai payé » avec les seuls moyens de A, « Je conteste », coordonnées de versement), accueil et gains
// (net par course aux termes figés). Scénarios §14.1 n° 16, 17 et 19 (côté chauffeur) de la spécification.
// Partie 4b : côté A (« Reçu » / « Versé », « Pas reçu », « Annuler », « Rouvrir », RIB, « Valider », « Contester la
// course », « Relancer »), blocages, relances, frais Rydar, dette et suppression du compte, relevés : n° 18 à 24.
// Réglages du réseau écrits directement (helpers de tests/db/helpers.ts). L'interrupteur est rouvert avant chaque test et
// recoupé à la fin du fichier.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../../packages/shared/src/domain";
import {
  NETWORK_PARAMS, networkTerms, type DriverNetworkSettlementItem, type DriverNetworkSettlements, type DriverPayoutInfo,
} from "../../packages/shared/src/network";
import {
  acceptDriverTerms, approveNetwork, as, CDG, createAuthUser, createDriver, createMember, createOrg, createRideAsOwner, enableNetwork,
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
    // Commission et frais de SON organisation sur sa seule course propre (20 % de 10 €) ; part des organisations
    // partenaires à part, jamais comptée comme « commission » (U4)
    expect(e.today).toMatchObject({ commission_cents: 200, partner_rides: 2, partner_part_cents: 1250 + 2000 });
    expect(e.today.revenue_cents - e.today.commission_cents - e.today.partner_part_cents).toBe(e.today.net_cents);
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
    // Sans course partenaire : périodes sans les clés du réseau (réponse d'avant)
    for (const period of ["today", "week", "month"]) {
      expect(Object.keys(earnings[period]).sort(), period).toEqual([
        "cash_cents", "commission_cents", "distance_m", "duration_s", "from", "net_cents", "revenue_cents", "rides", "unpriced_rides",
      ]);
    }
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

// =============================================================================
// Partie 4b — côté A, blocages, relances, frais Rydar, dette et suppression, exports
// =============================================================================

/** Raison d'inéligibilité du chauffeur pour une course de A (NULL : éligible), private.network_driver_reason. */
async function driverReason(driverId: string, rideId: string): Promise<string | null> {
  const [row] = await sql(
    `select private.network_driver_reason(d, r) as reason from public.drivers d, public.rides r where d.id = $1 and r.id = $2`,
    [driverId, rideId],
  );
  return row.reason;
}

/** Blocage réseau (private.network_blocker) du chauffeur envers une donneuse, montant de la course à venir. */
const blockerOf = async (driverId: string, giverId: string, amount = 0): Promise<string | null> =>
  (await sql(`select private.network_blocker($1, $2, $3) as b`, [driverId, giverId, amount]))[0].b;

/** Notifications d'un chauffeur d'un type donné (lignes chez A pour une course partenaire). */
const notesOf = (driverId: string, type: string) =>
  sql(
    `select organization_id, driver_org_id, ride_id, channel::text as channel, title, body, data from public.notifications
      where driver_id = $1 and type = $2 order by created_at, id`,
    [driverId, type],
  );

/** Course de A au lieu de la paire (dispatch de création ; non proposée au réseau tant que les vagues propres durent). */
const rideOfA = (p: Pair, overrides: Record<string, unknown> = {}, A: Org = p.A) =>
  createRideAsOwner(A, { pickup_lat: p.site[0], pickup_lng: p.site[1], price_cents: 5000, ...overrides });

/** Écriture directe sans déclencheurs (horodatage tenu par un déclencheur, ex. updated_at du RIB). */
async function rawUpdate(text: string, params: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(text, params);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Relances automatiques (verrou du worker : réessai si un autre passage est en cours). */
async function runReminders(): Promise<Record<string, any>> {
  for (let i = 0; i < 20; i++) {
    const [{ r }] = await sql(`select private.settlement_reminders() as r`);
    if (r.ok) return r;
  }
  throw new Error("private.settlement_reminders toujours occupée");
}

async function superAdmin(): Promise<string> {
  const id = await createAuthUser(`sa-${tag()}@test.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}

const svc = async (fn: string, args: unknown[] = []) =>
  as({ role: "service_role" }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0].r);

// =============================================================================
// n° 18 — Blocages (règles locales)
// =============================================================================
describe("Blocages réseau (§10.7, §14.1 n° 18)", () => {
  it("impayé échu envers A : plus de course de A, courses de C et courses propres de B intactes ; dette propre chez B → plus aucune offre réseau", async () => {
    const p = await networkPair({ executor: "centrale" });
    const C = await giver("Troisième");
    const a1 = await sharedRide(p, { payment_method: "cash" });
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = $1`, [a1.settlement.id]);

    // A : plus proposée au partenaire (règle de A), même après les vagues propres
    const nextA = await rideOfA(p);
    expect(await driverReason(p.partner.id, nextA.id)).toBe("giver_unpaid");
    await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [p.partner.id]);
    await moveTo(p.partner.id, north(p.site, 800));
    await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [nextA.id]);
    await sql("select private.dispatch_tick()");
    expect(await sql(`select 1 from public.ride_offers where ride_id = $1 and driver_id = $2`, [nextA.id, p.partner.id])).toEqual([]);
    expect(await blockerOf(p.partner.id, p.A.id)).toBe("giver_unpaid");

    // C : intactes (course de C partagée de bout en bout)
    expect(await blockerOf(p.partner.id, C.id)).toBeNull();
    const c1 = await sharedRide(p, { payment_method: "cash" }, { A: C });
    expect(c1.settlement).toMatchObject({ organization_id: C.id, status: "due" });

    // B (centrale) : une dette réseau ne bloque jamais ses courses propres
    expect((await sql(`select private.driver_blocker($1) as b`, [p.partner.id]))[0].b).toBeNull();
    await moveTo(p.partner.id, north(p.site, 800));
    const own = await createRideAsOwner(p.B, { pickup_lat: p.site[0], pickup_lng: p.site[1], price_cents: 3000 });
    const [ownOffer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [
      own.id, p.partner.id,
    ]);
    expect(ownOffer, "course propre de B proposée").toBeTruthy();
    await as({ sub: p.partner.userId }, (q) => q("select public.decline_ride_offer($1)", [ownOffer.id]));

    // Dette propre chez B (commission échue) : plus aucune offre réseau, quelle que soit la donneuse
    const ownId = await ownLine(p.B, p.partner.id);
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = $1`, [ownId]);
    expect(await blockerOf(p.partner.id, C.id)).toBe("own_unpaid");
    expect(await driverReason(p.partner.id, (await rideOfA(p, {}, C)).id)).toBe("own_unpaid");
  });

  it("plafond de A (encours envers A seulement) ; plafond de B (toutes donneuses confondues)", async () => {
    const p = await networkPair();
    const C = await giver("Troisième");
    await sharedRide(p, { payment_method: "cash" }); // 5 € dus à A, pas encore échus
    await sharedRide(p, { payment_method: "cash" }, { A: C }); // 5 € dus à C
    expect(await blockerOf(p.partner.id, p.A.id, 500)).toBeNull();

    // A plafonne à 9 € : 5 € dus + 5 € de la prochaine course payée à bord > 9 €
    await sql(`update public.organization_settings set settlement_credit_limit_cents = 900 where organization_id = $1`, [p.A.id]);
    expect(await blockerOf(p.partner.id, p.A.id, 500)).toBe("giver_credit_limit");
    expect(await blockerOf(p.partner.id, p.A.id, 0)).toBeNull();
    expect(await blockerOf(p.partner.id, C.id, 500)).toBeNull();
    expect(await driverReason(p.partner.id, (await rideOfA(p, { payment_method: "cash" })).id)).toBe("giver_credit_limit");
    // Prépayée : rien ne sera dû à A
    expect(await driverReason(p.partner.id, (await rideOfA(p, { payment_method: "online" })).id)).toBeNull();
    await sql(`update public.organization_settings set settlement_credit_limit_cents = null where organization_id = $1`, [p.A.id]);

    // B plafonne à 9 € : 10 € dus au réseau, toutes donneuses → bloqué pour A comme pour C
    await sql(`update public.network_memberships set executor_credit_limit_cents = 900 where organization_id = $1`, [p.B.id]);
    expect(await blockerOf(p.partner.id, p.A.id)).toBe("executor_limit");
    expect(await blockerOf(p.partner.id, C.id)).toBe("executor_limit");
    const [msg] = await sql(`select private.network_blocker_message('executor_limit', $1, $2) as m`, [p.aName, p.bName]);
    expect(msg.m).toBe(`Plafond de ${p.bName} atteint : réglez d'abord vos courses partenaires.`);
  });

  it("échéance d'un reversement : au moins 48 h même si A règle tout de suite ; « Rouvrir » : nouvelle échéance, relances remises à zéro, chauffeur prévenu", async () => {
    const p = await networkPair();
    await sql(`update public.organization_settings set settlement_grace_hours = 0 where organization_id = $1`, [p.A.id]);
    const { ride, settlement } = await sharedRide(p, { payment_method: "cash" });
    const hoursTo = async (from: "created_at" | "now()") =>
      Number((await sql(`select extract(epoch from (due_at - ${from})) / 3600 as h from public.ride_settlements where id = $1`, [settlement.id]))[0].h);
    expect(Math.abs((await hoursTo("created_at")) - NETWORK_PARAMS.minDriverGraceHours)).toBeLessThan(0.05);

    // « Reçu », puis « Rouvrir » (erreur de saisie) trois jours plus tard
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "cash", null])).toMatchObject({ ok: true });
    await sql(
      `update public.ride_settlements
          set due_at = now() - interval '3 days', reminders_sent = 2, last_reminded_at = now() - interval '1 day' where id = $1`,
      [settlement.id],
    );
    expect(await rpc(p.A.ownerId, "reopen_settlement", [settlement.id])).toEqual({ ok: true, code: "REOPENED", message: "Règlement rouvert." });
    const [x] = await sql(`select status, reminders_sent, last_reminded_at, settled_at from public.ride_settlements where id = $1`, [settlement.id]);
    expect(x).toEqual({ status: "due", reminders_sent: 0, last_reminded_at: null, settled_at: null });
    expect(Math.abs((await hoursTo("now()")) - NETWORK_PARAMS.minDriverGraceHours)).toBeLessThan(0.05);
    const notes = await notesOf(p.partner.id, "settlement_due");
    expect(notes).toHaveLength(2); // fin de course, puis réouverture
    expect(notes[1]).toMatchObject({
      organization_id: p.A.id, driver_org_id: p.B.id, ride_id: ride.id, title: `À RÉGLER À ${p.aName}`,
      data: { type: "settlement_due", network: true, settlement_id: settlement.id, ride_id: ride.id, amount_cents: 500 },
    });
    expect(notes[1].body).toContain(`Course #${ride.number} · ${p.aName} attend toujours 5 €, à régler avant `);
    const [ev] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'settlement.reopened'`, [ride.id]);
    expect(ev).toMatchObject({ actor_type: "user", actor_id: p.A.ownerId, data: { settlement_id: settlement.id, network: true } });
    expect(ev.message).toContain(`Règlement de 5 € avec le chauffeur partenaire Karim T. · ${p.bName} rouvert — à régler avant `);
    const [msg] = (await messagesOf(`driver:${p.partner.id}`, settlement.id)).slice(-1);
    expect(msg.payload).toMatchObject({ action: "reopened", network: true, item: { status: "due", overdue: false } });

    // Délai de A plus long (72 h) : c'est lui qui compte
    await sql(`update public.organization_settings set settlement_grace_hours = 72 where organization_id = $1`, [p.A.id]);
    await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "cash", null]);
    await rpc(p.A.ownerId, "reopen_settlement", [settlement.id]);
    expect(Math.abs((await hoursTo("now()")) - 72)).toBeLessThan(0.05);
  });

  it("débiteur de A revenu par une autre organisation (nouvelle fiche, mêmes empreintes) : bloqué chez A seulement, selon la règle de A", async () => {
    const p = await networkPair();
    const a1 = await sharedRide(p, { payment_method: "cash" });
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = $1`, [a1.settlement.id]);
    // Il rejoint C (qui reçoit le réseau) avec le même téléphone
    const C = await createOrg(`Executante C ${tag()}`);
    await enableNetwork(C, { in: true });
    await approveNetwork(C);
    const again = await readyPartner(C, { firstName: "Revenu", at: north(p.site, 900) });
    await sql(`update public.drivers set phone = (select phone from public.drivers where id = $2) where id = $1`, [again.id, p.partner.id]);
    const nextA = await rideOfA(p);
    expect(await driverReason(again.id, nextA.id)).toBe("debtor");
    // Une autre donneuse : rien
    const D = await giver("Quatrième");
    expect(await driverReason(again.id, (await rideOfA(p, {}, D)).id)).toBeNull();
    // Règle de A : sans blocage des impayés, rien
    await sql(`update public.organization_settings set block_unpaid = false where organization_id = $1`, [p.A.id]);
    expect(await driverReason(again.id, nextA.id)).toBeNull();
    await sql(`update public.organization_settings set block_unpaid = true where organization_id = $1`, [p.A.id]);
    expect(await driverReason(again.id, nextA.id)).toBe("debtor");
    // Dette réglée : plus rien
    await rpc(p.A.ownerId, "confirm_settlements", [[a1.settlement.id], "cash", null]);
    expect(await driverReason(again.id, nextA.id)).toBeNull();
  });
});

// =============================================================================
// n° 19 (côté A) — Prépayé : RIB, « Annuler » refusé, « Versé »
// =============================================================================
describe("Versements prépayés côté A (§10.5, §14.1 n° 19)", () => {
  it("RIB pour un versement : owner / admin de A seulement, consultation journalisée sans IBAN et notifiée au chauffeur, avertissements", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const admin = await createMember(p.A, "admin");
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, "BNPAFRPPXXX"]);
    await rawUpdate(`update public.driver_payout_details set updated_at = now() - interval '5 days' where driver_id = $1`, [p.partner.id]);
    const { ride, settlement } = await sharedRide(p, { payment_method: "online" });
    const info = (who: string) => rpc(who, "org_network_payout_info", [settlement.id]);

    for (const who of [dispatcher, p.B.ownerId, p.partner.userId]) {
      expect((await expectPgError(info(who))).code, who).toBe("42501");
    }
    expect(await sql(`select 1 from public.audit_logs where action = 'network.payout_info_viewed' and entity_id = $1`, [settlement.id])).toEqual([]);

    const first = await info(p.A.ownerId);
    expect(first).toEqual({
      settlement_id: settlement.id, amount_cents: 4500, currency: "EUR", reference: `R${ride.number}`, payee_name: "Karim Tazi",
      iban: IBAN_FR, bic: "BNPAFRPPXXX", updated_at: expect.any(String), warnings: [],
    });
    const audits = await sql(
      `select organization_id, actor_type, actor_user_id, entity_id, severity, metadata from public.audit_logs
        where action = 'network.payout_info_viewed' and entity_id = $1`,
      [settlement.id],
    );
    expect(audits).toEqual([{
      organization_id: p.A.id, actor_type: "user", actor_user_id: p.A.ownerId, entity_id: settlement.id, severity: "info",
      metadata: { settlement_id: settlement.id },
    }]);
    expect(JSON.stringify(audits)).not.toMatch(/30006000|FR76|Karim/);
    const [note] = await notesOf(p.partner.id, "settlement_payout_info");
    expect(note).toMatchObject({
      organization_id: p.A.id, ride_id: ride.id, title: `RIB CONSULTÉ PAR ${p.aName}`,
      body: `${p.aName} a consulté votre RIB pour vous verser 45 €`,
      data: { type: "settlement_payout_info", network: true, settlement_id: settlement.id, ride_id: ride.id, amount_cents: 4500 },
    });

    // IBAN changé depuis la fin de la course (et il y a moins de 72 h) : les deux avertissements
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_DE, null]);
    const second = await info(admin);
    expect(second).toMatchObject({ iban: IBAN_DE, bic: null, warnings: ["iban_changed", "recent_change"] });
    const [warned] = await sql(
      `select severity from public.audit_logs where action = 'network.payout_info_viewed' and entity_id = $1 order by id desc limit 1`,
      [settlement.id],
    );
    expect(warned.severity).toBe("warning");
    expect(await notesOf(p.partner.id, "settlement_payout_info")).toHaveLength(2);

    // « Versé » : plus de raison de lire le RIB
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "transfer", null])).toMatchObject({ ok: true, paid_out_cents: 4500 });
    expect((await expectPgError(info(p.A.ownerId))).code).toBe("42501");
  });

  it("RIB consulté en boucle : chaque consultation auditée ; chauffeur prévenu une fois par 24 h, et de nouveau après un changement de son RIB", async () => {
    const p = await networkPair();
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]);
    await rawUpdate(`update public.driver_payout_details set updated_at = now() - interval '5 days' where driver_id = $1`, [p.partner.id]);
    const { settlement } = await sharedRide(p, { payment_method: "online" });
    const info = () => rpc(p.A.ownerId, "org_network_payout_info", [settlement.id]);
    const audits = async () =>
      (await sql(`select count(*)::int as n from public.audit_logs where action = 'network.payout_info_viewed' and entity_id = $1`, [settlement.id]))[0].n;
    const notes = async () => (await notesOf(p.partner.id, "settlement_payout_info")).length;

    // Deux consultations simultanées : la seconde attend la première (règlement verrouillé), puis voit sa notification
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const begin = async (c: typeof c1) => {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: p.A.ownerId, role: "authenticated" })]);
      await c.query("set local role authenticated");
    };
    try {
      await begin(c1);
      await begin(c2);
      await c1.query("select public.org_network_payout_info($1)", [settlement.id]);
      const pid = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      let settled = false;
      const second = c2.query("select public.org_network_payout_info($1)", [settlement.id]).finally(() => {
        settled = true;
      });
      second.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting && !settled; i++) {
        const [a] = await sql("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        waiting = a?.wait_event_type === "Lock";
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(true);
      await c1.query("commit");
      await second;
      await c2.query("commit");
    } finally {
      await c1.query("rollback").catch(() => undefined);
      await c2.query("rollback").catch(() => undefined);
      c1.release();
      c2.release();
    }
    expect(await notes()).toBe(1);
    // Puis cinq autres consultations : sept audits, toujours une seule notification
    for (let i = 0; i < 5; i++) await info();
    expect(await audits()).toBe(7);
    expect(await notes()).toBe(1);
    // 24 h plus tard : de nouveau prévenu, une fois
    await rawUpdate(
      `update public.notifications set created_at = now() - interval '25 hours' where driver_id = $1 and type = 'settlement_payout_info'`,
      [p.partner.id],
    );
    await info();
    await info();
    expect(await notes()).toBe(2);
    // RIB changé par le chauffeur : prévenu dès la consultation suivante (avertissements), une fois
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_DE, null]);
    expect(await info()).toMatchObject({ iban: IBAN_DE, warnings: ["iban_changed", "recent_change"] });
    await info();
    expect(await notes()).toBe(3);
    expect(await audits()).toBe(11);
  });

  it("RIB non renseigné : PAYOUT_DETAILS_MISSING ; course à vérifier : ni RIB ni « Versé » (NETWORK_PAYOUT_ON_HOLD) ; reversement : pas de RIB", async () => {
    const p = await networkPair();
    const { settlement } = await sharedRide(p, { payment_method: "online" });
    let err = await expectPgError(rpc(p.A.ownerId, "org_network_payout_info", [settlement.id]));
    expect([err.code, err.message]).toEqual(["P0002", expect.stringContaining("PAYOUT_DETAILS_MISSING")]);
    expect(await sql(`select 1 from public.audit_logs where action = 'network.payout_info_viewed' and entity_id = $1`, [settlement.id])).toEqual([]);

    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]);
    const held = await sharedRide(p, { payment_method: "online" }, { gps: false });
    err = await expectPgError(rpc(p.A.ownerId, "org_network_payout_info", [held.settlement.id]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_PAYOUT_ON_HOLD")]);
    err = await expectPgError(rpc(p.A.ownerId, "confirm_settlements", [[held.settlement.id], "transfer", null]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_PAYOUT_ON_HOLD")]);
    // Lot mêlé (versement libre + versement retenu) : rien n'est confirmé
    await expectPgError(rpc(p.A.ownerId, "confirm_settlements", [[settlement.id, held.settlement.id], "transfer", null]));
    expect((await sql(`select array_agg(status) as s from public.ride_settlements where id = any ($1)`, [[settlement.id, held.settlement.id]]))[0].s)
      .toEqual(["due", "due"]);

    const cash = await sharedRide(p, { payment_method: "cash" });
    expect((await expectPgError(rpc(p.A.ownerId, "org_network_payout_info", [cash.settlement.id]))).code).toBe("42501");
  });

  it("« Annuler » : refusé sur un versement (NETWORK_SETTLEMENT_ACTION_FORBIDDEN), permis sur un reversement avec motif ; « Versé » notifié, puis « Je conteste »", async () => {
    const p = await networkPair();
    const online = await sharedRide(p, { payment_method: "online" });
    let err = await expectPgError(rpc(p.A.ownerId, "waive_settlement", [online.settlement.id, "Geste commercial"]));
    expect([err.code, err.message]).toEqual(["42501", expect.stringContaining("NETWORK_SETTLEMENT_ACTION_FORBIDDEN")]);
    expect((await sql(`select status from public.ride_settlements where id = $1`, [online.settlement.id]))[0].status).toBe("due");

    // « Versé »
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[online.settlement.id], "transfer", "virement du jour"])).toEqual({
      ok: true, code: "CONFIRMED", count: 1, amount_cents: 4500, received_cents: 0, paid_out_cents: 4500, message: "1 règlement confirmé",
    });
    const [sent] = await notesOf(p.partner.id, "settlement_payout_sent");
    expect(sent).toMatchObject({
      organization_id: p.A.id, ride_id: online.ride.id, title: `VERSEMENT DE ${p.aName}`, body: `${p.aName} vous a versé 45 €`,
      data: { type: "settlement_payout_sent", network: true, amount_cents: 4500, settlement_id: online.settlement.id, ride_id: online.ride.id },
    });
    const [paid] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'settlement.paid'`, [online.ride.id]);
    expect(paid).toMatchObject({ actor_type: "user", actor_id: p.A.ownerId, data: { network: true, method: "transfer" } });
    expect(paid.message).toBe(`45 € versés au chauffeur partenaire Karim T. · ${p.bName} (virement)`);
    expect(await rpc(p.partner.userId, "driver_dispute_network_settlement", [online.settlement.id, "Rien reçu sur mon compte"])).toMatchObject({ ok: true });

    // Reversement (payé à bord) : « Annuler » avec motif
    const cash = await sharedRide(p, { payment_method: "cash" });
    expect(await rpc(p.A.ownerId, "waive_settlement", [cash.settlement.id, "x"])).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(await rpc(p.A.ownerId, "waive_settlement", [cash.settlement.id, "Geste commercial"])).toEqual({
      ok: true, code: "WAIVED", message: "Règlement annulé.",
    });
    const [waived] = await notesOf(p.partner.id, "settlement_waived");
    expect(waived).toMatchObject({
      title: `ANNULÉ PAR ${p.aName}`, body: `Course #${cash.ride.number} · ${p.aName} a annulé les 5 € à régler`,
      data: { type: "settlement_waived", network: true, settlement_id: cash.settlement.id, ride_id: cash.ride.id, amount_cents: 500 },
    });
    const [ev] = await sql(`select message, data from public.ride_events where ride_id = $1 and type = 'settlement.waived'`, [cash.ride.id]);
    expect(ev).toEqual({
      message: `Reversement de 5 € du chauffeur partenaire Karim T. · ${p.bName} annulé : Geste commercial`,
      data: { settlement_id: cash.settlement.id, reason: "Geste commercial", network: true },
    });
    for (const n of [sent, waived]) expect(JSON.stringify(n.data)).not.toMatch(/commission|platform_fee|driver_payout/);
  });

  it("« Pas reçu » : owner / admin de A seulement (jamais un dispatcher), chauffeur prévenu, effet limité aux courses de A", async () => {
    const p = await networkPair();
    const C = await giver("Troisième");
    const dispatcher = await createMember(p.A, "dispatcher");
    const { ride, settlement } = await sharedRide(p, { payment_method: "cash" });
    await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [settlement.id], "link", null]);
    for (const [fn, args] of [
      ["dispute_settlement", [settlement.id, "Rien reçu"]],
      ["confirm_settlements", [[settlement.id], "link", null]],
      ["waive_settlement", [settlement.id, "Geste commercial"]],
    ] as const) {
      expect((await expectPgError(rpc(dispatcher, fn, [...args]))).code, fn).toBe("42501");
    }
    expect(await rpc(p.A.ownerId, "dispute_settlement", [settlement.id, "Rien reçu sur le lien"])).toEqual({
      ok: true, code: "DISPUTED", message: "Paiement contesté : le chauffeur est prévenu.",
    });
    const [note] = await notesOf(p.partner.id, "settlement_disputed");
    expect(note).toMatchObject({
      ride_id: ride.id, title: `NON REÇU PAR ${p.aName}`, body: `Course #${ride.number} · 5 € non reçus par ${p.aName} : Rien reçu sur le lien`,
      data: { type: "settlement_disputed", network: true, settlement_id: settlement.id, ride_id: ride.id, amount_cents: 500 },
    });
    const [ev] = await sql(`select message, actor_type, actor_id from public.ride_events where ride_id = $1 and type = 'settlement.disputed'`, [ride.id]);
    expect(ev).toEqual({
      message: `Paiement de 5 € du chauffeur partenaire Karim T. · ${p.bName} contesté : Rien reçu sur le lien`, actor_type: "user",
      actor_id: p.A.ownerId,
    });
    // Bloqué chez A seulement (même avant l'échéance) ; une redéclaration ne débloque pas
    expect(await blockerOf(p.partner.id, p.A.id)).toBe("giver_unpaid");
    expect(await blockerOf(p.partner.id, C.id)).toBeNull();
    await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [settlement.id], "cash", null]);
    expect(await blockerOf(p.partner.id, p.A.id)).toBe("giver_unpaid");
    // Ligne prépayée : rien à contester pour A (inchangé)
    const online = await sharedRide(p, { payment_method: "online" }, { A: C });
    expect(await rpc(C.ownerId, "dispute_settlement", [online.settlement.id, "Rien reçu"])).toMatchObject({ ok: false, code: "NOT_DISPUTABLE" });
  });
});

// =============================================================================
// n° 20 — Course « à vérifier » : retenue, « Valider », « Contester la course »
// =============================================================================
describe("Course « à vérifier » (§10.9, §14.1 n° 20)", () => {
  it("versement retenu 72 h ; « Valider » lève la retenue une fois, chauffeur prévenu ; dispatcher et B refusés", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]);
    const { ride, settlement, execution } = await sharedRide(p, { payment_method: "online" }, { gps: false });
    const [held] = await sql(`select extract(epoch from (hold_until - ended_at)) / 3600 as h from public.ride_network_executions where id = $1`, [execution.id]);
    expect(Math.abs(Number(held.h) - NETWORK_PARAMS.payoutHoldHours)).toBeLessThan(0.05);

    for (const who of [dispatcher, p.B.ownerId, p.partner.userId]) {
      expect((await expectPgError(rpc(who, "validate_network_ride", [ride.id]))).code, who).toBe("42501");
    }
    const before = (await sql(`select count(*)::int as n from realtime.messages where topic = $1 and event = 'network.updated'`, [`org:${p.B.id}`]))[0].n;
    const v = await rpc(p.A.ownerId, "validate_network_ride", [ride.id]);
    expect(v).toMatchObject({
      ok: true, ride_id: ride.id,
      settlement: { id: settlement.id, status: "due", network: { on_hold: false, suspect_reasons: ["no_gps"] } },
    });
    const [e] = await sql(`select validated_at, validated_by, hold_until <= now() as released from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e).toMatchObject({ validated_by: p.A.ownerId, released: true });
    expect(e.validated_at).not.toBeNull();
    // Chauffeur : versement à recevoir (plus retenu), prévenu
    const net: DriverNetworkSettlements = await rpc(p.partner.userId, "driver_network_settlements");
    expect(net.summary).toMatchObject({ payout_due_cents: 4500, on_hold_cents: 0 });
    const payouts = await notesOf(p.partner.id, "settlement_payout");
    expect(payouts.at(-1)).toMatchObject({
      title: `GAIN À RECEVOIR DE ${p.aName}`, body: `Course #${ride.number} · ${p.aName} a validé la course : 45 € vous seront versés`,
      data: { type: "settlement_payout", network: true, settlement_id: settlement.id, ride_id: ride.id, amount_cents: 4500 },
    });
    const [ev] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'ride.network_validated'`, [ride.id]);
    expect(ev).toMatchObject({
      actor_type: "user", actor_id: p.A.ownerId, level: "success",
      data: { network: true, execution_id: execution.id, suspect_reasons: ["no_gps"], released: true },
    });
    expect(ev.message).toBe(`Course partagée vérifiée et validée : versement de 45 € au chauffeur partenaire Karim T. · ${p.bName} libéré`);
    expect(await sql(`select 1 from public.audit_logs where action = 'network.ride_validated' and entity_id = $1`, [ride.id])).toHaveLength(1);
    // B reçoit l'identifiant de l'exécution seulement
    const toB = await sql(`select payload from realtime.messages where topic = $1 and event = 'network.updated' order by id`, [`org:${p.B.id}`]);
    expect(toB.length).toBeGreaterThan(before);
    expect(toB.at(-1)!.payload).toEqual({ execution_id: execution.id });

    // Une seule fois : même réponse, rien de plus
    expect(await rpc(p.A.ownerId, "validate_network_ride", [ride.id])).toMatchObject({ ok: true, settlement: { id: settlement.id } });
    expect(await sql(`select 1 from public.ride_events where ride_id = $1 and type = 'ride.network_validated'`, [ride.id])).toHaveLength(1);
    // Le RIB se lit, « Versé » est permis
    expect(await rpc(p.A.ownerId, "org_network_payout_info", [settlement.id])).toMatchObject({ amount_cents: 4500 });
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "transfer", null])).toMatchObject({ ok: true });
  });

  it("course payée à bord « à vérifier » : « Valider » sans retenue ; course propre ou en cours : RIDE_NOT_FOUND", async () => {
    const p = await networkPair();
    const { ride, execution } = await sharedRide(p, { payment_method: "cash" }, { gps: false });
    expect(await rpc(p.A.ownerId, "validate_network_ride", [ride.id])).toMatchObject({ ok: true, settlement: { direction: "driver_owes" } });
    const [e] = await sql(`select validated_at, hold_until from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e.validated_at).not.toBeNull();
    expect(e.hold_until).toBeNull();
    const [ev] = await sql(`select message, data from public.ride_events where ride_id = $1 and type = 'ride.network_validated'`, [ride.id]);
    expect(ev).toMatchObject({ message: "Course partagée vérifiée et validée", data: { released: false } });
    expect(await notesOf(p.partner.id, "settlement_payout")).toEqual([]);

    const own = await createRideAsOwner(p.A, { pickup_lat: p.site[0], pickup_lng: p.site[1] });
    const { ride: running } = await partnerAccepts(p, p.partner);
    for (const id of [own.id, running.id, randomUUID()]) {
      const err = await expectPgError(rpc(p.A.ownerId, "validate_network_ride", [id]));
      expect([err.code, err.message]).toEqual(["P0002", expect.stringContaining("RIDE_NOT_FOUND")]);
    }
  });

  it("« Contester la course » : versement annulé, baisse des frais Rydar en attente du super admin, chauffeur prévenu ; ni « Valider » ni « Rouvrir » ensuite", async () => {
    const p = await networkPair({ giver: "centrale" });
    const dispatcher = await createMember(p.A, "dispatcher");
    const { ride, settlement, execution } = await sharedRide(p, { payment_method: "online" }, { gps: false });
    expect(await sql(`select amount_cents, status from public.platform_fee_entries where ride_id = $1`, [ride.id])).toEqual([
      { amount_cents: 500, status: "posted" },
    ]);
    expect((await expectPgError(rpc(dispatcher, "contest_network_ride", [ride.id, "Client jamais pris en charge"]))).code).toBe("42501");

    const res = await rpc(p.A.ownerId, "contest_network_ride", [ride.id, "  Client   jamais pris en charge  "]);
    expect(res).toMatchObject({
      ok: true, ride_id: ride.id,
      settlement: { id: settlement.id, status: "waived", note: "Course contestée : Client jamais pris en charge", network: { contested: true } },
      fee_reduction: { entry_id: expect.any(String), amount_cents: 500 },
    });
    const [fee] = await sql(`select * from public.platform_fee_entries where id = $1`, [res.fee_reduction.entry_id]);
    expect(fee).toMatchObject({
      organization_id: p.A.id, ride_id: ride.id, kind: "correction", amount_cents: -500, status: "pending", created_by: p.A.ownerId,
      label: `Contestation course ${ride.number} · réseau partagé : frais 5 € → 0 €`,
      reason: "Course contestée : Client jamais pris en charge — versement de 37,50 € au chauffeur partenaire annulé",
    });
    // Une écriture de la course qui réveille le déclencheur des frais ne remplace jamais la demande (aucun recalcul)
    await sql(`update public.rides set payment_method = payment_method, commission_cents = commission_cents where id = $1`, [ride.id]);
    expect(await sql(`select kind, amount_cents, status from public.platform_fee_entries where ride_id = $1 order by created_at`, [ride.id])).toEqual([
      { kind: "ride", amount_cents: 500, status: "posted" },
      { kind: "correction", amount_cents: -500, status: "pending" },
    ]);
    const [e] = await sql(`select contested_at, contested_by, contested_reason from public.ride_network_executions where id = $1`, [execution.id]);
    expect(e).toMatchObject({ contested_by: p.A.ownerId, contested_reason: "Client jamais pris en charge" });
    const [note] = await notesOf(p.partner.id, "settlement_payout_cancelled");
    expect(note).toMatchObject({
      ride_id: ride.id, title: `VERSEMENT ANNULÉ — ${p.aName}`,
      body: `Course #${ride.number} · ${p.aName} conteste la course (Client jamais pris en charge) : les 37,50 € prévus ne vous seront pas versés`,
      data: { type: "settlement_payout_cancelled", network: true, ride_id: ride.id, settlement_id: settlement.id, amount_cents: 3750 },
    });
    const [ev] = await sql(`select * from public.ride_events where ride_id = $1 and type = 'ride.network_contested'`, [ride.id]);
    expect(ev).toMatchObject({
      actor_type: "user", actor_id: p.A.ownerId, level: "warning",
      data: { network: true, execution_id: execution.id, reason: "Client jamais pris en charge", payout_waived_cents: 3750, fee_reduction_cents: 500 },
    });
    expect(ev.message).toBe(
      `Course partagée contestée : Client jamais pris en charge — versement de 37,50 € au chauffeur partenaire Karim T. · ${p.bName} annulé ; baisse des frais Rydar de 5 € demandée à Rydar`,
    );
    expect(await sql(`select 1 from public.audit_logs where action = 'network.ride_contested' and entity_id = $1`, [ride.id])).toHaveLength(1);
    expect(await sql(`select 1 from realtime.messages where topic = $1 and event = 'platform.updated' and payload ->> 'entry_id' = $2`, [
      `org:${p.A.id}`, res.fee_reduction.entry_id,
    ])).toHaveLength(1);

    // Double envoi : même réponse, rien de plus
    const again = await rpc(p.A.ownerId, "contest_network_ride", [ride.id, "Autre motif bien long"]);
    expect(again.fee_reduction).toEqual(res.fee_reduction);
    expect(await sql(`select 1 from public.platform_fee_entries where ride_id = $1 and kind = 'correction'`, [ride.id])).toHaveLength(1);
    // Ensuite : ni « Valider » ni « Rouvrir » le versement annulé
    let err = await expectPgError(rpc(p.A.ownerId, "validate_network_ride", [ride.id]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_RIDE_CONTESTED")]);
    err = await expectPgError(rpc(p.A.ownerId, "reopen_settlement", [settlement.id]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_RIDE_CONTESTED")]);
    expect(ERROR_MESSAGES.NETWORK_RIDE_CONTESTED).toBeTruthy();
    // Le chauffeur peut répondre « Je conteste »
    expect(await rpc(p.partner.userId, "driver_dispute_network_settlement", [settlement.id, "J'ai bien fait la course"])).toMatchObject({ ok: true });
    // Rydar décide de ses frais : baisse acceptée → plus rien de dû pour cette course
    const sa = await superAdmin();
    expect(await svc("svc_platform_review_entry", [res.fee_reduction.entry_id, sa, true, null])).toMatchObject({ ok: true, code: "APPROVED" });
    expect((await sql(`select sum(amount_cents)::int as s from public.platform_fee_entries where ride_id = $1 and status = 'posted'`, [ride.id]))[0].s).toBe(0);
  });

  it("« Contester la course » : 7 jours au plus après la fin, motif de 5 à 300 caractères ; reversement inchangé ; course propre : RIDE_NOT_FOUND", async () => {
    const p = await networkPair();
    const { ride, settlement, execution } = await sharedRide(p, { payment_method: "cash" });
    let err = await expectPgError(rpc(p.A.ownerId, "contest_network_ride", [ride.id, "non"]));
    expect([err.code, err.message]).toEqual(["22023", expect.stringContaining("NETWORK_DISPUTE_REASON_INVALID")]);
    await sql(`update public.ride_network_executions set ended_at = now() - interval '8 days' where id = $1`, [execution.id]);
    err = await expectPgError(rpc(p.A.ownerId, "contest_network_ride", [ride.id, "Trajet jamais effectué"]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_CONTEST_EXPIRED")]);
    await sql(`update public.ride_network_executions set ended_at = now() - interval '6 days' where id = $1`, [execution.id]);
    const res = await rpc(p.A.ownerId, "contest_network_ride", [ride.id, "Trajet jamais effectué"]);
    expect(res).toMatchObject({ ok: true, settlement: { id: settlement.id, status: "due", network: { contested: true } }, fee_reduction: { amount_cents: 500 } });
    const [note] = await notesOf(p.partner.id, "settlement_contested");
    expect(note).toMatchObject({
      title: `COURSE CONTESTÉE — ${p.aName}`, body: `Course #${ride.number} · ${p.aName} conteste la course : Trajet jamais effectué`,
      data: { type: "settlement_contested", network: true, ride_id: ride.id, settlement_id: settlement.id, amount_cents: 500 },
    });
    // Les frais restent dus tant que Rydar n'a pas décidé ; l'état du règlement éclaire sa décision
    expect((await sql(`select sum(amount_cents)::int as s from public.platform_fee_entries where ride_id = $1 and status = 'posted'`, [ride.id]))[0].s).toBe(500);
    const [fee] = await sql(`select reason from public.platform_fee_entries where id = $1`, [res.fee_reduction.entry_id]);
    expect(fee.reason).toBe("Course contestée : Trajet jamais effectué — reversement de 5 € du chauffeur partenaire encore dû");

    const own = await createRideAsOwner(p.A, { pickup_lat: p.site[0], pickup_lng: p.site[1] });
    err = await expectPgError(rpc(p.A.ownerId, "contest_network_ride", [own.id, "Trajet jamais effectué"]));
    expect([err.code, err.message]).toEqual(["P0002", expect.stringContaining("RIDE_NOT_FOUND")]);
  });

  // A conteste ou valide la course pendant que le chauffeur répond « Je conteste » à un « Pas reçu » : les trois fonctions
  // prennent leurs verrous dans le même ordre (exécution, puis règlement). A est arrêtée juste après son premier verrou
  // (exécution) ; le chauffeur doit alors attendre SANS tenir le règlement, sinon interblocage (40P01).
  for (const fn of ["contest_network_ride", "validate_network_ride"] as const) {
    it(`« Je conteste » du chauffeur pendant « ${fn === "contest_network_ride" ? "Contester" : "Valider"} » : verrous dans le même ordre, jamais d'interblocage`, async () => {
      const p = await networkPair();
      const { ride, settlement, execution } = await sharedRide(p, { payment_method: "cash" }, { gps: false });
      await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [settlement.id], "cash", null]);
      expect(await rpc(p.A.ownerId, "dispute_settlement", [settlement.id, "Rien reçu"])).toMatchObject({ ok: true });

      const cA = await pool.connect();
      const cD = await pool.connect();
      const claims = (sub: string) => JSON.stringify({ sub, role: "authenticated" });
      try {
        await cA.query("begin");
        await cA.query("select 1 from public.ride_network_executions where id = $1 for update", [execution.id]);
        await cA.query("select set_config('request.jwt.claims', $1, true)", [claims(p.A.ownerId)]);
        await cA.query("set local role authenticated");
        await cD.query("begin");
        await cD.query("select set_config('request.jwt.claims', $1, true)", [claims(p.partner.userId)]);
        await cD.query("set local role authenticated");
        const pid = (await cD.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const dispute = cD.query("select public.driver_dispute_network_settlement($1, $2) as r", [settlement.id, "J'ai bien payé en espèces"]);
        dispute.catch(() => undefined);
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          const [a] = await sql("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
          waiting = a?.wait_event_type === "Lock";
          if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting).toBe(true);
        const args = fn === "contest_network_ride" ? [ride.id, "Trajet jamais effectué"] : [ride.id];
        const done = (await cA.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r;
        expect(done).toMatchObject({ ok: true, ride_id: ride.id });
        await cA.query("commit");
        const disputed = (await dispute).rows[0].r;
        await cD.query("commit");
        expect(disputed).toMatchObject({ ok: true, item: { id: settlement.id, status: "disputed", driver_dispute_reason: "J'ai bien payé en espèces" } });
      } finally {
        await cA.query("rollback").catch(() => undefined);
        await cD.query("rollback").catch(() => undefined);
        cA.release();
        cD.release();
      }
      const [e] = await sql(`select driver_dispute_reason, contested_at is not null as contested, validated_at is not null as validated
                               from public.ride_network_executions where id = $1`, [execution.id]);
      expect(e).toEqual({
        driver_dispute_reason: "J'ai bien payé en espèces", contested: fn === "contest_network_ride", validated: fn === "validate_network_ride",
      });
    });
  }
});

// =============================================================================
// n° 21 — « Reçu » d'une ligne réseau (C2) ; droits et organisation suspendue
// =============================================================================
describe("« Reçu » d'une ligne réseau (§10.5, §14.1 n° 21)", () => {
  it("ligne réseau unique : chauffeur prévenu, niveau de confiance de sa fiche de B inchangé ; les courses partenaires ne comptent pas chez B", async () => {
    const p = await networkPair({ executor: "centrale" });
    await sql(`update public.organization_settings set trust_after_rides = 2 where organization_id = $1`, [p.B.id]);
    await sql(`update public.drivers set trust_level = 'new' where id = $1`, [p.partner.id]);
    await insertRideBypass(p.B, { driver_id: p.partner.id, completed_at: new Date(), payment_method: "online" });
    const { ride, settlement } = await sharedRide(p, { payment_method: "cash" });

    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "cash", null])).toEqual({
      ok: true, code: "CONFIRMED", count: 1, amount_cents: 500, received_cents: 500, paid_out_cents: 0, message: "1 règlement confirmé",
    });
    const [note] = await notesOf(p.partner.id, "settlement_paid");
    expect(note).toMatchObject({
      organization_id: p.A.id, driver_org_id: p.B.id, ride_id: ride.id, title: `PAIEMENT REÇU PAR ${p.aName}`,
      body: `${p.aName} a bien reçu 5 € — merci !`,
      data: { type: "settlement_paid", network: true, amount_cents: 500, settlement_id: settlement.id, ride_id: ride.id },
    });
    const [ev] = await sql(`select message from public.ride_events where ride_id = $1 and type = 'settlement.paid'`, [ride.id]);
    expect(ev.message).toBe(`5 € reçus du chauffeur partenaire Karim T. · ${p.bName} (espèces)`);
    const trust = async () => (await sql(`select trust_level from public.drivers where id = $1`, [p.partner.id]))[0].trust_level;
    expect(await trust()).toBe("new");
    // Promotion de B : 1 course propre sur 2 (la course partenaire réglée n'entre pas)
    expect((await sql(`select private.maybe_promote_driver($1) as r`, [p.partner.id]))[0].r).toBe(false);
    await insertRideBypass(p.B, { driver_id: p.partner.id, completed_at: new Date(), payment_method: "online" });
    expect((await sql(`select private.maybe_promote_driver($1) as r`, [p.partner.id]))[0].r).toBe(true);
    expect(await trust()).toBe("trusted");
  });

  it("plusieurs lignes d'un coup (notification sans course) ; dispatcher refusé, lot mêlé compris ; A suspendue : owner / admin pour ses lignes réseau", async () => {
    const p = await networkPair({ giver: "centrale" });
    const dispatcher = await createMember(p.A, "dispatcher");
    const admin = await createMember(p.A, "admin");
    const s1 = await sharedRide(p, { payment_method: "cash" });
    const s2 = await sharedRide(p, { payment_method: "cash" });
    const s3 = await sharedRide(p, { payment_method: "cash" });
    const own = await createDriver(p.A, { firstName: "Interne" });
    const ownId = await ownLine(p.A, own.id);
    const ownId2 = await ownLine(p.A, own.id);

    for (const ids of [[s1.settlement.id], [ownId, s1.settlement.id]]) {
      expect((await expectPgError(rpc(dispatcher, "confirm_settlements", [ids, "cash", null]))).code).toBe("42501");
    }
    expect((await expectPgError(rpc(dispatcher, "dispute_settlement", [s1.settlement.id, "Rien reçu"]))).code).toBe("42501");
    expect((await sql(`select count(*)::int as n from public.ride_settlements where id = any ($1) and status = 'due'`, [[s1.settlement.id, ownId]]))[0].n).toBe(2);
    // Ligne propre seule : inchangé (dispatcher permis)
    expect(await rpc(dispatcher, "confirm_settlements", [[ownId], "cash", null])).toMatchObject({ ok: true, count: 1 });

    // Deux lignes réseau d'un coup : une notification, sans course
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[s1.settlement.id, s2.settlement.id], "cash", null])).toMatchObject({
      ok: true, count: 2, received_cents: 2500,
    });
    const paid = await notesOf(p.partner.id, "settlement_paid");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ ride_id: null, body: `${p.aName} a bien reçu 25 € — merci !`, data: { type: "settlement_paid", network: true, amount_cents: 2500 } });
    expect(paid[0].data).not.toHaveProperty("settlement_id");

    // A suspendue : owner / admin gardent la main sur leurs lignes réseau ; jamais un dispatcher ; jamais une ligne propre
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [p.A.id]);
    try {
      expect((await expectPgError(rpc(dispatcher, "confirm_settlements", [[s3.settlement.id], "cash", null]))).code).toBe("42501");
      expect((await expectPgError(rpc(p.A.ownerId, "confirm_settlements", [[ownId2, s3.settlement.id], "cash", null]))).code).toBe("42501");
      expect(await rpc(admin, "dispute_settlement", [s3.settlement.id, "Rien reçu"])).toMatchObject({ ok: true, code: "DISPUTED" });
      expect(await rpc(p.A.ownerId, "confirm_settlements", [[s3.settlement.id], "cash", null])).toMatchObject({ ok: true, count: 1 });
      expect(await rpc(p.A.ownerId, "reopen_settlement", [s3.settlement.id])).toMatchObject({ ok: true });
      expect(await rpc(p.A.ownerId, "waive_settlement", [s3.settlement.id, "Geste commercial"])).toMatchObject({ ok: true });
    } finally {
      await sql(`update public.organizations set status = 'active' where id = $1`, [p.A.id]);
    }
  });
});

// =============================================================================
// n° 22 — Relances réseau
// =============================================================================
describe("Relances réseau (§10.8, §14.1 n° 22)", () => {
  it("automatiques : application seulement (même si A relance par WhatsApp), 23 h d'écart, 3 au plus ; A suspendue ou chauffeur inactif : aucune", async () => {
    const p = await networkPair();
    await sql(`update public.organization_settings set reminder_channels = '{whatsapp}' where organization_id = $1`, [p.A.id]);
    const { settlement } = await sharedRide(p, { payment_method: "cash" });
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = $1`, [settlement.id]);

    const r1 = await runReminders();
    expect(r1.network).toBeGreaterThanOrEqual(1);
    expect(r1.reminders).toBeGreaterThanOrEqual(r1.network);
    const notes = await notesOf(p.partner.id, "settlement_reminder");
    expect(notes).toEqual([{
      organization_id: p.A.id, driver_org_id: p.B.id, ride_id: null, channel: "push", title: `RAPPEL — À RÉGLER À ${p.aName}`,
      body: `Rappel : 5 € à régler à ${p.aName} (1 course partenaire)`,
      data: { type: "settlement_reminder", network: true, amount_cents: 500, count: 1 },
    }]);
    expect(await sql(`select 1 from public.notifications where driver_id = $1 and channel = 'whatsapp'`, [p.partner.id])).toEqual([]);
    const sent = async () => (await sql(`select reminders_sent from public.ride_settlements where id = $1`, [settlement.id]))[0].reminders_sent;
    expect(await sent()).toBe(1);
    await runReminders();
    expect(await notesOf(p.partner.id, "settlement_reminder")).toHaveLength(1);
    // 23 h plus tard, deux fois encore ; jamais une quatrième
    for (let i = 0; i < 3; i++) {
      await sql(`update public.ride_settlements set last_reminded_at = now() - interval '24 hours' where id = $1`, [settlement.id]);
      await runReminders();
    }
    expect(await notesOf(p.partner.id, "settlement_reminder")).toHaveLength(NETWORK_PARAMS.autoRemindersMax);
    expect(await sent()).toBe(3);

    // A suspendue / chauffeur inactif : aucune relance
    const q = await networkPair();
    const s2 = await sharedRide(q, { payment_method: "cash" });
    const q2 = await networkPair();
    const s3 = await sharedRide(q2, { payment_method: "cash" });
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = any ($1)`, [[s2.settlement.id, s3.settlement.id]]);
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [q.A.id]);
    await sql(`update public.drivers set status = 'inactive' where id = $1`, [q2.partner.id]);
    try {
      await runReminders();
      expect(await notesOf(q.partner.id, "settlement_reminder")).toEqual([]);
      expect(await notesOf(q2.partner.id, "settlement_reminder")).toEqual([]);
    } finally {
      await sql(`update public.organizations set status = 'active' where id = $1`, [q.A.id]);
    }
  });

  it("manuelle (« Relancer ») : tout membre de A, application seulement, une par 30 min, seulement envers son organisation", async () => {
    const p = await networkPair();
    const C = await giver("Troisième");
    const dispatcher = await createMember(p.A, "dispatcher");
    const a1 = await sharedRide(p, { payment_method: "cash" });
    const a2 = await sharedRide(p, { payment_method: "cash" });
    const c1 = await sharedRide(p, { payment_method: "cash" }, { A: C });
    const remind = (who: string, org: string, id: string) => rpc(who, "remind_network_driver", [org, id]);

    expect(await remind(dispatcher, p.A.id, a1.settlement.id)).toEqual({
      ok: true, code: "REMINDED", amount_cents: 1000, count: 2, channels: ["app"], message: "Rappel envoyé au chauffeur (application).",
    });
    const notes = await notesOf(p.partner.id, "settlement_reminder");
    expect(notes).toEqual([expect.objectContaining({
      organization_id: p.A.id, ride_id: null, channel: "push", title: `RAPPEL — À RÉGLER À ${p.aName}`,
      body: `Rappel : 10 € à régler à ${p.aName} (2 courses partenaires)`,
      data: { type: "settlement_reminder", network: true, amount_cents: 1000, count: 2 },
    })]);
    const [ev] = await sql(
      `select * from public.ride_events where organization_id = $1 and type = 'settlement.reminded' order by id desc limit 1`,
      [p.A.id],
    );
    expect(ev).toMatchObject({ ride_id: null, actor_type: "user", actor_id: dispatcher, data: { network: true, amount_cents: 1000, count: 2, channels: ["app"] } });
    expect(ev.message).toBe(`Rappel envoyé par l'application au chauffeur partenaire Karim T. · ${p.bName} : 10 € à régler (2 courses)`);
    expect(JSON.stringify(ev)).not.toContain(p.partner.id);
    expect((await sql(`select reminders_sent from public.ride_settlements where id = $1`, [c1.settlement.id]))[0].reminders_sent).toBe(0);

    // Une par 30 min (toutes les lignes du chauffeur envers A)
    const tooSoon = await remind(p.A.ownerId, p.A.id, a2.settlement.id);
    expect(tooSoon).toMatchObject({ ok: false, code: "TOO_SOON", message: "Rappel déjà envoyé il y a moins de 30 minutes." });
    expect(new Date(tooSoon.next_allowed_at).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    // Seulement envers son organisation : ligne de C demandée par A, ligne de A demandée par C → rien ; non-membre → refusé
    expect(await remind(p.A.ownerId, p.A.id, c1.settlement.id)).toMatchObject({ ok: false, code: "NOTHING_DUE" });
    expect(await remind(C.ownerId, C.id, a1.settlement.id)).toMatchObject({ ok: false, code: "NOTHING_DUE" });
    for (const who of [C.ownerId, p.B.ownerId, p.partner.userId]) {
      expect((await expectPgError(remind(who, p.A.id, a1.settlement.id))).code, who).toBe("42501");
    }
    // Signalé payé : plus rien à relancer
    await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [a1.settlement.id, a2.settlement.id], "link", null]);
    await sql(`update public.ride_settlements set last_reminded_at = now() - interval '31 minutes' where id = any ($1)`, [[a1.settlement.id, a2.settlement.id]]);
    expect(await remind(p.A.ownerId, p.A.id, a1.settlement.id)).toMatchObject({ ok: false, code: "NOTHING_DUE" });
  });
});

// =============================================================================
// n° 23 — Frais Rydar d'une course partagée
// =============================================================================
describe("Frais Rydar d'une course partagée (§10.9, §14.1 n° 23)", () => {
  it("flotte : écriture chez A au taux figé à l'acceptation, « réseau partagé », rien chez B, aucun recalcul, due même règlement contesté", async () => {
    const p = await networkPair();
    await sql(`update public.organizations set platform_fee_percent = 20 where id = $1`, [p.A.id]);
    const { ride, execution } = await partnerAccepts(p, p.partner, { payment_method: "cash" });
    expect(execution.terms).toMatchObject({ platform_fee_cents: 1000, amount_cents: 1000 });
    // A baisse ses frais pendant la course : les termes acceptés comptent
    await sql(`update public.organizations set platform_fee_percent = 10 where id = $1`, [p.A.id]);
    await finish(p.partner, ride.id, p.site);
    const entries = () => sql(`select organization_id, kind, amount_cents, status, label from public.platform_fee_entries where ride_id = $1`, [ride.id]);
    expect(await entries()).toEqual([
      { organization_id: p.A.id, kind: "ride", amount_cents: 1000, status: "posted", label: `Course ${ride.number} · réseau partagé` },
    ]);
    expect(await sql(`select 1 from public.platform_fee_entries where organization_id = $1`, [p.B.id])).toEqual([]);
    expect(await sql(`select 1 from private.fleet_fee_basis where ride_id = $1`, [ride.id])).toEqual([]);
    // Aucun recalcul (déclencheur des frais réveillé)
    await sql(`update public.rides set commission_cents = commission_cents, payment_method = payment_method where id = $1`, [ride.id]);
    expect(await entries()).toHaveLength(1);
    // « Pas reçu » : les frais de A restent dus
    const [x] = await sql(`select id from public.ride_settlements where ride_id = $1`, [ride.id]);
    await rpc(p.A.ownerId, "dispute_settlement", [x.id, "Rien reçu"]);
    expect(await entries()).toEqual([expect.objectContaining({ amount_cents: 1000, status: "posted" })]);
    // Compte de A : course payée à bord, chez le chauffeur tant que la ligne réseau est ouverte
    const [account] = await sql(`select private.platform_account($1) as a`, [p.A.id]);
    expect(account.a).toMatchObject({ with_drivers_cents: 1000, collected_by_centrale_cents: 0 });
    await rpc(p.A.ownerId, "confirm_settlements", [[x.id], "cash", null]);
    const [after] = await sql(`select private.platform_account($1) as a`, [p.A.id]);
    expect(after.a).toMatchObject({ with_drivers_cents: 0, collected_by_centrale_cents: 1000 });
  });

  it("A passée en centrale pendant la course (répartition vivante recalculée à 20 %) : frais des termes figés", async () => {
    const p = await networkPair();
    const { ride, execution } = await partnerAccepts(p, p.partner, { payment_method: "online" });
    expect(execution.terms).toMatchObject({ platform_fee_cents: 500, commission_cents: 0 });
    await sql(`update public.organization_settings set driver_commission_percent = 15 where organization_id = $1`, [p.A.id]);
    await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_percent = 20 where id = $1`, [p.A.id]);
    const [live] = await sql(`select platform_fee_cents from public.rides where id = $1`, [ride.id]);
    expect(live.platform_fee_cents).toBe(1000);
    await finish(p.partner, ride.id, p.site);
    expect(await sql(`select amount_cents, label from public.platform_fee_entries where ride_id = $1`, [ride.id])).toEqual([
      { amount_cents: 500, label: `Course ${ride.number} · réseau partagé` },
    ]);
    expect(await sql(`select amount_cents, platform_fee_cents from public.ride_settlements where ride_id = $1`, [ride.id])).toEqual([
      { amount_cents: 4500, platform_fee_cents: 500 },
    ]);
  });

  it("contestation : la baisse demandée n'est jamais acceptée d'office (ménage après 30 jours), Rydar décide ; état du règlement dans le motif", async () => {
    const p = await networkPair({ giver: "centrale" });
    const { ride, settlement } = await sharedRide(p, { payment_method: "cash" });
    // Le chauffeur reverse la part de A (12,50 €, dont 5 € de frais Rydar) ; A confirme « Reçu », puis conteste
    expect(await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [settlement.id], "cash", null])).toMatchObject({ ok: true });
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "cash", null])).toMatchObject({ ok: true, received_cents: 1250 });
    const res = await rpc(p.A.ownerId, "contest_network_ride", [ride.id, "Client mécontent du trajet"]);
    expect(res).toMatchObject({ ok: true, settlement: { status: "paid" }, fee_reduction: { amount_cents: 500 } });
    const entryId: string = res.fee_reduction.entry_id;
    const [fee] = await sql(`select status, reason from public.platform_fee_entries where id = $1`, [entryId]);
    expect(fee).toEqual({ status: "pending", reason: "Course contestée : Client mécontent du trajet — reversement de 12,50 € du chauffeur partenaire reçu" });

    // Baisse ordinaire de A (prix corrigé après une course propre), elle aussi en attente depuis 31 jours
    const own = await insertRideBypass(p.A, { completed_at: new Date(Date.now() - 40 * 86_400_000) });
    const [ordinary] = await sql(
      `insert into public.platform_fee_entries (organization_id, ride_id, kind, amount_cents, status, label, reason, occurred_at, due_at, created_at)
       values ($1, $2, 'correction', -100, 'pending', 'Correction course test', 'Prix modifié après la course', now() - interval '31 days', now(),
               now() - interval '31 days')
       returning id`,
      [p.A.id, own],
    );
    await rawUpdate(`update public.platform_fee_entries set created_at = now() - interval '31 days' where id = $1`, [entryId]);
    const [{ r }] = await sql(`select private.housekeeping() as r`);
    expect(r.errors?.platform_reductions).toBeUndefined();
    const entry = async (id: string) => (await sql(`select status, reviewed_at from public.platform_fee_entries where id = $1`, [id]))[0];
    // La baisse ordinaire est acceptée d'office (CGV art. 5) ; celle de la contestation attend la décision de Rydar
    expect(await entry(ordinary.id)).toMatchObject({ status: "posted" });
    expect(await entry(entryId)).toEqual({ status: "pending", reviewed_at: null });
    const posted = async () =>
      (await sql(`select sum(amount_cents)::int as s from public.platform_fee_entries where ride_id = $1 and status = 'posted'`, [ride.id]))[0].s;
    expect(await posted()).toBe(500);

    // Montrée à part au super admin (/admin/frais) : contestation d'une course partagée, jamais acceptée d'office
    const json = async (id: string) =>
      (await sql(`select private.platform_entry_json(e) as j from public.platform_fee_entries e where id = $1`, [id]))[0].j;
    expect((await json(entryId)).network_contest).toEqual({ contested_at: expect.any(String) });
    expect(await json(ordinary.id)).not.toHaveProperty("network_contest");
    const sa = await superAdmin();
    const overview = await rpc(sa, "admin_platform_overview");
    expect(overview.pending_reductions.find((e: any) => e.id === entryId)).toMatchObject({ network_contest: { contested_at: expect.any(String) } });

    // Décision explicite : refus motivé → frais dus
    expect(await svc("svc_platform_review_entry", [entryId, sa, false, "Reversement reçu par la centrale"])).toMatchObject({ ok: true, code: "REJECTED" });
    expect(await posted()).toBe(500);
  });
});

// =============================================================================
// n° 24 — Encaissements et garde de changement de modèle
// =============================================================================
describe("Encaissements et changement de modèle (§10.5, §14.1 n° 24)", () => {
  it("Encaissements sans ligne réseau ; retour en flotte permis avec des lignes réseau ouvertes, refusé avec des lignes propres", async () => {
    const p = await networkPair({ giver: "centrale" });
    const { settlement } = await sharedRide(p, { payment_method: "cash" });
    const still = await sharedRide(p, { payment_method: "cash" });
    const overview = await rpc(p.A.ownerId, "org_settlement_overview", [p.A.id]);
    expect(overview.totals).toMatchObject({ to_collect_cents: 0, open_count: 0, declared_count: 0, to_pay_cents: 0 });
    expect(overview.month).toMatchObject({ rides: 0, volume_cents: 0 });
    expect(overview.drivers).toEqual([]);
    for (const filter of ["open", "all", "overdue"]) {
      expect((await rpc(p.A.ownerId, "org_settlements", [p.A.id, filter, null, 100, null])).items, filter).toEqual([]);
    }

    // Retour en flotte : les lignes réseau ne le bloquent pas — déclencheur ET action du super admin
    // (svc_platform_set_fees, seul chemin du produit, même garde)
    const sa = await superAdmin();
    const toFleet = () => svc("svc_platform_set_fees", [p.A.id, sa, null, null, "fleet", "consent", null, "Demande écrite (test)"]);
    expect(await toFleet()).toMatchObject({ ok: true });
    expect((await sql(`select dispatch_model from public.organizations where id = $1`, [p.A.id]))[0].dispatch_model).toBe("fleet");
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [p.A.id]);
    await sql(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [p.A.id]);
    // … elles se règlent toujours (onglet « Réseau partagé »)
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[settlement.id], "cash", null])).toMatchObject({ ok: true });
    // Ligne propre ouverte : refus inchangé, la ligne réseau encore ouverte n'est pas comptée
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [p.A.id]);
    const own = await createDriver(p.A, { firstName: "Interne" });
    const ownId = await ownLine(p.A, own.id);
    expect((await sql(`select status from public.ride_settlements where id = $1`, [still.settlement.id]))[0].status).toBe("due");
    const err = await expectPgError(sql(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [p.A.id]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("SETTLEMENTS_OPEN: 1 règlement(s)")]);
    expect(await toFleet()).toMatchObject({ ok: false, code: "SETTLEMENTS_OPEN", count: 1, field: "dispatchModel" });
    // Ligne propre : comptée dans Encaissements comme avant
    expect((await rpc(p.A.ownerId, "org_settlement_overview", [p.A.id])).totals).toMatchObject({ open_count: 1, to_collect_cents: 1500 });
    expect((await rpc(p.A.ownerId, "org_settlements", [p.A.id, "open", null, 100, null])).items.map((i: any) => i.id)).toEqual([ownId]);
  });
});

// =============================================================================
// Dette et suppression de compte (§10.10)
// =============================================================================
describe("Dette réseau et suppression du compte (§10.10, S2)", () => {
  it("dette rappelée avant la suppression ; empreintes gardées pour chaque créancière ; débiteur bloqué chez elle sous une nouvelle fiche ; purge une fois réglée", async () => {
    const p = await networkPair();
    const C = await giver("Troisième");
    const cName = await orgName(C);
    const a1 = await sharedRide(p, { payment_method: "cash" });
    const a2 = await sharedRide(p, { payment_method: "cash" });
    await sharedRide(p, { payment_method: "cash" }, { A: C });
    await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [a2.settlement.id], "link", null]);

    const expected = {
      owed_cents: 0, declared_cents: 0, currency: "EUR", organization: p.bName,
      network: [
        { organization: p.aName, owed_cents: 500, declared_cents: 500 },
        { organization: cName, owed_cents: 500, declared_cents: 0 },
      ].sort((x, y) => x.organization.localeCompare(y.organization)),
    };
    expect(await rpc(p.partner.userId, "driver_deletion_debt")).toEqual(expected);
    expect(await svc("svc_driver_deletion_debt", [p.partner.userId])).toEqual(expected);
    // Sans dette réseau : réponse d'avant (pas de clé « network »)
    const lone = await createDriver(p.B, { firstName: "Solo" });
    expect(await rpc(lone.userId, "driver_deletion_debt")).toEqual({ owed_cents: 0, declared_cents: 0, currency: "EUR", organization: p.bName });

    const [{ phone }] = await sql(`select phone from public.drivers where id = $1`, [p.partner.id]);
    expect(await svc("svc_delete_driver_account", [p.partner.userId])).toMatchObject({ ok: true, code: "DELETED" });
    const kept = await sql(`select creditor_org_id, kind from private.network_debtor_identities where driver_id = $1`, [p.partner.id]);
    expect(new Set(kept.map((k) => k.creditor_org_id))).toEqual(new Set([p.A.id, C.id]));
    expect(new Set(kept.map((k) => k.kind))).toEqual(new Set(["phone", "email", "vtc_card"]));
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'driver.deleted' and entity_id = $1`, [p.partner.id]);
    expect(audit.metadata.network_debtor_identities).toBe(kept.length);

    // Il revient par une autre organisation avec le même téléphone : bloqué chez A (et chez C), pas ailleurs
    const E = await createOrg(`Executante E ${tag()}`);
    await enableNetwork(E, { in: true });
    await approveNetwork(E);
    const again = await readyPartner(E, { firstName: "Revenu", at: north(p.site, 900) });
    await sql(`update public.drivers set phone = $2 where id = $1`, [again.id, phone]);
    const nextA = await rideOfA(p);
    expect(await driverReason(again.id, nextA.id)).toBe("debtor");
    expect(await driverReason(again.id, (await rideOfA(p, {}, await giver("Autre"))).id)).toBeNull();

    // A encaisse : plus rien chez A (aucune notification à une fiche supprimée), purge par le ménage ; C garde les siennes
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[a1.settlement.id, a2.settlement.id], "cash", null])).toMatchObject({ ok: true, count: 2 });
    expect(await notesOf(p.partner.id, "settlement_paid")).toEqual([]);
    expect(await driverReason(again.id, nextA.id)).toBeNull();
    const [{ r }] = await sql(`select private.housekeeping() as r`);
    expect(r.debtor_identities_purged).toBeGreaterThanOrEqual(1);
    const left = await sql(`select distinct creditor_org_id from private.network_debtor_identities where driver_id = $1`, [p.partner.id]);
    expect(left.map((k) => k.creditor_org_id)).toEqual([C.id]);
  });
});

// =============================================================================
// Relevés (§10.11), réseau fermé, droits de la partie 4b
// =============================================================================
describe("Relevés, réseau fermé et droits (partie 4b)", () => {
  it("mois d'une course partagée (relevés, exports) : fin de la course dans le fuseau de A, le même chez A et chez B", async () => {
    const p = await networkPair();
    await sql(`update public.organizations set timezone = 'Pacific/Auckland' where id = $1`, [p.A.id]);
    const { execution } = await sharedRide(p, { payment_method: "cash" });
    await sql(`update public.ride_network_executions set ended_at = '2026-10-31T13:00:00Z' where id = $1`, [execution.id]);
    const month = async () => (await sql(`select private.network_month(e) as m from public.ride_network_executions e where id = $1`, [execution.id]))[0].m;
    expect(await month()).toBe("2026-11"); // 1er novembre à Auckland, encore octobre à Paris (B)
    await sql(`update public.organizations set timezone = 'Europe/Paris' where id = $1`, [p.A.id]);
    expect(await month()).toBe("2026-10");
  });

  it("réseau fermé par Rydar : les décisions d'argent de A restent possibles (NETWORK_CLOSED_RPCS)", async () => {
    const p = await networkPair();
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]);
    const held = await sharedRide(p, { payment_method: "online" }, { gps: false });
    const cash = await sharedRide(p, { payment_method: "cash" });
    await setSharedNetwork(false);
    expect(await rpc(p.A.ownerId, "validate_network_ride", [held.ride.id])).toMatchObject({ ok: true });
    expect(await rpc(p.A.ownerId, "org_network_payout_info", [held.settlement.id])).toMatchObject({ iban: IBAN_FR });
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[held.settlement.id], "transfer", null])).toMatchObject({ ok: true });
    expect(await rpc(p.A.ownerId, "remind_network_driver", [p.A.id, cash.settlement.id])).toMatchObject({ ok: true, code: "REMINDED" });
    expect(await rpc(p.A.ownerId, "contest_network_ride", [cash.ride.id, "Trajet non conforme"])).toMatchObject({ ok: true });
    expect(await rpc(p.A.ownerId, "dispute_settlement", [cash.settlement.id, "Rien reçu"])).toMatchObject({ ok: true });
  });

  it("A suspendue ou archivée : owner / admin gardent RIB, « Valider », « Versé » et « Contester » ; « Relancer » : organisation active", async () => {
    const p = await networkPair();
    const admin = await createMember(p.A, "admin");
    const dispatcher = await createMember(p.A, "dispatcher");
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]);
    const held = await sharedRide(p, { payment_method: "online" }, { gps: false });
    const cash = await sharedRide(p, { payment_method: "cash" });
    try {
      await sql(`update public.organizations set status = 'suspended' where id = $1`, [p.A.id]);
      for (const [fn, args] of [
        ["org_network_payout_info", [held.settlement.id]],
        ["validate_network_ride", [held.ride.id]],
        ["contest_network_ride", [cash.ride.id, "Trajet non conforme"]],
        ["remind_network_driver", [p.A.id, cash.settlement.id]],
      ] as Array<[string, unknown[]]>) {
        expect((await expectPgError(rpc(dispatcher, fn, args))).code, `${fn} dispatcher`).toBe("42501");
      }
      expect(await rpc(admin, "validate_network_ride", [held.ride.id])).toMatchObject({ ok: true, ride_id: held.ride.id });
      expect(await rpc(p.A.ownerId, "org_network_payout_info", [held.settlement.id])).toMatchObject({
        iban: IBAN_FR, amount_cents: held.settlement.amount_cents,
      });
      const remind = await expectPgError(rpc(p.A.ownerId, "remind_network_driver", [p.A.id, cash.settlement.id]));
      expect(remind.code).toBe("42501");
      expect(remind.message).toMatch(/^FORBIDDEN_TENANT/);

      await sql(`update public.organizations set status = 'archived' where id = $1`, [p.A.id]);
      expect(await rpc(admin, "confirm_settlements", [[held.settlement.id], "transfer", null])).toMatchObject({ ok: true, count: 1 });
      expect(await rpc(p.A.ownerId, "contest_network_ride", [cash.ride.id, "Trajet non conforme"])).toMatchObject({
        ok: true, ride_id: cash.ride.id,
      });
      expect((await expectPgError(rpc(p.A.ownerId, "remind_network_driver", [p.A.id, cash.settlement.id]))).code).toBe("42501");
      expect(await sql(`select status from public.ride_settlements where id = any ($1) order by status`, [[held.settlement.id, cash.settlement.id]]))
        .toEqual([{ status: "due" }, { status: "paid" }]);
      expect((await sql(`select last_reminded_at from public.ride_settlements where id = $1`, [cash.settlement.id]))[0].last_reminded_at).toBeNull();
    } finally {
      await sql(`update public.organizations set status = 'active' where id = $1`, [p.A.id]);
    }
  });

  it("RPC de A : jamais anonymes, contrôle dans la fonction ; aides : serveur seulement", async () => {
    const calls: Array<[string, unknown[]]> = [
      ["org_network_payout_info", [randomUUID()]],
      ["validate_network_ride", [randomUUID()]],
      ["contest_network_ride", [randomUUID(), "Trajet non conforme"]],
      ["remind_network_driver", [randomUUID(), randomUUID()]],
    ];
    for (const [fn, args] of calls) {
      const anon = await expectPgError(as({ role: "anon" }, (q) => q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args)));
      expect(anon.code, `${fn} anon`).toBe("42501");
    }
    const rows = await sql(
      `select n.nspname, p.proname, p.prosecdef as definer, 'search_path=""' = any (p.proconfig) as empty_path,
              has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'public' and p.proname in ('org_network_payout_info', 'validate_network_ride', 'contest_network_ride',
                 'remind_network_driver'))
           or (n.nspname = 'private' and p.proname in ('network_notify', 'network_month'))`,
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      const isPublic = r.nspname === "public";
      expect(r, r.proname).toMatchObject({ definer: isPublic, empty_path: true, auth: isPublic, anon: false });
    }
  });
});
