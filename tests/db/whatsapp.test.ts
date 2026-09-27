import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, CHAMPS_ELYSEES, createAuthUser, createMember, createOrg, createRideAsOwner, expectPgError, insertRideBypass, north, pool, sql, type Org } from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils (mêmes conventions que centrale.test.ts)
// -----------------------------------------------------------------------------
type CDriver = { id: string; userId: string; phone: string };
const NEAR = north(CHAMPS_ELYSEES, 500);
const TOKEN = "EAAGtest-token-0123456789abcdef";

async function centrale(name: string, settings: Record<string, unknown> = {}) {
  const org = await createOrg(name, { settings: { settlement_link: "https://revolut.me/centrale/{montant}", settlement_methods: "{link,cash}", ...settings } });
  await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_fixed_cents = 500 where id = $1`, [org.id]);
  return org;
}

async function driverIn(org: Org, phone = `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`): Promise<CDriver> {
  const userId = await createAuthUser(`chauffeur-${randomUUID().slice(0, 8)}@test.dev`, "Chauffeur");
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, `WA-${randomUUID().slice(0, 6)}`.toUpperCase()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id, trust_level)
     values ($1, $2, 'Mohamed', 'Test', $3, 'active', 'available', $4, 'trusted') returning id`,
    [org.id, userId, phone, v.id],
  );
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at) values ($1, $2, $3, $4, now(), now())`,
    [d.id, org.id, NEAR[0], NEAR[1]],
  );
  return { id: d.id, userId, phone };
}

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};

async function acceptAndComplete(d: CDriver, rideId: string) {
  const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, d.id]);
  expect(offer, "offre en attente").toBeTruthy();
  expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
    expect((await rpc(d.userId, "driver_update_ride_status", [rideId, s])).ok).toBe(true);
  }
}

/** Course 59 € espèces : 19 € dus par le chauffeur (14 € de commission + 5 € de frais). */
async function owes19(org: Org, d: CDriver) {
  const ride = await createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash" });
  await acceptAndComplete(d, ride.id);
  return ride;
}

const connect = (org: Org, actor = org.ownerId, over: { enabled?: boolean; token?: string | null } = {}) =>
  svc("svc_whatsapp_save", [org.id, actor, "106540352242922", over.token === undefined ? TOKEN : over.token, "+33 1 84 60 12 12", "NovaLink", "rappel_commission", "fr", over.enabled ?? true]);

const reminders = (driverId: string) =>
  sql(`select channel::text, type, title, data from public.notifications where driver_id = $1 and type = 'settlement_reminder' order by created_at, channel`, [driverId]);

async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}

// -----------------------------------------------------------------------------
describe("WhatsApp : numéro au format international", () => {
  it("06… → 336… ; +33, 0033, espaces et points acceptés ; numéro inexploitable → null", async () => {
    const [r] = await sql(`select private.wa_phone('06 12 34 56 78') a, private.wa_phone('+33 6.12.34.56.78') b, private.wa_phone('0033612345678') c,
      private.wa_phone('0470 12 34 56', 'BE') d, private.wa_phone('12') e, private.wa_phone(null) f, private.wa_mask('33612345678') g`);
    expect(r).toEqual({ a: "33612345678", b: "33612345678", c: "33612345678", d: "32470123456", e: null, f: null, g: "+33 6 •• •• •• 78" });
  });
});

describe("WhatsApp : relances centrale → chauffeur", () => {
  it("canal application par défaut ; WhatsApp demandé mais non relié → application, raison indiquée", async () => {
    const org = await centrale("WA Défaut");
    const d = await driverIn(org);
    await owes19(org, d);

    const res = await rpc(org.ownerId, "remind_driver_settlements", [d.id]);
    expect(res).toMatchObject({ ok: true, code: "REMINDED", channels: ["app"], whatsapp_error: null, message: "Rappel envoyé par l'application." });

    await sql(`update public.ride_settlements set last_reminded_at = null where driver_id = $1`, [d.id]);
    const forced = await rpc(org.ownerId, "remind_driver_settlements", [d.id, ["whatsapp"]]);
    expect(forced).toMatchObject({ channels: ["app"], whatsapp_error: "NOT_CONFIGURED" });
    expect(forced.message).toBe("Rappel envoyé par l'application (WhatsApp non configuré).");
    expect((await reminders(d.id)).map((n) => n.channel)).toEqual(["push", "push"]);

    const bad = await rpc(org.ownerId, "remind_driver_settlements", [d.id, ["sms"]]);
    expect(bad.code).toBe("INVALID_CHANNELS");
  });

  it("WhatsApp seul : message modèle avec variables, repli par l'application si Meta refuse définitivement", async () => {
    const org = await centrale("NovaLink", { reminder_channels: "{whatsapp}" });
    const d = await driverIn(org, "06 12 34 56 78");
    await owes19(org, d);
    expect((await connect(org)).code).toBe("SAVED");

    const res = await rpc(org.ownerId, "remind_driver_settlements", [d.id]);
    expect(res).toMatchObject({ channels: ["whatsapp"], message: "Rappel envoyé par WhatsApp." });
    const [wa] = await reminders(d.id);
    expect(wa.channel).toBe("whatsapp");
    expect(wa.data).toMatchObject({ sender: "org", to: "33612345678", params: ["Mohamed", "19 €", "NovaLink", "1 course"] });
    expect(wa.data.fallback).toMatchObject({ type: "settlement_reminder", title: "RAPPEL COMMISSION" });

    // Le worker réserve le message avec les identifiants de la centrale (jeton : service role seulement)
    const [claimed] = await sql(`select * from private.claim_whatsapp(10) where organization_id = $1`, [org.id]);
    expect(claimed).toMatchObject({ sender: "org", phone_number_id: "106540352242922", access_token: TOKEN, template: "rappel_commission", language: "fr" });
    // Les pushes ne prennent jamais un message WhatsApp
    expect((await sql(`select id from private.claim_notifications(500) where id = $1`, [claimed.id]))).toHaveLength(0);

    // Numéro sans WhatsApp : échec définitif → push de repli, erreur visible dans les réglages
    const done = await sql(`select private.complete_whatsapp($1, false, 'Message non remis (code 131026)', null, false) as r`, [claimed.id]);
    expect(done[0].r).toMatchObject({ status: "failed", fallback: true });
    const all = await reminders(d.id);
    expect(all.map((n) => n.channel)).toEqual(["whatsapp", "push"]);
    expect(all.find((n) => n.channel === "push")!.title).toBe("RAPPEL COMMISSION");
    const [cfg] = await sql(`select last_error, last_error_at, sent_count from public.org_whatsapp where organization_id = $1`, [org.id]);
    expect(cfg).toMatchObject({ last_error: "Message non remis (code 131026)", sent_count: 0 });
    expect(cfg.last_error_at).toBeTruthy();
    const [ev] = await sql(`select message from public.ride_events where organization_id = $1 and type = 'whatsapp.failed'`, [org.id]);
    expect(ev.message).toContain("relance envoyée par l'application");
  });

  it("les deux canaux : push + WhatsApp (sans repli) ; succès compté ; erreur temporaire reprise", async () => {
    const org = await centrale("WA Les Deux", { reminder_channels: "{app,whatsapp}" });
    const d = await driverIn(org);
    await owes19(org, d);
    await connect(org);
    expect((await rpc(org.ownerId, "remind_driver_settlements", [d.id])).message).toBe("Rappel envoyé par WhatsApp et l'application.");
    const rows = await reminders(d.id);
    expect(rows.map((n) => n.channel)).toEqual(["push", "whatsapp"]);
    expect(rows[1]!.data.fallback).toBeNull();

    const [claimed] = await sql(`select id from private.claim_whatsapp(10) where organization_id = $1`, [org.id]);
    // Erreur temporaire (limite de débit) : remis en file
    await sql(`select private.complete_whatsapp($1, false, 'Limite de débit atteinte (code 130429)', null, true)`, [claimed.id]);
    const [queued] = await sql(`select status::text, attempts from public.notifications where id = $1`, [claimed.id]);
    expect(queued).toEqual({ status: "queued", attempts: 1 });
    await sql(`update public.notifications set scheduled_for = now() where id = $1`, [claimed.id]);
    const [again] = await sql(`select id from private.claim_whatsapp(10) where organization_id = $1`, [org.id]);
    expect(again.id).toBe(claimed.id);
    await sql(`select private.complete_whatsapp($1, true, null, 'wamid.1', false)`, [claimed.id]);
    const [cfg] = await sql(`select sent_count, last_sent_at from public.org_whatsapp where organization_id = $1`, [org.id]);
    expect(cfg.sent_count).toBe(1);
    expect(cfg.last_sent_at).toBeTruthy();
  });

  it("relance automatique du worker par WhatsApp ; numéro invalide → application", async () => {
    const org = await centrale("WA Auto", { reminder_channels: "{whatsapp}" });
    const ok = await driverIn(org);
    const invalid = await driverIn(org, "12");
    await owes19(org, ok);
    await owes19(org, invalid);
    await connect(org);
    await sql(`update public.ride_settlements set due_at = now() - interval '2 hours' where organization_id = $1`, [org.id]);
    const [{ r }] = await sql(`select private.settlement_reminders() as r`);
    expect(r.whatsapp).toBeGreaterThanOrEqual(1);
    expect((await reminders(ok.id)).map((n) => [n.channel, n.title])).toEqual([["whatsapp", "COMMISSION EN RETARD"]]);
    expect((await reminders(invalid.id)).map((n) => n.channel)).toEqual(["push"]);
  });

  it("droits : jeton jamais lisible, configuration réservée aux owner / admin, déconnexion → application", async () => {
    const org = await centrale("WA Droits", { reminder_channels: "{app,whatsapp}" });
    const dispatcher = await createMember(org, "dispatcher");
    const admin = await createMember(org, "admin");
    expect((await expectPgError(connect(org, dispatcher))).code).toBe("42501");
    expect((await connect(org, admin)).code).toBe("SAVED");
    // Sans jeton : conservé
    expect((await connect(org, admin, { token: null, enabled: false })).code).toBe("SAVED");
    const [sec] = await sql(`select access_token from public.org_whatsapp_secrets where organization_id = $1`, [org.id]);
    expect(sec.access_token).toBe(TOKEN);

    expect(await as({ sub: org.ownerId }, (q) => q(`select phone_number_id, enabled from public.org_whatsapp`))).toEqual([{ phone_number_id: "106540352242922", enabled: false }]);
    expect(await as({ sub: dispatcher }, (q) => q(`select 1 from public.org_whatsapp`))).toHaveLength(0);
    expect((await expectPgError(as({ sub: org.ownerId }, (q) => q(`select access_token from public.org_whatsapp_secrets`)))).code).toBe("42501");
    expect((await expectPgError(as({ sub: org.ownerId }, (q) => q(`update public.org_whatsapp set enabled = true`)))).code).toBe("42501");
    expect((await expectPgError(as({ sub: org.ownerId }, (q) => q(`select * from private.claim_whatsapp(1)`)))).code).toBe("42501");

    expect((await svc("svc_whatsapp_remove", [org.id, org.ownerId])).code).toBe("REMOVED");
    const [s] = await sql(`select reminder_channels from public.organization_settings where organization_id = $1`, [org.id]);
    expect(s.reminder_channels).toEqual(["app"]);
    expect(await sql(`select 1 from public.org_whatsapp_secrets where organization_id = $1`, [org.id])).toHaveLength(0);
    const [log] = await sql(`select metadata from public.audit_logs where organization_id = $1 and action = 'whatsapp.configured' order by id limit 1`, [org.id]);
    expect(JSON.stringify(log.metadata)).not.toContain(TOKEN);

    // Helpers private sans security definer (CLAUDE.md, 20260924004200) : appelés par des RPC definer ou le worker
    const definer = await sql(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.prosecdef and p.proname = any ($1::text[])`,
      [["whatsapp_ready", "queue_whatsapp", "remind_driver", "platform_whatsapp_target", "claim_whatsapp", "complete_whatsapp"]],
    );
    expect(definer).toEqual([]);
  });
});

