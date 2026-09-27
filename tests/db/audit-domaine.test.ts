import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, createOrg, expectPgError, pool, sql } from "./helpers";

// Audit « domaine » (migration 20260924005000) : résolution des hôtes de mini-site, unicité des domaines
// personnalisés vérifiés, fréquence des changements de sous-domaine.

afterAll(async () => {
  await pool.end();
});

const ROOT = "rydar-test.fr";
const sub = () => `s${randomUUID().slice(0, 8)}`;

/** Domaine personnalisé vérifié (deux temps : changer de domaine remet la vérification à zéro, trigger 000700). */
async function verifiedDomain(orgId: string, domain: string) {
  await sql("update public.booking_sites set enabled = true, custom_domain = $2 where organization_id = $1", [orgId, domain]);
  await sql("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1", [orgId]);
}

/** Résolution comme apps/web/proxy.ts (rôle anon, clé publique). */
async function resolve(host: string, root = ROOT): Promise<string | null> {
  const [row] = await as({ role: "anon" }, (q) => q("select public.resolve_booking_host($1, $2) as slug", [host, root]));
  return row.slug;
}

describe("resolve_booking_host : un domaine personnalisé ne capte jamais un hôte de la plateforme", () => {
  it("le sous-domaine d'une centrale reste le sien, qu'une autre centrale plus ancienne OU plus récente ait ce nom en domaine vérifié", async () => {
    // Scénario du TOCTOU (front#3) : un domaine « vérifié » égal au sous-domaine de la victime
    for (const attackerFirst of [true, false]) {
      const first = await createOrg(attackerFirst ? "Pirate" : "Victime");
      const second = await createOrg(attackerFirst ? "Victime" : "Pirate");
      const [attaquant, victime] = attackerFirst ? [first, second] : [second, first];
      const name = sub();
      await sql("update public.booking_sites set enabled = true, subdomain = $2 where organization_id = $1", [victime.id, name]);
      await verifiedDomain(attaquant.id, `${name}.${ROOT}`);
      expect(await resolve(`${name}.${ROOT}`)).toBe(victime.slug);
      expect(await resolve(`${name.toUpperCase()}.${ROOT.toUpperCase()}`)).toBe(victime.slug);
    }
  });

  it("un domaine personnalisé sous le domaine racine (ou le domaine racine) ne se résout jamais", async () => {
    const org = await createOrg("SousRacine");
    const name = sub();
    await verifiedDomain(org.id, `${name}.${ROOT}`);
    expect(await resolve(`${name}.${ROOT}`)).toBeNull();
    const racine = await createOrg("Racine");
    await verifiedDomain(racine.id, ROOT);
    expect(await resolve(ROOT)).toBeNull();
  });

  it("résolutions légitimes inchangées : sous-domaine actif, domaine personnalisé vérifié, rien sinon", async () => {
    const org = await createOrg("Legit");
    const name = sub();
    const domain = `resa-${name}.exemple-vtc.fr`;
    await sql("update public.booking_sites set enabled = true, subdomain = $2, custom_domain = $3 where organization_id = $1", [org.id, name, domain]);
    expect(await resolve(`${name}.${ROOT}`)).toBe(org.slug);
    expect(await resolve(domain)).toBeNull(); // non vérifié
    await sql("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1", [org.id]);
    expect(await resolve(domain)).toBe(org.slug);
    expect(await resolve(`${name}.autre-racine.fr`)).toBeNull();
    expect(await resolve(`x.${name}.${ROOT}`)).toBeNull();
    // Un « _ » du domaine racine n'est pas un joker (ancien LIKE)
    expect(await resolve(`${name}.rydar-testxfr`, "rydar-test_fr")).toBeNull();
    await sql("update public.booking_sites set enabled = false where organization_id = $1", [org.id]);
    expect(await resolve(`${name}.${ROOT}`)).toBeNull();
    expect(await resolve(domain)).toBeNull();
  });
});

