// Réseau partagé, lot 7 — tests transverses (§14.1 n° 30 à 32 de la spécification) : un cycle complet de courses
// partagées sans aucune erreur de clé étrangère (23503), puis, sur les données laissées par ce cycle, le balayage
// GÉNÉRIQUE des fuites (chaque table lisible par un membre de A, de B et par le chauffeur partenaire, colonnes accordées
// lues sous son propre rôle) et le temps réel par topic. Réglages du réseau écrits directement (helpers de
// tests/db/helpers.ts) ; l'interrupteur est ouvert pour ce fichier et recoupé à la fin.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveNetwork, as, CDG, createDriver, createMember, createOrg, createRideAsOwner, enableNetwork, expectPgError, inMinutes,
  north, pool, setSharedNetwork, sql, type Driver,
} from "./helpers";
import {
  finish, giver, moveTo, orgName, pendingOffer, readyPartner, rpc, siteMaker, stepAs, tag, uniquePhone, type Pair,
} from "./network-fixtures";

const nextSite = siteMaker(-75);

beforeAll(async () => {
  await setSharedNetwork(true);
});

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

// -----------------------------------------------------------------------------
// Données propres à ce fichier : valeurs reconnaissables, cherchées telles quelles par le balayage
// -----------------------------------------------------------------------------
const CLIENT = { name: "Cliente Lot7 Confidentielle", phone: "+33677001122", email: "cliente.lot7@example.com" };
const PICKUP = "21 Rue des Secrets, 75008 Paris";
const DROPOFF = "7 Quai Discret, 69002 Lyon";
const COMMENT = "Digicode 9988Z, sonner chez Mme Arbogast";
const PARTNER_LAST_NAME = "Zemmouribelkacem";
const PARTNER_NUMBER = 90817;

type Message = { id: number; topic: string; event: string; payload: Record<string, any> };
const lastMessageId = async () => Number((await sql(`select coalesce(max(id), 0) as m from realtime.messages`))[0].m);
const messagesSince = async (after: number, topics: string[]) =>
  (await sql(`select id, topic, event, payload from realtime.messages where id > $1 and topic = any ($2) order by id`, [after, topics])).map(
    (m) => ({ ...m, id: Number(m.id) }),
  ) as Message[];

/** État partagé par les tests du fichier (le cycle n° 30 prépare les données des balayages n° 31 et 32). */
const ctx: {
  p: Pair;
  own: Driver; // chauffeur de A
  other: Driver; // autre chauffeur de B (jamais sollicité)
  aAdmin: string;
  aDispatcher: string;
  bAdmin: string;
  bDispatcher: string;
  rides: Record<string, string>; // étape → id de course de A
  marker: number; // dernier message temps réel avant le cycle
  windows: Array<[number, number]>; // intervalles (ids de messages) où le partenaire est en course pour A (immédiates)
  ownerIds: string[];
} = {} as never;

const call = (who: string, fn: string, args: unknown[] = []) => rpc(who, fn, args);

/** Course de A au lieu de la paire (client, adresses et commentaire reconnaissables). */
async function rideOfA(overrides: Record<string, unknown> = {}) {
  const { p } = ctx;
  const cols = {
    organization_id: p.A.id, pickup_address: PICKUP, pickup_lat: p.site[0], pickup_lng: p.site[1], dropoff_address: DROPOFF,
    dropoff_lat: CDG[0], dropoff_lng: CDG[1], customer_name: CLIENT.name, customer_phone: CLIENT.phone, customer_email: CLIENT.email,
    comment: COMMENT, passengers: 2, vehicle_category: "business", price_cents: 5000, ...overrides,
  };
  const keys = Object.keys(cols);
  const [row] = await as({ sub: p.A.ownerId }, (q) =>
    q(`insert into public.rides (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id, number`, Object.values(cols)),
  );
  return row as { id: string; number: number };
}

/** Course immédiate amenée à la fin de ses vagues propres, puis un passage du dispatch (étape réseau). */
async function toNetworkStage(rideId: string) {
  await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [rideId]);
  await sql("select private.dispatch_tick()");
}

