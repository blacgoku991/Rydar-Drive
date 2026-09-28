// Contre-audit « sql » (20260924005400) : plafond « nouveau chauffeur » d'une course sans prix, verrou de
// l'acceptation, relance par le suivi des vols, empreintes « phone » de l'ancienne normalisation, compte de connexion
// conservé, jetons et activation, sessions à la suspension d'une centrale, Super Admin donné à un compte existant.
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  as, CDG, CHAMPS_ELYSEES, createAuthUser, createDriver, createOrg, createRideAsOwner, expectPgError, insertRideBypass, north,
  pool, rideState, sql, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, any>;
type Q = <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => Promise<R[]>;

const MIN = 60_000;
const AIRPORT = "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France";
const PARIS = "12 Avenue des Champs-Élysées, 75008 Paris";

/** Comme `as`, avec des claims JWT complets (iat, amr). */
async function asClaims<T>(claims: Record<string, unknown>, fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", ...claims })]);
    await client.query("set local role authenticated");
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
const newUser = (label: string) => createAuthUser(`${label}-${randomUUID().slice(0, 8)}@test.dev`, `Personne ${label}`);
async function superAdmin() {
  const sa = await newUser("super");
  await sql("update public.users set is_super_admin = true where id = $1", [sa]);
  return sa;
}
async function centrale(name: string, settings: Record<string, unknown> = {}) {
  const org = await createOrg(name, { settings });
  await sql("update public.organizations set dispatch_model = 'centrale', platform_fee_fixed_cents = 500 where id = $1", [org.id]);
  return org;
}
async function membership(orgId: string, userId: string, status: "active" | "invited" | "disabled", role = "dispatcher") {
  await sql("insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, $3, $4)", [orgId, userId, role, status]);
}
const pendingOffer = async (rideId: string, d: { id: string }) =>
  (await rideState(rideId)).offers.find((o) => o.driver_id === d.id && o.status === "pending");

/** Numéro unique « 06XXXXXXXX » (les bannissements portent sur l'identité : jamais de valeur partagée entre tests). */
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
/** « 0633333333 » → « +33 (0)6 33 33 33 33 ». */
const withTrunk = (digits: string) => `+33 (0)${digits.slice(1, 2)} ${digits.slice(2).replace(/(\d{2})(?=\d)/g, "$1 ")}`;
/** Empreinte calculée avec l'ANCIENNE normalisation (avant 004600) : la forme stockée telle quelle. */
const legacyHash = (stored: string) => createHash("sha256").update(`rydar:phone:${stored}`).digest("hex");
const banScope = async (orgId: string, kind: string, value: string) =>
  (await sql("select private.identity_ban_scope($1, $2, $3) as s", [orgId, kind, value]))[0].s as string | null;
const fiche = async (id: string) =>
  (await sql("select status, banned_at, suspended_reason, application_status from public.drivers where id = $1", [id]))[0];

/** Fiche chauffeur avec un téléphone donné (unique par défaut) et son compte de connexion. */
async function driverWithPhone(org: Org, phone = uniquePhone(), opts: { status?: string } = {}) {
  const email = `contre-${randomUUID().slice(0, 8)}@test.dev`;
  const userId = await createAuthUser(email, "Chauffeur Contre");
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, status, presence)
     values ($1, $2, 'Karim', 'Contre', $3, $4, $5, 'offline') returning id`,
    [org.id, userId, phone, email, opts.status ?? "active"],
  );
  return { id: d.id as string, userId, phone };
}

/** Session Supabase Auth ouverte (session + refresh token). */
async function openSession(userId: string) {
  await sql("insert into auth.sessions (user_id) values ($1)", [userId]);
  await sql("insert into auth.refresh_tokens (token, user_id, revoked) values ($1, $2, false)", [`rt-${userId}-${Math.random()}`, userId]);
}
async function sessionCount(userId: string) {
  const [{ s }] = await sql("select count(*)::int as s from auth.sessions where user_id = $1", [userId]);
  const [{ t }] = await sql("select count(*)::int as t from auth.refresh_tokens where user_id = $1::text", [userId]);
  return s + t;
}

// -----------------------------------------------------------------------------
describe("Plafond « nouveau chauffeur » : course sans prix à l'acceptation (sql1#0)", () => {
  it("course sans prix : refusée à un chauffeur repassé « nouveau » (comme à l'envoi) ; hors course, aucun blocage", async () => {
    const org = await centrale("Contre prix absent", { new_driver_max_price_cents: 3000, settlement_methods: "{link,cash,transfer}" });
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 300) }); // confirmé (niveau par défaut)
    // Course API sans prix, proposée au chauffeur confirmé
    const [ride] = await as({ role: "service_role" }, (q) =>
      q(
        `insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name,
           customer_phone, vehicle_category, payment_method)
         values ($1, 'api', $2, $3, $4, 'Gare du Nord, 75010 Paris', 'Client API', '+33600000009', 'business', 'cash') returning id`,
        [org.id, PARIS, CHAMPS_ELYSEES[0], CHAMPS_ELYSEES[1]],
      ));
    const offer = await pendingOffer(ride.id, d);
    expect(offer).toBeTruthy();

    // Repassé « nouveau » par la centrale après l'envoi de l'offre
    await sql("update public.drivers set trust_level = 'new' where id = $1", [d.id]);
    expect(await rpc(d.userId, "accept_ride_offer", [offer!.id])).toMatchObject({ ok: false, code: "DRIVER_BLOCKED", reason: "new_driver" });
    expect((await rideState(ride.id)).ride.driver_id).toBeNull();

    // Même règle que l'envoi des offres ; hors course (accueil, Commissions) : pas de blocage « nouveau chauffeur »
    const [b] = await sql(
      `select private.centrale_blocker($1, 'new', null, true, null, 3000) as offre,
              private.driver_blocker($1, null, true) as course_sans_prix,
              private.driver_blocker($1, 2000, true) as course_sous_plafond,
              private.driver_blocker($1, 5000, true) as course_au_dessus,
              private.driver_blocker($1, null) as hors_course`,
      [d.id],
    );
    expect(b).toEqual({ offre: "new_driver", course_sans_prix: "new_driver", course_sous_plafond: null, course_au_dessus: "new_driver", hors_course: null });
    expect((await rpc(d.userId, "driver_home")).settlement).toMatchObject({ blocked: null });
  });
});

// -----------------------------------------------------------------------------
describe("accept_ride_offer : verrou du chauffeur sans interblocage avec le dispatch (sql1#1)", () => {
  it("acceptation en cours : une offre du dispatch au même chauffeur s'insère sans attendre ; deux acceptations restent sérialisées", async () => {
    const org = await createOrg("Contre verrou");
    const d = await createDriver(org, { firstName: "Verrou", at: north(CHAMPS_ELYSEES, 300) });
    const x = await createRideAsOwner(org);
    const ox = await pendingOffer(x.id, d);
    expect(ox).toBeTruthy();
    const y = await createRideAsOwner(org); // chauffeur déjà sollicité : pas d'offre
    const z = await createRideAsOwner(org);
    const [oy] = await sql(
      `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, distance_m, expires_at)
       values ($1, $2, $3, 'pending', 'geo', 1, 300, now() + interval '60 seconds') returning id`,
      [org.id, y.id, d.id],
    );

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const c3 = await pool.connect();
    const begin = async (c: pg.PoolClient) => {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: d.userId, role: "authenticated" })]);
      await c.query("set local role authenticated");
    };
    try {
      await begin(c1);
      const r1 = (await c1.query("select public.accept_ride_offer($1) as r", [ox!.id])).rows[0].r;
      expect(r1.code).toBe("ACCEPTED");

      // Pendant l'acceptation (non validée) : le dispatch_tick insère une offre pour ce chauffeur (clé étrangère →
      // FOR KEY SHARE sur sa ligne). Avec FOR UPDATE, elle attendait l'acceptation (interblocage possible).
      await c3.query("begin");
      await c3.query("set local lock_timeout = '1500ms'");
      const inserted = await c3.query(
        `insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, expires_at)
         values ($1, $2, $3, 'pending', 'fleet', 0, now() + interval '60 seconds') returning id`,
        [org.id, z.id, d.id],
      );
      expect(inserted.rows).toHaveLength(1);
      await c3.query("rollback");

      // Seconde acceptation du même chauffeur : attend la première (ligne du chauffeur), puis DRIVER_BUSY
      await begin(c2);
      const pid = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const p2 = c2.query("select public.accept_ride_offer($1) as r", [oy.id]);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [a] = await sql("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        waiting = a?.wait_event_type === "Lock";
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      await c1.query("commit");
      const r2 = (await p2).rows[0].r;
      await c2.query("commit");
      expect(r2).toMatchObject({ ok: false, code: "DRIVER_BUSY" });
    } finally {
      for (const c of [c1, c2, c3]) {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    }
    const rides = await sql("select id, driver_id from public.rides where id = any($1)", [[x.id, y.id]]);
    expect(rides.find((r) => r.id === x.id)?.driver_id).toBe(d.id);
    expect(rides.find((r) => r.id === y.id)?.driver_id).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe("Suivi des vols : relance d'une course sans chauffeur, mêmes règles que « Relancer » (sql1#3)", () => {
  const apply = async (rideId: string, f: { status: string; scheduled: Date; estimated: Date }) =>
    (await sql("select private.apply_flight_status($1, $2, $3, $4, null, null, null, 'test', null) as r", [
      rideId, f.status, f.scheduled, f.estimated,
    ]))[0].r as Row;
  const minuteFromNow = (ms: number) => new Date(Math.ceil((Date.now() + ms) / MIN) * MIN);
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

  it("frais plateforme en retard : la course NO_DRIVER_FOUND suit le vol mais n'est pas reproposée à la flotte", async () => {
    const org = await centrale("Contre vol bloqué", { settlement_methods: "{link,cash,transfer}" });
    const sa = await superAdmin();
    const d = await createDriver(org, { presence: "offline" });
    const ride = await insertRideBypass(org, {
      status: "NO_DRIVER_FOUND", type: "instant", dispatch_mode: "geo", pickup_at: new Date(Date.now() - 10 * MIN), no_driver_at: new Date(),
      pickup_address: AIRPORT, pickup_lat: CDG[0], pickup_lng: CDG[1], flight_number: "AF 1234",
    });
    // Frais échus depuis longtemps + « bloquer après 1 jour »
    await insertRideBypass(org, { completed_at: new Date(Date.now() - 75 * 86_400_000) });
    const [terms] = await as({ role: "service_role" }, (q) => q("select public.svc_platform_terms($1, $2, 'monthly', 5, 1) as r", [org.id, sa]));
    expect(terms.r.code).toBe("SAVED");
    expect(await rpc(org.ownerId, "redispatch_ride", [ride])).toMatchObject({ ok: false, code: "PLATFORM_FEES_OVERDUE" });

    const S = new Date(Date.now() + 120 * MIN);
    const res = await apply(ride, { status: "scheduled", scheduled: S, estimated: S });
    expect(res).toMatchObject({ ok: true, code: "UPDATED", pickup_changed: true, requalified: null });
    const state = await rideState(ride);
    expect(state.ride).toMatchObject({ status: "NO_DRIVER_FOUND", type: "instant", driver_id: null });
    expect(new Date(state.ride.pickup_at).getTime()).toBeGreaterThan(Date.now() + 100 * MIN); // l'heure suit le vol
    expect(state.offers.filter((o) => o.driver_id === d.id)).toEqual([]);
    const ev = state.events.find((e) => e.type === "dispatch.relaunch_blocked");
    expect(ev).toMatchObject({ level: "warning", data: { code: "PLATFORM_FEES_OVERDUE" } });
    expect(ev!.message).toContain("course non relancée — frais plateforme en retard");
  });

  it("quota mensuel atteint : planifiée NO_DRIVER_FOUND (recherche GPS) repoussée par un retard, pas relancée ; quota relevé : relancée", async () => {
    const org = await createOrg("Contre vol quota");
    const [{ at }] = await sql("select date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' - interval '2 days' as at");
    const T0 = minuteFromNow(50 * MIN);
    const ride = await insertRideBypass(org, {
      status: "NO_DRIVER_FOUND", type: "scheduled", dispatch_mode: "geo", created_at: at, pickup_at: T0, no_driver_at: new Date(),
      pickup_address: AIRPORT, pickup_lat: CDG[0], pickup_lng: CDG[1], dropoff_address: PARIS, flight_number: "AF 7777",
    });
    await createRideAsOwner(org);
    await createRideAsOwner(org);
    await sql(`update public.organizations set limits_override = '{"max_rides_per_month": 2}' where id = $1`, [org.id]);

    const S = plus(T0, -15 * MIN);
    const res = await apply(ride, { status: "delayed", scheduled: S, estimated: plus(S, 180 * MIN) });
    expect(res).toMatchObject({ pickup_changed: true, requalified: null });
    let state = await rideState(ride);
    expect(state.ride).toMatchObject({ status: "NO_DRIVER_FOUND", dispatch_mode: "geo" });
    const ev = state.events.find((e) => e.type === "dispatch.relaunch_blocked");
    expect(ev).toMatchObject({ data: { code: "PLAN_LIMIT_RIDES" } });
    expect(ev!.message).toContain("limite mensuelle de courses atteinte");

    // Quota relevé : le retard suivant la reproposé à toute la flotte (comportement de 004500)
    await sql(`update public.organizations set limits_override = '{"max_rides_per_month": 10}' where id = $1`, [org.id]);
    expect(await apply(ride, { status: "delayed", scheduled: S, estimated: plus(S, 240 * MIN) })).toMatchObject({ requalified: "fleet" });
    state = await rideState(ride);
    expect(state.ride.dispatch_mode).toBe("fleet");
    expect(["SEARCHING_DRIVER", "OFFERED"]).toContain(state.ride.status);
  });
});

// -----------------------------------------------------------------------------
describe("Téléphone : bannissement à l'empreinte de l'ancienne normalisation (sql2#0)", () => {
  it("banni puis supprimé avec un numéro « +330… » : toute écriture du numéro reste refusée ; fiche déjà enregistrée signalée", async () => {
    const org = await createOrg("Contre ban ancien");
    const elsewhere = await createOrg("Contre ban ancien ailleurs");
    const sa = await superAdmin();
    const digits = uniquePhone();
    const legacyForm = `+330${digits.slice(1)}`; // écriture stockée par l'ancien normalizePhone pour « +33 (0)6… »
    const canonical = `+33${digits.slice(1)}`;
    const shared = await driverWithPhone(org, digits); // même numéro, déjà enregistré dans la centrale
    const outside = await driverWithPhone(elsewhere, digits);
    const b = await driverWithPhone(org, legacyForm);
    expect((await rpc(org.ownerId, "ban_driver", [b.id, "Fraude avérée", "fraud", false, false])).code).toBe("BANNED");

    // Bannissement d'avant 004600 (empreinte de « +330… » tel quel), puis compte supprimé : numéro effacé, empreinte
    // impossible à recalculer
    await sql("update public.banned_identities set value_hash = $2 where driver_id = $1 and kind = 'phone'", [b.id, legacyHash(legacyForm)]);
    expect((await sql("select private.delete_driver_account($1, 'admin', $2) as r", [b.id, sa]))[0].r.code).toBe("DELETED");
    expect((await sql("select phone from public.drivers where id = $1", [b.id]))[0].phone).toBe("");

    for (const phone of [digits, canonical, legacyForm, withTrunk(digits), `+33 0${digits.slice(1)}`, `0033 ${digits.slice(1)}`, `33${digits.slice(1)}`]) {
      expect(await banScope(org.id, "phone", phone), phone).toBe("org");
    }
    expect(await banScope(org.id, "phone", uniquePhone())).toBeNull();
    expect(await banScope(elsewhere.id, "phone", digits)).toBeNull(); // bannissement de centrale

    // Réinscription refusée : création par la centrale, vérification du lien d'inscription
    expect((await expectPgError(driverWithPhone(org, canonical))).message).toMatch(/IDENTITY_BANNED/);
    expect(await svc("svc_identity_check", [org.id, withTrunk(digits), `retour-${randomUUID().slice(0, 6)}@test.dev`, null, null]))
      .toMatchObject({ banned: true });

    // Rattrapage : la fiche déjà enregistrée, qui ne tombe sur ce bannissement que par l'ancienne empreinte, est signalée
    expect((await sql("select private.flag_legacy_phone_ban_matches() as n"))[0].n).toBeGreaterThanOrEqual(1);
    expect(await fiche(shared.id)).toMatchObject({
      status: "suspended", banned_at: null, suspended_reason: "Téléphone déjà utilisé par un compte banni — vérification requise",
    });
    const [audit] = await sql("select metadata from public.audit_logs where action = 'driver.banned_identity' and entity_id = $1", [shared.id]);
    expect(audit.metadata).toMatchObject({ kind: "phone", scope: "org", legacy_hash: true, suspended: true });
    expect((await fiche(outside.id)).status).toBe("active");
    // Rejoué : plus rien à signaler pour elle
    await sql("select private.flag_legacy_phone_ban_matches()");
    expect(await sql("select id from public.audit_logs where action = 'driver.banned_identity' and entity_id = $1", [shared.id])).toHaveLength(1);
  });

  it("autres écritures anciennes : « 33612… » sans « + », « +44 (0)20… » écrit à l'identique", async () => {
    const org = await createOrg("Contre ban formes");
    const digits = uniquePhone();
    const intl = `+44 (0)20 ${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")} ${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
    for (const stored of [`33${digits.slice(1)}`, `+44${intl.replace(/[^0-9]/g, "").slice(2)}`]) {
      await sql(
        `insert into public.banned_identities (scope, organization_id, kind, value_hash, hint, reason)
         values ('org', $1, 'phone', $2, 'test', 'ancien bannissement')`,
        [org.id, legacyHash(stored)],
      );
    }
    expect(await banScope(org.id, "phone", digits)).toBe("org");
    expect(await banScope(org.id, "phone", `+33 ${digits.slice(1)}`)).toBe("org");
    expect(await banScope(org.id, "phone", intl)).toBe("org");
  });

  it("signalement antérieur (empreinte « +330… ») : fiche d'une autre centrale au même numéro proposée au super admin, non bannie sans confirmation", async () => {
    const orgA = await createOrg("Contre signalement A");
    const orgB = await createOrg("Contre signalement B");
    const sa = await superAdmin();
    const digits = uniquePhone();
    const legacyForm = `+330${digits.slice(1)}`;
    const reported = await driverWithPhone(orgA, legacyForm);
    const carrier = await driverWithPhone(orgB, digits);
    const ban = await rpc(orgA.ownerId, "ban_driver", [reported.id, "Fraude avérée", "fraud", true, false]);
    expect(ban.code).toBe("BANNED");
    await sql(
      `update public.fraud_reports set identities = (
         select jsonb_agg(case when e ->> 'kind' = 'phone' then e || jsonb_build_object('hash', $2::text) else e end)
         from jsonb_array_elements(identities) e) where id = $1`,
      [ban.report_id, legacyHash(legacyForm)],
    );

    const preview = await rpc(sa, "admin_fraud_report_matches", [ban.report_id]);
    expect(preview.matches.find((m: Row) => m.driver_id === carrier.id)).toMatchObject({ same_org: false, kinds: ["phone"] });
    const res = await svc("svc_platform_ban", [ban.report_id, sa, "Confirmé"]);
    expect(res).toMatchObject({ ok: true, code: "PLATFORM_BANNED", identities_skipped: 1, skipped_drivers: 1 });
    expect(await banScope(orgB.id, "phone", digits)).toBeNull();
    expect((await fiche(carrier.id)).status).toBe("active");
  });
});

