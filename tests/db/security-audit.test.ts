// Audit de sécurité p5 (20260924007900_security_audit) : chaque bloc reprend un constat reproduit avant la correction.
//  1. Réseau partagé : l'organisation d'un chauffeur en course partenaire ne retrouve jamais sa position (offre
//     planifiée à toute la flotte, explication de fin de recherche, alertes de suivi).
//  2. Limites de l'offre (chauffeurs, accès) tenues même sous des requêtes simultanées.
//  3. Centrale : un dispatcher ne modifie plus prix, commission ou paiement d'une course qui a un règlement.
//  4. Accusés de réception : un par BOÎTE (alias « +étiquette », points Gmail) et par 24 h.
//  5. Jeton push servi seulement tant que la session qui l'a enregistré existe.
//  6. Position : un saut impossible (> 250 km/h sur plus de 1 km) est ignoré.
//  7. Suppression de compte : « compte conservé » recalculé à la reprise (gérant ou super admin entre-temps).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createDriver, createMember, createOrg, createRideAsOwner, expectPgError, nextWave,
  north, pool, setSharedNetwork, sql, type Driver, type Org,
} from "./helpers";
import { moveTo, networkPair, partnerAccepts, siteMaker } from "./network-fixtures";

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, any>;
const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const uniquePhone = () => `+3365${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/** Transaction ouverte « comme PostgREST » sur une connexion dédiée (requêtes simultanées). */
async function openSession(claims: Row, role = "authenticated") {
  const c = await pool.connect();
  await c.query("begin");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...claims })]);
  await c.query(`set local role ${role}`);
  return c;
}
const settle = async <T,>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));

// =============================================================================
// 1. Réseau partagé : position du chauffeur jamais rendue à sa propre organisation pendant une course partenaire
// =============================================================================
describe("Réseau partagé : position d'un chauffeur en course partenaire", () => {
  const site = siteMaker(65);
  beforeAll(async () => {
    await setSharedNetwork(true);
  });
  afterAll(async () => {
    await setSharedNetwork(false);
  });

  it("course planifiée de B proposée à toute la flotte : aucune distance pour le chauffeur en course partenaire", async () => {
    const s = site();
    const p = await networkPair(s);
    await partnerAccepts(p);
    await moveTo(p.partner.id, north(s, 4321));
    // Chauffeur de B libre, à une distance connue de B (contrôle : la distance reste donnée pour lui)
    const free = await createDriver(p.B, { at: north(s, 1200) });
    const dispatcherB = await createMember(p.B, "dispatcher");

    const inThreeHours = new Date(Date.now() + 3 * 3600_000).toISOString();
    const probe = await createRideAsOwner(p.B, { pickup_lat: s[0], pickup_lng: s[1], pickup_at: inThreeHours, price_cents: 3000 });
    const offers = await as({ sub: dispatcherB }, (q) =>
      q("select driver_id, distance_m from public.ride_offers where ride_id = $1", [probe.id]));
    const partner = offers.find((o: Row) => o.driver_id === p.partner.id);
    expect(partner?.distance_m ?? null).toBeNull();
    expect(Math.abs(offers.find((o: Row) => o.driver_id === free.id)!.distance_m - 1200)).toBeLessThan(25);

    // Diffusion en direct sur org:B : jamais de distance pour lui non plus
    const sent = await sql(
      `select payload from realtime.messages where topic = $1 and event = 'offer.updated' and payload ->> 'driver_id' = $2`,
      [`org:${p.B.id}`, p.partner.id],
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) expect(JSON.stringify(m.payload)).not.toMatch(/"distance_m":\s*\d/);
  });

  it("fin de recherche d'une course de B : chauffeur « déjà en course », sans distance", async () => {
    const s = site();
    const p = await networkPair(s);
    await partnerAccepts(p);
    await moveTo(p.partner.id, north(s, 2345));
    const dispatcherB = await createMember(p.B, "dispatcher");

    const probe = await createRideAsOwner(p.B, { pickup_lat: s[0], pickup_lng: s[1], price_cents: 3000 });
    for (let i = 0; i < 12; i++) {
      const [r] = await sql("select status from public.rides where id = $1", [probe.id]);
      if (r.status === "NO_DRIVER_FOUND") break;
      await nextWave(probe.id);
    }
    const events = await as({ sub: dispatcherB }, (q) =>
      q("select message, data from public.ride_events where ride_id = $1 and type = 'dispatch.excluded'", [probe.id]));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const item = e.data.excluded.find((x: Row) => x.driver_id === p.partner.id);
      expect(item).toMatchObject({ reason: "busy", label: "déjà en course" });
      expect(item.distance_m ?? null).toBeNull();
      expect(e.message).not.toMatch(/\(\d+([,.]\d+)?\s?(k?m)\)\s*:\s*déjà en course/);
    }
  });

  it("course de B enchaînée après la course partenaire : ni retard, ni immobilité, ni GPS calculés sur sa position", async () => {
    const s = site();
    const p = await networkPair(s);
    const { ride } = await partnerAccepts(p, p.partner, { estimated_duration_s: 600 });
    await moveTo(p.partner.id, north(s, 1500));
    const [a] = await sql("select pickup_at from public.rides where id = $1", [ride.id]);
    const pickup = new Date(new Date(a.pickup_at).getTime() + (600 + 45 * 60 + 120) * 1000).toISOString();
    const far = north(s, 30000);
    const probe = await createRideAsOwner(p.B, {
      pickup_lat: far[0], pickup_lng: far[1], pickup_at: pickup, price_cents: 3000, estimated_duration_s: 600,
    });
    const assigned = await rpc(p.B.ownerId, "assign_ride", [probe.id, p.partner.id]);
    expect(assigned.ok, JSON.stringify(assigned)).toBe(true);
    await sql("select private.watch_rides()");

    const dispatcherB = await createMember(p.B, "dispatcher");
    const alerts = await as({ sub: dispatcherB }, (q) => q("select kind, data from public.ride_alerts where ride_id = $1", [probe.id]));
    for (const al of alerts) {
      expect(["late", "stalled", "no_gps"]).not.toContain(al.kind);
      for (const k of ["distance_m", "eta_minutes", "lat", "lng"]) expect(al.data?.[k] ?? null).toBeNull();
    }
    const events = await as({ sub: dispatcherB }, (q) =>
      q("select data from public.ride_events where ride_id = $1 and type like 'alert.%'", [probe.id]));
    for (const e of events) for (const k of ["distance_m", "eta_minutes", "lat", "lng"]) expect(e.data?.[k] ?? null).toBeNull();
  });
});

// =============================================================================
// 2. Limites de l'offre : requêtes simultanées
// =============================================================================
describe("Limites de l'offre sous requêtes simultanées", () => {
  async function planWith(limits: Row) {
    const [plan] = await sql(`insert into public.plans (code, name, limits) values ($1, 'Limitée', $2) returning id`, [
      `limite_${randomUUID().slice(0, 8)}`, JSON.stringify({ api_access: true, ...limits }),
    ]);
    return plan.id as string;
  }

  it("deux validations de candidatures en même temps : la seconde attend puis dépasse → PLAN_LIMIT_DRIVERS", async () => {
    const org = await createOrg("Limite Course", { plan: await planWith({ max_drivers: 1 }) });
    const applicants: string[] = [];
    for (let i = 0; i < 2; i++) {
      const userId = await createAuthUser(`cand-${randomUUID().slice(0, 8)}@test.dev`, "Candidat");
      const [d] = await sql(
        `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence,
           application_status, applied_at, joined_via)
         values ($1, $2, 'Candidat', 'Test', $3, 'inactive', 'offline', 'pending', now(), 'join_link') returning id`,
        [org.id, userId, uniquePhone()],
      );
      applicants.push(d.id);
    }
    const claims = { sub: org.ownerId, iat: Math.floor(Date.now() / 1000) + 1 };
    const c1 = await openSession(claims);
    const c2 = await openSession(claims);
    try {
      const first = await c1.query("select public.approve_driver_application($1, 'new') as r", [applicants[0]]);
      expect(first.rows[0].r).toMatchObject({ ok: true, code: "APPROVED" });
      const second = settle(c2.query("select public.approve_driver_application($1, 'new') as r", [applicants[1]]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await c1.query("commit");
      const outcome = await second;
      if (outcome.ok) expect(outcome.value.rows[0].r.ok).toBe(false);
      else expect(outcome.error.message).toMatch(/PLAN_LIMIT_DRIVERS/);
    } finally {
      for (const c of [c1, c2]) {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    }
    const [{ n }] = await sql(
      `select count(*)::int as n from public.drivers where organization_id = $1 and status in ('invited', 'active', 'suspended')`,
      [org.id],
    );
    expect(n).toBe(1);
  });

  it("deux accès ajoutés en même temps : le second attend puis dépasse → PLAN_LIMIT_ADMINS", async () => {
    const org = await createOrg("Limite Accès", { plan: await planWith({ max_admins: 2, max_drivers: 50 }) });
    const u1 = await createAuthUser(`acces-${randomUUID().slice(0, 8)}@test.dev`, "Accès 1");
    const u2 = await createAuthUser(`acces-${randomUUID().slice(0, 8)}@test.dev`, "Accès 2");
    const c1 = await openSession({}, "service_role");
    const c2 = await openSession({}, "service_role");
    try {
      await c1.query(`insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'admin', 'invited')`, [org.id, u1]);
      const second = settle(
        c2.query(`insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'admin', 'invited')`, [org.id, u2]),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await c1.query("commit");
      const outcome = await second;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.message).toMatch(/PLAN_LIMIT_ADMINS/);
    } finally {
      for (const c of [c1, c2]) {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    }
    const [{ n }] = await sql(
      `select count(*)::int as n from public.organization_users where organization_id = $1 and status in ('active', 'invited')`,
      [org.id],
    );
    expect(n).toBe(2);
  });
});

// =============================================================================
// 3. Centrale : règlement d'une course terminée modifiable par owner / admin seulement
// =============================================================================
describe("Centrale : prix, commission et paiement d'une course réglée", () => {
  const NEAR = north(CHAMPS_ELYSEES, 500);

  async function centrale(name: string) {
    const org = await createOrg(name);
    await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_fixed_cents = 500 where id = $1`, [org.id]);
    return org;
  }

  async function completedRide(org: Org, d: Driver) {
    const ride = await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
    const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [ride.id, d.id]);
    expect(offer, "offre en attente").toBeTruthy();
    expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
    for (const st of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      expect((await rpc(d.userId, "driver_update_ride_status", [ride.id, st])).ok, st).toBe(true);
    }
    return ride;
  }
  const settlementOf = async (rideId: string) => (await sql(`select * from public.ride_settlements where ride_id = $1`, [rideId]))[0];

  it("dispatcher : commission à 0 ou paiement « en ligne » refusés (FORBIDDEN_ROLE), règlement intact ; l'admin corrige", async () => {
    const org = await centrale("Centrale Règlement");
    const d = await createDriver(org, { at: NEAR });
    const ride = await completedRide(org, d);
    const before = await settlementOf(ride.id);
    expect(before).toMatchObject({ status: "due", direction: "driver_owes", amount_cents: 1900 });

    const dispatcher = await createMember(org, "dispatcher");
    for (const patch of ["commission_cents = 0", "payment_method = 'online'", "price_cents = 1500"]) {
      const err = await expectPgError(as({ sub: dispatcher }, (q) => q(`update public.rides set ${patch} where id = $1`, [ride.id])));
      expect(err.message, patch).toMatch(/FORBIDDEN_ROLE/);
    }
    expect(await settlementOf(ride.id)).toMatchObject({ status: "due", direction: "driver_owes", amount_cents: 1900, due_at: before.due_at });

    const admin = await createMember(org, "admin");
    await as({ sub: admin }, (q) => q(`update public.rides set commission_cents = 2000 where id = $1`, [ride.id]));
    expect(await settlementOf(ride.id)).toMatchObject({ status: "due", amount_cents: 2500 });
  });

  it("dispatcher : la correction reste permise avant la fin de la course (aucun règlement)", async () => {
    const org = await centrale("Centrale Avant");
    const ride = await createRideAsOwner(org, { price_cents: 5900, payment_method: "cash" });
    const dispatcher = await createMember(org, "dispatcher");
    await as({ sub: dispatcher }, (q) => q(`update public.rides set price_cents = 6200, payment_method = 'online' where id = $1`, [ride.id]));
    const [r] = await sql(`select price_cents, payment_method from public.rides where id = $1`, [ride.id]);
    expect(r).toMatchObject({ price_cents: 6200, payment_method: "online" });
  });
});