/** Le partenaire accepte l'offre réseau en attente ; ouvre un intervalle « course de A tenue par le partenaire ». */
async function partnerTakes(rideId: string) {
  const offer = await pendingOffer(rideId, ctx.p.partner.id);
  expect(offer, "offre réseau envoyée").toBeTruthy();
  const start = await lastMessageId();
  expect(await call(ctx.p.partner.userId, "accept_ride_offer", [offer!.id])).toMatchObject({ ok: true, code: "ACCEPTED" });
  return start;
}
async function closeWindow(start: number) {
  ctx.windows.push([start, await lastMessageId()]);
}

/** Immédiate de A acceptée par le partenaire (étape réseau réelle). */
async function sharedImmediate(overrides: Record<string, unknown> = {}) {
  const { p } = ctx;
  await moveTo(p.partner.id, north(p.site, 800));
  await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [p.partner.id]);
  const ride = await rideOfA(overrides);
  await toNetworkStage(ride.id);
  const start = await partnerTakes(ride.id);
  return { ride, start };
}

/** Écriture sans déclencheurs (horloge simulée), données de test seulement. */
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

const executionsOf = (rideId: string) =>
  sql(`select id, executor_driver_id, end_reason, ended_at from public.ride_network_executions where ride_id = $1 order by accepted_at`, [rideId]);
const rideRow = async (rideId: string) => (await sql(`select * from public.rides where id = $1`, [rideId]))[0];

