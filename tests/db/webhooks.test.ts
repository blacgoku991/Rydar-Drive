// Webhooks sortants (migrations 20260924006000_webhooks et 20260924006100_webhooks_hardening) : détection des événements
// sur les courses (création, cycle du chauffeur, attribution, retrait, annulation, fin de recherche, relance, heure
// modifiée ; centrale suspendue ou offre sans l'API : rien), filtrage par adresse, prise et compte rendu du worker (forme
// de « ride », un envoi en cours par adresse, tour de rôle entre centrales, verrous, reprises, désactivation
// automatique, comptes rendus simultanés), conservation, fonctions svc_* (validation, ajout ou mise à jour, secret,
// plafond, tests et renvois bornés, isolement des centrales, journal d'audit) et droits d'accès.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createDriver, createMember, createOrg, createRideAsOwner, DB_URL, expectPgError,
  inMinutes, insertRideBypass, nextWave, north, pool, rideState, sql, type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, any>;
type Actor = { type: string; id: string | null };

const EVENTS = [
  "ride.created", "ride.accepted", "ride.driver_unassigned", "ride.driver_en_route", "ride.driver_arrived",
  "ride.passenger_onboard", "ride.in_progress", "ride.completed", "ride.cancelled", "ride.no_driver_found",
  "ride.search_restarted", "ride.rescheduled",
];
const AUTO_DISABLED = "Désactivé automatiquement : 50 échecs consécutifs et aucun envoi réussi depuis 3 jours";
const DELAYS = [60, 300, 900, 3600, 10800, 21600, 43200, 86400];
const CHAIN = ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"];
const ENDPOINT_KEYS = [
  "created_at", "description", "disabled_reason", "enabled", "events", "id", "last_error", "last_failure_at",
  "last_success_at", "url",
];
// Colonnes de PUBLIC_RIDE_SELECT (apps/web/lib/api/v1.ts) + updated_at
const RIDE_KEYS = [
  "id", "number", "type", "status", "pickup_address", "pickup_lat", "pickup_lng", "dropoff_address", "dropoff_lat",
  "dropoff_lng", "pickup_at", "passengers", "luggage", "vehicle_category", "price_cents", "currency", "payment_method",
  "flight_number", "external_reference", "estimated_distance_m", "estimated_duration_s", "route_polyline", "created_at",
  "accepted_at", "driver_arrived_at", "started_at", "completed_at", "cancelled_at", "driver", "updated_at",
].sort();
const CLAIM_KEYS = [
  "attempts", "endpoint_id", "event_status", "event_type", "id", "occurred_at", "organization_id", "previous_status",
  "ride", "secret", "url",
];

const hookUrl = (label = "hooks") => `https://${label}-${randomUUID().slice(0, 8)}.example.com/rydar`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// Outils : fonctions svc_* (web, service role)
// -----------------------------------------------------------------------------
const ownerOf = (org: Org): Actor => ({ type: "user", id: org.ownerId });

async function svc(text: string, params: unknown[]): Promise<Row> {
  const [row] = await as({ role: "service_role" }, (q) => q(text, params));
  return row.r as Row;
}

function upsert(
  org: Org,
  url: string | null,
  o: { description?: string | null; events?: (string | null)[] | null; secret?: string | null; actor?: Actor; orgId?: string | null } = {},
) {
  const actor = o.actor ?? ownerOf(org);
  return svc(
    `select public.svc_webhook_upsert($1::uuid, $2::text, $3::text, $4::text[], $5::text, $6::public.actor_type, $7::uuid) as r`,
    [o.orgId === undefined ? org.id : o.orgId, url, o.description ?? null, o.events ?? null, o.secret ?? null, actor.type, actor.id],
  );
}
const remove = (org: Org, id: string | null, actor = ownerOf(org)) =>
  svc(`select public.svc_webhook_delete($1::uuid, $2::uuid, $3::public.actor_type, $4::uuid) as r`, [org.id, id, actor.type, actor.id]);
const setEnabled = (org: Org, id: string, enabled: boolean | null, actor = ownerOf(org)) =>
  svc(`select public.svc_webhook_set_enabled($1::uuid, $2::uuid, $3::boolean, $4::public.actor_type, $5::uuid) as r`,
    [org.id, id, enabled, actor.type, actor.id]);
const rotate = (org: Org, id: string, actor = ownerOf(org)) =>
  svc(`select public.svc_webhook_rotate_secret($1::uuid, $2::uuid, $3::public.actor_type, $4::uuid) as r`, [org.id, id, actor.type, actor.id]);
const ping = (org: Org, id: string, actor = ownerOf(org)) =>
  svc(`select public.svc_webhook_ping($1::uuid, $2::uuid, $3::public.actor_type, $4::uuid) as r`, [org.id, id, actor.type, actor.id]);
const redeliver = (org: Org, id: string, actor = ownerOf(org)) =>
  svc(`select public.svc_webhook_redeliver($1::uuid, $2::uuid, $3::public.actor_type, $4::uuid) as r`, [org.id, id, actor.type, actor.id]);

type Endpoint = { id: string; url: string; secret: string | null; events: string[]; enabled: boolean };

/** Webhook actif de la centrale (events vide = tous). */
async function addEndpoint(org: Org, events: string[] = [], url = hookUrl()): Promise<Endpoint> {
  const r = await upsert(org, url, { events });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return { ...r.endpoint, secret: r.secret } as Endpoint;
}

const secretOf = async (endpointId: string) =>
  (await sql(`select secret from public.webhook_endpoint_secrets where endpoint_id = $1`, [endpointId]))[0]?.secret as string | undefined;
const endpointRow = async (id: string) => (await sql(`select * from public.webhook_endpoints where id = $1`, [id]))[0] as Row;
const deliveryRow = async (id: string) => (await sql(`select * from public.webhook_deliveries where id = $1`, [id]))[0] as Row;

// -----------------------------------------------------------------------------
// Outils : courses
// -----------------------------------------------------------------------------
const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};

/** Course reçue par l'API (POST /api/v1/rides : service role, source « api »). */
async function apiRide(org: Org, over: Row = {}): Promise<string> {
  const ride: Row = {
    organization_id: org.id,
    source: "api",
    pickup_address: "12 Avenue des Champs-Élysées, 75008 Paris",
    pickup_lat: CHAMPS_ELYSEES[0],
    pickup_lng: CHAMPS_ELYSEES[1],
    dropoff_address: "Gare du Nord, 75010 Paris",
    customer_name: "Client API",
    customer_phone: "+33600000009",
    vehicle_category: "business",
    price_cents: 6500,
    external_reference: `RP-${randomUUID().slice(0, 5).toUpperCase()}`,
    ...over,
  };
  const cols = Object.keys(ride);
  const [row] = await as({ role: "service_role" }, (q) =>
    q(`insert into public.rides (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(ride)),
  );
  return row.id as string;
}

/** Offre GPS acceptée par le chauffeur (vagues suivantes si besoin). */
async function acceptOffer(d: Driver, rideId: string) {
  let offer = (await rideState(rideId)).offers.find((o) => o.driver_id === d.id && o.status === "pending");
  for (let w = 1; !offer && w < 4; w++) {
    await nextWave(rideId);
    offer = (await rideState(rideId)).offers.find((o) => o.driver_id === d.id && o.status === "pending");
  }
  expect(offer, "offre en attente").toBeDefined();
  expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
}

async function drive(d: Driver, rideId: string, statuses = CHAIN) {
  for (const s of statuses) {
    const r = await rpc(d.userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

const deliveriesOf = (rideId: string, endpointId: string | null = null) =>
  sql(
    `select * from public.webhook_deliveries where ride_id = $1 and ($2::uuid is null or endpoint_id = $2)
      order by occurred_at, event_type`,
    [rideId, endpointId],
  );
/** [type, statut, statut précédent] des envois d'une course, dans l'ordre des événements. */
const triples = async (rideId: string, endpointId: string | null = null) =>
  (await deliveriesOf(rideId, endpointId)).map((d) => [d.event_type, d.event_status, d.previous_status]);
const typesOf = async (endpointId: string) =>
  (await sql(`select event_type from public.webhook_deliveries where endpoint_id = $1 order by occurred_at, event_type`, [endpointId]))
    .map((r) => r.event_type as string);
const rideStatus = async (rideId: string) => (await sql(`select status from public.rides where id = $1`, [rideId]))[0].status as string;

// -----------------------------------------------------------------------------
// Outils : worker (connexion directe, rôle propriétaire)
// -----------------------------------------------------------------------------
const claim = (limit: number | null = 10) => sql(`select * from private.claim_webhook_deliveries($1::integer)`, [limit]);
const complete = (id: string, ok: boolean, code: number | null = null, error: string | null = null) =>
  sql(`select private.complete_webhook_delivery($1::uuid, $2::boolean, $3::integer, $4::text)`, [id, ok, code, error]);
const purge = async () => (await sql(`select private.purge_webhook_deliveries() as n`))[0].n as number;

/** Envoi ajouté directement (fixtures). */
async function insertDelivery(org: Org, endpointId: string, over: Row = {}): Promise<Row> {
  const row: Row = { organization_id: org.id, endpoint_id: endpointId, event_type: "ping", ...over };
  const cols = Object.keys(row);
  const [r] = await sql(
    `insert into public.webhook_deliveries (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(row),
  );
  return r;
}

/** Envoi dû maintenant puis pris par le worker. */
async function claimOne(id: string) {
  await sql(`update public.webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = $1 and status = 'pending'`, [id]);
  const rows = await claim(100);
  const row = rows.find((r) => r.id === id);
  expect(row, "envoi pris").toBeDefined();
  return row as Row;
}

/** Tout ce qui est dû, comme le worker : un envoi par adresse à la fois, chaque envoi pris rendu « envoyé » avant la
 *  prise suivante. Renvoie les envois dans l'ordre où ils ont été pris. */
async function claimAll(limit = 10): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < 50; i++) {
    const rows = await claim(limit);
    if (rows.length === 0) break;
    for (const r of rows) await complete(r.id, true, 200);
    out.push(...rows);
  }
  return out;
}

async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql("update public.users set is_super_admin = true where id = $1", [id]);
  return id;
}

async function apiKey(org: Org): Promise<string> {
  const [k] = await sql(
    `insert into public.api_keys (organization_id, name, prefix, last4, scopes)
     values ($1, 'Clé webhooks', $2, 'abcd', '{rides:create,rides:read,webhooks:manage}') returning id`,
    [org.id, `rdk_live_${randomUUID().replace(/-/g, "").slice(0, 12)}`],
  );
  return k.id as string;
}

