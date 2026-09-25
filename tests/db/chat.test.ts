import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createDriver, createOrg, expectPgError, north, pool, sql,
  type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

type SendArgs = {
  org?: string | null;
  channel: string;
  driver?: string | null;
  body?: string | null;
  report?: string | null;
  lat?: number | null;
  lng?: number | null;
};

/** Appelle send_chat_message en tant que `sub` (JWT authenticated). */
async function send(sub: string, a: SendArgs) {
  const [row] = await as({ sub }, (q) =>
    q("select public.send_chat_message($1, $2, $3, $4, $5, $6, $7) as m", [
      a.org ?? null, a.channel, a.driver ?? null, a.body ?? null, a.report ?? null, a.lat ?? null, a.lng ?? null,
    ]),
  );
  return row.m;
}

const markRead = async (sub: string, org: string | null, thread: string) =>
  (await as({ sub }, (q) => q("select public.mark_chat_read($1, $2) as r", [org, thread])))[0].r;
const overview = async (sub: string, org: string) =>
  (await as({ sub }, (q) => q("select public.chat_overview($1) as o", [org])))[0].o;
const driverOverview = async (sub: string) =>
  (await as({ sub }, (q) => q("select public.driver_chat_overview() as o")))[0].o;
const vote = async (sub: string, id: string, stillThere: boolean) =>
  (await as({ sub }, (q) => q("select public.vote_fleet_report($1, $2) as v", [id, stillThere])))[0].v;

const realtime = (topic: string, event: string, id?: string) =>
  sql(
    `select payload, event, topic from realtime.messages
     where topic = $1 and event = $2 and ($3::text is null or payload ->> 'id' = $3) order by id`,
    [topic, event, id ?? null],
  );

async function createMember(org: Org, role: "owner" | "admin" | "dispatcher", fullName: string) {
  const id = await createAuthUser(`${role}-${Math.random().toString(36).slice(2, 8)}@test.dev`, fullName);
  await sql(`insert into public.organization_users (organization_id, user_id, role) values ($1, $2, $3)`, [org.id, id, role]);
  return id;
}

async function createSuperAdmin() {
  const id = await createAuthUser(`root-${Math.random().toString(36).slice(2, 8)}@test.dev`, "Root");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}

