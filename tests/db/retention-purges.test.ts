// Conformité — purges de conservation sans décision du propriétaire (20260924007300_retention_purges) : sessions Auth
// inactives depuis 400 jours (ménage horaire), dernière adresse IP d'une clé d'API au bout de 90 jours sans
// utilisation, justificatifs « Visite médicale » (plus d'ajout ni de rappel).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createDriver, createOrg, expectPgError, pool, sql, sqlImport } from "./helpers";

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, any>;
const housekeeping = async () => (await sql("select private.housekeeping() as r"))[0].r as Row;
/** Le passage horaire (journal d'audit et sessions d'Auth) est rejoué au prochain ménage. */
const forgetHourlyRun = () => sql("delete from private.housekeeping_runs where task = 'auth_audit'");

describe("Sessions d'authentification (auth.sessions)", () => {
  it("ménage horaire : sessions sans utilisation depuis plus de 400 jours supprimées (adresse IP, navigateur) ; les autres restent", async () => {
    const user = await createAuthUser(`sessions-${randomUUID().slice(0, 6)}@test.dev`, "Sessions Test");
    const session = async (days: { created: number; updated: number; refreshed: number | null }) =>
      (await sql(
        `insert into auth.sessions (user_id, created_at, updated_at, refreshed_at, ip, user_agent)
         values ($1, now() - make_interval(days => $2), now() - make_interval(days => $3),
                 case when $4::integer is null then null else (now() at time zone 'utc') - make_interval(days => $4::integer) end,
                 '203.0.113.7', 'Mozilla/5.0 (test)')
         returning id`,
        [user, days.created, days.updated, days.refreshed],
      ))[0].id as string;
    const stale = await session({ created: 900, updated: 401, refreshed: 401 });
    const staleNeverRefreshed = await session({ created: 500, updated: 450, refreshed: null });
    const used = await session({ created: 900, updated: 5, refreshed: 5 }); // ancienne mais utilisée
    const recent = await session({ created: 10, updated: 10, refreshed: null });

    await forgetHourlyRun();
    const res = await housekeeping();
    expect(res.errors).toBeUndefined();
    expect(res.auth_sessions_purged).toBeGreaterThanOrEqual(2);
    const left = (await sql(`select id from auth.sessions where id = any ($1::uuid[])`, [[stale, staleNeverRefreshed, used, recent]]))
      .map((x) => x.id).sort();
    expect(left).toEqual([used, recent].sort());

    // Passage suivant dans l'heure : table non reparcourue (comme le journal d'audit d'Auth)
    const again = await housekeeping();
    expect(again.auth_sessions_purged).toBeNull();
    expect(again.errors).toBeUndefined();
  });

  it("purge impossible (droits) : erreur consignée « auth_sessions », le reste du ménage passe", async () => {
    await sql(`create function public.test_block_auth_sessions() returns trigger language plpgsql as $$
               begin raise exception 'permission refusée (test)'; end; $$`);
    await sql("create trigger test_block_auth_sessions before delete on auth.sessions for each row execute function public.test_block_auth_sessions()");
    try {
      const user = await createAuthUser(`sessions-bloc-${randomUUID().slice(0, 6)}@test.dev`, "Sessions Bloc");
      await sql(`insert into auth.sessions (user_id, created_at, updated_at) values ($1, now() - interval '600 days', now() - interval '600 days')`, [user]);
      await forgetHourlyRun();
      const res = await housekeeping();
      expect(res.errors).toEqual({ auth_sessions: expect.stringMatching(/permission refusée/) });
      expect(res.auth_sessions_purged).toBeNull();
      expect(res.auth_audit_purged).not.toBeNull();
    } finally {
      await sql("drop trigger test_block_auth_sessions on auth.sessions");
      await sql("drop function public.test_block_auth_sessions()");
    }
  });
});