// =============================================================================
// Détection des événements
// =============================================================================
describe("Webhooks : événements des courses", () => {
  it("course reçue par l'API : ride.created seul (les étapes du dispatch ne produisent rien)", async () => {
    const org = await createOrg("WH API");
    const ep = await addEndpoint(org);
    const rideId = await apiRide(org);

    expect(await rideStatus(rideId)).not.toBe("CREATED");
    const rows = await deliveriesOf(rideId);
    expect(rows.map((d) => [d.event_type, d.event_status, d.previous_status])).toEqual([["ride.created", "CREATED", null]]);
    expect(rows[0]).toMatchObject({
      organization_id: org.id, endpoint_id: ep.id, ride_id: rideId, status: "pending", attempts: 0,
      locked_until: null, last_status_code: null, last_error: null, delivered_at: null,
    });
    expect(rows[0].next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("offre acceptée puis cycle complet du chauffeur : accepted, en route, arrivé, à bord, démarrée, terminée", async () => {
    const org = await createOrg("WH Cycle");
    await addEndpoint(org);
    const d = await createDriver(org, { firstName: "Yanis", at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    await acceptOffer(d, ride.id);
    await drive(d, ride.id);

    expect(await triples(ride.id)).toEqual([
      ["ride.created", "CREATED", null],
      ["ride.accepted", "ACCEPTED", "OFFERED"],
      ["ride.driver_en_route", "DRIVER_EN_ROUTE", "ACCEPTED"],
      ["ride.driver_arrived", "DRIVER_ARRIVED", "DRIVER_EN_ROUTE"],
      ["ride.passenger_onboard", "PASSENGER_ONBOARD", "DRIVER_ARRIVED"],
      ["ride.in_progress", "IN_PROGRESS", "PASSENGER_ONBOARD"],
      ["ride.completed", "COMPLETED", "IN_PROGRESS"],
    ]);
    // Heures strictement croissantes
    const at = (await deliveriesOf(ride.id)).map((r) => r.occurred_at.getTime());
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("attribution manuelle, réattribution à un autre chauffeur (accepted), même chauffeur (rien), retrait (driver_unassigned)", async () => {
    const org = await createOrg("WH Attribution");
    await addEndpoint(org);
    const a = await createDriver(org, { firstName: "Amel", presence: "offline" });
    const b = await createDriver(org, { firstName: "Bruno", presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(180) });
    expect(ride.type).toBe("scheduled");
    const before = await rideStatus(ride.id);

    expect((await rpc(org.ownerId, "assign_ride", [ride.id, a.id])).code).toBe("ASSIGNED");
    expect((await rpc(org.ownerId, "assign_ride", [ride.id, b.id])).code).toBe("ASSIGNED");
    expect((await rpc(org.ownerId, "assign_ride", [ride.id, b.id])).code).toBe("UNCHANGED");
    const res = await rpc(org.ownerId, "reassign_ride", [ride.id, "Chauffeur malade", null]);
    expect(res.code).toBe("RELAUNCHED");

    expect(await triples(ride.id)).toEqual([
      ["ride.created", "CREATED", null],
      ["ride.accepted", "ACCEPTED", before],
      ["ride.accepted", "ACCEPTED", "ACCEPTED"],
      // Heure future inchangée : pas de ride.rescheduled ; relance à la flotte ensuite : rien
      ["ride.driver_unassigned", "SEARCHING_DRIVER", "ACCEPTED"],
    ]);
  });

  it("retrait sans dispatch automatique : course en attente (CREATED) → driver_unassigned", async () => {
    const org = await createOrg("WH Retrait manuel", { settings: { auto_dispatch: false } });
    await addEndpoint(org);
    const d = await createDriver(org, { firstName: "Chloé" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(120) });
    expect(await rideStatus(ride.id)).toBe("CREATED");
    expect((await rpc(org.ownerId, "assign_ride", [ride.id, d.id])).code).toBe("ASSIGNED");
    expect((await rpc(org.ownerId, "reassign_ride", [ride.id, null, d.id])).code).toBe("UNASSIGNED");

    expect(await triples(ride.id)).toEqual([
      ["ride.created", "CREATED", null],
      ["ride.accepted", "ACCEPTED", "CREATED"],
      ["ride.driver_unassigned", "CREATED", "ACCEPTED"],
    ]);
  });

  it("retrait d'une course immédiate déjà à l'heure : driver_unassigned puis rescheduled (heure remise à maintenant), dans cet ordre", async () => {
    const org = await createOrg("WH Retrait immédiat");
    await addEndpoint(org);
    const d = await createDriver(org, { firstName: "Driss", at: north(CHAMPS_ELYSEES, 600) });
    const ride = await createRideAsOwner(org);
    await acceptOffer(d, ride.id);
    await sleep(20);
    expect((await rpc(org.ownerId, "reassign_ride", [ride.id, null, d.id])).ok).toBe(true);

    const rows = await deliveriesOf(ride.id);
    expect(rows.map((r) => [r.event_type, r.event_status, r.previous_status]).slice(2)).toEqual([
      ["ride.driver_unassigned", "SEARCHING_DRIVER", "ACCEPTED"],
      ["ride.rescheduled", "SEARCHING_DRIVER", "ACCEPTED"],
    ]);
    const [unassigned, rescheduled] = rows.slice(2);
    expect(rescheduled.occurred_at.getTime()).toBeGreaterThanOrEqual(unassigned.occurred_at.getTime());
  });

  it("annulation par la centrale (cancel_ride) et par l'API (svc_cancel_ride) : ride.cancelled", async () => {
    const org = await createOrg("WH Annulation");
    await addEndpoint(org);
    const d = await createDriver(org, { firstName: "Elsa", presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(90) });
    expect((await rpc(org.ownerId, "assign_ride", [ride.id, d.id])).code).toBe("ASSIGNED");
    expect((await rpc(org.ownerId, "cancel_ride", [ride.id, "Client absent"])).code).toBe("CANCELLED");
    expect((await triples(ride.id)).at(-1)).toEqual(["ride.cancelled", "CANCELLED", "ACCEPTED"]);

    const viaApi = await apiRide(org);
    const before = await rideStatus(viaApi);
    const res = await svc(`select public.svc_cancel_ride($1::uuid, $2::uuid, $3::text, 'api') as r`, [org.id, viaApi, "Annulée par le site"]);
    expect(res.code).toBe("CANCELLED");
    expect(await triples(viaApi)).toEqual([
      ["ride.created", "CREATED", null],
      ["ride.cancelled", "CANCELLED", before],
    ]);
  });

  it("dispatch sans chauffeur jusqu'au bout : ride.no_driver_found une seule fois ; « Relancer » une course passée → search_restarted puis rescheduled", async () => {
    const org = await createOrg("WH Sans chauffeur");
    await addEndpoint(org);
    const ride = await createRideAsOwner(org);
    for (let i = 0; i < 12 && (await rideStatus(ride.id)) !== "NO_DRIVER_FOUND"; i++) await nextWave(ride.id);
    expect(await rideStatus(ride.id)).toBe("NO_DRIVER_FOUND");

    const t = await triples(ride.id);
    expect(t.map((x) => x[0])).toEqual(["ride.created", "ride.no_driver_found"]);
    const [, ended] = t;
    expect(ended![1]).toBe("NO_DRIVER_FOUND");
    expect(["SEARCHING_DRIVER", "OFFERED"]).toContain(ended![2]);

    // Relance : de nouveau en recherche (search_restarted) et heure remise à maintenant (rescheduled), dans cet ordre
    expect((await rpc(org.ownerId, "redispatch_ride", [ride.id])).code).toBe("RELAUNCHED");
    expect((await triples(ride.id)).slice(2)).toEqual([
      ["ride.search_restarted", "SEARCHING_DRIVER", "NO_DRIVER_FOUND"],
      ["ride.rescheduled", "SEARCHING_DRIVER", "NO_DRIVER_FOUND"],
    ]);
  });

  it("« Relancer » une course sans chauffeur dont l'heure est à venir : search_restarted seul (heure inchangée)", async () => {
    const org = await createOrg("WH Relance future");
    const ep = await addEndpoint(org);
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(180) });
    expect(ride.type).toBe("scheduled");
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND', no_driver_at = now() where id = $1`, [ride.id]);
    expect((await triples(ride.id, ep.id)).map((x) => x[0])).toEqual(["ride.created", "ride.no_driver_found"]);

    expect((await rpc(org.ownerId, "redispatch_ride", [ride.id])).code).toBe("RELAUNCHED");
    const after = (await triples(ride.id, ep.id)).slice(2);
    expect(after).toEqual([["ride.search_restarted", "SEARCHING_DRIVER", "NO_DRIVER_FOUND"]]);

    // Deuxième recherche sans chauffeur : de nouveau ride.no_driver_found (le destinataire voit l'aller-retour)
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND', no_driver_at = now() where id = $1`, [ride.id]);
    expect((await triples(ride.id, ep.id)).slice(3).map((x) => x[0])).toEqual(["ride.no_driver_found"]);

    // Abonnement limité aux autres événements : rien de nouveau pour cette adresse
    const other = await addEndpoint(org, ["ride.completed"]);
    expect((await rpc(org.ownerId, "redispatch_ride", [ride.id])).code).toBe("RELAUNCHED");
    expect(await typesOf(other.id)).toEqual([]);
  });

  it("vol retardé d'une course sans chauffeur remise en service (requalified fleet) : rescheduled puis search_restarted ; relance refusée : rescheduled seul", async () => {
    const org = await createOrg("WH Vol relance");
    const ep = await addEndpoint(org);
    const MIN = 60_000;
    const T0 = new Date(Math.ceil((Date.now() + 30 * MIN) / MIN) * MIN);
    const airportRide = () =>
      createRideAsOwner(org, {
        pickup_address: "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France",
        pickup_lat: 49.0047, pickup_lng: 2.571, flight_number: "AF 7777", pickup_at: T0.toISOString(),
      });
    const apply = async (rideId: string, scheduled: Date, estimated: Date) =>
      (await sql("select private.apply_flight_status($1, 'delayed', $2, $3, null, null, null, 'test', null) as r", [
        rideId, scheduled, estimated,
      ]))[0].r as Row;

    const ride = await airportRide();
    expect(ride.type).toBe("instant");
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND', no_driver_at = now() where id = $1`, [ride.id]);
    const S = new Date(T0.getTime() - 15 * MIN);
    const res = await apply(ride.id, S, new Date(S.getTime() + 150 * MIN));
    expect(res).toMatchObject({ pickup_changed: true, requalified: "fleet" });
    expect(await rideStatus(ride.id)).toBe("SEARCHING_DRIVER");
    expect((await triples(ride.id, ep.id)).slice(2)).toEqual([
      ["ride.rescheduled", "NO_DRIVER_FOUND", "NO_DRIVER_FOUND"],
      ["ride.search_restarted", "SEARCHING_DRIVER", "NO_DRIVER_FOUND"],
    ]);

    // Relance refusée (quota mensuel atteint) : la course reste sans chauffeur, son heure suit le vol → rescheduled seul
    const blocked = await airportRide();
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND', no_driver_at = now() where id = $1`, [blocked.id]);
    await sql(`update public.organizations set limits_override = '{"max_rides_per_month": 1}' where id = $1`, [org.id]);
    const res2 = await apply(blocked.id, S, new Date(S.getTime() + 150 * MIN));
    expect(res2).toMatchObject({ pickup_changed: true, requalified: null });
    expect(await rideStatus(blocked.id)).toBe("NO_DRIVER_FOUND");
    expect((await triples(blocked.id, ep.id)).slice(2)).toEqual([["ride.rescheduled", "NO_DRIVER_FOUND", "NO_DRIVER_FOUND"]]);
  });

  it("centrale suspendue ou archivée, offre sans l'API : aucun événement enregistré ; de nouveau active avec l'API : événements", async () => {
    const org = await createOrg("WH Centrale inactive");
    const ep = await addEndpoint(org);
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(240) });
    expect(await typesOf(ep.id)).toEqual(["ride.created"]);
    const shift = () => sql(`update public.rides set pickup_at = pickup_at + interval '10 minutes' where id = $1`, [ride.id]);

    for (const status of ["suspended", "archived"]) {
      await sql(`update public.organizations set status = $2 where id = $1`, [org.id, status]);
      await shift();
      expect(await typesOf(ep.id), status).toEqual(["ride.created"]);
    }
    await sql(`update public.organizations set status = 'active' where id = $1`, [org.id]);
    await shift();
    expect(await typesOf(ep.id)).toEqual(["ride.created", "ride.rescheduled"]);

    // Offre sans l'API (surcharge du super admin, mêmes règles que l'API v1) : rien ; de nouveau incluse : événements
    await sql(`update public.organizations set limits_override = '{"api_access": false}' where id = $1`, [org.id]);
    await shift();
    expect(await typesOf(ep.id)).toHaveLength(2);
    const plan = await sql(
      `insert into public.plans (code, name, limits) values ($1, 'Sans API', '{"api_access": false}') returning id`,
      [`wh_no_api_${randomUUID().slice(0, 8)}`],
    );
    await sql(`update public.organizations set limits_override = '{}', plan_id = $2 where id = $1`, [org.id, plan[0].id]);
    await shift();
    expect(await typesOf(ep.id)).toHaveLength(2);
    // Centrale sans offre : tout est inclus (private.org_limits, comme l'API v1)
    await sql(`update public.organizations set plan_id = null where id = $1`, [org.id]);
    await shift();
    expect(await typesOf(ep.id)).toEqual(["ride.created", "ride.rescheduled", "ride.rescheduled"]);
    // Surcharge en chaîne : « true » vaut oui (comme ::boolean de limits_audit), une valeur mal formée vaut non, sans
    // jamais faire échouer la course
    await sql(`update public.organizations set plan_id = $2, limits_override = '{"api_access": "true"}' where id = $1`, [org.id, plan[0].id]);
    await shift();
    expect(await typesOf(ep.id)).toHaveLength(4);
    await sql(`update public.organizations set limits_override = '{"api_access": {"x": 1}}' where id = $1`, [org.id]);
    await shift();
    expect(await typesOf(ep.id)).toHaveLength(4);
  });

  it("heure de prise en charge modifiée : rescheduled (même statut, course sans chauffeur comprise) ; rien pour une course terminée ou annulée", async () => {
    const org = await createOrg("WH Heure");
    await addEndpoint(org);
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(240) });
    const status = await rideStatus(ride.id);
    await sql(`update public.rides set pickup_at = pickup_at + interval '30 minutes' where id = $1`, [ride.id]);
    expect((await triples(ride.id)).slice(1)).toEqual([["ride.rescheduled", status, status]]);

    // Même heure réécrite : rien
    await sql(`update public.rides set pickup_at = pickup_at where id = $1`, [ride.id]);
    expect(await deliveriesOf(ride.id)).toHaveLength(2);

    for (const closed of ["CANCELLED", "COMPLETED"]) {
      const r = await createRideAsOwner(org, { pickup_at: inMinutes(300) });
      await sql(`update public.rides set status = $2 where id = $1`, [r.id, closed]);
      const n = (await deliveriesOf(r.id)).length;
      await sql(`update public.rides set pickup_at = pickup_at + interval '1 hour' where id = $1`, [r.id]);
      expect(await deliveriesOf(r.id), closed).toHaveLength(n);
      // Statut et heure changés ensemble vers un statut final : l'événement de statut seulement
      const r2 = await createRideAsOwner(org, { pickup_at: inMinutes(300) });
      await sql(`update public.rides set status = $2, pickup_at = pickup_at + interval '1 hour' where id = $1`, [r2.id, closed]);
      expect((await triples(r2.id)).slice(1).map((x) => x[0]), closed).toEqual([
        { CANCELLED: "ride.cancelled", COMPLETED: "ride.completed" }[closed],
      ]);
    }

    // Course sans chauffeur : pas finale (relance, vol retardé) → son heure modifiée est signalée
    const ndf = await createRideAsOwner(org, { pickup_at: inMinutes(300) });
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND' where id = $1`, [ndf.id]);
    await sql(`update public.rides set pickup_at = pickup_at + interval '1 hour' where id = $1`, [ndf.id]);
    const t = (await triples(ndf.id)).slice(1);
    expect(t.map((x) => x[0])).toEqual(["ride.no_driver_found", "ride.rescheduled"]);
    expect(t[1]).toEqual(["ride.rescheduled", "NO_DRIVER_FOUND", "NO_DRIVER_FOUND"]);
    const ndf2 = await createRideAsOwner(org, { pickup_at: inMinutes(300) });
    await sql(`update public.rides set status = 'NO_DRIVER_FOUND', pickup_at = pickup_at + interval '1 hour' where id = $1`, [ndf2.id]);
    expect((await triples(ndf2.id)).slice(1).map((x) => x[0])).toEqual(["ride.no_driver_found", "ride.rescheduled"]);
  });

  it("statut et heure changés par la même requête : événement de statut puis rescheduled (1 µs plus tard)", async () => {
    const org = await createOrg("WH Double");
    await addEndpoint(org);
    const d = await createDriver(org, { firstName: "Farid", presence: "offline" });
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(100) });
    expect((await rpc(org.ownerId, "assign_ride", [ride.id, d.id])).code).toBe("ASSIGNED");
    await sql(`update public.rides set status = 'DRIVER_EN_ROUTE', pickup_at = pickup_at + interval '5 minutes' where id = $1`, [ride.id]);

    const rows = (await deliveriesOf(ride.id)).slice(2);
    expect(rows.map((r) => [r.event_type, r.event_status, r.previous_status])).toEqual([
      ["ride.driver_en_route", "DRIVER_EN_ROUTE", "ACCEPTED"],
      ["ride.rescheduled", "DRIVER_EN_ROUTE", "ACCEPTED"],
    ]);
    const [{ diff }] = await sql(
      `select extract(epoch from (b.occurred_at - a.occurred_at)) * 1000000 as diff
         from public.webhook_deliveries a, public.webhook_deliveries b where a.id = $1 and b.id = $2`,
      [rows[0].id, rows[1].id],
    );
    expect(Number(diff)).toBe(1);
  });

  it("transitions internes (vague suivante, offre expirée, chauffeur changé hors « acceptée ») : aucun événement", async () => {
    const org = await createOrg("WH Bruit");
    await addEndpoint(org);
    const far = await createDriver(org, { firstName: "Gilles", at: north(CHAMPS_ELYSEES, 10_000) });
    const ride = await createRideAsOwner(org);
    await nextWave(ride.id, 3);
    expect((await rideState(ride.id)).offers.some((o) => o.driver_id === far.id)).toBe(true);
    await sql(`update public.rides set status = 'SEARCHING_DRIVER' where id = $1`, [ride.id]);
    await sql(`update public.rides set status = 'OFFERED' where id = $1`, [ride.id]);
    expect((await triples(ride.id)).map((x) => x[0])).toEqual(["ride.created"]);

    // Course en route : chauffeur remplacé sans changement de statut → rien (seul « acceptée » le signale)
    const d1 = await createDriver(org, { firstName: "Hugo", presence: "offline" });
    const d2 = await createDriver(org, { firstName: "Inès", presence: "offline" });
    const r = await createRideAsOwner(org, { pickup_at: inMinutes(200) });
    expect((await rpc(org.ownerId, "assign_ride", [r.id, d1.id])).code).toBe("ASSIGNED");
    await sql(`update public.rides set status = 'DRIVER_EN_ROUTE' where id = $1`, [r.id]);
    await sql(`update public.rides set driver_id = $2 where id = $1`, [r.id, d2.id]);
    expect((await triples(r.id)).map((x) => x[0])).toEqual(["ride.created", "ride.accepted", "ride.driver_en_route"]);
  });

  it("filtrage : chaque adresse ne reçoit que ses événements ; adresse désactivée et autre centrale : rien", async () => {
    const org = await createOrg("WH Filtres");
    const other = await createOrg("WH Autre centrale");
    const all = await addEndpoint(org);
    const finals = await addEndpoint(org, ["ride.completed", "ride.cancelled"]);
    const created = await addEndpoint(org, ["ride.created"]);
    const disabled = await addEndpoint(org);
    expect((await setEnabled(org, disabled.id, false)).ok).toBe(true);
    const foreign = await addEndpoint(other);

    const d = await createDriver(org, { firstName: "Jade", at: north(CHAMPS_ELYSEES, 500) });
    const done = await createRideAsOwner(org);
    await acceptOffer(d, done.id);
    await drive(d, done.id);
    const cancelled = await createRideAsOwner(org, { pickup_at: inMinutes(150) });
    expect((await rpc(org.ownerId, "cancel_ride", [cancelled.id, null])).code).toBe("CANCELLED");

    expect(await typesOf(all.id)).toHaveLength(7 + 2);
    expect((await typesOf(finals.id)).sort()).toEqual(["ride.cancelled", "ride.completed"]);
    expect(await typesOf(created.id)).toEqual(["ride.created", "ride.created"]);
    expect(await typesOf(disabled.id)).toEqual([]);
    expect(await typesOf(foreign.id)).toEqual([]);
    // Toutes les lignes portent la centrale de la course
    const orgs = await sql(`select distinct organization_id from public.webhook_deliveries where ride_id = any ($1::uuid[])`, [[done.id, cancelled.id]]);
    expect(orgs.map((r) => r.organization_id)).toEqual([org.id]);
  });

  it("course créée par un dispatcher (qui ne lit pas les webhooks) ou par un import : déclencheur sans erreur ; import sans événement", async () => {
    const org = await createOrg("WH Dispatcher");
    const ep = await addEndpoint(org);
    const dispatcher = await createMember(org, "dispatcher");
    const [row] = await as({ sub: dispatcher }, (q) =>
      q(
        `insert into public.rides (organization_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name,
           customer_phone, vehicle_category, pickup_at)
         values ($1, '1 Rue de Rivoli, 75001 Paris', 48.8606, 2.3376, 'Gare de Lyon, 75012 Paris', 'Client', '+33600000003', 'business', $2)
         returning id`,
        [org.id, inMinutes(60)],
      ),
    );
    expect(await triples(row.id, ep.id)).toEqual([["ride.created", "CREATED", null]]);
    expect(await as({ sub: dispatcher }, (q) => q(`select * from public.webhook_endpoints`))).toEqual([]);

    const imported = await insertRideBypass(org, { completed_at: new Date() });
    expect(await deliveriesOf(imported)).toEqual([]);
  });

  it("adresse supprimée pendant le changement d'une course : la course est quand même modifiée (événement perdu)", async () => {
    const org = await createOrg("WH Course concurrente");
    const ep = await addEndpoint(org);
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(200) });
    const a = await pool.connect();
    try {
      await a.query("begin");
      await a.query(`delete from public.webhook_endpoints where id = $1`, [ep.id]);
      // Le déclencheur voit encore l'adresse ; la clé étrangère attend la fin de la suppression puis échoue
      const pending = pool.query(`update public.rides set pickup_at = pickup_at + interval '1 hour' where id = $1`, [ride.id]);
      await sleep(300);
      await a.query("commit");
      await pending;
    } finally {
      a.release();
    }
    const [r] = await sql(`select pickup_at from public.rides where id = $1`, [ride.id]);
    expect(r.pickup_at.getTime()).toBeGreaterThan(Date.now() + 200 * 60_000);
    expect(await sql(`select 1 from public.webhook_deliveries where endpoint_id = $1`, [ep.id])).toEqual([]);
  });

  it("réveil du worker : pg_notify('rydar_webhooks') à la validation, seulement s'il y a un envoi", async () => {
    const org = await createOrg("WH Réveil");
    await addEndpoint(org);
    const silent = await createOrg("WH Sans webhook");
    const listener = new pg.Client({ connectionString: DB_URL });
    await listener.connect();
    const got: string[] = [];
    listener.on("notification", (n) => got.push(n.channel));
    try {
      await listener.query("listen rydar_webhooks");
      await apiRide(silent);
      await sleep(300);
      expect(got).toEqual([]);
      await apiRide(org);
      for (let i = 0; i < 40 && got.length === 0; i++) await sleep(50);
      expect(got).toEqual(["rydar_webhooks"]);
    } finally {
      await listener.end();
    }
  });
});

