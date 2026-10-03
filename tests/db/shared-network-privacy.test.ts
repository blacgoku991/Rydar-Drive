// Réseau partagé, lot 5 — accès et confidentialité (20260924007000_shared_network_access). Partie 5a : RPC du chauffeur
// partenaire (offres, course, planning, état réseau), de l'organisation qui confie la course (A : indicateurs, courses
// confiées, fiche course, exclusions) et de l'organisation du chauffeur (B : courses reçues, activité, chauffeurs) —
// matrice de visibilité §11.1 ; scénarios §14.1 n° 1 à 3 de la spécification, et confidentialité des lots 3 et 4.
// Partie 5b : journaux et alertes (§11.5), positions (§11.6, Q5), temps réel par topic (§13, §14.1 n° 32, balayage
// n° 31 des lignes lisibles par A), notifications (montants internes), webhooks et API (§11.7).
// Réglages du réseau écrits directement (helpers de tests/db/helpers.ts). L'interrupteur est rouvert avant chaque test et
// recoupé à la fin du fichier.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  DriverNetworkState, DriverOfferV2, DriverRide, NetworkDriverExclusion, NetworkExecutionSummary, NetworkGivenItem,
  NetworkReceivedItem, OrgNetworkActivity, OrgNetworkDriver, OrgNetworkGiven, OrgNetworkReceived, OrgNetworkRide,
  OrgNetworkSummary,
} from "../../packages/shared/src/network";
import {
  acceptDriverTerms, approveNetwork, as, CDG, createAuthUser, createDriver, createMember, createOrg, createRideAsOwner,
  enableNetwork, expectPgError, inMinutes, networkTermsVersion, north, pingApp, pool, setSharedNetwork, sql, type Driver,
  type Org,
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
const uniquePhone = () => `+3363${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/**
 * Lieu propre à chaque paire (≈ 39 km d'écart, plus que le rayon réseau maximal), loin des lieux des autres fichiers
 * (dispatch : latitudes 42,5 et au-delà ; argent : 20 et au-delà) : les partenaires des autres tests, restés
 * disponibles, ne sont jamais à proximité.
 */
let sites = 0;
const nextSite = (): [number, number] => [-10 - ++sites * 0.35, 2.35];

const PICKUP = "12 Avenue des Champs-Élysées, 75008 Paris";
const DROPOFF = "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France";
const COMMENT = "Code porte 4321B, demander M. Dupont au 3e étage";
const CLIENT = { name: "Client Confidentiel", phone: "+33698765432" };

/** Clés exactes des réponses (contrats de @rydar/shared) */
const DRIVER_RIDE_KEYS = [
  "id", "number", "type", "status", "pickup_address", "pickup_lat", "pickup_lng", "dropoff_address", "dropoff_lat",
  "dropoff_lng", "pickup_at", "created_at", "accepted_at", "completed_at", "cancelled_at", "cancel_reason", "passengers",
  "luggage", "vehicle_category", "estimated_distance_m", "estimated_duration_s", "route_polyline", "flight_number",
  "comment", "customer_name", "customer_phone", "customer_visible_from", "customer_visible_until", "price_cents",
  "currency", "payment_method", "flight_mode", "flight_status", "flight_scheduled_arrival", "flight_estimated_arrival",
  "flight_actual_arrival", "flight_terminal", "flight_origin", "flight_delay_minutes", "pickup_at_original", "money",
  "network", "voucher",
] as const satisfies ReadonlyArray<keyof DriverRide>;
const OFFER_V2_KEYS = [
  "offer_id", "ride_id", "number", "mode", "status", "ride_type", "pickup_address", "pickup_lat", "pickup_lng",
  "dropoff_address", "dropoff_lat", "dropoff_lng", "pickup_at", "price_cents", "currency", "payment_method", "passengers",
  "luggage", "vehicle_category", "distance_m", "estimated_distance_m", "estimated_duration_s", "route_polyline",
  "flight_number", "comment", "sent_at", "expires_at", "flight_mode", "flight_status", "flight_scheduled_arrival",
  "flight_estimated_arrival", "flight_actual_arrival", "flight_delay_minutes", "flight_terminal", "flight_origin",
  "pickup_at_original", "dispatch_model", "commission_cents", "platform_fee_cents", "driver_payout_cents",
  "driver_collects", "blocked", "blocked_message", "network",
] as const satisfies ReadonlyArray<keyof DriverOfferV2>;
const EXECUTION_KEYS = [
  "id", "accepted_at", "ended_at", "end_reason", "driver_label", "partner", "vehicle", "terms", "counterparty",
  "suspect_reasons", "on_hold", "hold_until", "contested_at", "contested_reason", "driver_disputed_at",
  "driver_dispute_reason", "validated_at", "driver_excluded",
] as const satisfies ReadonlyArray<keyof NetworkExecutionSummary>;
const RECEIVED_KEYS = [
  "execution_id", "reference", "accepted_at", "ended_at", "end_reason", "ride", "driver", "vehicle", "giver", "money",
  "settlement", "to_check", "contested",
] as const satisfies ReadonlyArray<keyof NetworkReceivedItem>;
const STATE_KEYS = [
  "enabled", "org_allowed", "accepted_version", "accepted_at", "terms", "mode", "organization", "capable_at",
  "excluded_until", "readiness", "payout",
] as const satisfies ReadonlyArray<keyof DriverNetworkState>;

const sorted = (keys: readonly string[]) => [...keys].sort();

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

/** A (donneuse, 10 % de frais Rydar ; centrale : 15 % de commission) partage, B (flotte par défaut) reçoit ; validées. */
async function networkPair(opts: { giver?: Model; executor?: Model } = {}): Promise<Pair> {
  const A = await createOrg(`Donneuse ${tag()}`);
  if (opts.giver === "centrale") {
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [A.id]);
    await sql(`update public.organization_settings set driver_commission_percent = 15 where organization_id = $1`, [A.id]);
  }
  await sql(`update public.organizations set phone = '+33140000001' where id = $1`, [A.id]);
  await enableNetwork(A, { out: true });
  await approveNetwork(A);
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

/** Course de A au lieu de la paire : adresse et commentaire de test, client confidentiel. */
async function rideOf(p: Pair, overrides: Record<string, unknown> = {}, A: Org = p.A) {
  return createRideAsOwner(A, {
    pickup_address: PICKUP, pickup_lat: p.site[0], pickup_lng: p.site[1], dropoff_address: DROPOFF, comment: COMMENT,
    customer_name: CLIENT.name, customer_phone: CLIENT.phone, price_cents: 5000, ...overrides,
  });
}

/** Course immédiate amenée à la fin de ses vagues propres, puis un passage du dispatch (étape réseau). */
async function toNetworkStage(rideId: string) {
  await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [rideId]);
  await sql("select private.dispatch_tick()");
}

async function pendingOffer(rideId: string, driverId: string) {
  const [o] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [
    rideId, driverId,
  ]);
  return o as { id: string } | undefined;
}

/** Course immédiate de A proposée au réseau : offre en attente pour le partenaire. */
async function partnerOffer(p: Pair, overrides: Record<string, unknown> = {}, partner: Driver = p.partner, A: Org = p.A) {
  await moveTo(partner.id, north(p.site, 800));
  await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [partner.id]);
  const ride = await rideOf(p, overrides, A);
  await toNetworkStage(ride.id);
  const offer = await pendingOffer(ride.id, partner.id);
  expect(offer, "offre réseau envoyée").toBeTruthy();
  return { ride, offer: offer! };
}

/** Course de A acceptée par le partenaire (étape réseau réelle + accept_ride_offer). */
async function partnerAccepts(p: Pair, overrides: Record<string, unknown> = {}, partner: Driver = p.partner, A: Org = p.A) {
  const { ride, offer } = await partnerOffer(p, overrides, partner, A);
  const res = await rpc(partner.userId, "accept_ride_offer", [offer.id]);
  expect(res).toMatchObject({ ok: true, code: "ACCEPTED" });
  const [execution] = await sql(`select * from public.ride_network_executions where ride_id = $1 and ended_at is null`, [ride.id]);
  return { ride, execution };
}

/** Planifiée de A dans sa fenêtre réseau, acceptée par le partenaire. */
async function scheduledPartnerAccepts(p: Pair, minutes = 100, overrides: Record<string, unknown> = {}) {
  const ride = await rideOf(p, { pickup_at: inMinutes(minutes), ...overrides });
  await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
  await sql(`update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
  await sql("select private.dispatch_tick()");
  const offer = await pendingOffer(ride.id, p.partner.id);
  expect(offer, "offre réseau planifiée").toBeTruthy();
  expect(await rpc(p.partner.userId, "accept_ride_offer", [offer!.id])).toMatchObject({ ok: true, code: "ACCEPTED" });
  const [execution] = await sql(`select * from public.ride_network_executions where ride_id = $1 and ended_at is null`, [ride.id]);
  return { ride, execution };
}

async function stepAs(driver: Driver, rideId: string, status: string) {
  return rpc(driver.userId, "driver_update_ride_status", [rideId, status]);
}

/** Course menée jusqu'au bout par le chauffeur (positions fraîches : aucune raison « à vérifier », sauf gps: false). */
async function finish(driver: Driver, rideId: string, site: [number, number], opts: { gps?: boolean } = {}) {
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
    await moveTo(driver.id, site);
    expect(await stepAs(driver, rideId, s), s).toMatchObject({ ok: true });
  }
  await moveTo(driver.id, CDG, opts.gps === false ? 600 : 0);
  expect(await stepAs(driver, rideId, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
}

/** Course partagée faite de bout en bout ; renvoie la course, l'exécution et la ligne réseau. */
async function sharedRide(p: Pair, overrides: Record<string, unknown> = {}, opts: { gps?: boolean } = {}) {
  const { ride, execution } = await partnerAccepts(p, overrides);
  await finish(p.partner, ride.id, p.site, opts);
  const [settlement] = await sql(`select * from public.ride_settlements where ride_id = $1`, [ride.id]);
  return { ride, execution, settlement };
}

/** Appel d'une RPC publique sous le rôle authenticated de l'utilisateur. */
const rpc = async (who: string, fn: string, args: unknown[] = []) =>
  as({ sub: who }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0].r);

const offersV2 = async (d: Driver) => (await rpc(d.userId, "driver_offers_v2")) as DriverOfferV2[];
const driverRide = async (d: Driver, rideId: string) => (await rpc(d.userId, "driver_ride", [rideId])) as DriverRide;
const reads = async (executionId: string) =>
  (await sql(`select client_data_reads as n, client_data_first_read_at as f, client_data_last_read_at as l
                from public.ride_network_executions where id = $1`, [executionId]))[0];

/** Écriture sans déclencheurs (horloge simulée : heures de prise en charge et de fin), données de test seulement. */
async function rewind(statements: Array<[string, unknown[]]>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    for (const [text, params] of statements) await client.query(text, params);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Texte d'une réponse : aucune donnée de A qui ne doit jamais sortir (client, adresse exacte, commentaire). */
function expectNoClientData(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [CLIENT.name, CLIENT.phone, "Champs-Élysées", "Terminal 2E", "4321B", "Dupont"]) {
    expect(text, secret).not.toContain(secret);
  }
}

