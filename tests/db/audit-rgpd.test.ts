import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createDriver, createOrg, createRideAsOwner, expectPgError, inMinutes, insertRideBypass,
  north, pool, rideState, sql, type Org,
} from "./helpers";

// Audit RGPD (migration 20260924004800) : conservation réellement appliquée (journal Supabase Auth, courses non
// clôturées, position des alertes), signalement retiré, suppression de compte (centrale inactive, débiteur).

type Row = Record<string, any>;

const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
const housekeeping = async () => (await sql("select private.housekeeping() as r"))[0].r as Row;
/** Purge du journal Auth espacée (une fois par heure) : oubliée pour le passage suivant. */
const forgetAuthAuditRun = () => sql("delete from private.housekeeping_runs where task = 'auth_audit'");
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const uniquePlate = () => `RG-${String(Math.floor(Math.random() * 900) + 100)}-${randomUUID().slice(0, 2).toUpperCase()}`;
const uniqueVtc = () => `EVTC${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

/** Journal d'audit de Supabase Auth, tel que GoTrue le crée (RLS activée, sans policy). */
beforeAll(async () => {
  await sql(`create table if not exists auth.audit_log_entries (
    instance_id uuid, id uuid primary key, payload json, created_at timestamptz, ip_address varchar(64) not null default '')`);
  await sql(`alter table auth.audit_log_entries enable row level security`);
});

afterAll(async () => {
  await sql(`drop table if exists auth.audit_log_entries`);
  await forgetAuthAuditRun();
  await pool.end();
});

async function authLog(payload: Record<string, unknown>, daysAgo = 0) {
  const id = randomUUID();
  await sql(
    `insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
     values ('00000000-0000-0000-0000-000000000000', $1, $2::json, now() - make_interval(days => $3), '203.0.113.50')`,
    [id, JSON.stringify(payload), daysAgo],
  );
  return id;
}
const login = (userId: string, name: string, email: string, daysAgo = 0) =>
  authLog({ action: "login", actor_id: userId, actor_name: name, actor_username: email, log_type: "account", traits: { provider: "email" } }, daysAgo);
const authLogsLeft = async (ids: string[]) =>
  (await sql(`select id from auth.audit_log_entries where id = any($1::uuid[])`, [ids])).map((r) => r.id as string).sort();

async function centrale(name: string, autoApprove = false) {
  const org = await createOrg(name);
  await sql(
    `update public.organizations set dispatch_model = 'centrale', join_enabled = true, join_auto_approve = $2 where id = $1`,
    [org.id, autoApprove],
  );
  return org;
}

// -----------------------------------------------------------------------------
describe("Journal d'audit de Supabase Auth (textes-accueil#0)", () => {
  it("ménage : connexions de plus d'un an effacées, une fois par heure au plus", async () => {
    const user = randomUUID();
    const old = await login(user, "Karim Ancien", "karim.ancien@test.dev", 400);
    const recent = await login(user, "Karim Ancien", "karim.ancien@test.dev", 10);
    await forgetAuthAuditRun();
    const res = await housekeeping();
    expect(res.errors).toBeUndefined();
    expect(res.auth_audit_purged).toBeGreaterThanOrEqual(1);
    expect(await authLogsLeft([old, recent])).toEqual([recent]);
    // Passage suivant dans l'heure : table non reparcourue
    const again = await housekeeping();
    expect(again.auth_audit_purged).toBeNull();
    expect(again.errors).toBeUndefined();
  });

  it("suppression du compte chauffeur : son historique de connexions et la trace de suppression effacés ; ceux des autres restent", async () => {
    const org = await createOrg("RGPD journal Auth");
    const d = await createDriver(org, { firstName: "Journalise" });
    const other = await createDriver(org, { firstName: "Voisin" });
    const mine = [
      await login(d.userId, "Journalise Test", "journalise@test.dev", 3),
      await authLog({ action: "token_refreshed", actor_id: d.userId, actor_username: "journalise@test.dev", log_type: "token" }, 1),
    ];
    const theirs = await login(other.userId, "Voisin Test", "voisin@test.dev", 3);

    const del = await svc("svc_delete_driver_account", [d.userId]);
    expect(del).toMatchObject({ ok: true, code: "DELETED", keep_auth: false, auth_done: false });
    // GoTrue écrit « user_deleted » (traits) quand la route supprime le compte, avant d'enregistrer l'avancement
    mine.push(await authLog({ action: "user_deleted", actor_id: "00000000-0000-0000-0000-000000000000", actor_username: "service_role",
      log_type: "team", traits: { user_email: "journalise@test.dev", user_id: d.userId, user_phone: "" } }));
    const progress = await svc("svc_account_deletion_progress", [del.deletion_id, true, true, null]);
    expect(progress).toMatchObject({ ok: true, done: true });
    expect(progress).not.toHaveProperty("auth_log_error");
    expect(await authLogsLeft([...mine, theirs])).toEqual([theirs]);
  });

  it("purge impossible (droits, table) : erreur consignée, ni le ménage ni la suppression n'échouent", async () => {
    await sql(`create function public.test_block_auth_audit() returns trigger language plpgsql as $$
               begin raise exception 'permission refusée (test)'; end; $$`);
    await sql("create trigger test_block_auth_audit before delete on auth.audit_log_entries for each row execute function public.test_block_auth_audit()");
    try {
      const user = randomUUID();
      const old = await login(user, "Nadia Bloquee", "nadia@test.dev", 500);
      const [event] = await sql(
        `insert into public.ride_events (organization_id, type, message, created_at)
         values ($1, 'fleet.report', 'Bouchon signalé', now() - interval '200 days') returning id`,
        [(await createOrg("RGPD purge bloquée")).id],
      );
      await forgetAuthAuditRun();
      const res = await housekeeping();
      expect(res.errors).toEqual({ auth_audit: expect.stringMatching(/permission refusée/) });
      expect(res.auth_audit_purged).toBeNull();
      expect(await authLogsLeft([old])).toEqual([old]);
      // Le reste du ménage est passé
      expect(await sql("select id from public.ride_events where id = $1", [event.id])).toHaveLength(0);

      const org = await createOrg("RGPD suppression bloquée");
      const d = await createDriver(org, { firstName: "Bloque" });
      const mine = await login(d.userId, "Bloque Test", "bloque@test.dev", 1);
      const del = await svc("svc_delete_driver_account", [d.userId]);
      const progress = await svc("svc_account_deletion_progress", [del.deletion_id, true, true, null]);
      expect(progress).toMatchObject({ ok: true, done: true, auth_log_error: expect.stringMatching(/permission refusée/) });
      expect(await authLogsLeft([mine])).toEqual([mine]);
    } finally {
      await sql("drop trigger test_block_auth_audit on auth.audit_log_entries");
      await sql("drop function public.test_block_auth_audit()");
      await forgetAuthAuditRun();
    }
  });
});

// -----------------------------------------------------------------------------
describe("Durées de conservation complétées (textes-accueil#8 et #9)", () => {
  it("courses de plus de 10 ans purgées quel que soit leur statut (course jamais clôturée comprise)", async () => {
    const org = await createOrg("RGPD courses non closes");
    const [{ limit }] = await sql("select date_trunc('year', now() - interval '10 years') as limit");
    const before = new Date((limit as Date).getTime() - 86_400_000);
    const after = new Date((limit as Date).getTime() + 86_400_000);
    const d = await createDriver(org, { firstName: "Ancien" });
    const stale = [
      await insertRideBypass(org, { status: "CREATED", pickup_at: before, customer_name: "Client Oublié" }),
      await insertRideBypass(org, { status: "ACCEPTED", pickup_at: before, driver_id: d.id }),
      await insertRideBypass(org, { status: "IN_PROGRESS", pickup_at: before, driver_id: d.id }),
    ];
    await sql("update public.drivers set current_ride_id = $2 where id = $1", [d.id, stale[2]]);
    const kept = await insertRideBypass(org, { status: "CREATED", pickup_at: after });
    const res = await housekeeping();
    expect(res.errors).toBeUndefined();
    expect(res.rides_purged).toBeGreaterThanOrEqual(3);
    expect((await sql("select id from public.rides where id = any($1::uuid[])", [[...stale, kept]])).map((r) => r.id)).toEqual([kept]);
    expect((await sql("select current_ride_id from public.drivers where id = $1", [d.id]))[0].current_ride_id).toBeNull();
  });

  it("position du chauffeur dans une alerte close et dans son journal : retirée au bout de 30 jours", async () => {
    const org = await createOrg("RGPD alertes");
    const d = await createDriver(org, { firstName: "Immobile" });
    const ride = await insertRideBypass(org, { status: "COMPLETED", pickup_at: new Date(Date.now() - 40 * 86_400_000), driver_id: d.id });
    const alert = async (kind: string, status: "open" | "resolved", daysAgo: number) =>
      (await sql(
        `insert into public.ride_alerts (organization_id, ride_id, driver_id, kind, message, data, status, resolution, resolved_at, created_at)
         values ($1, $2, $3, $4, 'Immobile est immobile depuis 12 min', '{"lat": 48.87, "lng": 2.30, "driver_name": "Immobile", "still_minutes": 12}',
                 $5, case when $5 = 'resolved' then 'auto_resolved' end, case when $5 = 'resolved' then now() end,
                 now() - make_interval(days => $6))
         returning id`,
        [org.id, ride, d.id, kind, status, daysAgo],
      ))[0].id as string;
    const oldResolved = await alert("stalled", "resolved", 31);
    const oldOpen = await alert("no_gps", "open", 31);
    const recent = await alert("late", "resolved", 5);
    const event = async (type: string, daysAgo: number) =>
      String((await sql(
        `insert into public.ride_events (organization_id, ride_id, type, level, message, data, created_at)
         values ($1, $2, $3, 'warning', 'Immobile est immobile', '{"lat": 48.87, "lng": 2.30, "kind": "stalled"}', now() - make_interval(days => $4))
         returning id`,
        [org.id, ride, type, daysAgo],
      ))[0].id);
    const oldEvent = await event("alert.stalled", 31);
    const oldNoGps = await event("alert.no_gps", 45);
    const recentEvent = await event("alert.stalled", 3);

    const res = await housekeeping();
    expect(res.alert_positions_purged).toBeGreaterThanOrEqual(3);
    const alerts = Object.fromEntries((await sql("select id, data from public.ride_alerts where id = any($1::uuid[])", [[oldResolved, oldOpen, recent]])).map((r) => [r.id, r.data]));
    expect(alerts[oldResolved]).toEqual({ driver_name: "Immobile", still_minutes: 12 });
    expect(alerts[oldOpen]).toMatchObject({ lat: 48.87, lng: 2.3 });
    expect(alerts[recent]).toMatchObject({ lat: 48.87, lng: 2.3 });
    const events = Object.fromEntries((await sql("select id, data from public.ride_events where id = any($1::bigint[])", [[oldEvent, oldNoGps, recentEvent]])).map((r) => [String(r.id), r.data]));
    expect(events[oldEvent]).toEqual({ kind: "stalled" });
    expect(events[oldNoGps]).toEqual({ kind: "stalled" });
    expect(events[recentEvent]).toMatchObject({ lat: 48.87 });
  });
});

// -----------------------------------------------------------------------------
describe("Signalement retiré par la centrale (flux-annexes#6, textes-accueil#2)", () => {
  it("texte, auteur et position effacés des alertes envoyées ; puis supprimées avec le compte de l'auteur", async () => {
    const org = await createOrg("RGPD signalement retiré");
    const author = await createDriver(org, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 400) });
    const mate = await createDriver(org, { firstName: "Paulin", at: north(CHAMPS_ELYSEES, 600) });
    const [sent] = await as({ sub: author.userId }, (q) =>
      q(`select public.send_chat_message(null, 'fleet', null, 'Contrôle rue de Rivoli, le client Dupont insulte', 'control', null, null) as m`),
    );
    const messageId = sent.m.id as string;
    // Alerte déjà envoyée par le worker
    await sql(`update public.notifications set status = 'sent', sent_at = now() where data ->> 'message_id' = $1`, [messageId]);
    const [before] = await sql(`select body, data from public.notifications where driver_id = $1 and type = 'fleet_report'`, [mate.id]);
    expect(before.body).toContain("Dupont");
    expect(before.data.author_name).toBe("Karim T.");

    expect((await rpc(org.ownerId, "remove_chat_message", [messageId])).code).toBe("REMOVED");
    const after = await sql(`select status, body, data from public.notifications where data ->> 'message_id' = $1`, [messageId]);
    expect(after).toEqual([{ status: "sent", body: "Signalement retiré par la centrale", data: { message_id: messageId, removed: true } }]);
    // Lu par le destinataire comme par la centrale : plus rien du texte ni de l'auteur
    for (const sub of [mate.userId, org.ownerId]) {
      const rows = await as({ sub }, (q) => q(`select body, data from public.notifications where data ->> 'message_id' = $1`, [messageId]));
      expect(JSON.stringify(rows)).not.toMatch(/Dupont|Karim|48\.8/);
    }

    // Compte de l'auteur supprimé : le signalement retiré (journal sans auteur) est retrouvé, ses alertes partent
    expect((await svc("svc_delete_driver_account", [author.userId])).code).toBe("DELETED");
    expect(await sql(`select id from public.notifications where data ->> 'message_id' = $1`, [messageId])).toHaveLength(0);
    expect(await sql(`select id from public.ride_events where data ->> 'message_id' = $1`, [messageId])).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe("Suppression de compte, centrale suspendue ou archivée (textes-accueil#7)", () => {
  it("course acceptée non commencée libérée (à attribuer), puis compte supprimé", async () => {
    const org = await createOrg("RGPD centrale suspendue");
    const d = await createDriver(org, { firstName: "Suspendu", at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers[0];
    expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
    await sql(`update public.organizations set status = 'suspended' where id = $1`, [org.id]);

    const admin = await createAuthUser(`admin-${randomUUID().slice(0, 6)}@test.dev`, "Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [admin]);
    const r = await svc("svc_admin_delete_driver", [d.id, admin]);
    expect(r).toMatchObject({ ok: true, code: "DELETED", rides_released: 1 });
    const [row] = await sql(`select status, driver_id, vehicle_id, accepted_at from public.rides where id = $1`, [ride.id]);
    expect(row).toEqual({ status: "CREATED", driver_id: null, vehicle_id: null, accepted_at: null });
    expect((await sql(`select count(*)::int as n from public.ride_assignments where ride_id = $1 and is_active`, [ride.id]))[0].n).toBe(0);
    const [event] = await sql(`select message, level from public.ride_events where ride_id = $1 and type = 'ride.driver_deleted'`, [ride.id]);
    expect(event).toEqual({
      level: "warning",
      message: `Course retirée au chauffeur #${d.number}, qui a supprimé son compte (centrale inactive) — à attribuer manuellement`,
    });
    const [fiche] = await sql(`select deleted_at is not null as deleted, current_ride_id from public.drivers where id = $1`, [d.id]);
    expect(fiche).toEqual({ deleted: true, current_ride_id: null });
  });

  it("course commencée : refus, sans rien libérer ; centrale active : refus inchangé", async () => {
    const org = await createOrg("RGPD centrale archivée");
    const d = await createDriver(org, { firstName: "Enroute" });
    const accepted = await insertRideBypass(org, { status: "ACCEPTED", driver_id: d.id, pickup_at: inMinutes(600) });
    const started = await insertRideBypass(org, { status: "IN_PROGRESS", driver_id: d.id, pickup_at: new Date() });
    await sql(`update public.organizations set status = 'archived' where id = $1`, [org.id]);
    const r = await svc("svc_delete_driver_account", [d.userId]);
    expect(r).toMatchObject({ ok: false, code: "RIDES_ASSIGNED", count: 1 });
    const rows = await sql(`select id, status, driver_id from public.rides where id = any($1::uuid[]) order by status`, [[accepted, started]]);
    expect(rows).toEqual([
      { id: accepted, status: "ACCEPTED", driver_id: d.id },
      { id: started, status: "IN_PROGRESS", driver_id: d.id },
    ]);
    expect((await sql(`select deleted_at from public.drivers where id = $1`, [d.id]))[0].deleted_at).toBeNull();

    const active = await createOrg("RGPD centrale active");
    const e = await createDriver(active, { firstName: "Actif" });
    await insertRideBypass(active, { status: "ACCEPTED", driver_id: e.id, pickup_at: inMinutes(600) });
    expect(await svc("svc_delete_driver_account", [e.userId])).toMatchObject({ ok: false, code: "RIDES_ASSIGNED", count: 1 });
  });
});

