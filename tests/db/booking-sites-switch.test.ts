import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createOrg, createRideAsOwner, expectPgError, pool, setBookingSitesEnabled, sql, type Org } from "./helpers";

// Interrupteur plateforme des mini-sites (migration 20260924006200) : coupé par la migration, réglé par le super admin
// (svc_set_booking_sites_enabled). Coupé : aucun hôte résolu, aucune course « booking_site », réglages figés pour les
// clients ; les réglages de chaque centrale sont conservés et reviennent tels quels.

afterAll(async () => {
  await setBookingSitesEnabled(false);
  await pool.end();
});

const ROOT = "rydar-switch.fr";

async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql("update public.users set is_super_admin = true where id = $1", [id]);
  return id;
}

/** Appel en service role (action serveur du super admin, après requireSuperAdmin). */
async function toggle(actor: string | null, enabled: boolean | null) {
  const [row] = await as({ role: "service_role" }, (q) => q("select public.svc_set_booking_sites_enabled($1, $2) as r", [actor, enabled]));
  return row.r as Record<string, unknown>;
}

/** Résolution comme apps/web/proxy.ts (rôle anon, clé publique) et /api/tls/allowed. */
async function resolve(host: string): Promise<string | null> {
  const [row] = await as({ role: "anon" }, (q) => q("select public.resolve_booking_host($1, $2) as slug", [host, ROOT]));
  return row.slug;
}

const switchState = async () => (await sql("select booking_sites_enabled from public.platform_settings"))[0]?.booking_sites_enabled as boolean;

/** Mini-site publié : sous-domaine + domaine personnalisé vérifié (interrupteur allumé le temps du réglage). */
async function publishedSite(org: Org) {
  const subdomain = `s${randomUUID().slice(0, 8)}`;
  const domain = `resa-${randomUUID().slice(0, 8)}.fr`;
  await setBookingSitesEnabled(true);
  await sql("update public.booking_sites set enabled = true, subdomain = $2, custom_domain = $3, title = 'Titre' where organization_id = $1", [org.id, subdomain, domain]);
  await sql("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1", [org.id]);
  await setBookingSitesEnabled(false);
  return { subdomain, domain };
}

const siteRow = async (orgId: string) =>
  (await sql("select enabled, subdomain, custom_domain, custom_domain_verified_at, title from public.booking_sites where organization_id = $1", [orgId]))[0];

const RIDE = (orgId: string, source: string) => ({
  organization_id: orgId, source, pickup_address: "Gare de Lyon, 75012 Paris", pickup_lat: 48.8443, pickup_lng: 2.3743,
  dropoff_address: "Opéra Garnier, 75009 Paris", dropoff_lat: 48.8719, dropoff_lng: 2.3316, customer_name: "Client Mini-site",
  customer_phone: "+33611223344", passengers: 1, vehicle_category: "business", payment_method: "card",
});

/** Insertion comme submitBooking (service role, aucune session). */
async function insertRideAsService(orgId: string, source: string) {
  const ride = RIDE(orgId, source);
  const cols = Object.keys(ride);
  const params = cols.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) =>
    q(`insert into public.rides (${cols.join(", ")}) values (${params}) returning id, source`, Object.values(ride)),
  );
  return row as { id: string; source: string };
}

