// Audit « droits » (20260924004300) : écritures directes des colonnes d'administration des chauffeurs, lecture des
// organisations, notifications de Rydar, jetons push, quota de stockage, visite médicale, version des documents légaux.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createMember, createOrg, createRideAsOwner, expectPgError, north, pool, sql,
  type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
type D = { id: string; userId: string };
const NEAR = north(CHAMPS_ELYSEES, 500);
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function centrale(name: string, settings: Record<string, unknown> = {}) {
  const org = await createOrg(name, { settings: { settlement_link: "https://revolut.me/centrale/{montant}", settlement_methods: "{link,cash}", ...settings } });
  await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_fixed_cents = 500 where id = $1`, [org.id]);
  return org;
}

async function driverIn(
  org: Org,
  opts: { status?: string; application?: string | null; trust?: "new" | "trusted"; at?: [number, number] } = {},
): Promise<D> {
  const userId = await createAuthUser(`droits-${randomUUID().slice(0, 8)}@test.dev`, "Chauffeur Droits");
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, `DR-${randomUUID().slice(0, 6)}`.toUpperCase()],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id, trust_level,
       application_status, joined_via)
     values ($1, $2, 'Yanis', 'Test', $3, $4, 'offline', $5, $6, $7, $8) returning id`,
    [org.id, userId, uniquePhone(), opts.status ?? "active", v.id, opts.trust ?? "trusted", opts.application ?? null,
      opts.application ? "join_link" : "dashboard"],
  );
  if (opts.at) {
    await sql(
      `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at) values ($1, $2, $3, $4, now(), now())`,
      [d.id, org.id, opts.at[0], opts.at[1]],
    );
    await sql(`update public.drivers set presence = 'available' where id = $1`, [d.id]);
  }
  return { id: d.id, userId };
}

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};

const updateDriver = (sub: string, driverId: string, set: string, params: unknown[] = []) =>
  as({ sub }, (q) => q(`update public.drivers set ${set} where id = $1 returning id`, [driverId, ...params]));

const driverRow = async (id: string) =>
  (await sql(`select status, trust_level, suspended_reason, first_name, notes, vehicle_id from public.drivers where id = $1`, [id]))[0];