describe("Clés d'API : dernière adresse IP d'utilisation", () => {
  it("effacée 90 jours après la dernière utilisation (ou la création si jamais utilisée), sans trace d'audit ; la clé et sa date restent", async () => {
    const org = await createOrg("Purge IP API");
    const key = async (name: string, usedDaysAgo: number | null, createdDaysAgo: number) =>
      (await sql(
        `insert into public.api_keys (organization_id, name, prefix, last4, created_at, last_used_at, last_used_ip)
         values ($1, $2, 'rdk_live_' || substr(md5(random()::text), 1, 6), '0000', now() - make_interval(days => $4),
                 case when $3::integer is null then null else now() - make_interval(days => $3::integer) end, '198.51.100.23')
         returning id`,
        [org.id, name, usedDaysAgo, createdDaysAgo],
      ))[0].id as string;
    const old = await key("ancienne", 91, 400);
    const neverUsed = await key("jamais", null, 120);
    const fresh = await key("récente", 10, 400);
    const auditBefore = (await sql(`select count(*)::int as n from public.audit_logs where organization_id = $1`, [org.id]))[0].n;

    const res = await housekeeping();
    expect(res.api_key_ips_purged).toBeGreaterThanOrEqual(2);
    const rows = await sql(`select id, last_used_ip, last_used_at from public.api_keys where id = any ($1::uuid[])`, [[old, neverUsed, fresh]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[old].last_used_ip).toBeNull();
    expect(byId[old].last_used_at).not.toBeNull();
    expect(byId[neverUsed].last_used_ip).toBeNull();
    expect(byId[fresh].last_used_ip).toBe("198.51.100.23");
    expect((await sql(`select count(*)::int as n from public.audit_logs where organization_id = $1`, [org.id]))[0].n).toBe(auditBefore);
  });
});

describe("Justificatifs « Visite médicale » (donnée de santé)", () => {
  it("plus aucun ajout ni changement de type vers « medical », par aucune voie ; un justificatif hérité reste modifiable, sans rappel", async () => {
    const org = await createOrg("Purge médical");
    const d = await createDriver(org, { firstName: "Medic" });
    // Tableau de bord (droits par colonne, RLS) puis service role : refusés
    const viaDashboard = await expectPgError(as({ sub: org.ownerId }, (q) =>
      q(`insert into public.driver_documents (organization_id, driver_id, type, status) values ($1, $2, 'medical', 'valid')`, [org.id, d.id])));
    expect([viaDashboard.code, viaDashboard.message]).toEqual(["22023", expect.stringContaining("TYPE_NOT_ALLOWED")]);
    const viaService = await expectPgError(
      sql(`insert into public.driver_documents (organization_id, driver_id, type, status) values ($1, $2, 'medical', 'valid')`, [org.id, d.id]));
    expect(viaService.code).toBe("22023");
    const [card] = await sql(
      `insert into public.driver_documents (organization_id, driver_id, type, status, expires_at, reviewed_at)
       values ($1, $2, 'vtc_card', 'valid', current_date + 5, now()) returning id`,
      [org.id, d.id],
    );
    expect((await expectPgError(sql(`update public.driver_documents set type = 'medical' where id = $1`, [card.id]))).code).toBe("22023");

    // Justificatif hérité (mode import : reprise de données, comme le seed) : modifiable (passage à « expiré » par le
    // ménage), jamais rappelé
    const [medical] = await sqlImport(
      `insert into public.driver_documents (organization_id, driver_id, type, status, expires_at, reviewed_at)
       values ($1, $2, 'medical', 'valid', current_date + 5, now()) returning id`,
      [org.id, d.id],
    );
    await sql("select private.document_reminders()");
    const notes = await sql(`select type, title from public.notifications where driver_id = $1 and type like 'document_%'`, [d.id]);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).not.toMatch(/médical/i);
    expect((await sql(`select reminders_sent from public.driver_documents where id = $1`, [medical.id]))[0].reminders_sent).toEqual([]);
    await sql(`update public.driver_documents set expires_at = current_date - 2 where id = $1`, [medical.id]);
    const res = await housekeeping();
    expect(res.errors).toBeUndefined();
    expect((await sql(`select status from public.driver_documents where id = $1`, [medical.id]))[0].status).toBe("expired");
  });
});