// -----------------------------------------------------------------------------
describe("Chauffeur supprimé avec des commissions dues (sql-rpc-argent#1, api-driver#7)", () => {
  async function applyWith(org: Org, id: { phone: string; email: string; vtc: string | null }, first = "Karim") {
    const userId = await createAuthUser(`${randomUUID().slice(0, 8)}-${id.email}`, `${first} Candidat`);
    return svc("svc_driver_apply", [org.id, userId, first, "Candidat", id.phone, id.email, id.vtc,
      JSON.stringify({ model: "Classe E", plate: uniquePlate(), category: "business" }), null]);
  }
  async function owe(org: Org, driverId: string, cents: number) {
    const ride = await insertRideBypass(org, { status: "COMPLETED", driver_id: driverId, pickup_at: new Date(), payment_method: "cash" });
    await sql(
      `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
         commission_cents, driver_payout_cents, payment_method, reference, status, due_at)
       values ($1, $2, $3, 'Karim Candidat', 'driver_owes', $4, 5000, $4, 5000 - $4, 'cash', $5, 'due', now() - interval '1 day')`,
      [org.id, ride, driverId, cents, `RG-${randomUUID().slice(0, 8)}`],
    );
  }

  it("empreintes gardées tant que la dette est ouverte, candidature jamais validée d'office, montant visible de la centrale", async () => {
    const org = await centrale("RGPD dette", true);
    const id = { phone: uniquePhone(), email: `dette-${randomUUID().slice(0, 6)}@test.dev`, vtc: uniqueVtc() };
    const first = await applyWith(org, id);
    expect(first.code).toBe("APPROVED");
    const [{ number }] = await sql(`select number from public.drivers where id = $1`, [first.driver_id]);
    const [{ user_id: userId }] = await sql(`select user_id from public.drivers where id = $1`, [first.driver_id]);
    await owe(org, first.driver_id, 1900);
    await owe(org, first.driver_id, 1500);

    expect((await svc("svc_delete_driver_account", [userId])).code).toBe("DELETED");
    const kept = await sql(`select kind, value_hash, driver_number from private.debtor_identities where driver_id = $1 order by kind`, [first.driver_id]);
    // E-mail de la fiche et e-mail du compte de connexion (ici distincts), téléphone, carte VTC
    expect(kept.map((k) => k.kind)).toEqual(["email", "email", "phone", "vtc_card"]);
    expect(kept.every((k) => /^[0-9a-f]{64}$/.test(k.value_hash) && k.driver_number === number)).toBe(true);
    const [deleted] = await sql(`select message, level from public.ride_events where type = 'driver.deleted' and data ->> 'driver_id' = $1`, [first.driver_id]);
    expect(deleted).toEqual({
      level: "warning",
      message: `Le chauffeur #${number} a supprimé son compte — reste dû : 34 € de commissions (2 règlements au nom de « Chauffeur supprimé (#${number}) »)`,
    });
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'driver.deleted' and entity_id = $1`, [first.driver_id]);
    expect(audit.metadata).toMatchObject({ owed_cents: 3400, owed_settlements: 2, debtor_identities: 4 });

    // Même carte VTC (téléphone et e-mail nouveaux) : en attente malgré la validation automatique
    const again = await applyWith(org, { phone: uniquePhone(), email: `autre-${randomUUID().slice(0, 6)}@test.dev`, vtc: id.vtc.toLowerCase() });
    expect(again.code).toBe("PENDING");
    expect((await sql(`select status, application_status from public.drivers where id = $1`, [again.driver_id]))[0])
      .toEqual({ status: "inactive", application_status: "pending" });
    const [warn] = await sql(`select message, level, data from public.ride_events where type = 'driver.applied_debtor' and data ->> 'driver_id' = $1`, [again.driver_id]);
    expect(warn.level).toBe("warning");
    expect(warn.message).toContain(`« Chauffeur supprimé (#${number}) »`);
    expect(warn.message).toContain("34 € de commissions");
    expect(warn.data).toMatchObject({ owed_cents: 3400, owed_settlements: 2, debtor_numbers: [number] });
    const [applied] = await sql(`select severity, metadata from public.audit_logs where action = 'driver.applied' and entity_id = $1`, [again.driver_id]);
    expect(applied).toMatchObject({ severity: "warning", metadata: { auto_approved: false, debtor: { owed_cents: 3400, numbers: [number] } } });
    // Réponse identique à une candidature en attente : rien n'est dit au candidat
    expect(Object.keys(again).sort()).toEqual(["code", "driver_id", "number", "ok", "organization"]);

    // Identité sans lien : validation automatique inchangée
    expect((await applyWith(org, { phone: uniquePhone(), email: `libre-${randomUUID().slice(0, 6)}@test.dev`, vtc: uniqueVtc() })).code).toBe("APPROVED");
    // Autre centrale : la dette ne la regarde pas
    const other = await centrale("RGPD autre centrale", true);
    expect((await applyWith(other, { ...id, email: `x-${id.email}` })).code).toBe("APPROVED");

    // Dette réglée : empreintes effacées au ménage suivant, validation automatique rétablie
    await sql(`update public.ride_settlements set status = 'paid', settled_at = now() where driver_id = $1`, [first.driver_id]);
    expect((await housekeeping()).debtor_identities_purged).toBeGreaterThanOrEqual(4);
    expect(await sql(`select id from private.debtor_identities where driver_id = $1`, [first.driver_id])).toHaveLength(0);
    expect((await applyWith(org, { phone: uniquePhone(), email: id.email, vtc: null })).code).toBe("APPROVED");
  });

  it("aucune dette : aucune empreinte gardée ; table inaccessible aux clients", async () => {
    const org = await centrale("RGPD sans dette", true);
    const d = await createDriver(org, { firstName: "Solvable" });
    await sql(`update public.drivers set email = $2 where id = $1`, [d.id, `solvable-${randomUUID().slice(0, 6)}@test.dev`]);
    expect((await svc("svc_delete_driver_account", [d.userId])).code).toBe("DELETED");
    expect(await sql(`select id from private.debtor_identities where driver_id = $1`, [d.id])).toHaveLength(0);
    for (const who of [{ sub: org.ownerId }, { role: "service_role" as const }, { role: "anon" as const }]) {
      const e = await expectPgError(as(who, (q) => q("select * from private.debtor_identities")));
      expect(e.code).toBe("42501");
      const f = await expectPgError(as(who, (q) => q("select private.debtor_match($1, '0600000000', null, null)", [org.id])));
      expect(f.code).toBe("42501");
    }
  });
});
