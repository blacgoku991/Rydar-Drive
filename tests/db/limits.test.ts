import { afterAll, describe, expect, it } from "vitest";
import { as, createDriver, createOrg, expectPgError, pool, sql } from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("Limites des offres SaaS", () => {
  it("max_drivers est appliqué en base", async () => {
    const [plan] = await sql(
      `insert into public.plans (code, name, limits) values ('tiny', 'Tiny', '{"max_drivers":2}') returning id`,
    );
    const org = await createOrg("Tiny", { plan: plan.id });
    await createDriver(org);
    await createDriver(org);
    await expect(createDriver(org)).rejects.toThrow(/PLAN_LIMIT_DRIVERS/);
  });

  it("sans api_access, impossible de créer une clé API", async () => {
    const [plan] = await sql(`insert into public.plans (code, name, limits) values ('noapi', 'NoAPI', '{}') returning id`);
    const org = await createOrg("NoApi", { plan: plan.id });
    await expect(
      sql("insert into public.api_keys (organization_id, name, prefix, last4) values ($1, 'site', 'rdk_live_x', '1234')", [org.id]),
    ).rejects.toThrow(/PLAN_FEATURE_API/);
  });

  it("un dispatcher ne peut pas modifier les réglages (owner/admin uniquement)", async () => {
    const org = await createOrg("Roles");
    const [u] = await sql(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'dispatcher-roles@test.dev') returning id`,
    );
    await sql("insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'dispatcher')", [org.id, u.id]);
    const rows = await as({ sub: u.id }, (q) =>
      q("update public.organization_settings set offer_timeout_seconds = 99 where organization_id = $1 returning 1", [org.id]),
    );
    expect(rows).toHaveLength(0);
    const err = await expectPgError(
      as({ sub: u.id }, (q) => q("update public.organizations set status = 'active' where id = $1", [org.id])),
    );
    expect(err.code).toBe("42501");
  });

  it("audit : suspension d'un chauffeur journalisée", async () => {
    const org = await createOrg("Audit");
    const d = await createDriver(org);
    await as({ sub: org.ownerId }, (q) => q("update public.drivers set status = 'suspended' where id = $1", [d.id]));
    const logs = await sql("select action, severity from public.audit_logs where entity_id = $1 order by id", [d.id]);
    expect(logs.at(-1)).toEqual({ action: "drivers.update", severity: "warning" });
  });
});