// =============================================================================
// n° 30 — Cycle complet sans 23503
// =============================================================================
describe("Cycle complet d'une organisation qui confie ses courses (§14.1 n° 30)", () => {
  it("acceptation, étapes, fin (règlement + frais), annulation par A, retraits (B, A), assign_ride, redispatch_ride, Non effectuée, alertes, rappels — sans 23503", async () => {
    const site = nextSite();
    const A = await giver("Centrale Cycle", "centrale");
    await sql(`update public.organizations set phone = '+33140000071' where id = $1`, [A.id]);
    const B = await createOrg(`Flotte Cycle ${tag()}`);
    await enableNetwork(B, { in: true });
    await approveNetwork(B);
    const partner = await readyPartner(B, { firstName: "Karim", lastName: PARTNER_LAST_NAME, at: north(site, 800) });
    await sql(`update public.drivers set number = $2 where id = $1`, [partner.id, PARTNER_NUMBER]);
    const p: Pair = { A, B, partner, site, aName: await orgName(A), bName: await orgName(B) };
    ctx.p = p;
    ctx.rides = {};
    ctx.windows = [];
    ctx.other = await readyPartner(B, { firstName: "Samir", lastName: "Hors-Champ", at: north(nextSite(), 800) });
    ctx.own = await createDriver(A, { firstName: "Paul", at: north(nextSite(), 500), presence: "offline" });
    await sql(`update public.drivers set phone = $2, last_name = 'Martin' where id = $1`, [ctx.own.id, uniquePhone()]);
    ctx.aAdmin = await createMember(A, "admin");
    ctx.aDispatcher = await createMember(A, "dispatcher");
    ctx.bAdmin = await createMember(B, "admin");
    ctx.bDispatcher = await createMember(B, "dispatcher");
    ctx.marker = await lastMessageId();

    // 1. Immédiate payée à bord (carte) : étapes, alerte GPS muet puis rétablie, signalement routier refusé pendant la
    //    course partenaire (Q5), fin → règlement réseau (driver_owes) + frais Rydar chez A ; déclaration puis « Reçu »
    const r1 = await sharedImmediate({ payment_method: "card" });
    ctx.rides.completedCard = r1.ride.id;
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
      await moveTo(partner.id, site);
      expect(await stepAs(partner, r1.ride.id, s), s).toMatchObject({ ok: true });
    }
    await moveTo(partner.id, site, 600);
    await sql("select private.watch_rides()");
    const [gpsAlert] = await sql(`select kind, status, data from public.ride_alerts where ride_id = $1`, [r1.ride.id]);
    expect(gpsAlert).toMatchObject({ status: "open", data: { network: true } });
    await moveTo(partner.id, site);
    await sql("select private.watch_rides()");
    const report = await expectPgError(
      call(partner.userId, "send_chat_message", [null, "fleet", null, null, "police", site[0], site[1]]),
    );
    expect([report.code, report.message]).toEqual(["55000", expect.stringContaining("NETWORK_RIDE_REPORT_BLOCKED")]);
    expect(await stepAs(partner, r1.ride.id, "IN_PROGRESS")).toMatchObject({ ok: true });
    await moveTo(partner.id, CDG);
    expect(await stepAs(partner, r1.ride.id, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
    await closeWindow(r1.start);
    const [s1] = await sql(`select * from public.ride_settlements where ride_id = $1`, [r1.ride.id]);
    expect(s1).toMatchObject({
      organization_id: A.id, driver_id: null, network_driver_id: partner.id, network_driver_org_id: B.id, direction: "driver_owes",
      network_counterparty: "driver", status: "due",
    });
    expect(await call(partner.userId, "driver_declare_network_payment", [A.id, [s1.id], "cash", null])).toMatchObject({ ok: true });
    expect(await call(A.ownerId, "confirm_settlements", [[s1.id], "cash", null])).toMatchObject({ ok: true });
    // Signalement routier hors course partenaire : permis (sa flotte, sa position)
    expect(await call(partner.userId, "send_chat_message", [null, "fleet", null, null, "police", site[0], site[1]]))
      .toMatchObject({ report_type: "police", author_driver_id: partner.id });

    // 2. Immédiate prépayée (en ligne) : RIB, fin → A doit la part du chauffeur ; consultation du RIB, « Versé »
    expect(await call(partner.userId, "driver_set_payout_details", [`Karim ${PARTNER_LAST_NAME}`, "FR7630006000011234567890189", null]))
      .toMatchObject({ configured: true });
    const r2 = await sharedImmediate({ payment_method: "online" });
    ctx.rides.completedOnline = r2.ride.id;
    await finish(partner, r2.ride.id, site);
    await closeWindow(r2.start);
    const [s2] = await sql(`select * from public.ride_settlements where ride_id = $1`, [r2.ride.id]);
    expect(s2).toMatchObject({ direction: "centrale_owes", network_driver_id: partner.id, status: "due" });
    expect(await call(A.ownerId, "org_network_payout_info", [s2.id])).toMatchObject({ settlement_id: s2.id });
    expect(await call(A.ownerId, "confirm_settlements", [[s2.id], "transfer", null])).toMatchObject({ ok: true });

    // 3. Annulée par A pendant que le partenaire la tient
    const r3 = await sharedImmediate();
    ctx.rides.cancelledByA = r3.ride.id;
    await moveTo(partner.id, site);
    expect(await stepAs(partner, r3.ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    expect(await call(A.ownerId, "cancel_ride", [r3.ride.id, "Client absent"])).toMatchObject({ ok: true, code: "CANCELLED" });
    await closeWindow(r3.start);

    // 4. Retrait par B (fiche suspendue puis rétablie) → recherche reprise chez A ; puis attribuée à Paul (assign_ride),
    //    menée au bout par lui (règlement de centrale ordinaire)
    const r4 = await sharedImmediate();
    ctx.rides.releasedThenAssigned = r4.ride.id;
    expect(await call(B.ownerId, "set_driver_status", [partner.id, "inactive", null])).toMatchObject({ ok: true });
    await closeWindow(r4.start);
    expect(await call(B.ownerId, "set_driver_status", [partner.id, "active", null])).toMatchObject({ ok: true });
    expect(await rideRow(r4.ride.id)).toMatchObject({ driver_id: null, network_at: null });
    await moveTo(ctx.own.id, site);
    await sql(`update public.drivers set presence = 'available' where id = $1`, [ctx.own.id]);
    expect(await call(A.ownerId, "assign_ride", [r4.ride.id, ctx.own.id])).toMatchObject({ ok: true, code: "ASSIGNED" });
    await finish(ctx.own, r4.ride.id, site);
    expect((await sql(`select network_driver_id, driver_id from public.ride_settlements where ride_id = $1`, [r4.ride.id]))[0])
      .toEqual({ network_driver_id: null, driver_id: ctx.own.id });

    // 5. Retirée par A (reassign_ride, « removed_by_giver ») puis attribuée à Paul pendant la recherche (assign_ride)
    const r5 = await sharedImmediate();
    ctx.rides.removedByA = r5.ride.id;
    expect(await call(ctx.aDispatcher, "reassign_ride", [r5.ride.id, "Client injoignable", partner.id])).toMatchObject({ ok: true, network: true });
    await closeWindow(r5.start);
    await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [ctx.own.id]);
    expect(await call(A.ownerId, "assign_ride", [r5.ride.id, ctx.own.id])).toMatchObject({ ok: true, code: "ASSIGNED" });
    expect(await call(A.ownerId, "cancel_ride", [r5.ride.id, "Plus besoin"])).toMatchObject({ ok: true, code: "CANCELLED" });

    // 6. « Relancer » pendant le partage (redispatch_ride) : partage clos, vagues propres, puis nouveau partage (cycle 2)
    //    accepté ; ensuite le chauffeur est retiré du réseau par B (network_watch → « executor_released »), réautorisé,
    //    et la course est attribuée à Paul pour finir
    await moveTo(partner.id, north(site, 800));
    await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [partner.id]);
    const r6 = await rideOfA();
    ctx.rides.redispatched = r6.id;
    await toNetworkStage(r6.id);
    expect(await pendingOffer(r6.id, partner.id)).toBeTruthy();
    expect(await call(ctx.aDispatcher, "redispatch_ride", [r6.id])).toMatchObject({ ok: true, code: "RELAUNCHED" });
    await toNetworkStage(r6.id);
    const start6 = await partnerTakes(r6.id);
    expect(await call(B.ownerId, "set_driver_network_allowed", [partner.id, false])).toMatchObject({ ok: true });
    await sql("select private.watch_rides()");
    await closeWindow(start6);
    expect(await rideRow(r6.id)).toMatchObject({ driver_id: null, network_at: null });
    expect(await call(B.ownerId, "set_driver_network_allowed", [partner.id, true])).toMatchObject({ ok: true });
    await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [ctx.own.id]);
    expect(await call(A.ownerId, "assign_ride", [r6.id, ctx.own.id])).toMatchObject({ ok: true, code: "ASSIGNED" });
    await finish(ctx.own, r6.id, site);

    // 7. Planifiée acceptée dans sa fenêtre réseau : rappels (schedule_reminders), alerte de retard, jamais démarrée →
    //    « Non effectuée » (expire_unstarted_rides)
    await moveTo(partner.id, north(site, 800));
    await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [partner.id]);
    const r7 = await rideOfA({ pickup_at: inMinutes(100) });
    ctx.rides.notPerformed = r7.id;
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes', next_dispatch_at = now() - interval '1 second' where id = $1`, [r7.id]);
    await sql("select private.dispatch_tick()");
    await partnerTakes(r7.id);
    // Planifiée acceptée d'avance : elle n'occupe pas encore le chauffeur (il roule pour sa flotte, qui le voit) ; la
    // position ne serait masquée à B qu'une fois la course commencée (course en cours)
    expect((await sql(`select current_ride_id from public.drivers where id = $1`, [partner.id]))[0].current_ride_id).toBeNull();
    await sql("select private.schedule_reminders($1)", [r7.id]);
    const reminders = await sql(`select organization_id, driver_org_id, type from public.notifications where ride_id = $1 and type = 'ride_reminder'`, [r7.id]);
    expect(reminders.length).toBeGreaterThan(0);
    for (const n of reminders) expect(n).toMatchObject({ organization_id: A.id, driver_org_id: B.id });
    // Prise en charge dans 5 min, partenaire à 30 km : alerte « retard » (apply_ride_alert)
    await rewind([[`update public.rides set pickup_at = now() + interval '5 minutes' where id = $1`, [r7.id]]]);
    await moveTo(partner.id, north(site, 30_000));
    await sql("select private.watch_rides()");
    expect((await sql(`select kind from public.ride_alerts where ride_id = $1`, [r7.id])).length).toBeGreaterThan(0);
    await rewind([[`update public.rides set pickup_at = now() - interval '7 hours' where id = $1`, [r7.id]]]);
    await sql("select private.expire_unstarted_rides()");
    expect(await rideRow(r7.id)).toMatchObject({ status: "CANCELLED" });

    // Bilan : chaque exécution close avec le bon motif, partenaire libre, partages clos, frais Rydar chez A seulement
    const reasons = Object.fromEntries(
      await Promise.all(Object.entries(ctx.rides).map(async ([k, id]) => [k, (await executionsOf(id)).map((e) => e.end_reason)])),
    );
    expect(reasons).toEqual({
      completedCard: ["completed"],
      completedOnline: ["completed"],
      cancelledByA: ["cancelled_by_giver"],
      releasedThenAssigned: ["executor_released"],
      removedByA: ["removed_by_giver"],
      redispatched: ["executor_released"],
      notPerformed: ["not_performed"],
    });
    expect(await sql(`select 1 from public.ride_network_executions where executor_driver_id = $1 and ended_at is null`, [partner.id])).toEqual([]);
    expect(await sql(`select status from public.ride_network_shares where organization_id = $1 and status = 'open'`, [A.id])).toEqual([]);
    expect((await sql(`select presence, current_ride_id from public.drivers where id = $1`, [partner.id]))[0])
      .toMatchObject({ current_ride_id: null });
    const fees = await sql(`select organization_id, ride_id from public.platform_fee_entries where organization_id in ($1, $2)`, [A.id, B.id]);
    expect(fees.every((f) => f.organization_id === A.id)).toBe(true);
    for (const id of [r1.ride.id, r2.ride.id, r4.ride.id, r6.id]) expect(fees.some((f) => f.ride_id === id), id).toBe(true);
    expect((await sql(`select status from public.ride_settlements where id = any ($1) order by direction desc`, [[s1.id, s2.id]])).map((x) => x.status))
      .toEqual(["paid", "paid"]);
    ctx.ownerIds = [A.ownerId, B.ownerId];
  });
});