// =============================================================================
// n° 1 — Chauffeur partenaire : offre, course, planning, état réseau
// =============================================================================
describe("Chauffeur partenaire (§11.2, §14.1 n° 1)", () => {
  it("offre partenaire (driver_offers_v2) : « Course de {A} », communes, ~300 m, UN montant, ni adresse, ni tracé, ni commentaire, ni client", async () => {
    const p = await networkPair();
    // Départ hors de la grille de 0,003° (le lieu du test, lui, tombe dessus)
    const { ride, offer } = await partnerOffer(p, {
      flight_number: "AF1234", luggage: 2, pickup_lat: p.site[0] + 0.00123, pickup_lng: p.site[1] + 0.00077,
    });
    await sql(`update public.rides set route_polyline = 'abc_polyline_secret' where id = $1`, [ride.id]);

    const offers = await offersV2(p.partner);
    expect(offers).toHaveLength(1);
    const o = offers[0]!;
    expect(sorted(Object.keys(o))).toEqual(sorted(OFFER_V2_KEYS));
    expect(o).toMatchObject({
      offer_id: offer.id, ride_id: ride.id, number: Number(ride.number), ride_type: "instant", status: "pending",
      pickup_address: "75008 Paris", dropoff_address: "Roissy-en-France", price_cents: 5000, payment_method: "card",
      luggage: 2, route_polyline: null, flight_number: null, comment: null, dispatch_model: null, commission_cents: null,
      platform_fee_cents: null, driver_payout_cents: 4500, driver_collects: true, blocked: null, blocked_message: null,
    });
    // Coordonnées arrondies à 0,003° (~300 m), jamais le point exact
    const [r] = await sql(`select pickup_lat, pickup_lng, dropoff_lat, dropoff_lng from public.rides where id = $1`, [ride.id]);
    for (const [k, exact] of [["pickup_lat", r.pickup_lat], ["pickup_lng", r.pickup_lng], ["dropoff_lat", r.dropoff_lat]] as const) {
      const v = (o as any)[k] as number;
      expect(Math.abs(v - exact), k).toBeLessThanOrEqual(0.0015 + 1e-9);
      expect(Math.abs(Math.round(v / 0.003) * 0.003 - v), k).toBeLessThan(1e-9);
      expect(v, k).not.toBe(exact);
    }
    expect(o.distance_m! % 100).toBe(0);
    // UN montant (part du chauffeur + part de A), jamais commission ni frais Rydar
    expect(o.network).toEqual({
      giver: { name: p.aName, legal_name: `${p.aName} SAS`, vtc_registration: "EVTC075230001" },
      pickup_area: "75008 Paris",
      dropoff_area: "Roissy-en-France",
      money: {
        price_cents: 5000, currency: "EUR", payment_method: "card", collects: true, driver_part_cents: 4500,
        giver_part_cents: 500, direction: "driver_owes", amount_cents: 500, counterparty: "driver",
      },
    });
    expectNoClientData(o);
    expect(JSON.stringify(o)).not.toContain("AF1234");
    expect(JSON.stringify(o)).not.toContain("abc_polyline_secret");
    expect(JSON.stringify(o)).not.toMatch(/commission_cents":\d|platform_fee_cents":\d/);

    // Ancienne lecture (driver_offers) : jamais d'offre réseau ; réseau coupé : plus d'offre partenaire dans v2
    expect(await rpc(p.partner.userId, "driver_offers")).toEqual([]);
    await setSharedNetwork(false);
    expect(await offersV2(p.partner)).toEqual([]);
  });

  it("offres propres : driver_offers() à l'identique (même ordre) + « network »: null ; blocage réseau avec son message", async () => {
    const p = await networkPair();
    // Offre partenaire de A, puis offre propre de B au même chauffeur (première vague de B, à la création)
    const { ride } = await partnerOffer(p);
    const own = await createRideAsOwner(p.B, { pickup_lat: p.site[0], pickup_lng: p.site[1], pickup_address: "1 rue de B, 75011 Paris" });
    expect(await pendingOffer(own.id, p.partner.id), "offre propre de B").toBeTruthy();
    // Blocage réseau : plafond de A (règle locale) → raison et message aux noms de A et de B
    await sql(`update public.organization_settings set settlement_credit_limit_cents = 100 where organization_id = $1`, [p.A.id]);
    const offers = await offersV2(p.partner);
    const ownNow = (await rpc(p.partner.userId, "driver_offers")) as Array<Record<string, unknown>>;
    expect(ownNow.map((o) => o.ride_id)).toEqual([own.id]);
    expect(ownNow[0]).toMatchObject({ pickup_address: "1 rue de B, 75011 Paris", comment: null });
    expect(offers.filter((o) => o.network === null)).toEqual(ownNow.map((o) => ({ ...o, network: null })));
    const partnerOne = offers.find((o) => o.ride_id === ride.id)!;
    expect(offers.indexOf(partnerOne)).toBe(offers.length - 1); // offres propres d'abord
    expect(partnerOne.blocked).toBe("giver_credit_limit");
    expect(partnerOne.blocked_message).toBe(`Plafond de ${p.aName} atteint : réglez vos courses de ${p.aName} pour en recevoir d'autres.`);
  });

  it("course partenaire (driver_ride) : liste blanche exacte, client dès l'acceptation (immédiate), lectures comptées ; select direct → 0 ligne", async () => {
    const p = await networkPair();
    const { ride, execution } = await partnerAccepts(p, { flight_number: "AF1234" });

    // §14.1 n° 1 : la course de A n'est jamais lisible directement par le partenaire (RLS), ni son journal, ses alertes,
    // son historique de statuts ; ses offres seulement, sans leurs termes (commission et frais de A)
    for (const [table, col] of [["rides", "id"], ["ride_events", "ride_id"], ["ride_status_history", "ride_id"], ["ride_alerts", "ride_id"]] as const) {
      const rows = await as({ sub: p.partner.userId }, (q) => q(`select 1 from public.${table} where ${col} = $1`, [ride.id]));
      expect(rows, table).toEqual([]);
    }
    expect(await as({ sub: p.partner.userId }, (q) => q(`select driver_id from public.ride_offers where ride_id = $1`, [ride.id])))
      .toEqual([{ driver_id: p.partner.id }]);
    expect((await expectPgError(as({ sub: p.partner.userId }, (q) => q(`select network_terms from public.ride_offers where ride_id = $1`, [ride.id])))).code)
      .toBe("42501");

    expect(await reads(execution.id)).toMatchObject({ n: 0, f: null, l: null });
    const v = await driverRide(p.partner, ride.id);
    expect(sorted(Object.keys(v))).toEqual(sorted(DRIVER_RIDE_KEYS));
    expect(v).toMatchObject({
      id: ride.id, number: Number(ride.number), type: "instant", status: "ACCEPTED", pickup_address: PICKUP, dropoff_address: DROPOFF,
      comment: COMMENT, flight_number: "AF1234", customer_name: CLIENT.name, customer_phone: CLIENT.phone, cancel_reason: null,
      customer_visible_until: null, price_cents: 5000, payment_method: "card",
      money: {
        price_cents: 5000, currency: "EUR", payment_method: "card", collects: true, driver_part_cents: 4500, giver_part_cents: 500,
        direction: "driver_owes", amount_cents: 500, counterparty: "driver", creditor_name: p.aName,
      },
      network: {
        execution_id: execution.id,
        giver: { name: p.aName, legal_name: `${p.aName} SAS`, vtc_registration: "EVTC075230001", phone: "+33140000001", phone_until: null },
      },
      voucher: {
        booked_by: { name: p.aName, legal_name: `${p.aName} SAS`, vtc_registration: "EVTC075230001", phone: "+33140000001" },
        operator: { kind: "organization", name: `${p.bName} SAS`, vtc_registration: "EVTC075230001" },
        pickup_address: PICKUP, customer: { name: CLIENT.name, phone: CLIENT.phone }, receipt_by: p.aName,
      },
    });
    // Immédiate : client visible dès l'acceptation
    expect(new Date(v.customer_visible_from!).getTime()).toBe(new Date(execution.accepted_at).getTime());
    // Jamais la répartition interne de A ni ses données internes (e-mail du client, référence, clé API, créateur)
    for (const k of ["commission_cents", "platform_fee_cents", "driver_payout_cents", "customer_email", "external_reference", "api_key_id", "created_by", "organization_id", "driver_id"]) {
      expect(v, k).not.toHaveProperty(k);
    }
    // Chaque réponse qui contient le client est comptée pour A
    await driverRide(p.partner, ride.id);
    const counted = await reads(execution.id);
    expect(counted.n).toBe(2);
    expect(counted.f.getTime()).toBeLessThanOrEqual(counted.l.getTime());

    // Course qu'il ne tient pas : RIDE_NOT_FOUND (autre course de A, puis cette course après « Retirer »)
    const other = await rideOf(p);
    expect((await expectPgError(driverRide(p.partner, other.id))).message).toMatch(/^RIDE_NOT_FOUND/);
    const removed = await rpc(p.A.ownerId, "reassign_ride", [ride.id, "Client injoignable", p.partner.id]);
    expect(removed).toMatchObject({ ok: true, network: true });
    expect((await expectPgError(driverRide(p.partner, ride.id))).message).toMatch(/^RIDE_NOT_FOUND/);
    // Un membre d'organisation sans fiche chauffeur : refusé
    expect((await expectPgError(driverRide({ ...p.partner, userId: p.B.ownerId }, ride.id))).code).toBe("42501");
  });

  it("planifiée : client masqué avant prise en charge − 60 min (aucune lecture comptée), visible ensuite ; bon de réservation sans client", async () => {
    const p = await networkPair();
    const { ride, execution } = await scheduledPartnerAccepts(p, 100);
    const before = await driverRide(p.partner, ride.id);
    expect(before).toMatchObject({ customer_name: null, customer_phone: null, pickup_address: PICKUP, comment: COMMENT });
    expect(before.voucher.customer).toBeNull();
    const [{ pickup_at: pickupAt }] = await sql(`select pickup_at from public.rides where id = $1`, [ride.id]);
    expect(new Date(before.customer_visible_from!).getTime()).toBe(new Date(pickupAt).getTime() - 60 * 60_000);
    expect((await reads(execution.id)).n).toBe(0);

    // Prise en charge dans 30 min : dans la fenêtre
    await rewind([[`update public.rides set pickup_at = now() + interval '30 minutes' where id = $1`, [ride.id]]]);
    const inside = await driverRide(p.partner, ride.id);
    expect(inside).toMatchObject({ customer_name: CLIENT.name, customer_phone: CLIENT.phone });
    expect(inside.voucher.customer).toEqual({ name: CLIENT.name, phone: CLIENT.phone });
    expect((await reads(execution.id)).n).toBe(1);

    // Planning (driver_rides_upcoming) : jamais le client d'une course partenaire, aucune lecture comptée
    const upcoming = (await rpc(p.partner.userId, "driver_rides_upcoming")) as DriverRide[];
    const mine = upcoming.find((x) => x.id === ride.id)!;
    expect(sorted(Object.keys(mine))).toEqual(sorted(DRIVER_RIDE_KEYS));
    expect(mine).toMatchObject({ customer_name: null, customer_phone: null, network: { execution_id: execution.id } });
    expect(mine.voucher.customer).toBeNull();
    expect((await reads(execution.id)).n).toBe(1);
  });

  it("fin + 1 h : client masqué, adresses ramenées aux communes, coordonnées arrondies, ni tracé ni commentaire ; repli C3 (fiche suspendue, client à bord)", async () => {
    const p = await networkPair();
    const { ride, execution } = await partnerAccepts(p, { flight_number: "AF1234" });
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
      await moveTo(p.partner.id, p.site);
      expect(await stepAs(p.partner, ride.id, s), s).toMatchObject({ ok: true });
    }
    // Fiche suspendue par B, client à bord (C3) : il lit toujours sa course pour la terminer
    await sql(`update public.drivers set status = 'suspended' where id = $1`, [p.partner.id]);
    expect(await driverRide(p.partner, ride.id)).toMatchObject({ status: "PASSENGER_ONBOARD", customer_name: CLIENT.name });
    expect(await stepAs(p.partner, ride.id, "IN_PROGRESS")).toMatchObject({ ok: true });
    await moveTo(p.partner.id, CDG);
    expect(await stepAs(p.partner, ride.id, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
    // Juste après la fin : encore lisible (fin + 1 h), puis plus pour la fiche suspendue après 1 h
    const done = await driverRide(p.partner, ride.id);
    expect(done).toMatchObject({ status: "COMPLETED", customer_name: CLIENT.name, pickup_address: PICKUP });
    expect(done.customer_visible_until).not.toBeNull();
    await sql(`update public.drivers set status = 'active' where id = $1`, [p.partner.id]);

    await rewind([
      [`update public.ride_network_executions set ended_at = ended_at - interval '2 hours' where id = $1`, [execution.id]],
      [`update public.rides set completed_at = completed_at - interval '2 hours' where id = $1`, [ride.id]],
    ]);
    const n = (await reads(execution.id)).n;
    const later = await driverRide(p.partner, ride.id);
    expect(later).toMatchObject({
      customer_name: null, customer_phone: null, pickup_address: "75008 Paris", dropoff_address: "Roissy-en-France",
      route_polyline: null, comment: null, flight_number: null,
    });
    expect(later.voucher).toMatchObject({ customer: null, pickup_address: "75008 Paris" });
    expect(Math.abs(Math.round(later.pickup_lat / 0.003) * 0.003 - later.pickup_lat)).toBeLessThan(1e-9);
    expectNoClientData(later);
    expect((await reads(execution.id)).n).toBe(n);
    // Montants : termes figés, A toujours joignable tant que le règlement est ouvert
    expect(later.money).toMatchObject({ driver_part_cents: 4500, giver_part_cents: 500, direction: "driver_owes" });
    expect(later.network!.giver.phone).toBe("+33140000001");
  });

  it("course propre (interrupteur coupé) : mêmes valeurs que la ligne rides, argent de la centrale, bon de réservation ; planning comme avant", async () => {
    await setSharedNetwork(false);
    const C = await createOrg(`Centrale ${tag()}`);
    await sql(`update public.organizations set dispatch_model = 'centrale', legal_name = 'Centrale SAS', vtc_registration = 'EVTC0751' where id = $1`, [C.id]);
    await sql(`update public.organization_settings set driver_commission_percent = 20 where organization_id = $1`, [C.id]);
    const site = nextSite();
    const d = await createDriver(C, { firstName: "Lina", at: site });
    const ride = await createRideAsOwner(C, { pickup_lat: site[0], pickup_lng: site[1], price_cents: 4000, payment_method: "cash" });
    expect(await rpc(C.ownerId, "assign_ride", [ride.id, d.id])).toMatchObject({ ok: true });
    // La ligne que lisait l'app (RLS) : mêmes valeurs, champ par champ (dates au même instant, n° bigint)
    const [row] = await as({ sub: d.userId }, (q) => q(`select * from public.rides where id = $1`, [ride.id]));
    const v = await driverRide(d, ride.id);
    expect(sorted(Object.keys(v))).toEqual(sorted(DRIVER_RIDE_KEYS));
    const same = (got: unknown, expected: unknown) =>
      expected instanceof Date ? new Date(got as string).getTime() === expected.getTime()
        : typeof expected === "string" && typeof got === "number" ? String(got) === expected
          : JSON.stringify(got) === JSON.stringify(expected);
    for (const k of DRIVER_RIDE_KEYS.filter((x) => !["money", "network", "voucher", "customer_visible_from", "customer_visible_until"].includes(x))) {
      expect(same((v as any)[k], row[k]), `${k} : ${JSON.stringify((v as any)[k])} ≠ ${JSON.stringify(row[k])}`).toBe(true);
    }
    expect(v).toMatchObject({ customer_name: row.customer_name, customer_visible_from: null, customer_visible_until: null, network: null });
    expect(v.money).toEqual({
      price_cents: 4000, currency: "EUR", payment_method: "cash", collects: true, driver_part_cents: row.driver_payout_cents,
      giver_part_cents: row.commission_cents + row.platform_fee_cents, direction: "driver_owes",
      amount_cents: row.commission_cents + row.platform_fee_cents, counterparty: null, creditor_name: await orgName(C),
    });
    expect(v.voucher).toMatchObject({
      booked_by: { name: await orgName(C), legal_name: "Centrale SAS", vtc_registration: "EVTC0751" },
      operator: { kind: "driver", name: "Lina Test", vtc_registration: null },
      customer: { name: row.customer_name, phone: row.customer_phone }, receipt_by: await orgName(C),
    });
    // Aucune lecture comptée pour une course propre ; planning : la même course, client compris
    const upcoming = (await rpc(d.userId, "driver_rides_upcoming")) as DriverRide[];
    expect(upcoming.map((x) => x.id)).toEqual([ride.id]);
    expect(upcoming[0]).toEqual(v);
    // Flotte : ni part ni sens (jamais les frais Rydar d'une flotte)
    const F = await createOrg(`Flotte ${tag()}`);
    const f = await createDriver(F, { at: site });
    const fr = await createRideAsOwner(F, { pickup_lat: site[0], pickup_lng: site[1], price_cents: 3000 });
    expect(await rpc(F.ownerId, "assign_ride", [fr.id, f.id])).toMatchObject({ ok: true });
    expect((await driverRide(f, fr.id)).money).toEqual({
      price_cents: 3000, currency: "EUR", payment_method: "card", collects: true, driver_part_cents: null, giver_part_cents: null,
      direction: null, amount_cents: null, counterparty: null, creditor_name: null,
    });
  });

  it("état réseau : NETWORK_DISABLED réseau coupé ; état complet ; ping ; arrêt (offres fermées) et reprise ; conditions périmées ou à accepter", async () => {
    const p = await networkPair();
    await setSharedNetwork(false);
    for (const [fn, args] of [["driver_network_state", []], ["driver_network_ping", []], ["driver_set_network", [false, null]]] as const) {
      const e = await expectPgError(rpc(p.partner.userId, fn, [...args]));
      expect(e.code, fn).toBe("55000");
      expect(e.message, fn).toMatch(/^NETWORK_DISABLED/);
    }
    await setSharedNetwork(true);

    const state = (await rpc(p.partner.userId, "driver_network_state")) as DriverNetworkState;
    expect(sorted(Object.keys(state))).toEqual(sorted(STATE_KEYS));
    const version = await networkTermsVersion();
    expect(state).toMatchObject({
      enabled: true, org_allowed: true, accepted_version: version, mode: "consent",
      terms: { version, min_version: null, grace_until: null },
      organization: { id: p.B.id, name: p.bName, dispatch_model: "fleet", receiving: true },
      readiness: { ready: true, missing: [], warnings: [] },
      payout: { configured: false, iban_last4: null, in_use: false },
    });
    await sql(`update public.driver_network_settings set capable_at = now() - interval '9 days' where driver_id = $1`, [p.partner.id]);
    const ping = await rpc(p.partner.userId, "driver_network_ping");
    expect(Date.now() - new Date(ping.capable_at).getTime()).toBeLessThan(60_000);

    // Arrêt : ses offres partenaires en attente fermées, audit chez B
    const { offer } = await partnerOffer(p);
    const off = (await rpc(p.partner.userId, "driver_set_network", [false, null])) as DriverNetworkState;
    expect(off).toMatchObject({ enabled: false, accepted_version: version });
    expect(off.readiness.missing).toContain("driver_off");
    expect((await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer.id]))[0]).toEqual({
      status: "closed", closed_reason: "network_unavailable",
    });
    // Reprise sans nouvelle acceptation (conditions encore valables), puis acceptation de la version en vigueur
    expect(await rpc(p.partner.userId, "driver_set_network", [true, null])).toMatchObject({ enabled: true });
    expect(await rpc(p.partner.userId, "driver_set_network", [true, version])).toMatchObject({ enabled: true, accepted_version: version });
    expect(await rpc(p.partner.userId, "driver_set_network", [true, version])).toMatchObject({ enabled: true });
    const proofs = await sql(
      `select organization_id, source, accepted_by_email from public.legal_acceptances where user_id = $1 and document = 'network_driver'`,
      [p.partner.userId],
    );
    expect(proofs).toEqual([{ organization_id: p.B.id, source: "app", accepted_by_email: null }]);
    const audits = await sql(
      `select metadata from public.audit_logs where organization_id = $1 and action = 'driver.network_consent' order by id`,
      [p.B.id],
    );
    expect(audits.map((a) => a.metadata.enabled)).toEqual([false, true]);
    // Version périmée : NETWORK_TERMS_OUTDATED ; nouveau chauffeur sans acceptation : NETWORK_TERMS_REQUIRED
    expect((await expectPgError(rpc(p.partner.userId, "driver_set_network", [true, "2020-01-01"]))).message).toMatch(/^NETWORK_TERMS_OUTDATED/);
    const fresh = await createDriver(p.B, { firstName: "Nouveau" });
    expect((await expectPgError(rpc(fresh.userId, "driver_set_network", [true, null]))).message).toMatch(/^NETWORK_TERMS_REQUIRED/);
    // Un membre de B sans fiche chauffeur : refusé
    expect((await expectPgError(rpc(p.B.ownerId, "driver_network_state"))).code).toBe("42501");
  });

  it("libellé d'un chauffeur (private.driver_label_for) : complet pour son organisation, court « Prénom I. · B » pour une autre", async () => {
    const p = await networkPair();
    const [{ own, other }] = await sql(
      `select private.driver_label_for($1, $2) as own, private.driver_label_for($1, $3) as other`,
      [p.partner.id, p.B.id, p.A.id],
    );
    expect(own).toBe(`Karim Tazi (#${p.partner.number})`);
    expect(other).toBe(`Karim T. · ${p.bName}`);
  });
});

