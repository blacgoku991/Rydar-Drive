import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createDriver, createMember, createOrg, createRideAsOwner, expectPgError, inMinutes,
  insertRideBypass, north, pool, rideState, sql, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
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
const svcDelete = (userId: string) => svc("svc_delete_driver_account", [userId]);

/** Valeurs uniques (lettres seulement pour les noms) : retrouvables sans ambiguïté partout dans la base. */
const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const uniquePlate = () => `${letters(2)}-${String(Math.floor(Math.random() * 900) + 100)}-${letters(2)}`.toUpperCase();
const NEAR = north(CHAMPS_ELYSEES, 500);

async function centrale(name: string) {
  const org = await createOrg(name);
  await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_fixed_cents = 500, join_enabled = true where id = $1`, [org.id]);
  return org;
}

async function setLocation(org: Org, driverId: string, point: [number, number], ageSeconds = 5) {
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
     values ($1, $2, $3, $4, now() - make_interval(secs => $5), now() - make_interval(secs => $5))
     on conflict (driver_id) do update set lat = excluded.lat, lng = excluded.lng, recorded_at = excluded.recorded_at,
       updated_at = excluded.updated_at`,
    [driverId, org.id, point[0], point[1], ageSeconds],
  );
}

/** Candidature par lien (véhicule personnel créé), puis validation éventuelle par le propriétaire. */
async function applicant(org: Org, opts: { approve?: boolean; first?: string; last?: string } = {}) {
  const first = opts.first ?? cap(`q${letters(8)}`);
  const last = opts.last ?? cap(`z${letters(8)}`);
  const phone = uniquePhone();
  const email = `${letters(10)}@example.test`;
  const plate = uniquePlate();
  const vtc = `EVTC${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const userId = await createAuthUser(email, `${first} ${last}`);
  await sql(`update public.users set phone = $2 where id = $1`, [userId, phone]);
  const vehicle = { brand: "Toyota", model: "Corolla", color: "Gris", plate, category: "standard", seats: 4 };
  const applied = await svc("svc_driver_apply", [org.id, userId, first, last, phone, email, vtc, JSON.stringify(vehicle), `Je suis ${first}`]);
  expect(applied.code).toBe("PENDING");
  if (opts.approve) expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, "trusted"])).code).toBe("APPROVED");
  const [d] = await sql(`select id, number, vehicle_id from public.drivers where id = $1`, [applied.driver_id]);
  return { id: d.id as string, number: d.number as number, vehicleId: d.vehicle_id as string, userId, first, last, phone, email, plate, vtc };
}

async function acceptAndComplete(userId: string, driverId: string, rideId: string) {
  const offer = (await rideState(rideId)).offers.find((o) => o.driver_id === driverId && o.status === "pending");
  expect(offer, "offre en attente").toBeTruthy();
  expect((await rpc(userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
    const r = await rpc(userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Parcourt TOUTES les colonnes texte / varchar / jsonb / tableaux de texte des tables du schéma public et renvoie
 * les valeurs qui contiennent encore l'une des chaînes cherchées (insensible à la casse).
 */
async function findTraces(needles: string[]) {
  const cols = await sql(
    `select c.table_name, c.column_name
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public'
        and (c.data_type in ('text', 'character varying', 'jsonb', 'json')
             or (c.data_type = 'ARRAY' and c.udt_name in ('_text', '_varchar')))
      order by 1, 2`,
  );
  expect(cols.length).toBeGreaterThan(100);
  const patterns = needles.map((n) => `%${likeEscape(n)}%`);
  const hits: string[] = [];
  for (const { table_name, column_name } of cols) {
    const rows = await sql(
      `select "${column_name}"::text as v from public."${table_name}" where "${column_name}"::text ilike any ($1::text[])`,
      [patterns],
    );
    for (const r of rows) hits.push(`${table_name}.${column_name} : ${String(r.v).slice(0, 240)}`);
  }
  return hits;
}

// -----------------------------------------------------------------------------
describe("Suppression du compte chauffeur — identité effacée partout (migration 004000)", () => {
  it("après suppression, ni prénom, ni nom, ni téléphone, ni e-mail, ni plaque, ni carte VTC dans aucune colonne texte / jsonb du schéma public", async () => {
    const org = await centrale("Suppression totale");
    const me = await applicant(org, { approve: true });
    const alias = `Chauffeur supprimé (#${me.number})`;
    await sql(`update public.drivers set presence = 'available' where id = $1`, [me.id]);
    await setLocation(org, me.id, NEAR);
    // Collègue en ligne à côté (destinataire du signalement, cité dans les « non sollicités »)
    const mate = await createDriver(org, { firstName: "Paulin", at: north(CHAMPS_ELYSEES, 700), category: "business" });

    // 1) Course payée en espèces : acceptée, terminée → règlement, « X accepte », « Commission de … due par X »
    const ride = await createRideAsOwner(org, { vehicle_category: "standard", price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
    await acceptAndComplete(me.userId, me.id, ride.id);
    const [settlement] = await sql(`select id, driver_label from public.ride_settlements where ride_id = $1`, [ride.id]);
    expect(settlement.driver_label).toContain(me.first);
    expect((await rpc(org.ownerId, "remind_driver_settlements", [me.id])).code).toBe("REMINDED");
    expect((await rpc(me.userId, "driver_declare_payment", [[settlement.id], "cash", `Réglé par ${me.first}`])).code).toBe("DECLARED");

    // 2) Course « van » : personne de compatible → « non sollicités » (lui et le collègue)
    const van = await createRideAsOwner(org, { vehicle_category: "van", price_cents: 9000 });
    await sql(`select private.explain_no_driver($1)`, [van.id]);
    const [excluded] = await sql(`select message, data from public.ride_events where ride_id = $1 and type = 'dispatch.excluded'`, [van.id]);
    expect(excluded.message).toContain(`${me.first} ${me.last.charAt(0)}.`);

    // 3) Attribution manuelle, GPS muet → alerte (nom, position), puis course retirée par la centrale
    await setLocation(org, me.id, NEAR, 600);
    const late = await createRideAsOwner(org, { vehicle_category: "standard", price_cents: 4000 });
    expect((await rpc(org.ownerId, "assign_ride", [late.id, me.id])).code).toBe("ASSIGNED");
    await sql(`select private.watch_rides()`);
    const [alert] = await sql(`select message, data from public.ride_alerts where ride_id = $1 and kind = 'no_gps'`, [late.id]);
    expect(alert.message).toContain(me.first);
    expect(alert.data.lat).toBeTypeOf("number");
    expect((await rpc(org.ownerId, "reassign_ride", [late.id, `${me.first} ne répond pas`, me.id])).ok).toBe(true);
    await setLocation(org, me.id, NEAR);

    // 4) Messagerie : message à la centrale, réponse, signalement flotte (notification + vote du collègue)
    await as({ sub: me.userId }, (q) => q(`select public.send_chat_message(null, 'driver', null, $1, null, null, null)`, [`Bonjour, ici ${me.first}`]));
    await as({ sub: org.ownerId }, (q) => q(`select public.send_chat_message($1, 'driver', $2, $3, null, null, null)`, [org.id, me.id, `Bien reçu ${me.first}`]));
    const [report] = await as({ sub: me.userId }, (q) =>
      q(`select public.send_chat_message(null, 'fleet', null, 'Contrôle place de la Concorde', 'control', $1, $2) as m`, [NEAR[0], NEAR[1]]),
    );
    expect(report.m.notified).toBe(1);
    const [mateNotif] = await sql(`select data from public.notifications where driver_id = $1 and type = 'fleet_report'`, [mate.id]);
    expect(mateNotif.data.author_name).toBe(`${me.first} ${me.last.charAt(0)}.`);
    await as({ sub: mate.userId }, (q) => q(`select public.vote_fleet_report($1, true)`, [report.m.id]));

    // 5) Données personnelles diverses : justificatif, appareil, jeton, historique GPS, session
    await sql(
      `insert into public.driver_documents (organization_id, driver_id, type, file_path, number, status) values ($1, $2, 'vtc_card', $3, $4, 'valid')`,
      [org.id, me.id, `${org.id}/${me.id}/vtc_card-1.jpg`, me.vtc],
    );
    const [device] = await sql(
      `insert into public.driver_devices (organization_id, driver_id, installation_id, platform, app_version, device_name)
       values ($1, $2, $3, 'android', '1.1.0', $4) returning id`,
      [org.id, me.id, `and-${letters(16)}`, `Téléphone de ${me.first}`],
    );
    await sql(`insert into public.push_tokens (organization_id, driver_id, device_id, token, platform) values ($1, $2, $3, $4, 'android')`, [
      org.id, me.id, device.id, `ExponentPushToken[${letters(20)}]`,
    ]);
    await sql(`insert into public.driver_location_history (organization_id, driver_id, lat, lng, recorded_at) values ($1, $2, $3, $4, now())`, [
      org.id, me.id, NEAR[0], NEAR[1],
    ]);

    // 6) Bannissement pour fraude signalé au super admin (motif conservé) + trace d'audit web du signalement
    const ban = await rpc(org.ownerId, "ban_driver", [me.id, `Commission jamais payée par ${me.first}`, "unpaid", true, true]);
    expect(ban.code).toBe("BANNED");
    const [fraud] = await sql(`select id, driver_label from public.fraud_reports where driver_id = $1`, [me.id]);
    expect(fraud.driver_label).toContain(me.last);
    await sql(
      `insert into public.audit_logs (organization_id, actor_type, action, entity_type, entity_id, metadata)
       values ($1, 'super_admin', 'fraud_report.dismissed', 'fraud_reports', $2, $3)`,
      [org.id, fraud.id, { driver: fraud.driver_label, note: "Classé" }],
    );
    // Indices en clair du bannissement (initiale, domaine, chiffres) : identités, signalement, journal d'une levée
    const hints = await sql(`select id, kind, hint from public.banned_identities where driver_id = $1 order by kind`, [me.id]);
    expect(hints.filter((h) => h.hint).length).toBeGreaterThan(3);
    const phoneBan = hints.find((h) => h.kind === "phone");
    expect((await rpc(org.ownerId, "lift_identity_ban", [phoneBan.id, `Numéro de ${me.first} réattribué`])).code).toBe("LIFTED");
    expect((await sql(`select metadata from public.audit_logs where action = 'identity_ban.lifted' and entity_id = $1`, [phoneBan.id]))[0].metadata.hint).toBe(phoneBan.hint);
    await sql(`insert into auth.sessions (user_id) values ($1)`, [me.userId]);

    // 7) Journal d'audit web : inscription par lien (IP et navigateur du candidat, lib/join.ts), action de la
    //    centrale sur sa fiche (IP du propriétaire), action de son propre compte
    const audit = async (actorType: string, actorId: string | null, action: string, entity: [string, string], ip: string, ua: string, metadata: Row) =>
      (
        await sql(
          `insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, ip, user_agent, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [org.id, actorType, actorId, action, entity[0], entity[1], ip, ua, metadata],
        )
      )[0].id as string;
    const signupAudit = await audit("system", null, "driver.join_link_signup", ["drivers", me.id], "203.0.113.7", "Mozilla/5.0 (iPhone)", {
      status: "PENDING", email: me.email, driver_number: me.number,
    });
    const ownerAudit = await audit("user", org.ownerId, "driver.trust_level_changed", ["drivers", me.id], "198.51.100.20", "Mozilla/5.0 (Macintosh)", {
      from: "new", to: "trusted",
    });
    const selfAudit = await audit("user", me.userId, "user.password_changed", ["users", me.userId], "203.0.113.8", "RydarDrive/1.1 (Android)", {});

    // Avant : l'identité est bien présente (le parcours ci-dessous ne passe pas à vide)
    const needles = [me.first, me.last, me.phone, `+33${me.phone.slice(1)}`, me.email, me.plate, me.vtc];
    expect((await findTraces(needles)).length).toBeGreaterThan(10);

    // ------------------------------------------------------------ suppression (depuis l'application)
    const r = await svcDelete(me.userId);
    expect(r).toMatchObject({
      ok: true, code: "DELETED", already_deleted: false, driver_id: me.id, organization_id: org.id, number: me.number,
      keep_auth: false, storage_prefix: `${org.id}/${me.id}/`, storage_done: false, auth_done: false, pending: true,
      documents: 1, vehicle: "anonymized",
    });

    // File : compte de connexion et dossier de stockage à supprimer
    const [q] = await sql(`select * from private.account_deletions where driver_id = $1`, [me.id]);
    expect(q).toMatchObject({ user_id: me.userId, keep_auth: false, source: "app", storage_prefix: `${org.id}/${me.id}/`, done_at: null });
    // Sessions coupées, nom et téléphone effacés du compte (supprimé ensuite par la file)
    expect((await sql(`select count(*)::int as n from auth.sessions where user_id = $1`, [me.userId]))[0].n).toBe(0);
    expect((await sql(`select full_name, phone from public.users where id = $1`, [me.userId]))[0]).toEqual({ full_name: null, phone: null });
    expect((await sql(`select raw_user_meta_data from auth.users where id = $1`, [me.userId]))[0].raw_user_meta_data).not.toHaveProperty("full_name");

    // Fiche anonyme, détachée du compte, candidature close
    const [row] = await sql(
      `select first_name, last_name, phone, email, user_id, application_status, status, vehicle_id, deleted_at is not null as deleted
         from public.drivers where id = $1`,
      [me.id],
    );
    expect(row).toEqual({
      first_name: "Chauffeur", last_name: "supprimé", phone: "", email: null, user_id: null, application_status: null,
      status: "inactive", vehicle_id: null, deleted: true,
    });

    // Véhicule d'inscription utilisé par une course : anonymisé, désactivé, audit caviardé
    const [veh] = await sql(`select plate, brand, model, color, is_active from public.vehicles where id = $1`, [me.vehicleId]);
    expect(veh).toMatchObject({ brand: null, model: "Véhicule supprimé", color: null, is_active: false });
    expect(veh.plate).toMatch(/^SUPPR-/);
    expect((await rideState(ride.id)).ride.vehicle_id).toBe(me.vehicleId);
    const vehAudit = await sql(`select metadata from public.audit_logs where entity_type = 'vehicles' and entity_id = $1`, [me.vehicleId]);
    expect(vehAudit.length).toBeGreaterThan(0);
    expect(vehAudit.every((a) => a.metadata.redacted === true)).toBe(true);

    // Conservé sans identité : règlement, courses, journal, alerte, signalement de fraude (motif), empreintes
    expect((await sql(`select driver_label from public.ride_settlements where id = $1`, [settlement.id]))[0].driver_label).toBe(alias);
    const events = await sql(`select type, message, data from public.ride_events where ride_id = $1 order by id`, [ride.id]);
    expect(events.find((e) => e.type === "offer.accepted")?.message).toBe(`${alias} accepte`);
    expect(events.find((e) => e.type === "settlement.due")?.message).toContain(`due par ${alias}`);
    const [ex] = await sql(`select message, data from public.ride_events where ride_id = $1 and type = 'dispatch.excluded'`, [van.id]);
    expect(ex.data.excluded.find((x: Row) => x.driver_id === me.id).name).toBe(alias);
    expect(ex.data.excluded.find((x: Row) => x.driver_id === mate.id).name).toBe("Paulin T.");
    expect(ex.message).toContain(alias);
    expect(ex.message).toContain("Paulin T.");
    const [a] = await sql(`select message, data from public.ride_alerts where ride_id = $1 and kind = 'no_gps'`, [late.id]);
    expect(a.message).toContain(alias);
    expect(a.data).not.toHaveProperty("driver_name");
    expect(a.data).not.toHaveProperty("lat");
    expect((await sql(`select message from public.ride_events where ride_id = $1 and type = 'ride.reassigned'`, [late.id]))[0].message).toContain(alias);
    const [f] = await sql(`select driver_label, reason, identities from public.fraud_reports where id = $1`, [fraud.id]);
    // Motif conservé (lutte contre la fraude), sans son nom : signalement, identités, fiche
    expect(f).toMatchObject({ driver_label: alias, reason: `Commission jamais payée par ${alias}` });
    expect((await sql(`select ban_reason from public.drivers where id = $1`, [me.id]))[0].ban_reason).toBe(`Commission jamais payée par ${alias}`);
    expect((await sql(`select distinct reason from public.banned_identities where driver_id = $1`, [me.id])).map((b) => b.reason)).toEqual([
      `Commission jamais payée par ${alias}`,
    ]);
    // Bannissement : empreintes (hachages) conservées, indices en clair effacés partout
    const bans = await sql(`select hint, value_hash from public.banned_identities where driver_id = $1`, [me.id]);
    expect(bans.length).toBeGreaterThan(3);
    expect(bans.every((b) => b.hint === null && /^[0-9a-f]{64}$/.test(b.value_hash))).toBe(true);
    expect(f.identities.length).toBeGreaterThan(3);
    expect(f.identities.every((i: Row) => !("hint" in i) && /^[0-9a-f]{64}$/.test(i.hash))).toBe(true);
    const [liftAudit] = await sql(`select metadata from public.audit_logs where action = 'identity_ban.lifted' and entity_id = $1`, [phoneBan.id]);
    expect(liftAudit.metadata).toEqual({ kind: "phone", reason: `Numéro de ${alias} réattribué` });
    // Journal d'audit : IP et navigateur du chauffeur retirés (inscription, son compte) ; ceux du propriétaire, qui a
    // agi sur la fiche, conservés (valeurs caviardées)
    const network = await sql(
      `select id::text, host(ip) as ip, user_agent, metadata from public.audit_logs where id = any ($1::bigint[]) order by id`,
      [[signupAudit, ownerAudit, selfAudit]],
    );
    expect(network).toEqual([
      { id: String(signupAudit), ip: null, user_agent: null, metadata: { redacted: true } },
      { id: String(ownerAudit), ip: "198.51.100.20", user_agent: "Mozilla/5.0 (Macintosh)", metadata: { redacted: true } },
      { id: String(selfAudit), ip: null, user_agent: null, metadata: {} },
    ]);

    // Supprimé : signalements (événements, notification du collègue, vote), messages, appareils, positions…
    expect((await sql(`select count(*)::int as n from public.ride_events where organization_id = $1 and type like 'fleet.report%'`, [org.id]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from public.notifications where driver_id = $1 and type = 'fleet_report'`, [mate.id]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from public.chat_report_votes where message_id = $1`, [report.m.id]))[0].n).toBe(0);
    for (const t of ["driver_documents", "driver_devices", "driver_locations", "driver_location_history", "push_tokens", "chat_messages", "notifications"]) {
      const [c] = await sql(`select count(*)::int as n from public.${t} where driver_id = $1`, [me.id]);
      expect(c.n, t).toBe(0);
    }
    // Le collègue garde son nom (aucun remplacement hors de ses lignes à lui)
    expect((await sql(`select first_name from public.drivers where id = $1`, [mate.id]))[0].first_name).toBe("Paulin");

    // La file supprime ensuite le compte de connexion (route web / worker) : plus aucune trace nulle part
    await sql(`delete from auth.users where id = $1`, [me.userId]);
    expect(await findTraces(needles)).toEqual([]);

    // Bannissement : empreintes et signalement conservés 3 ans après la suppression, puis effacés (worker)
    await sql(`select private.purge_deleted_driver_bans()`);
    expect((await sql(`select count(*)::int as n from public.banned_identities where driver_id = $1`, [me.id]))[0].n).toBeGreaterThan(3);
    await sql(`select private.purge_deleted_driver_bans(interval '0 seconds')`);
    expect((await sql(`select count(*)::int as n from public.banned_identities where driver_id = $1`, [me.id]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from public.fraud_reports where id = $1`, [fraud.id]))[0].n).toBe(0);
    expect((await sql(`select banned_at, ban_reason from public.drivers where id = $1`, [me.id]))[0]).toEqual({ banned_at: null, ban_reason: null });
  });

  it("motif du nom : limites de mot, homonyme complet (autre numéro) épargné, forme stricte sans prénom seul ni initiale", async () => {
    const scrub = async (strict: boolean, text: string) =>
      (await sql(`select regexp_replace($2, private.driver_name_pattern('Mohamed', 'Dupont', 7, $1), '[X]', 'g') as r`, [strict, text]))[0].r;
    expect(await scrub(false, "Mohamed Dupont (#7) · Mohamed (#7) · Mohamed Dupont (#2) · Mohamed (#2) · Mohamed D. · Mohamed accepte · Mohamedou · Jean-Mohamed")).toBe(
      "[X] · [X] · Mohamed Dupont (#2) · Mohamed (#2) · [X] · [X] accepte · Mohamedou · Jean-Mohamed",
    );
    // Motif saisi sur SON événement : son prénom remplacé, les homonymes cités avec leur numéro épargnés
    expect(
      await scrub(false, "Course retirée à Mohamed Dupont (#7) par la centrale : Mohamed ne répond pas, confiée à Mohamed Dupont (#2) puis Mohamed ben Ali (#3)"),
    ).toBe("Course retirée à [X] par la centrale : [X] ne répond pas, confiée à Mohamed Dupont (#2) puis Mohamed ben Ali (#3)");
    expect(await scrub(false, "Mohamed remplacé par Karim (#3) · Mohamed, Karim (#3)")).toBe("[X] remplacé par Karim (#3) · [X], Karim (#3)");
    expect(await scrub(true, "Mohamed Dupont (#7) · Mohamed (#7) · Mohamed Dupont · Mohamed Dupont (#2) · Mme Mohamed · Mohamed D. · Client : Mohamed Haddad")).toBe(
      "[X] · [X] · [X] · Mohamed Dupont (#2) · Mme Mohamed · Mohamed D. · Client : Mohamed Haddad",
    );
    // Prénom inconnu : pas de motif (parties structurelles seulement)
    expect((await sql(`select private.driver_name_pattern(null, 'Dupont', 7, false) as p`))[0].p).toBeNull();
  });

  it("homonyme : seules les lignes du chauffeur supprimé sont réécrites", async () => {
    const org = await createOrg("Suppression homonyme");
    const first = cap(`n${letters(6)}`);
    const me = await createDriver(org, { firstName: first, at: north(CHAMPS_ELYSEES, 600) });
    const twin = await createDriver(org, { firstName: first, at: north(CHAMPS_ELYSEES, 650) });
    const alias = `Chauffeur supprimé (#${me.number})`;
    const ride = await createRideAsOwner(org);
    const offers = (await rideState(ride.id)).offers;
    const mine = offers.find((o) => o.driver_id === me.id);
    const his = offers.find((o) => o.driver_id === twin.id);
    expect(mine && his).toBeTruthy();
    expect((await rpc(me.userId, "decline_ride_offer", [mine.id])).ok).toBe(true);
    expect((await rpc(twin.userId, "accept_ride_offer", [his.id])).code).toBe("ACCEPTED");

    expect((await svcDelete(me.userId)).code).toBe("DELETED");
    const events = await sql(`select type, message from public.ride_events where ride_id = $1 order by id`, [ride.id]);
    expect(events.find((e) => e.type === "offer.declined")?.message).toBe(`${alias} refuse la course`);
    expect(events.find((e) => e.type === "offer.accepted")?.message).toBe(`${first} accepte`);
  });

  it("homonyme (centrale, courses partagées) : règlement, alerte gardée, retrait et « non sollicités » de l'autre intacts ; commentaire de la course conservé", async () => {
    const org = await centrale("Suppression homonyme centrale");
    const first = cap(`m${letters(6)}`);
    // Même prénom, même initiale du nom : « Prénom B. » pour les deux dans les « non sollicités »
    const me = await applicant(org, { approve: true, first, last: cap(`b${letters(7)}`) });
    const twin = await applicant(org, { approve: true, first, last: cap(`b${letters(7)}`) });
    const alias = `Chauffeur supprimé (#${me.number})`;
    const twinFull = `${first} ${twin.last} (#${twin.number})`;
    const online = async () => {
      for (const [d, m] of [[me, 500], [twin, 650]] as const) {
        await sql(`update public.drivers set presence = 'available' where id = $1`, [d.id]);
        await setLocation(org, d.id, north(CHAMPS_ELYSEES, m));
      }
    };
    const pendingOffer = async (rideId: string, driverId: string) => {
      const offer = (await rideState(rideId)).offers.find((o) => o.driver_id === driverId && o.status === "pending");
      expect(offer, "offre en attente").toBeTruthy();
      return offer.id as string;
    };
    const events = (rideId: string) => sql(`select id, type, message, data from public.ride_events where ride_id = $1 order by id`, [rideId]);

    // 1) Sa course : commentaire saisi à la réservation, le client porte son prénom
    await online();
    const comment = `Client : ${first} Haddad, appeler ${first} à l'arrivée`;
    const mine = await createRideAsOwner(org, { vehicle_category: "standard", price_cents: 5900, commission_cents: 1400, payment_method: "cash", comment });
    await acceptAndComplete(me.userId, me.id, mine.id);

    // 2) Course partagée : il refuse, l'homonyme accepte et la termine (commission due par l'homonyme)
    await online();
    const shared = await createRideAsOwner(org, { vehicle_category: "standard", price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
    expect((await rpc(me.userId, "decline_ride_offer", [await pendingOffer(shared.id, me.id)])).ok).toBe(true);
    await acceptAndComplete(twin.userId, twin.id, shared.id);

    // 3) Course partagée : il refuse, l'homonyme accepte ; GPS muet → alerte gardée par la centrale, puis retrait
    await online();
    const late = await createRideAsOwner(org, { vehicle_category: "standard", price_cents: 4000 });
    expect((await rpc(me.userId, "decline_ride_offer", [await pendingOffer(late.id, me.id)])).ok).toBe(true);
    expect((await rpc(twin.userId, "accept_ride_offer", [await pendingOffer(late.id, twin.id)])).code).toBe("ACCEPTED");
    await setLocation(org, twin.id, north(CHAMPS_ELYSEES, 650), 600);
    await sql(`select private.watch_rides()`);
    const [alert] = await sql(`select id from public.ride_alerts where ride_id = $1 and kind = 'no_gps'`, [late.id]);
    expect(alert, "alerte GPS de l'homonyme").toBeTruthy();
    expect((await rpc(org.ownerId, "acknowledge_ride_alert", [alert.id])).code).toBe("ACKNOWLEDGED");
    expect((await rpc(org.ownerId, "reassign_ride", [late.id, `${first} ne répond pas`, twin.id])).ok).toBe(true);

    // 4) « Non sollicités » : les deux, lui en premier (plus proche)
    await online();
    const van = await createRideAsOwner(org, { vehicle_category: "van", price_cents: 9000 });
    await sql(`select private.explain_no_driver($1)`, [van.id]);

    const sharedBefore = await events(shared.id);
    const lateBefore = await events(late.id);
    const [excludedBefore] = (await events(van.id)).filter((e) => e.type === "dispatch.excluded");
    const initial = `${first} ${me.last.charAt(0)}.`;
    expect(excludedBefore.data.excluded.map((x: Row) => [x.driver_id, x.name])).toEqual([[me.id, initial], [twin.id, initial]]);
    expect(sharedBefore.find((e) => e.type === "settlement.due")?.message).toContain(`due par ${twinFull}`);
    const [alertBefore] = await sql(`select message, data from public.ride_alerts where id = $1`, [alert.id]);
    expect(alertBefore.message).toContain(first);

    expect((await svcDelete(me.userId)).code).toBe("DELETED");

    // Sa course : son nom remplacé dans ses événements, commentaire de la centrale inchangé
    const mineAfter = await events(mine.id);
    expect(mineAfter.find((e) => e.type === "offer.accepted")?.message).toBe(`${alias} accepte`);
    expect(mineAfter.find((e) => e.type === "settlement.due")?.message).toContain(`due par ${alias}`);
    expect((await sql(`select comment from public.rides where id = $1`, [mine.id]))[0].comment).toBe(comment);

    // Courses partagées : seule SA réponse change ; règlement, acceptation, alerte, « gardée », retrait de l'homonyme intacts
    for (const [before, after] of [[sharedBefore, await events(shared.id)], [lateBefore, await events(late.id)]]) {
      expect(after.length).toBe(before.length);
      after.forEach((e, i) => {
        if (e.type === "offer.declined" && e.data.driver_id === me.id) expect(e.message).toBe(`${alias} refuse la course`);
        else expect(e, e.type).toEqual(before[i]);
      });
    }
    const lateAfter = await events(late.id);
    expect(lateAfter.find((e) => e.type === "alert.kept")?.message).toContain(`la centrale garde ${first} `);
    expect(lateAfter.find((e) => e.type === "ride.reassigned")?.message).toContain(`Course retirée à ${twinFull} par la centrale : ${first} ne répond pas`);
    expect(await sql(`select message, data from public.ride_alerts where id = $1`, [alert.id])).toEqual([alertBefore]);

    // « Non sollicités » : son élément et son extrait seulement, l'homonyme de même initiale garde son nom
    const [excluded] = (await events(van.id)).filter((e) => e.type === "dispatch.excluded");
    expect(excluded.data.excluded.map((x: Row) => [x.driver_id, x.name])).toEqual([[me.id, alias], [twin.id, initial]]);
    expect(excluded.message).toBe(excludedBefore.message.replace(`— ${initial}`, `— ${alias}`));
    expect(excluded.message.split(initial).length - 1).toBe(1);
  });
});

describe("Suppression du compte chauffeur — fiche, candidature, file", () => {
  it("candidature supprimée : close, validation et refus impossibles, réactivation refusée, véhicule supprimé", async () => {
    const org = await centrale("Suppression candidature");
    const cand = await applicant(org);
    const r = await svcDelete(cand.userId);
    expect(r).toMatchObject({ ok: true, code: "DELETED", vehicle: "deleted", keep_auth: false });

    const [row] = await sql(`select application_status, application_message, status, user_id from public.drivers where id = $1`, [cand.id]);
    expect(row).toEqual({ application_status: null, application_message: null, status: "inactive", user_id: null });
    // Plus listée (candidatures en attente de la centrale)
    const [overview] = await as({ sub: org.ownerId }, (q) =>
      q(`select count(*)::int as n from public.drivers where organization_id = $1 and application_status = 'pending'`, [org.id]),
    );
    expect(overview.n).toBe(0);

    expect(await rpc(org.ownerId, "approve_driver_application", [cand.id, "trusted"])).toMatchObject({ ok: false, code: "DRIVER_DELETED" });
    expect(await rpc(org.ownerId, "reject_driver_application", [cand.id, "Non"])).toMatchObject({ ok: false, code: "DRIVER_DELETED" });
    // Ni réactivation, ni suspension (une fiche suspendue compterait dans l'offre), ni nouvelles coordonnées (même par
    // le propriétaire, colonnes qu'il peut modifier)…
    for (const set of [
      "status = 'active'", "status = 'invited'", "status = 'suspended'", "first_name = 'Karim'", "phone = '0611223344'", "email = 'k@example.test'",
      "trust_level = 'trusted'", "suspended_reason = 'Réactivation prévue'",
    ]) {
      const err = await expectPgError(as({ sub: org.ownerId }, (q) => q(`update public.drivers set ${set} where id = $1`, [cand.id])));
      expect(err.code, set).toBe("42501");
      expect(err.message).toMatch(/DRIVER_DELETED/);
    }
    // … ni candidature rouverte, ni rattachement à un compte ou à un véhicule, ni « dé-suppression » (même en accès direct)
    const other = await createAuthUser(`${letters(8)}@example.test`, "Autre");
    const [fleetVehicle] = await sql(`insert into public.vehicles (organization_id, model, plate) values ($1, 'Classe E', $2) returning id`, [org.id, uniquePlate()]);
    for (const [set, args] of [
      ["application_status = 'pending'", []],
      ["user_id = $2", [other]],
      ["vehicle_id = $2", [fleetVehicle.id]],
      ["deleted_at = null", []],
      ["presence = 'available'", []],
      ["banned_at = now()", []],
      ["application_note = 'Rappeler'", []],
    ] as const) {
      const err = await expectPgError(sql(`update public.drivers set ${set} where id = $1`, [cand.id, ...args]));
      expect(err.code, set).toBe("42501");
      expect(err.message).toMatch(/DRIVER_DELETED/);
    }
    // … ni nouveau justificatif (numéro de pièce rattaché à la fiche anonyme), même ajouté par la centrale
    const docErr = await expectPgError(
      as({ sub: org.ownerId }, (q) =>
        q(`insert into public.driver_documents (organization_id, driver_id, type, file_path, number, status) values ($1, $2, 'vtc_card', $3, 'EVTC000000001', 'valid')`, [
          org.id, cand.id, `${org.id}/${cand.id}/vtc_card-2.jpg`,
        ]),
      ),
    );
    expect(docErr.code).toBe("42501");
    expect(docErr.message).toMatch(/DRIVER_DELETED/);
    // Restent possibles : les effacements (notes vidées, statut « inactif », hors ligne) ; rien d'autre
    await as({ sub: org.ownerId }, (q) => q(`update public.drivers set notes = null, status = 'inactive' where id = $1`, [cand.id]));
    await sql(`update public.drivers set presence = 'offline', online_since = null, current_ride_id = null where id = $1`, [cand.id]);

    // Véhicule personnel jamais utilisé : supprimé, audit caviardé
    expect((await sql(`select count(*)::int as n from public.vehicles where id = $1`, [cand.vehicleId]))[0].n).toBe(0);
    const audits = await sql(`select metadata from public.audit_logs where entity_type = 'vehicles' and entity_id = $1`, [cand.vehicleId]);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain(cand.plate);

    // Rejouée (réponse perdue, nouvel appui) : même état, sans nouvelle suppression
    expect(await svcDelete(cand.userId)).toMatchObject({ ok: true, code: "DELETED", already_deleted: true, driver_id: cand.id, pending: true });
    const [{ n }] = await sql(`select count(*)::int as n from public.audit_logs where entity_id = $1 and action = 'driver.deleted'`, [cand.id]);
    expect(n).toBe(1);
  });

  it("fiche supprimée : ni confiance, ni bannissement ou levée par la centrale, ni course ; la plateforme traite les empreintes sans toucher la fiche", async () => {
    const org = await centrale("Suppression bannissement");
    const sa = await createAuthUser(`sa-${letters(8)}@example.test`, "Super Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [sa]);
    // Banni pour fraude et signalé au super admin, puis compte supprimé ; un autre, jamais banni, supprimé aussi
    const banned = await applicant(org, { approve: true });
    const ban = await rpc(org.ownerId, "ban_driver", [banned.id, "Faux paiements répétés", "fraud", true, false]);
    expect(ban.code).toBe("BANNED");
    expect((await svcDelete(banned.userId)).code).toBe("DELETED");
    const quiet = await applicant(org, { approve: true });
    expect((await svcDelete(quiet.userId)).code).toBe("DELETED");
    const snapshot = async (id: string) => (await sql(`select to_jsonb(d) - 'updated_at' as j from public.drivers d where id = $1`, [id]))[0].j as Row;
    const before = { banned: await snapshot(banned.id), quiet: await snapshot(quiet.id) };
    const orgBans = async () =>
      (await sql(`select count(*)::int as n from public.banned_identities where driver_id = $1 and scope = 'org' and lifted_at is null`, [banned.id]))[0].n;
    const activeBans = await orgBans();
    expect(activeBans).toBeGreaterThanOrEqual(3);

    // Centrale : ni niveau de confiance, ni bannissement, ni levée (tout est annulé : ni empreinte, ni signalement)
    for (const attempt of [
      () => as({ sub: org.ownerId }, (q) => q(`update public.drivers set trust_level = 'new' where id = $1`, [banned.id])),
      () => rpc(org.ownerId, "ban_driver", [quiet.id, "Motif sans objet", "fraud", true, false]),
      () => rpc(org.ownerId, "lift_driver_ban", [banned.id, "Erreur de saisie"]),
    ]) {
      const err = await expectPgError(attempt());
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/DRIVER_DELETED/);
    }
    expect((await sql(`select count(*)::int as n from public.banned_identities where driver_id = $1`, [quiet.id]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from public.fraud_reports where driver_id = $1`, [quiet.id]))[0].n).toBe(0);
    expect(await orgBans()).toBe(activeBans);

    // Attribution d'une course : refusée (fiche « inactive » pour toujours), course inchangée
    const ride = await createRideAsOwner(org, { vehicle_category: "standard" });
    expect(await rpc(org.ownerId, "assign_ride", [ride.id, quiet.id])).toMatchObject({ ok: false, code: "DRIVER_INACTIVE" });
    expect((await sql(`select driver_id from public.rides where id = $1`, [ride.id]))[0].driver_id).toBeNull();

    // Plateforme : les empreintes du signalement sont bannies puis levées ; la fiche anonyme ne bouge pas.
    // Acteur revérifié : un membre de centrale n'est pas le super admin.
    const [report] = await sql(`select id from public.fraud_reports where driver_id = $1`, [banned.id]);
    expect((await expectPgError(svc("svc_platform_ban", [report.id, org.ownerId, null]))).code).toBe("42501");
    const platform = await svc("svc_platform_ban", [report.id, sa, "Confirmé"]);
    expect(platform).toMatchObject({ ok: true, code: "PLATFORM_BANNED", drivers: 0 });
    expect(platform.identities).toBeGreaterThanOrEqual(3);
    expect(await snapshot(banned.id)).toEqual(before.banned);
    const lifted = await svc("svc_platform_unban", [report.id, sa, "Erreur d'identité"]);
    expect(lifted).toMatchObject({ ok: true, code: "LIFTED", identities: platform.identities });
    expect(await snapshot(banned.id)).toEqual(before.banned);
    expect(await snapshot(quiet.id)).toEqual(before.quiet);

    // Seul le système efface encore : purge des bannissements des comptes supprimés depuis 3 ans
    await sql(`select private.purge_deleted_driver_bans(interval '0 seconds')`);
    const [after] = await sql(`select banned_at, ban_reason, ban_scope, suspended_reason from public.drivers where id = $1`, [banned.id]);
    expect(after).toEqual({ banned_at: null, ban_reason: null, ban_scope: null, suspended_reason: before.banned.suspended_reason });
    expect((await sql(`select count(*)::int as n from public.banned_identities where driver_id = $1`, [banned.id]))[0].n).toBe(0);
  });

  it("rattrapage des fiches supprimées par 003500 : file alimentée, compte détaché, nom retrouvé et retiré des traces", async () => {
    const org = await centrale("Suppression rattrapage");
    const me = await applicant(org, { approve: true });
    const alias = `Chauffeur supprimé (#${me.number})`;
    await sql(`update public.drivers set presence = 'available' where id = $1`, [me.id]);
    await setLocation(org, me.id, NEAR);
    const ride = await createRideAsOwner(org, { vehicle_category: "standard", price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
    await acceptAndComplete(me.userId, me.id, ride.id);
    // Suppression telle que la faisait 003500 : fiche anonymisée, mais compte encore rattaché et traces nominatives
    await sql(
      `update public.drivers set first_name = 'Chauffeur', last_name = 'supprimé', phone = '', email = null, status = 'inactive',
         presence = 'offline', vehicle_id = null, deleted_at = now() where id = $1`,
      [me.id],
    );
    expect((await sql(`select message from public.ride_events where ride_id = $1 and type = 'offer.accepted'`, [ride.id]))[0].message).toBe(`${me.first} accepte`);

    // (d'autres fiches supprimées « à l'ancienne » par d'autres fichiers de test peuvent être rattrapées aussi)
    const [{ n: repaired }] = await sql(`select private.repair_deleted_drivers() as n`);
    expect(repaired).toBeGreaterThanOrEqual(1);
    expect((await sql(`select user_id, application_status from public.drivers where id = $1`, [me.id]))[0]).toEqual({ user_id: null, application_status: null });
    const [q] = await sql(`select user_id, keep_auth, source, auth_done_at, storage_prefix from private.account_deletions where driver_id = $1`, [me.id]);
    expect(q).toMatchObject({ user_id: me.userId, keep_auth: false, source: "repair", auth_done_at: null, storage_prefix: `${org.id}/${me.id}/` });
    expect((await sql(`select driver_label from public.ride_settlements where ride_id = $1`, [ride.id]))[0].driver_label).toBe(alias);
    expect((await sql(`select message from public.ride_events where ride_id = $1 and type = 'offer.accepted'`, [ride.id]))[0].message).toBe(`${alias} accepte`);
    expect((await sql(`select full_name, phone from public.users where id = $1`, [me.userId]))[0]).toEqual({ full_name: null, phone: null });
    expect((await sql(`select raw_user_meta_data from auth.users where id = $1`, [me.userId]))[0].raw_user_meta_data).not.toHaveProperty("full_name");
    // Idempotent
    expect(await sql(`select private.repair_deleted_drivers() as n`)).toEqual([{ n: 0 }]);
  });

  it("rattrapage (flotte) : fiche sans règlement, compte Auth déjà supprimé : nom retrouvé dans le journal et retiré", async () => {
    const org = await createOrg("Suppression rattrapage flotte");
    const first = cap(`z${letters(7)}`);
    const last = cap(`w${letters(7)}`);
    const zed = await createDriver(org, { firstName: first, at: NEAR, presence: "offline" });
    await sql(`update public.drivers set last_name = $2 where id = $1`, [zed.id, last]);
    const alias = `Chauffeur supprimé (#${zed.number})`;
    // « Prénom (#N) est en ligne », « Prénom accepte »
    await as({ sub: zed.userId }, (q) => q(`select public.driver_set_online(true)`));
    await setLocation(org, zed.id, NEAR);
    const ride = await createRideAsOwner(org);
    await acceptAndComplete(zed.userId, zed.id, ride.id);
    // « Course attribuée manuellement à Prénom Nom (#N) »
    const manual = await createRideAsOwner(org);
    expect((await rpc(org.ownerId, "assign_ride", [manual.id, zed.id])).code).toBe("ASSIGNED");
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      expect((await rpc(zed.userId, "driver_update_ride_status", [manual.id, s])).ok, s).toBe(true);
    }
    // « Prénom N. » des non sollicités
    const van = await createRideAsOwner(org, { vehicle_category: "van" });
    await sql(`select private.explain_no_driver($1)`, [van.id]);

    // Suppression telle que la faisait 003500 (fiche anonymisée, données supprimées), puis compte Auth supprimé
    // par la route : drivers.user_id → null, plus aucune source du nom hors du journal des courses
    for (const t of ["notifications", "driver_locations", "driver_devices", "push_tokens"]) await sql(`delete from public.${t} where driver_id = $1`, [zed.id]);
    await sql(
      `update public.drivers set first_name = 'Chauffeur', last_name = 'supprimé', phone = '', email = null, status = 'inactive',
         presence = 'offline', vehicle_id = null, deleted_at = now() where id = $1`,
      [zed.id],
    );
    await sql(`delete from auth.users where id = $1`, [zed.userId]);
    expect((await sql(`select user_id from public.drivers where id = $1`, [zed.id]))[0].user_id).toBeNull();
    expect((await findTraces([first, last])).length).toBeGreaterThan(3);

    await sql(`select private.repair_deleted_drivers()`);
    expect(await findTraces([first, last])).toEqual([]);
    const messages = await sql(`select type, message from public.ride_events where ride_id = any ($1::uuid[]) order by id`, [[ride.id, manual.id]]);
    expect(messages.find((e) => e.type === "offer.accepted")?.message).toBe(`${alias} accepte`);
    expect(messages.find((e) => e.type === "ride.assigned_manually")?.message).toBe(`Course attribuée manuellement à ${alias}`);
    expect((await sql(`select message from public.ride_events where type = 'driver.online' and data ->> 'driver_id' = $1`, [zed.id]))[0].message).toBe(`${alias} est en ligne`);
    // Plus de compte à supprimer : seule la purge du dossier de stockage reste
    const [q] = await sql(`select user_id, auth_done_at is not null as auth_done, source from private.account_deletions where driver_id = $1`, [zed.id]);
    expect(q).toEqual({ user_id: null, auth_done: true, source: "repair" });
  });

  it("refusée tant qu'une course est attribuée", async () => {
    const org = await createOrg("Suppression en course");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers[0];
    const [acc] = await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offer.id]));
    expect(acc.r.code).toBe("ACCEPTED");
    const r = await svcDelete(d.userId);
    expect(r).toMatchObject({ ok: false, code: "RIDES_ASSIGNED", count: 1 });
    expect(r.message).toContain("terminez-la");
    // Deux courses attribuées : pluriel, dans l'application comme dans l'outil super admin
    await insertRideBypass(org, { status: "ACCEPTED", driver_id: d.id, pickup_at: inMinutes(120) });
    const two = await svcDelete(d.userId);
    expect(two).toMatchObject({ ok: false, code: "RIDES_ASSIGNED", count: 2 });
    expect(two.message).toBe("Vous avez 2 courses attribuées : terminez-les ou demandez à votre centrale de les réattribuer, puis supprimez votre compte.");
    const admin = await createAuthUser(`admin-${letters(6)}@example.test`, "Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [admin]);
    expect(await svc("svc_admin_delete_driver", [d.id, admin])).toMatchObject({
      ok: false, code: "RIDES_ASSIGNED", message: "2 courses attribuées à ce chauffeur : la centrale doit d'abord les terminer ou les réattribuer.",
    });
    const [row] = await sql("select deleted_at, user_id from public.drivers where id = $1", [d.id]);
    expect(row).toEqual({ deleted_at: null, user_id: d.userId });
    expect((await sql(`select count(*)::int as n from private.account_deletions where driver_id = $1`, [d.id]))[0].n).toBe(0);
  });

  it("membre de centrale : seul le profil chauffeur est supprimé, compte et sessions de gestion conservés", async () => {
    const org = await createOrg("Suppression gérant");
    const [vehicle] = await sql(`insert into public.vehicles (organization_id, model, plate) values ($1, 'Classe E', $2) returning id`, [org.id, uniquePlate()]);
    const [d] = await sql(
      `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id)
       values ($1, $2, 'Gérant', 'Roulant', $3, 'active', 'offline', $4) returning id, number`,
      [org.id, org.ownerId, uniquePhone(), vehicle.id],
    );
    await sql(`insert into auth.sessions (user_id) values ($1)`, [org.ownerId]);
    const [before] = await sql(`select full_name from public.users where id = $1`, [org.ownerId]);

    const r = await svcDelete(org.ownerId);
    expect(r).toMatchObject({ ok: true, code: "DELETED", keep_auth: true, auth_done: true, user_id: org.ownerId });
    expect((await sql(`select count(*)::int as n from auth.sessions where user_id = $1`, [org.ownerId]))[0].n).toBe(1);
    expect((await sql(`select full_name from public.users where id = $1`, [org.ownerId]))[0].full_name).toBe(before.full_name);
    expect((await sql(`select user_id from public.drivers where id = $1`, [d.id]))[0].user_id).toBeNull();
    // Véhicule de la flotte (créé au tableau de bord) : détaché seulement
    expect((await sql(`select model from public.vehicles where id = $1`, [vehicle.id]))[0].model).toBe("Classe E");
    // Rejouée par le même compte : état de la file (plus de fiche rattachée)
    expect(await svcDelete(org.ownerId)).toMatchObject({ ok: true, code: "DELETED", already_deleted: true, keep_auth: true });
    // Peut redevenir chauffeur plus tard (plus de fiche rattachée à son compte)
    expect((await sql(`select count(*)::int as n from public.drivers where user_id = $1`, [org.ownerId]))[0].n).toBe(0);
  });

  it("ancien membre désactivé, simple invité, ou d'une centrale archivée : pas de compte de gestion utile, compte de connexion supprimé", async () => {
    const org = await createOrg("Suppression ancien membre");
    const disabled = await createMember(org, "dispatcher", "Ancien Régulateur");
    await sql(`update public.organization_users set status = 'disabled' where organization_id = $1 and user_id = $2`, [org.id, disabled]);
    const archived = await createOrg("Suppression centrale archivée");
    const formerAdmin = await createMember(archived, "admin", "Ancien Administrateur");
    await sql(`update public.organizations set status = 'archived' where id = $1`, [archived.id]);
    const admin = await createAuthUser(`admin-${letters(6)}@example.test`, "Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [admin]);

    for (const userId of [disabled, formerAdmin]) {
      await sql(`update public.users set phone = $2 where id = $1`, [userId, uniquePhone()]);
      const [d] = await sql(
        `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence)
         values ($1, $2, 'Ancien', 'Membre', $3, 'active', 'offline') returning id`,
        [org.id, userId, uniquePhone()],
      );
      const [{ email }] = await sql(`select email from auth.users where id = $1`, [userId]);
      expect((await rpc(admin, "admin_find_drivers", [email]))[0]).toMatchObject({ id: d.id, has_account: true, keep_auth: false });
      expect(await svcDelete(userId)).toMatchObject({ ok: true, code: "DELETED", keep_auth: false, auth_done: false, user_id: userId });
      expect((await sql(`select full_name, phone from public.users where id = $1`, [userId]))[0]).toEqual({ full_name: null, phone: null });
    }
    // Simple invitation en attente (aucun accès, 20260924004700) : compte non conservé (20260924005400 ; un membre
    // actif garde le sien : test « membre de centrale »)
    const invited = await createMember(org, "dispatcher", "Nouveau Régulateur");
    await sql(`update public.organization_users set status = 'invited' where organization_id = $1 and user_id = $2`, [org.id, invited]);
    await sql(`insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence) values ($1, $2, 'Nouveau', 'Membre', $3, 'active', 'offline')`, [
      org.id, invited, uniquePhone(),
    ]);
    expect(await svcDelete(invited)).toMatchObject({ ok: true, code: "DELETED", keep_auth: false, auth_done: false, user_id: invited });
  });

  it("file : avancement, nouvel essai espacé, abandon après 10 essais, relance par le super admin", async () => {
    const org = await createOrg("Suppression file");
    const d = await createDriver(org);
    const r = await svcDelete(d.userId);
    const id = r.deletion_id as string;
    // Traitée aussitôt par la route : le worker ne la voit pas encore
    expect(await sql(`select id from private.claim_account_deletions(100) where id = $1`, [id])).toEqual([]);

    const step = await svc("svc_account_deletion_progress", [id, true, false, "GoTrue indisponible"]);
    expect(step).toMatchObject({ ok: true, storage_done: true, auth_done: false, done: false, attempts: 1, last_error: "GoTrue indisponible" });
    const [{ wait }] = await sql(`select round(extract(epoch from next_attempt_at - now()) / 60) as wait from private.account_deletions where id = $1`, [id]);
    expect(Number(wait)).toBe(5);

    // Échéance passée : reprise par le worker (bail : pas deux fois de suite)
    await sql(`update private.account_deletions set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
    expect((await sql(`select id, user_id, storage_prefix from private.claim_account_deletions(100) where id = $1`, [id]))[0]).toMatchObject({ user_id: d.userId });
    expect(await sql(`select id from private.claim_account_deletions(100) where id = $1`, [id])).toEqual([]);

    // Échecs répétés : abandon au 10e essai, alerte critique dans le journal d'audit
    for (let i = 0; i < 9; i++) await sql(`select private.complete_account_deletion($1, false, false, 'Erreur réseau')`, [id]);
    const [abandoned] = await sql(`select private.account_deletion_json(q) as j from private.account_deletions q where id = $1`, [id]);
    expect(abandoned.j).toMatchObject({ attempts: 10, abandoned: true, done: false });
    await sql(`update private.account_deletions set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
    expect(await sql(`select id from private.claim_account_deletions(100) where id = $1`, [id])).toEqual([]);
    expect((await sql(`select count(*)::int as n from public.audit_logs where action = 'driver.deletion_failed' and entity_id = $1`, [d.id]))[0].n).toBe(1);

    // Super admin : liste (échecs en tête, sans identifiant de compte) puis « Réessayer »
    const admin = await createAuthUser(`admin-${letters(6)}@example.test`, "Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [admin]);
    const list = await rpc(admin, "admin_account_deletions", [100]);
    expect(list.failed).toBeGreaterThanOrEqual(1);
    const item = list.items.find((x: Row) => x.deletion_id === id);
    expect(item).toMatchObject({ status: "failed", has_account: true, organization: { id: org.id } });
    expect(item).not.toHaveProperty("user_id");
    expect((await expectPgError(rpc(org.ownerId, "admin_account_deletions", [100]))).code).toBe("42501");

    expect((await svc("svc_account_deletion_retry", [id, org.ownerId]).catch((e) => e)).code).toBe("42501");
    expect(await svc("svc_account_deletion_retry", [id, admin])).toMatchObject({ ok: true, attempts: 0, pending: true });
    expect(await svc("svc_account_deletion_progress", [id, false, true, null])).toMatchObject({ done: true, storage_done: true, auth_done: true, last_error: null });
    expect(await svc("svc_account_deletion_retry", [id, admin])).toMatchObject({ ok: false, code: "NOT_PENDING" });
  });

  it("super admin : recherche par e-mail ou téléphone (toutes centrales), suppression tracée", async () => {
    const org = await centrale("Suppression par e-mail");
    const cand = await applicant(org, { approve: true });
    const admin = await createAuthUser(`admin-${letters(6)}@example.test`, "Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [admin]);

    const byEmail = await rpc(admin, "admin_find_drivers", [cand.email.toUpperCase()]);
    expect(byEmail).toHaveLength(1);
    expect(byEmail[0]).toMatchObject({ id: cand.id, has_account: true, keep_auth: false, rides_assigned: 0, organization: { id: org.id } });
    const byPhone = await rpc(admin, "admin_find_drivers", [`+33 ${cand.phone.slice(1)}`]);
    expect(byPhone.map((x: Row) => x.id)).toEqual([cand.id]);
    expect(await rpc(admin, "admin_find_drivers", ["ab"])).toEqual([]);
    expect((await expectPgError(rpc(org.ownerId, "admin_find_drivers", [cand.email]))).code).toBe("42501");

    expect((await expectPgError(svc("svc_admin_delete_driver", [cand.id, org.ownerId]))).code).toBe("42501");
    const r = await svc("svc_admin_delete_driver", [cand.id, admin]);
    expect(r).toMatchObject({ ok: true, code: "DELETED", source: "admin", user_id: cand.userId });
    const [log] = await sql(`select actor_type, actor_user_id, metadata from public.audit_logs where entity_id = $1 and action = 'driver.deleted'`, [cand.id]);
    expect(log).toMatchObject({ actor_type: "super_admin", actor_user_id: admin, metadata: { source: "admin" } });
    expect((await sql(`select message from public.ride_events where type = 'driver.deleted' and data ->> 'driver_id' = $1`, [cand.id]))[0].message).toContain("traité par Rydar Drive");
    // Plus trouvable (identité effacée), rejouée : sans effet
    expect(await rpc(admin, "admin_find_drivers", [cand.email])).toEqual([]);
    expect(await svc("svc_admin_delete_driver", [cand.id, admin])).toMatchObject({ ok: true, already_deleted: true });
  });

  it("compte bloqué : mot de passe vérifié côté serveur (empreinte bcrypt), chauffeur non supprimé seulement", async () => {
    const org = await createOrg("Suppression mot de passe");
    const d = await createDriver(org);
    const [{ email }] = await sql(`select email from auth.users where id = $1`, [d.userId]);
    await sql(`update auth.users set encrypted_password = extensions.crypt('Secret-2026', extensions.gen_salt('bf', 4)) where id = $1`, [d.userId]);

    const check = async (e: string, p: string) => (await as({ role: "service_role" }, (q) => q(`select public.svc_driver_password_check($1, $2) as r`, [e, p])))[0].r;
    expect(await check(email.toUpperCase(), "Secret-2026")).toBe(d.userId);
    expect(await check(email, "secret-2026")).toBeNull();
    expect(await check(`x${email}`, "Secret-2026")).toBeNull();
    // Préfixe $2b$ (autres outils) : même algorithme
    await sql(`update auth.users set encrypted_password = '$2b$' || substr(extensions.crypt('Autre-2026', extensions.gen_salt('bf', 4)), 5) where id = $1`, [d.userId]);
    expect(await check(email, "Autre-2026")).toBe(d.userId);
    // Compte qui n'est pas chauffeur : jamais
    await sql(`update auth.users set encrypted_password = extensions.crypt('Owner-2026', extensions.gen_salt('bf', 4)) where id = $1`, [org.ownerId]);
    const [{ email: ownerEmail }] = await sql(`select email from auth.users where id = $1`, [org.ownerId]);
    expect(await check(ownerEmail, "Owner-2026")).toBeNull();
    // Réservée au service
    await expect(as({ sub: d.userId }, (q) => q(`select public.svc_driver_password_check($1, 'x')`, [email]))).rejects.toThrow(/permission denied/);
    // Après la suppression : plus de fiche rattachée
    await svcDelete(d.userId);
    expect(await check(email, "Autre-2026")).toBeNull();
  });

  it("réservée au service : ni un chauffeur ni un membre ne peuvent l'appeler directement ; compte sans fiche : NOT_DRIVER", async () => {
    const org = await createOrg("Suppression droits");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    for (const call of [
      `select public.svc_delete_driver_account('${d.userId}')`,
      `select public.svc_admin_delete_driver('${d.id}', '${org.ownerId}')`,
      `select public.svc_account_deletion_progress(gen_random_uuid(), true, true, null)`,
      `select public.svc_account_deletion_retry(gen_random_uuid(), '${org.ownerId}')`,
    ]) {
      await expect(as({ sub: d.userId }, (q) => q(call)), call).rejects.toThrow(/permission denied/);
      await expect(as({ sub: org.ownerId }, (q) => q(call)), call).rejects.toThrow(/permission denied/);
    }
    await expect(as({ sub: org.ownerId }, (q) => q(`select * from private.account_deletions`))).rejects.toThrow(/permission denied/);
    expect(await svcDelete(org.ownerId)).toMatchObject({ ok: false, code: "NOT_DRIVER" });
    expect(await svcDelete(randomUUID())).toMatchObject({ ok: false, code: "NOT_DRIVER" });
    // Fonctions private sans security definer (CLAUDE.md) : appelées par les RPC svc_* (definer), le worker ou la
    // migration ; seul le déclencheur des sessions (auth.sessions) reste definer
    const definer = await sql(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.prosecdef and p.proname = any ($1::text[]) order by 1`,
      [[
        "scrub_driver_traces", "scrub_excluded_message", "keeps_login_account", "redact_driver_audit", "delete_driver_account",
        "complete_account_deletion", "claim_account_deletions", "repair_deleted_drivers", "purge_deleted_driver_bans",
        "drivers_deleted_guard", "driver_documents_deleted_guard", "revoke_sessions_on_access_change",
      ]],
    );
    expect(definer.map((r) => r.proname)).toEqual(["revoke_sessions_on_access_change"]);
  });
});
