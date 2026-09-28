import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { as, createOrg, expectPgError, pool, sql } from "./helpers";

// Contre-audit « web_api » (web_public#6, sql3#2) : un mini-site dont le sous-domaine EXISTANT est réservé (pris avant
// la migration 004900) enregistre ses autres réglages — le trigger ne refuse qu'un CHANGEMENT de sous-domaine —, et la
// requête de contrôle documentée dans docs/DEPLOYMENT.md (« Mini-sites ») repère ces sous-domaines en production.

afterAll(async () => {
  await pool.end();
});

/** État d'avant la migration 004900 : sous-domaine réservé écrit sans les triggers (superutilisateur, transaction). */
async function legacyReservedSubdomain(orgId: string, subdomain: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.booking_sites set subdomain = $2, enabled = true where organization_id = $1", [orgId, subdomain]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Requête de contrôle, lue telle quelle dans docs/DEPLOYMENT.md. */
function controlQuery(): string {
  const doc = readFileSync(join(__dirname, "..", "..", "docs", "DEPLOYMENT.md"), "utf8");
  const m = /```sql\n(select[^`]*is_reserved_subdomain[^`]*?);?\n```/.exec(doc);
  if (!m) throw new Error("Requête de contrôle des sous-domaines réservés absente de docs/DEPLOYMENT.md");
  return m[1]!;
}

describe("sous-domaine réservé déjà en place (avant la migration 004900)", () => {
  it("l'owner enregistre ses autres réglages (sous-domaine renvoyé tel quel), mais ne peut pas passer à un AUTRE nom réservé", async () => {
    const org = await createOrg("Legacy Reserve");
    const legacy = `rydar-${org.id.slice(0, 6)}`;
    await legacyReservedSubdomain(org.id, legacy);
    // Le formulaire renvoie le sous-domaine actuel à chaque enregistrement (UPDATE OF subdomain, même valeur)
    const [row] = await as({ sub: org.ownerId }, (q) =>
      q("update public.booking_sites set subdomain = $2, title = 'Nouveau titre' where organization_id = $1 returning subdomain, title", [org.id, legacy]),
    );
    expect(row).toEqual({ subdomain: legacy, title: "Nouveau titre" });
    const err = await expectPgError(
      as({ sub: org.ownerId }, (q) => q("update public.booking_sites set subdomain = 'support' where organization_id = $1", [org.id])),
    );
    expect(err.message).toMatch(/^SUBDOMAIN_RESERVED/);
    // Quitter le nom réservé pour un nom ordinaire : accepté
    const [renamed] = await as({ sub: org.ownerId }, (q) =>
      q("update public.booking_sites set subdomain = $2 where organization_id = $1 returning subdomain", [org.id, `centrale-${org.id.slice(0, 6)}`]),
    );
    expect(renamed.subdomain).toBe(`centrale-${org.id.slice(0, 6)}`);
  });

  it("la requête de contrôle de docs/DEPLOYMENT.md liste les sous-domaines réservés déjà pris, et seulement eux", async () => {
    const legacyOrg = await createOrg("Legacy Controle");
    const ordinary = await createOrg("Ordinaire Controle");
    const legacy = `rydar-ctl-${legacyOrg.id.slice(0, 6)}`;
    await legacyReservedSubdomain(legacyOrg.id, legacy);
    const rows = await sql(controlQuery());
    expect(rows).toContainEqual({ organization_id: legacyOrg.id, subdomain: legacy, enabled: true });
    expect(rows.some((r) => r.organization_id === ordinary.id)).toBe(false);
  });
});