// =============================================================================
// Worker : prise d'un lot
// =============================================================================
describe("Webhooks : private.claim_webhook_deliveries", () => {
  // File globale : chaque test part d'une file vide (aucun autre fichier de tests ne crée de webhook)
  beforeEach(async () => {
    await sql("truncate public.webhook_deliveries");
  });

  it("forme de « ride » : colonnes de PUBLIC_RIDE_SELECT + updated_at, chauffeur (prénom, véhicule) ; état courant de la course", async () => {
    const org = await createOrg("WH Forme");
    const ep = await addEndpoint(org);
    const d = await createDriver(org, { firstName: "Karim", presence: "offline" });
    await sql(`update public.vehicles set brand = 'Mercedes', color = 'Noir' where id = $1`, [d.vehicleId]);
    const rideId = await apiRide(org, { pickup_at: inMinutes(120), flight_number: "AF1234", comment: "Code 1234B" });
    expect((await rpc(org.ownerId, "assign_ride", [rideId, d.id])).code).toBe("ASSIGNED");

    // Une seule adresse : un envoi par prise, dans l'ordre des événements
    const rows = await claimAll();
    expect(rows.map((r) => r.event_type)).toEqual(["ride.created", "ride.accepted"]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(CLAIM_KEYS);
      expect(r).toMatchObject({ organization_id: org.id, endpoint_id: ep.id, url: ep.url, attempts: 0 });
      expect(r.secret).toBe(ep.secret);
      expect(r.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
      expect(Object.keys(r.ride).sort()).toEqual(RIDE_KEYS);
    }
    // Transition de l'événement, état courant de la course (déjà acceptée pour ride.created)
    expect([rows[0].event_status, rows[0].previous_status]).toEqual(["CREATED", null]);
    expect(rows[0].ride.status).toBe("ACCEPTED");
    expect(rows[0].ride).toEqual(rows[1].ride);

    const [db] = await sql(`select * from public.rides where id = $1`, [rideId]);
    const ride = rows[0].ride;
    expect(ride).toMatchObject({
      id: rideId, number: Number(db.number), type: "scheduled", status: "ACCEPTED", pickup_address: db.pickup_address,
      pickup_lat: db.pickup_lat, pickup_lng: db.pickup_lng, dropoff_address: db.dropoff_address, dropoff_lat: null,
      dropoff_lng: null, passengers: 1, luggage: 0, vehicle_category: "business", price_cents: 6500, currency: "EUR",
      payment_method: "card", flight_number: "AF1234", external_reference: db.external_reference,
      estimated_distance_m: null, estimated_duration_s: null, route_polyline: null, driver_arrived_at: null,
      started_at: null, completed_at: null, cancelled_at: null,
      driver: { first_name: "Karim", vehicle: { brand: "Mercedes", model: "Classe E", color: "Noir", plate: expect.stringMatching(/^AA-/) } },
    });
    expect(Object.keys(ride.driver).sort()).toEqual(["first_name", "vehicle"]);
    for (const k of ["pickup_at", "created_at", "accepted_at", "updated_at"]) {
      expect(new Date(ride[k]).getTime(), k).toBe(new Date(db[k]).getTime());
    }
    // Minimisation : ni client, ni commentaire, ni nom ou téléphone du chauffeur
    const text = JSON.stringify(ride);
    for (const secret of ["Client API", "+33600000009", "Code 1234B", "+33600000000", "Test"]) expect(text).not.toContain(secret);

    // Chauffeur sans véhicule ; course sans chauffeur ; « ping » ; course supprimée
    await sql(`update public.drivers set vehicle_id = null where id = $1`, [d.id]);
    const again = await insertDelivery(org, ep.id, { ride_id: rideId, event_type: "ride.accepted", event_status: "ACCEPTED" });
    expect((await claimAll()).find((r) => r.id === again.id)!.ride.driver).toEqual({ first_name: "Karim", vehicle: null });
    const lone = await apiRide(org, { pickup_at: inMinutes(300) });
    expect((await claimAll()).find((r) => r.event_type === "ride.created")!.ride).toMatchObject({ id: lone, driver: null });
    const p = await ping(org, ep.id);
    const pinged = (await claimAll()).find((r) => r.id === p.delivery_id)!;
    expect(pinged).toMatchObject({ event_type: "ping", event_status: null, previous_status: null, ride: null });
    const orphan = await insertDelivery(org, ep.id, { ride_id: null, event_type: "ride.cancelled", event_status: "CANCELLED" });
    expect((await claimAll()).find((r) => r.id === orphan.id)!.ride).toBeNull();
  });

  it("une adresse : un seul envoi en cours, le plus ancien dû d'abord, verrou 2 min ; ni envoi futur, ni adresse désactivée ; « en cours » expiré repris", async () => {
    const org = await createOrg("WH Lot");
    const ep = await addEndpoint(org);
    const off = await addEndpoint(org);
    const a = await insertDelivery(org, ep.id, { occurred_at: new Date(Date.now() - 3000) });
    const b = await insertDelivery(org, ep.id, { occurred_at: new Date(Date.now() - 2000) });
    const c = await insertDelivery(org, ep.id, { occurred_at: new Date(Date.now() - 1000) });
    const future = await insertDelivery(org, ep.id, { next_attempt_at: new Date(Date.now() + 60_000) });
    const disabled = await insertDelivery(org, off.id);
    await setEnabled(org, off.id, false);
    const stale = await insertDelivery(org, ep.id, { status: "sending", locked_until: new Date(Date.now() - 1000), occurred_at: new Date(Date.now() - 10_000) });
    const done = await insertDelivery(org, ep.id, { status: "delivered" });
    const failed = await insertDelivery(org, ep.id, { status: "failed" });

    // Envoi « en cours » expiré (worker arrêté) repris en premier, seul : l'adresse est ensuite occupée
    expect((await claim(10)).map((r) => r.id)).toEqual([stale.id]);
    expect(await claim(10)).toEqual([]);
    const [lock] = await sql(
      `select status, extract(epoch from (locked_until - now())) as s from public.webhook_deliveries where id = $1`, [stale.id]);
    expect(lock.status).toBe("sending");
    expect(Number(lock.s)).toBeGreaterThan(115);
    expect(Number(lock.s)).toBeLessThanOrEqual(120);

    // Chaque compte rendu libère l'adresse : le suivant, dans l'ordre des événements
    const order: string[] = [];
    let current = stale.id;
    for (let i = 0; i < 3; i++) {
      await complete(current, true, 200);
      const next = await claim(10);
      expect(next).toHaveLength(1);
      // Pris sans compter d'essai (compté au compte rendu)
      expect((await deliveryRow(next[0]!.id)).attempts).toBe(0);
      current = next[0]!.id;
      order.push(current);
    }
    expect(order).toEqual([a.id, b.id, c.id]);
    await complete(c.id, true, 200);
    expect(await claim(10)).toEqual([]);
    for (const x of [future, disabled, done, failed]) {
      expect((await deliveryRow(x.id)).status).toBe(x.status);
    }

    // Envoi en cours chez un autre worker (verrou valide) : l'adresse est sautée, ses autres envois attendent
    const busyEp = await addEndpoint(org);
    const busy = await insertDelivery(org, busyEp.id, { status: "sending", locked_until: new Date(Date.now() + 60_000) });
    const queued = await insertDelivery(org, busyEp.id, { occurred_at: new Date(Date.now() - 60_000) });
    expect(await claim(10)).toEqual([]);
    expect((await deliveryRow(queued.id)).status).toBe("pending");
    await complete(busy.id, true, 200);
    expect((await claim(10)).map((r) => r.id)).toEqual([queued.id]);
    await complete(queued.id, true, 200);

    // Limites : null → 20 par défaut, négatif → rien, plafond 100 (25 adresses insérées directement : le plafond
    // de 10 par centrale n'est contrôlé que par svc_webhook_upsert)
    for (let i = 0; i < 25; i++) {
      const [e] = await sql(`insert into public.webhook_endpoints (organization_id, url) values ($1, $2) returning id`, [org.id, hookUrl("lot")]);
      await insertDelivery(org, e.id);
    }
    expect(await claim(-5)).toEqual([]);
    expect(await claim(null)).toHaveLength(20);
    expect(await claim(1000)).toHaveLength(5);
  });

  it("tour de rôle entre centrales : une centrale avec beaucoup d'envois en attente ne passe pas devant les autres", async () => {
    const big = await createOrg("WH Grosse centrale");
    const small = await createOrg("WH Petite centrale");
    const tiny = await createOrg("WH Toute petite centrale");
    const bigEps = [await addEndpoint(big), await addEndpoint(big), await addEndpoint(big)];
    // Arriéré de la grosse centrale : 5 envois anciens par adresse
    for (const e of bigEps) {
      for (let i = 0; i < 5; i++) await insertDelivery(big, e.id, { occurred_at: new Date(Date.now() - 3_600_000 + i * 1000) });
    }
    const s = await insertDelivery(small, (await addEndpoint(small)).id);
    const t = await insertDelivery(tiny, (await addEndpoint(tiny)).id);

    // Premier tour : une adresse par centrale (les deux petites passent malgré l'arriéré, plus ancien)
    const first = await claim(3);
    expect(first.map((r) => r.organization_id).sort()).toEqual([big.id, small.id, tiny.id].sort());
    expect(first.map((r) => r.id)).toEqual(expect.arrayContaining([s.id, t.id]));
    // Puis les autres adresses de la grosse centrale, une ligne chacune (la première est occupée)
    const second = await claim(10);
    expect(second).toHaveLength(2);
    expect(second.every((r) => r.organization_id === big.id)).toBe(true);
    const busyEndpoint = first.find((r) => r.organization_id === big.id)!.endpoint_id;
    expect(new Set(second.map((r) => r.endpoint_id)).size).toBe(2);
    expect(second.some((r) => r.endpoint_id === busyEndpoint)).toBe(false);
    expect(await claim(10)).toEqual([]);
  });

  it("tour de rôle avec des envois en cours (worker : une prise par place libérée) : la centrale qui occupe déjà des places passe derrière", async () => {
    const big = await createOrg("WH Places occupées");
    const small = await createOrg("WH Événement frais");
    const bigEps = [await addEndpoint(big), await addEndpoint(big), await addEndpoint(big), await addEndpoint(big)];
    // 3 places tenues par la grosse centrale (adresses lentes), arriéré ancien sur sa 4e adresse
    for (const e of bigEps.slice(0, 3)) {
      await insertDelivery(big, e.id, { status: "sending", locked_until: new Date(Date.now() + 60_000) });
    }
    const backlog: Row[] = [];
    for (let i = 0; i < 3; i++) {
      backlog.push(await insertDelivery(big, bigEps[3]!.id, { occurred_at: new Date(Date.now() - 3_600_000 + i * 1000) }));
    }
    const fresh = await insertDelivery(small, (await addEndpoint(small)).id);

    // Place libérée : l'événement frais de l'autre centrale passe devant l'arriéré, plus ancien
    expect((await claim(1)).map((r) => r.id)).toEqual([fresh.id]);
    // Place suivante : l'arriéré (seul envoi encore dû)
    expect((await claim(1)).map((r) => r.id)).toEqual([backlog[0]!.id]);
    expect(await claim(1)).toEqual([]);
  });

  it("un test (« ping ») passe en tête de son adresse, devant l'arriéré dû", async () => {
    const org = await createOrg("WH Test en tête");
    const ep = await addEndpoint(org);
    const old: Row[] = [];
    for (let i = 0; i < 3; i++) {
      old.push(await insertDelivery(org, ep.id, {
        event_type: "ride.cancelled", event_status: "CANCELLED", occurred_at: new Date(Date.now() - 600_000 + i * 1000),
      }));
    }
    const p = await ping(org, ep.id);
    const order = (await claimAll()).map((r) => r.id);
    expect(order).toEqual([p.delivery_id, ...old.map((d) => d.id)]);
  });

  it("centrale suspendue ou archivée : aucun envoi pris, ils restent en attente ; repris à la réactivation", async () => {
    const org = await createOrg("WH Prise suspendue");
    const ep = await addEndpoint(org);
    const x = await insertDelivery(org, ep.id);
    for (const status of ["suspended", "archived"]) {
      await sql(`update public.organizations set status = $2 where id = $1`, [org.id, status]);
      expect(await claim(10), status).toEqual([]);
      expect((await deliveryRow(x.id)).status).toBe("pending");
    }
    await sql(`update public.organizations set status = 'active' where id = $1`, [org.id]);
    expect((await claim(10)).map((r) => r.id)).toEqual([x.id]);
  });

  it("heures de « ride » en UTC (« +00:00 », comme PostgREST), quel que soit le fuseau de la connexion du worker", async () => {
    const org = await createOrg("WH Fuseau");
    await addEndpoint(org);
    const rideId = await apiRide(org, { pickup_at: inMinutes(90) });
    const client = await pool.connect();
    try {
      await client.query("set timezone = 'Europe/Paris'");
      const { rows } = await client.query(`select * from private.claim_webhook_deliveries(10)`);
      const ride = rows.find((r) => r.ride?.id === rideId)!.ride;
      for (const k of ["pickup_at", "created_at", "updated_at"]) expect(ride[k], k).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00$/);
      expect((await client.query(`show timezone`)).rows[0].TimeZone).toBe("Europe/Paris");
    } finally {
      await client.query("reset timezone").catch(() => undefined);
      client.release();
    }
  });

  it("for update skip locked : une ligne verrouillée par un autre worker est sautée, sans prendre un autre envoi de son adresse", async () => {
    const org = await createOrg("WH Verrou");
    const ep = await addEndpoint(org);
    const ep2 = await addEndpoint(org);
    const x = await insertDelivery(org, ep.id, { occurred_at: new Date(Date.now() - 5000) });
    const y = await insertDelivery(org, ep.id);
    const z = await insertDelivery(org, ep2.id);
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query(`select id from public.webhook_deliveries where id = $1 for update`, [x.id]);
      // x est en train d'être pris ailleurs : y (même adresse) attend, z (autre adresse) part
      expect((await claim(10)).map((r) => r.id)).toEqual([z.id]);
      await other.query("rollback");
    } finally {
      other.release();
    }
    expect((await claim(10)).map((r) => r.id)).toEqual([x.id]);
    expect((await deliveryRow(y.id)).status).toBe("pending");
  });

  it("deux prises simultanées : jamais deux envois en cours pour une même adresse", async () => {
    const org = await createOrg("WH Prises simultanées");
    const eps = [await addEndpoint(org), await addEndpoint(org), await addEndpoint(org)];
    for (const e of eps) for (let i = 0; i < 4; i++) await insertDelivery(org, e.id, { occurred_at: new Date(Date.now() - 10_000 + i) });
    const batches = await Promise.all(Array.from({ length: 4 }, () => claim(10)));
    const taken = batches.flat();
    expect(taken).toHaveLength(3);
    expect(new Set(taken.map((r) => r.endpoint_id)).size).toBe(3);
    const [{ n }] = await sql(
      `select max(c)::int as n from (select count(*) as c from public.webhook_deliveries where status = 'sending' group by endpoint_id) x`);
    expect(n).toBe(1);
  });
});

