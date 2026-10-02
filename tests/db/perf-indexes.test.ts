import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createAuthUser, createDriver, createMember, createOrg, expectPgError, pool, sql, type Driver, type Org } from "./helpers";

// Migration 20260924006500_perf_indexes : index des lectures fréquentes d'une centrale, et public.chat_counts (compteurs
// du menu « Messages ») qui doit donner EXACTEMENT les mêmes valeurs que chat_overview.unread_total / open_reports.

afterAll(async () => {
  await pool.end();
});

const counts = async (sub: string, org: string) => (await as({ sub }, (q) => q("select public.chat_counts($1) as c", [org])))[0].c;
const overview = async (sub: string, org: string) => (await as({ sub }, (q) => q("select public.chat_overview($1) as o", [org])))[0].o;

type Msg = {
  channel: "fleet" | "driver";
  driver?: Driver;
  by: { user: string } | { driver: Driver } | "system";
  minutesAgo: number;
  deleted?: boolean;
};

async function message(org: Org, m: Msg): Promise<string> {
  const user = typeof m.by === "object" && "user" in m.by ? m.by.user : null;
  const author = typeof m.by === "object" && "driver" in m.by ? m.by.driver.id : null;
  const [row] = await sql(
    `insert into public.chat_messages (organization_id, channel, driver_id, author_type, author_user_id, author_driver_id, author_name, body,
       created_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, 'Auteur', 'Message', now() - make_interval(mins => $7), case when $8 then now() end)
     returning id`,
    [org.id, m.channel, m.driver?.id ?? null, user ? "user" : author ? "driver" : "system", user, author, m.minutesAgo, !!m.deleted],
  );
  // Horodatage fixé à la validation (déclencheur chat_messages_stamp_commit) : antidaté ensuite
  await sql(`update public.chat_messages set created_at = now() - make_interval(mins => $2) where id = $1`, [row.id, m.minutesAgo]);
  return row.id;
}

async function markRead(org: Org, user: string, thread: string, minutesAgo: number) {
  await sql(
    `insert into public.chat_reads (organization_id, reader_key, thread_key, last_read_at) values ($1, $2, $3, now() - make_interval(mins => $4))
     on conflict (organization_id, reader_key, thread_key) do update set last_read_at = excluded.last_read_at`,
    [org.id, `user:${user}`, thread, minutesAgo],
  );
}

async function report(org: Org, messageId: string, reporter: Driver, status: "open" | "dismissed" = "open") {
  await sql(
    `insert into public.chat_message_reports (organization_id, message_id, reporter_type, reporter_driver_id, status, resolved_at)
     values ($1, $2, 'driver', $3, $4, case when $4 = 'open' then null else now() end)`,
    [org.id, messageId, reporter.id, status],
  );
}

