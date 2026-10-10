// Flotte Privée (migrations 20260924007600 et 20260924007700, docs/FLOTTE-PRIVEE.md § 13.1) : schéma et droits,
// création atomique par le super admin, limites imposées malgré l'offre et la surcharge, gardes (une fiche, celle du
// propriétaire ; lien fermé ; ni réseau, ni centrale ; un seul accès), suppression puis recréation de la fiche,
// bascule sur place sans perte (vers flotte, vers centrale, retour ; offre de service choisie à la sortie écrite dans la
// même transaction ; aucune offre de course fermée avant son échéance),
// écritures concurrentes d'une entrée en cours (gardes sous le verrou de l'organisation), exemption de règlement du
// gérant en centrale.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PRIVATE_FLEET_BLOCKERS, PRIVATE_FLEET_DISPATCH_PROFILE, PRIVATE_FLEET_LIMITS, STANDARD_DISPATCH_PROFILE,
} from "../../packages/shared/src/private-fleet";
import {
  as, asFresh, createApiRide, createAuthUser, createDriver, createMember, createOrg, createPrivateFleet, enableNetwork,
  expectPgError, inMinutes, networkTermsVersion, pool, setSharedNetwork, sql, superAdmin, unlimitedPlan, type Org,
  type PgError,
} from "./helpers";

type Row = Record<string, any>;

const VERSION = "2026-10-02";
const APP = "https://app.rydar.test";
const NOTE = "Demande écrite du client (e-mail du 09/10/2026)";
const uid = () => randomUUID().slice(0, 8);
const uniquePhone = () => `+336${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const uniquePlate = () => `PF-${randomUUID().slice(0, 3)}-${randomUUID().slice(0, 2)}`.toUpperCase();

const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};
/** RPC d'un membre au jeton récent (adhésion activée) ou d'un chauffeur. */
const fresh = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await asFresh(sub, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Row;
};

/** Paramètres de svc_platform_create_private_fleet (comme l'action du super admin). */
function createArgs(
  actor: string,
  owner: string,
  o: {
    slug?: string; plan?: string | null; percent?: number; fixed?: number; contract?: string;
    org?: Record<string, unknown>; driver?: Record<string, unknown>; vehicle?: Record<string, unknown>;
  } = {},
) {
  const slug = o.slug ?? `pf-${uid()}`;
  return [
    actor, owner,
    JSON.stringify({
      name: "VTC Karim", slug, email: `contact@${slug}.test`, phone: "+33612345678", city: "Paris", legal_name: "VTC Karim EI",
      siret: "123 456 789 00012", vtc_registration: "EVTC075230001", ...o.org,
    }),
    JSON.stringify({ first_name: "Karim", last_name: "Gérant", phone: uniquePhone(), vtc_card_number: "T075-2026", ...o.driver }),
    JSON.stringify({
      brand: "Mercedes", model: "Classe E", color: "Noir", plate: uniquePlate(), category: "business", seats: 4, luggage_capacity: 3,
      ...o.vehicle,
    }),
    o.plan === undefined ? null : o.plan, o.percent ?? 0, o.fixed ?? 0, o.contract ?? "CP-2026-014", VERSION, null, APP,
  ];
}
const create = (args: unknown[]) => svc("svc_platform_create_private_fleet", args);

/** Bascule (comme l'action du super admin). `plan` fourni (null = sans offre) : offre écrite par la RPC à la sortie. */
const setPrivate = (
  orgId: string,
  actor: string,
  enabled: boolean,
  note: string | null,
  o: { model?: string; percent?: number; fixed?: number; mode?: string; effectiveOn?: string; legalOn?: string; plan?: string | null } = {},
) =>
  svc("svc_platform_set_private_fleet", [
    orgId, actor, enabled, note, o.model ?? null, o.percent ?? null, o.fixed ?? null, o.mode ?? "notice", o.effectiveOn ?? null,
    VERSION, o.legalOn ?? null, APP, o.plan !== undefined, o.plan ?? null,
  ]);

const settings = async (orgId: string) =>
  (await sql(
    `select auto_dispatch, instant_threshold_minutes, scheduled_dispatch_lead_minutes, offer_timeout_seconds, dispatch_radii_m,
            dispatch_retry_radii_m, allow_category_upgrade
       from public.organization_settings where organization_id = $1`,
    [orgId],
  ))[0];
const limits = async (orgId: string) => (await sql("select private.org_limits($1) as l", [orgId]))[0].l as Row;
const orgRow = async (orgId: string) =>
  (await sql("select private_fleet, dispatch_model, join_enabled, join_auto_approve from public.organizations where id = $1", [orgId]))[0];

/** Fiche chauffeur sur le compte du propriétaire d'une organisation standard (compte partagé, gérant qui roule). */
async function ownerFiche(org: Org) {
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, uniquePlate()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, vehicle_id)
     values ($1, $2, 'Gérant', 'Propriétaire', $3, 'active', $4) returning id`,
    [org.id, org.ownerId, uniquePhone(), v.id],
  );
  return d.id as string;
}