describe("migration 20260924006200 : mini-sites coupés", () => {
  it("interrupteur coupé (une seule ligne), lu par booking_sites_enabled(), coupure journalisée", async () => {
    expect(await sql("select id, booking_sites_enabled from public.platform_settings")).toEqual([{ id: true, booking_sites_enabled: false }]);
    const [{ on }] = await as({ role: "service_role" }, (q) => q("select public.booking_sites_enabled() as on"));
    expect(on).toBe(false);
    const logs = await sql(
      "select actor_type, severity, metadata from public.audit_logs where action = 'platform.booking_sites_disabled' and metadata ->> 'source' = 'migration 20260924006200'",
    );
    expect(logs).toEqual([{ actor_type: "system", severity: "warning", metadata: { from: true, to: false, source: "migration 20260924006200" } }]);
  });

  it("ligne absente = coupé (jamais un mini-site servi par défaut)", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from public.platform_settings");
      const { rows } = await client.query("select public.booking_sites_enabled() as on");
      expect(rows[0].on).toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("coupé : mini-sites hors ligne, réglages conservés", () => {
  it("ni sous-domaine ni domaine personnalisé résolus ; la réactivation remet chaque mini-site tel quel", async () => {
    const org = await createOrg("Switch Hote");
    const { subdomain, domain } = await publishedSite(org);
    const before = await siteRow(org.id);
    expect(before).toMatchObject({ enabled: true, subdomain, custom_domain: domain, title: "Titre" });
    expect(before.custom_domain_verified_at).not.toBeNull();

    expect(await resolve(`${subdomain}.${ROOT}`)).toBeNull();
    expect(await resolve(domain)).toBeNull();

    await setBookingSitesEnabled(true);
    expect(await resolve(`${subdomain}.${ROOT}`)).toBe(org.slug);
    expect(await resolve(domain)).toBe(org.slug);
    await setBookingSitesEnabled(false);
    expect(await resolve(`${subdomain}.${ROOT}`)).toBeNull();
    // Rien n'a touché aux réglages de la centrale
    expect(await siteRow(org.id)).toEqual(before);
  });

  it("aucune course « booking_site » (service role comme le mini-site) ; API et dashboard non concernés", async () => {
    const org = await createOrg("Switch Course");
    const err = await expectPgError(insertRideAsService(org.id, "booking_site"));
    expect(err.message).toMatch(/^BOOKING_SITES_DISABLED/);
    expect(err.code).toBe("55000");
    expect(await sql("select count(*)::int as n from public.rides where organization_id = $1", [org.id])).toEqual([{ n: 0 }]);

    expect((await insertRideAsService(org.id, "api")).source).toBe("api");
    expect((await createRideAsOwner(org)).id).toBeTruthy();

    await setBookingSitesEnabled(true);
    expect((await insertRideAsService(org.id, "booking_site")).source).toBe("booking_site");
    await setBookingSitesEnabled(false);
  });

  it("réglages figés pour le client (owner, PostgREST), même un simple titre ; possibles une fois réactivés", async () => {
    const org = await createOrg("Switch Reglages");
    for (const statement of [
      "update public.booking_sites set title = 'Nouveau titre' where organization_id = $1",
      "update public.booking_sites set enabled = false where organization_id = $1",
    ]) {
      const err = await expectPgError(as({ sub: org.ownerId }, (q) => q(statement, [org.id])));
      expect(err.message).toMatch(/^BOOKING_SITES_DISABLED/);
    }
    await setBookingSitesEnabled(true);
    const [row] = await as({ sub: org.ownerId }, (q) =>
      q("update public.booking_sites set title = 'Nouveau titre', enabled = true where organization_id = $1 returning title, enabled", [org.id]),
    );
    expect(row).toEqual({ title: "Nouveau titre", enabled: true });
    await setBookingSitesEnabled(false);
  });

  it("service role et base : ni activation ni vérification de domaine ; les réductions passent (offre rétrogradée)", async () => {
    const org = await createOrg("Switch Service");
    await publishedSite(org);
    // Vérification d'un nouveau domaine (verifyCustomDomain) refusée
    await sql("update public.booking_sites set custom_domain = $2 where organization_id = $1", [org.id, `autre-${randomUUID().slice(0, 6)}.fr`]);
    const verify = await expectPgError(
      as({ role: "service_role" }, (q) => q("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1", [org.id])),
    );
    expect(verify.message).toMatch(/^BOOKING_SITES_DISABLED/);

    // Offre sans mini-site ni domaine : site coupé et domaine dévérifié par private.sync_booking_site_rights
    const other = await createOrg("Switch Retro");
    await publishedSite(other);
    await sql(`update public.organizations set limits_override = '{"booking_site":false,"custom_domain":false}' where id = $1`, [other.id]);
    expect(await siteRow(other.id)).toMatchObject({ enabled: false, custom_domain_verified_at: null });
    // Réactivation directe en base refusée pendant la coupure
    await sql("update public.organizations set limits_override = '{}' where id = $1", [other.id]);
    const enable = await expectPgError(sql("update public.booking_sites set enabled = true where organization_id = $1", [other.id]));
    expect(enable.message).toMatch(/^BOOKING_SITES_DISABLED/);
  });
});

describe("droits : seul le super admin règle l'interrupteur", () => {
  it("clients : ni lecture de la table, ni écriture, ni appel de svc_set_booking_sites_enabled", async () => {
    const org = await createOrg("Switch Droits");
    const sa = await superAdmin();
    // Lecture : super admin seulement (RLS) ; anon sans aucun droit
    expect(await as({ sub: org.ownerId }, (q) => q("select * from public.platform_settings"))).toEqual([]);
    expect((await expectPgError(as({ role: "anon" }, (q) => q("select * from public.platform_settings")))).code).toBe("42501");
    expect(await as({ sub: sa }, (q) => q("select booking_sites_enabled from public.platform_settings"))).toEqual([{ booking_sites_enabled: false }]);
    // Écriture directe : personne, super admin compris (tout passe par svc_set_booking_sites_enabled)
    for (const who of [{ sub: org.ownerId }, { sub: sa }, { role: "anon" as const }]) {
      const w = await expectPgError(as(who, (q) => q("update public.platform_settings set booking_sites_enabled = true")));
      expect(w.code).toBe("42501");
      const i = await expectPgError(as(who, (q) => q("insert into public.platform_settings (id, booking_sites_enabled) values (true, true)")));
      expect(i.code).toBe("42501");
      const f = await expectPgError(as(who, (q) => q("select public.svc_set_booking_sites_enabled($1, true)", [sa])));
      expect(f.code).toBe("42501");
    }
    // Lecture de l'état : dashboard (authenticated) oui, anonyme non (le proxy passe par resolve_booking_host)
    expect((await as({ sub: org.ownerId }, (q) => q("select public.booking_sites_enabled() as on")))[0].on).toBe(false);
    expect((await expectPgError(as({ role: "anon" }, (q) => q("select public.booking_sites_enabled()")))).code).toBe("42501");
    expect(await switchState()).toBe(false);
  });

  it("service role : auteur revérifié (super admin seulement)", async () => {
    const org = await createOrg("Switch Auteur");
    for (const actor of [org.ownerId, null, randomUUID()]) {
      const e = await expectPgError(toggle(actor, true));
      expect(e.code).toBe("42501");
    }
    expect(await switchState()).toBe(false);
  });

  it("super admin : réactive puis recoupe, chaque changement journalisé avec son auteur, sans doublon", async () => {
    const sa = await superAdmin();
    expect(await toggle(sa, null)).toMatchObject({ ok: false, code: "INVALID" });

    expect(await toggle(sa, true)).toEqual({ ok: true, enabled: true, changed: true });
    expect(await switchState()).toBe(true);
    const [row] = await sql("select updated_by from public.platform_settings");
    expect(row.updated_by).toBe(sa);
    expect(await toggle(sa, true)).toEqual({ ok: true, enabled: true, changed: false });
    expect(await toggle(sa, false)).toEqual({ ok: true, enabled: false, changed: true });
    expect(await switchState()).toBe(false);

    const logs = await sql("select action, actor_type, entity_type, metadata from public.audit_logs where actor_user_id = $1 order by id", [sa]);
    expect(logs).toEqual([
      { action: "platform.booking_sites_enabled", actor_type: "super_admin", entity_type: "platform_settings", metadata: { from: false, to: true } },
      { action: "platform.booking_sites_disabled", actor_type: "super_admin", entity_type: "platform_settings", metadata: { from: true, to: false } },
    ]);
  });
});
