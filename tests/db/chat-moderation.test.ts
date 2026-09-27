import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createDriver, createMember, createOrg, expectPgError, north, pool, sql,
  type Driver, type Org,
} from "./helpers";

// Modération du fil « Chauffeurs » (20260924004100) : signaler, masquer un auteur, retrait et classement
// par la centrale. Style et fixtures : tests/db/chat.test.ts.

afterAll(async () => {
  await pool.end();
});

type SendArgs = { org?: string | null; channel: string; driver?: string | null; body?: string | null; report?: string | null };

async function send(sub: string, a: SendArgs) {
  const [row] = await as({ sub }, (q) =>
    q("select public.send_chat_message($1, $2, $3, $4, $5) as m", [a.org ?? null, a.channel, a.driver ?? null, a.body ?? null, a.report ?? null]),
  );
  return row.m;
}

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args)))[0].r;
};
const report = (sub: string, id: string, reason: string | null = null) => rpc(sub, "report_chat_message", [id, reason]);
const block = (sub: string, driverId: string) => rpc(sub, "block_chat_author", [driverId]);
const unblock = (sub: string, driverId: string) => rpc(sub, "unblock_chat_author", [driverId]);
const remove = (sub: string, id: string) => rpc(sub, "remove_chat_message", [id]);
const dismiss = (sub: string, reportId: string) => rpc(sub, "dismiss_chat_report", [reportId]);
const queue = (sub: string, org: string) => rpc(sub, "chat_moderation_queue", [org]);
const overview = (sub: string, org: string) => rpc(sub, "chat_overview", [org]);
const driverOverview = (sub: string) => rpc(sub, "driver_chat_overview");
const vote = (sub: string, id: string, stillThere: boolean) => rpc(sub, "vote_fleet_report", [id, stillThere]);

const moderationEvents = (org: string, messageId: string) =>
  sql(
    `select payload from realtime.messages where topic = $1 and event = 'chat.moderation' and payload ->> 'message_id' = $2 order by id`,
    [`org:${org}`, messageId],
  );

const fleetIds = (o: { fleet: { messages: { id: string }[] } }) => o.fleet.messages.map((m) => m.id);

async function setLocation(d: Pick<Driver, "id">, org: Org, at: [number, number]) {
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (driver_id) do update set lat = excluded.lat, lng = excluded.lng, recorded_at = now(), updated_at = now()`,
    [d.id, org.id, at[0], at[1]],
  );
}

/** Fiche chauffeur liée à un compte existant (gérant d'une petite centrale qui conduit aussi). */
async function driverFor(org: Org, userId: string, firstName: string): Promise<{ id: string }> {
  const [row] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence)
     values ($1, $2, $3, 'Test', '+33600000000', 'active', 'available') returning id`,
    [org.id, userId, firstName],
  );
  return { id: row.id };
}

/** accept_legal_documents appelée par l'utilisateur connecté (application : sans centrale, source « app »). */
const acceptTerms = async (sub: string, documents: string[], version: string) =>
  (await as({ sub }, (q) => q("select public.accept_legal_documents($1::text[], $2::text, null, 'app') as r", [documents, version])))[0].r;

/**
 * Transaction concurrente qui supprime un message sans valider (comme la suppression du compte de son auteur),
 * pendant que `call` s'exécute : `call` attend le verrou de la ligne, puis la suppression est validée.
 */