describe("WhatsApp : relance Rydar → propriétaire de la centrale", () => {
  it("refusée sans numéro Rydar (relance non consommée), puis envoyée au propriétaire", async () => {
    const sa = await superAdmin();
    await sql(`delete from public.platform_whatsapp_secrets`);
    await sql(`delete from public.platform_whatsapp`);
    const org = await centrale("WA Plateforme");
    await insertRideBypass(org, { completed_at: new Date() });

    const refused = await svc("svc_platform_remind", [org.id, sa, null, true]);
    expect(refused.code).toBe("WHATSAPP_NOT_CONFIGURED");
    const [o] = await sql(`select platform_reminded_at from public.organizations where id = $1`, [org.id]);
    expect(o.platform_reminded_at).toBeNull();

    expect((await svc("svc_whatsapp_save", [null, sa, "200000000000001", TOKEN, "+33 1 00 00 00 00", "Rydar Drive", "rappel_frais_plateforme", "fr", true])).code).toBe("SAVED");
    // Propriétaire sans téléphone, centrale sans téléphone
    expect((await svc("svc_platform_remind", [org.id, sa, null, true])).code).toBe("NO_PHONE");
    expect((await as({ sub: sa }, (q) => q(`select public.admin_platform_whatsapp($1) as r`, [org.id])))[0].r).toMatchObject({ ready: true, reason: "NO_PHONE" });

    await sql(`update public.users set phone = '07 11 22 33 44' where id = $1`, [org.ownerId]);
    const target = (await as({ sub: sa }, (q) => q(`select public.admin_platform_whatsapp($1) as r`, [org.id])))[0].r;
    expect(target).toMatchObject({ ready: true, reason: null, source: "owner", to_display: "+33 7 •• •• •• 44" });
    expect((await expectPgError(as({ sub: org.ownerId }, (q) => q(`select public.admin_platform_whatsapp($1)`, [org.id])))).code).toBe("42501");

    const res = await svc("svc_platform_remind", [org.id, sa, "Merci", true]);
    expect(res).toMatchObject({ ok: true, whatsapp: true });
    const [n] = await sql(`select channel::text, type, user_id, data from public.notifications where organization_id = $1 and type = 'platform_fee_reminder'`, [org.id]);
    expect(n).toMatchObject({ channel: "whatsapp", user_id: org.ownerId });
    expect(n.data).toMatchObject({ sender: "platform", to: "33711223344", fallback: null });
    expect(n.data.params[0]).toBe("WA Plateforme");
    const [claimed] = await sql(`select sender, phone_number_id, access_token, template from private.claim_whatsapp(50) where organization_id = $1`, [org.id]);
    expect(claimed).toEqual({ sender: "platform", phone_number_id: "200000000000001", access_token: TOKEN, template: "rappel_frais_plateforme" });
    const [log] = await sql(`select metadata from public.audit_logs where organization_id = $1 and action = 'platform_fee.reminded' order by id desc limit 1`, [org.id]);
    expect(log.metadata).toMatchObject({ whatsapp: true, whatsapp_to: "+33 7 •• •• •• 44" });
  });
});