async function setLocation(d: Driver, org: Org, at: [number, number], ageSeconds = 5) {
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
     values ($1, $2, $3, $4, now() - make_interval(secs => $5), now() - make_interval(secs => $5))
     on conflict (driver_id) do update set lat = excluded.lat, lng = excluded.lng,
       recorded_at = excluded.recorded_at, updated_at = excluded.updated_at`,
    [d.id, org.id, at[0], at[1], ageSeconds],
  );
}

describe("Messagerie : envoi", () => {
  let A: Org;
  let B: Org;
  let dA: Driver;
  let dA2: Driver;
  let dB: Driver;
  let suspended: Driver;

  beforeAll(async () => {
    A = await createOrg("Chat Envoi A");
    B = await createOrg("Chat Envoi B");
    dA = await createDriver(A, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 500) });
    dA2 = await createDriver(A, { firstName: "Sofiane", at: north(CHAMPS_ELYSEES, 900) });
    dB = await createDriver(B, { firstName: "Bruno", at: north(CHAMPS_ELYSEES, 300) });
    suspended = await createDriver(A, { firstName: "Suspendu", status: "suspended" });
  });

  it("la centrale écrit sur le fil flotte : message JSON, temps réel org + fleet, aucun push", async () => {
    const m = await send(A.ownerId, { org: A.id, channel: "fleet", body: "  Bonjour à tous  " });
    expect(m).toMatchObject({
      organization_id: A.id, channel: "fleet", driver_id: null, author_type: "user", author_user_id: A.ownerId,
      author_driver_id: null, author_name: "Owner Chat Envoi A", body: "Bonjour à tous", report_type: null,
      expires_at: null, confirmations: 0, dismissals: 0, thread: "fleet", active: false, notified: 0,
    });
    expect(await realtime(`org:${A.id}`, "chat.message", m.id)).toHaveLength(1);
    expect(await realtime(`fleet:${A.id}`, "chat.message", m.id)).toHaveLength(1);
    expect(await realtime(`driver:${dA.id}`, "chat.message", m.id)).toHaveLength(0);
    const notifs = await sql(`select * from public.notifications where data ->> 'message_id' = $1`, [m.id]);
    expect(notifs).toHaveLength(0);
  });

  it("la centrale écrit à un chauffeur : fil direct, temps réel org + driver, push « chat_message » prioritaire", async () => {
    const m = await send(A.ownerId, { org: A.id, channel: "driver", driver: dA.id, body: "Passe au bureau ce soir" });
    expect(m).toMatchObject({ channel: "driver", driver_id: dA.id, thread: `driver:${dA.id}`, notified: 1 });
    expect(await realtime(`org:${A.id}`, "chat.message", m.id)).toHaveLength(1);
    const [evt] = await realtime(`driver:${dA.id}`, "chat.message", m.id);
    expect(evt.payload.body).toBe("Passe au bureau ce soir");
    expect(await realtime(`fleet:${A.id}`, "chat.message", m.id)).toHaveLength(0);

    const notifs = await sql(`select * from public.notifications where data ->> 'message_id' = $1`, [m.id]);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      organization_id: A.id, driver_id: dA.id, ride_id: null, type: "chat_message", priority: "high",
      title: "Message de la centrale", body: "Passe au bureau ce soir", status: "queued",
    });
    expect(notifs[0].data).toMatchObject({ message_id: m.id, channel: "driver", thread: `driver:${dA.id}` });
  });

  it("pas de push vers un chauffeur non actif (message conservé)", async () => {
    const m = await send(A.ownerId, { org: A.id, channel: "driver", driver: suspended.id, body: "Rappelle-moi" });
    expect(m.notified).toBe(0);
    const notifs = await sql(`select 1 from public.notifications where data ->> 'message_id' = $1`, [m.id]);
    expect(notifs).toHaveLength(0);
  });

  it("un dispatcher peut écrire ; un membre d'une autre organisation non", async () => {
    const dispatcher = await createMember(A, "dispatcher", "Nadia Dispatch");
    const m = await send(dispatcher, { org: A.id, channel: "fleet", body: "Relève à 18 h" });
    expect(m.author_name).toBe("Nadia Dispatch");
    const err = await expectPgError(send(B.ownerId, { org: A.id, channel: "fleet", body: "intrus" }));
    expect(err.code).toBe("42501");
  });

  it("le chauffeur écrit à la centrale (p_org null) : son propre fil, sans push", async () => {
    const m = await send(dA.userId, { channel: "driver", body: "Je suis en retard de 5 min" });
    expect(m).toMatchObject({
      organization_id: A.id, channel: "driver", driver_id: dA.id, author_type: "driver", author_driver_id: dA.id,
      author_user_id: null, author_name: "Karim T.", notified: 0,
    });
    expect(await realtime(`org:${A.id}`, "chat.message", m.id)).toHaveLength(1);
    expect(await realtime(`driver:${dA.id}`, "chat.message", m.id)).toHaveLength(1);
    const notifs = await sql(`select 1 from public.notifications where data ->> 'message_id' = $1`, [m.id]);
    expect(notifs).toHaveLength(0);
    // p_org = sa propre organisation fonctionne aussi
    const m2 = await send(dA.userId, { org: A.id, channel: "driver", driver: dA.id, body: "Ok" });
    expect(m2.driver_id).toBe(dA.id);
  });

  it("le chauffeur écrit sur le fil flotte de son organisation", async () => {
    const m = await send(dA.userId, { channel: "fleet", body: "Bouchon porte Maillot" });
    expect(m).toMatchObject({ organization_id: A.id, channel: "fleet", driver_id: null, author_driver_id: dA.id });
    expect(await realtime(`fleet:${A.id}`, "chat.message", m.id)).toHaveLength(1);
    expect(await realtime(`fleet:${B.id}`, "chat.message", m.id)).toHaveLength(0);
  });

  it("isolation : autre tenant, fil d'un autre chauffeur, anonyme → 42501", async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => send(A.ownerId, { org: A.id, channel: "driver", driver: dB.id, body: "x" }),
      () => send(A.ownerId, { org: B.id, channel: "fleet", body: "x" }),
      () => send(dA.userId, { org: B.id, channel: "fleet", body: "x" }),
      () => send(dA.userId, { channel: "driver", driver: dA2.id, body: "x" }),
      () => send(dA.userId, { org: B.id, channel: "driver", driver: dB.id, body: "x" }),
      () => as({ role: "anon" }, (q) => q("select public.send_chat_message($1, 'fleet', null, 'x')", [A.id])),
    ];
    for (const run of cases) {
      const err = await expectPgError(run());
      expect(err.code).toBe("42501");
    }
    // Utilisateur authentifié sans organisation ni compte chauffeur
    const stranger = await createAuthUser(`stranger-${Date.now()}@test.dev`, "Inconnu");
    expect((await expectPgError(send(stranger, { channel: "fleet", body: "x" }))).code).toBe("42501");
    expect((await expectPgError(send(stranger, { org: A.id, channel: "fleet", body: "x" }))).code).toBe("42501");
    const leaked = await sql(`select 1 from public.chat_messages where body = 'x'`);
    expect(leaked).toHaveLength(0);
  });

  it("chauffeur suspendu : envoi refusé (42501)", async () => {
    const err = await expectPgError(send(suspended.userId, { channel: "fleet", body: "x" }));
    expect(err.code).toBe("42501");
  });

  it("validations → 22023 avec code métier", async () => {
    const cases: Array<[SendArgs, string]> = [
      [{ org: A.id, channel: "sms", body: "x" }, "INVALID_CHANNEL"],
      [{ org: A.id, channel: "fleet", body: "   " }, "EMPTY_MESSAGE"],
      [{ org: A.id, channel: "fleet", body: null }, "EMPTY_MESSAGE"],
      [{ org: A.id, channel: "fleet", body: "a".repeat(1001) }, "MESSAGE_TOO_LONG"],
      [{ org: A.id, channel: "fleet", driver: dA.id, body: "x" }, "INVALID_THREAD"],
      [{ org: A.id, channel: "driver", body: "x" }, "INVALID_THREAD"],
      [{ org: A.id, channel: "driver", driver: dA.id, body: "x", report: "police", lat: 48.8, lng: 2.3 }, "INVALID_REPORT"],
      [{ org: A.id, channel: "fleet", body: "x", report: "ufo", lat: 48.8, lng: 2.3 }, "INVALID_REPORT_TYPE"],
      [{ org: A.id, channel: "fleet", body: "x", lat: 48.8 }, "INVALID_COORDINATES"],
      [{ org: A.id, channel: "fleet", body: "x", lat: 95, lng: 2.3 }, "INVALID_COORDINATES"],
      [{ org: A.id, channel: "fleet", report: "police" }, "LOCATION_REQUIRED"],
    ];
    for (const [args, code] of cases) {
      const err = await expectPgError(send(A.ownerId, args));
      expect(err.code, code).toBe("22023");
      expect(err.message.startsWith(code), err.message).toBe(true);
    }
    // 1000 caractères : accepté
    const m = await send(dA2.userId, { channel: "fleet", body: "b".repeat(1000) });
    expect(m.body).toHaveLength(1000);
  });

  it("limite de débit : 20 messages / minute / auteur → RATE_LIMITED (PT429)", async () => {
    const C = await createOrg("Chat Debit");
    const bavard = await createDriver(C, { firstName: "Bavard", at: north(CHAMPS_ELYSEES, 100) });
    for (let i = 0; i < 20; i++) await send(bavard.userId, { channel: "fleet", body: `msg ${i}` });
    const err = await expectPgError(send(bavard.userId, { channel: "fleet", body: "un de trop" }));
    expect(err.code).toBe("PT429");
    expect(err.message).toMatch(/^RATE_LIMITED/);
    // Les autres auteurs ne sont pas affectés
    const ok = await send(C.ownerId, { org: C.id, channel: "fleet", body: "la centrale peut encore écrire" });
    expect(ok.id).toBeDefined();
    // Une minute plus tard, le chauffeur peut réécrire
    await sql(`update public.chat_messages set created_at = created_at - interval '61 seconds' where author_driver_id = $1`, [bavard.id]);
    const again = await send(bavard.userId, { channel: "fleet", body: "de retour" });
    expect(again.body).toBe("de retour");
  });

  it("limite de débit sous concurrence : 25 envois simultanés → exactement 20 acceptés", async () => {
    const C = await createOrg("Chat Rafale");
    const rafale = await createDriver(C, { firstName: "Rafale" });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => send(rafale.userId, { channel: "fleet", body: `rafale ${i}` })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(20);
    expect(ko).toHaveLength(5);
    expect(ko.every((r) => r.reason.code === "PT429")).toBe(true);
    const [count] = await sql(`select count(*)::int as n from public.chat_messages where author_driver_id = $1`, [rafale.id]);
    expect(count.n).toBe(20);
  });
});

describe("Messagerie : lecture (RLS)", () => {
  let A: Org;
  let B: Org;
  let dA: Driver;
  let dA2: Driver;
  let dB: Driver;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    A = await createOrg("Chat RLS A");
    B = await createOrg("Chat RLS B");
    dA = await createDriver(A, { firstName: "Mehdi" });
    dA2 = await createDriver(A, { firstName: "Yanis" });
    dB = await createDriver(B, { firstName: "Brice" });
    ids.fleetA = (await send(A.ownerId, { org: A.id, channel: "fleet", body: "flotte A" })).id;
    ids.directA = (await send(A.ownerId, { org: A.id, channel: "driver", driver: dA.id, body: "direct A" })).id;
    ids.directA2 = (await send(A.ownerId, { org: A.id, channel: "driver", driver: dA2.id, body: "direct A2" })).id;
    ids.fleetB = (await send(B.ownerId, { org: B.id, channel: "fleet", body: "flotte B" })).id;
    ids.directB = (await send(dB.userId, { channel: "driver", body: "direct B" })).id;
  });

  const visible = (sub: string) =>
    as({ sub }, (q) => q("select id from public.chat_messages")).then((rows) => rows.map((r) => r.id).sort());

  it("la centrale voit tous les messages de son organisation, jamais ceux d'une autre", async () => {
    expect(await visible(A.ownerId)).toEqual([ids.fleetA, ids.directA, ids.directA2].sort());
    expect(await visible(B.ownerId)).toEqual([ids.fleetB, ids.directB].sort());
  });

  it("un chauffeur voit la flotte de son org et son seul fil direct", async () => {
    expect(await visible(dA.userId)).toEqual([ids.fleetA, ids.directA].sort());
    expect(await visible(dA2.userId)).toEqual([ids.fleetA, ids.directA2].sort());
    expect(await visible(dB.userId)).toEqual([ids.fleetB, ids.directB].sort());
  });

  it("le super admin voit tout ; anon n'a aucun accès", async () => {
    const root = await createSuperAdmin();
    const all = await visible(root);
    for (const id of Object.values(ids)) expect(all).toContain(id);
    const err = await expectPgError(as({ role: "anon" }, (q) => q("select * from public.chat_messages")));
    expect(err.code).toBe("42501");
  });

  it("aucune écriture directe (insert / update / delete) → 42501", async () => {
    const attempts = [
      `insert into public.chat_messages (organization_id, channel, author_type, author_name, body) values ('${A.id}', 'fleet', 'user', 'x', 'x')`,
      `update public.chat_messages set body = 'hack' where id = '${ids.fleetA}'`,
      `delete from public.chat_messages where id = '${ids.fleetA}'`,
      `insert into public.chat_reads (organization_id, reader_key, thread_key) values ('${A.id}', 'user:${A.ownerId}', 'fleet')`,
      `insert into public.chat_report_votes (organization_id, message_id, voter_key, still_there) values ('${A.id}', '${ids.fleetA}', 'user:${A.ownerId}', true)`,
    ];
    for (const text of attempts) {
      const e1 = await expectPgError(as({ sub: A.ownerId }, (q) => q(text)));
      expect(e1.code, text).toBe("42501");
      const e2 = await expectPgError(as({ sub: dA.userId }, (q) => q(text)));
      expect(e2.code, text).toBe("42501");
    }
    const [row] = await sql(`select body from public.chat_messages where id = $1`, [ids.fleetA]);
    expect(row.body).toBe("flotte A");
  });

  it("organization_id d'un message est immuable (même en superutilisateur)", async () => {
    const err = await expectPgError(sql(`update public.chat_messages set organization_id = $1 where id = $2`, [B.id, ids.fleetA]));
    expect(err.code).toBe("42501");
  });

  it("chat_reads : chacun ne voit que ses propres accusés de lecture", async () => {
    await markRead(A.ownerId, A.id, "fleet");
    await markRead(dA.userId, null, "fleet");
    await markRead(dA.userId, null, `driver:${dA.id}`);
    await markRead(dA2.userId, null, "fleet");
    const own = await as({ sub: dA.userId }, (q) => q("select reader_key, thread_key from public.chat_reads order by thread_key"));
    expect(own).toEqual([
      { reader_key: `driver:${dA.id}`, thread_key: `driver:${dA.id}` },
      { reader_key: `driver:${dA.id}`, thread_key: "fleet" },
    ]);
    const owner = await as({ sub: A.ownerId }, (q) => q("select reader_key from public.chat_reads"));
    expect(owner.every((r) => r.reader_key === `user:${A.ownerId}`)).toBe(true);
    const other = await as({ sub: B.ownerId }, (q) => q("select * from public.chat_reads where organization_id = $1", [A.id]));
    expect(other).toHaveLength(0);
  });
});

describe("Signalements flotte", () => {
  let A: Org;
  let B: Org;
  let author: Driver;
  let near: Driver;
  let busy: Driver;
  let offline: Driver;
  let far: Driver;
  let otherOrg: Driver;
  let noGps: Driver;
  let staleGps: Driver;

  beforeAll(async () => {
    A = await createOrg("Signalements A");
    B = await createOrg("Signalements B");
    author = await createDriver(A, { firstName: "Karim", at: CHAMPS_ELYSEES });
    near = await createDriver(A, { firstName: "Near", at: north(CHAMPS_ELYSEES, 2000) });
    busy = await createDriver(A, { firstName: "Busy", at: north(CHAMPS_ELYSEES, 10_000), presence: "on_trip" });
    offline = await createDriver(A, { firstName: "Offline", at: north(CHAMPS_ELYSEES, 1000), presence: "offline" });
    far = await createDriver(A, { firstName: "Far", at: north(CHAMPS_ELYSEES, 30_000) });
    otherOrg = await createDriver(B, { firstName: "Voisin", at: north(CHAMPS_ELYSEES, 500) });
    noGps = await createDriver(A, { firstName: "SansGps" });
    staleGps = await createDriver(A, { firstName: "Perime", at: north(CHAMPS_ELYSEES, 200), locationAgeSeconds: 20 * 60 });
  });

  it("chauffeur : position par défaut = sa dernière position, corps par défaut, expiration 45 min", async () => {
    const before = Date.now();
    const m = await send(author.userId, { channel: "fleet", report: "police" });
    expect(m).toMatchObject({
      channel: "fleet", report_type: "police", body: "Contrôle de police signalé", author_driver_id: author.id,
      lat: CHAMPS_ELYSEES[0], lng: CHAMPS_ELYSEES[1], active: true, thread: "fleet",
    });
    const ttl = new Date(m.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(44 * 60_000);
    expect(ttl).toBeLessThan(46 * 60_000);

    // Push : chauffeurs de l'org en ligne à ≤ 25 km, hors auteur / hors ligne / trop loin / autre org
    const notifs = await sql(`select * from public.notifications where data ->> 'message_id' = $1 order by driver_id`, [m.id]);
    expect(notifs.map((n) => n.driver_id).sort()).toEqual([near.id, busy.id].sort());
    expect(m.notified).toBe(2);
    const toNear = notifs.find((n) => n.driver_id === near.id)!;
    expect(toNear).toMatchObject({ type: "fleet_report", priority: "normal", title: "Police signalée", organization_id: A.id });
    expect(toNear.body).toMatch(/^Contrôle de police signalé — à [\d,]+ km de vous \(Karim T\.\)$/);
    expect(toNear.data).toMatchObject({ message_id: m.id, report_type: "police", thread: "fleet" });
    expect(toNear.data.distance_m).toBeGreaterThan(1900);
    expect(toNear.data.distance_m).toBeLessThan(2100);

    // Journal + temps réel
    const [evt] = await sql(`select * from public.ride_events where type = 'fleet.report' and data ->> 'message_id' = $1`, [m.id]);
    expect(evt).toMatchObject({ organization_id: A.id, ride_id: null, category: "system", level: "warning", actor_type: "driver", actor_id: author.id });
    expect(evt.data.notified).toBe(2);
    expect(await realtime(`fleet:${A.id}`, "chat.message", m.id)).toHaveLength(1);
    expect(await realtime(`org:${A.id}`, "chat.message", m.id)).toHaveLength(1);
  });

  it("accident / danger : 60 min, commentaire conservé, position explicite acceptée", async () => {
    const at = north(CHAMPS_ELYSEES, 3000);
    const before = Date.now();
    const m = await send(near.userId, { channel: "fleet", report: "accident", body: "Carambolage A1 sortie 3", lat: at[0], lng: at[1] });
    expect(m).toMatchObject({ report_type: "accident", body: "Carambolage A1 sortie 3", lat: at[0], lng: at[1] });
    const ttl = new Date(m.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(59 * 60_000);
    expect(ttl).toBeLessThan(61 * 60_000);
    const notifs = await sql(`select driver_id, title, body from public.notifications where data ->> 'message_id' = $1`, [m.id]);
    expect(notifs.map((n) => n.driver_id).sort()).toEqual([author.id, busy.id].sort());
    expect(notifs[0].title).toBe("Accident signalé");
    expect(notifs[0].body).toMatch(/^Carambolage A1 sortie 3 — à /);
  });

  it("sans position GPS récente → LOCATION_REQUIRED", async () => {
    for (const d of [noGps, staleGps]) {
      const err = await expectPgError(send(d.userId, { channel: "fleet", report: "control" }));
      expect(err.code).toBe("22023");
      expect(err.message).toMatch(/^LOCATION_REQUIRED/);
    }
  });

  it("la centrale peut signaler avec une position explicite (tous les chauffeurs proches notifiés)", async () => {
    const err = await expectPgError(send(A.ownerId, { org: A.id, channel: "fleet", report: "traffic" }));
    expect(err.message).toMatch(/^LOCATION_REQUIRED/);
    const m = await send(A.ownerId, { org: A.id, channel: "fleet", report: "traffic", lat: CHAMPS_ELYSEES[0], lng: CHAMPS_ELYSEES[1] });
    expect(m).toMatchObject({ author_type: "user", body: "Bouchon signalé", report_type: "traffic" });
    const notifs = await sql(`select driver_id from public.notifications where data ->> 'message_id' = $1`, [m.id]);
    // staleGps : position de plus de 15 min → pas de push
    expect(notifs.map((n) => n.driver_id).sort()).toEqual([author.id, near.id, busy.id].sort());
    expect(notifs.find((n) => n.driver_id === otherOrg.id)).toBeUndefined();
  });

  it("anti-spam : 5 signalements max par auteur sur 10 minutes", async () => {
    const C = await createOrg("Signalements Spam");
    const spammer = await createDriver(C, { firstName: "Spam", at: CHAMPS_ELYSEES });
    for (let i = 0; i < 5; i++) await send(spammer.userId, { channel: "fleet", report: "danger" });
    const err = await expectPgError(send(spammer.userId, { channel: "fleet", report: "danger" }));
    expect(err.code).toBe("PT429");
    // Un message texte reste possible
    const m = await send(spammer.userId, { channel: "fleet", body: "désolé" });
    expect(m.report_type).toBeNull();
  });
});

describe("Votes sur les signalements", () => {
  let A: Org;
  let B: Org;
  let author: Driver;
  let v1: Driver;
  let v2: Driver;
  let dB: Driver;

  beforeAll(async () => {
    A = await createOrg("Votes A");
    B = await createOrg("Votes B");
    author = await createDriver(A, { firstName: "Auteur", at: CHAMPS_ELYSEES });
    v1 = await createDriver(A, { firstName: "Votant", at: north(CHAMPS_ELYSEES, 1500) });
    v2 = await createDriver(A, { firstName: "Second", at: north(CHAMPS_ELYSEES, 4000) });
    dB = await createDriver(B, { firstName: "Etranger", at: north(CHAMPS_ELYSEES, 100) });
  });

  const report = async (type = "police", by: Driver = author) => send(by.userId, { channel: "fleet", report: type });
  const row = async (id: string) => (await sql(`select * from public.chat_messages where id = $1`, [id]))[0];

  it("« toujours là » : confirmation, expiration repoussée à ≥ 30 min, diffusion chat.report", async () => {
    const m = await report();
    await sql(`update public.chat_messages set expires_at = now() + interval '5 minutes' where id = $1`, [m.id]);
    const res = await vote(v1.userId, m.id, true);
    expect(res).toMatchObject({ ok: true, code: "VOTED", my_vote: true, expired: false });
    expect(res.report.confirmations).toBe(1);
    const r = await row(m.id);
    expect(new Date(r.expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    const events = await realtime(`fleet:${A.id}`, "chat.report", m.id);
    expect(events.at(-1)?.payload).toMatchObject({ id: m.id, confirmations: 1, dismissals: 0, active: true });
    expect(await realtime(`org:${A.id}`, "chat.report", m.id)).not.toHaveLength(0);

    // Même vote rejoué : aucun effet
    const again = await vote(v1.userId, m.id, true);
    expect(again).toMatchObject({ ok: true, code: "ALREADY_VOTED" });
    expect((await row(m.id)).confirmations).toBe(1);

    // Le vote est visible par son auteur (et lui seul)
    const mine = await as({ sub: v1.userId }, (q) => q("select still_there from public.chat_report_votes where message_id = $1", [m.id]));
    expect(mine).toEqual([{ still_there: true }]);
    const others = await as({ sub: v2.userId }, (q) => q("select * from public.chat_report_votes where message_id = $1", [m.id]));
    expect(others).toHaveLength(0);
  });

  it("« plus là » : 1 vote → toujours actif ; 2 votes distincts → expiré", async () => {
    const m = await report("control");
    const first = await vote(v1.userId, m.id, false);
    expect(first).toMatchObject({ ok: true, expired: false });
    expect(first.report.dismissals).toBe(1);
    // Rejouer le même vote ne compte pas deux fois
    expect((await vote(v1.userId, m.id, false)).code).toBe("ALREADY_VOTED");
    expect((await row(m.id)).dismissals).toBe(1);
    const second = await vote(v2.userId, m.id, false);
    expect(second).toMatchObject({ ok: true, expired: true });
    expect(second.report).toMatchObject({ dismissals: 2, active: false });
    const [evt] = await sql(`select * from public.ride_events where type = 'fleet.report_cleared' and data ->> 'message_id' = $1`, [m.id]);
    expect(evt).toBeDefined();
    // Plus de vote possible une fois expiré
    const late = await vote(author.userId, m.id, true);
    expect(late).toMatchObject({ ok: false, code: "REPORT_EXPIRED" });
  });

  it("votes simultanés « plus là » de deux chauffeurs : sérialisés, jamais perdus", async () => {
    const m = await report("traffic", v2);
    const [r1, r2] = await Promise.all([vote(v1.userId, m.id, false), vote(author.userId, m.id, true)]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    const r = await row(m.id);
    expect(r.dismissals).toBe(1);
    expect(r.confirmations).toBe(1);
    const votes = await sql(`select voter_key, still_there from public.chat_report_votes where message_id = $1 order by voter_key`, [m.id]);
    expect(votes).toHaveLength(2);
  });

  it("changer d'avis : la confirmation est retirée au profit du « plus là »", async () => {
    const m = await report("traffic");
    const aged = () => sql(`update public.chat_report_votes set updated_at = now() - interval '2 minutes' where message_id = $1`, [m.id]);
    await vote(v1.userId, m.id, true);
    await aged(); // une minute minimum entre deux avis
    const res = await vote(v1.userId, m.id, false);
    expect(res.report).toMatchObject({ confirmations: 0, dismissals: 1, active: true });
    await aged();
    const back = await vote(v1.userId, m.id, true);
    expect(back.report).toMatchObject({ confirmations: 1, dismissals: 0, active: true });
  });

  it("anti-abus : pas d'auto-confirmation, changer d'avis ne prolonge pas, 1 min entre deux avis, 3 h max", async () => {
    const m = await report("police", v1);
    expect(await vote(v1.userId, m.id, true)).toMatchObject({ ok: false, code: "OWN_REPORT" });

    await sql(`update public.chat_messages set expires_at = now() + interval '2 minutes' where id = $1`, [m.id]);
    await vote(v2.userId, m.id, true); // premier « toujours là » : +30 min
    expect(new Date((await row(m.id)).expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    // Changer d'avis aussitôt : refusé (chaque vote est diffusé à toute l'organisation)
    expect((await expectPgError(vote(v2.userId, m.id, false))).code).toBe("PT429");

    // Alterner « plus là » / « toujours là » ne relance plus l'expiration
    const aged = () => sql(`update public.chat_report_votes set updated_at = now() - interval '2 minutes' where message_id = $1`, [m.id]);
    await aged();
    await vote(v2.userId, m.id, false);
    await sql(`update public.chat_messages set expires_at = now() + interval '2 minutes' where id = $1`, [m.id]);
    await aged();
    const back = await vote(v2.userId, m.id, true);
    expect(back.report.confirmations).toBe(1);
    expect(new Date((await row(m.id)).expires_at).getTime() - Date.now()).toBeLessThan(3 * 60_000);

    // Plafond : 3 h après la publication, quels que soient les votes
    const m2 = await report("control", v1);
    await sql(
      `update public.chat_messages set created_at = now() - interval '2 hours 50 minutes', expires_at = now() + interval '1 minute' where id = $1`,
      [m2.id],
    );
    await vote(v2.userId, m2.id, true);
    const left = new Date((await row(m2.id)).expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThan(11 * 60_000);
  });

  it("l'auteur ou la centrale retire le signalement immédiatement", async () => {
    const m1 = await report("danger");
    expect(await vote(author.userId, m1.id, false)).toMatchObject({ ok: true, expired: true });
    const m2 = await report("accident", v2);
    expect(await vote(A.ownerId, m2.id, false)).toMatchObject({ ok: true, expired: true });
    expect(new Date((await row(m2.id)).expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("erreurs : message ordinaire (22023), inconnu (P0002), autre tenant (42501), vote incomplet (22023)", async () => {
    const text = await send(author.userId, { channel: "fleet", body: "simple message" });
    expect((await expectPgError(vote(v1.userId, text.id, true))).code).toBe("22023");
    expect((await expectPgError(vote(v1.userId, "00000000-0000-4000-8000-000000000000", true))).code).toBe("P0002");
    const m = await report("other", v2);
    expect((await expectPgError(vote(dB.userId, m.id, false))).code).toBe("42501");
    expect((await expectPgError(vote(B.ownerId, m.id, false))).code).toBe("42501");
    const nullVote = await expectPgError(as({ sub: v1.userId }, (q) => q("select public.vote_fleet_report($1, null)", [m.id])));
    expect(nullVote.code).toBe("22023");
    expect((await row(m.id)).dismissals).toBe(0);
  });
});

describe("Non-lus et vues d'ensemble", () => {
  let A: Org;
  let B: Org;
  let karim: Driver;
  let sofiane: Driver;
  let inactive: Driver;
  let inactiveWithMessages: Driver;
  let dB: Driver;

  beforeAll(async () => {
    A = await createOrg("Overview A");
    B = await createOrg("Overview B");
    karim = await createDriver(A, { firstName: "Karim", at: CHAMPS_ELYSEES });
    sofiane = await createDriver(A, { firstName: "Sofiane", at: north(CHAMPS_ELYSEES, 5000), presence: "offline" });
    inactive = await createDriver(A, { firstName: "Ancien", status: "inactive" });
    inactiveWithMessages = await createDriver(A, { firstName: "Parti", status: "inactive" });
    dB = await createDriver(B, { firstName: "Bob" });
    await send(A.ownerId, { org: A.id, channel: "driver", driver: inactiveWithMessages.id, body: "Rends le badge" });
  });

  it("centrale : non-lus par fil, tri par dernier message, fils des chauffeurs actifs (+ inactifs avec historique)", async () => {
    await send(karim.userId, { channel: "driver", body: "Bonjour centrale" });
    await send(karim.userId, { channel: "driver", body: "Vous êtes là ?" });
    await send(sofiane.userId, { channel: "fleet", body: "Salut la flotte" });
    await send(A.ownerId, { org: A.id, channel: "fleet", body: "Message de la centrale (le mien)" });

    const o = await overview(A.ownerId, A.id);
    expect(o.organization_id).toBe(A.id);
    expect(o.fleet).toMatchObject({ thread: "fleet", active_reports: 0 });
    // Mon propre message n'est pas « non lu » ; écrire sur la flotte l'a marquée lue
    expect(o.fleet.unread).toBe(0);
    expect(o.fleet.last_message.body).toBe("Message de la centrale (le mien)");

    const threads = o.drivers.map((t: any) => t.thread);
    expect(threads[0]).toBe(`driver:${karim.id}`);
    expect(threads).toContain(`driver:${sofiane.id}`);
    expect(threads).toContain(`driver:${inactiveWithMessages.id}`);
    expect(threads).not.toContain(`driver:${inactive.id}`);
    expect(threads).not.toContain(`driver:${dB.id}`);
    const k = o.drivers[0];
    expect(k).toMatchObject({ unread: 2, last_read_at: null, driver_last_read_at: expect.any(String) });
    expect(k.driver).toMatchObject({ id: karim.id, first_name: "Karim", presence: "available", status: "active" });
    expect(k.last_message.body).toBe("Vous êtes là ?");
    const s = o.drivers.find((t: any) => t.thread === `driver:${sofiane.id}`);
    expect(s).toMatchObject({ unread: 0, last_message: null });
    expect(o.unread_total).toBe(2);

    // Un autre dispatcher n'a encore rien lu : la flotte est non lue pour lui
    const other = await createMember(A, "dispatcher", "Autre Dispatch");
    const o2 = await overview(other, A.id);
    expect(o2.fleet.unread).toBe(2);
    expect(o2.unread_total).toBe(2 + 2 + 1);

    // Lecture du fil de Karim → 0 non-lu, accusé temps réel vers Karim et l'org
    const r = await markRead(A.ownerId, A.id, `driver:${karim.id}`);
    expect(r).toMatchObject({ ok: true, thread: `driver:${karim.id}` });
    const after = await overview(A.ownerId, A.id);
    expect(after.drivers.find((t: any) => t.thread === `driver:${karim.id}`).unread).toBe(0);
    expect(after.unread_total).toBe(0);
    const receipts = await realtime(`driver:${karim.id}`, "chat.read");
    expect(receipts.at(-1)?.payload).toMatchObject({ thread: `driver:${karim.id}`, reader_type: "user", reader_key: `user:${A.ownerId}` });
    expect((await realtime(`org:${A.id}`, "chat.read")).length).toBeGreaterThan(0);

    // Nouveau message de Karim → à nouveau 1 non-lu
    await send(karim.userId, { channel: "driver", body: "Merci" });
    const again = await overview(A.ownerId, A.id);
    expect(again.drivers.find((t: any) => t.thread === `driver:${karim.id}`).unread).toBe(1);
  });

  it("message validé APRÈS une lecture du fil (transaction plus longue) : reste compté non lu", async () => {
    const other = await createMember(A, "dispatcher", "Dispatch Rapide");
    const slow = await pool.connect();
    try {
      await slow.query("begin");
      await slow.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A.ownerId, role: "authenticated" })]);
      await slow.query("set local role authenticated");
      await slow.query("select public.send_chat_message($1, 'fleet', null, 'MESSAGE LENT', null, null, null)", [A.id]);
      // Pendant ce temps : un autre message est validé, puis Karim lit le fil flotte
      await send(other, { org: A.id, channel: "fleet", body: "message rapide" });
      await markRead(karim.userId, null, "fleet");
      expect((await driverOverview(karim.userId)).fleet.unread).toBe(0);
      await slow.query("commit");
    } finally {
      slow.release();
    }
    const o = await driverOverview(karim.userId);
    expect(o.fleet.unread).toBe(1);
    expect(o.fleet.last_message.body).toBe("MESSAGE LENT");
  });

  it("répondre dans un fil vaut lecture de ce fil", async () => {
    await send(sofiane.userId, { channel: "driver", body: "Question planning" });
    let o = await overview(A.ownerId, A.id);
    expect(o.drivers.find((t: any) => t.thread === `driver:${sofiane.id}`).unread).toBe(1);
    await send(A.ownerId, { org: A.id, channel: "driver", driver: sofiane.id, body: "Réponse" });
    o = await overview(A.ownerId, A.id);
    expect(o.drivers.find((t: any) => t.thread === `driver:${sofiane.id}`).unread).toBe(0);
  });

  it("chauffeur : non-lus centrale / flotte, derniers messages, vu par la centrale, signalements actifs", async () => {
    const C = await createOrg("Overview Chauffeur");
    const me = await createDriver(C, { firstName: "Moi", at: CHAMPS_ELYSEES });
    const mate = await createDriver(C, { firstName: "Collegue", at: north(CHAMPS_ELYSEES, 3000) });

    let o = await driverOverview(me.userId);
    expect(o).toMatchObject({ driver_id: me.id, organization_id: C.id, unread_total: 0, reports: [] });
    expect(o.dispatch).toMatchObject({ thread: `driver:${me.id}`, unread: 0, last_message: null, messages: [], seen_by_dispatch_at: null });
    expect(o.fleet).toMatchObject({ thread: "fleet", unread: 0, last_message: null, messages: [] });

    await send(C.ownerId, { org: C.id, channel: "driver", driver: me.id, body: "Premier" });
    await send(C.ownerId, { org: C.id, channel: "driver", driver: me.id, body: "Second" });
    await send(C.ownerId, { org: C.id, channel: "driver", driver: mate.id, body: "Pas pour moi" });
    await send(mate.userId, { channel: "fleet", body: "Hello" });
    const rep = await send(mate.userId, { channel: "fleet", report: "police" });
    await send(me.userId, { channel: "fleet", body: "Mon message flotte" });

    o = await driverOverview(me.userId);
    expect(o.dispatch.unread).toBe(2);
    expect(o.dispatch.messages.map((m: any) => m.body)).toEqual(["Premier", "Second"]);
    expect(o.dispatch.last_message.body).toBe("Second");
    // Mon propre message flotte a marqué le fil comme lu
    expect(o.fleet.unread).toBe(0);
    expect(o.fleet.messages.map((m: any) => m.body)).toEqual(["Hello", "Contrôle de police signalé", "Mon message flotte"]);
    expect(o.unread_total).toBe(2);
    expect(o.reports).toHaveLength(1);
    expect(o.reports[0]).toMatchObject({ id: rep.id, report_type: "police", my_vote: null, active: true });
    expect(o.reports[0].distance_m).toBeGreaterThan(2900);
    expect(o.reports[0].distance_m).toBeLessThan(3100);

    await vote(me.userId, rep.id, true);
    await markRead(me.userId, null, `driver:${me.id}`);
    await markRead(C.ownerId, C.id, `driver:${me.id}`);
    o = await driverOverview(me.userId);
    expect(o.dispatch.unread).toBe(0);
    expect(o.dispatch.seen_by_dispatch_at).not.toBeNull();
    expect(o.reports[0].my_vote).toBe(true);
    // Accusé de lecture du chauffeur visible côté centrale
    const receipts = await realtime(`org:${C.id}`, "chat.read");
    expect(receipts.some((e) => e.payload.reader_key === `driver:${me.id}`)).toBe(true);
    const ov = await overview(C.ownerId, C.id);
    expect(ov.drivers.find((t: any) => t.thread === `driver:${me.id}`).driver_last_read_at).not.toBeNull();
    expect(ov.fleet.active_reports).toBe(1);
  });

  it("mark_chat_read : validations et isolation", async () => {
    expect((await expectPgError(markRead(A.ownerId, A.id, "general"))).code).toBe("22023");
    expect((await expectPgError(markRead(A.ownerId, A.id, "driver:pas-un-uuid"))).code).toBe("22023");
    expect((await expectPgError(markRead(karim.userId, null, `driver:${sofiane.id}`))).code).toBe("42501");
    expect((await expectPgError(markRead(A.ownerId, A.id, `driver:${dB.id}`))).code).toBe("42501");
    expect((await expectPgError(markRead(A.ownerId, B.id, "fleet"))).code).toBe("42501");
    expect((await expectPgError(markRead(karim.userId, B.id, "fleet"))).code).toBe("42501");
    const err = await expectPgError(as({ role: "anon" }, (q) => q("select public.mark_chat_read($1, 'fleet')", [A.id])));
    expect(err.code).toBe("42501");
    // Marquer deux fois : idempotent (last_read_at ne recule jamais)
    const r1 = await markRead(karim.userId, null, "fleet");
    const r2 = await markRead(karim.userId, null, "fleet");
    expect(new Date(r2.last_read_at).getTime()).toBeGreaterThanOrEqual(new Date(r1.last_read_at).getTime());
  });

  it("vues d'ensemble : isolation par rôle et par tenant", async () => {
    expect((await expectPgError(overview(B.ownerId, A.id))).code).toBe("42501");
    expect((await expectPgError(overview(karim.userId, A.id))).code).toBe("42501");
    expect((await expectPgError(driverOverview(A.ownerId))).code).toBe("42501");
    const err = await expectPgError(as({ role: "anon" }, (q) => q("select public.chat_overview($1)", [A.id])));
    expect(err.code).toBe("42501");
    // Le super admin peut consulter (lecture seule)
    const root = await createSuperAdmin();
    const o = await overview(root, A.id);
    expect(o.drivers.length).toBeGreaterThan(0);
    // Le fil de l'org B ne fuit pas dans la vue du chauffeur A
    const ko = await driverOverview(karim.userId);
    expect(ko.organization_id).toBe(A.id);
    expect(ko.fleet.messages.every((m: any) => m.organization_id === A.id)).toBe(true);
  });
});

describe("Temps réel : topic fleet:<org>", () => {
  it("lisible par la centrale et les chauffeurs de l'org, pas par les autres ; org:/driver: inchangés", async () => {
    const A = await createOrg("Topic A");
    const B = await createOrg("Topic B");
    const dA = await createDriver(A, { firstName: "Alpha" });
    const dB = await createDriver(B, { firstName: "Beta" });
    await send(A.ownerId, { org: A.id, channel: "fleet", body: "diffusion" });
    await send(A.ownerId, { org: A.id, channel: "driver", driver: dA.id, body: "perso" });

    const count = async (sub: string, topic: string) =>
      (await as({ sub }, (q) => q("select count(*)::int as n from realtime.messages"), { topic }))[0].n as number;

    expect(await count(A.ownerId, `fleet:${A.id}`)).toBeGreaterThan(0);
    expect(await count(dA.userId, `fleet:${A.id}`)).toBeGreaterThan(0);
    expect(await count(dB.userId, `fleet:${A.id}`)).toBe(0);
    expect(await count(B.ownerId, `fleet:${A.id}`)).toBe(0);
    const root = await createSuperAdmin();
    expect(await count(root, `fleet:${A.id}`)).toBeGreaterThan(0);
    // Conditions existantes conservées
    expect(await count(A.ownerId, `org:${A.id}`)).toBeGreaterThan(0);
    expect(await count(B.ownerId, `org:${A.id}`)).toBe(0);
    expect(await count(dA.userId, `driver:${dA.id}`)).toBeGreaterThan(0);
    expect(await count(dB.userId, `driver:${dA.id}`)).toBe(0);
    expect(await count(dA.userId, `org:${A.id}`)).toBe(0);
  });
});

describe("Cycle de vie", () => {
  it("ménage : purge des messages de plus de 180 jours", async () => {
    const A = await createOrg("Menage Chat");
    const old = await send(A.ownerId, { org: A.id, channel: "fleet", body: "très ancien" });
    const recent = await send(A.ownerId, { org: A.id, channel: "fleet", body: "récent" });
    await sql(`update public.chat_messages set created_at = now() - interval '181 days' where id = $1`, [old.id]);
    const [res] = await sql(`select private.housekeeping() as r`);
    expect(res.r.chat_purged).toBeGreaterThanOrEqual(1);
    const left = await sql(`select id from public.chat_messages where id = any($1::uuid[])`, [[old.id, recent.id]]);
    expect(left.map((r) => r.id)).toEqual([recent.id]);
    // Réservé au worker (service_role)
    const err = await expectPgError(as({ sub: A.ownerId }, (q) => q("select private.housekeeping()")));
    expect(err.code).toBe("42501");
  });

  it("suppression d'un chauffeur : son fil direct disparaît, ses messages flotte restent (auteur anonymisé)", async () => {
    const A = await createOrg("Suppression Chat");
    const d = await createDriver(A, { firstName: "Depart", at: CHAMPS_ELYSEES });
    const direct = await send(d.userId, { channel: "driver", body: "au revoir" });
    const fleet = await send(d.userId, { channel: "fleet", body: "bonne route à tous" });
    const rep = await send(d.userId, { channel: "fleet", report: "police" });
    await sql(`delete from public.drivers where id = $1`, [d.id]);
    expect(await sql(`select 1 from public.chat_messages where id = $1`, [direct.id])).toHaveLength(0);
    const rows = await sql(`select id, author_driver_id, author_name from public.chat_messages where id = any($1::uuid[]) order by created_at`, [[fleet.id, rep.id]]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.author_driver_id === null && r.author_name === "Depart T.")).toBe(true);
  });

  it("fonctions internes non exécutables par les clients", async () => {
    const A = await createOrg("Interne Chat");
    for (const text of [
      "select private.chat_caller($1, true)",
      "select private.chat_message_json(m) from public.chat_messages m where m.organization_id = $1",
    ]) {
      const err = await expectPgError(as({ sub: A.ownerId }, (q) => q(text, [A.id])));
      expect(err.code, text).toBe("42501");
    }
  });
});