// =============================================================================
// 4. Accusés de réception : une boîte, quelles que soient ses variantes d'adresse
// =============================================================================
describe("Accusés de réception : alias d'une même boîte", () => {
  const request = (email: string) => ({
    id: randomUUID(), topic: "other", name: "Visiteur", email, message: "Bonjour, une question sur l'offre.", ip_hash: "e".repeat(64),
  });
  const ackFor = (email: string) => [{ kind: "contact_ack", to_email: email, reply_to: null, subject: "Demande bien reçue", body_text: "Merci." }];

  it("victime+a / victime+b / v.ictime (Gmail) : un seul accusé ; adresses distinctes ailleurs : un chacun", async () => {
    const box = `victime${randomUUID().slice(0, 6)}`;
    const variants = [`${box}+a@gmail.com`, `${box}+b@gmail.com`, `${box.slice(0, 1)}.${box.slice(1)}@googlemail.com`, `${box.toUpperCase()}@Gmail.com`];
    const queued = [];
    for (const email of variants) queued.push((await svc("svc_contact_submit", [request(email), JSON.stringify(ackFor(email))])).ack_queued);
    expect(queued).toEqual([true, false, false, false]);

    // Hors Gmail : « +étiquette » ignorée, mais les points distinguent deux personnes
    const dom = `ex${randomUUID().slice(0, 6)}.fr`;
    const other = [`jean.dupont@${dom}`, `jean.dupont+promo@${dom}`, `jeandupont@${dom}`];
    const res = [];
    for (const email of other) res.push((await svc("svc_contact_submit", [request(email), JSON.stringify(ackFor(email))])).ack_queued);
    expect(res).toEqual([true, false, true]);
  });

  it("clé de boîte : minuscules, « +étiquette » retirée, points Gmail retirés, googlemail.com = gmail.com", async () => {
    const [r] = await sql(
      `select private.mailbox_key(' V.Ictime+tag@GoogleMail.com ') as a, private.mailbox_key('a.b+c@exemple.fr') as b,
              private.mailbox_key('+x@exemple.fr') as c`,
    );
    expect(r).toEqual({ a: "victime@gmail.com", b: "a.b@exemple.fr", c: "+x@exemple.fr" });
  });
});