describe("Moyens de paiement de la centrale (lien, virement, espèces, autre)", () => {
  it("seuls les moyens renseignés sont proposés ; RIB renvoyé au chauffeur ; « autre moyen » accepté", async () => {
    const org = await centrale("NovaLink Paiements", { settlement_methods: "{link,transfer,cash,other}", settlement_link: null });
    const d = await driverIn(org);
    await owes19(org, d);
    let mine = await rpc(d.userId, "driver_settlements");
    // Lien non saisi, pas d'IBAN, pas d'instructions : espèces seulement
    expect(mine.pay.methods).toEqual(["cash"]);
    expect(mine.pay.bank).toBeNull();
    expect((await rpc(d.userId, "driver_declare_payment", [mine.pay.settlement_ids, "transfer", null])).code).toBe("INVALID_METHOD");

    await as({ sub: org.ownerId }, (q) =>
      q(`update public.organization_settings set settlement_link = 'https://paypal.me/novalink/{montant}EUR', settlement_iban = 'FR7630006000011234567890189',
           settlement_bic = 'AGRIFRPP', settlement_payee_name = 'NovaLink SAS', settlement_instructions = 'Wero au 06 12 34 56 78'
         where organization_id = $1`, [org.id]),
    );
    mine = await rpc(d.userId, "driver_settlements");
    expect(mine.pay.methods).toEqual(["link", "transfer", "cash", "other"]);
    expect(mine.pay.bank).toEqual({ payee_name: "NovaLink SAS", iban: "FR7630006000011234567890189", bic: "AGRIFRPP" });
    const res = await rpc(d.userId, "driver_declare_payment", [mine.pay.settlement_ids, "other", "Wero envoyé"]);
    expect(res.code).toBe("DECLARED");
    const [s] = await sql(`select declared_method from public.ride_settlements where driver_id = $1`, [d.id]);
    expect(s.declared_method).toBe("other");

    const badIban = await expectPgError(sql(`update public.organization_settings set settlement_iban = 'FR76 1234' where organization_id = $1`, [org.id]));
    expect(badIban.code).toBe("23514");
  });
});