// =============================================================================
// Worker : compte rendu, reprises, désactivation automatique, conservation
// =============================================================================
describe("Webhooks : private.complete_webhook_delivery et private.purge_webhook_deliveries", () => {
  beforeEach(async () => {
    await sql("truncate public.webhook_deliveries");
  });

  it("succès : envoyé, code HTTP gardé ; adresse : dernier succès, échecs consécutifs remis à zéro", async () => {
    const org = await createOrg("WH Succès");
    const ep = await addEndpoint(org);
    await sql(`update public.webhook_endpoints set consecutive_failures = 7, last_error = 'HTTP 500' where id = $1`, [ep.id]);
    const x = await insertDelivery(org, ep.id);
    await claimOne(x.id);
    await complete(x.id, true, 204);

    expect(await deliveryRow(x.id)).toMatchObject({ status: "delivered", last_status_code: 204, last_error: null, locked_until: null, attempts: 0 });
    expect((await deliveryRow(x.id)).delivered_at).toBeInstanceOf(Date);
    const e = await endpointRow(ep.id);
    expect(e).toMatchObject({ consecutive_failures: 0, last_error: null, enabled: true });
    expect(e.last_success_at).toBeInstanceOf(Date);

    // Succès signalé tard pour un envoi passé en échec : il est bien parti
    const late = await insertDelivery(org, ep.id, { status: "failed", attempts: 9 });
    await complete(late.id, true, 200);
    expect((await deliveryRow(late.id)).status).toBe("delivered");
    // Identifiant inconnu : rien
    await complete(randomUUID(), false, 500, "x");
  });

  it("échecs : nouvel essai après 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h ; échec définitif au 9e", async () => {
    const org = await createOrg("WH Reprises");
    const ep = await addEndpoint(org);
    const x = await insertDelivery(org, ep.id, { event_type: "ride.cancelled", event_status: "CANCELLED" });
    for (let n = 1; n <= 9; n++) {
      await claimOne(x.id);
      await complete(x.id, false, 503, "Service Unavailable");
      const [row] = await sql(
        `select *, extract(epoch from (next_attempt_at - now())) as wait from public.webhook_deliveries where id = $1`, [x.id]);
      expect(row.attempts).toBe(n);
      expect(row).toMatchObject({ last_status_code: 503, last_error: "Service Unavailable", locked_until: null });
      if (n <= 8) {
        expect(row.status).toBe("pending");
        expect(Number(row.wait)).toBeGreaterThan(DELAYS[n - 1]! - 5);
        expect(Number(row.wait)).toBeLessThanOrEqual(DELAYS[n - 1]!);
      } else {
        expect(row.status).toBe("failed");
      }
    }
    expect(await claim(10)).toEqual([]);
    const e = await endpointRow(ep.id);
    expect(e).toMatchObject({ consecutive_failures: 9, last_error: "Service Unavailable", enabled: true });
    expect(e.last_failure_at).toBeInstanceOf(Date);

    // Échec signalé pour un envoi qui n'est plus « en cours » : ignoré
    const y = await insertDelivery(org, ep.id, { event_type: "ride.cancelled", next_attempt_at: new Date(Date.now() + 60_000) });
    await complete(y.id, false, 500, "trop tard");
    expect(await deliveryRow(y.id)).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect((await endpointRow(ep.id)).consecutive_failures).toBe(9);

    // Puis un succès : compteurs de l'adresse remis à zéro
    await claimOne(y.id);
    await complete(y.id, true, 200);
    expect(await endpointRow(ep.id)).toMatchObject({ consecutive_failures: 0, last_error: null });
  });

  it("motif d'échec : texte nettoyé et borné à 500 caractères, sinon « Réponse HTTP n », sinon motif inconnu", async () => {
    const org = await createOrg("WH Motifs");
    const ep = await addEndpoint(org);
    const cases: [number | null, string | null, string][] = [
      [null, "connect ECONNREFUSED\n  203.0.113.5:443", "connect ECONNREFUSED 203.0.113.5:443"],
      [500, null, "Réponse HTTP 500"],
      [null, "   ", "Échec de l'envoi (motif inconnu)"],
      [302, "x".repeat(800), "x".repeat(500)],
    ];
    for (const [code, error, expected] of cases) {
      const x = await insertDelivery(org, ep.id);
      await claimOne(x.id);
      await complete(x.id, false, code, error);
      expect((await deliveryRow(x.id)).last_error).toBe(expected);
      expect((await endpointRow(ep.id)).last_error).toBe(expected);
    }
  });

  it("désactivation automatique : 50 échecs consécutifs et aucun succès depuis 3 jours (jamais réussi : 3 jours depuis la création) ; envois en attente → échec", async () => {
    const org = await createOrg("WH Désactivation");
    const cases = [
      { last: "now() - interval '4 days'", created: "now()", disabled: true },
      { last: "null", created: "now() - interval '4 days'", disabled: true },
      // Adresse neuve qui n'a jamais réussi (récepteur pas encore déployé, mauvais secret…) : 3 jours de délai
      { last: "null", created: "now() - interval '2 days'", disabled: false },
      { last: "null", created: "now()", disabled: false },
      { last: "now() - interval '1 day'", created: "now() - interval '30 days'", disabled: false },
    ];
    for (const c of cases) {
      const label = `succès ${c.last}, créée ${c.created}`;
      const ep = await addEndpoint(org);
      await sql(
        `update public.webhook_endpoints set consecutive_failures = 49, last_success_at = ${c.last}, created_at = ${c.created} where id = $1`,
        [ep.id],
      );
      const x = await insertDelivery(org, ep.id, { event_type: "ride.created", event_status: "CREATED" });
      const waiting = await insertDelivery(org, ep.id, { event_type: "ride.created", next_attempt_at: new Date(Date.now() + 3_600_000) });
      await claimOne(x.id);
      await complete(x.id, false, 500, "Internal Server Error");
      const e = await endpointRow(ep.id);
      expect(e.consecutive_failures, label).toBe(50);
      expect(e.enabled, label).toBe(!c.disabled);
      if (c.disabled) {
        expect(e.disabled_reason).toBe(AUTO_DISABLED);
        expect(await deliveryRow(waiting.id)).toMatchObject({ status: "failed" });
        expect((await deliveryRow(waiting.id)).last_error).toBe(
          "Webhook désactivé automatiquement (50 échecs consécutifs, aucun envoi réussi depuis 3 jours)");
        // Réactivation : motif et compteur effacés, plus d'échec automatique au prochain essai
        const r = await setEnabled(org, ep.id, true);
        expect(r.endpoint).toMatchObject({ enabled: true, disabled_reason: null });
        expect((await endpointRow(ep.id)).consecutive_failures).toBe(0);
      } else {
        expect(e.disabled_reason).toBeNull();
        expect((await deliveryRow(waiting.id)).status).toBe("pending");
      }
    }
  });

  it("test (« ping ») en échec : définitif dès le premier échec (aucun nouvel essai) ; un autre test est aussitôt possible", async () => {
    const org = await createOrg("WH Ping échec");
    const ep = await addEndpoint(org);
    const p = await ping(org, ep.id);
    expect(p.ok).toBe(true);
    await claimOne(p.delivery_id);
    await complete(p.delivery_id, false, 401, "HTTP 401");
    expect(await deliveryRow(p.delivery_id)).toMatchObject({ status: "failed", attempts: 1, last_status_code: 401, locked_until: null });
    expect((await endpointRow(ep.id)).consecutive_failures).toBe(1);
    expect(await claim(10)).toEqual([]);
    expect((await ping(org, ep.id)).ok).toBe(true);
  });

  it("comptes rendus simultanés d'une même adresse au seuil de désactivation : ni interblocage (40P01) ni erreur", async () => {
    const org = await createOrg("WH Comptes rendus simultanés");
    for (let trial = 0; trial < 6; trial++) {
      const ep = await addEndpoint(org);
      await sql(
        `update public.webhook_endpoints set consecutive_failures = 47, created_at = now() - interval '4 days' where id = $1`, [ep.id]);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await insertDelivery(org, ep.id, { event_type: "ride.created", status: "sending", locked_until: new Date(Date.now() + 120_000) })).id);
      }
      // Chaque compte rendu sur sa propre connexion (comme les envois parallèles du worker)
      const results = await Promise.allSettled(
        ids.map((id) => pool.query(`select private.complete_webhook_delivery($1::uuid, false, 503, 'HTTP 503')`, [id])),
      );
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason?.code ?? String(r.reason));
      expect(errors, `essai ${trial}`).toEqual([]);
      // Le 50e échec désactive l'adresse et passe ses autres envois en échec : les comptes rendus suivants n'y changent rien
      const e = await endpointRow(ep.id);
      expect(e).toMatchObject({ enabled: false, disabled_reason: AUTO_DISABLED, consecutive_failures: 50 });
      const statuses = await sql(`select status from public.webhook_deliveries where endpoint_id = $1`, [ep.id]);
      expect(statuses.every((r) => r.status === "failed")).toBe(true);
    }
  });

  it("conservation : envois terminés 30 jours, tout envoi 45 jours", async () => {
    const org = await createOrg("WH Conservation");
    const ep = await addEndpoint(org);
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const keep = [
      await insertDelivery(org, ep.id, { status: "delivered", created_at: days(29) }),
      await insertDelivery(org, ep.id, { status: "failed", created_at: days(29) }),
      await insertDelivery(org, ep.id, { status: "pending", created_at: days(44) }),
      await insertDelivery(org, ep.id, { status: "pending", created_at: days(1) }),
    ];
    const gone = [
      await insertDelivery(org, ep.id, { status: "delivered", created_at: days(31) }),
      await insertDelivery(org, ep.id, { status: "failed", created_at: days(40) }),
      await insertDelivery(org, ep.id, { status: "pending", created_at: days(46) }),
      await insertDelivery(org, ep.id, { status: "sending", created_at: days(50), locked_until: new Date() }),
    ];
    expect(await purge()).toBe(4);
    const left = (await sql(`select id from public.webhook_deliveries`)).map((r) => r.id).sort();
    expect(left).toEqual(keep.map((r) => r.id).sort());
    expect(gone.every((g) => !left.includes(g.id))).toBe(true);
    expect(await purge()).toBe(0);
  });
});