/** Candidature en attente (comme svc_driver_apply, inscrite directement). */
async function candidate(org: Org) {
  const user = await createAuthUser(`candidat-${uid()}@test.dev`, "Candidat");
  await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, application_status, applied_at, joined_via, trust_level)
     values ($1, $2, 'Samir', 'Candidat', $3, 'inactive', 'pending', now(), 'join_link', 'new')`,
    [org.id, user, uniquePhone()],
  );
}

const pendingOffer = async (rideId: string, driverId: string) =>
  (await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, driverId]))[0]?.id as string;
const rideRow = async (rideId: string) => (await sql("select * from public.rides where id = $1", [rideId]))[0] as Row;
const offerRow = async (offerId: string) => (await sql("select * from public.ride_offers where id = $1", [offerId]))[0] as Row;
const tick = () => sql("select private.dispatch_tick()");
/** Prochain passage du dispatch atteint (fin de la vague ou de l'offre en cours), puis passage. */
async function passNow(rideId: string) {
  await sql("update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1", [rideId]);
  await tick();
}
/** Rappels « à confirmer » en file d'une organisation. */
const queuedReminders = (orgId: string) =>
  sql("select id from public.notifications where organization_id = $1 and status = 'queued' and data ->> 'kind' = 'private_reminder'", [orgId]);

/** Course acceptée puis menée jusqu'au bout par le chauffeur (compte userId). */
async function acceptAndComplete(userId: string, rideId: string, driverId: string) {
  const accepted = await fresh(userId, "accept_ride_offer", [await pendingOffer(rideId, driverId)]);
  expect(accepted.code, JSON.stringify(accepted)).toBe("ACCEPTED");
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
    const r = await fresh(userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

beforeAll(async () => {
  await setSharedNetwork(true);
});

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

// -----------------------------------------------------------------------------
describe("schéma et droits", () => {
  it("drapeau faux par défaut ; lu par le propriétaire (grant par colonne) ; jamais écrit hors des RPC du super admin", async () => {
    const std = await createOrg("PF Standard");
    expect((await orgRow(std.id)).private_fleet).toBe(false);
    const pf = await createPrivateFleet("Schéma");
    const rows = await asFresh(pf.ownerId, (q) =>
      q("select id, name, private_fleet, dispatch_model, join_enabled from public.organizations where id = $1", [pf.id]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ private_fleet: true, dispatch_model: "fleet", join_enabled: false });

    // Aucun grant d'écriture sur la colonne
    const own = await expectPgError(asFresh(pf.ownerId, (q) => q("update public.organizations set private_fleet = false where id = $1", [pf.id])));
    expect(own.code).toBe("42501");
    // Service role sans le marqueur des RPC : verrou (mise à jour et création)
    for (const [orgId, value] of [[pf.id, false], [std.id, true]] as const) {
      const e = await expectPgError(as({ role: "service_role" }, (q) => q("update public.organizations set private_fleet = $2 where id = $1", [orgId, value])));
      expect(e.message).toMatch(/^PRIVATE_FLEET_LOCKED/);
      expect(e.code).toBe("42501");
    }
    const inserted = await expectPgError(as({ role: "service_role" }, (q) =>
      q("insert into public.organizations (name, slug, private_fleet) values ('Pirate', $1, true)", [`pf-pirate-${uid()}`])));
    expect(inserted.message).toMatch(/^PRIVATE_FLEET_LOCKED/);
    // Le marqueur posé n'ouvre ni la centrale ni le lien d'inscription
    const model = await expectPgError(as({ role: "service_role" }, async (q) => {
      await q("select set_config('rydar.private_fleet_change', $1, true)", [pf.id]);
      await q("update public.organizations set dispatch_model = 'centrale' where id = $1", [pf.id]);
    }));
    expect(model.message).toMatch(/^PRIVATE_FLEET_MODEL/);
    expect(model.code).toBe("55000");
    const join = await expectPgError(as({ role: "service_role" }, (q) => q("update public.organizations set join_enabled = true where id = $1", [pf.id])));
    expect(join.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    expect(await orgRow(pf.id)).toMatchObject({ private_fleet: true, dispatch_model: "fleet", join_enabled: false });
  });

  it("contrainte, dernier rempart (déclencheurs désactivés) : modèle flotte et lien fermé ; index de l'agenda", async () => {
    const pf = await createPrivateFleet("Contrainte");
    const client = await pool.connect();
    try {
      for (const set of ["join_enabled = true", "dispatch_model = 'centrale'"]) {
        await client.query("begin");
        await client.query("set local session_replication_role = replica");
        const e = await expectPgError(client.query(`update public.organizations set ${set} where id = $1`, [pf.id]));
        expect(e.code).toBe("23514");
        expect(e.message).toContain("organizations_private_fleet_check");
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
    expect(await sql("select 1 from pg_indexes where schemaname = 'public' and indexname = 'rides_driver_pickup_idx'")).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
describe("création (svc_platform_create_private_fleet)", () => {
  it("tout en une fois : organisation, propriétaire activé, fiche du gérant sur le même compte, profil, frais initiaux, audit", async () => {
    const actor = await superAdmin();
    const owner = await createAuthUser(`pf-owner-${uid()}@test.dev`, "Karim Gérant");
    const slug = `pf-create-${uid()}`;
    const plan = await unlimitedPlan();
    const res = await create(createArgs(actor, owner, { slug, plan, percent: 2, fixed: 50 }));
    expect(res).toMatchObject({ ok: true, code: "CREATED", fees: { ok: true, code: "APPLIED" } });
    const orgId = res.organization_id as string;

    const [org] = await sql(
      `select private_fleet, dispatch_model, join_enabled, plan_id, created_by, city, legal_name, siret, vtc_registration,
              platform_fee_percent::float8 as pct, platform_fee_fixed_cents as fixed
         from public.organizations where id = $1`,
      [orgId],
    );
    expect(org).toMatchObject({
      private_fleet: true, dispatch_model: "fleet", join_enabled: false, plan_id: plan, created_by: actor, city: "Paris",
      legal_name: "VTC Karim EI", siret: "12345678900012", vtc_registration: "EVTC075230001", pct: 2, fixed: 50,
    });
    const members = await sql("select user_id, role, status, invited_by, activated_at from public.organization_users where organization_id = $1", [orgId]);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ user_id: owner, role: "owner", status: "active", invited_by: actor });
    expect(members[0].activated_at).not.toBeNull();

    const drivers = await sql(
      `select d.id, d.user_id, d.owner_driver, d.trust_level, d.status, d.joined_via, d.created_by, d.email, v.category, v.seats, v.luggage_capacity
         from public.drivers d join public.vehicles v on v.id = d.vehicle_id where d.organization_id = $1`,
      [orgId],
    );
    expect(drivers).toEqual([
      expect.objectContaining({
        id: res.driver_id, user_id: owner, owner_driver: true, trust_level: "trusted", status: "active", joined_via: "dashboard",
        created_by: actor, category: "business", seats: 4, luggage_capacity: 3,
      }),
    ]);
    const [account] = await sql("select email from public.users where id = $1", [owner]);
    expect(drivers[0].email).toBe(account.email);

    expect(await settings(orgId)).toEqual({ ...PRIVATE_FLEET_DISPATCH_PROFILE });
    expect(await limits(orgId)).toMatchObject({ ...PRIVATE_FLEET_LIMITS, api_access: true });
    const [change] = await sql("select mode, status, to_percent::float8 as pct, to_fixed_cents from public.platform_fee_changes where organization_id = $1", [orgId]);
    expect(change).toEqual({ mode: "initial", status: "applied", pct: 2, to_fixed_cents: 50 });
    const mails = await sql("select kind, to_email from public.email_outbox where organization_id = $1", [orgId]);
    expect(mails).toEqual([{ kind: "platform_fee_change", to_email: account.email }]);
    const [audit] = await sql(
      "select actor_type, actor_user_id, metadata from public.audit_logs where organization_id = $1 and action = 'organization.private_fleet_created'",
      [orgId],
    );
    expect(audit).toMatchObject({
      actor_type: "super_admin", actor_user_id: actor,
      metadata: { owner, driver_id: res.driver_id, plan_id: plan, percent: 2, fixed_cents: 50, contract_ref: "CP-2026-014" },
    });
    // Aucun abonnement créé (facturation à décider) ; mini-site désactivé comme toute organisation
    expect(await sql("select 1 from public.subscriptions where organization_id = $1", [orgId])).toHaveLength(0);
    expect((await sql("select enabled from public.booking_sites where organization_id = $1", [orgId]))[0].enabled).toBe(false);
  });

  it("refus avant toute écriture : acteur, soi-même, compte déjà chauffeur ou pas neuf, offre sans API, slug, contrat, saisie", async () => {
    const actor = await superAdmin();
    const owner = await createAuthUser(`pf-owner-${uid()}@test.dev`, "Karim");
    expect((await expectPgError(create(createArgs(owner, owner)))).code).toBe("42501");
    expect(await create(createArgs(actor, actor))).toMatchObject({ ok: false, code: "SELF_NOT_ALLOWED", field: "ownerEmail" });
    expect(await create(createArgs(actor, await superAdmin()))).toMatchObject({ ok: false, code: "SELF_NOT_ALLOWED" });

    const std = await createOrg("PF Autre Organisation");
    const driver = await createDriver(std);
    expect(await create(createArgs(actor, driver.userId))).toMatchObject({ ok: false, code: "ALREADY_REGISTERED", field: "ownerEmail" });
    const member = await createMember(std, "dispatcher");
    expect(await create(createArgs(actor, member))).toMatchObject({ ok: false, code: "OWNER_NOT_NEW", field: "ownerEmail" });
    const old = await createAuthUser(`pf-old-${uid()}@test.dev`, "Ancien compte");
    await sql("update public.users set created_at = now() - interval '2 hours' where id = $1", [old]);
    expect(await create(createArgs(actor, old))).toMatchObject({ ok: false, code: "OWNER_NOT_NEW" });

    const code = () => `pf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const [noApi] = await sql(`insert into public.plans (code, name, limits, is_public) values ($1, 'Sans API', '{"api_access": false}', false) returning id`, [code()]);
    const [inactive] = await sql(`insert into public.plans (code, name, limits, is_active) values ($1, 'Inactive', '{"api_access": true}', false) returning id`, [code()]);
    const [noKey] = await sql(`insert into public.plans (code, name, limits) values ($1, 'Sans clé', '{"max_drivers": 1}') returning id`, [code()]);
    for (const plan of [noApi.id, inactive.id, noKey.id]) {
      expect(await create(createArgs(actor, owner, { plan }))).toMatchObject({ ok: false, code: "PRIVATE_FLEET_PLAN_INVALID", field: "planId" });
    }
    expect(await create(createArgs(actor, owner, { slug: std.slug }))).toMatchObject({ ok: false, code: "SLUG_TAKEN", field: "slug" });
    for (const slug of ["eligibilite", "rydar-paris", "admin"]) {
      expect(await create(createArgs(actor, owner, { slug }))).toMatchObject({ ok: false, code: "SUBDOMAIN_RESERVED", field: "slug" });
    }
    expect(await create(createArgs(actor, owner, { slug: "Pas Valide" }))).toMatchObject({ ok: false, code: "INVALID", field: "slug" });
    // Ville obligatoire (§ 8.1) : absente, vide, blanche ou trop longue
    for (const city of [null, "", "   ", "x".repeat(81)]) {
      expect(await create(createArgs(actor, owner, { org: { city } })), String(city)).toMatchObject({ ok: false, code: "INVALID", field: "city" });
    }
    for (const contract of ["", "   ", "ab"]) {
      expect(await create(createArgs(actor, owner, { contract }))).toMatchObject({ ok: false, code: "CONSENT_REQUIRED", field: "contractRef" });
    }
    expect(await create(createArgs(actor, owner, { vehicle: { seats: 0 } }))).toMatchObject({ ok: false, code: "INVALID", field: "vehicle.seats" });
    expect(await create(createArgs(actor, owner, { vehicle: { category: "limousine" } }))).toMatchObject({ ok: false, code: "INVALID", field: "vehicle.category" });
    expect(await create(createArgs(actor, owner, { driver: { first_name: " " } }))).toMatchObject({ ok: false, code: "INVALID", field: "ownerFirstName" });

    expect(await sql("select 1 from public.organization_users where user_id = $1", [owner])).toHaveLength(0);
    expect(await sql("select 1 from public.drivers where user_id = $1", [owner])).toHaveLength(0);
  });

  it("frais refusés (60 %) : rien n'est écrit — ni organisation, ni adhésion, ni fiche, ni e-mail ; création possible ensuite", async () => {
    const actor = await superAdmin();
    const owner = await createAuthUser(`pf-owner-${uid()}@test.dev`, "Karim");
    const slug = `pf-fees-${uid()}`;
    const [{ n: before }] = await sql("select count(*)::int as n from public.email_outbox");
    const refused = await create(createArgs(actor, owner, { slug, percent: 60 }));
    expect(refused).toMatchObject({ ok: false, code: "INVALID", field: "platformFeePercent" });
    expect(await sql("select 1 from public.organizations where slug = $1", [slug])).toHaveLength(0);
    expect(await sql("select 1 from public.organization_users where user_id = $1", [owner])).toHaveLength(0);
    expect(await sql("select 1 from public.drivers where user_id = $1", [owner])).toHaveLength(0);
    expect((await sql("select count(*)::int as n from public.email_outbox"))[0].n).toBe(before);
    expect(await create(createArgs(actor, owner, { slug, percent: 5 }))).toMatchObject({ ok: true, code: "CREATED" });
  });
});