// -----------------------------------------------------------------------------
describe("Compte de connexion : une invitation en attente ne le conserve pas (sql2#1, web_comptes#5)", () => {
  it("suppression du compte chauffeur : compte de connexion supprimé malgré l'invitation d'une autre centrale ; membre actif : conservé", async () => {
    const A = await createOrg("Contre suppr A");
    const T = await createOrg("Contre suppr tierce");
    const d = await driverWithPhone(A);
    await sql("update public.users set phone = $2 where id = $1", [d.userId, d.phone]);
    await membership(T.id, d.userId, "invited");
    const keeps = async (u: string) => (await sql("select private.keeps_login_account($1) as k", [u]))[0].k as boolean;
    expect(await keeps(d.userId)).toBe(false);

    const res = (await sql("select private.delete_driver_account($1, 'app') as r", [d.id]))[0].r;
    expect(res).toMatchObject({ ok: true, code: "DELETED", keep_auth: false, auth_done: false, user_id: d.userId });
    expect((await sql("select full_name, phone from public.users where id = $1", [d.userId]))[0]).toEqual({ full_name: null, phone: null });

    const m = await driverWithPhone(A);
    await membership(T.id, m.userId, "active");
    expect(await keeps(m.userId)).toBe(true);
  });

  it("bannissement plateforme : un fraudeur seulement invité par une centrale tierce est verrouillé (Auth)", async () => {
    const A = await createOrg("Contre ban invit A");
    const T = await createOrg("Contre ban invit tierce");
    const sa = await superAdmin();
    const f = await driverWithPhone(A);
    await membership(T.id, f.userId, "invited");
    const ban = await rpc(A.ownerId, "ban_driver", [f.id, "Fraude avérée", "fraud", true, false]);
    const res = await svc("svc_platform_ban", [ban.report_id, sa, "Confirmé"]);
    expect(res).toMatchObject({ ok: true, code: "PLATFORM_BANNED", user_ids: [f.userId], kept_user_ids: [] });
  });
});