// -----------------------------------------------------------------------------
describe("Chauffeurs : statut, confiance et suspension réservés aux owner / admin (écriture directe)", () => {
  it("dispatcher refusé (42501) sur status, trust_level, suspended_reason ; « Modifier » inchangé", async () => {
    const org = await centrale("Droits Colonnes");
    const dispatcher = await createMember(org, "dispatcher");
    const d = await driverIn(org, { trust: "new" });
    const candidate = await driverIn(org, { status: "inactive", application: "pending", trust: "new" });
    const rejected = await driverIn(org, { status: "inactive", application: "rejected", trust: "new" });

    for (const [id, set, params] of [
      [candidate.id, "status = 'active', trust_level = 'trusted'", []],
      [rejected.id, "status = 'active'", []],
      [d.id, "trust_level = 'trusted'", []],
      [d.id, "status = 'suspended', suspended_reason = $2", ["sabotage"]],
      [d.id, "suspended_reason = $2", ["motif"]],
    ] as const) {
      const e = await expectPgError(updateDriver(dispatcher, id, set, [...params]));
      expect(e.code, set).toBe("42501");
      // status / suspended_reason : droit de colonne retiré (20260924006650) ; trust_level : garde-fou du rôle
      expect(e.message).toMatch(/status|suspended_reason/.test(set) ? /permission denied/ : /FORBIDDEN_ROLE/);
    }
    expect(await driverRow(candidate.id)).toMatchObject({ status: "inactive", trust_level: "new" });
    expect(await driverRow(d.id)).toMatchObject({ status: "active", trust_level: "new", suspended_reason: null });

    // Dialogue « Modifier » (updateDriver) : identité, coordonnées, carte VTC, notes, véhicule
    expect(
      await updateDriver(dispatcher, d.id, "first_name = 'Yanis2', last_name = 'Test2', phone = $2, email = $3, vtc_card_number = 'EVTC 42', notes = 'RAS'", [
        uniquePhone(), `modif-${randomUUID().slice(0, 6)}@test.dev`,
      ]),
    ).toHaveLength(1);
    const [v] = await sql(`insert into public.vehicles (organization_id, model, plate) values ($1, 'Zoé', $2) returning id`, [org.id, `VH-${randomUUID().slice(0, 6)}`]);
    expect(await updateDriver(dispatcher, d.id, "vehicle_id = $2", [v.id])).toHaveLength(1);
    // Statut : jamais par écriture directe, même inchangé (set_driver_status seulement)
    expect((await expectPgError(updateDriver(dispatcher, d.id, "status = 'active'"))).code).toBe("42501");
    expect(await driverRow(d.id)).toMatchObject({ first_name: "Yanis2", notes: "RAS", vehicle_id: v.id, status: "active" });
  });

  it("owner et admin : suspension, réactivation, niveau de confiance ; service role et chauffeur non concernés", async () => {
    const org = await centrale("Droits Colonnes Admin");
    const admin = await createMember(org, "admin");
    const d = await driverIn(org, { trust: "new" });

    // Statut : par set_driver_status (client à bord refusé, courses remises en recherche) ; jamais en écriture directe
    expect((await expectPgError(updateDriver(org.ownerId, d.id, "status = 'suspended', suspended_reason = $2", ["Retards"]))).code).toBe("42501");
    expect((await rpc(org.ownerId, "set_driver_status", [d.id, "suspended", "Retards"])).ok).toBe(true);
    expect((await rpc(org.ownerId, "set_driver_status", [d.id, "active", null])).ok).toBe(true);
    expect(await updateDriver(admin, d.id, "trust_level = 'trusted'")).toHaveLength(1);
    expect(await driverRow(d.id)).toMatchObject({ status: "active", trust_level: "trusted", suspended_reason: null });

    // Owner d'une AUTRE centrale : la RLS le prive déjà de la ligne
    const other = await centrale("Droits Colonnes Autre");
    expect(await updateDriver(other.ownerId, d.id, "trust_level = 'new'")).toHaveLength(0);

    // Service role (serveur) : non concerné
    await as({ role: "service_role" }, (q) => q(`update public.drivers set status = 'inactive' where id = $1`, [d.id]));
    await as({ role: "service_role" }, (q) => q(`update public.drivers set status = 'active' where id = $1`, [d.id]));

    // Chauffeur : présence par RPC (security definer), inchangée
    expect((await rpc(d.userId, "driver_set_online", [true])).ok).toBe(true);
    // … mais pas d'écriture directe de sa fiche (policy drivers_update réservée aux membres)
    expect(await updateDriver(d.userId, d.id, "trust_level = 'new'")).toHaveLength(0);

    // Validation de candidature (RPC security definer, owner) : inchangée
    const candidate = await driverIn(org, { status: "inactive", application: "pending", trust: "new" });
    expect((await rpc(org.ownerId, "approve_driver_application", [candidate.id, null])).code).toBe("APPROVED");
    expect(await driverRow(candidate.id)).toMatchObject({ status: "active" });
  });

  it("confirm_settlements lancé par un dispatcher promeut toujours le chauffeur « confirmé »", async () => {
    const org = await centrale("Droits Promotion", { trust_after_rides: 1 });
    const dispatcher = await createMember(org, "dispatcher");
    const d = await driverIn(org, { trust: "new", at: NEAR });
    const ride = await createRideAsOwner(org, { price_cents: 2500, commission_cents: 500, payment_method: "cash" });
    const [offer] = await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [ride.id, d.id]);
    expect(offer, "offre en attente").toBeTruthy();
    expect((await rpc(d.userId, "accept_ride_offer", [offer.id])).code).toBe("ACCEPTED");
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
      expect((await rpc(d.userId, "driver_update_ride_status", [ride.id, s])).ok, s).toBe(true);
    }
    const [s] = await sql(`select id from public.ride_settlements where ride_id = $1`, [ride.id]);
    expect((await rpc(dispatcher, "confirm_settlements", [[s.id], "cash", null])).code).toBe("CONFIRMED");
    expect((await driverRow(d.id)).trust_level).toBe("trusted");
  });
});