// -----------------------------------------------------------------------------
describe("limites imposées (private.org_limits)", () => {
  it("1 chauffeur et 1 accès malgré une offre qui les lève et une surcharge du super admin", async () => {
    const pf = await createPrivateFleet("Limites");
    await sql(`update public.organizations set limits_override = '{"max_drivers": 50, "max_admins": 10}' where id = $1`, [pf.id]);
    expect(await limits(pf.id)).toMatchObject({ max_drivers: 1, max_admins: 1, api_access: true });
    const [plan] = await sql(
      `insert into public.plans (code, name, limits) values ($1, 'Grande flotte', '{"api_access": true, "max_drivers": 200, "max_admins": 20}') returning id`,
      [`pf_big_${randomUUID().replace(/-/g, "").slice(0, 10)}`],
    );
    await sql("update public.organizations set plan_id = $2 where id = $1", [pf.id, plan.id]);
    expect(await limits(pf.id)).toMatchObject({ max_drivers: 1, max_admins: 1 });
    await sql("update public.organizations set plan_id = null, limits_override = '{}' where id = $1", [pf.id]);
    expect(await limits(pf.id)).toEqual({ api_access: true, booking_site: true, custom_domain: true, advanced_stats: true, ...PRIVATE_FLEET_LIMITS });
  });

  it("organisation standard : formule de 20260924002800 inchangée (avec offre, sans offre, surcharge)", async () => {
    const withPlan = await createOrg("PF Std Offre");
    const noPlan = await createOrg("PF Std Sans Offre");
    await sql("update public.organizations set plan_id = null where id = $1", [noPlan.id]);
    const override = await createOrg("PF Std Surcharge");
    await sql(`update public.organizations set limits_override = '{"max_drivers": 3, "booking_site": false}' where id = $1`, [override.id]);
    for (const org of [withPlan, noPlan, override]) {
      const [row] = await sql(
        `select private.org_limits(o.id) as actual,
                case when o.plan_id is null
                     then '{"api_access": true, "booking_site": true, "custom_domain": true, "advanced_stats": true}'::jsonb
                     else coalesce(p.limits, '{}'::jsonb) end || coalesce(o.limits_override, '{}'::jsonb) as expected
           from public.organizations o left join public.plans p on p.id = o.plan_id where o.id = $1`,
        [org.id],
      );
      expect(row.actual).toEqual(row.expected);
      expect(row.actual).not.toHaveProperty("max_admins");
    }
  });
});