// -----------------------------------------------------------------------------
describe("Jeton émis après l'activation (sql2#2, sql2#3, web_comptes#2)", () => {
  it("jeton de la même seconde que l'activation refusé ; bandeau des frais plateforme : même règle", async () => {
    const A = await centrale("Contre jeton seconde");
    const x = await newUser("seconde");
    await membership(A.id, x, "invited", "admin");
    const accepted = await asClaims({ sub: x, amr: [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) }] }, (q) =>
      q("select public.accept_member_invitations() as r"));
    expect(accepted[0].r).toMatchObject({ ok: true, code: "ACTIVATED" });
    // Activation à s + 0,9 s (fixée pour le test)
    const s = Math.floor(Date.now() / 1000) - 60;
    await sql("update public.organization_users set activated_at = to_timestamp($3::double precision + 0.9) where organization_id = $1 and user_id = $2", [
      A.id, x, s,
    ]);
    const probe = (iat: number) =>
      asClaims({ sub: x, iat }, async (q) => ({
        role: (await q("select private.has_org_role($1, array['owner','admin']::public.org_role[]) as ok", [A.id]))[0].ok,
        banner: (await q("select public.org_platform_status($1) as r", [A.id]))[0].r.enabled,
      }));
    expect(await probe(s - 600)).toEqual({ role: false, banner: false }); // jeton d'un tiers, bien avant
    expect(await probe(s)).toEqual({ role: false, banner: false }); // même seconde, 0,9 s AVANT l'activation
    expect(await probe(s + 1)).toEqual({ role: true, banner: true });
  });
});