async function deletedMeanwhile<T>(messageId: string, fnName: string, call: () => Promise<T>): Promise<T> {
  const deleting = await pool.connect();
  try {
    await deleting.query("begin");
    await deleting.query("delete from public.chat_messages where id = $1", [messageId]);
    const pending = call();
    pending.catch(() => undefined);
    // L'appel concurrent attend le verrou de la ligne supprimée
    for (let i = 0; i < 100; i++) {
      const [w] = (
        await pool.query(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like $1`,
          [`%${fnName}%`],
        )
      ).rows;
      if (w.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await deleting.query("commit");
    return await pending;
  } catch (error) {
    await deleting.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    deleting.release();
  }
}

describe("Modération : signaler un message", () => {
  let A: Org;
  let B: Org;
  let karim: Driver;
  let sofiane: Driver;
  let nadia: Driver;
  let bruno: Driver;
  let dispatcher: string;

  beforeAll(async () => {
    A = await createOrg("Modération Signalement A");
    B = await createOrg("Modération Signalement B");
    karim = await createDriver(A, { firstName: "Karim" });
    sofiane = await createDriver(A, { firstName: "Sofiane" });
    nadia = await createDriver(A, { firstName: "Nadia" });
    bruno = await createDriver(B, { firstName: "Bruno" });
    dispatcher = await createMember(A, "dispatcher", "Lina Dispatch");
  });

  it("un chauffeur signale le message d'un autre : signalement ouvert, centrale prévenue (identifiants seulement)", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Message insultant" });
    const res = await report(karim.userId, m.id, "  Propos   insultants  ");
    expect(res).toMatchObject({ ok: true, code: "REPORTED", message_id: m.id, status: "open" });

    const [row] = await sql(`select * from public.chat_message_reports where id = $1`, [res.report_id]);
    expect(row).toMatchObject({
      organization_id: A.id, message_id: m.id, reporter_type: "driver", reporter_driver_id: karim.id, reporter_user_id: null,
      reason: "Propos insultants", status: "open", resolved_at: null,
    });

    const events = await moderationEvents(A.id, m.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ action: "reported", organization_id: A.id, message_id: m.id, report_id: res.report_id });
    // Rien n'est diffusé aux chauffeurs
    const fleet = await sql(`select 1 from realtime.messages where topic = $1 and event = 'chat.moderation'`, [`fleet:${A.id}`]);
    expect(fleet).toHaveLength(0);
  });

  it("le message signalé disparaît du fil de celui qui l'a signalé (et de ses non-lus), pas de celui des autres", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Spam" });
    const before = await driverOverview(karim.userId);
    expect(fleetIds(before)).toContain(m.id);
    await report(karim.userId, m.id);

    const after = await driverOverview(karim.userId);
    expect(fleetIds(after)).not.toContain(m.id);
    expect(after.fleet.last_message?.id).not.toBe(m.id);
    expect(after.fleet.unread).toBe(before.fleet.unread - 1);
    expect(fleetIds(await driverOverview(nadia.userId))).toContain(m.id);
  });

  it("deuxième signalement du même message par le même chauffeur : réponse idempotente", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Encore" });
    const first = await report(karim.userId, m.id, "spam");
    const second = await report(karim.userId, m.id, "autre motif");
    expect(second).toMatchObject({ ok: true, code: "ALREADY_REPORTED", report_id: first.report_id, status: "open" });
    const rows = await sql(`select reason from public.chat_message_reports where message_id = $1`, [m.id]);
    expect(rows).toEqual([{ reason: "spam" }]);
  });

  it("refus : son propre message, message système, fil direct, motif trop long, message retiré", async () => {
    const own = await send(karim.userId, { channel: "fleet", body: "Le mien" });
    expect((await expectPgError(report(karim.userId, own.id))).message).toMatch(/^OWN_MESSAGE/);

    const [system] = await sql(
      `insert into public.chat_messages (organization_id, channel, author_type, author_name, body)
       values ($1, 'fleet', 'system', 'Rydar Drive', 'Bienvenue') returning id`,
      [A.id],
    );
    expect((await expectPgError(report(karim.userId, system.id))).message).toMatch(/^NOT_REPORTABLE/);

    const direct = await send(A.ownerId, { org: A.id, channel: "driver", driver: karim.id, body: "Passe au bureau" });
    expect((await expectPgError(report(karim.userId, direct.id))).message).toMatch(/^NOT_REPORTABLE/);

    const m = await send(sofiane.userId, { channel: "fleet", body: "Motif" });
    const long = await expectPgError(report(karim.userId, m.id, "x".repeat(201)));
    expect(long.message).toMatch(/^REASON_TOO_LONG/);
    expect(long.code).toBe("22023");

    await remove(dispatcher, m.id);
    const gone = await expectPgError(report(nadia.userId, m.id));
    expect(gone.message).toMatch(/^MESSAGE_NOT_FOUND/);
    expect(gone.code).toBe("P0002");
  });

  it("autre centrale : ni son chauffeur, ni son membre, ni le super admin ne peuvent signaler", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Interne" });
    expect((await expectPgError(report(bruno.userId, m.id))).code).toBe("42501");
    expect((await expectPgError(report(B.ownerId, m.id))).code).toBe("42501");
    const root = await createAuthUser(`root-${Math.random().toString(36).slice(2, 8)}@test.dev`, "Root");
    await sql(`update public.users set is_super_admin = true where id = $1`, [root]);
    expect((await expectPgError(report(root, m.id))).code).toBe("42501");
    const anon = await expectPgError(as({ role: "anon" }, (q) => q("select public.report_chat_message($1, null)", [m.id])));
    expect(anon.code).toBe("42501");
  });

  it("un membre de la centrale peut signaler (pour décision d'un responsable)", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "À vérifier" });
    const res = await report(dispatcher, m.id, "À vérifier par le gérant");
    expect(res.code).toBe("REPORTED");
    const [row] = await sql(`select reporter_type, reporter_user_id, reporter_driver_id from public.chat_message_reports where id = $1`, [res.report_id]);
    expect(row).toEqual({ reporter_type: "user", reporter_user_id: dispatcher, reporter_driver_id: null });
  });

  it("limite anti-abus : 10 signalements par tranche de 10 minutes", async () => {
    const spammer = await createDriver(A, { firstName: "Rapide" });
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await send(A.ownerId, { org: A.id, channel: "fleet", body: `Annonce ${i}` })).id);
    for (let i = 0; i < 10; i++) expect((await report(spammer.userId, ids[i]!)).code).toBe("REPORTED");
    const err = await expectPgError(report(spammer.userId, ids[10]!));
    expect(err.code).toBe("PT429");
    expect(err.message).toMatch(/^RATE_LIMITED/);
  });

  it("RLS : la centrale lit les signalements, l'auteur du signalement les siens, personne d'autre", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Lecture RLS" });
    const res = await report(karim.userId, m.id);
    const read = (sub: string) => as({ sub }, (q) => q(`select id from public.chat_message_reports where id = $1`, [res.report_id]));
    expect(await read(karim.userId)).toHaveLength(1);
    expect(await read(A.ownerId)).toHaveLength(1);
    expect(await read(dispatcher)).toHaveLength(1);
    expect(await read(sofiane.userId)).toHaveLength(0);
    expect(await read(nadia.userId)).toHaveLength(0);
    expect(await read(B.ownerId)).toHaveLength(0);
    // Écriture directe interdite
    const write = await expectPgError(
      as({ sub: karim.userId }, (q) => q(`update public.chat_message_reports set status = 'dismissed' where id = $1`, [res.report_id])),
    );
    expect(write.code).toBe("42501");
  });
});

describe("Modération : gérant d'une petite centrale qui conduit aussi (membre ET chauffeur)", () => {
  let C: Org;
  let owner: { id: string };
  let sofiane: Driver;

  beforeAll(async () => {
    C = await createOrg("Modération Gérant chauffeur");
    owner = await driverFor(C, C.ownerId, "Gérant");
    sofiane = await createDriver(C, { firstName: "Sofiane" });
  });

  it("il signale EN CHAUFFEUR : signalement à son nom de chauffeur, message retiré de son fil", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Message du collègue" });
    expect(fleetIds(await driverOverview(C.ownerId))).toContain(m.id);

    const res = await report(C.ownerId, m.id, "Hors sujet");
    expect(res).toMatchObject({ ok: true, code: "REPORTED", message_id: m.id });
    const [row] = await sql(`select reporter_type, reporter_driver_id, reporter_user_id from public.chat_message_reports where id = $1`, [
      res.report_id,
    ]);
    expect(row).toEqual({ reporter_type: "driver", reporter_driver_id: owner.id, reporter_user_id: null });
    // Plus dans son fil, à la relecture comme à la réouverture de l'application
    const after = await driverOverview(C.ownerId);
    expect(fleetIds(after)).not.toContain(m.id);
    expect(after.fleet.last_message?.id).not.toBe(m.id);
    expect(await report(C.ownerId, m.id)).toMatchObject({ code: "ALREADY_REPORTED", report_id: res.report_id });
    // La centrale le voit dans sa file, au nom du chauffeur
    const q = await queue(C.ownerId, C.id);
    expect(q.items.find((i: { message: { id: string } }) => i.message.id === m.id)?.reports.map((r: { reporter_type: string }) => r.reporter_type)).toEqual([
      "driver",
    ]);
  });

  it("aucun de ses messages n'est signalable : ni écrit dans l'application (chauffeur), ni depuis le tableau de bord (membre)", async () => {
    const fromApp = await send(C.ownerId, { channel: "fleet", body: "Écrit dans l'application" });
    expect(fromApp).toMatchObject({ author_type: "driver", author_driver_id: owner.id });
    const fromDashboard = await send(C.ownerId, { org: C.id, channel: "fleet", body: "Écrit depuis le tableau de bord" });
    expect(fromDashboard).toMatchObject({ author_type: "user", author_user_id: C.ownerId });
    for (const own of [fromApp, fromDashboard]) {
      const err = await expectPgError(report(C.ownerId, own.id));
      expect(err.message).toMatch(/^OWN_MESSAGE/);
      expect(err.code).toBe("22023");
    }
    expect(await sql(`select 1 from public.chat_message_reports where message_id = any($1::uuid[])`, [[fromApp.id, fromDashboard.id]])).toHaveLength(0);
  });

  it("il vote EN CHAUFFEUR : vote affiché dans son fil, un « Plus là » ne retire pas seul le signalement", async () => {
    await setLocation(sofiane, C, north(CHAMPS_ELYSEES, 800));
    await setLocation(owner, C, north(CHAMPS_ELYSEES, 400));
    const incident = await send(sofiane.userId, { channel: "fleet", report: "police" });

    const res = await vote(C.ownerId, incident.id, false);
    expect(res).toMatchObject({ ok: true, code: "VOTED", my_vote: false, expired: false });
    const votes = await sql(`select voter_key from public.chat_report_votes where message_id = $1`, [incident.id]);
    expect(votes).toEqual([{ voter_key: `driver:${owner.id}` }]);
    const mine = (await driverOverview(C.ownerId)).reports.find((r: { id: string }) => r.id === incident.id);
    expect(mine).toMatchObject({ my_vote: false, dismissals: 1 });
  });
});

describe("Règles du fil : version des CGU acceptée (driver_chat_overview.rules_version)", () => {
  it("null tant que les CGU ne sont pas acceptées ; ensuite la version la plus récente, par compte", async () => {
    const C = await createOrg("Modération Règles du fil");
    const karim = await createDriver(C, { firstName: "Karim" });
    const nadia = await createDriver(C, { firstName: "Nadia" });
    expect((await driverOverview(karim.userId)).rules_version).toBeNull();

    // La politique de confidentialité seule ne vaut pas acceptation des règles du fil
    await acceptTerms(karim.userId, ["privacy"], "2026-09-27");
    expect((await driverOverview(karim.userId)).rules_version).toBeNull();

    // Application : sans centrale, source « app »
    expect(await acceptTerms(karim.userId, ["cgu"], "2026-06-01")).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect((await driverOverview(karim.userId)).rules_version).toBe("2026-06-01");
    const rows = await sql(`select organization_id, source from public.legal_acceptances where user_id = $1 and document = 'cgu'`, [karim.userId]);
    expect(rows).toEqual([{ organization_id: null, source: "app" }]);

    // Plusieurs versions : la plus récente, même acceptée avant une plus ancienne (deux versions de l'application)
    // (versions passées : accept_legal_documents refuse une date future, 20260924004300)
    await acceptTerms(karim.userId, ["cgu"], "2026-09-27");
    await acceptTerms(karim.userId, ["cgu"], "2026-07-01");
    expect((await driverOverview(karim.userId)).rules_version).toBe("2026-09-27");

    // Inscription par lien : acceptation enregistrée au nom de la centrale (service role, lib/join.ts)
    expect((await driverOverview(nadia.userId)).rules_version).toBeNull();
    await sql(
      `insert into public.legal_acceptances (user_id, organization_id, document, version, source) values ($1, $2, 'cgu', '2026-09-27', 'join')`,
      [nadia.userId, C.id],
    );
    expect((await driverOverview(nadia.userId)).rules_version).toBe("2026-09-27");
    expect((await driverOverview(karim.userId)).rules_version).toBe("2026-09-27");
  });
});

describe("Modération : masquer un chauffeur", () => {
  let A: Org;
  let B: Org;
  let karim: Driver;
  let sofiane: Driver;
  let nadia: Driver;
  let bruno: Driver;

  beforeAll(async () => {
    A = await createOrg("Modération Masquage A");
    B = await createOrg("Modération Masquage B");
    karim = await createDriver(A, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 400) });
    sofiane = await createDriver(A, { firstName: "Sofiane", at: north(CHAMPS_ELYSEES, 800) });
    nadia = await createDriver(A, { firstName: "Nadia", at: north(CHAMPS_ELYSEES, 1200) });
    bruno = await createDriver(B, { firstName: "Bruno" });
  });

  it("masquer puis réafficher : messages et signalements de l'auteur exclus pour celui qui masque seulement", async () => {
    const msg = await send(sofiane.userId, { channel: "fleet", body: "Bonjour la flotte" });
    const center = await send(A.ownerId, { org: A.id, channel: "fleet", body: "Annonce de la centrale" });
    await setLocation(sofiane, A, north(CHAMPS_ELYSEES, 800));
    const incident = await send(sofiane.userId, { channel: "fleet", report: "police" });

    const res = await block(karim.userId, sofiane.id);
    expect(res).toEqual({ ok: true, code: "BLOCKED", driver_id: sofiane.id, name: "Sofiane T." });
    expect((await block(karim.userId, sofiane.id)).code).toBe("ALREADY_BLOCKED");

    const o = await driverOverview(karim.userId);
    expect(fleetIds(o)).not.toContain(msg.id);
    expect(fleetIds(o)).not.toContain(incident.id);
    expect(fleetIds(o)).toContain(center.id);
    expect(o.reports.map((r: { id: string }) => r.id)).not.toContain(incident.id);
    expect(o.fleet.unread).toBe(1);
    expect(o.blocked).toEqual([{ driver_id: sofiane.id, name: "Sofiane T.", blocked_at: expect.any(String) }]);

    // Les autres chauffeurs voient tout
    const other = await driverOverview(nadia.userId);
    expect(fleetIds(other)).toEqual(expect.arrayContaining([msg.id, incident.id, center.id]));
    expect(other.blocked).toEqual([]);

    expect((await unblock(karim.userId, sofiane.id)).code).toBe("UNBLOCKED");
    expect((await unblock(karim.userId, sofiane.id)).code).toBe("NOT_BLOCKED");
    const back = await driverOverview(karim.userId);
    expect(fleetIds(back)).toEqual(expect.arrayContaining([msg.id, incident.id]));
    expect(back.blocked).toEqual([]);
  });

  it("pas d'alerte « signalement » pour un chauffeur qui a masqué l'auteur", async () => {
    await block(nadia.userId, sofiane.id);
    await setLocation(sofiane, A, north(CHAMPS_ELYSEES, 800));
    await setLocation(karim, A, north(CHAMPS_ELYSEES, 400));
    await setLocation(nadia, A, north(CHAMPS_ELYSEES, 1200));
    const incident = await send(sofiane.userId, { channel: "fleet", report: "accident" });
    const recipients = await sql(
      `select driver_id from public.notifications where type = 'fleet_report' and data ->> 'message_id' = $1`,
      [incident.id],
    );
    const ids = recipients.map((r) => r.driver_id);
    expect(ids).toContain(karim.id);
    expect(ids).not.toContain(nadia.id);
    await unblock(nadia.userId, sofiane.id);
  });

  it("refus : soi-même, chauffeur d'une autre centrale, membre de la centrale (pas un chauffeur)", async () => {
    expect((await expectPgError(block(karim.userId, karim.id))).message).toMatch(/^CANNOT_BLOCK_SELF/);
    expect((await expectPgError(block(karim.userId, bruno.id))).code).toBe("42501");
    expect((await expectPgError(block(A.ownerId, sofiane.id))).code).toBe("42501");
    expect((await expectPgError(unblock(A.ownerId, sofiane.id))).code).toBe("42501");
  });

  it("RLS : seul celui qui masque voit son masquage (ni l'auteur masqué, ni la centrale)", async () => {
    await block(karim.userId, nadia.id);
    const read = (sub: string) => as({ sub }, (q) => q(`select blocked_driver_id from public.chat_blocks where driver_id = $1`, [karim.id]));
    expect(await read(karim.userId)).toEqual([{ blocked_driver_id: nadia.id }]);
    expect(await read(nadia.userId)).toHaveLength(0);
    expect(await read(A.ownerId)).toHaveLength(0);
    const write = await expectPgError(
      as({ sub: karim.userId }, (q) =>
        q(`insert into public.chat_blocks (organization_id, driver_id, blocked_driver_id) values ($1, $2, $3)`, [A.id, karim.id, sofiane.id]),
      ),
    );
    expect(write.code).toBe("42501");
  });

  it("fiche supprimée (deleted_at) : ses masquages disparaissent dans les deux sens, ses signalements aussi", async () => {
    const leaving = await createDriver(A, { firstName: "Partant" });
    await block(leaving.userId, sofiane.id);
    await block(karim.userId, leaving.id);
    const m = await send(sofiane.userId, { channel: "fleet", body: "Signalé par un partant" });
    await report(leaving.userId, m.id, "Motif rédigé par le partant");
    await sql(`update public.drivers set deleted_at = now() where id = $1`, [leaving.id]);
    const rows = await sql(`select 1 from public.chat_blocks where driver_id = $1 or blocked_driver_id = $1`, [leaving.id]);
    expect(rows).toHaveLength(0);
    expect(await sql(`select 1 from public.chat_message_reports where reporter_driver_id = $1`, [leaving.id])).toHaveLength(0);
  });
});

describe("Modération : suppression du compte chauffeur (svc_delete_driver_account)", () => {
  let A: Org;
  let karim: Driver;
  let sofiane: Driver;
  let dispatcher: string;

  beforeAll(async () => {
    A = await createOrg("Modération Suppression A");
    karim = await createDriver(A, { firstName: "Karim" });
    sofiane = await createDriver(A, { firstName: "Sofiane" });
    dispatcher = await createMember(A, "dispatcher", "Lina Dispatch");
  });

  const deleteAccount = async (userId: string) =>
    (await as({ role: "service_role" }, (q) => q(`select public.svc_delete_driver_account($1) as r`, [userId])))[0].r;

  it("ses signalements rédigés (ouverts ou traités) et ses masquages sont supprimés ; ceux des autres restent", async () => {
    const leaving = await createDriver(A, { firstName: "Partant" });
    // Signalements rédigés par le chauffeur qui part : un ouvert, un classé par la centrale
    const open = await send(sofiane.userId, { channel: "fleet", body: "Toujours en attente" });
    const mine = await report(leaving.userId, open.id, "Motif personnel du partant");
    const other = await report(karim.userId, open.id, "Motif de Karim");
    const dismissed = await send(sofiane.userId, { channel: "fleet", body: "Déjà classé" });
    await report(leaving.userId, dismissed.id, "Motif classé");
    await dismiss(dispatcher, (await report(karim.userId, dismissed.id)).report_id);
    // Message du partant signalé par un autre : supprimé avec le compte, son signalement avec lui
    const written = await send(leaving.userId, { channel: "fleet", body: "Message du partant" });
    const onWritten = await report(karim.userId, written.id, "Visait le partant");
    await block(leaving.userId, sofiane.id);
    await block(karim.userId, leaving.id);

    const res = await deleteAccount(leaving.userId);
    expect(res).toMatchObject({ ok: true, code: "DELETED" });

    // Signalements rédigés par le partant (ouvert et classé) : supprimés, motifs compris
    expect(await sql(`select 1 from public.chat_message_reports where reporter_driver_id = $1`, [leaving.id])).toHaveLength(0);
    expect(await sql(`select 1 from public.chat_message_reports where id = $1`, [mine.report_id])).toHaveLength(0);
    expect(await sql(`select 1 from public.chat_message_reports where reason in ('Motif personnel du partant', 'Motif classé')`)).toHaveLength(0);
    // Son message et le signalement qui le visait : supprimés ensemble
    expect(await sql(`select 1 from public.chat_messages where id = $1`, [written.id])).toHaveLength(0);
    expect(await sql(`select 1 from public.chat_message_reports where id = $1`, [onWritten.report_id])).toHaveLength(0);
    expect(await sql(`select 1 from public.chat_blocks where driver_id = $1 or blocked_driver_id = $1`, [leaving.id])).toHaveLength(0);
    // Le signalement de Karim sur le même message reste ouvert
    const [kept] = await sql(`select status, reason from public.chat_message_reports where id = $1`, [other.report_id]);
    expect(kept).toEqual({ status: "open", reason: "Motif de Karim" });

    // File de modération : le message reste signalé une fois (par Karim), sans le nom du partant
    const q = await queue(dispatcher, A.id);
    const item = q.items.find((i: { message: { id: string } }) => i.message.id === open.id);
    expect(item.report_count).toBe(1);
    expect(item.reports.map((r: { reporter_name: string }) => r.reporter_name)).toEqual(["Karim T."]);
    expect(q.items.map((i: { message: { id: string } }) => i.message.id)).not.toContain(written.id);
  });
});

describe("Modération : la centrale supprime un message ou ignore un signalement", () => {
  let A: Org;
  let B: Org;
  let karim: Driver;
  let sofiane: Driver;
  let nadia: Driver;
  let dispatcher: string;

  beforeAll(async () => {
    A = await createOrg("Modération Centrale A");
    B = await createOrg("Modération Centrale B");
    karim = await createDriver(A, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 400) });
    sofiane = await createDriver(A, { firstName: "Sofiane", at: north(CHAMPS_ELYSEES, 800) });
    nadia = await createDriver(A, { firstName: "Nadia", at: north(CHAMPS_ELYSEES, 1200) });
    dispatcher = await createMember(A, "dispatcher", "Lina Dispatch");
  });

  it("file de modération : un élément par message, signalements et motifs, compteur dans chat_overview", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Message douteux" });
    await report(karim.userId, m.id, "Insultes");
    await report(nadia.userId, m.id);

    const q = await queue(dispatcher, A.id);
    expect(q.open).toBe(1);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ message: { id: m.id, body: "Message douteux", author_name: "Sofiane T." }, report_count: 2 });
    expect(q.items[0].reports.map((r: { reporter_name: string; reason: string | null }) => [r.reporter_name, r.reason])).toEqual([
      ["Karim T.", "Insultes"],
      ["Nadia T.", null],
    ]);
    expect((await overview(A.ownerId, A.id)).open_reports).toBe(1);

    expect((await expectPgError(queue(B.ownerId, A.id))).code).toBe("42501");
    expect((await expectPgError(queue(karim.userId, A.id))).code).toBe("42501");
  });

  it("supprimer : message masqué partout, signalements « removed », temps réel, audit ; idempotent", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "À supprimer" });
    const r1 = await report(karim.userId, m.id, "Hors sujet");

    const res = await remove(dispatcher, m.id);
    expect(res).toEqual({ ok: true, code: "REMOVED", message_id: m.id, reports: 1 });
    const [row] = await sql(`select deleted_at, removed_by from public.chat_messages where id = $1`, [m.id]);
    expect(row.deleted_at).not.toBeNull();
    expect(row.removed_by).toBe(dispatcher);
    const [rep] = await sql(`select status, resolved_by, resolved_at from public.chat_message_reports where id = $1`, [r1.report_id]);
    expect(rep).toMatchObject({ status: "removed", resolved_by: dispatcher });
    expect(rep.resolved_at).not.toBeNull();

    // Lecture directe (RLS) : ni la centrale, ni les chauffeurs
    for (const sub of [A.ownerId, dispatcher, nadia.userId, sofiane.userId]) {
      expect(await as({ sub }, (q) => q(`select id from public.chat_messages where id = $1`, [m.id]))).toHaveLength(0);
    }
    // RPC de lecture
    expect(fleetIds(await driverOverview(nadia.userId))).not.toContain(m.id);
    expect((await overview(A.ownerId, A.id)).fleet.last_message?.id).not.toBe(m.id);
    expect((await queue(A.ownerId, A.id)).items.map((i: { message: { id: string } }) => i.message.id)).not.toContain(m.id);

    const events = await moderationEvents(A.id, m.id);
    expect(events.map((e) => e.payload.action)).toEqual(["reported", "removed"]);
    expect(events[1].payload).toEqual({ action: "removed", organization_id: A.id, message_id: m.id });
    const fleet = await sql(`select payload from realtime.messages where topic = $1 and event = 'chat.removed' and payload ->> 'id' = $2`, [
      `fleet:${A.id}`, m.id,
    ]);
    expect(fleet).toHaveLength(1);
    expect(fleet[0].payload).toEqual({ id: m.id, organization_id: A.id });

    const audit = await sql(`select actor_user_id, severity, metadata from public.audit_logs where action = 'chat.message_removed' and entity_id = $1`, [m.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: dispatcher, severity: "warning", metadata: { author_driver_id: sofiane.id, reports: 1 } });

    expect(await remove(dispatcher, m.id)).toEqual({ ok: true, code: "ALREADY_REMOVED", message_id: m.id });
  });

  it("supprimer un signalement de la flotte : expiré, alertes en file annulées, texte retiré du journal, votes refusés", async () => {
    await setLocation(sofiane, A, north(CHAMPS_ELYSEES, 800));
    await setLocation(karim, A, north(CHAMPS_ELYSEES, 400));
    const incident = await send(sofiane.userId, { channel: "fleet", report: "danger", body: "Texte injurieux" });
    const queued = await sql(`select id from public.notifications where data ->> 'message_id' = $1 and status = 'queued'`, [incident.id]);
    expect(queued.length).toBeGreaterThan(0);
    expect((await overview(A.ownerId, A.id)).fleet.active_reports).toBeGreaterThan(0);

    await remove(A.ownerId, incident.id);
    const [row] = await sql(`select expires_at <= now() as expired from public.chat_messages where id = $1`, [incident.id]);
    expect(row.expired).toBe(true);
    const notifs = await sql(`select status from public.notifications where data ->> 'message_id' = $1`, [incident.id]);
    expect(notifs.every((n) => n.status === "cancelled")).toBe(true);
    const journal = await sql(`select message, data from public.ride_events where type = 'fleet.report' and data ->> 'message_id' = $1`, [incident.id]);
    expect(journal).toHaveLength(1);
    expect(journal[0].message).toBe("Signalement retiré par la centrale");
    expect(JSON.stringify(journal[0])).not.toContain("injurieux");
    // Diffusion « chat.report » (carte du dashboard, applications) : inactif
    const upd = await sql(`select payload from realtime.messages where topic = $1 and event = 'chat.report' and payload ->> 'id' = $2`, [
      `org:${A.id}`, incident.id,
    ]);
    expect(upd.at(-1)?.payload.active).toBe(false);
    expect((await driverOverview(karim.userId)).reports.map((r: { id: string }) => r.id)).not.toContain(incident.id);

    const err = await expectPgError(vote(karim.userId, incident.id, true));
    expect(err.message).toMatch(/^REPORT_NOT_FOUND/);
  });

  it("message supprimé pendant la suppression (compte de son auteur) : MESSAGE_NOT_FOUND, ni audit ni diffusion", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Supprimé en même temps" });
    const auditBefore = await sql(`select count(*)::int as n from public.audit_logs where action = 'chat.message_removed'`);
    const eventsBefore = await sql(`select count(*)::int as n from realtime.messages where event in ('chat.moderation', 'chat.removed')`);

    const err = await deletedMeanwhile(m.id, "remove_chat_message", () => expectPgError(remove(dispatcher, m.id)));
    expect(err.code).toBe("P0002");
    expect(err.message).toMatch(/^MESSAGE_NOT_FOUND/);

    expect(await sql(`select count(*)::int as n from public.audit_logs where action = 'chat.message_removed'`)).toEqual(auditBefore);
    expect(await sql(`select count(*)::int as n from realtime.messages where event in ('chat.moderation', 'chat.removed')`)).toEqual(eventsBefore);
  });

  it("ignorer un message supprimé entre-temps (compte de son auteur) : MESSAGE_NOT_FOUND", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Auteur parti" });
    const r = await report(karim.userId, m.id);
    const err = await deletedMeanwhile(m.id, "dismiss_chat_report", () => expectPgError(dismiss(dispatcher, r.report_id)));
    expect(err.code).toBe("P0002");
    expect(err.message).toMatch(/^MESSAGE_NOT_FOUND/);
    expect(await sql(`select 1 from public.audit_logs where action = 'chat.report_dismissed' and entity_id = $1`, [m.id])).toHaveLength(0);
  });

  it("ignorer un message déjà supprimé par un autre membre : ALREADY_RESOLVED « removed », même signalement classé avant", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Supprimé par Lina" });
    const r = await report(karim.userId, m.id);
    await remove(dispatcher, m.id);
    expect(await dismiss(A.ownerId, r.report_id)).toEqual({ ok: true, code: "ALREADY_RESOLVED", message_id: m.id, status: "removed" });

    // Classé, puis signalé à nouveau et supprimé : le premier signalement (classé) renvoie aussi « removed »
    const m2 = await send(sofiane.userId, { channel: "fleet", body: "Classé puis supprimé" });
    const first = await report(karim.userId, m2.id);
    await dismiss(dispatcher, first.report_id);
    await report(nadia.userId, m2.id);
    await remove(dispatcher, m2.id);
    expect(await dismiss(A.ownerId, first.report_id)).toEqual({ ok: true, code: "ALREADY_RESOLVED", message_id: m2.id, status: "removed" });
  });

  it("refus : fil direct, chauffeur, autre centrale", async () => {
    const direct = await send(A.ownerId, { org: A.id, channel: "driver", driver: karim.id, body: "Privé" });
    expect((await expectPgError(remove(A.ownerId, direct.id))).message).toMatch(/^NOT_REMOVABLE/);
    const m = await send(sofiane.userId, { channel: "fleet", body: "Reste là" });
    expect((await expectPgError(remove(karim.userId, m.id))).code).toBe("42501");
    expect((await expectPgError(remove(B.ownerId, m.id))).code).toBe("42501");
    const [row] = await sql(`select deleted_at from public.chat_messages where id = $1`, [m.id]);
    expect(row.deleted_at).toBeNull();
  });

  it("ignorer : tous les signalements du message classés ; message conservé pour les autres ; idempotent", async () => {
    const m = await send(sofiane.userId, { channel: "fleet", body: "Blague limite" });
    const r1 = await report(karim.userId, m.id);
    const r2 = await report(nadia.userId, m.id, "Pas drôle");

    expect((await expectPgError(dismiss(karim.userId, r1.report_id))).code).toBe("42501");
    expect((await expectPgError(dismiss(B.ownerId, r1.report_id))).code).toBe("42501");

    const res = await dismiss(dispatcher, r1.report_id);
    expect(res).toEqual({ ok: true, code: "DISMISSED", message_id: m.id, dismissed: 2 });
    const rows = await sql(`select status, resolved_by from public.chat_message_reports where id = any($1) order by created_at`, [
      [r1.report_id, r2.report_id],
    ]);
    expect(rows).toEqual([
      { status: "dismissed", resolved_by: dispatcher },
      { status: "dismissed", resolved_by: dispatcher },
    ]);
    expect((await moderationEvents(A.id, m.id)).map((e) => e.payload.action)).toEqual(["reported", "reported", "dismissed"]);
    expect((await queue(A.ownerId, A.id)).items.map((i: { message: { id: string } }) => i.message.id)).not.toContain(m.id);

    // Toujours visible pour qui ne l'a pas signalé ; toujours masqué pour ceux qui l'ont signalé
    const others = await driverOverview(sofiane.userId);
    expect(fleetIds(others)).toContain(m.id);
    expect(fleetIds(await driverOverview(karim.userId))).not.toContain(m.id);

    expect(await dismiss(dispatcher, r2.report_id)).toEqual({ ok: true, code: "ALREADY_RESOLVED", message_id: m.id, status: "dismissed" });

    // Un nouveau signalement (autre chauffeur) rouvre la file
    const late = await createDriver(A, { firstName: "Tardif" });
    expect((await report(late.userId, m.id)).code).toBe("REPORTED");
    expect((await queue(A.ownerId, A.id)).items.map((i: { message: { id: string } }) => i.message.id)).toContain(m.id);
  });
});