// =============================================================================
// Gestion : fonctions svc_*
// =============================================================================
describe("Webhooks : svc_webhook_upsert", () => {
  it("création : secret généré « whsec_ » + 48 hex montré une fois, jamais dans l'adresse ni le journal ; événements normalisés", async () => {
    const org = await createOrg("WH Création");
    const url = hookUrl();
    const r = await upsert(org, `  ${url}  `, { description: "  RYDAR\nPrivé  ", events: ["ride.completed", "ride.created", "ride.completed"] });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(r.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(Object.keys(r.endpoint).sort()).toEqual(ENDPOINT_KEYS);
    expect(r.endpoint).toMatchObject({
      url, description: "RYDAR Privé", events: ["ride.created", "ride.completed"], enabled: true, disabled_reason: null,
      last_success_at: null, last_failure_at: null, last_error: null,
    });
    expect(JSON.stringify(r.endpoint)).not.toContain(r.secret);
    expect(await secretOf(r.endpoint.id)).toBe(r.secret);
    const e = await endpointRow(r.endpoint.id);
    expect(e).toMatchObject({ organization_id: org.id, created_by_type: "user", created_by: org.ownerId, consecutive_failures: 0 });

    const [log] = await sql(`select * from public.audit_logs where action = 'webhook.created' and entity_id = $1`, [r.endpoint.id]);
    expect(log).toMatchObject({ organization_id: org.id, actor_type: "user", actor_user_id: org.ownerId, entity_type: "webhook_endpoints" });
    expect(log.metadata).toMatchObject({ url, secret_generated: true });
    expect(JSON.stringify(log)).not.toContain(r.secret);

    // Tous les événements : null ou liste vide ; schéma et hôte en minuscules
    const all = await upsert(org, "HTTPS://Hooks.Example.COM:8443/Rydar?x=1", { events: [] });
    expect(all.endpoint).toMatchObject({ url: "https://hooks.example.com:8443/Rydar?x=1", events: [], description: null });
    expect((await upsert(org, hookUrl(), { events: null })).endpoint.events).toEqual([]);
    expect((await upsert(org, hookUrl(), { events: EVENTS })).endpoint.events).toEqual(EVENTS);
  });

  it("secret fourni (dérivé par l'intégrateur) : gardé, jamais renvoyé ; 32 à 200 caractères [A-Za-z0-9_.-]", async () => {
    const org = await createOrg("WH Secret fourni");
    const secret = "a1B2_c3.D4-" + "e".repeat(30);
    const r = await upsert(org, hookUrl(), { secret });
    expect(r).toMatchObject({ ok: true, created: true, secret: null });
    expect(await secretOf(r.endpoint.id)).toBe(secret);

    for (const bad of ["", "court", "a".repeat(31), "a".repeat(201), `${"a".repeat(31)} `, `${"a".repeat(32)}é`, `${"a".repeat(32)}/`]) {
      const x = await upsert(org, hookUrl(), { secret: bad });
      expect(x, JSON.stringify(bad)).toMatchObject({ ok: false, code: "WEBHOOK_INVALID_SECRET" });
      expect(x.message).toBeTruthy();
    }
    expect((await upsert(org, hookUrl(), { secret: "f".repeat(32) })).ok).toBe(true);
    expect((await upsert(org, hookUrl(), { secret: "f".repeat(200) })).ok).toBe(true);
  });

  it("adresse refusée : WEBHOOK_INVALID_URL (https seulement, ni identifiants, ni réseau local ou privé)", async () => {
    const org = await createOrg("WH Adresses");
    const bad = [
      null, "", "   ", "http://example.com/hook", "ftp://example.com/hook", "example.com/hook", "https://",
      "https:///chemin", "https://user:pass@example.com/hook", "https://token@example.com/hook",
      "https://localhost/hook", "https://LOCALHOST:8443/", "https://api.localhost/hook", "https://intranet/hook",
      "https://kong:8000/rest/v1", "https://127.0.0.1/hook", "https://127.1/", "https://2130706433/", "https://0x7f.0.0.1/",
      "https://017700000001/", "https://0.0.0.0/", "https://10.1.2.3/", "https://172.16.5.4/", "https://172.31.255.255/",
      "https://192.168.1.10/", "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/", "https://224.0.0.1/",
      "https://255.255.255.255/", "https://[::1]/", "https://[::]/", "https://[fe80::1]/", "https://[fd12:3456::1]/",
      "https://[::ffff:127.0.0.1]/", "https://[::ffff:10.0.0.1]/", "https://[ff02::1]/", "https://[64:ff9b::a00:1]/",
      "https://[fe80::1%25eth0]/", "https://exa mple.com/", "https://example.com\\@evil.com/", "https://exam\tple.com/",
      "https://example..com/", "https://.example.com/", "https://example.com:0/", "https://example.com:65536/",
      "https://example.com:/", "https://%31%32%37.0.0.1/", `https://example.com/${"a".repeat(490)}`,
    ];
    for (const url of bad) {
      const r = await upsert(org, url);
      expect(r, JSON.stringify(url)).toMatchObject({ ok: false, code: "WEBHOOK_INVALID_URL" });
      expect(r.message, JSON.stringify(url)).toMatch(/\S/);
    }
    expect(await sql(`select 1 from public.webhook_endpoints where organization_id = $1`, [org.id])).toEqual([]);

    const good = [
      "https://example.com/hook", "https://hooks.example.com:8443/rydar?source=drive#x", "https://93.184.216.34/hook",
      "https://[2606:4700:4700::1111]/hook", "https://rydar-prive.vercel.app/api/drive/webhook", "https://café.example.fr/hook",
      "https://example.com", "https://172.32.0.1/hook", "https://100.128.0.1/hook",
    ];
    for (const url of good) {
      const r = await upsert(org, url);
      expect(r, url).toMatchObject({ ok: true, created: true });
    }
  });

  it("événements refusés : WEBHOOK_INVALID_EVENTS (inconnu, « ping », null) ; description de plus de 120 caractères : VALIDATION_ERROR", async () => {
    const org = await createOrg("WH Événements");
    for (const events of [["ride.unknown"], ["ping"], ["ride.created", null], ["RIDE.CREATED"], ["ride.created", ""]]) {
      const r = await upsert(org, hookUrl(), { events });
      expect(r, JSON.stringify(events)).toMatchObject({ ok: false, code: "WEBHOOK_INVALID_EVENTS" });
      expect(r.message).toContain("ride.created");
    }
    expect(await upsert(org, hookUrl(), { description: "d".repeat(121) })).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect((await upsert(org, hookUrl(), { description: "d".repeat(120) })).ok).toBe(true);
    expect((await upsert(org, hookUrl(), { description: " \n\t " })).endpoint.description).toBeNull();
  });

  it("même adresse : mise à jour (created: false, secret: null), réactivée, compteurs remis à zéro ; secret remplacé seulement s'il est fourni", async () => {
    const org = await createOrg("WH Mise à jour");
    const url = hookUrl();
    const first = await upsert(org, url, { description: "Ancien", events: ["ride.created"] });
    const id = first.endpoint.id;
    await setEnabled(org, id, false);
    await sql(`update public.webhook_endpoints set consecutive_failures = 60, disabled_reason = 'x' where id = $1`, [id]);

    const again = await upsert(org, url, { description: "RYDAR Privé", events: null });
    expect(again).toMatchObject({ ok: true, created: false, secret: null });
    expect(again.endpoint).toMatchObject({ id, url, description: "RYDAR Privé", events: [], enabled: true, disabled_reason: null });
    expect((await endpointRow(id)).consecutive_failures).toBe(0);
    expect(await secretOf(id)).toBe(first.secret);

    const derived = "Z".repeat(64);
    const third = await upsert(org, url, { secret: derived });
    expect(third).toMatchObject({ ok: true, created: false, secret: null });
    expect(third.endpoint.description).toBeNull();
    expect(await secretOf(id)).toBe(derived);
    expect(await sql(`select 1 from public.webhook_endpoints where organization_id = $1`, [org.id])).toHaveLength(1);
    const logs = await sql(`select metadata from public.audit_logs where action = 'webhook.updated' and entity_id = $1 order by id`, [id]);
    expect(logs.map((l) => [l.metadata.reenabled, l.metadata.secret_replaced])).toEqual([[true, false], [false, true]]);
    expect(JSON.stringify(logs)).not.toContain(derived);
  });

  it("10 webhooks au plus par centrale (WEBHOOK_LIMIT) ; mise à jour toujours possible ; même adresse dans deux centrales", async () => {
    const org = await createOrg("WH Plafond");
    const other = await createOrg("WH Plafond voisine");
    const urls = Array.from({ length: 10 }, () => hookUrl());
    for (const url of urls) expect((await upsert(org, url)).ok).toBe(true);
    const over = await upsert(org, hookUrl());
    expect(over).toMatchObject({ ok: false, code: "WEBHOOK_LIMIT" });
    expect(over.message).toBeTruthy();
    expect(await upsert(org, urls[3]!, { description: "Toujours modifiable" })).toMatchObject({ ok: true, created: false });
    const shared = await upsert(other, urls[0]!);
    expect(shared).toMatchObject({ ok: true, created: true });
    expect(await sql(`select 1 from public.webhook_endpoints where organization_id = $1`, [org.id])).toHaveLength(10);
  });

  it("auteur revérifié : clé API de la centrale (ou sans identifiant), propriétaire, administrateur, super admin ; refus sinon", async () => {
    const org = await createOrg("WH Auteurs");
    const other = await createOrg("WH Auteurs voisine");
    const key = await apiKey(org);
    const foreignKey = await apiKey(other);
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");
    const sa = await superAdmin();

    const viaKey = await upsert(org, hookUrl(), { actor: { type: "api", id: key } });
    expect(viaKey.ok).toBe(true);
    expect(await endpointRow(viaKey.endpoint.id)).toMatchObject({ created_by_type: "api", created_by: key });
    const [log] = await sql(`select * from public.audit_logs where action = 'webhook.created' and entity_id = $1`, [viaKey.endpoint.id]);
    expect(log).toMatchObject({ actor_type: "api", actor_user_id: null });
    expect(log.metadata.api_key_id).toBe(key);

    expect((await upsert(org, hookUrl(), { actor: { type: "api", id: null } })).ok).toBe(true);
    expect((await upsert(org, hookUrl(), { actor: { type: "user", id: admin } })).ok).toBe(true);
    const bySa = await upsert(org, hookUrl(), { actor: { type: "user", id: sa } });
    expect(bySa.ok).toBe(true);
    expect((await endpointRow(bySa.endpoint.id)).created_by_type).toBe("super_admin");

    const refused: [Actor, string][] = [
      [{ type: "api", id: foreignKey }, "clé d'une autre centrale"],
      [{ type: "user", id: dispatcher }, "dispatcher"],
      [{ type: "user", id: other.ownerId }, "propriétaire d'une autre centrale"],
      [{ type: "user", id: null }, "utilisateur sans identifiant"],
      [{ type: "driver", id: org.ownerId }, "type chauffeur"],
      [{ type: "system", id: null }, "système"],
    ];
    for (const [actor, label] of refused) {
      const e = await expectPgError(upsert(org, hookUrl(), { actor }));
      expect(e.code, label).toBe("42501");
      expect(e.message, label).toMatch(/^FORBIDDEN/);
    }
    await sql(`update public.organization_users set status = 'disabled' where organization_id = $1 and user_id = $2`, [org.id, admin]);
    expect((await expectPgError(upsert(org, hookUrl(), { actor: { type: "user", id: admin } }))).code).toBe("42501");

    const unknown = await expectPgError(upsert(org, hookUrl(), { orgId: randomUUID() }));
    expect(unknown.code).toBe("42501");
    expect(unknown.message).toMatch(/^FORBIDDEN_TENANT/);
    expect((await expectPgError(upsert(org, hookUrl(), { orgId: null }))).code).toBe("42501");
  });
});

describe("Webhooks : suppression, activation, secret, test, renvoi", () => {
  it("suppression : secret et envois supprimés avec l'adresse ; autre centrale ou inconnue : WEBHOOK_NOT_FOUND", async () => {
    const org = await createOrg("WH Suppression");
    const other = await createOrg("WH Suppression voisine");
    const ep = await addEndpoint(org);
    const ride = await createRideAsOwner(org, { pickup_at: inMinutes(100) });
    expect(await deliveriesOf(ride.id, ep.id)).toHaveLength(1);

    expect(await remove(other, ep.id)).toMatchObject({ ok: false, code: "WEBHOOK_NOT_FOUND" });
    expect(await remove(org, randomUUID())).toMatchObject({ ok: false, code: "WEBHOOK_NOT_FOUND" });
    expect(await remove(org, null)).toMatchObject({ ok: false, code: "WEBHOOK_NOT_FOUND" });
    expect(await endpointRow(ep.id)).toBeDefined();

    expect(await remove(org, ep.id)).toEqual({ ok: true });
    expect(await endpointRow(ep.id)).toBeUndefined();
    expect(await secretOf(ep.id)).toBeUndefined();
    expect(await deliveriesOf(ride.id)).toEqual([]);
    const [log] = await sql(`select * from public.audit_logs where action = 'webhook.deleted' and entity_id = $1`, [ep.id]);
    expect(log).toMatchObject({ organization_id: org.id, severity: "warning" });
    expect(log.metadata.url).toBe(ep.url);
  });

  it("désactivation puis réactivation : {ok, endpoint} ; envois en attente gardés pendant la pause ; autre centrale : WEBHOOK_NOT_FOUND", async () => {
    const org = await createOrg("WH Activation");
    const other = await createOrg("WH Activation voisine");
    const ep = await addEndpoint(org);
    const queued = await insertDelivery(org, ep.id);

    const off = await setEnabled(org, ep.id, false);
    expect(off).toMatchObject({ ok: true, endpoint: { id: ep.id, enabled: false, disabled_reason: null } });
    expect(Object.keys(off.endpoint).sort()).toEqual(ENDPOINT_KEYS);
    expect((await claim(100)).some((r) => r.id === queued.id)).toBe(false);
    expect((await deliveryRow(queued.id)).status).toBe("pending");

    expect(await setEnabled(other, ep.id, true)).toMatchObject({ ok: false, code: "WEBHOOK_NOT_FOUND" });
    expect(await setEnabled(org, ep.id, null)).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect((await endpointRow(ep.id)).enabled).toBe(false);

    await sql(`update public.webhook_endpoints set consecutive_failures = 12, disabled_reason = 'Motif' where id = $1`, [ep.id]);
    expect(await setEnabled(org, ep.id, true)).toMatchObject({ ok: true, endpoint: { enabled: true, disabled_reason: null } });
    expect((await endpointRow(ep.id)).consecutive_failures).toBe(0);
    expect((await claim(100)).some((r) => r.id === queued.id)).toBe(true);
    const actions = (await sql(`select action from public.audit_logs where entity_id = $1 order by id`, [ep.id])).map((r) => r.action);
    expect(actions).toEqual(["webhook.created", "webhook.disabled", "webhook.enabled"]);
  });

  it("nouveau secret : « whsec_ » + 48 hex, différent, enregistré, absent du journal ; autre centrale : WEBHOOK_NOT_FOUND", async () => {
    const org = await createOrg("WH Rotation");
    const other = await createOrg("WH Rotation voisine");
    const ep = await addEndpoint(org);
    const r = await rotate(org, ep.id);
    expect(Object.keys(r).sort()).toEqual(["ok", "secret"]);
    expect(r.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(r.secret).not.toBe(ep.secret);
    expect(await secretOf(ep.id)).toBe(r.secret);
    expect(await rotate(other, ep.id)).toMatchObject({ ok: false, code: "WEBHOOK_NOT_FOUND" });
    expect(await secretOf(ep.id)).toBe(r.secret);
    const logs = await sql(`select * from public.audit_logs where entity_id = $1`, [ep.id]);
    expect(logs.map((l) => l.action)).toContain("webhook.secret_rotated");
    expect(JSON.stringify(logs)).not.toContain(r.secret);
    expect(JSON.stringify(logs)).not.toContain(ep.secret);
  });

  it("test (« ping ») : envoi sans course dû tout de suite ; adresse désactivée : WEBHOOK_DISABLED ; autre centrale : WEBHOOK_NOT_FOUND", async () => {
    const org = await createOrg("WH Ping");
    const other = await createOrg("WH Ping voisine");
    const ep = await addEndpoint(org);
    const r = await ping(org, ep.id);
    expect(Object.keys(r).sort()).toEqual(["delivery_id", "ok"]);
    expect(await deliveryRow(r.delivery_id)).toMatchObject({
      organization_id: org.id, endpoint_id: ep.id, ride_id: null, event_type: "ping", event_status: null,
      previous_status: null, status: "pending", attempts: 0,
    });
    expect((await deliveryRow(r.delivery_id)).next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await ping(other, ep.id)).toMatchObject({ ok: false, code: "WEBHOOK_NOT_FOUND" });
    await setEnabled(org, ep.id, false);
    const off = await ping(org, ep.id);
    expect(off).toMatchObject({ ok: false, code: "WEBHOOK_DISABLED" });
    expect(off.message).toBeTruthy();
  });

  it("renvoi : envoyé ou en échec → en attente, essais à zéro, dû maintenant ; en attente → avancé ; autre centrale : introuvable", async () => {
    const org = await createOrg("WH Renvoi");
    const other = await createOrg("WH Renvoi voisine");
    const ep = await addEndpoint(org);
    const failed = await insertDelivery(org, ep.id, {
      status: "failed", attempts: 9, last_status_code: 500, last_error: "HTTP 500", next_attempt_at: new Date(Date.now() - 86_400_000),
    });
    const delivered = await insertDelivery(org, ep.id, { status: "delivered", delivered_at: new Date(), last_status_code: 200 });
    const waiting = await insertDelivery(org, ep.id, { attempts: 3, next_attempt_at: new Date(Date.now() + 3_600_000) });
    const sending = await insertDelivery(org, ep.id, { status: "sending", locked_until: new Date(Date.now() + 60_000) });

    for (const x of [failed, delivered]) {
      expect(await redeliver(org, x.id)).toEqual({ ok: true });
      const row = await deliveryRow(x.id);
      expect(row).toMatchObject({ status: "pending", attempts: 0, delivered_at: null, locked_until: null });
      expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }
    expect(await redeliver(org, waiting.id)).toEqual({ ok: true });
    expect(await deliveryRow(waiting.id)).toMatchObject({ status: "pending", attempts: 3 });
    expect((await deliveryRow(waiting.id)).next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await redeliver(org, sending.id)).toEqual({ ok: true });
    expect((await deliveryRow(sending.id)).status).toBe("sending");

    const done = await insertDelivery(org, ep.id, { status: "delivered" });
    expect(await redeliver(other, done.id)).toMatchObject({ ok: false, code: "WEBHOOK_DELIVERY_NOT_FOUND" });
    expect(await redeliver(org, randomUUID())).toMatchObject({ ok: false, code: "WEBHOOK_DELIVERY_NOT_FOUND" });
    expect((await deliveryRow(done.id)).status).toBe("delivered");
    await setEnabled(org, ep.id, false);
    expect(await redeliver(org, done.id)).toMatchObject({ ok: false, code: "WEBHOOK_DISABLED" });
    const [log] = await sql(`select * from public.audit_logs where action = 'webhook.redelivered' and entity_id = $1`, [failed.id]);
    expect(log).toMatchObject({ organization_id: org.id, entity_type: "webhook_deliveries" });
  });

  it("test : un seul « ping » en attente ou en cours par adresse (WEBHOOK_TEST_PENDING), libre dès qu'il a abouti ; refus sans ligne ni journal", async () => {
    const org = await createOrg("WH Ping unique");
    const ep = await addEndpoint(org);
    const ep2 = await addEndpoint(org);
    const pings = async () =>
      Number((await sql(`select count(*) from public.audit_logs where organization_id = $1 and action = 'webhook.ping'`, [org.id]))[0].count);

    const first = await ping(org, ep.id);
    expect(first.ok).toBe(true);
    const again = await ping(org, ep.id);
    expect(again).toMatchObject({ ok: false, code: "WEBHOOK_TEST_PENDING" });
    expect(again.message).toBeTruthy();
    // Autre adresse de la centrale : test possible
    expect((await ping(org, ep2.id)).ok).toBe(true);

    // En cours : toujours refusé ; abouti : nouveau test possible
    await claimOne(first.delivery_id);
    expect((await ping(org, ep.id)).code).toBe("WEBHOOK_TEST_PENDING");
    await complete(first.delivery_id, true, 204);
    expect((await ping(org, ep.id)).ok).toBe(true);

    expect(await pings()).toBe(3);
    expect(await sql(`select 1 from public.webhook_deliveries where endpoint_id = $1 and event_type = 'ping'`, [ep.id])).toHaveLength(2);

    // Pings simultanés sur une même adresse : un seul accepté
    const ep3 = await addEndpoint(org);
    const results = await Promise.all(Array.from({ length: 4 }, () => ping(org, ep3.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.code === "WEBHOOK_TEST_PENDING")).toBe(true);
  });

  it("tests et renvois : 10 par minute au plus pour la centrale (WEBHOOK_TEST_RATE_LIMITED) ; refus sans ligne ni journal ; autre centrale non touchée", async () => {
    const org = await createOrg("WH Quota tests");
    const other = await createOrg("WH Quota voisine");
    const ep = await addEndpoint(org);
    const ep2 = await addEndpoint(org);
    const done: Row[] = [];
    for (let i = 0; i < 10; i++) done.push(await insertDelivery(org, ep.id, { event_type: "ride.created", status: "delivered" }));
    const counted = async () =>
      Number((await sql(
        `select count(*) from public.audit_logs where organization_id = $1 and action in ('webhook.ping', 'webhook.redelivered')`,
        [org.id],
      ))[0].count);

    expect((await ping(org, ep.id)).ok).toBe(true);
    for (let i = 0; i < 9; i++) expect(await redeliver(org, done[i]!.id), `renvoi ${i}`).toEqual({ ok: true });
    expect(await counted()).toBe(10);

    const tooManyPings = await ping(org, ep2.id);
    expect(tooManyPings).toMatchObject({ ok: false, code: "WEBHOOK_TEST_RATE_LIMITED" });
    expect(tooManyPings.message).toBeTruthy();
    expect(await redeliver(org, done[9]!.id)).toMatchObject({ ok: false, code: "WEBHOOK_TEST_RATE_LIMITED" });
    expect((await deliveryRow(done[9]!.id)).status).toBe("delivered");
    expect(await sql(`select 1 from public.webhook_deliveries where endpoint_id = $1`, [ep2.id])).toEqual([]);
    expect(await counted()).toBe(10);
    // Introuvable et désactivé passent avant le quota
    expect(await redeliver(org, randomUUID())).toMatchObject({ code: "WEBHOOK_DELIVERY_NOT_FOUND" });

    // Autre centrale : son propre quota
    expect((await ping(other, (await addEndpoint(other)).id)).ok).toBe(true);

    // Une minute plus tard : de nouveau possible
    await sql(
      `update public.audit_logs set created_at = created_at - interval '61 seconds'
        where organization_id = $1 and action in ('webhook.ping', 'webhook.redelivered')`,
      [org.id],
    );
    expect((await ping(org, ep2.id)).ok).toBe(true);
    expect(await redeliver(org, done[9]!.id)).toEqual({ ok: true });
  });

  it("chaque fonction svc_* revérifie l'auteur (dispatcher, autre centrale : FORBIDDEN)", async () => {
    const org = await createOrg("WH Auteur svc");
    const ep = await addEndpoint(org);
    const d = await insertDelivery(org, ep.id, { status: "failed" });
    const dispatcher: Actor = { type: "user", id: await createMember(org, "dispatcher") };
    for (const call of [
      () => remove(org, ep.id, dispatcher),
      () => setEnabled(org, ep.id, false, dispatcher),
      () => rotate(org, ep.id, dispatcher),
      () => ping(org, ep.id, dispatcher),
      () => redeliver(org, d.id, dispatcher),
    ]) {
      expect((await expectPgError(call())).code).toBe("42501");
    }
    expect(await endpointRow(ep.id)).toMatchObject({ enabled: true });
  });
});

// =============================================================================
// Droits d'accès
// =============================================================================
describe("Webhooks : droits d'accès", () => {
  const SVC_CALLS = (org: Org, id: string) => [
    `select public.svc_webhook_upsert('${org.id}', 'https://pirate.example.com/x', null, null, null, 'user', '${org.ownerId}')`,
    `select public.svc_webhook_delete('${org.id}', '${id}', 'user', '${org.ownerId}')`,
    `select public.svc_webhook_set_enabled('${org.id}', '${id}', false, 'user', '${org.ownerId}')`,
    `select public.svc_webhook_rotate_secret('${org.id}', '${id}', 'user', '${org.ownerId}')`,
    `select public.svc_webhook_ping('${org.id}', '${id}', 'user', '${org.ownerId}')`,
    `select public.svc_webhook_redeliver('${org.id}', '${id}', 'user', '${org.ownerId}')`,
  ];
  const PRIVATE_CALLS = [
    "select * from private.claim_webhook_deliveries(10)",
    `select private.complete_webhook_delivery('${randomUUID()}', true, 200, null)`,
    "select private.purge_webhook_deliveries()",
    "select private.webhook_ride_json(gen_random_uuid())",
    "select * from private.webhook_check_url('https://example.com')",
    "select private.webhook_event_types()",
    "select private.webhook_tests_exhausted(gen_random_uuid())",
  ];

  it("svc_* : service role seulement ; claim / complete / purge et helpers : ni client ni service role", async () => {
    const org = await createOrg("WH Droits fonctions");
    const ep = await addEndpoint(org);
    for (const who of [{ role: "anon" as const }, { sub: org.ownerId }]) {
      for (const stmt of [...SVC_CALLS(org, ep.id), ...PRIVATE_CALLS]) {
        const e = await expectPgError(as(who, (q) => q(stmt)));
        expect(e.code, `${JSON.stringify(who)} ${stmt}`).toBe("42501");
      }
    }
    for (const stmt of PRIVATE_CALLS) {
      const e = await expectPgError(as({ role: "service_role" }, (q) => q(stmt)));
      expect(e.code, stmt).toBe("42501");
    }
    // Service role : toutes les fonctions svc_* (sans erreur de droit)
    for (const stmt of SVC_CALLS(org, ep.id).reverse()) {
      await as({ role: "service_role" }, (q) => q(stmt));
    }

    // Déclencheur : security definer (écrit une table protégée) ; worker et helpers : sans definer (CLAUDE.md)
    const definer = await sql(
      `select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = any ($1::text[]) order by 1`,
      [["queue_ride_webhooks", "claim_webhook_deliveries", "complete_webhook_delivery", "purge_webhook_deliveries",
        "webhook_ride_json", "webhook_endpoint_json", "webhook_check_url", "webhook_ip_blocked", "webhook_actor",
        "webhook_audit", "webhook_event_types", "webhook_tests_exhausted"]],
    );
    expect(definer.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual(["queue_ride_webhooks"]);
    expect(definer).toHaveLength(12);
    const svcDefiner = await sql(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'svc\\_webhook\\_%' and p.prosecdef
          and 'search_path=""' = any (p.proconfig)`,
    );
    expect(svcDefiner[0].n).toBe(6);
  });

  it("RLS : propriétaire, administrateur et super admin lisent adresses et envois de la centrale ; dispatcher, chauffeur, autre centrale : rien", async () => {
    const org = await createOrg("WH Lecture");
    const other = await createOrg("WH Lecture voisine");
    const ep = await addEndpoint(org);
    await addEndpoint(other);
    await ping(org, ep.id);
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");
    const driver = await createDriver(org, { firstName: "Lou" });
    const sa = await superAdmin();

    const read = (sub: string) =>
      as({ sub }, async (q) => ({
        endpoints: (await q(`select id, organization_id from public.webhook_endpoints`)).map((r) => r.organization_id),
        deliveries: (await q(`select organization_id from public.webhook_deliveries`)).map((r) => r.organization_id),
      }));
    for (const sub of [org.ownerId, admin]) {
      const r = await read(sub);
      expect(r.endpoints).toEqual([org.id]);
      expect(r.deliveries).toEqual([org.id]);
    }
    for (const sub of [dispatcher, driver.userId, other.ownerId]) {
      const r = await read(sub);
      expect(r.endpoints.filter((o) => o === org.id), sub).toEqual([]);
      expect(r.deliveries.filter((o) => o === org.id), sub).toEqual([]);
    }
    const bySa = await read(sa);
    expect(bySa.endpoints).toContain(org.id);
    expect(bySa.endpoints).toContain(other.id);

    // Administrateur désactivé : plus rien
    await sql(`update public.organization_users set status = 'disabled' where organization_id = $1 and user_id = $2`, [org.id, admin]);
    expect((await read(admin)).endpoints).toEqual([]);
  });

  it("secrets : ni anonyme ni membre (même propriétaire) ; aucune écriture client sur les trois tables ; service role : accès serveur", async () => {
    const org = await createOrg("WH Secrets");
    const ep = await addEndpoint(org);
    const d = await insertDelivery(org, ep.id);
    const stmts = [
      "select * from public.webhook_endpoint_secrets",
      "select * from public.webhook_endpoints",
      "select * from public.webhook_deliveries",
      `insert into public.webhook_endpoints (organization_id, url) values ('${org.id}', 'https://pirate.example.com/x')`,
      `update public.webhook_endpoints set url = 'https://pirate.example.com/x' where id = '${ep.id}'`,
      `delete from public.webhook_endpoints where id = '${ep.id}'`,
      `insert into public.webhook_endpoint_secrets (endpoint_id, secret) values ('${ep.id}', '${"p".repeat(40)}')`,
      `update public.webhook_endpoint_secrets set secret = '${"p".repeat(40)}'`,
      `delete from public.webhook_endpoint_secrets`,
      `insert into public.webhook_deliveries (organization_id, endpoint_id, event_type) values ('${org.id}', '${ep.id}', 'ping')`,
      `update public.webhook_deliveries set status = 'pending' where id = '${d.id}'`,
      `delete from public.webhook_deliveries where id = '${d.id}'`,
    ];
    for (const stmt of stmts) {
      const e = await expectPgError(as({ role: "anon" }, (q) => q(stmt)));
      expect(e.code, `anon ${stmt}`).toBe("42501");
    }
    for (const stmt of stmts.filter((s) => !/^select \* from public\.webhook_(endpoints|deliveries)$/.test(s))) {
      const e = await expectPgError(as({ sub: org.ownerId }, (q) => q(stmt)));
      expect(e.code, `propriétaire ${stmt}`).toBe("42501");
    }
    expect(await secretOf(ep.id)).toBe(ep.secret);
    expect(await endpointRow(ep.id)).toMatchObject({ url: ep.url });
    const viaService = await as({ role: "service_role" }, (q) =>
      q(`select secret from public.webhook_endpoint_secrets where endpoint_id = $1`, [ep.id]));
    expect(viaService).toEqual([{ secret: ep.secret }]);
  });

  it("organization_id immuable sur les adresses et les envois", async () => {
    const org = await createOrg("WH Tenant");
    const other = await createOrg("WH Tenant voisine");
    const ep = await addEndpoint(org);
    const d = await insertDelivery(org, ep.id);
    expect((await expectPgError(sql(`update public.webhook_endpoints set organization_id = $2 where id = $1`, [ep.id, other.id]))).code).toBe("42501");
    expect((await expectPgError(sql(`update public.webhook_deliveries set organization_id = $2 where id = $1`, [d.id, other.id]))).code).toBe("42501");
  });
});