// =============================================================================
// n° 31 — Balayage générique des fuites (après le cycle)
// =============================================================================
type Row = Record<string, unknown>;
type Probe = { label: string; test: (value: string | number) => boolean };

/** Tables et vues de public lisibles par authenticated, avec les colonnes accordées (droit de table ou par colonne). */
async function readableRelations() {
  return (await sql(`
    select c.relname::text as name, array_agg(a.attname::text order by a.attnum) as cols
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relkind in ('r', 'v', 'm', 'p') and has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT')
     group by c.relname order by c.relname`)) as Array<{ name: string; cols: string[] }>;
}

/** Tout ce que `who` lit directement (son rôle, RLS), table par table. */
async function readAll(who: string): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const t of await readableRelations()) {
    const cols = t.cols.map((c) => `"${c}"`).join(", ");
    out[t.name] = (await as({ sub: who }, (q) => q(`select to_jsonb(x) as r from (select ${cols} from public."${t.name}") x`))).map(
      (x) => x.r as Row,
    );
  }
  return out;
}

/** Valeurs (et clés) d'une valeur JSON, en profondeur. */
function walk(value: unknown, visit: (v: string | number, isKey: boolean) => void) {
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (Array.isArray(value)) value.forEach((x) => walk(x, visit));
  else if (typeof value === "object") {
    for (const [k, x] of Object.entries(value as Row)) {
      visit(k, true);
      walk(x, visit);
    }
  } else visit(value as string | number, false);
}