// =============================================================================
// n° 2 — Organisation du chauffeur (B) : rien de A, sauf « Courses reçues »
// =============================================================================
describe("Organisation du chauffeur, B (§11.4, §14.1 n° 2)", () => {
  it("owner, admin et dispatcher de B : aucune ligne de A (course, journal, règlement, notifications, offres) ; tables réseau sans lecture", async () => {
    const p = await networkPair();
    const { ride, settlement } = await sharedRide(p);
    expect(settlement).toBeTruthy();
    const admin = await createMember(p.B, "admin");
    const dispatcher = await createMember(p.B, "dispatcher");
    for (const who of [p.B.ownerId, admin, dispatcher]) {
      for (const [table, col] of [
        ["rides", "id"], ["ride_events", "ride_id"], ["ride_settlements", "ride_id"], ["notifications", "ride_id"],
        ["ride_offers", "ride_id"], ["ride_assignments", "ride_id"], ["ride_alerts", "ride_id"], ["ride_status_history", "ride_id"],
      ] as const) {
        const rows = await as({ sub: who }, (q) => q(`select 1 from public.${table} where ${col} = $1`, [ride.id]));
        expect(rows, `${table} (${who === p.B.ownerId ? "owner" : who === admin ? "admin" : "dispatcher"})`).toEqual([]);
      }
      for (const table of ["ride_network_shares", "ride_network_executions", "driver_payout_details"]) {
        expect((await expectPgError(as({ sub: who }, (q) => q(`select 1 from public.${table} limit 1`)))).code, table).toBe("42501");
      }
    }
  });

  it("« Courses reçues » (org_network_received) : communes, chauffeur, véhicule, montants, règlement — jamais le client ni l'adresse ; filtres, mois, curseur", async () => {
    const p = await networkPair();
    const first = await sharedRide(p, { payment_method: "cash" });
    const second = await sharedRide(p, { payment_method: "online" });
    const dispatcher = await createMember(p.B, "dispatcher");

    const all = (await rpc(dispatcher, "org_network_received", [p.B.id, "all", null, null, 50, null])) as OrgNetworkReceived;
    expect(all.filter).toBe("all");
    expect(all.items.map((i) => i.execution_id)).toEqual([second.execution.id, first.execution.id]);
    const item = all.items[1]!;
    expect(sorted(Object.keys(item))).toEqual(sorted(RECEIVED_KEYS));
    expect(item).toMatchObject({
      reference: `R${first.ride.number}`, end_reason: "completed",
      ride: { type: "instant", status: "COMPLETED", pickup_area: "75008 Paris", dropoff_area: "Roissy-en-France" },
      driver: { id: p.partner.id, number: p.partner.number, first_name: "Karim", last_name: "Tazi" },
      giver: { id: p.A.id, name: p.aName, phone: "+33140000001" },
      money: { price_cents: 5000, currency: "EUR", payment_method: "cash", driver_part_cents: 4500, direction: "driver_owes", amount_cents: 500 },
      settlement: { status: "due", overdue: false, on_hold: false, driver_disputed: false },
      to_check: false, contested: false,
    });
    expect(sorted(Object.keys(item.ride))).toEqual(["completed_at", "dropoff_area", "pickup_area", "pickup_at", "status", "type"]);
    expectNoClientData(all);
    expect(JSON.stringify(all)).not.toMatch(/commission|platform_fee/);

    // Filtres, partenaire, mois, curseur
    const open = (await rpc(dispatcher, "org_network_received", [p.B.id, "open", null, null, 50, null])) as OrgNetworkReceived;
    expect(open.items).toHaveLength(2);
    expect(((await rpc(dispatcher, "org_network_received", [p.B.id, "settled", null, null, 50, null])) as OrgNetworkReceived).items).toEqual([]);
    expect(((await rpc(dispatcher, "org_network_received", [p.B.id, "inconnu", null, null, 50, null])) as OrgNetworkReceived).filter).toBe("all");
    expect(((await rpc(dispatcher, "org_network_received", [p.B.id, "all", p.B.id, null, 50, null])) as OrgNetworkReceived).items).toEqual([]);
    const [{ m }] = await sql(`select private.network_month(e) as m from public.ride_network_executions e where e.id = $1`, [first.execution.id]);
    expect(((await rpc(dispatcher, "org_network_received", [p.B.id, "all", p.A.id, m, 50, null])) as OrgNetworkReceived).items).toHaveLength(2);
    expect(((await rpc(dispatcher, "org_network_received", [p.B.id, "all", null, "2001-01", 50, null])) as OrgNetworkReceived).items).toEqual([]);
    expect((await expectPgError(rpc(dispatcher, "org_network_received", [p.B.id, "all", null, "2026-13", 50, null]))).code).toBe("22023");
    const page1 = (await rpc(dispatcher, "org_network_received", [p.B.id, "all", null, null, 1, null])) as OrgNetworkReceived;
    expect(page1.items.map((i) => i.execution_id)).toEqual([second.execution.id]);
    expect(page1.next_before).not.toBeNull();
    const page2 = (await rpc(dispatcher, "org_network_received", [p.B.id, "all", null, null, 1, page1.next_before])) as OrgNetworkReceived;
    expect(page2.items.map((i) => i.execution_id)).toEqual([first.execution.id]);
    // Organisation qui confie : rien à lire ici (B seulement)
    expect((await expectPgError(rpc(p.A.ownerId, "org_network_received", [p.B.id, "all", null, null, 50, null]))).code).toBe("42501");

    // Retrait : la suite de la course chez A n'est jamais montrée à B (statut de l'exécution, pas de la course)
    const { ride } = await partnerAccepts(p);
    expect(await rpc(p.A.ownerId, "reassign_ride", [ride.id, null, p.partner.id])).toMatchObject({ ok: true });
    const after = (await rpc(dispatcher, "org_network_received", [p.B.id, "all", null, null, 1, null])) as OrgNetworkReceived;
    expect(after.items[0]).toMatchObject({ end_reason: "removed_by_giver", ride: { status: "CANCELLED", completed_at: null }, settlement: null });
  });

  it("activité (org_network_activity) : chauffeur en course partenaire sans position (Q5), créneau pris ; position et points de la course partenaire invisibles pour B", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p);
    await moveTo(p.partner.id, p.site);
    expect(await stepAs(p.partner, ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });

    const act = (await rpc(p.B.ownerId, "org_network_activity", [p.B.id])) as OrgNetworkActivity;
    expect(act.on_ride).toHaveLength(1);
    expect(act.on_ride[0]).toMatchObject({
      driver: { id: p.partner.id, number: p.partner.number, first_name: "Karim", last_name: "Tazi" },
      giver: { id: p.A.id, name: p.aName }, phase: "DRIVER_EN_ROUTE",
    });
    expect(Object.keys(act.on_ride[0]!).sort()).toEqual(["driver", "giver", "phase", "since"]);
    expect(JSON.stringify(act)).not.toContain(ride.id);
    expectNoClientData(act);

    // Q5 : position en direct masquée à B pendant la course partenaire ; points d'une course partenaire jamais lisibles
    expect(await as({ sub: p.B.ownerId }, (q) => q(`select 1 from public.driver_locations where driver_id = $1`, [p.partner.id]))).toEqual([]);
    expect((await as({ sub: p.partner.userId }, (q) => q(`select 1 from public.driver_locations where driver_id = $1`, [p.partner.id])))).toHaveLength(1);
    await sql(
      `insert into public.driver_location_history (driver_id, organization_id, lat, lng, recorded_at, ride_org_id)
       values ($1, $2, 1, 1, now(), $3), ($1, $2, 2, 2, now(), $2), ($1, $2, 3, 3, now(), null)`,
      [p.partner.id, p.B.id, p.A.id],
    );
    const points = await as({ sub: p.B.ownerId }, (q) => q(`select lat from public.driver_location_history where driver_id = $1 order by lat`, [p.partner.id]));
    expect(points.map((x) => Number(x.lat))).toEqual([2, 3]);

    // Planifiée acceptée (autre partenaire) : créneau pris, pas « en course »
    const other = await readyPartner(p.B, { firstName: "Sami", at: north(p.site, 900) });
    await moveTo(p.partner.id, north(p.site, 50_000));
    const sched = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes', next_dispatch_at = now() - interval '1 second' where id = $1`, [sched.id]);
    await sql("select private.dispatch_tick()");
    const offer = await pendingOffer(sched.id, other.id);
    expect(offer).toBeTruthy();
    expect(await rpc(other.userId, "accept_ride_offer", [offer!.id])).toMatchObject({ ok: true });
    const act2 = (await rpc(p.B.ownerId, "org_network_activity", [p.B.id])) as OrgNetworkActivity;
    expect(act2.on_ride.map((r) => r.driver.id)).toEqual([p.partner.id]);
    expect(act2.scheduled).toHaveLength(1);
    expect(act2.scheduled[0]).toMatchObject({ driver: { id: other.id, first_name: "Sami" }, giver: { id: p.A.id, name: p.aName } });
    const [{ pickup_at: pickupAt, d }] = await sql(`select pickup_at, coalesce(estimated_duration_s, 2700) as d from public.rides where id = $1`, [sched.id]);
    expect(new Date(act2.scheduled[0]!.until).getTime()).toBe(new Date(pickupAt).getTime() + (d + 45 * 60) * 1000);
    // Organisation qui confie : refusée
    expect((await expectPgError(rpc(p.A.ownerId, "org_network_activity", [p.B.id]))).code).toBe("42501");
  });

  it("statistiques : chiffres de B seulement (driver_stats), courses partenaires en nombre, offres réseau hors des taux de A (org_stats)", async () => {
    const p = await networkPair();
    const range = [new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString()];
    const before = await rpc(p.B.ownerId, "driver_stats", [p.partner.id, 30]);
    expect(before).not.toHaveProperty("network_rides");
    // Course partenaire terminée + offre réseau refusée : rien dans les compteurs de B ni dans les taux de A
    await sharedRide(p, { price_cents: 9900 });
    const { offer } = await partnerOffer(p);
    expect(await rpc(p.partner.userId, "decline_ride_offer", [offer.id])).toMatchObject({ ok: true });
    const stats = await rpc(p.B.ownerId, "driver_stats", [p.partner.id, 30]);
    expect(stats.rides).toEqual(before.rides);
    expect(stats.offers).toEqual(before.offers);
    expect(stats.network_rides).toBe(1);
    expect(JSON.stringify(stats)).not.toContain("9900");
    const orgB = await rpc(p.B.ownerId, "org_stats", [p.B.id, ...range]);
    expect(orgB).toMatchObject({ network_rides: 1, summary: { rides_total: 0, revenue_cents: 0 } });
    const orgA = await rpc(p.A.ownerId, "org_stats", [p.A.id, ...range]);
    expect(orgA.offers).toMatchObject({ offers_sent: 0, accepted: 0, declined: 0 });
    expect(orgA.summary).toMatchObject({ completed: 1, revenue_cents: 9900 });
    expect(orgA).not.toHaveProperty("network_rides");
  });

  it("chauffeurs de B (org_network_drivers, set_driver_network_allowed) : owner / admin, réseau ouvert ; retrait → offres fermées, une seule trace", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.B, "dispatcher");
    const list = (await rpc(p.B.ownerId, "org_network_drivers", [p.B.id])) as OrgNetworkDriver[];
    const row = list.find((x) => x.driver.id === p.partner.id)!;
    expect(row).toMatchObject({
      driver: { number: p.partner.number, first_name: "Karim", last_name: "Tazi", status: "active" },
      settings: { enabled: true, org_allowed: true }, vtc_operator_registration: "EVTC075990001",
      readiness: { ready: true, missing: [] },
    });
    expect((await expectPgError(rpc(dispatcher, "org_network_drivers", [p.B.id]))).code).toBe("42501");
    expect((await expectPgError(rpc(p.A.ownerId, "org_network_drivers", [p.B.id]))).code).toBe("42501");

    const { offer } = await partnerOffer(p);
    expect((await expectPgError(rpc(dispatcher, "set_driver_network_allowed", [p.partner.id, false]))).code).toBe("42501");
    expect((await expectPgError(rpc(p.A.ownerId, "set_driver_network_allowed", [p.partner.id, false]))).code).toBe("42501");
    expect(await rpc(p.B.ownerId, "set_driver_network_allowed", [p.partner.id, false])).toEqual({
      ok: true, driver_id: p.partner.id, allowed: false, closed_offers: 1,
    });
    expect((await sql(`select status from public.ride_offers where id = $1`, [offer.id]))[0].status).toBe("closed");
    expect(await rpc(p.B.ownerId, "set_driver_network_allowed", [p.partner.id, false])).toMatchObject({ closed_offers: 0 });
    const after = ((await rpc(p.B.ownerId, "org_network_drivers", [p.B.id])) as OrgNetworkDriver[]).find((x) => x.driver.id === p.partner.id)!;
    expect(after.settings!.org_allowed).toBe(false);
    expect(after.readiness.missing).toContain("org_disallowed");
    expect((await sql(`select count(*)::int as n from public.audit_logs where organization_id = $1 and action = 'network.settings' and entity_id = $2`, [p.B.id, p.partner.id]))[0].n).toBe(1);
    expect(await rpc(p.B.ownerId, "set_driver_network_allowed", [p.partner.id, true])).toMatchObject({ allowed: true });

    await setSharedNetwork(false);
    expect((await expectPgError(rpc(p.B.ownerId, "org_network_drivers", [p.B.id]))).message).toMatch(/^NETWORK_DISABLED/);
    expect((await expectPgError(rpc(p.B.ownerId, "set_driver_network_allowed", [p.partner.id, false]))).message).toMatch(/^NETWORK_DISABLED/);
  });
});