// -----------------------------------------------------------------------------
describe("Organisations : lecture", () => {
  it("chauffeur : aucune ligne ; dispatcher : colonnes du tableau de bord seulement ; relance Rydar par RPC (owner)", async () => {
    const org = await centrale("Droits Organisation");
    const dispatcher = await createMember(org, "dispatcher");
    const admin = await createMember(org, "admin");
    const d = await driverIn(org);
    await sql(
      `update public.organizations set platform_reminder_note = '3 factures impayées', platform_reminded_at = now(),
         stripe_customer_id = 'cus_SECRET', limits_override = '{"max_drivers": 3}', join_code = 'abcdef0123456789' where id = $1`,
      [org.id],
    );

    // Chauffeur : l'application ne lit jamais la table (RPC)
    expect(await as({ sub: d.userId }, (q) => q(`select id from public.organizations`))).toHaveLength(0);
    expect((await rpc(d.userId, "driver_home")).driver).toBeTruthy();

    for (const who of [dispatcher, admin, org.ownerId]) {
      // lib/auth.ts (embed), /dashboard/network, Réglages › Centrale et › Organisation
      const [row] = await as({ sub: who }, (q) =>
        q(
          `select o.id, o.name, o.slug, o.status, o.logo_url, o.timezone, o.plan_id, o.dispatch_model, o.join_code, o.join_enabled,
                  o.join_auto_approve, o.legal_name, o.currency, o.platform_fee_percent, o.platform_fee_fixed_cents, o.siret, o.email,
                  o.phone, o.address, o.city, o.postal_code, o.vtc_registration
             from public.organization_users ou join public.organizations o on o.id = ou.organization_id
            where ou.user_id = auth.uid()`,
        ),
      );
      expect(row).toMatchObject({ id: org.id, join_code: "abcdef0123456789", platform_fee_fixed_cents: 500 });
      for (const col of ["platform_reminder_note", "platform_reminded_at", "platform_payment_days", "platform_block_after_days",
        "platform_billing_cycle", "stripe_customer_id", "limits_override", "suspended_reason", "ride_counter", "created_by", "*"]) {
        const e = await expectPgError(as({ sub: who }, (q) => q(`select ${col} from public.organizations where id = $1`, [org.id])));
        expect(e.code, col).toBe("42501");
      }
    }

    // Réglages › Organisation (owner / admin) : mise à jour inchangée
    expect(await as({ sub: admin }, (q) => q(`update public.organizations set city = 'Lyon' where id = $1 returning id`, [org.id]))).toHaveLength(1);
    // Relance de Rydar : servie aux owner / admin par org_platform_status, jamais au dispatcher
    expect((await rpc(org.ownerId, "org_platform_status", [org.id])).account.reminder_note).toBe("3 factures impayées");
    expect(await rpc(dispatcher, "org_platform_status", [org.id])).toEqual({ enabled: false });

    // Super admin (session) : listes /admin
    const sa = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [sa]);
    const all = await as({ sub: sa }, (q) => q(`select id, name, slug, status, city, email, created_at, dispatch_model, brand_color, plan_id from public.organizations`));
    expect(all.some((o) => o.id === org.id)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe("Notifications envoyées par Rydar", () => {
  it("relance des frais plateforme : destinataire et owner / admin seulement, pas les dispatchers", async () => {
    const org = await centrale("Droits Notifications");
    const dispatcher = await createMember(org, "dispatcher");
    const admin = await createMember(org, "admin");
    const d = await driverIn(org);
    await sql(
      `select private.queue_whatsapp($1, null, $2, 'platform', '33711223344', 'platform_fee_reminder', 'RELANCE FRAIS PLATEFORME',
         '5 € à régler à Rydar Drive', array['Droits Notifications', '5 €', '05/10/2026'])`,
      [org.id, org.ownerId],
    );
    await sql(`select private.queue_notification($1, $2, null, null, 'settlement_reminder', 'COMMISSION', '19 € à régler', '{}'::jsonb, 'normal', null)`, [
      org.id, d.id,
    ]);
    const types = async (sub: string) =>
      (await as({ sub }, (q) => q(`select type from public.notifications where organization_id = $1 order by type`, [org.id]))).map((r) => r.type);

    expect(await types(dispatcher)).toEqual(["settlement_reminder"]);
    expect(await types(admin)).toEqual(["platform_fee_reminder", "settlement_reminder"]);
    expect(await types(org.ownerId)).toEqual(["platform_fee_reminder", "settlement_reminder"]);
    expect(await types(d.userId)).toEqual(["settlement_reminder"]);
  });
});

// -----------------------------------------------------------------------------
describe("Jetons push et appareils", () => {
  const register = (sub: string, installation: string, token: string | null = null) =>
    rpc(sub, "driver_register_device", [installation, "android", token, "expo"]);

  it("aucune lecture client (membres, chauffeur)", async () => {
    const org = await centrale("Droits Jetons");
    const dispatcher = await createMember(org, "dispatcher");
    const d = await driverIn(org);
    expect(await register(d.userId, `inst-${randomUUID()}`, `ExponentPushToken[${randomUUID()}]`)).toMatchObject({ ok: true, push: true });
    for (const who of [dispatcher, org.ownerId, d.userId]) {
      for (const table of ["push_tokens", "driver_devices"]) {
        expect((await expectPgError(as({ sub: who }, (q) => q(`select * from public.${table}`)))).code, table).toBe("42501");
      }
    }
  });

  it("jeton d'un autre compte : réattribué depuis la même installation seulement", async () => {
    const orgA = await centrale("Droits Jetons A");
    const orgB = await centrale("Droits Jetons B");
    const victim = await driverIn(orgA);
    const attacker = await driverIn(orgB);
    const token = `ExponentPushToken[victim-${randomUUID()}]`;
    const installation = `inst-${randomUUID()}`;
    await register(victim.userId, installation, token);

    // Autre centrale, autre appareil : le jeton reste à la victime
    expect(await register(attacker.userId, `inst-${randomUUID()}`, token)).toMatchObject({ ok: true, push: false });
    expect(await sql(`select driver_id, organization_id, is_active from public.push_tokens where token = $1`, [token])).toEqual([
      { driver_id: victim.id, organization_id: orgA.id, is_active: true },
    ]);
    // Même centrale, autre appareil : idem
    const colleague = await driverIn(orgA);
    expect(await register(colleague.userId, `inst-${randomUUID()}`, token)).toMatchObject({ ok: true, push: false });
    expect((await sql(`select driver_id from public.push_tokens where token = $1`, [token]))[0].driver_id).toBe(victim.id);

    // Téléphone partagé (même installation) : le jeton suit le compte connecté, même dans une autre centrale
    expect(await register(attacker.userId, installation, token)).toMatchObject({ ok: true, push: true });
    expect(await sql(`select driver_id, organization_id from public.push_tokens where token = $1`, [token])).toEqual([
      { driver_id: attacker.id, organization_id: orgB.id },
    ]);
  });

  it("au plus 5 jetons actifs et 10 appareils par chauffeur (les plus récents)", async () => {
    const org = await centrale("Droits Jetons Plafond");
    const d = await driverIn(org);
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      const token = `ExponentPushToken[plafond-${i}-${randomUUID().slice(0, 8)}]`;
      tokens.push(token);
      // Une transaction par appel : horodatages croissants
      await register(d.userId, `inst-plafond-${i}-${randomUUID().slice(0, 6)}`, token);
    }
    const active = await sql(`select token from public.push_tokens where driver_id = $1 and is_active order by updated_at`, [d.id]);
    expect(active.map((r) => r.token)).toEqual(tokens.slice(-5));
    const [devices] = await sql(`select count(*) filter (where revoked_at is null)::int as live, count(*)::int as total from public.driver_devices where driver_id = $1`, [d.id]);
    expect(devices).toEqual({ live: 10, total: 12 });

    // Jeton désactivé par le plafond puis réenregistré : réactivé, le plus ancien sort
    await register(d.userId, `inst-plafond-retour-${randomUUID().slice(0, 6)}`, tokens[0]);
    const again = await sql(`select token from public.push_tokens where driver_id = $1 and is_active`, [d.id]);
    expect(again).toHaveLength(5);
    expect(again.map((r) => r.token)).toContain(tokens[0]);
    expect(again.map((r) => r.token)).not.toContain(tokens[7]);
  });
});

// -----------------------------------------------------------------------------
describe("Justificatifs : visite médicale retirée", () => {
  it("driver_submit_document refuse « medical » (TYPE_NOT_ALLOWED), rien n'est enregistré", async () => {
    const org = await centrale("Droits Médical");
    const d = await driverIn(org);
    const res = await rpc(d.userId, "driver_submit_document", ["medical", null, null, `${org.id}/${d.id}/medical.jpg`, null, null]);
    expect(res).toMatchObject({ ok: false, code: "TYPE_NOT_ALLOWED" });
    expect(await sql(`select 1 from public.driver_documents where driver_id = $1`, [d.id])).toHaveLength(0);
    // Autres types inchangés
    expect(await rpc(d.userId, "driver_submit_document", ["vtc_card", null, null, `${org.id}/${d.id}/vtc.jpg`, null, null])).toMatchObject({
      ok: true, code: "DOCUMENT_SUBMITTED",
    });
  });
});

// -----------------------------------------------------------------------------
describe("Documents légaux : version acceptée", () => {
  const accept = async (sub: string, version: string) =>
    (await as({ sub }, (q) => q(`select public.accept_legal_documents(array['cgu', 'privacy'], $1, null, 'app') as r`, [version])))[0].r;

  it("format AAAA-MM-JJ, date réelle, jamais au-delà du lendemain (heure de Paris)", async () => {
    const org = await createOrg("Droits Légal");
    const [{ today, tomorrow, later }] = await sql(
      `select to_char(d, 'YYYY-MM-DD') as today, to_char(d + 1, 'YYYY-MM-DD') as tomorrow, to_char(d + 2, 'YYYY-MM-DD') as later
         from (select (now() at time zone 'Europe/Paris')::date as d) x`,
    );
    for (const version of ["9999-12-31", later, "n'importe quoi", "2026-02-30", "2026-9-27", "2026-09-27x", "v".repeat(60)]) {
      expect(await accept(org.ownerId, version), version).toMatchObject({ ok: false, code: "INVALID_VERSION" });
    }
    expect(await sql(`select 1 from public.legal_acceptances where user_id = $1`, [org.ownerId])).toHaveLength(0);
    expect(await accept(org.ownerId, today)).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect(await accept(org.ownerId, tomorrow)).toMatchObject({ ok: true, code: "ACCEPTED" });
    expect(await accept(org.ownerId, "2026-01-15")).toMatchObject({ ok: true, code: "ACCEPTED" });
  });
});

// -----------------------------------------------------------------------------
// Stockage (Supabase Storage simulé, comme driver-money-docs.test.ts)
// -----------------------------------------------------------------------------
describe("Justificatifs : quota de dépôts dans le stockage", () => {
  beforeAll(async () => {
    await sql(`create schema if not exists storage`);
    await sql(`create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null,
      name text not null,
      owner uuid,
      created_at timestamptz not null default now(),
      unique (bucket_id, name))`);
    await sql(`alter table storage.objects enable row level security`);
    await sql(`grant usage on schema storage to authenticated`);
    await sql(`grant select, insert, update, delete on storage.objects to authenticated`);
    await sql(`create function storage.foldername(name text) returns text[] language plpgsql as $$
      declare _parts text[];
      begin
        select string_to_array(name, '/') into _parts;
        return _parts[1:array_length(_parts, 1) - 1];
      end $$`);
    await sql(`grant execute on function storage.foldername(text) to authenticated`);
    const [row] = await sql(`select private.install_driver_document_storage_policy() as ok`);
    expect(row.ok).toBe(true);
  });

  afterAll(async () => {
    await sql(`drop schema if exists storage cascade`);
  });

  const upload = (sub: string, name: string) =>
    as({ sub }, (q) => q(`insert into storage.objects (bucket_id, name, owner) values ('driver-documents', $1, $2)`, [name, sub]));

  it("30 dépôts par 24 h (candidat compris), sans récursion ; les dépôts anciens ne comptent pas", async () => {
    const org = await centrale("Droits Stockage");
    const candidate = await driverIn(org, { status: "inactive", application: "pending" });
    const other = await driverIn(org);
    const file = (d: D) => `${org.id}/${d.id}/${randomUUID().slice(0, 8)}.jpg`;

    for (let i = 0; i < 30; i++) await upload(candidate.userId, file(candidate));
    expect((await expectPgError(upload(candidate.userId, file(candidate)))).code).toBe("42501");
    // Quota par chauffeur : un autre chauffeur de la centrale dépose normalement
    await upload(other.userId, file(other));

    // Dépôts de plus de 24 h : ne comptent plus
    await sql(`update storage.objects set created_at = now() - interval '2 days' where name like $1`, [`${org.id}/${candidate.id}/%`]);
    await upload(candidate.userId, file(candidate));
    expect(await as({ sub: candidate.userId }, (q) => q(`select private.driver_document_uploads_24h() as n`))).toEqual([{ n: "1" }]);
  });
});