describe("booking_sites.custom_domain : unicité sur les seuls domaines vérifiés", () => {
  it("un domaine saisi mais non vérifié ne bloque plus son vrai propriétaire", async () => {
    const squatteur = await createOrg("Squat");
    const proprio = await createOrg("Proprio");
    const domain = `taxi-${sub()}.fr`;
    await as({ sub: squatteur.ownerId }, (q) =>
      q("update public.booking_sites set custom_domain = $2 where organization_id = $1", [squatteur.id, domain]),
    );
    const rows = await as({ sub: proprio.ownerId }, (q) =>
      q("update public.booking_sites set custom_domain = $2 where organization_id = $1 returning custom_domain", [proprio.id, domain]),
    );
    expect(rows).toEqual([{ custom_domain: domain }]);
    // Le premier qui prouve le TXT l'emporte : la seconde vérification échoue (23505)
    await sql("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1 and custom_domain = $2", [proprio.id, domain]);
    const err = await expectPgError(
      sql("update public.booking_sites set custom_domain_verified_at = now() where organization_id = $1 and custom_domain = $2", [squatteur.id, domain]),
    );
    expect(err.code).toBe("23505");
  });

  it("changer de domaine remet la vérification à zéro (trigger inchangé)", async () => {
    const org = await createOrg("Reset");
    await verifiedDomain(org.id, `a-${sub()}.fr`);
    const [row] = await as({ sub: org.ownerId }, (q) =>
      q("update public.booking_sites set custom_domain = $2 where organization_id = $1 returning custom_domain_verified_at", [org.id, `b-${sub()}.fr`]),
    );
    expect(row.custom_domain_verified_at).toBeNull();
  });
});

describe("booking_sites.subdomain : changements limités (certificats HTTPS à la demande)", () => {
  it("5 changements par 7 jours glissants pour la centrale ; un enregistrement sans changement ne compte pas", async () => {
    const org = await createOrg("Renomme");
    const update = (name: string) =>
      as({ sub: org.ownerId }, (q) =>
        q("update public.booking_sites set subdomain = $2, title = 'x' where organization_id = $1 returning subdomain", [org.id, name]),
      );
    let last = "";
    for (let i = 0; i < 5; i += 1) {
      last = sub();
      expect(await update(last)).toEqual([{ subdomain: last }]);
      expect(await update(last)).toEqual([{ subdomain: last }]); // même nom : pas un changement
    }
    const err = await expectPgError(update(sub()));
    expect(err.message).toMatch(/^SUBDOMAIN_CHANGE_LIMIT/);
    const [{ n }] = await sql("select cardinality(subdomain_changes) as n from public.booking_sites where organization_id = $1", [org.id]);
    expect(n).toBe(5);
    // Fenêtre glissante : les changements de plus de 7 jours ne comptent plus
    await sql(
      "update public.booking_sites set subdomain_changes = array(select t - interval '8 days' from unnest(subdomain_changes) t) where organization_id = $1",
      [org.id],
    );
    const next = sub();
    expect(await update(next)).toEqual([{ subdomain: next }]);
    const [{ m }] = await sql("select cardinality(subdomain_changes) as m from public.booking_sites where organization_id = $1", [org.id]);
    expect(m).toBe(1);
  });

  it("le client ne peut pas effacer lui-même l'historique ; le service role (super admin) n'est pas limité", async () => {
    const org = await createOrg("Historique");
    await sql("update public.booking_sites set subdomain_changes = array_fill(now(), array[5]) where organization_id = $1", [org.id]);
    const denied = await expectPgError(
      as({ sub: org.ownerId }, (q) => q("update public.booking_sites set subdomain_changes = '{}' where organization_id = $1", [org.id])),
    );
    expect(denied.code).toBe("42501");
    await expect(
      as({ sub: org.ownerId }, (q) => q("update public.booking_sites set subdomain = $2 where organization_id = $1", [org.id, sub()])),
    ).rejects.toThrow(/SUBDOMAIN_CHANGE_LIMIT/);
    const name = sub();
    const rows = await as({ role: "service_role" }, (q) =>
      q("update public.booking_sites set subdomain = $2 where organization_id = $1 returning subdomain", [org.id, name]),
    );
    expect(rows).toEqual([{ subdomain: name }]);
  });
});