// =============================================================================
// n° 3 — Organisation qui confie la course (A)
// =============================================================================
describe("Organisation qui confie la course, A (§11.3, §14.1 n° 3)", () => {
  it("aucune offre réseau lisible, RIB et tables réseau illisibles directement", async () => {
    const p = await networkPair();
    const { ride } = await partnerOffer(p);
    const dispatcher = await createMember(p.A, "dispatcher");
    for (const who of [p.A.ownerId, dispatcher]) {
      expect(await as({ sub: who }, (q) => q(`select id from public.ride_offers where ride_id = $1`, [ride.id]))).toEqual([]);
      for (const table of ["driver_payout_details", "ride_network_executions", "ride_network_shares"]) {
        expect((await expectPgError(as({ sub: who }, (q) => q(`select 1 from public.${table} limit 1`)))).code, table).toBe("42501");
      }
      // Termes d'une offre (commission et frais) jamais lisibles côté client
      expect((await expectPgError(as({ sub: who }, (q) => q(`select network_terms from public.ride_offers limit 1`)))).code).toBe("42501");
      // Notifications du partenaire (lignes chez A) : lisibles par lui seul
      expect(await as({ sub: who }, (q) => q(`select 1 from public.notifications where ride_id = $1`, [ride.id]))).toEqual([]);
    }
    expect((await sql(`select count(*)::int as n from public.notifications where ride_id = $1 and driver_id = $2`, [ride.id, p.partner.id]))[0].n)
      .toBeGreaterThan(0);
    expect((await as({ sub: p.partner.userId }, (q) => q(`select type from public.notifications where ride_id = $1`, [ride.id]))).map((n) => n.type))
      .toEqual(["ride_offer"]);
  });

  it("fiche course (org_network_ride) : partage, chauffeur partenaire (téléphone dans sa fenêtre), contrôles, carte de B, lectures du client, actions", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const { ride, execution } = await partnerAccepts(p, { payment_method: "cash" });
    const [{ phone }] = await sql(`select phone from public.drivers where id = $1`, [p.partner.id]);

    await driverRide(p.partner, ride.id);
    const live = (await rpc(dispatcher, "org_network_ride", [ride.id])) as OrgNetworkRide;
    expect(live.share).toMatchObject({ status: "accepted", cycle: 1, stage: "instant", partners_offered: 1, closed_reason: null });
    expect(sorted(Object.keys(live.execution!))).toEqual(sorted([...EXECUTION_KEYS, "checks", "driver_phone", "driver_phone_until", "client_data"]));
    expect(live.execution).toMatchObject({
      id: execution.id, driver_label: "Karim T.", partner: { id: p.B.id, name: p.bName }, driver_phone: phone,
      driver_phone_until: null, driver_excluded: false, validated_at: null, client_data: { reads: 1 },
      checks: { vtc_card_number: expect.stringMatching(/^VTC/) },
    });
    expect(live.operator).toMatchObject({ organization_id: p.B.id, name: p.bName, legal_name: `${p.bName} SAS`, siret: "12345678901234" });
    expect(live.previous).toEqual([]);
    // Dispatcher : « Retirer » seulement ; owner : exclusions aussi (pas de clôture, chauffeur actif et localisé)
    expect(live.can).toEqual({ remove: true, close: false, validate: false, contest: false, exclude_driver: false, exclude_partner: false });
    const asOwner = (await rpc(p.A.ownerId, "org_network_ride", [ride.id])) as OrgNetworkRide;
    expect(asOwner.can).toEqual({ remove: true, close: false, validate: false, contest: false, exclude_driver: true, exclude_partner: true });
    // Jamais le nom de famille ni le n° interne du chauffeur partenaire
    expect(JSON.stringify(asOwner)).not.toContain("Tazi");

    // Fin de course payée à bord : règlement ouvert → téléphone jusqu'à fin + 30 jours
    await finish(p.partner, ride.id, p.site);
    const done = (await rpc(p.A.ownerId, "org_network_ride", [ride.id])) as OrgNetworkRide;
    const ended = new Date(done.execution!.ended_at!).getTime();
    expect(done.execution!.driver_phone).toBe(phone);
    expect(new Date(done.execution!.driver_phone_until!).getTime()).toBe(ended + 30 * 86_400_000);
    expect(done.settlement).toMatchObject({ status: "due", network: { execution_id: execution.id } });
    expect(done.can).toMatchObject({ remove: false, close: false, contest: true, validate: false });
    // « Reçu », puis 3 jours plus tard : fenêtre de 48 h passée → téléphone masqué
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[done.settlement!.id], "cash", null])).toMatchObject({ ok: true });
    await rewind([
      [`update public.ride_network_executions set ended_at = ended_at - interval '3 days' where id = $1`, [execution.id]],
      [`update public.ride_settlements set updated_at = now() - interval '3 days' where id = $1`, [done.settlement!.id]],
    ]);
    const old = (await rpc(p.A.ownerId, "org_network_ride", [ride.id])) as OrgNetworkRide;
    expect(old.execution!.driver_phone).toBeNull();
    expect(new Date(old.execution!.driver_phone_until!).getTime()).toBeLessThan(Date.now());

    // B, une autre organisation : refusées ; course inconnue : RIDE_NOT_FOUND ; jamais partagée : null
    expect((await expectPgError(rpc(p.B.ownerId, "org_network_ride", [ride.id]))).code).toBe("42501");
    expect((await expectPgError(rpc(p.A.ownerId, "org_network_ride", [randomUUID()]))).code).toBe("P0002");
    const plain = await createRideAsOwner(p.A, { pickup_lat: 0, pickup_lng: 0 });
    expect(await rpc(p.A.ownerId, "org_network_ride", [plain.id])).toBeNull();
  });

  it("chauffeur retiré : exécution précédente (motif), partage rouvert sans lui ; clôture proposée sans position depuis 30 min", async () => {
    const p = await networkPair();
    const { ride, execution } = await partnerAccepts(p);
    expect(await rpc(p.A.ownerId, "reassign_ride", [ride.id, "Retard", p.partner.id])).toMatchObject({ ok: true });
    const removed = (await rpc(p.A.ownerId, "org_network_ride", [ride.id])) as OrgNetworkRide;
    expect(removed.execution).toBeNull();
    expect(removed.operator).toBeNull();
    expect(removed.previous).toHaveLength(1);
    expect(removed.previous[0]).toMatchObject({ id: execution.id, end_reason: "removed_by_giver", driver_label: "Karim T." });
    expect(sorted(Object.keys(removed.previous[0]!))).toEqual(sorted(EXECUTION_KEYS));
    expect(removed.can).toMatchObject({ remove: false, close: false, exclude_driver: false });

    // Autre course, client à bord, plus de position depuis 35 min : « Clôturer » (owner / admin)
    const second = await partnerAccepts(p);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
      await moveTo(p.partner.id, p.site);
      expect(await stepAs(p.partner, second.ride.id, s), s).toMatchObject({ ok: true });
    }
    await moveTo(p.partner.id, p.site, 35 * 60);
    const onboard = (await rpc(p.A.ownerId, "org_network_ride", [second.ride.id])) as OrgNetworkRide;
    expect(onboard.can).toMatchObject({ remove: false, close: true });
    const dispatcher = await createMember(p.A, "dispatcher");
    expect(((await rpc(dispatcher, "org_network_ride", [second.ride.id])) as OrgNetworkRide).can.close).toBe(false);
  });

  it("indicateurs (org_network_summary) = filtres de « Courses confiées » (org_network_given) ; pastille ; curseur ; A suspendue : owner / admin seulement", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    // Karim tient une course (en route : plus sollicité) ; Nora fait les suivantes
    const enCours = await partnerAccepts(p);
    const second = await readyPartner(p.B, { firstName: "Nora", at: north(p.site, 700) });
    const cash = await partnerAccepts(p, { payment_method: "cash" }, second);
    await finish(second, cash.ride.id, p.site);
    const online = await partnerAccepts(p, { payment_method: "online" }, second);
    await finish(second, online.ride.id, p.site, { gps: false });
    const declared = await partnerAccepts(p, { payment_method: "cash" }, second);
    await finish(second, declared.ride.id, p.site);
    const [line] = await sql(`select id from public.ride_settlements where ride_id = $1`, [declared.ride.id]);
    expect(await rpc(second.userId, "driver_declare_network_payment", [p.A.id, [line.id], "link", null])).toMatchObject({ ok: true });
    const late = await partnerAccepts(p, { payment_method: "cash" }, second);
    await finish(second, late.ride.id, p.site);
    // Course de A en recherche réseau (avant le retard : un impayé échu bloque Nora pour les courses de A)
    await moveTo(second.id, north(p.site, 800));
    const searching = await rideOf(p);
    await toNetworkStage(searching.id);
    expect(await pendingOffer(searching.id, second.id), "course proposée au réseau").toBeTruthy();
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where ride_id = $1`, [late.ride.id]);

    const summary = (await rpc(dispatcher, "org_network_summary", [p.A.id])) as OrgNetworkSummary;
    expect(summary.currency).toBe("EUR");
    expect(summary.given).toEqual({
      searching: 1, in_progress: 1, to_collect_cents: 1500, to_confirm_count: 1, to_pay_cents: 4500, to_check_count: 1,
      overdue_cents: 500, overdue_count: 1, disputed_count: 0,
    });
    expect(summary.badge).toBe(3);
    expect(summary.received).toEqual({ in_progress: 0, month_rides: 0, total_rides: 0, open_count: 0 });
    expect(summary.readiness.share_out).toEqual({ active: true, missing: [], warnings: [] });
    expect(summary.readiness.share_in).toMatchObject({ active: false });
    expect(summary.readiness.share_in.missing).toEqual(["not_receiving", "insurance"]);
    expect(summary.readiness.approval).toMatchObject({ status: "approved", refused_reason: null });
    const bSummary = (await rpc(p.B.ownerId, "org_network_summary", [p.B.id])) as OrgNetworkSummary;
    expect(bSummary.received).toEqual({ in_progress: 1, month_rides: 4, total_rides: 5, open_count: 4 });

    const given = async (filter: string, limit = 50, before: string | null = null) =>
      (await rpc(dispatcher, "org_network_given", [p.A.id, filter, null, null, limit, before])) as OrgNetworkGiven;
    const ids = async (filter: string) => (await given(filter)).items.map((i) => i.ride.id);
    expect(await ids("in_progress")).toEqual([enCours.ride.id]);
    expect(await ids("to_check")).toEqual([online.ride.id]);
    expect(await ids("to_collect")).toEqual([late.ride.id, declared.ride.id, cash.ride.id]);
    expect(await ids("to_confirm")).toEqual([declared.ride.id]);
    expect(await ids("overdue")).toEqual([late.ride.id]);
    expect(await ids("to_pay")).toEqual([online.ride.id]);
    expect(await ids("disputed")).toEqual([]);
    expect(await ids("settled")).toEqual([]);
    expect((await given("all")).items).toHaveLength(5);
    expect((await given("??")).filter).toBe("all");
    const item = (await given("to_check")).items[0] as NetworkGivenItem;
    expect(sorted(Object.keys(item.execution))).toEqual(sorted(EXECUTION_KEYS));
    expect(item).toMatchObject({
      ride: { id: online.ride.id, number: Number(online.ride.number), pickup_address: PICKUP, customer_name: CLIENT.name },
      execution: { driver_label: "Nora T.", suspect_reasons: ["no_gps"], on_hold: true, validated_at: null },
      settlement: { direction: "centrale_owes", status: "due", network: { on_hold: true, payout_configured: false } },
    });
    // Curseur : pages de 2, puis la fin (next_before NULL)
    const p1 = await given("all", 2);
    const p2 = await given("all", 2, p1.next_before);
    const p3 = await given("all", 2, p2.next_before);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.execution.id)).toHaveLength(5);
    expect(new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.execution.id)).size).toBe(5);
    expect(p3.next_before).toBeNull();
    // Validée : plus « à vérifier »
    expect(await rpc(p.A.ownerId, "validate_network_ride", [online.ride.id])).toMatchObject({ ok: true });
    expect(await ids("to_check")).toEqual([]);
    expect(((await rpc(dispatcher, "org_network_summary", [p.A.id])) as OrgNetworkSummary).given.to_check_count).toBe(0);

    // B : aucune course confiée lisible chez A ; A suspendue : owner / admin seulement (sommes en cours)
    expect((await expectPgError(rpc(p.B.ownerId, "org_network_given", [p.A.id, "all", null, null, 50, null]))).code).toBe("42501");
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [p.A.id]);
    expect(await rpc(p.A.ownerId, "org_network_summary", [p.A.id])).toMatchObject({ given: { to_collect_cents: 1500 } });
    expect(((await rpc(p.A.ownerId, "org_network_given", [p.A.id, "all", null, null, 50, null])) as OrgNetworkGiven).items).toHaveLength(5);
    expect((await expectPgError(rpc(dispatcher, "org_network_summary", [p.A.id]))).code).toBe("42501");
    await sql(`update public.organizations set status = 'active' where id = $1`, [p.A.id]);
    // Réseau fermé : les sommes en cours restent lisibles (NETWORK_CLOSED_RPCS)
    await setSharedNetwork(false);
    expect(await rpc(dispatcher, "org_network_summary", [p.A.id])).toMatchObject({ readiness: { enabled: false } });
    expect(((await rpc(dispatcher, "org_network_given", [p.A.id, "all", null, null, 50, null])) as OrgNetworkGiven).items).toHaveLength(5);
    expect(((await rpc(p.B.ownerId, "org_network_received", [p.B.id, "all", null, null, 50, null])) as OrgNetworkReceived).items).toHaveLength(5);
    expect(await rpc(p.B.ownerId, "org_network_activity", [p.B.id])).toMatchObject({ on_ride: [{ driver: { id: p.partner.id } }] });
  });

  it("dispatcher de A : refusé sur toute action d'argent réseau (42501), autorisé à relancer", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const { ride, execution, settlement } = await sharedRide(p, { payment_method: "cash" });
    const refused: Array<[string, unknown[]]> = [
      ["confirm_settlements", [[settlement.id], "cash", null]],
      ["dispute_settlement", [settlement.id, "Pas reçu du tout"]],
      ["waive_settlement", [settlement.id, "Geste commercial"]],
      ["validate_network_ride", [ride.id]],
      ["contest_network_ride", [ride.id, "Course non faite"]],
      ["close_network_ride", [ride.id]],
      ["exclude_network_driver", [execution.id, null]],
    ];
    for (const [fn, args] of refused) {
      expect((await expectPgError(rpc(dispatcher, fn, args))).code, fn).toBe("42501");
    }
    await sql(`update public.ride_settlements set due_at = now() - interval '1 hour' where id = $1`, [settlement.id]);
    expect(await rpc(dispatcher, "remind_network_driver", [p.A.id, settlement.id])).toMatchObject({ ok: true, code: "REMINDED" });
  });

  it("exclusions de chauffeurs : exclure (empreintes, offres fermées, idempotente), liste, lever ; réseau fermé : NETWORK_DISABLED", async () => {
    const p = await networkPair();
    const { execution } = await sharedRide(p);
    const { offer } = await partnerOffer(p);

    const res = await rpc(p.A.ownerId, "exclude_network_driver", [execution.id, "  Retards   répétés  "]);
    expect(res).toMatchObject({ ok: true, closed_offers: 1 });
    const exclusion = res.exclusion as NetworkDriverExclusion;
    expect(exclusion).toMatchObject({ label: `Karim T. · ${p.bName}`, reason: "Retards répétés", lifted_at: null, created_by_name: `Owner ${p.aName}` });
    expect((await sql(`select status from public.ride_offers where id = $1`, [offer.id]))[0].status).toBe("closed");
    // Idempotente : même exclusion, rien de fermé
    expect(await rpc(p.A.ownerId, "exclude_network_driver", [execution.id, "encore"])).toMatchObject({ exclusion: { id: exclusion.id }, closed_offers: 0 });
    // Bloqué chez A par ses empreintes (dispatch), signalé dans les listes
    const [{ block }] = await sql(`select private.network_identity_block($1, $2) as block`, [p.partner.id, p.A.id]);
    expect(block).toBe("excluded");
    const given = (await rpc(p.A.ownerId, "org_network_given", [p.A.id, "all", null, null, 50, null])) as OrgNetworkGiven;
    expect(given.items.find((i) => i.execution.id === execution.id)!.execution.driver_excluded).toBe(true);
    const list = (await rpc(p.A.ownerId, "org_network_driver_exclusions", [p.A.id])) as NetworkDriverExclusion[];
    expect(list.map((x) => x.id)).toEqual([exclusion.id]);
    expect(Object.keys(list[0]!).sort()).toEqual(["created_at", "created_by_name", "id", "label", "lifted_at", "reason"]);
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/);
    // Lever (une autre organisation : refusée)
    expect((await expectPgError(rpc(p.B.ownerId, "lift_network_driver_exclusion", [p.B.id, exclusion.id]))).code).toBe("42501");
    expect(await rpc(p.A.ownerId, "lift_network_driver_exclusion", [p.A.id, exclusion.id])).toEqual({ ok: true });
    expect(await rpc(p.A.ownerId, "lift_network_driver_exclusion", [p.A.id, exclusion.id])).toEqual({ ok: true });
    expect(((await rpc(p.A.ownerId, "org_network_driver_exclusions", [p.A.id])) as NetworkDriverExclusion[])[0]!.lifted_at).not.toBeNull();
    expect((await sql(`select private.network_identity_block($1, $2) as block`, [p.partner.id, p.A.id]))[0].block).toBeNull();
    const audit = await sql(`select action from public.audit_logs where organization_id = $1 and action like 'network.driver_exclu%' order by id`, [p.A.id]);
    expect(audit.map((a) => a.action)).toEqual(["network.driver_excluded", "network.driver_exclusion_lifted"]);
    // Dispatcher, B : refusés ; réseau fermé : NETWORK_DISABLED
    const dispatcher = await createMember(p.A, "dispatcher");
    expect((await expectPgError(rpc(dispatcher, "org_network_driver_exclusions", [p.A.id]))).code).toBe("42501");
    expect((await expectPgError(rpc(p.B.ownerId, "exclude_network_driver", [execution.id, null]))).code).toBe("42501");
    await setSharedNetwork(false);
    for (const [fn, args] of [["exclude_network_driver", [execution.id, null]], ["org_network_driver_exclusions", [p.A.id]], ["lift_network_driver_exclusion", [p.A.id, exclusion.id]]] as const) {
      expect((await expectPgError(rpc(p.A.ownerId, fn, [...args]))).message, fn).toMatch(/^NETWORK_DISABLED/);
    }
  });

  it("organisations rencontrées (network_partner_names) : seulement après une course acceptée, jamais une organisation seulement sollicitée", async () => {
    const p = await networkPair();
    const C = await createOrg(`Sollicitee ${tag()}`);
    await enableNetwork(C, { in: true });
    await approveNetwork(C);
    const cDriver = await readyPartner(C, { firstName: "Yanis", at: north(p.site, 1200) });
    const { ride } = await partnerOffer(p);
    expect(await pendingOffer(ride.id, cDriver.id)).toBeTruthy();
    expect(await rpc(p.A.ownerId, "network_partner_names", [p.A.id])).toEqual({});
    expect(await rpc(p.partner.userId, "accept_ride_offer", [(await pendingOffer(ride.id, p.partner.id))!.id])).toMatchObject({ ok: true });
    expect(await rpc(p.A.ownerId, "network_partner_names", [p.A.id])).toEqual({ [p.B.id]: p.bName });
    expect(await rpc(p.B.ownerId, "network_partner_names", [p.B.id])).toEqual({ [p.A.id]: p.aName });
    expect(await rpc(C.ownerId, "network_partner_names", [C.id])).toEqual({});
    expect((await expectPgError(rpc(C.ownerId, "network_partner_names", [p.A.id]))).code).toBe("42501");
  });
});

// =============================================================================
// Partie 5b — journaux, alertes, positions, temps réel, notifications, webhooks (§11.5 à §11.7, §13 ; §14.1 n° 32)
// =============================================================================
type Message = { id: number; topic: string; event: string; payload: Record<string, any> };
const lastMessageId = async () => Number((await sql(`select coalesce(max(id), 0) as m from realtime.messages`))[0].m);
const messagesSince = async (after: number, topics: string[]) =>
  (await sql(`select id, topic, event, payload from realtime.messages where id > $1 and topic = any ($2) order by id`, [after, topics])).map(
    (m) => ({ ...m, id: Number(m.id) }),
  ) as Message[];
const location = (d: Driver, at: [number, number]) => rpc(d.userId, "update_driver_location", [at[0], at[1]]);
const historyOf = (driverId: string) =>
  sql(`select ride_id, ride_org_id from public.driver_location_history where driver_id = $1 order by recorded_at, id`, [driverId]);
const labelOf = (p: Pair) => `Karim T. · ${p.bName}`;
/** Données qu'aucune ligne lisible par A ne doit contenir sur le chauffeur partenaire (S3) : identifiants, nom, n° interne. */
function expectNoPartnerIdentity(value: unknown, p: Pair, extra: string[] = []) {
  const text = JSON.stringify(value);
  for (const secret of [p.partner.id, p.partner.userId, p.B.ownerId, "Tazi", '"driver_number"', ...extra]) {
    expect(text, secret).not.toContain(secret);
  }
}

describe("Journaux et alertes (§11.5, partie 5b)", () => {
  it("private.log_event : filet de sécurité — chauffeur d'une autre organisation retiré des données, libellé court dans le message, acteur extérieur sans identifiant ; ligne propre inchangée", async () => {
    const p = await networkPair();
    const own = await createDriver(p.A, { firstName: "Paul" });
    const { ride } = await partnerAccepts(p);
    const n = p.partner.number;
    const log = (type: string, message: string, data: Record<string, unknown>, actorType: string, actorId: string | null) =>
      sql(`select private.log_event($1, $2, $3, $4, 'timeline', 'info', $5::jsonb, $6::public.actor_type, $7)`, [
        p.A.id, ride.id, type, message, JSON.stringify(data), actorType, actorId,
      ]);
    const event = async (type: string) =>
      (await sql(`select message, data, actor_type, actor_id from public.ride_events where ride_id = $1 and type = $2`, [ride.id, type]))[0];

    await log("test.partner", `Karim Tazi (#${n}) accepte ; Karim (#${n}) roule — M. Tazi`, {
      driver_id: p.partner.id, previous_driver_id: own.id, assigned_driver_id: p.partner.id, driver_ids: [own.id, p.partner.id],
      driver_number: n, driver_name: "Karim", lat: 48.1, lng: 2.1, keep: true,
    }, "driver", p.partner.id);
    const ev = await event("test.partner");
    expect(ev.data).toEqual({ previous_driver_id: own.id, driver_ids: [own.id], network_count: 1, keep: true });
    expect(ev.message).toBe(`${labelOf(p)} accepte ; ${labelOf(p)} roule — M. T.`);
    expect(ev).toMatchObject({ actor_type: "driver", actor_id: null });

    // Ligne propre (chauffeur de A, ses coordonnées comprises) : identique à avant
    const ownData = { driver_id: own.id, driver_number: own.number, driver_name: "Paul", lat: 48.2, lng: 2.2 };
    await log("test.own", `Paul Test (#${own.number}) accepte`, ownData, "driver", own.id);
    expect(await event("test.own")).toEqual({ message: `Paul Test (#${own.number}) accepte`, data: ownData, actor_type: "driver", actor_id: own.id });

    // Acteurs « user » : membre de A et super admin gardés ; membre de B → « system » ; compte du partenaire → « driver »
    const admin = await createAuthUser(`sa-${tag()}@test.dev`, "Super Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [admin]);
    for (const [type, actor, expected] of [
      ["test.user.a", p.A.ownerId, { actor_type: "user", actor_id: p.A.ownerId }],
      ["test.user.sa", admin, { actor_type: "user", actor_id: admin }],
      ["test.user.b", p.B.ownerId, { actor_type: "system", actor_id: null }],
      ["test.user.partner", p.partner.userId, { actor_type: "driver", actor_id: null }],
    ] as const) {
      await log(type, "Action", {}, "user", actor);
      expect(await event(type), type).toMatchObject(expected);
    }

    // Course jamais passée par le réseau, ou ligne sans course : acteur d'une autre organisation gardé, comme avant le
    // réseau (interrupteur coupé : rien ne change)
    const site = nextSite();
    const plain = await createRideAsOwner(p.A, { pickup_lat: site[0], pickup_lng: site[1] });
    for (const rideId of [plain.id, null]) {
      for (const [type, actorType, actor] of [
        ["test.plain.user", "user", p.B.ownerId],
        ["test.plain.partner", "user", p.partner.userId],
        ["test.plain.driver", "driver", p.partner.id],
      ] as const) {
        await sql(`select private.log_event($1, $2, $3, 'Action', 'timeline', 'info', '{}'::jsonb, $4::public.actor_type, $5)`, [
          p.A.id, rideId, type, actorType, actor,
        ]);
        const [row] = await sql(
          `select actor_type, actor_id from public.ride_events
            where organization_id = $1 and ride_id is not distinct from $2::uuid and type = $3 order by id desc limit 1`,
          [p.A.id, rideId, type]);
        expect(row, `${type} ${rideId ? "course" : "sans course"}`).toEqual({ actor_type: actorType, actor_id: actor });
      }
    }
  });

  it("historique des statuts : chauffeur partenaire et membre de B jamais identifiés chez A ; chauffeur de A inchangé", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p);
    expect(await stepAs(p.partner, ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    // B retire son chauffeur du service (course rendue à A) : le membre de B n'apparaît pas chez A
    expect(await rpc(p.B.ownerId, "set_driver_status", [p.partner.id, "inactive", null])).toMatchObject({ ok: true });
    const history = await as({ sub: p.A.ownerId }, (q) =>
      q(`select from_status, to_status, actor_type, actor_id from public.ride_status_history where ride_id = $1 order by id`, [ride.id]));
    expect(history.find((h) => h.to_status === "ACCEPTED")).toMatchObject({ actor_type: "driver", actor_id: null });
    expect(history.find((h) => h.to_status === "DRIVER_EN_ROUTE")).toMatchObject({ actor_type: "driver", actor_id: null });
    expect(history.at(-1)).toMatchObject({ from_status: "DRIVER_EN_ROUTE", actor_type: "system", actor_id: null });
    expectNoPartnerIdentity(history, p);
    const events = await as({ sub: p.A.ownerId }, (q) => q(`select message, data, actor_id from public.ride_events where ride_id = $1`, [ride.id]));
    expectNoPartnerIdentity(events, p);

    // Course propre de A : acteur du chauffeur gardé
    const site = nextSite();
    const own = await createDriver(p.A, { firstName: "Paul", at: north(site, 100) });
    const ownRide = await createRideAsOwner(p.A, { pickup_lat: site[0], pickup_lng: site[1] });
    expect(await rpc(p.A.ownerId, "assign_ride", [ownRide.id, own.id])).toMatchObject({ ok: true });
    expect(await stepAs(own, ownRide.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    const [step] = await sql(`select actor_type, actor_id from public.ride_status_history where ride_id = $1 and to_status = 'DRIVER_EN_ROUTE'`, [ownRide.id]);
    expect(step).toEqual({ actor_type: "driver", actor_id: own.id });
  });

  it("alertes d'une course partenaire : libellé court, ni identifiant, ni n° interne, ni position, distance arrondie ; diffusion sans driver_id ; « Garder »", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p);
    const label = labelOf(p);
    // GPS muet depuis 10 min
    await moveTo(p.partner.id, p.site, 600);
    await sql("select private.watch_rides()");
    const [alert] = await sql(`select * from public.ride_alerts where ride_id = $1 and kind = 'no_gps'`, [ride.id]);
    expect(alert.message).toBe(`Plus de position GPS de ${label} depuis 10 min`);
    expect(alert.driver_id).toBe(p.partner.id); // colonne (clé « on delete set null ») : identifiant résiduel accepté
    expect(alert.data).toMatchObject({ driver_name: label, network: true, ride_number: Number(ride.number) });
    for (const k of ["driver_id", "driver_number", "lat", "lng"]) expect(alert.data, k).not.toHaveProperty(k);
    const [logged] = await sql(`select message, data, actor_id from public.ride_events where ride_id = $1 and type = 'alert.no_gps'`, [ride.id]);
    expect(logged).toMatchObject({ message: alert.message, actor_id: null, data: { driver_name: label, network: true } });
    expectNoPartnerIdentity([alert.message, alert.data, logged], p);
    // Diffusion sur org:{A} : sans identifiant ; « Garder » (sourdine) : réponse sans identifiant, journal au libellé court
    const [sent] = await sql(`select payload from realtime.messages where event = 'ride.alert' and payload ->> 'id' = $1 order by id desc limit 1`, [alert.id]);
    expect(sent.payload).toMatchObject({ driver_id: null, network: true, message: alert.message });
    const ack = await rpc(p.A.ownerId, "acknowledge_ride_alert", [alert.id]);
    expect(ack).toMatchObject({ ok: true, alert: { driver_id: null, network: true } });
    const [kept] = await sql(`select message from public.ride_events where ride_id = $1 and type = 'alert.kept'`, [ride.id]);
    expect(kept.message).toContain(`garde ${label}`);

    // Retard : chauffeur à ~20 km (distance exacte jamais multiple de 100 m), distance arrondie à 100 m
    let exact = 0;
    for (let offset = 20_123; exact % 100 === 0; offset += 37) {
      await moveTo(p.partner.id, north(p.site, offset));
      [{ exact }] = await sql(
        `select round(extensions.st_distance(l.location, r.pickup_location))::int as exact
           from public.driver_locations l, public.rides r where l.driver_id = $1 and r.id = $2`,
        [p.partner.id, ride.id],
      );
    }
    await sql("select private.watch_rides()");
    const [late] = await sql(`select message, data from public.ride_alerts where ride_id = $1 and kind = 'late'`, [ride.id]);
    expect(late.message.startsWith(`${label} sera en retard d'environ `)).toBe(true);
    expect(late.data.distance_m).toBe(Math.round(exact / 100) * 100);
    for (const k of ["driver_id", "driver_number", "lat", "lng"]) expect(late.data, k).not.toHaveProperty(k);
  });
});