// -----------------------------------------------------------------------------
describe("Suspension d'une centrale : sessions de ses seuls membres actifs sans autre accès (sql2#4)", () => {
  it("invité, ancien membre désactivé, chauffeur ou candidat d'une autre centrale : sessions conservées ; membre sans autre accès : fermées", async () => {
    const A = await createOrg("Contre sessions A");
    const C = await createOrg("Contre sessions C");
    const invited = await driverWithPhone(A);
    await membership(C.id, invited.userId, "invited");
    const disabled = await driverWithPhone(A);
    await membership(C.id, disabled.userId, "disabled");
    const driving = await driverWithPhone(A);
    await membership(C.id, driving.userId, "active");
    const applicant = await driverWithPhone(A, uniquePhone(), { status: "inactive" });
    await sql("update public.drivers set application_status = 'pending' where id = $1", [applicant.id]);
    await membership(C.id, applicant.userId, "active");
    const onlyC = await newUser("seulement-c");
    await membership(C.id, onlyC, "active");
    const users = [invited.userId, disabled.userId, driving.userId, applicant.userId, onlyC];
    for (const u of users) await openSession(u);

    await sql("update public.organizations set status = 'suspended' where id = $1", [C.id]);
    expect(await Promise.all(users.map(sessionCount))).toEqual([2, 2, 2, 2, 0]);
    for (const d of [invited, disabled, driving]) expect((await fiche(d.id)).status).toBe("active");
  });
});