describe("chat_counts : mêmes compteurs que chat_overview, sans la liste des fils", () => {
  let A: Org;
  let B: Org;
  let dispatcher: string;
  let rootId: string;
  let d1: Driver;
  let d2: Driver;
  let d3: Driver;

  beforeAll(async () => {
    A = await createOrg("Compteurs Messages A");
    B = await createOrg("Compteurs Messages B");
    dispatcher = await createMember(A, "dispatcher", "Dispatch A");
    rootId = await createAuthUser(`root-compteurs-${Date.now()}@test.dev`, "Root");
    await sql(`update public.users set is_super_admin = true where id = $1`, [rootId]);
    d1 = await createDriver(A, { firstName: "Actif" });
    d2 = await createDriver(A, { firstName: "Suspendu", status: "suspended" });
    d3 = await createDriver(A, { firstName: "Muet" });

    const m1 = await message(A, { channel: "fleet", by: { driver: d1 }, minutesAgo: 50 });
    await message(A, { channel: "fleet", by: { user: dispatcher }, minutesAgo: 40 });
    await message(A, { channel: "fleet", by: { user: A.ownerId }, minutesAgo: 35 });
    const m4 = await message(A, { channel: "fleet", by: { driver: d1 }, minutesAgo: 30, deleted: true });
    await message(A, { channel: "driver", driver: d1, by: { driver: d1 }, minutesAgo: 45 });
    await message(A, { channel: "driver", driver: d1, by: { user: A.ownerId }, minutesAgo: 44 });
    await message(A, { channel: "driver", driver: d1, by: { driver: d1 }, minutesAgo: 5, deleted: true });
    // Chauffeur suspendu : son fil compte encore (chat_overview le liste parce qu'il a des messages)
    await message(A, { channel: "driver", driver: d2, by: { driver: d2 }, minutesAgo: 20 });
    const m8 = await message(A, { channel: "fleet", by: "system", minutesAgo: 10 });
    // Autre centrale : jamais comptée
    const dB = await createDriver(B, { firstName: "Ailleurs" });
    await message(B, { channel: "fleet", by: { driver: dB }, minutesAgo: 15 });
    await message(B, { channel: "driver", driver: dB, by: { driver: dB }, minutesAgo: 15 });

    // Lectures du gérant : fil flotte lu il y a 38 min (m1 et m2 lus, m8 non), fil de d2 lu il y a 25 min (m7 non lu)
    await markRead(A, A.ownerId, "fleet", 38);
    await markRead(A, A.ownerId, `driver:${d2.id}`, 25);
    // Lecture d'un AUTRE utilisateur : sans effet sur le gérant
    await markRead(A, dispatcher, `driver:${d1.id}`, 1);

    await report(A, m1, d2); // ouvert, compté
    await report(A, m1, d3); // même message : compté une fois
    await report(A, m4, d2); // message retiré : non compté
    await report(A, m8, d3, "dismissed"); // traité : non compté
  });

  it("gérant : non-lus après SA dernière lecture, ses propres messages et les messages retirés exclus", async () => {
    expect(await counts(A.ownerId, A.id)).toEqual({ unread_total: 3, open_reports: 1 });
  });

  it("égalité avec chat_overview pour le gérant, un dispatcher et le super admin", async () => {
    for (const who of [A.ownerId, dispatcher, rootId]) {
      const o = await overview(who, A.id);
      expect(await counts(who, A.id)).toEqual({ unread_total: o.unread_total, open_reports: o.open_reports });
    }
  });

  it("après lecture d'un fil : les deux lectures restent égales", async () => {
    await markRead(A, dispatcher, "fleet", 0);
    const o = await overview(dispatcher, A.id);
    const c = await counts(dispatcher, A.id);
    expect(c).toEqual({ unread_total: o.unread_total, open_reports: o.open_reports });
    expect(c.unread_total).toBe(1); // seul le message de d2 (fil de d1 lu il y a 1 min, flotte lue)
  });

  it("accès : réservé aux membres de la centrale (ou super admin) ; chauffeur et anonyme refusés", async () => {
    expect((await expectPgError(counts(B.ownerId, A.id))).code).toBe("42501");
    expect((await expectPgError(counts(d1.userId, A.id))).code).toBe("42501");
    const anon = await expectPgError(as({ role: "anon" }, (q) => q("select public.chat_counts($1)", [A.id])));
    expect(anon.code).toBe("42501");
  });
});

describe("Index de lecture des centrales", () => {
  it("présents avec la définition attendue", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'
         and indexname in ('rides_org_open_pickup_idx', 'ride_offers_org_sent_idx', 'ride_events_org_id_idx') order by 1`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(["ride_events_org_id_idx", "ride_offers_org_sent_idx", "rides_org_open_pickup_idx"]);
    const open = rows.find((r) => r.indexname === "rides_org_open_pickup_idx")!.indexdef;
    expect(open).toMatch(/\(organization_id, pickup_at\)/);
    expect(open).toMatch(/COMPLETED.*CANCELLED.*NO_DRIVER_FOUND/);
  });
});
