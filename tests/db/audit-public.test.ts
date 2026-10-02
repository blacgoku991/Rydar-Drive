import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVED_SUBDOMAINS } from "../../packages/shared/src/schemas";
import { as, createOrg, expectPgError, pool, setBookingSitesEnabled, sql } from "./helpers";

// Audit « public » (migration 004900) : sous-domaines réservés à la plateforme et mini-site / domaine
// personnalisé coupés quand l'offre ne les inclut plus.

// Mini-sites servis pendant ce fichier (interrupteur plateforme, migration 20260924006200 : coupé par défaut)
beforeAll(() => setBookingSitesEnabled(true));

afterAll(async () => {
  await setBookingSitesEnabled(false);
  await pool.end();
});

const ROOT = "rydardrive.fr";
const resolve = async (host: string) =>
  (await as({ role: "anon" }, (q) => q("select public.resolve_booking_host($1, $2) as slug", [host, ROOT])))[0].slug as string | null;

describe("sous-domaines réservés", () => {
  it("un owner ne peut pas publier son mini-site sur admin. / support. / rydar-… (PostgREST contourne zod)", async () => {
    const org = await createOrg("Reserve A");
    for (const sub of ["admin", "support", "login", "rydar-aide", "RydarDrive"]) {
      const err = await expectPgError(
        as({ sub: org.ownerId }, (q) => q("update public.booking_sites set subdomain = $2, enabled = true where organization_id = $1", [org.id, sub])),
      );
      expect(err.message, sub).toMatch(/SUBDOMAIN_RESERVED/);
    }
    expect(await resolve(`support.${ROOT}`)).toBeNull();
  });

  it("un sous-domaine ordinaire reste libre, et le modifier puis garder le même nom fonctionne", async () => {
    const org = await createOrg("Reserve B");
    const sub = `vtc-support-${org.id.slice(0, 6)}`;
    await as({ sub: org.ownerId }, (q) => q("update public.booking_sites set subdomain = $2, enabled = true where organization_id = $1", [org.id, sub]));
    await as({ sub: org.ownerId }, (q) => q("update public.booking_sites set subdomain = $2, title = 'Titre' where organization_id = $1", [org.id, sub]));
    expect(await resolve(`${sub}.${ROOT}`)).toBe(org.slug);
  });

  it("création d'une centrale à l'identifiant réservé : mini-site créé sans sous-domaine (pas d'échec)", async () => {
    const [org] = await sql(`insert into public.organizations (name, slug) values ('Support', 'support') returning id`);
    const [site] = await sql("select subdomain from public.booking_sites where organization_id = $1", [org.id]);
    expect(site.subdomain).toBeNull();
  });

  it("même liste en SQL et dans @rydar/shared", async () => {
    for (const s of RESERVED_SUBDOMAINS) {
      const [{ r }] = await sql("select private.is_reserved_subdomain($1) as r", [s]);
      expect(r, s).toBe(true);
    }
    const [{ n }] = await sql("select private.is_reserved_subdomain('elite-paris') as n");
    expect(n).toBe(false);
  });
});

describe("droits de l'offre : mini-site et domaine personnalisé", () => {
  async function setup(name: string) {
    const [full] = await sql(
      `insert into public.plans (code, name, limits) values ($1, 'Complète', '{"api_access":true,"booking_site":true,"custom_domain":true}') returning id`,
      [`full_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`],
    );
    const org = await createOrg(name, { plan: full.id });
    const domain = `resa-${org.id.slice(0, 8)}.example.test`;
    await sql(
      "update public.booking_sites set enabled = true, custom_domain = $2 where organization_id = $1",
      [org.id, domain],
    );
    await sql("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1", [org.id]);
    const [site] = await sql("select subdomain from public.booking_sites where organization_id = $1", [org.id]);
    return { org, planId: full.id as string, domain, subdomain: site.subdomain as string };
  }
  const site = async (orgId: string) => (await sql("select enabled, custom_domain_verified_at from public.booking_sites where organization_id = $1", [orgId]))[0];

  it("passage à une offre sans mini-site (super admin / Stripe, service role) : site coupé, domaine à revérifier", async () => {
    const { org, domain, subdomain } = await setup("Droits Retrogradee");
    expect(await resolve(domain)).toBe(org.slug);
    const [basic] = await sql(`insert into public.plans (code, name, limits) values ('basic_audit_public', 'Basique', '{"api_access":true}') returning id`);
    await as({ role: "service_role" }, (q) => q("update public.organizations set plan_id = $2 where id = $1", [org.id, basic.id]));
    const s = await site(org.id);
    expect(s.enabled).toBe(false);
    expect(s.custom_domain_verified_at).toBeNull();
    expect(await resolve(domain)).toBeNull();
    expect(await resolve(`${subdomain}.${ROOT}`)).toBeNull();
  });

  it("domaine personnalisé retiré par surcharge : domaine à revérifier, mini-site maintenu", async () => {
    const { org, domain, subdomain } = await setup("Droits Surcharge");
    await sql(`update public.organizations set limits_override = '{"custom_domain":false}' where id = $1`, [org.id]);
    const s = await site(org.id);
    expect(s.enabled).toBe(true);
    expect(s.custom_domain_verified_at).toBeNull();
    expect(await resolve(domain)).toBeNull();
    expect(await resolve(`${subdomain}.${ROOT}`)).toBe(org.slug);
  });

  it("limites de l'offre modifiées : sites de toutes ses centrales coupés", async () => {
    const { org, planId } = await setup("Droits Offre Modifiee");
    await sql(`update public.plans set limits = '{"api_access":true}' where id = $1`, [planId]);
    expect((await site(org.id)).enabled).toBe(false);
  });

  it("centrale sans offre : tout reste autorisé", async () => {
    const { org, domain } = await setup("Droits Sans Offre");
    await sql("update public.organizations set plan_id = null where id = $1", [org.id]);
    const s = await site(org.id);
    expect(s.enabled).toBe(true);
    expect(s.custom_domain_verified_at).not.toBeNull();
    expect(await resolve(domain)).toBe(org.slug);
  });

  it("autre changement de la centrale (nom) : aucun effet", async () => {
    const { org } = await setup("Droits Nom");
    await sql(`update public.plans set limits = limits where id = (select plan_id from public.organizations where id = $1)`, [org.id]);
    await sql("update public.organizations set name = 'Nouveau nom' where id = $1", [org.id]);
    expect((await site(org.id)).enabled).toBe(true);
  });
});