/** « table.colonne : secret » pour chaque valeur lue qui contient un secret (colonnes permises exclues). */
function leaks(data: Record<string, Row[]>, probes: Probe[], allowed: Record<string, string[]> = {}, keyProbes: Probe[] = []) {
  const hits = new Set<string>();
  for (const [table, rows] of Object.entries(data)) {
    for (const row of rows) {
      for (const [col, value] of Object.entries(row)) {
        if (allowed[table]?.includes(col)) continue;
        walk(value, (v, isKey) => {
          for (const probe of isKey ? keyProbes : probes) if (probe.test(v)) hits.add(`${table}.${col} : ${probe.label}`);
        });
      }
    }
  }
  return [...hits].sort();
}

const contains = (label: string, needle: string): Probe => ({
  label, test: (v) => typeof v === "string" && v.toLowerCase().includes(needle.toLowerCase()),
});
const numberProbe = (label: string, n: number): Probe => ({
  label, test: (v) => (typeof v === "number" ? v === n : v === String(n) || new RegExp(`#\\s?${n}\\b`).test(v)),
});

describe("Balayage des fuites après le cycle (§14.1 n° 31, S3)", () => {
  it("membres de A (owner, admin, dispatcher) : aucune table ne livre l'identité du partenaire ni de B ; seuls identifiants opaques : rides.driver_id / vehicle_id, ride_settlements.network_driver_id, ride_alerts.driver_id", async () => {
    const { p } = ctx;
    const [partnerRow] = await sql(
      `select d.phone, d.vtc_card_number, d.vtc_operator_registration, u.email
         from public.drivers d join auth.users u on u.id = d.user_id where d.id = $1`,
      [p.partner.id],
    );
    const probes: Probe[] = [
      contains("id du partenaire", p.partner.id),
      contains("compte du partenaire", p.partner.userId),
      contains("véhicule du partenaire", p.partner.vehicleId),
      contains("nom de famille du partenaire", PARTNER_LAST_NAME),
      numberProbe("n° interne du partenaire", PARTNER_NUMBER),
      contains("téléphone du partenaire", partnerRow.phone),
      contains("e-mail du partenaire", partnerRow.email),
      contains("carte VTC du partenaire", partnerRow.vtc_card_number),
      contains("IBAN du partenaire", "FR7630006000011234567890189"),
      contains("autre chauffeur de B", ctx.other.id),
      contains("compte d'un autre chauffeur de B", ctx.other.userId),
      contains("Samir Hors-Champ", "Hors-Champ"),
      contains("propriétaire de B", p.B.ownerId),
      contains("admin de B", ctx.bAdmin),
      contains("dispatcher de B", ctx.bDispatcher),
    ];
    // Seuls identifiants opaques lus (§14.1 n° 31) : chauffeur et véhicule de la course, débiteur de la ligne réseau,
    // chauffeur d'une alerte (résidu accepté au lot 2 : même valeur que rides.driver_id, clé étrangère et effacement) —
    // jamais son nom, son n°, ses coordonnées, son RIB, ni rien d'autre de B
    const residual = [
      "ride_alerts.driver_id : id du partenaire",
      "ride_settlements.network_driver_id : id du partenaire",
      "rides.driver_id : id du partenaire",
      "rides.vehicle_id : véhicule du partenaire",
    ];
    for (const [who, label] of [[p.A.ownerId, "owner"], [ctx.aAdmin, "admin"], [ctx.aDispatcher, "dispatcher"]] as const) {
      const data = await readAll(who);
      expect(leaks(data, probes), `A ${label}`).toEqual(residual);
      // Le partenaire est bien là sous son libellé court (preuve que le balayage lit les bonnes lignes)
      expect(JSON.stringify(data.ride_events), label).toContain("Karim Z.");
      expect(data.rides.some((r) => r.driver_id === p.partner.id || r.id === ctx.rides.completedCard), label).toBe(true);
    }
  });

  it("membres de B : rien de A (courses, client, adresses, commentaire, membres, chauffeurs, règlements) ; chauffeur partenaire : rien de A hors ses offres et notifications, jamais le client ni les montants internes de A", async () => {
    const { p } = ctx;
    const settlements = (await sql(`select id from public.ride_settlements where organization_id = $1`, [p.A.id])).map((x) => x.id as string);
    const clientProbes: Probe[] = [
      contains("nom du client", CLIENT.name),
      contains("téléphone du client", CLIENT.phone),
      contains("e-mail du client", CLIENT.email),
      contains("adresse de départ", "Rue des Secrets"),
      contains("adresse d'arrivée", "Quai Discret"),
      contains("commentaire", "9988Z"),
      contains("nom dans le commentaire", "Arbogast"),
      contains("chauffeur de A", ctx.own.id),
      contains("compte du chauffeur de A", ctx.own.userId),
      contains("propriétaire de A", p.A.ownerId),
      contains("admin de A", ctx.aAdmin),
      contains("dispatcher de A", ctx.aDispatcher),
    ];
    const rideProbes = Object.entries(ctx.rides).map(([k, id]) => contains(`course de A (${k})`, id));
    const settlementProbes = settlements.map((id) => contains("règlement de A", id));
    for (const [who, label] of [[p.B.ownerId, "owner"], [ctx.bAdmin, "admin"], [ctx.bDispatcher, "dispatcher"]] as const) {
      expect(leaks(await readAll(who), [...clientProbes, ...rideProbes, ...settlementProbes]), `B ${label}`).toEqual([]);
    }

    // Chauffeur partenaire, 1 h après la fin de ses courses (ménage : rappels et points de la course partagée purgés) :
    // ses offres et notifications citent les courses de A (identifiants nécessaires à l'app), jamais le client, le
    // commentaire, l'adresse exacte, les membres ou chauffeurs de A, ni la commission ou les frais Rydar de A
    await rewind([[
      `update public.ride_network_executions set ended_at = ended_at - interval '2 hours' where executor_driver_id = $1 and ended_at is not null`,
      [p.partner.id],
    ]]);
    await sql("select private.housekeeping()");
    const mine = await readAll(p.partner.userId);
    const moneyKeys: Probe[] = [
      { label: "clé commission_cents", test: (v) => v === "commission_cents" },
      { label: "clé platform_fee_cents", test: (v) => v === "platform_fee_cents" },
    ];
    expect(leaks(mine, clientProbes, {}, moneyKeys), "chauffeur partenaire").toEqual([]);
    expect(mine.rides, "aucune course de A en lecture directe").toEqual([]);
    expect(mine.ride_settlements, "aucun règlement réseau en lecture directe").toEqual([]);
    expect(mine.notifications.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// n° 32 — Temps réel du cycle, par topic
// =============================================================================
describe("Temps réel du cycle (§14.1 n° 32, S14)", () => {
  it("org:{B} et fleet:{B} : rien de A ; pendant ses courses de A, ni position ni course du partenaire pour B ; org:{A} : jamais l'identité, la distance ni la vague du partenaire", async () => {
    const { p } = ctx;
    const msgs = await messagesSince(ctx.marker, [`org:${p.A.id}`, `org:${p.B.id}`, `fleet:${p.B.id}`, `driver:${p.partner.id}`]);
    const of = (topic: string) => msgs.filter((m) => m.topic === topic);
    const inWindow = (m: Message) => ctx.windows.some(([a, b]) => m.id > a && m.id <= b);
    /** Chauffeur concerné : driver.location porte driver_id, driver.updated porte id. */
    const subject = (m: Message) => (m.event === "driver.location" ? m.payload.driver_id : m.payload.id);
    const orgA = of(`org:${p.A.id}`);
    const orgB = of(`org:${p.B.id}`);
    const fleetB = of(`fleet:${p.B.id}`);
    expect(orgA.length).toBeGreaterThan(20);
    expect(orgB.length).toBeGreaterThan(5);

    // B : aucune donnée de A (courses, client, adresses, commentaire, membres, chauffeur de A)
    const aSecrets = [
      ...Object.values(ctx.rides), CLIENT.name, CLIENT.phone, CLIENT.email, "Rue des Secrets", "Quai Discret", "9988Z", "Arbogast",
      ctx.own.id, p.A.ownerId, ctx.aAdmin, ctx.aDispatcher,
    ];
    for (const [topic, list] of [["org:B", orgB], ["fleet:B", fleetB]] as const) {
      const text = JSON.stringify(list);
      for (const secret of aSecrets) expect(text, `${topic} : ${secret}`).not.toContain(secret);
    }
    // Pendant chaque course de A tenue par le partenaire : aucune position pour B, statut « En course partenaire »
    expect(orgB.some((m) => m.event === "driver.location" && subject(m) === p.partner.id && !inWindow(m))).toBe(true);
    expect(orgB.filter((m) => m.event === "driver.location" && subject(m) === p.partner.id && inWindow(m))).toEqual([]);
    const busy = orgB.filter((m) => m.event === "driver.updated" && m.payload.id === p.partner.id && inWindow(m) && m.payload.current_ride_id);
    expect(busy).toEqual([]);
    expect(orgB.some((m) => m.event === "driver.updated" && m.payload.network === true && m.payload.network_giver === p.aName)).toBe(true);
    for (const m of orgB.filter((x) => x.event === "network.updated")) expect(Object.keys(m.payload)).toEqual(["execution_id"]);
    // Le signalement fait hors course partenaire passe bien par fleet:{B} (le fil est écouté)
    expect(fleetB.some((m) => JSON.stringify(m.payload).includes("police"))).toBe(true);

    // A : jamais l'identifiant, le nom de famille, le n° interne ni la position du partenaire ; offres réseau sans
    // chauffeur, distance ni vague ; courses tenues par le partenaire sans driver_id
    const text = JSON.stringify(orgA);
    for (const secret of [p.partner.id, p.partner.userId, PARTNER_LAST_NAME, p.B.ownerId, ctx.other.id]) {
      expect(text, `org:A : ${secret}`).not.toContain(secret);
    }
    expect(orgA.filter((m) => ["driver.location", "driver.updated"].includes(m.event) && subject(m) !== ctx.own.id)).toEqual([]);
    const networkOffers = orgA.filter((m) => m.event === "offer.updated" && m.payload.network === true);
    expect(networkOffers.length).toBeGreaterThan(0);
    for (const m of networkOffers) expect(m.payload).toMatchObject({ driver_id: null, distance_m: null, wave: null });
    for (const m of orgA.filter((x) => x.event === "ride.updated" && x.payload.network === true)) {
      expect(m.payload.driver_id).toBeNull();
    }
    walk(orgA.map((m) => m.payload), (v) => expect(v === PARTNER_NUMBER || (typeof v === "string" && /#\s?90817\b/.test(v))).toBe(false));

    // driver:{partenaire} : il reçoit ses courses, offres et règlements
    const mine = of(`driver:${p.partner.id}`);
    expect(mine.some((m) => m.event === "ride.updated" && m.payload.driver_id === p.partner.id)).toBe(true);
    expect(mine.some((m) => m.event === "settlement.updated")).toBe(true);
  });
});

// =============================================================================
// Lot 7 — performance de l'étape réseau : mêmes partenaires, contrôles arrêtés plus tôt
// =============================================================================
describe("Étape réseau : contrôles des partenaires arrêtés à la limite (20260924007200)", () => {
  it("network_candidates(…, p_limit) = début de la liste complète, même ordre ; banni (plateforme) jamais candidat ; 1 suffit à l'arrêt anticipé", async () => {
    const site = nextSite();
    const A = await giver("Centrale Limite", "fleet");
    const B = await createOrg(`Flotte Limite ${tag()}`);
    await enableNetwork(B, { in: true });
    await approveNetwork(B);
    const near = [];
    for (const [i, m] of [300, 900, 1500, 2100].entries()) near.push(await readyPartner(B, { firstName: `P${i}`, at: north(site, m) }));
    // Le plus proche banni par la plateforme (empreinte de sa carte VTC) : jamais candidat
    await sql(
      `insert into public.banned_identities (scope, kind, value_hash, reason)
       select 'platform', k.kind, k.value_hash, 'Fraude' from private.driver_identity_keys k
        where k.driver_id = $1 and k.kind = 'vtc_card'`,
      [near[0]!.id],
    );
    const ride = await createRideAsOwner(A, { pickup_lat: site[0], pickup_lng: site[1], price_cents: 5000 });
    await sql(`update public.rides set network_at = now() where id = $1`, [ride.id]);
    const list = async (limit: number | null) =>
      (await sql(
        `select c.driver_id from private.network_candidates((select r from public.rides r where r.id = $1), 16000, false, $2) c`,
        [ride.id, limit],
      )).map((x) => x.driver_id);
    const all = (await sql(
      `select c.driver_id from private.network_candidates((select r from public.rides r where r.id = $1), 16000) c`, [ride.id],
    )).map((x) => x.driver_id);
    expect(all).toEqual([near[1]!.id, near[2]!.id, near[3]!.id]);
    expect(await list(null)).toEqual(all);
    expect(await list(2)).toEqual(all.slice(0, 2));
    expect(await list(1)).toEqual(all.slice(0, 1));
    expect((await sql(`select private.network_identity_block($1, $2) as r`, [near[0]!.id, A.id]))[0].r).toBe("banned");
    expect((await sql(`select private.network_identity_block($1, $2) as r`, [near[1]!.id, A.id]))[0].r).toBeNull();
  });
});