describe("Positions (§11.6, Q5, partie 5b)", () => {
  it("course partenaire : points marqués (ride_org_id), invisibles pour B et pour A ; aucune position diffusée à B, « En course partenaire ({A}) » ; tout revient après la fin", async () => {
    const p = await networkPair();
    await location(p.partner, p.site); // avant la course : point visible par B
    const { ride } = await partnerAccepts(p);
    const marker = await lastMessageId();
    expect(await stepAs(p.partner, ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    await location(p.partner, north(p.site, 300));
    await location(p.partner, north(p.site, 150));
    expect(await historyOf(p.partner.id)).toEqual([
      { ride_id: null, ride_org_id: null },
      { ride_id: ride.id, ride_org_id: p.A.id },
      { ride_id: ride.id, ride_org_id: p.A.id },
    ]);
    // B : ses points seulement ; A : aucun (pas de carte du partenaire en v1) ; le chauffeur : tous
    const read = (sub: string) =>
      as({ sub }, (q) => q(`select ride_id, ride_org_id from public.driver_location_history where driver_id = $1`, [p.partner.id]));
    expect(await read(p.B.ownerId)).toEqual([{ ride_id: null, ride_org_id: null }]);
    expect(await read(p.A.ownerId)).toEqual([]);
    expect(await read(p.partner.userId)).toHaveLength(3);
    expect(await as({ sub: p.B.ownerId }, (q) => q(`select 1 from public.driver_locations where driver_id = $1`, [p.partner.id]))).toEqual([]);

    // Temps réel pendant la course : rien de la position ni de la course pour B
    const during = await messagesSince(marker, [`org:${p.B.id}`, `org:${p.A.id}`, `driver:${p.partner.id}`]);
    expect(during.filter((m) => m.event === "driver.location")).toEqual([]);
    const toB = during.filter((m) => m.topic === `org:${p.B.id}` && m.event === "driver.updated");
    expect(toB.length).toBeGreaterThan(0);
    for (const m of toB) {
      expect(m.payload).toMatchObject({ id: p.partner.id, current_ride_id: null, network: true, network_giver: p.aName });
    }
    // Le chauffeur lui-même : sa course en cours, comme avant
    const own = during.filter((m) => m.topic === `driver:${p.partner.id}` && m.event === "driver.updated");
    expect(own.at(-1)!.payload).toEqual({ id: p.partner.id, presence: "en_route", status: "active", current_ride_id: ride.id });

    // Fin de course : statut habituel, position de nouveau diffusée et visible par B
    for (const s of ["DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      await moveTo(p.partner.id, s === "COMPLETED" ? CDG : p.site);
      expect(await stepAs(p.partner, ride.id, s), s).toMatchObject({ ok: true });
    }
    const end = await lastMessageId();
    const [last] = (await messagesSince(marker, [`org:${p.B.id}`])).filter((m) => m.event === "driver.updated").slice(-1);
    expect(last!.payload).toMatchObject({ current_ride_id: null, presence: "available" });
    expect(last!.payload).not.toHaveProperty("network");
    expect(last!.payload).not.toHaveProperty("network_giver");
    // Hors course : un point par minute au plus (points précédents vieillis de 2 min pour en enregistrer un nouveau)
    await sql(`update public.driver_location_history set recorded_at = recorded_at - interval '2 minutes' where driver_id = $1`, [p.partner.id]);
    await location(p.partner, CDG);
    const after = await messagesSince(end, [`org:${p.B.id}`]);
    expect(after.filter((m) => m.event === "driver.location").map((m) => m.payload.driver_id)).toEqual([p.partner.id]);
    expect((await historyOf(p.partner.id)).at(-1)).toEqual({ ride_id: null, ride_org_id: null });
    expect(await read(p.B.ownerId)).toEqual([{ ride_id: null, ride_org_id: null }, { ride_id: null, ride_org_id: null }]);
  });

  it("ménage : points, rappels et notifications de vol d'une course partenaire supprimés 1 h après sa fin, jamais pendant ; points et règlements gardés", async () => {
    const p = await networkPair();
    await location(p.partner, p.site);
    const { ride, execution } = await partnerAccepts(p);
    expect(await stepAs(p.partner, ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    await location(p.partner, north(p.site, 200));
    const notify = (type: string) =>
      sql(`select private.queue_notification($1, $2, $3, null, $4, 'Test', '12 Avenue des Champs-Élysées', '{}'::jsonb) as id`, [
        p.A.id, p.partner.id, ride.id, type,
      ]);
    await notify("ride_reminder");
    await notify("flight_update");
    const partnerPoints = async () =>
      Number((await sql(`select count(*) as n from public.driver_location_history where driver_id = $1 and ride_org_id is not null`, [p.partner.id]))[0].n);
    const types = async () =>
      (await sql(`select type from public.notifications where ride_id = $1 and driver_id = $2 order by type`, [ride.id, p.partner.id])).map((x) => x.type);
    const housekeeping = async () => (await sql(`select private.housekeeping() as r`))[0].r;

    // Course en cours : rien n'est supprimé — même si le même chauffeur a tenu la même course plus tôt (exécution close
    // depuis 2 h, recréée sans déclencheurs : reprise par un chauffeur de A puis de nouveau proposée au réseau)
    await rewind([[
      `insert into public.ride_network_executions (ride_id, organization_id, executor_org_id, executor_driver_id, counterparty,
         driver_label, operator, vehicle, checks, terms, giver_terms_version, executor_terms_version, driver_terms_version,
         accepted_at, ended_at, end_reason)
       select ride_id, organization_id, executor_org_id, executor_driver_id, counterparty, driver_label, operator, vehicle, checks,
              terms, giver_terms_version, executor_terms_version, driver_terms_version, now() - interval '3 hours',
              now() - interval '2 hours', 'reassigned_own'
         from public.ride_network_executions where id = $1`,
      [execution.id],
    ]]);
    expect((await housekeeping()).errors).toBeUndefined();
    expect(await partnerPoints()).toBe(1);
    expect(await types()).toEqual(["flight_update", "ride_offer", "ride_reminder"]);
    for (const s of ["DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      await moveTo(p.partner.id, s === "COMPLETED" ? CDG : p.site);
      expect(await stepAs(p.partner, ride.id, s), s).toMatchObject({ ok: true });
    }
    // Fin il y a moins d'1 h : gardés
    await housekeeping();
    expect(await partnerPoints()).toBe(1);
    expect(await types()).toEqual(["flight_update", "ride_offer", "ride_reminder", "settlement_due"]);
    // Fin il y a plus d'1 h : points, rappels et vol supprimés ; offre (communes) et règlement gardés ; point propre gardé
    await rewind([[`update public.ride_network_executions set ended_at = now() - interval '61 minutes' where id = $1`, [execution.id]]]);
    const before = await housekeeping();
    expect(before.history_purged).toBeGreaterThanOrEqual(1);
    expect(before.notifications_purged).toBeGreaterThanOrEqual(2);
    expect(await partnerPoints()).toBe(0);
    expect(await historyOf(p.partner.id)).toEqual([{ ride_id: null, ride_org_id: null }]);
    expect(await types()).toEqual(["ride_offer", "settlement_due"]);
  });
});

describe("Temps réel (§13, §14.1 n° 32, partie 5b)", () => {
  it("cycle complet : org:{B} et fleet:{B} sans donnée de A ; org:{A} sans identifiant, distance, vague ni position du partenaire ; driver:{id} inchangé ; lignes lisibles par A sans identité du partenaire (n° 31)", async () => {
    const p = await networkPair({ giver: "centrale" });
    const topics = [`org:${p.A.id}`, `org:${p.B.id}`, `fleet:${p.B.id}`, `driver:${p.partner.id}`];
    const marker = await lastMessageId();
    const { ride, offer } = await partnerOffer(p);
    expect(await rpc(p.partner.userId, "accept_ride_offer", [offer.id])).toMatchObject({ ok: true, code: "ACCEPTED" });
    const [execution] = await sql(`select id from public.ride_network_executions where ride_id = $1`, [ride.id]);
    const accepted = await lastMessageId();
    // Positions de l'app, alerte GPS muet puis rétablie, étapes jusqu'à la fin (règlement : la centrale A encaisse)
    await moveTo(p.partner.id, p.site, 600);
    await sql("select private.watch_rides()");
    await moveTo(p.partner.id, p.site);
    await location(p.partner, north(p.site, 100));
    await finish(p.partner, ride.id, p.site);
    await sql("select private.watch_rides()");
    const ended = await lastMessageId();
    await location(p.partner, CDG);

    const msgs = await messagesSince(marker, topics);
    const of = (topic: string) => msgs.filter((m) => m.topic === topic);
    const orgA = of(`org:${p.A.id}`);
    const orgB = of(`org:${p.B.id}`);

    // org:{B} : ni identifiant de course, ni adresse, ni client, ni position pendant la course ; ids seulement
    expect(JSON.stringify(orgB)).not.toContain(ride.id);
    expectNoClientData(orgB);
    expect([...new Set(orgB.map((m) => m.event))].sort()).toEqual(["driver.location", "driver.updated", "network.updated"]);
    for (const m of orgB.filter((x) => x.event === "network.updated")) expect(m.payload).toEqual({ execution_id: execution.id });
    expect(orgB.filter((m) => m.event === "driver.location" && m.id > accepted && m.id <= ended)).toEqual([]);
    for (const m of orgB.filter((x) => x.event === "driver.updated" && x.id > accepted && x.id <= ended && x.payload.presence !== "available")) {
      expect(m.payload).toMatchObject({ current_ride_id: null, network: true, network_giver: p.aName });
    }
    expect(of(`fleet:${p.B.id}`)).toEqual([]);

    // org:{A} : jamais l'identifiant, le nom de famille, le n° interne ni la position du partenaire
    expectNoPartnerIdentity(orgA, p);
    expect(orgA.filter((m) => ["driver.location", "driver.updated"].includes(m.event))).toEqual([]);
    const offers = orgA.filter((m) => m.event === "offer.updated" && m.payload.id === offer.id);
    expect(offers.length).toBeGreaterThan(0);
    for (const m of offers) expect(m.payload).toMatchObject({ driver_id: null, distance_m: null, wave: null, network: true });
    const rides = orgA.filter((m) => m.event === "ride.updated" && m.payload.id === ride.id && m.id > accepted);
    expect(rides.length).toBeGreaterThan(0);
    for (const m of rides) expect(m.payload).toMatchObject({ driver_id: null, network: true, network_execution_id: execution.id });
    const alerts = orgA.filter((m) => m.event === "ride.alert");
    expect(alerts.length).toBeGreaterThan(0);
    for (const m of alerts) expect(m.payload).toMatchObject({ driver_id: null, network: true });
    expect(orgA.some((m) => m.event === "settlement.updated")).toBe(true);
    expect(orgA.filter((m) => m.event === "network.updated").every((m) => Object.keys(m.payload).join() === "ride_id")).toBe(true);

    // driver:{id} : le chauffeur reçoit sa course, son offre et son règlement (élément partenaire), comme avant
    const mine = of(`driver:${p.partner.id}`);
    expect(mine.some((m) => m.event === "ride.updated" && m.payload.driver_id === p.partner.id)).toBe(true);
    expect(mine.some((m) => m.event === "offer.updated" && m.payload.id === offer.id)).toBe(true);
    expect(mine.some((m) => m.event === "settlement.updated" && m.payload.network === true)).toBe(true);

    // n° 31 (lignes lisibles par A après le cycle) : journal, alertes (hors colonne driver_id), historique, notifications,
    // offres — ni identifiant, ni nom de famille, ni n° interne du partenaire ; libellé court seulement
    const asA = <T,>(text: string) => as({ sub: p.A.ownerId }, (q) => q<T & Record<string, unknown>>(text, [ride.id]));
    const rows = {
      events: await asA(`select type, message, data, actor_id from public.ride_events where ride_id = $1`),
      alerts: await asA(`select kind, message, data from public.ride_alerts where ride_id = $1`),
      history: await asA(`select to_status, actor_type, actor_id from public.ride_status_history where ride_id = $1`),
      notifications: await asA(`select type, title, body, data from public.notifications where ride_id = $1`),
      offers: await asA(`select id, driver_id from public.ride_offers where ride_id = $1`),
    };
    expectNoPartnerIdentity(rows, p);
    expect(rows.offers).toEqual([]);
    expect(JSON.stringify(rows.events)).toContain(`Karim T.`);
    // Le partenaire ne reçoit jamais commission, frais Rydar ni part dans ses notifications
    const partnerNotes = await sql(`select data from public.notifications where driver_id = $1`, [p.partner.id]);
    for (const n of partnerNotes) {
      for (const k of ["commission_cents", "platform_fee_cents", "driver_payout_cents"]) expect(n.data, k).not.toHaveProperty(k);
    }
  });
});

describe("Notifications (§13, partie 5b)", () => {
  it("montants internes retirés à toute insertion : chauffeur partenaire toujours, chauffeur de flotte s'ils sont renseignés ; centrale et organisation inchangées", async () => {
    const p = await networkPair({ giver: "centrale" });
    const { ride } = await partnerAccepts(p);
    const money = { commission_cents: 750, platform_fee_cents: 500, driver_payout_cents: 3750, amount_cents: 1250 };
    const queue = async (org: string, driver: string | null, rideId: string | null, data: Record<string, unknown> = money) =>
      (await sql(`select private.queue_notification($1, $2, $3, null, 'test_money', 'Test', 'Test', $4::jsonb) as id`, [
        org, driver, rideId, JSON.stringify(data),
      ]))[0].id as string;
    const dataOf = async (id: string) => (await sql(`select data from public.notifications where id = $1`, [id]))[0].data;

    // Partenaire (notification chez A) : jamais
    expect(await dataOf(await queue(p.A.id, p.partner.id, ride.id))).toEqual({ amount_cents: 1250 });
    // Chauffeur de la flotte B : montants renseignés retirés ; NULL (cas des courses de flotte) gardé tel quel
    const fleetDriver = await createDriver(p.B, {});
    expect(await dataOf(await queue(p.B.id, fleetDriver.id, null))).toEqual({ amount_cents: 1250 });
    const nulls = { commission_cents: null, platform_fee_cents: null, driver_payout_cents: null, x: 1 };
    expect(await dataOf(await queue(p.B.id, fleetDriver.id, null, nulls))).toEqual(nulls);
    // Chauffeur de la centrale A (part affichée dans ses offres) et notification de l'organisation : inchangés
    const centraleDriver = await createDriver(p.A, {});
    expect(await dataOf(await queue(p.A.id, centraleDriver.id, null))).toEqual(money);
    expect(await dataOf(await queue(p.A.id, null, null))).toEqual(money);
    // Insertion directe (offres de run_geo_wave) : même règle
    const [direct] = await sql(
      `insert into public.notifications (organization_id, driver_id, ride_id, type, title, body, data)
       values ($1, $2, $3, 'test_money', 'Test', 'Test', $4::jsonb) returning data`,
      [p.A.id, p.partner.id, ride.id, JSON.stringify(money)],
    );
    expect(direct.data).toEqual({ amount_cents: 1250 });
  });
});

describe("Webhooks et API (§11.7, partie 5b)", () => {
  it("course partagée : webhooks de A seulement ; « driver » = prénom, véhicule figé, exploitant (même objet que l'API) ; null 24 h après la fin ; colonne réservée au service role", async () => {
    const p = await networkPair();
    const endpoint = async (org: Org) => {
      const [{ r }] = await as({ role: "service_role" }, (q) =>
        q(`select public.svc_webhook_upsert($1::uuid, $2::text, null, null, null, 'user'::public.actor_type, $3::uuid) as r`, [
          org.id, `https://hooks-${tag()}.example.com/rydar`, org.ownerId,
        ]));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r.endpoint.id as string;
    };
    const epA = await endpoint(p.A);
    const epB = await endpoint(p.B);
    const [vehicle] = await sql(`update public.vehicles set brand = 'Toyota', color = 'Gris' where id = $1 returning model, plate`, [p.partner.vehicleId]);
    const { ride, execution } = await partnerAccepts(p);
    // Véhicule changé après l'acceptation : l'instantané reste celui de la course
    await sql(`update public.vehicles set color = 'Rouge' where id = $1`, [p.partner.vehicleId]);
    const ridePayload = async () => (await sql(`select private.webhook_ride_json($1) as j`, [ride.id]))[0].j;
    const expected = {
      first_name: "Karim",
      vehicle: { brand: "Toyota", model: vehicle.model, color: "Gris", plate: vehicle.plate },
      operator: { name: `${p.bName} SAS` },
    };
    expect((await ridePayload()).driver).toEqual(expected);
    const [{ d }] = await as({ role: "service_role" }, (q) => q(`select public.ride_public_driver(r) as d from public.rides r where r.id = $1`, [ride.id]));
    expect(d).toEqual(expected);
    expectNoPartnerIdentity(await ridePayload(), p, ["+3363"]);
    expectNoClientData((await ridePayload()).driver);

    // Envois : webhooks de A seulement, jamais ceux de B
    const deliveries = await sql(`select endpoint_id, event_type from public.webhook_deliveries where ride_id = $1`, [ride.id]);
    expect(deliveries.filter((x) => x.endpoint_id === epB).length).toBe(0);
    expect(deliveries.filter((x) => x.endpoint_id === epA).map((x) => x.event_type)).toContain("ride.accepted");

    // Fin de course : chauffeur encore là 24 h, puis null
    await finish(p.partner, ride.id, p.site);
    expect((await ridePayload()).driver).toEqual(expected);
    await rewind([[`update public.ride_network_executions set ended_at = now() - interval '25 hours' where id = $1`, [execution.id]]]);
    expect((await ridePayload()).driver).toBeNull();
    expect(await sql(`select endpoint_id from public.webhook_deliveries where endpoint_id = $1`, [epB])).toEqual([]);

    // Colonne calculée de l'API : jamais pour un client (anon, membre)
    for (const who of [{ role: "anon" as const }, { sub: p.A.ownerId }]) {
      const e = await expectPgError(as(who, (q) => q(`select public.ride_public_driver(null::public.rides)`)));
      expect(e.code, JSON.stringify(who)).toBe("42501");
    }
    await sql(`delete from public.webhook_deliveries where endpoint_id = any ($1)`, [[epA, epB]]);
    await sql(`delete from public.webhook_endpoints where id = any ($1)`, [[epA, epB]]);
  });
});