// -----------------------------------------------------------------------------
describe("gardes", () => {
  it("une seule fiche, celle du propriétaire ; candidature et lien d'inscription fermés ; un seul accès", async () => {
    const pf = await createPrivateFleet("Gardes");
    const other = await createAuthUser(`pf-other-${uid()}@test.dev`, "Autre compte");
    const [veh] = await sql(
      `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe C', $2, 'business', 4) returning id`,
      [pf.id, uniquePlate()],
    );
    const second = await expectPgError(as({ role: "service_role" }, (q) =>
      q(`insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, vehicle_id)
         values ($1, $2, 'Second', 'Chauffeur', $3, 'active', $4)`, [pf.id, other, uniquePhone(), veh.id])));
    expect(second.message).toMatch(/^PRIVATE_FLEET_SINGLE_DRIVER/);
    const pending = await expectPgError(as({ role: "service_role" }, (q) =>
      q(`insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, application_status, joined_via)
         values ($1, $2, 'Samir', 'Candidat', $3, 'inactive', 'pending', 'join_link')`, [pf.id, other, uniquePhone()])));
    expect(pending.message).toMatch(/^PRIVATE_FLEET_SINGLE_DRIVER/);
    const detached = await expectPgError(as({ role: "service_role" }, (q) =>
      q(`insert into public.drivers (organization_id, first_name, last_name, phone, status) values ($1, 'Sans', 'Compte', $2, 'inactive')`, [pf.id, uniquePhone()])));
    expect(detached.message).toMatch(/^PRIVATE_FLEET_SINGLE_DRIVER/);
    const moved = await expectPgError(as({ role: "service_role" }, (q) => q("update public.drivers set user_id = $2 where id = $1", [pf.driverId, other])));
    expect(moved.message).toMatch(/^PRIVATE_FLEET_DRIVER_OWNER/);

    expect(await svc("svc_driver_apply", [
      pf.id, other, "Samir", "Candidat", "0611223344", "samir@test.dev", null,
      JSON.stringify({ model: "Corolla", plate: uniquePlate(), category: "standard" }), null,
    ])).toMatchObject({ ok: false, code: "JOIN_DISABLED" });

    const open = await expectPgError(fresh(pf.ownerId, "set_join_link", [pf.id, true, false, null]));
    expect(open.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    const regenerated = await fresh(pf.ownerId, "set_join_link", [pf.id, false, true, null]);
    expect(regenerated).toMatchObject({ ok: true, join_enabled: false });
    expect(regenerated.join_code).toBeTruthy();
    expect(await svc("svc_join_info", [regenerated.join_code])).toMatchObject({ ok: false, code: "JOIN_LINK_INVALID" });

    const admin = await expectPgError(sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'admin')", [pf.id, other]));
    expect(admin.message).toMatch(/^PLAN_LIMIT_ADMINS/);
    expect(await sql("select 1 from public.drivers where organization_id = $1", [pf.id])).toHaveLength(1);
  });

  it("ni réseau partagé (adhésion, demande, validation) ni centrale (svc_platform_set_fees)", async () => {
    const pf = await createPrivateFleet("Réseau", { org: { legal_name: "VTC Réseau EI", siret: "12345678900012", vtc_registration: "EVTC075230002" } });
    const share = await expectPgError(fresh(pf.ownerId, "set_network_settings", [pf.id, true, null, await networkTermsVersion(), null, null]));
    expect(share.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    const approve = await expectPgError(svc("svc_network_approve", [pf.actor, pf.id, true, false, null]));
    expect(approve.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    // Aucune adhésion créée, même suspendue (la suspension ne vise qu'une adhésion existante, voir la bascule)
    const suspend = await expectPgError(svc("svc_network_suspend", [pf.actor, pf.id, true, "Manquement à la convention"]));
    expect(suspend.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    expect(await sql("select 1 from public.network_memberships where organization_id = $1", [pf.id])).toHaveLength(0);
    const centrale = await expectPgError(svc("svc_platform_set_fees", [pf.id, pf.actor, null, null, "centrale", "notice", null, NOTE, VERSION, null, APP]));
    expect(centrale.message).toMatch(/^PRIVATE_FLEET_MODEL/);
    expect((await orgRow(pf.id)).dispatch_model).toBe("fleet");
  });

  it("suppression de compte de la fiche acceptée (compte de gestion gardé), puis fiche recréée par le super admin", async () => {
    const pf = await createPrivateFleet("Recréation");
    const [vehicle] = await sql("select plate from public.vehicles where id = $1", [pf.vehicleId]);
    const deleted = (await sql("select private.delete_driver_account($1, 'admin', $2) as r", [pf.driverId, pf.actor]))[0].r;
    expect(deleted).toMatchObject({ ok: true, code: "DELETED", keep_auth: true });
    expect((await sql("select user_id, deleted_at from public.drivers where id = $1", [pf.driverId]))[0]).toMatchObject({ user_id: null });
    expect((await sql("select status from public.organization_users where organization_id = $1 and user_id = $2", [pf.id, pf.ownerId]))[0].status).toBe("active");

    const driverJson = JSON.stringify({ first_name: "Karim", last_name: "Gérant", phone: uniquePhone() });
    const vehicleJson = JSON.stringify({ brand: "Mercedes", model: "Classe E", plate: vehicle.plate, category: "business", seats: 4 });
    expect((await expectPgError(svc("svc_platform_attach_private_fleet_driver", [pf.id, pf.ownerId, driverJson, vehicleJson]))).code).toBe("42501");
    const std = await createOrg("PF Recréation Standard");
    expect(await svc("svc_platform_attach_private_fleet_driver", [std.id, pf.actor, driverJson, vehicleJson])).toMatchObject({
      ok: false, code: "PRIVATE_FLEET_ONLY",
    });
    expect(await svc("svc_platform_attach_private_fleet_driver", [pf.id, pf.actor, driverJson, JSON.stringify({ model: "", plate: "AB" })]))
      .toMatchObject({ ok: false, code: "INVALID", field: "vehicle.model" });

    const res = await svc("svc_platform_attach_private_fleet_driver", [pf.id, pf.actor, driverJson, vehicleJson]);
    expect(res).toMatchObject({ ok: true, code: "CREATED" });
    expect((await sql("select user_id, owner_driver, trust_level, status, vehicle_id from public.drivers where id = $1", [res.driver_id]))[0]).toEqual({
      user_id: pf.ownerId, owner_driver: true, trust_level: "trusted", status: "active", vehicle_id: pf.vehicleId,
    });
    expect(await sql("select 1 from public.audit_logs where organization_id = $1 and action = 'driver.private_fleet_attached'", [pf.id])).toHaveLength(1);
    expect(await svc("svc_platform_attach_private_fleet_driver", [pf.id, pf.actor, driverJson, vehicleJson])).toMatchObject({
      ok: false, code: "PRIVATE_FLEET_HAS_DRIVER",
    });
  });

  it("recréation : propriétaire encore invité (phase 2) → INVITATION_PENDING", async () => {
    const pf = await createPrivateFleet("Invitation");
    await sql("select private.delete_driver_account($1, 'admin', $2)", [pf.driverId, pf.actor]);
    await sql("update public.organization_users set status = 'invited' where organization_id = $1 and user_id = $2", [pf.id, pf.ownerId]);
    expect(await svc("svc_platform_attach_private_fleet_driver", [
      pf.id, pf.actor, JSON.stringify({ first_name: "Karim", last_name: "Gérant", phone: uniquePhone() }),
      JSON.stringify({ model: "Classe E", plate: uniquePlate(), category: "business", seats: 4 }),
    ])).toMatchObject({ ok: false, code: "INVITATION_PENDING" });
  });
});

// -----------------------------------------------------------------------------
describe("bascule (svc_platform_set_private_fleet)", () => {
  const counts = async (orgId: string) =>
    (await sql(
      `select (select count(*)::int from public.rides where organization_id = $1) as rides,
              (select count(*)::int from public.drivers where organization_id = $1) as drivers,
              (select count(*)::int from public.api_keys where organization_id = $1) as keys,
              (select count(*)::int from public.platform_fee_entries where organization_id = $1) as fees`,
      [orgId],
    ))[0];

  it("sortie vers une flotte standard : profil et limites de l'offre, 2e chauffeur et 2e membre, lien ouvrable, audit, diffusions", async () => {
    const pf = await createPrivateFleet("Sortie Flotte", { percent: 0, fixedCents: 100 });
    await sql(
      `insert into public.api_keys (organization_id, name, prefix, last4, scopes) values ($1, 'Site du client', $2, 'abcd', '{rides:create}')`,
      [pf.id, `rdk_${uid()}`],
    );
    const ride = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    const before = await counts(pf.id);
    expect(before).toMatchObject({ rides: 1, drivers: 1, keys: 1 });
    const nextBefore = (await rideRow(ride.id)).next_dispatch_at.getTime();
    await sql("delete from realtime.messages where topic = any($1)", [[`org:${pf.id}`, `driver:${pf.driverId}`]]);

    expect(await setPrivate(pf.id, pf.actor, false, null)).toMatchObject({ ok: false, code: "CONSENT_REQUIRED", field: "consentNote" });
    expect(await setPrivate(pf.id, pf.actor, false, " ab ")).toMatchObject({ ok: false, code: "CONSENT_REQUIRED" });
    expect((await expectPgError(setPrivate(pf.id, pf.ownerId, false, NOTE))).code).toBe("42501");
    expect(await setPrivate(pf.id, pf.actor, false, NOTE, { percent: 5 })).toMatchObject({ ok: false, code: "INVALID", field: "platformFeeFixedCents" });

    const res = await setPrivate(pf.id, pf.actor, false, NOTE);
    expect(res).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED", fees: null, open_rides: 1 });
    expect(await orgRow(pf.id)).toMatchObject({ private_fleet: false, dispatch_model: "fleet" });
    expect(await settings(pf.id)).toEqual({ ...STANDARD_DISPATCH_PROFILE });
    expect(await limits(pf.id)).not.toHaveProperty("max_drivers");
    expect((await sql("select owner_driver from public.drivers where id = $1", [pf.driverId]))[0].owner_driver).toBe(true);
    expect(await counts(pf.id)).toEqual(before);
    // Aucune offre fermée : la réservation garde son offre et son prochain passage (échéances recalculées alors)
    expect((await rideRow(ride.id)).next_dispatch_at.getTime()).toBe(nextBefore);
    expect(await pendingOffer(ride.id, pf.driverId)).toBeTruthy();

    const org: Org = { id: pf.id, slug: pf.slug, ownerId: pf.ownerId };
    await createDriver(org, { firstName: "Deuxième" });
    await createMember(org, "admin");
    expect(await fresh(pf.ownerId, "set_join_link", [pf.id, true, false, null])).toMatchObject({ ok: true, join_enabled: true });

    const [audit] = await sql(
      "select actor_type, severity, metadata from public.audit_logs where organization_id = $1 and action = 'organization.private_fleet_disabled'",
      [pf.id],
    );
    expect(audit).toMatchObject({ actor_type: "super_admin", severity: "warning", metadata: { note: NOTE, dispatch_model: "fleet", open_rides: 1 } });
    const msgs = await sql("select topic, event, payload from realtime.messages where topic = any($1) order by id", [[`org:${pf.id}`, `driver:${pf.driverId}`]]);
    expect(msgs).toContainEqual(expect.objectContaining({ topic: `org:${pf.id}`, event: "platform.updated", payload: expect.objectContaining({ action: "model" }) }));
    expect(msgs).toContainEqual(expect.objectContaining({
      topic: `driver:${pf.driverId}`, event: "driver.updated", payload: expect.objectContaining({ id: pf.driverId, status: "active" }),
    }));
    // Même état demandé : rien à faire
    expect(await setPrivate(pf.id, pf.actor, false, NOTE)).toEqual({ ok: true, code: "UNCHANGED" });
    // Retour refusé : deux fiches, deux membres, lien ouvert ne compte pas (fermé par la bascule)
    const back = await setPrivate(pf.id, pf.actor, true, NOTE);
    expect(back).toMatchObject({ ok: false, code: "PRIVATE_FLEET_NOT_ELIGIBLE" });
    expect(back.blockers).toEqual(["members", "drivers"]);
  });

  it("sortie vers une centrale : refus des frais → rien d'écrit ; puis modèle changé, répartition des courses ouvertes calculée", async () => {
    const pf = await createPrivateFleet("Sortie Centrale");
    const ride = await createApiRide(pf.id, { price_cents: 8000, pickup_at: inMinutes(3 * 24 * 60) });
    const before = await counts(pf.id);

    const refused = await setPrivate(pf.id, pf.actor, false, NOTE, { model: "centrale", percent: 5, fixed: 100, mode: "notice", legalOn: "2026-11-05" });
    expect(refused).toMatchObject({ ok: false, code: "TERMS_NOT_NOTIFIED" });
    expect(await orgRow(pf.id)).toMatchObject({ private_fleet: true, dispatch_model: "fleet" });
    expect(await settings(pf.id)).toEqual({ ...PRIVATE_FLEET_DISPATCH_PROFILE });
    expect(await sql("select 1 from public.audit_logs where organization_id = $1 and action like 'organization.private_fleet_%abled'", [pf.id])).toHaveLength(0);

    const res = await setPrivate(pf.id, pf.actor, false, NOTE, { model: "centrale" });
    expect(res).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED", fees: { ok: true, code: "APPLIED", dispatch_model: "centrale" } });
    expect(await orgRow(pf.id)).toMatchObject({ private_fleet: false, dispatch_model: "centrale" });
    const [split] = await sql("select driver_payout_cents, platform_fee_cents from public.rides where id = $1", [ride.id]);
    expect(split.driver_payout_cents).toBe(8000);
    expect(await counts(pf.id)).toEqual(before);
    expect(await sql("select 1 from public.audit_logs where organization_id = $1 and action = 'organization.dispatch_model_changed'", [pf.id])).toHaveLength(1);
  });

  it("sortie avec l'offre choisie : écrite dans la même transaction, annulée avec un refus des frais ; offre inactive ou entrée refusées", async () => {
    const pf = await createPrivateFleet("Sortie Offre");
    const planOf = async () => (await sql("select private_fleet, plan_id from public.organizations where id = $1", [pf.id]))[0];
    const before = await planOf();
    const [pro] = await sql(
      `insert into public.plans (code, name, limits) values ($1, 'Pro PF', '{"api_access":true,"max_drivers":5,"max_admins":3}') returning id`,
      [`pf_pro_${uid()}`],
    );
    const [retired] = await sql(
      `insert into public.plans (code, name, limits, is_active) values ($1, 'Retirée PF', '{"api_access":true}', false) returning id`,
      [`pf_old_${uid()}`],
    );
    const planAudits = () => sql("select actor_type, actor_user_id, metadata from public.audit_logs where organization_id = $1 and action = 'organization.plan_changed'", [pf.id]);

    // Offre retirée : refusée avant tout
    expect(await setPrivate(pf.id, pf.actor, false, NOTE, { plan: retired.id })).toMatchObject({ ok: false, code: "INVALID", field: "planId" });
    // Refus des frais : drapeau ET offre inchangés (constat de la revue : jamais sortie avec l'ancienne offre ou sans limite)
    const refused = await setPrivate(pf.id, pf.actor, false, NOTE, { plan: pro.id, model: "centrale", percent: 5, fixed: 100, legalOn: "2026-11-05" });
    expect(refused).toMatchObject({ ok: false, code: "TERMS_NOT_NOTIFIED" });
    expect(await planOf()).toEqual(before);
    expect(await planAudits()).toHaveLength(0);

    // Sortie : drapeau levé et offre écrite ensemble ; limites de l'offre ; journal
    expect(await setPrivate(pf.id, pf.actor, false, NOTE, { plan: pro.id })).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED" });
    expect(await planOf()).toEqual({ private_fleet: false, plan_id: pro.id });
    expect(await limits(pf.id)).toMatchObject({ max_drivers: 5, max_admins: 3, api_access: true });
    expect(await planAudits()).toEqual([
      { actor_type: "super_admin", actor_user_id: pf.actor, metadata: { planId: pro.id, previousPlanId: before.plan_id, reason: "private_fleet_disabled" } },
    ]);
    const [disabled] = await sql("select metadata from public.audit_logs where organization_id = $1 and action = 'organization.private_fleet_disabled'", [pf.id]);
    expect(disabled.metadata).toMatchObject({ plan_id: pro.id, plan_changed: true });
    // Déjà sortie : l'offre se règle depuis la fiche (« Offre & limites »)
    expect(await setPrivate(pf.id, pf.actor, false, NOTE, { plan: null })).toMatchObject({ ok: false, code: "INVALID" });
    expect((await planOf()).plan_id).toBe(pro.id);

    // Sortie « sans offre » assumée : aucune limite ; même offre : rien de réécrit ni de journalisé
    const free = await createPrivateFleet("Sortie Sans Offre");
    expect(await setPrivate(free.id, free.actor, false, NOTE, { plan: null })).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED" });
    expect((await sql("select plan_id from public.organizations where id = $1", [free.id]))[0].plan_id).toBeNull();
    expect(await limits(free.id)).not.toHaveProperty("max_drivers");
    const same = await createPrivateFleet("Sortie Même Offre");
    const samePlan = (await sql("select plan_id from public.organizations where id = $1", [same.id]))[0].plan_id;
    expect(await setPrivate(same.id, same.actor, false, NOTE, { plan: samePlan })).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED" });
    expect(await sql("select 1 from public.audit_logs where organization_id = $1 and action = 'organization.plan_changed'", [same.id])).toHaveLength(0);

    // Entrée : jamais d'offre (réglée ensuite depuis la fiche)
    const actor = await superAdmin();
    const org = await createOrg("PF Entrée Offre");
    await ownerFiche(org);
    expect(await setPrivate(org.id, actor, true, NOTE, { plan: pro.id })).toMatchObject({ ok: false, code: "INVALID" });
    expect((await orgRow(org.id)).private_fleet).toBe(false);
  });

  it("entrée refusée tant qu'une raison existe (liste des raisons), acceptée sinon : lien fermé, profil, fiche du gérant", async () => {
    const actor = await superAdmin();
    const eligible = async (name: string) => {
      const org = await createOrg(name);
      const driverId = await ownerFiche(org);
      return { org, driverId };
    };
    const cases: [string, (org: Org) => Promise<unknown>, string[]][] = [
      ["deux fiches", (org) => createDriver(org), ["drivers"]],
      ["deux membres", (org) => createMember(org, "admin"), ["members"]],
      ["candidature", (org) => candidate(org), ["drivers", "applications"]],
      ["partage réseau", (org) => enableNetwork(org, { out: true }), ["network"]],
      ["centrale", (org) => sql("update public.organizations set dispatch_model = 'centrale' where id = $1", [org.id]), ["model"]],
    ];
    for (const [label, setup, expected] of cases) {
      const { org } = await eligible(`PF Entrée ${label}`);
      await setup(org);
      const res = await setPrivate(org.id, actor, true, NOTE);
      expect(res, label).toMatchObject({ ok: false, code: "PRIVATE_FLEET_NOT_ELIGIBLE" });
      expect(res.blockers, label).toEqual(expected);
      expect((await orgRow(org.id)).private_fleet, label).toBe(false);
    }
    // Fiche d'un autre compte que le propriétaire
    const foreign = await createOrg("PF Entrée fiche étrangère");
    await createDriver(foreign);
    expect((await setPrivate(foreign.id, actor, true, NOTE)).blockers).toEqual(["owner_driver"]);
    // Dans l'ordre de PRIVATE_FLEET_BLOCKERS
    const all = await createOrg("PF Entrée tout");
    await createDriver(all);
    await createMember(all, "dispatcher");
    await candidate(all);
    await enableNetwork(all, { in: true });
    await sql("update public.organizations set dispatch_model = 'centrale' where id = $1", [all.id]);
    expect((await setPrivate(all.id, actor, true, NOTE)).blockers).toEqual([...PRIVATE_FLEET_BLOCKERS]);

    // Acceptée : lien d'inscription ouvert et adhésion réseau inerte (non partagée) n'empêchent rien
    const { org, driverId } = await eligible("PF Entrée acceptée");
    await as({ sub: org.ownerId }, (q) => q("select public.set_join_link($1, true, false, true)", [org.id]));
    await sql("insert into public.network_memberships (organization_id) values ($1)", [org.id]);
    const res = await setPrivate(org.id, actor, true, NOTE);
    expect(res).toMatchObject({ ok: true, code: "PRIVATE_FLEET_ENABLED", fees: null });
    expect(await orgRow(org.id)).toEqual({ private_fleet: true, dispatch_model: "fleet", join_enabled: false, join_auto_approve: false });
    expect(await settings(org.id)).toEqual({ ...PRIVATE_FLEET_DISPATCH_PROFILE });
    expect((await sql("select owner_driver from public.drivers where id = $1", [driverId]))[0].owner_driver).toBe(true);
    expect(await limits(org.id)).toMatchObject(PRIVATE_FLEET_LIMITS);
    expect(await sql("select 1 from public.audit_logs where organization_id = $1 and action = 'organization.private_fleet_enabled'", [org.id])).toHaveLength(1);
    expect(await setPrivate(org.id, actor, true, NOTE)).toEqual({ ok: true, code: "UNCHANGED" });
    expect(await setPrivate(org.id, actor, true, NOTE, { model: "centrale" })).toMatchObject({ ok: false, code: "INVALID" });
    // L'adhésion existante reste suspendable ; jamais partagée
    expect(await svc("svc_network_suspend", [actor, org.id, true, "Manquement à la convention"])).toMatchObject({ ok: true, code: "SUSPENDED" });
    const share = await expectPgError(as({ sub: org.ownerId }, (q) =>
      q("select public.set_network_settings($1, true, null, null, null, null)", [org.id])));
    expect(share.message).toMatch(/^(PRIVATE_FLEET_RESTRICTED|NETWORK_TERMS_REQUIRED)/);
    const shareTerms = await expectPgError(as({ sub: org.ownerId }, async (q) =>
      q("select public.set_network_settings($1, true, null, $2, null, null)", [org.id, await networkTermsVersion()])));
    expect(shareTerms.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
  });

  it("sortie pendant l'attente d'une réponse : aucune offre fermée avant son échéance, rappels « à confirmer » annulés", async () => {
    const pf = await createPrivateFleet("Sortie Attente");
    await asFresh(pf.ownerId, (q) =>
      q("update public.organization_settings set scheduled_dispatch_lead_minutes = 120 where organization_id = $1", [pf.id]));
    const now = await createApiRide(pf.id);
    const later = await createApiRide(pf.id, { pickup_at: inMinutes(2 * 24 * 60) });
    expect(await queuedReminders(pf.id)).toHaveLength(3);
    const offer = await pendingOffer(now.id, pf.driverId);
    const deadline = (await offerRow(offer)).expires_at.getTime();
    expect((await rideRow(now.id)).next_dispatch_at.getTime()).toBe(deadline);

    expect(await setPrivate(pf.id, pf.actor, false, NOTE)).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED", open_rides: 2 });
    expect(await queuedReminders(pf.id)).toHaveLength(0);
    // Passage inchangé (à l'échéance de l'offre de 5 min) : un passage du dispatch ne ferme rien
    expect((await rideRow(now.id)).next_dispatch_at.getTime()).toBe(deadline);
    await tick();
    expect(await offerRow(offer)).toMatchObject({ status: "pending" });
    expect(await rideRow(now.id)).toMatchObject({ status: "OFFERED", dispatch_mode: "fleet" });
    // Planifiée : l'échéance suit le profil standard au passage suivant (délai 60 min), sans rappel « à confirmer »
    await passNow(later.id);
    const laterRide = await rideRow(later.id);
    expect((await offerRow(await pendingOffer(later.id, pf.driverId))).expires_at.getTime())
      .toBe(laterRide.pickup_at.getTime() - STANDARD_DISPATCH_PROFILE.scheduled_dispatch_lead_minutes * 60_000);
    expect(await queuedReminders(pf.id)).toHaveLength(0);

    // À l'échéance de l'offre : chemin standard (vagues GPS dès 4 km)
    await sql("update public.ride_offers set expires_at = now() - interval '1 second' where id = $1", [offer]);
    await passNow(now.id);
    expect(await offerRow(offer)).toMatchObject({ status: "expired", closed_reason: "fleet_window_elapsed" });
    expect(await rideRow(now.id)).toMatchObject({ dispatch_mode: "geo", dispatch_radius_m: STANDARD_DISPATCH_PROFILE.dispatch_radii_m[0] });
  });

  it("entrée pendant une recherche GPS : l'offre en attente vit jusqu'à son échéance, puis le dernier appel (100 km) est lancé", async () => {
    const actor = await superAdmin();
    const org = await createOrg("PF Entrée Vague");
    const driverId = await ownerFiche(org);
    await sql("update public.drivers set presence = 'available' where id = $1", [driverId]);
    await sql(
      `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
       values ($1, $2, 48.7262, 2.3652, now(), now())`,
      [driverId, org.id],
    );
    const ride = await createApiRide(org.id);
    expect(await rideRow(ride.id)).toMatchObject({ dispatch_mode: "geo", dispatch_wave: 1, dispatch_radius_m: 4000 });
    const offer = await pendingOffer(ride.id, driverId);
    expect(await offerRow(offer)).toMatchObject({ mode: "geo", status: "pending" });
    const nextBefore = (await rideRow(ride.id)).next_dispatch_at.getTime();

    expect(await setPrivate(org.id, actor, true, NOTE)).toMatchObject({ ok: true, code: "PRIVATE_FLEET_ENABLED", open_rides: 1 });
    expect(await rideRow(ride.id)).toMatchObject({ dispatch_mode: "geo", dispatch_wave: 0 });
    expect((await rideRow(ride.id)).next_dispatch_at.getTime()).toBe(nextBefore);
    await tick();
    expect(await offerRow(offer)).toMatchObject({ status: "pending" });

    // Échéance de l'offre : dernier appel de 100 km (l'offre en cours est prolongée), pas « Non confirmée »
    await passNow(ride.id);
    expect(await rideRow(ride.id)).toMatchObject({ status: "OFFERED", dispatch_wave: 1, dispatch_radius_m: 100_000 });
    expect(await offerRow(offer)).toMatchObject({ status: "pending" });
    expect(await sql("select 1 from public.notifications where ride_id = $1 and type = 'ride_unconfirmed'", [ride.id])).toHaveLength(0);
    // Fin du dernier appel : « Non confirmée »
    await passNow(ride.id);
    expect(await rideRow(ride.id)).toMatchObject({ status: "NO_DRIVER_FOUND" });
    expect(await sql("select 1 from public.notifications where ride_id = $1 and type = 'ride_unconfirmed'", [ride.id])).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
describe("entrée en Flotte Privée tenue ouverte : écritures concurrentes (deux connexions)", () => {
  /** Organisation standard éligible : le propriétaire, seul membre, a la seule fiche (même compte). */
  async function eligibleOrg(name: string) {
    const org = await createOrg(name);
    await ownerFiche(org);
    return org;
  }

  /**
   * Entrée en Flotte Privée dans une transaction A non validée, puis écriture d'une autre connexion B : B doit attendre
   * un verrou de A (ligne de l'organisation, ou verrou consultatif pour le réseau), puis relire le drapeau validé.
   * Renvoie l'erreur de B.
   */
  async function writeDuringEntry(orgId: string, write: (b: pg.PoolClient) => Promise<unknown>) {
    const actor = await superAdmin();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await a.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await a.query("set local role service_role");
      const { rows } = await a.query("select public.svc_platform_set_private_fleet($1, $2, true, $3) as r", [orgId, actor, NOTE]);
      expect(rows[0].r).toMatchObject({ ok: true, code: "PRIVATE_FLEET_ENABLED" });
      await b.query("set statement_timeout = '10s'");
      const [{ pid }] = (await b.query("select pg_backend_pid() as pid")).rows;
      const result = write(b).then(() => null, (e: PgError) => e);
      // B bloquée sur un verrou de A (et non terminée avant la validation de A)
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await sql("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        waiting = row?.wait_event_type === "Lock";
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      await a.query("commit");
      return await result;
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("reset statement_timeout").catch(() => undefined);
      a.release();
      b.release();
    }
  }

  const state = async (orgId: string) =>
    (await sql(
      `select o.private_fleet, private.private_fleet_blockers(o.id) as blockers,
              (select count(*)::int from public.organization_users u where u.organization_id = o.id and u.status <> 'disabled') as members,
              (select count(*)::int from public.drivers d where d.organization_id = o.id and d.deleted_at is null) as drivers
         from public.organizations o where o.id = $1`,
      [orgId],
    ))[0];

  it("adhésion invitée : attend la bascule puis refusée (PRIVATE_FLEET_RESTRICTED)", async () => {
    const org = await eligibleOrg("PF Course Adhésion");
    const invitee = await createAuthUser(`pf-invite-${uid()}@test.dev`, "Invité");
    const err = await writeDuringEntry(org.id, (b) =>
      b.query("insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'admin', 'invited')", [org.id, invitee]));
    expect(err?.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    expect(await state(org.id)).toEqual({ private_fleet: true, blockers: [], members: 1, drivers: 1 });
  });

  it("accès désactivé réactivé : attend la bascule puis refusé", async () => {
    const org = await eligibleOrg("PF Course Réactivation");
    const member = await createMember(org, "admin");
    await sql("update public.organization_users set status = 'disabled' where organization_id = $1 and user_id = $2", [org.id, member]);
    const err = await writeDuringEntry(org.id, (b) =>
      b.query("update public.organization_users set status = 'active' where organization_id = $1 and user_id = $2", [org.id, member]));
    expect(err?.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    expect(await state(org.id)).toEqual({ private_fleet: true, blockers: [], members: 1, drivers: 1 });
  });

  it("candidature : attend la bascule puis refusée (PRIVATE_FLEET_SINGLE_DRIVER)", async () => {
    const org = await eligibleOrg("PF Course Candidature");
    const user = await createAuthUser(`pf-cand-${uid()}@test.dev`, "Candidat");
    const err = await writeDuringEntry(org.id, (b) =>
      b.query(
        `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, application_status, applied_at, joined_via, trust_level)
         values ($1, $2, 'Samir', 'Candidat', $3, 'inactive', 'pending', now(), 'join_link', 'new')`,
        [org.id, user, uniquePhone()],
      ));
    expect(err?.message).toMatch(/^PRIVATE_FLEET_SINGLE_DRIVER/);
    expect(await state(org.id)).toEqual({ private_fleet: true, blockers: [], members: 1, drivers: 1 });
  });

  it("partage réseau demandé : attend la bascule puis refusé (PRIVATE_FLEET_RESTRICTED)", async () => {
    const org = await eligibleOrg("PF Course Réseau");
    const version = await networkTermsVersion();
    const err = await writeDuringEntry(org.id, (b) =>
      b.query(
        `insert into public.network_memberships (organization_id, share_out, terms_version, terms_accepted_at, terms_accepted_by, requested_at)
         values ($1, true, $2, now(), $3, now())`,
        [org.id, version, org.ownerId],
      ));
    expect(err?.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    expect(await sql("select 1 from public.network_memberships where organization_id = $1", [org.id])).toHaveLength(0);
  });

  it("2e adhésion glissée hors des déclencheurs : l'invitation ne s'active pas (dernier rempart)", async () => {
    const pf = await createPrivateFleet("Accès Unique");
    const invitee = await createAuthUser(`pf-invite-${uid()}@test.dev`, "Invité");
    const client = await pool.connect();
    try {
      // État que les écritures normales refusent : inséré déclencheurs désactivés
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query("insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'admin', 'invited')", [pf.id, invitee]);
      await client.query("commit");
      // L'invité ouvre le lien reçu par e-mail (preuve « invite »)
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: invitee, role: "authenticated", iat: Math.floor(Date.now() / 1000) + 2, amr: [{ method: "invite" }] }),
      ]);
      await client.query("set local role authenticated");
      const err = await expectPgError(client.query("select public.accept_member_invitations()"));
      expect(err.message).toMatch(/^PRIVATE_FLEET_RESTRICTED/);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    expect((await sql("select status from public.organization_users where organization_id = $1 and user_id = $2", [pf.id, invitee]))[0].status).toBe("invited");
  });
});

// -----------------------------------------------------------------------------
describe("exemption de règlement du gérant (20260924007700)", () => {
  it("en centrale après la bascule : course du gérant sans règlement ; course d'un autre chauffeur réglée (non-régression)", async () => {
    const pf = await createPrivateFleet("Exemption");
    expect(await setPrivate(pf.id, pf.actor, false, NOTE, { model: "centrale" })).toMatchObject({ ok: true, code: "PRIVATE_FLEET_DISABLED" });
    await sql("update public.organization_settings set driver_commission_percent = 20 where organization_id = $1", [pf.id]);
    const other = await createDriver({ id: pf.id, slug: pf.slug, ownerId: pf.ownerId }, { firstName: "Autre" });

    const own = await createApiRide(pf.id, { price_cents: 6000, payment_method: "cash", pickup_at: inMinutes(2 * 24 * 60) });
    await acceptAndComplete(pf.ownerId, own.id, pf.driverId);
    expect((await sql("select status, commission_cents from public.rides where id = $1", [own.id]))[0]).toEqual({ status: "COMPLETED", commission_cents: 1200 });
    expect(await sql("select 1 from public.ride_settlements where ride_id = $1", [own.id])).toHaveLength(0);
    const home = await fresh(pf.ownerId, "driver_home");
    expect(home.settlement).toMatchObject({ open_count: 0, owed_cents: 0, blocked: null });

    const theirs = await createApiRide(pf.id, { price_cents: 6000, payment_method: "cash", pickup_at: inMinutes(2 * 24 * 60) });
    await acceptAndComplete(other.userId, theirs.id, other.id);
    const [settlement] = await sql("select driver_id, direction, amount_cents, status from public.ride_settlements where ride_id = $1", [theirs.id]);
    expect(settlement).toEqual({ driver_id: other.id, direction: "driver_owes", amount_cents: 1200, status: "due" });
  });
});