// =============================================================================
// 5. Jeton push lié à la session qui l'a enregistré
// =============================================================================
describe("Jetons push : session révoquée = plus de notification", () => {
  async function session(userId: string, createdAgoSeconds = 60) {
    const [s] = await sql(
      `insert into auth.sessions (user_id, created_at) values ($1, now() - make_interval(secs => $2)) returning id`,
      [userId, createdAgoSeconds],
    );
    return s.id as string;
  }
  async function register(d: Driver, sessionId: string | null, token: string) {
    const c = await openSession({ sub: d.userId, ...(sessionId ? { session_id: sessionId } : {}) });
    try {
      const { rows } = await c.query("select public.driver_register_device($1, 'android', $2, 'expo') as r", [`inst-${token}`, token]);
      await c.query("commit");
      return rows[0].r as Row;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }
  async function tokensServed(d: Driver) {
    await sql(
      `insert into public.notifications (organization_id, driver_id, type, title, body, data, priority)
       select organization_id, id, 'chat_message', 'Message', 'Corps du message', '{}'::jsonb, 'normal' from public.drivers where id = $1`,
      [d.id],
    );
    const rows = await sql(`select driver_id, tokens from private.claim_notifications(500)`);
    const mine = rows.filter((r) => r.driver_id === d.id);
    expect(mine.length).toBeGreaterThan(0);
    return [...new Set(mine.flatMap((r) => (r.tokens as Row[]).map((t) => t.token as string)))];
  }

  it("téléphone A : jeton servi tant que sa session existe, plus du tout après « se déconnecter partout »", async () => {
    const org = await createOrg("Push Session");
    const d = await createDriver(org);
    const sA = await session(d.userId);
    const token = `ExponentPushToken[perdu-${randomUUID().slice(0, 8)}]`;
    expect(await register(d, sA, token)).toMatchObject({ ok: true, push: true });
    expect(await tokensServed(d)).toEqual([token]);

    // Mot de passe changé / déconnexion globale : sessions supprimées par Supabase Auth, puis nouvelle connexion (B)
    await sql(`delete from auth.sessions where user_id = $1`, [d.userId]);
    const sB = await session(d.userId, 0);
    expect(await tokensServed(d)).toEqual([]);
    // Le téléphone B enregistre son propre jeton : seul servi
    const tokenB = `ExponentPushToken[neuf-${randomUUID().slice(0, 8)}]`;
    await register(d, sB, tokenB);
    expect(await tokensServed(d)).toEqual([tokenB]);
    // Session expirée (not_after dépassé) : jeton non servi
    await sql(`update auth.sessions set not_after = now() - interval '1 minute' where id = $1`, [sB]);
    expect(await tokensServed(d)).toEqual([]);
    // Session retenue à l'enregistrement (claim « session_id » du jeton d'accès)
    expect((await sql(`select session_id from public.push_tokens where token = $1`, [tokenB]))[0].session_id).toBe(sB);
  });

  it("jeton enregistré avant la migration (sans session) : servi tant qu'une session d'alors existe encore", async () => {
    const org = await createOrg("Push Ancien");
    const d = await createDriver(org);
    await session(d.userId, 120);
    const token = `ExponentPushToken[ancien-${randomUUID().slice(0, 8)}]`;
    await register(d, null, token);
    expect(await tokensServed(d)).toEqual([token]);

    // Dernier enregistrement il y a 10 min (date posée sans le déclencheur touch_updated_at), puis mot de passe changé
    // (toutes les sessions révoquées) et nouvelle connexion ailleurs
    await sql(
      `set session_replication_role = replica;
       update public.push_tokens set updated_at = now() - interval '10 minutes' where token = '${token}';
       set session_replication_role = origin`,
    );
    await sql(`delete from auth.sessions where user_id = $1`, [d.userId]);
    await session(d.userId, 0);
    expect(await tokensServed(d)).toEqual([]);
  });
});

// =============================================================================
// 6. Position : saut impossible ignoré
// =============================================================================
describe("Position du chauffeur : vraisemblance", () => {
  const PARIS: [number, number] = [48.8718, 2.301];
  const NICE: [number, number] = [43.696, 7.265];
  const send = (d: Driver, at: [number, number], recordedAgoSeconds = 0, accuracy = 5) =>
    rpc(d.userId, "update_driver_location", [at[0], at[1], null, null, accuracy, 0.9, new Date(Date.now() - recordedAgoSeconds * 1000).toISOString()]);
  const where = async (d: Driver) => (await sql(`select lat, lng from public.driver_locations where driver_id = $1`, [d.id]))[0];

  it("Paris → Nice en 2 s : point ignoré (LOCATION_IMPLAUSIBLE), position précédente gardée ; trajet normal accepté", async () => {
    const org = await createOrg("Position Saut");
    const d = await createDriver(org);
    expect(await send(d, PARIS, 2)).toMatchObject({ ok: true, presence: "available" });
    const jump = await send(d, NICE, 0, 1_000_000);
    expect(jump).toMatchObject({ ok: false, code: "LOCATION_IMPLAUSIBLE", presence: "available" });
    expect(jump.next_interval_s).toBeGreaterThan(0);
    expect(await where(d)).toEqual({ lat: PARIS[0], lng: PARIS[1] });
    expect((await sql(`select count(*)::int as n from public.driver_location_history where driver_id = $1 and lat = $2`, [d.id, NICE[0]]))[0].n).toBe(0);

    // 800 m en 2 s (imprécision GPS) puis 1,5 km en 60 s (90 km/h) : acceptés
    expect((await send(d, north(PARIS, 800))).ok).toBe(true);
    await sql(`update public.driver_locations set recorded_at = recorded_at - interval '60 seconds', updated_at = updated_at - interval '60 seconds' where driver_id = $1`, [d.id]);
    expect((await send(d, north(PARIS, 800 + 1500))).ok).toBe(true);
    // 3 km aussitôt après : ignoré
    expect((await send(d, north(PARIS, 800 + 1500 + 3000))).code).toBe("LOCATION_IMPLAUSIBLE");
  });

  it("dernière position vieille de plus de 10 min (avion, téléphone éteint) : nouvelle position acceptée", async () => {
    const org = await createOrg("Position Vol");
    const d = await createDriver(org);
    expect((await send(d, PARIS)).ok).toBe(true);
    await sql(`update public.driver_locations set recorded_at = now() - interval '80 minutes', updated_at = now() - interval '80 minutes' where driver_id = $1`, [d.id]);
    expect(await send(d, NICE)).toMatchObject({ ok: true });
    expect(await where(d)).toEqual({ lat: NICE[0], lng: NICE[1] });
  });
});

// =============================================================================
// 7. Suppression de compte : « compte conservé » recalculé à la reprise
// =============================================================================
describe("Suppression de compte : compte devenu gérant entre la demande et la reprise", () => {
  beforeAll(async () => {
    await sql(`create table if not exists auth.audit_log_entries (
      instance_id uuid, id uuid primary key, payload json, created_at timestamptz, ip_address varchar(64) not null default '')`);
  });
  afterAll(async () => {
    await sql(`drop table if exists auth.audit_log_entries`);
  });

  it("reprise par le worker et « Réessayer » : compte conservé, journal Auth intact", async () => {
    const org = await createOrg("Suppression Gérant");
    const d = await createDriver(org);
    const r = await svc("svc_delete_driver_account", [d.userId]);
    expect(r).toMatchObject({ ok: true, code: "DELETED", keep_auth: false, auth_done: false });
    const id = r.deletion_id as string;
    // Échec de la suppression Auth (GoTrue indisponible), puis la personne accepte une invitation d'une autre centrale
    await svc("svc_account_deletion_progress", [id, true, false, "GoTrue indisponible"]);
    const other = await createOrg("Autre Centrale");
    await sql(`insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'admin', 'active')`, [other.id, d.userId]);
    const logId = randomUUID();
    await sql(`insert into auth.audit_log_entries (id, payload, created_at) values ($1, $2::json, now())`, [
      logId, JSON.stringify({ action: "login", actor_id: d.userId }),
    ]);

    await sql(`update private.account_deletions set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
    const [claimed] = await sql(`select keep_auth, auth_done_at from private.claim_account_deletions(100) where id = $1`, [id]);
    expect(claimed.keep_auth).toBe(true);
    expect(claimed.auth_done_at).not.toBeNull();
    // Compte rendu du worker (rien supprimé côté Auth : keep_auth) : terminé, journal Auth gardé
    const done = (await sql(`select private.complete_account_deletion($1, true, true, null) as r`, [id]))[0].r;
    expect(done).toMatchObject({ done: true, keep_auth: true });
    expect(await sql(`select id from auth.audit_log_entries where id = $1`, [logId])).toHaveLength(1);
  });

  it("« Réessayer » du super admin : compte devenu super admin conservé", async () => {
    const org = await createOrg("Suppression Super Admin");
    const d = await createDriver(org);
    const r = await svc("svc_delete_driver_account", [d.userId]);
    const id = r.deletion_id as string;
    await svc("svc_account_deletion_progress", [id, false, false, "GoTrue indisponible"]);
    await sql(`update public.users set is_super_admin = true where id = $1`, [d.userId]);
    const actor = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [actor]);
    expect(await svc("svc_account_deletion_retry", [id, actor])).toMatchObject({ ok: true, keep_auth: true, auth_done: true });
  });
});