// -----------------------------------------------------------------------------
describe("Super Admin donné à un compte existant : jeton antérieur sans les droits (web_comptes#1)", () => {
  it("users.super_admin_since : jeton émis avant la promotion → aucun droit ; jeton neuf → droits ; colonne non modifiable", async () => {
    await createOrg("Contre super admin");
    const u = await newUser("promu");
    // deploy/create-admin.sh : is_super_admin = true, super_admin_since = heure de la base
    await sql("update public.users set is_super_admin = true, super_admin_since = now() where id = $1", [u]);
    const now = Math.floor(Date.now() / 1000);
    const probe = (claims: Record<string, unknown>) =>
      asClaims({ sub: u, ...claims }, async (q) => ({
        db: (await q("select private.is_super_admin() as ok"))[0].ok,
        web: (await q("select public.session_is_super_admin() as ok"))[0].ok,
        orgs: Number((await q("select count(*) as n from public.organizations"))[0].n),
      }));
    expect(await probe({ iat: now - 600 })).toEqual({ db: false, web: false, orgs: 0 }); // jeton du tiers
    expect(await probe({})).toEqual({ db: false, web: false, orgs: 0 });
    const fresh = await probe({ iat: now + 2 });
    expect(fresh).toMatchObject({ db: true, web: true });
    expect(fresh.orgs).toBeGreaterThan(0);

    // Rôle donné sans date (avant cette migration, seed) : inchangé
    const legacy = await superAdmin();
    expect((await as({ sub: legacy }, (q) => q("select private.is_super_admin() as ok")))[0].ok).toBe(true);

    // Ni l'utilisateur ni un anonyme n'y touchent
    const err = await expectPgError(asClaims({ sub: u, iat: now + 2 }, (q) => q("update public.users set super_admin_since = null where id = $1", [u])));
    expect(err.code).toBe("42501");
    expect((await expectPgError(as({ role: "anon" }, (q) => q("select public.session_is_super_admin()")))).code).toBe("42501");
  });
});
