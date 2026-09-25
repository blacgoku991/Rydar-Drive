import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ago, as, createAuthUser, createDriver, createOrg, expectPgError, insertRideBypass, pool, sql, type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

const DAY = 86_400;
const TZ = "Europe/Paris";

// ---------------------------------------------------------------------------
// Utilitaires locaux
// ---------------------------------------------------------------------------
async function addMember(org: Org, role: "owner" | "admin" | "dispatcher"): Promise<string> {
  const id = await createAuthUser(`${role}-${randomUUID().slice(0, 8)}@test.dev`, `${role} ${org.slug}`);
  await sql(`insert into public.organization_users (organization_id, user_id, role) values ($1, $2, $3)`, [org.id, id, role]);
  return id;
}

async function superAdmin(): Promise<string> {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@test.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}

/** Appel d'une fonction en tant qu'utilisateur authentifié ; renvoie la valeur « r ». */
async function call<T = any>(sub: string, text: string, params: unknown[] = []): Promise<T> {
  const [row] = await as({ sub }, (q) => q(`select ${text} as r`, params));
  return row.r as T;
}

/** Date « AAAA-MM-JJ » = aujourd'hui (fuseau org) + n jours. */
async function dayOffset(n: number): Promise<string> {
  const [row] = await sql(`select to_char((now() at time zone '${TZ}')::date + $1::int, 'YYYY-MM-DD') as d`, [n]);
  return row.d;
}

async function localDate(at: Date): Promise<string> {
  const [row] = await sql(`select to_char($1::timestamptz at time zone '${TZ}', 'YYYY-MM-DD') as d`, [at]);
  return row.d;
}

async function insertDoc(
  org: Org,
  d: Driver,
  type: string,
  opts: { days?: number | null; status?: string; createdAgo?: number; label?: string; source?: string } = {},
): Promise<string> {
  const [row] = await sql(
    `insert into public.driver_documents (organization_id, driver_id, type, label, expires_at, status, source, created_at, file_path)
     values ($1::uuid, $2::uuid, $3::public.document_type, $4,
       case when $5::int is null then null else (now() at time zone '${TZ}')::date + $5::int end,
       $6::public.document_status, $7, now() - make_interval(secs => $8), $1::text || '/' || $2::text || '/seed.pdf')
     returning id`,
    [org.id, d.id, type, opts.label ?? null, opts.days === undefined ? null : opts.days, opts.status ?? "valid",
      opts.source ?? "dashboard", opts.createdAgo ?? 0],
  );
  return row.id;
}

const doc = async (id: string) => (await sql(`select * from public.driver_documents where id = $1`, [id]))[0];
const path = (org: Org, d: Driver, file = `${randomUUID().slice(0, 8)}.pdf`) => `${org.id}/${d.id}/${file}`;

function submit(
  d: Driver,
  args: { type: string; number?: string | null; expires?: string | null; path: string | null; issued?: string | null; label?: string | null },
) {
  return call(d.userId, "public.driver_submit_document($1::public.document_type, $2, $3::date, $4, $5::date, $6)", [
    args.type, args.number ?? null, args.expires ?? null, args.path, args.issued ?? null, args.label ?? null,
  ]);
}

const review = (sub: string, id: string, approve: boolean | null, note: string | null = null, expires: string | null = null) =>
  call(sub, "public.review_driver_document($1, $2, $3, $4::date)", [id, approve, note, expires]);

const realtime = (topic: string) =>
  sql(`select event, payload from realtime.messages where topic = $1 and event = 'driver.document' order by id`, [topic]);

const runReminders = async () => (await sql(`select private.document_reminders() as r`))[0].r;

// ---------------------------------------------------------------------------
// Gains
// ---------------------------------------------------------------------------
describe("Gains chauffeur — driver_earnings", () => {
  let org: Org;
  let d: Driver;
  let bounds: { day: Date; week: Date; month: Date };
  let threeDaysAgo: Date;

  beforeAll(async () => {
    org = await createOrg("Gains");
    d = await createDriver(org, { firstName: "Karim" });
    const other = await createDriver(org, { firstName: "Autre" });
    const now = new Date();
    threeDaysAgo = ago(3 * DAY);

    const ride = (fields: Record<string, unknown>) =>
      insertRideBypass(org, { driver_id: d.id, pickup_at: now, completed_at: now, ...fields });

    await ride({ price_cents: 5000, payment_method: "card", estimated_distance_m: 12_000, estimated_duration_s: 1200 });
    await ride({ price_cents: 3000, payment_method: "cash", estimated_distance_m: 8000, estimated_duration_s: 900 });
    await ride({ price_cents: null, estimated_distance_m: 1000 });
    await ride({ price_cents: 7000, pickup_at: ago(3 * DAY + 3600), completed_at: threeDaysAgo, estimated_distance_m: 20_000 });
    await ride({ price_cents: 10_000, pickup_at: ago(40 * DAY), completed_at: ago(40 * DAY) });
    await ride({ status: "CANCELLED", price_cents: 9999, completed_at: null, cancelled_at: now });
    await insertRideBypass(org, { driver_id: other.id, pickup_at: now, completed_at: now, price_cents: 4444 });
    // À venir : planifiée demain, attribuée
    await ride({ status: "ACCEPTED", type: "scheduled", price_cents: 6000, pickup_at: new Date(Date.now() + DAY * 1000), completed_at: null });

    const [b] = await sql(
      `select date_trunc('day', now() at time zone '${TZ}') at time zone '${TZ}' as day,
              date_trunc('week', now() at time zone '${TZ}') at time zone '${TZ}' as week,
              date_trunc('month', now() at time zone '${TZ}') at time zone '${TZ}' as month`,
    );
    bounds = b;
  });

  it("agrège jour / semaine (lundi) / mois dans le fuseau de l'org : seules les courses terminées du chauffeur", async () => {
    const e = await call(d.userId, "public.driver_earnings()");
    const inWeek = threeDaysAgo >= bounds.week;
    const inMonth = threeDaysAgo >= bounds.month;

    expect(e.currency).toBe("EUR");
    expect(e.timezone).toBe(TZ);
    expect(e.commission_percent).toBeNull();
    expect(e.days).toBe(7);
    expect(new Date(e.today.from).getTime()).toBe(bounds.day.getTime());
    expect(new Date(e.week.from).getTime()).toBe(bounds.week.getTime());
    expect(new Date(e.month.from).getTime()).toBe(bounds.month.getTime());

    expect(e.today).toMatchObject({
      rides: 3, revenue_cents: 8000, net_cents: null, commission_cents: null, cash_cents: 3000,
      distance_m: 21_000, duration_s: 2100, unpriced_rides: 1,
    });
    expect(e.week.rides).toBe(3 + (inWeek ? 1 : 0));
    expect(e.week.revenue_cents).toBe(8000 + (inWeek ? 7000 : 0));
    expect(e.month.rides).toBe(3 + (inMonth ? 1 : 0));
    expect(e.month.revenue_cents).toBe(8000 + (inMonth ? 7000 : 0));
    expect(e.month.distance_m).toBe(21_000 + (inMonth ? 20_000 : 0));

    expect(e.upcoming).toEqual({ rides: 1, revenue_cents: 6000, net_cents: null });
  });

  it("net estimé et commission quand la centrale a réglé un pourcentage", async () => {
    const updated = await as({ sub: org.ownerId }, (q) =>
      q(`update public.organization_settings set driver_commission_percent = 20 where organization_id = $1 returning driver_commission_percent`, [org.id]),
    );
    expect(updated).toHaveLength(1);

    const e = await call(d.userId, "public.driver_earnings(7)");
    expect(Number(e.commission_percent)).toBe(20);
    expect(e.today).toMatchObject({ revenue_cents: 8000, net_cents: 6400, commission_cents: 1600 });
    expect(e.upcoming).toEqual({ rides: 1, revenue_cents: 6000, net_cents: 4800 });
    const top = e.recent.find((r: any) => r.price_cents === 5000);
    expect(top.net_cents).toBe(4000);
    expect(e.recent.find((r: any) => r.price_cents === null).net_cents).toBeNull();
    expect(e.series.at(-1).net_cents).toBe(6400);

    await sql(`update public.organization_settings set driver_commission_percent = null where organization_id = $1`, [org.id]);
  });

  it("série quotidienne sur p_days (bornée 1..92) et 20 dernières courses terminées", async () => {
    const e = await call(d.userId, "public.driver_earnings(7)");
    expect(e.series).toHaveLength(7);
    expect(e.series.at(-1)).toMatchObject({ date: await dayOffset(0), rides: 3, revenue_cents: 8000, distance_m: 21_000 });
    expect(e.series[0].date).toBe(await dayOffset(-6));
    const cDate = await localDate(threeDaysAgo);
    expect(e.series.find((s: any) => s.date === cDate)).toMatchObject({ rides: 1, revenue_cents: 7000 });
    expect(e.series.reduce((n: number, s: any) => n + s.rides, 0)).toBe(4);

    expect((await call(d.userId, "public.driver_earnings(0)")).series).toHaveLength(1);
    expect((await call(d.userId, "public.driver_earnings(1000)")).series).toHaveLength(92);
    expect((await call(d.userId, "public.driver_earnings(null)")).series).toHaveLength(7);

    // Dernières courses : terminées uniquement (ni annulée, ni celle d'un autre), plus récente d'abord
    expect(e.recent).toHaveLength(5);
    expect(e.recent.map((r: any) => r.price_cents).slice(-2)).toEqual([7000, 10_000]);
    expect(e.recent[0]).toMatchObject({ pickup: "Place de l'Opéra", dropoff: "Gare de Lyon", currency: "EUR" });
    expect(typeof e.recent[0].number).toBe("number");
    expect(e.recent.some((r: any) => r.price_cents === 9999 || r.price_cents === 4444)).toBe(false);

    const busy = await createDriver(org, { firstName: "Busy" });
    for (let i = 0; i < 22; i++) {
      await insertRideBypass(org, { driver_id: busy.id, pickup_at: ago(i * 3600 + 600), completed_at: ago(i * 3600), price_cents: 1000 + i });
    }
    const b = await call(busy.userId, "public.driver_earnings()");
    expect(b.recent).toHaveLength(20);
    expect(b.recent[0].price_cents).toBe(1000);
    expect(b.recent[19].price_cents).toBe(1019);
  });

  it("réservé au chauffeur actif connecté ; isolation entre chauffeurs et organisations", async () => {
    expect((await expectPgError(call(org.ownerId, "public.driver_earnings()"))).code).toBe("42501");
    const suspended = await createDriver(org, { status: "suspended" });
    expect((await expectPgError(call(suspended.userId, "public.driver_earnings()"))).code).toBe("42501");
    const anon = await expectPgError(as({ role: "anon" }, (q) => q("select public.driver_earnings()")));
    expect(anon.code).toBe("42501");

    const orgB = await createOrg("Gains B");
    const other = await createDriver(orgB);
    const e = await call(other.userId, "public.driver_earnings(30)");
    expect(e.month.rides).toBe(0);
    expect(e.recent).toEqual([]);
    expect(e.upcoming.rides).toBe(0);
  });

  it("réglage de commission : admins seulement, borné 0..100", async () => {
    const dispatcher = await addMember(org, "dispatcher");
    const none = await as({ sub: dispatcher }, (q) =>
      q(`update public.organization_settings set driver_commission_percent = 50 where organization_id = $1 returning 1`, [org.id]),
    );
    expect(none).toHaveLength(0);
    const byDriver = await as({ sub: d.userId }, (q) =>
      q(`update public.organization_settings set driver_commission_percent = 0 where organization_id = $1 returning 1`, [org.id]),
    );
    expect(byDriver).toHaveLength(0);
    const orgB = await createOrg("Commission B");
    const crossTenant = await as({ sub: orgB.ownerId }, (q) =>
      q(`update public.organization_settings set driver_commission_percent = 1 where organization_id = $1 returning 1`, [org.id]),
    );
    expect(crossTenant).toHaveLength(0);

    const tooHigh = await expectPgError(
      as({ sub: org.ownerId }, (q) => q(`update public.organization_settings set driver_commission_percent = 150 where organization_id = $1`, [org.id])),
    );
    expect(tooHigh.code).toBe("23514");
    const [s] = await sql(`select driver_commission_percent from public.organization_settings where organization_id = $1`, [org.id]);
    expect(s.driver_commission_percent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Documents : dépôt par le chauffeur
// ---------------------------------------------------------------------------
describe("Documents — driver_submit_document", () => {
  it("crée un document « pending » + événement et temps réel pour la centrale ; un nouveau dépôt du même type remplace l'attente", async () => {
    const org = await createOrg("Docs Submit");
    const d = await createDriver(org, { firstName: "Karim" });
    const expires = await dayOffset(60);

    const r = await submit(d, { type: "vtc_card", number: " VTC-123 ", expires, path: path(org, d, "carte.pdf") });
    expect(r).toMatchObject({ ok: true, code: "DOCUMENT_SUBMITTED" });
    expect(r.document).toMatchObject({
      type: "vtc_card", label: "Carte VTC", number: "VTC-123", expires_at: expires, status: "pending", days_left: 60,
      source: "driver", driver_id: d.id, file_path: `${org.id}/${d.id}/carte.pdf`,
    });

    const row = await doc(r.document.id);
    expect(row).toMatchObject({ organization_id: org.id, status: "pending", source: "driver", reminders_sent: [] });

    const [ev] = await sql(`select * from public.ride_events where organization_id = $1 and type = 'document.submitted'`, [org.id]);
    expect(ev.ride_id).toBeNull();
    expect(ev.actor_type).toBe("driver");
    expect(ev.actor_id).toBe(d.id);
    expect(ev.message).toContain("a déposé un document à valider : Carte VTC");
    expect(ev.data).toMatchObject({ driver_id: d.id, document_id: r.document.id, document_type: "vtc_card", replaced_ids: [] });
    expect(r.replaced_id).toBeNull();

    const [msg] = await realtime(`org:${org.id}`);
    expect(msg.payload).toMatchObject({ action: "submitted", replaced_ids: [], document: { id: r.document.id }, driver: { id: d.id, first_name: "Karim" } });

    // Nouveau dépôt du même type : l'attente précédente est retirée (jamais modifiée sous les yeux de la centrale)
    const again = await submit(d, { type: "vtc_card", number: "VTC-456", expires: await dayOffset(90), path: path(org, d, "carte-v2.pdf") });
    expect(again).toMatchObject({ ok: true, code: "DOCUMENT_UPDATED", replaced_id: r.document.id });
    expect(again.document.id).not.toBe(r.document.id);
    expect(again.document).toMatchObject({ number: "VTC-456", days_left: 90, file_path: `${org.id}/${d.id}/carte-v2.pdf`, status: "pending" });
    const pending = await sql(`select id from public.driver_documents where driver_id = $1 and type = 'vtc_card'`, [d.id]);
    expect(pending.map((x) => x.id)).toEqual([again.document.id]);
    const last = (await realtime(`org:${org.id}`)).at(-1);
    expect(last.payload.replaced_ids).toEqual([r.document.id]);
    // La centrale qui validait l'ancien fichier ne valide pas le nouveau à l'aveugle
    expect(await review(org.ownerId, r.document.id, true)).toMatchObject({ ok: false, code: "DOCUMENT_NOT_FOUND" });
    expect((await doc(again.document.id)).status).toBe("pending");
    // Un document déjà validé n'est jamais retiré par un nouveau dépôt
    await review(org.ownerId, again.document.id, true);
    const third = await submit(d, { type: "vtc_card", expires: await dayOffset(400), path: path(org, d) });
    expect(third).toMatchObject({ ok: true, code: "DOCUMENT_SUBMITTED", replaced_id: null });
    expect((await doc(again.document.id)).status).toBe("valid");

    // « other » : chaque dépôt est un document distinct
    const o1 = await submit(d, { type: "other", label: "Attestation Kbis", path: path(org, d) });
    const o2 = await submit(d, { type: "other", label: "Photo tenue", path: path(org, d) });
    expect(o1.document.label).toBe("Attestation Kbis");
    expect(o1.document.id).not.toBe(o2.document.id);
  });

  it("refuse les chemins hors du dossier du chauffeur et les valeurs invalides", async () => {
    const org = await createOrg("Docs Invalid");
    const d = await createDriver(org);
    const colleague = await createDriver(org);
    const orgB = await createOrg("Docs Invalid B");
    const foreign = await createDriver(orgB);
    const prefix = `${org.id}/${d.id}/`;

    expect(await submit(d, { type: "vtc_card", path: null })).toMatchObject({ ok: false, code: "FILE_REQUIRED" });
    expect(await submit(d, { type: "vtc_card", path: "   " })).toMatchObject({ ok: false, code: "FILE_REQUIRED" });

    // Dossier d'un autre chauffeur (même org) ou d'une autre organisation → 42501
    for (const p of [path(org, colleague), path(orgB, foreign), `${orgB.id}/${d.id}/x.pdf`, `/${prefix}x.pdf`, `${d.id}/x.pdf`]) {
      expect((await expectPgError(submit(d, { type: "vtc_card", path: p }))).code).toBe("42501");
    }
    for (const p of [prefix, `${prefix}sub/`, `${prefix}../${colleague.id}/x.pdf`, `${prefix}./x.pdf`, `${prefix}a//b.pdf`, `${prefix}${"x".repeat(300)}.pdf`]) {
      expect(await submit(d, { type: "vtc_card", path: p })).toMatchObject({ ok: false, code: "INVALID_FILE_PATH" });
    }
    // Sous-dossier accepté
    expect(await submit(d, { type: "insurance", path: `${prefix}2026/assurance.pdf` })).toMatchObject({ ok: true });

    expect(await submit(d, { type: "vtc_card", path: path(org, d), expires: await dayOffset(-1) }))
      .toMatchObject({ ok: false, code: "DOCUMENT_ALREADY_EXPIRED", message: "Ce document est déjà expiré." });
    expect(await submit(d, { type: "vtc_card", path: path(org, d), expires: "2099-01-01" })).toMatchObject({ ok: false, code: "INVALID_EXPIRY" });
    expect(await submit(d, { type: "vtc_card", path: path(org, d), expires: await dayOffset(10), issued: await dayOffset(-5) }))
      .toMatchObject({ ok: true });
    expect(await submit(d, { type: "identity", path: path(org, d), issued: await dayOffset(1) })).toMatchObject({ ok: false, code: "INVALID_ISSUE_DATE" });
    expect(await submit(d, { type: "identity", path: path(org, d), number: "N".repeat(61) })).toMatchObject({ ok: false, code: "INVALID_NUMBER" });
    expect(await submit(d, { type: "other", path: path(org, d), label: "L".repeat(81) })).toMatchObject({ ok: false, code: "INVALID_LABEL" });
    expect(await submit(d, { type: null as any, path: path(org, d) })).toMatchObject({ ok: false, code: "INVALID_TYPE" });

    // Rien n'a été créé par les appels refusés
    const rows = await sql(`select type from public.driver_documents where driver_id = $1 order by type`, [d.id]);
    expect(rows.map((x) => x.type)).toEqual(["vtc_card", "insurance"]);
  });

  it("réservé aux chauffeurs actifs (rattacheur, anonyme, suspendu → 42501)", async () => {
    const org = await createOrg("Docs Roles");
    const d = await createDriver(org);
    const suspended = await createDriver(org, { status: "suspended" });
    const args = ["vtc_card", null, null, path(org, d), null, null];
    const text = "public.driver_submit_document($1::public.document_type, $2, $3::date, $4, $5::date, $6)";
    expect((await expectPgError(call(org.ownerId, text, args))).code).toBe("42501");
    expect((await expectPgError(call(suspended.userId, text, [...args.slice(0, 3), path(org, suspended), null, null]))).code).toBe("42501");
    expect((await expectPgError(as({ role: "anon" }, (q) => q(`select ${text}`, args)))).code).toBe("42501");
    expect(await sql(`select 1 from public.driver_documents where organization_id = $1`, [org.id])).toHaveLength(0);
  });

  it("limites : 10 documents en attente, 20 dépôts par heure", async () => {
    const org = await createOrg("Docs Limits");
    const d = await createDriver(org);
    for (let i = 0; i < 10; i++) await insertDoc(org, d, "other", { status: "pending", source: "driver" });
    expect(await submit(d, { type: "other", path: path(org, d) })).toMatchObject({ ok: false, code: "TOO_MANY_PENDING" });

    const spam = await createDriver(org);
    await sql(
      `insert into public.ride_events (organization_id, type, message, data)
       select $1, 'document.submitted', 'x', jsonb_build_object('driver_id', $2::uuid) from generate_series(1, 20)`,
      [org.id, spam.id],
    );
    expect(await submit(spam, { type: "vtc_card", path: path(org, spam) })).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    // Les quotas sont par chauffeur
    const fresh = await createDriver(org);
    expect(await submit(fresh, { type: "vtc_card", path: path(org, fresh) })).toMatchObject({ ok: true });
    // Un dépôt du même type qu'un document en attente le remplace, même au plafond
    const [waiting] = await sql(`select id from public.driver_documents where driver_id = $1 limit 1`, [d.id]);
    await sql(`update public.driver_documents set type = 'insurance' where id = $1`, [waiting.id]);
    expect(await submit(d, { type: "insurance", path: path(org, d) })).toMatchObject({ ok: true, code: "DOCUMENT_UPDATED" });
    // Au-delà du plafond (saisies directes) : refus sans rien retirer
    const extra = await insertDoc(org, d, "vtc_card", { status: "pending", source: "driver" });
    expect(await submit(d, { type: "vtc_card", path: path(org, d) })).toMatchObject({ ok: false, code: "TOO_MANY_PENDING" });
    expect((await doc(extra))?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Documents : lecture chauffeur
// ---------------------------------------------------------------------------
describe("Documents — driver_documents", () => {
  it("statut calculé, jours restants, documents remplacés masqués, types manquants", async () => {
    const org = await createOrg("Docs List");
    const d = await createDriver(org);
    const colleague = await createDriver(org);
    await insertDoc(org, d, "vtc_card", { days: 60 });
    await insertDoc(org, d, "driving_license", { days: 10, label: "Permis B" });
    await insertDoc(org, d, "insurance", { days: -1 }); // échu, pas encore basculé
    await insertDoc(org, d, "identity", { status: "pending", days: 3000, source: "driver" });
    const rejected = await insertDoc(org, d, "vehicle_registration", { status: "rejected", createdAgo: 60 });
    const oldMedical = await insertDoc(org, d, "medical", { days: 5, createdAgo: 2 * DAY });
    const newMedical = await insertDoc(org, d, "medical", { days: 700 });
    await insertDoc(org, d, "other", { label: "Kbis" });
    await insertDoc(org, colleague, "vtc_card", { days: 5 });

    const res = await call(d.userId, "public.driver_documents()");
    expect(res.today).toBe(await dayOffset(0));
    const byType = (t: string) => res.documents.filter((x: any) => x.type === t);

    expect(res.documents.map((x: any) => x.type)).toEqual([
      "vtc_card", "driving_license", "identity", "insurance", "vehicle_registration", "medical", "other",
    ]);
    expect(byType("vtc_card")[0]).toMatchObject({ status: "valid", days_left: 60, label: "Carte VTC" });
    expect(byType("driving_license")[0]).toMatchObject({ status: "expiring", days_left: 10, label: "Permis B" });
    expect(byType("insurance")[0]).toMatchObject({ status: "expired", days_left: -1 });
    expect(byType("identity")[0]).toMatchObject({ status: "pending", source: "driver" });
    expect(byType("vehicle_registration")[0]).toMatchObject({ id: rejected, status: "rejected", days_left: null });
    expect(byType("medical")).toHaveLength(1);
    expect(byType("medical")[0].id).toBe(newMedical);
    expect(res.documents.some((x: any) => x.id === oldMedical)).toBe(false);
    expect(byType("other")[0]).toMatchObject({ status: "valid", label: "Kbis", expires_at: null, days_left: null });

    expect(res.summary).toEqual({ valid: 3, expiring: 1, expired: 1, pending: 1, rejected: 1 });
    expect(res.missing_types).toEqual(["insurance", "vehicle_registration"]);

    // Nouveau dépôt après un refus : l'ancien refus disparaît, le type n'est plus manquant
    await submit(d, { type: "vehicle_registration", path: path(org, d) });
    const after = await call(d.userId, "public.driver_documents()");
    expect(after.documents.filter((x: any) => x.type === "vehicle_registration").map((x: any) => x.status)).toEqual(["pending"]);
    expect(after.missing_types).toEqual(["insurance"]);

    // Isolation : le collègue et un chauffeur d'une autre org ne voient que les leurs
    const mine = await call(colleague.userId, "public.driver_documents()");
    expect(mine.documents).toHaveLength(1);
    expect(mine.documents[0].driver_id).toBe(colleague.id);
    const orgB = await createOrg("Docs List B");
    const foreign = await createDriver(orgB);
    const empty = await call(foreign.userId, "public.driver_documents()");
    expect(empty.documents).toEqual([]);
    expect(empty.missing_types).toHaveLength(5);

    expect((await expectPgError(call(org.ownerId, "public.driver_documents()"))).code).toBe("42501");
  });

  it("RLS : un chauffeur ne lit que ses documents ; aucune écriture directe", async () => {
    const org = await createOrg("Docs RLS");
    const d = await createDriver(org);
    const colleague = await createDriver(org);
    await insertDoc(org, d, "vtc_card", { days: 60 });
    const theirs = await insertDoc(org, colleague, "vtc_card", { days: 60 });

    const rows = await as({ sub: d.userId }, (q) => q(`select driver_id from public.driver_documents`));
    expect(rows.every((r) => r.driver_id === d.id)).toBe(true);
    expect(rows).toHaveLength(1);

    const updated = await as({ sub: d.userId }, (q) => q(`update public.driver_documents set status = 'valid' where id = $1 returning 1`, [theirs]));
    expect(updated).toHaveLength(0);
    const err = await expectPgError(
      as({ sub: d.userId }, (q) =>
        q(`insert into public.driver_documents (organization_id, driver_id, type, status) values ($1, $2, 'vtc_card', 'valid')`, [org.id, d.id]),
      ),
    );
    expect(err.code).toBe("42501");
    // Colonnes gérées par les fonctions : non modifiables même par la centrale
    const col = await expectPgError(
      as({ sub: org.ownerId }, (q) => q(`update public.driver_documents set reminders_sent = '{30}' where id = $1`, [theirs])),
    );
    expect(col.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// Documents : validation par la centrale
// ---------------------------------------------------------------------------
describe("Documents — review_driver_document", () => {
  it("validation : statut, échéance corrigée, push chauffeur, journal, temps réel ; l'ancien document est remplacé", async () => {
    const org = await createOrg("Docs Review");
    const d = await createDriver(org, { firstName: "Karim" });
    const dispatcher = await addMember(org, "dispatcher");
    const old = await insertDoc(org, d, "vtc_card", { days: 20, createdAgo: 30 * DAY });
    const sub = await submit(d, { type: "vtc_card", expires: await dayOffset(800), path: path(org, d) });
    const id = sub.document.id;

    const res = await review(dispatcher, id, true, null, await dayOffset(900));
    expect(res).toMatchObject({ ok: true, code: "DOCUMENT_VALIDATED" });
    expect(res.document).toMatchObject({ id, status: "valid", days_left: 900 });

    const row = await doc(id);
    expect(row.status).toBe("valid");
    expect(row.reviewed_by).toBe(dispatcher);
    expect(row.reviewed_at).not.toBeNull();

    const [n] = await sql(`select * from public.notifications where driver_id = $1 and type = 'document_reviewed'`, [d.id]);
    expect(n).toMatchObject({ title: "Document validé", body: "Carte VTC : la centrale a validé votre document.", priority: "normal", ride_id: null });
    expect(n.data).toMatchObject({ type: "document_reviewed", document_id: id, document_type: "vtc_card", status: "valid" });

    const [ev] = await sql(`select * from public.ride_events where organization_id = $1 and type = 'document.validated'`, [org.id]);
    expect(ev).toMatchObject({ level: "success", actor_type: "user", actor_id: dispatcher, ride_id: null });
    expect(ev.message).toBe("Document validé : Carte VTC — Karim Test (#" + d.number + ")");

    const toDriver = await realtime(`driver:${d.id}`);
    expect(toDriver.at(-1).payload).toMatchObject({ action: "validated", document: { id, status: "valid" } });
    const toOrg = await realtime(`org:${org.id}`);
    expect(toOrg.at(-1).payload).toMatchObject({ action: "validated", driver: { id: d.id } });

    // Renouvellement : l'ancienne carte n'est plus affichée ni rappelée
    const list = await call(d.userId, "public.driver_documents()");
    expect(list.documents.map((x: any) => x.id)).toEqual([id]);
    expect((await doc(old)).status).toBe("valid");

    expect(await review(dispatcher, id, false)).toMatchObject({ ok: false, code: "DOCUMENT_NOT_PENDING" });
  });

  it("refus avec motif ; document échu non validable sans nouvelle date ; erreurs", async () => {
    const org = await createOrg("Docs Reject");
    const d = await createDriver(org);
    const admin = await addMember(org, "admin");

    const lic = (await submit(d, { type: "driving_license", path: path(org, d) })).document.id;
    const res = await review(admin, lic, false, "  Photo illisible, merci de renvoyer  ");
    expect(res).toMatchObject({ ok: true, code: "DOCUMENT_REJECTED", document: { status: "rejected", review_note: "Photo illisible, merci de renvoyer" } });
    const [n] = await sql(
      `select title, body, data from public.notifications where driver_id = $1 and type = 'document_reviewed' order by created_at`,
      [d.id],
    );
    expect(n).toMatchObject({ title: "Document refusé", body: "Permis de conduire : Photo illisible, merci de renvoyer" });
    expect(n.data.status).toBe("rejected");
    const [ev] = await sql(`select level, data from public.ride_events where organization_id = $1 and type = 'document.rejected' order by id`, [org.id]);
    expect(ev.level).toBe("warning");
    expect(ev.data.note).toBe("Photo illisible, merci de renvoyer");

    // Déposé valide mais échu entre-temps
    const stale = await insertDoc(org, d, "insurance", { status: "pending", days: -2, source: "driver" });
    expect(await review(admin, stale, true)).toMatchObject({ ok: false, code: "DOCUMENT_EXPIRED" });
    expect(await review(admin, stale, true, null, "2099-01-01")).toMatchObject({ ok: false, code: "INVALID_EXPIRY" });
    expect(await review(admin, stale, true, null, await dayOffset(365))).toMatchObject({ ok: true, document: { status: "valid", days_left: 365 } });

    const other = (await submit(d, { type: "identity", path: path(org, d) })).document.id;
    expect(await review(admin, other, null)).toMatchObject({ ok: false, code: "INVALID_DECISION" });
    expect(await review(admin, other, false, "x".repeat(501))).toMatchObject({ ok: false, code: "INVALID_NOTE" });
    expect(await review(admin, randomUUID(), true)).toMatchObject({ ok: false, code: "DOCUMENT_NOT_FOUND" });
    // Refus sans motif : message par défaut
    await review(admin, other, false);
    const [n2] = await sql(`select body from public.notifications where driver_id = $1 and type = 'document_reviewed' and data->>'document_id' = $2`, [d.id, other]);
    expect(n2.body).toBe("Pièce d'identité : la centrale a refusé ce document. Contactez-la pour en savoir plus.");
  });

  it("isolation et rôles : autre org, chauffeur, super admin → 42501 ; rien n'est modifié", async () => {
    const org = await createOrg("Docs Review Sec");
    const d = await createDriver(org);
    const id = (await submit(d, { type: "vtc_card", path: path(org, d) })).document.id;
    const orgB = await createOrg("Docs Review Sec B");
    const sa = await superAdmin();

    for (const sub of [orgB.ownerId, d.userId, sa]) {
      expect((await expectPgError(review(sub, id, true))).code).toBe("42501");
    }
    expect((await expectPgError(as({ role: "anon" }, (q) => q("select public.review_driver_document($1, true)", [id])))).code).toBe("42501");
    expect((await doc(id)).status).toBe("pending");
    expect(await sql(`select 1 from public.notifications where driver_id = $1 and type = 'document_reviewed'`, [d.id])).toHaveLength(0);
  });

  it("validation directe depuis le dashboard : décision horodatée ; nouvelle échéance → rappels réarmés", async () => {
    const org = await createOrg("Docs Direct");
    const d = await createDriver(org);
    const id = await insertDoc(org, d, "vtc_card", { status: "pending", days: 100, source: "driver" });
    await as({ sub: org.ownerId }, (q) => q(`update public.driver_documents set status = 'valid' where id = $1`, [id]));
    const row = await doc(id);
    expect(row.reviewed_by).toBe(org.ownerId);
    expect(row.reviewed_at).not.toBeNull();

    const expired = await insertDoc(org, d, "insurance", { status: "expired", days: -3 });
    await sql(`update public.driver_documents set reminders_sent = '{30,7,0}' where id = $1`, [expired]);
    await as({ sub: org.ownerId }, (q) =>
      q(`update public.driver_documents set expires_at = (now() at time zone '${TZ}')::date + 200 where id = $1`, [expired]),
    );
    expect(await doc(expired)).toMatchObject({ status: "valid", reminders_sent: [] });
  });
});

// ---------------------------------------------------------------------------
// Documents : vue centrale
// ---------------------------------------------------------------------------
describe("Documents — org_document_alerts", () => {
  it("à valider, échus, bientôt échus (≤ 30 j) avec le chauffeur ; remplacés et chauffeurs archivés exclus", async () => {
    const org = await createOrg("Docs Alerts");
    const d = await createDriver(org, { firstName: "Karim" });
    const archived = await createDriver(org, { status: "inactive" });
    const pending = await insertDoc(org, d, "identity", { status: "pending", days: 3000, source: "driver" });
    const expired = await insertDoc(org, d, "insurance", { status: "expired", days: -4 });
    const lateFlip = await insertDoc(org, d, "vehicle_registration", { status: "valid", days: -1 });
    const expiring = await insertDoc(org, d, "driving_license", { days: 12 });
    await insertDoc(org, d, "vtc_card", { days: 200 });
    await insertDoc(org, d, "medical", { days: 5, createdAgo: DAY }); // remplacé
    await insertDoc(org, d, "medical", { days: 400 });
    await insertDoc(org, d, "other", { status: "rejected" });
    await insertDoc(org, archived, "vtc_card", { status: "expired", days: -10 });
    const orgB = await createOrg("Docs Alerts B");
    const foreign = await createDriver(orgB);
    await insertDoc(orgB, foreign, "vtc_card", { status: "pending", source: "driver" });

    const dispatcher = await addMember(org, "dispatcher");
    const res = await call(dispatcher, "public.org_document_alerts($1)", [org.id]);
    expect(res.today).toBe(await dayOffset(0));
    expect(res.counts).toEqual({ pending: 1, expired: 2, expiring: 1 });
    expect(res.pending.map((x: any) => x.id)).toEqual([pending]);
    expect(res.expired.map((x: any) => x.id)).toEqual([expired, lateFlip]);
    expect(res.expiring.map((x: any) => x.id)).toEqual([expiring]);
    expect(res.expiring[0]).toMatchObject({ days_left: 12, status: "expiring", driver: { id: d.id, first_name: "Karim", number: d.number, status: "active" } });

    // Super admin : lecture ; autre organisation / chauffeur : refus
    const sa = await superAdmin();
    expect((await call(sa, "public.org_document_alerts($1)", [org.id])).counts.pending).toBe(1);
    expect((await expectPgError(call(orgB.ownerId, "public.org_document_alerts($1)", [org.id]))).code).toBe("42501");
    expect((await expectPgError(call(d.userId, "public.org_document_alerts($1)", [org.id]))).code).toBe("42501");
    const b = await call(orgB.ownerId, "public.org_document_alerts($1)", [orgB.id]);
    expect(b.counts).toEqual({ pending: 1, expired: 0, expiring: 0 });
    expect(b.pending[0].driver.id).toBe(foreign.id);
  });
});

// ---------------------------------------------------------------------------
// Documents : tâche quotidienne du worker
// ---------------------------------------------------------------------------
describe("Documents — private.document_reminders", () => {
  it("bascule les échus, notifie à J-30 / J-7 / échéance une seule fois par seuil, informe la centrale", async () => {
    const org = await createOrg("Docs Reminders");
    const d = await createDriver(org, { firstName: "Karim" });
    const inactive = await createDriver(org, { status: "inactive" });
    const in25 = await insertDoc(org, d, "vtc_card", { days: 25 });
    const in5 = await insertDoc(org, d, "driving_license", { days: 5 });
    const today = await insertDoc(org, d, "identity", { days: 0 });
    const past2 = await insertDoc(org, d, "insurance", { days: -2 });
    const past30 = await insertDoc(org, d, "vehicle_registration", { days: -30 });
    const far = await insertDoc(org, d, "other", { days: 200, label: "Kbis" });
    const replaced = await insertDoc(org, d, "medical", { days: 3, createdAgo: DAY });
    await insertDoc(org, d, "medical", { days: 400 });
    const pending = await insertDoc(org, d, "other", { status: "pending", days: 3, source: "driver" });
    const sleeping = await insertDoc(org, inactive, "vtc_card", { days: 5 });

    const summary = await runReminders();
    expect(summary.reminders).toBeGreaterThanOrEqual(4);
    expect(summary.expired).toBeGreaterThanOrEqual(2);

    const notifs = await sql(`select * from public.notifications where organization_id = $1 order by created_at, title`, [org.id]);
    const of = (id: string) => notifs.filter((n) => n.data.document_id === id);

    expect(of(in25)).toHaveLength(1);
    expect(of(in25)[0]).toMatchObject({ type: "document_expiring", title: "Carte VTC expire dans 25 jours", priority: "normal", driver_id: d.id });
    expect(of(in25)[0].data).toMatchObject({ threshold: 30, days_left: 25, document_type: "vtc_card" });
    expect(of(in5)[0]).toMatchObject({ type: "document_expiring", title: "Permis de conduire expire dans 5 jours", priority: "high" });
    expect(of(in5)[0].data.threshold).toBe(7);
    expect(of(today)[0]).toMatchObject({ type: "document_expiring", title: "Pièce d'identité expire aujourd'hui" });
    expect(of(today)[0].data.threshold).toBe(0);
    expect(of(past2)[0]).toMatchObject({ type: "document_expired", title: "Document expiré : Attestation d'assurance" });
    expect(of(past2)[0].body).toContain("Échéance dépassée depuis le");
    for (const id of [past30, far, replaced, pending, sleeping]) expect(of(id)).toHaveLength(0);
    for (const n of notifs) expect(new Date(n.scheduled_for).getTime()).toBeGreaterThanOrEqual(new Date(n.created_at).getTime() - 1000);

    expect(await doc(in25)).toMatchObject({ status: "valid", reminders_sent: [30] });
    expect(await doc(in5)).toMatchObject({ status: "valid", reminders_sent: [30, 7] });
    expect(await doc(today)).toMatchObject({ status: "valid", reminders_sent: [30, 7, 0] });
    expect(await doc(past2)).toMatchObject({ status: "expired", reminders_sent: [30, 7, 0] });
    expect(await doc(past30)).toMatchObject({ status: "expired", reminders_sent: [30, 7, 0] }); // marqué sans notifier
    expect((await doc(far)).reminders_sent).toEqual([]);
    expect((await doc(sleeping)).reminders_sent).toEqual([]);
    expect((await doc(pending)).status).toBe("pending");

    // Centrale : journal à J-7 et à l'échéance seulement
    const events = await sql(`select type, level, message, data from public.ride_events where organization_id = $1 order by id`, [org.id]);
    const evOf = (id: string) => events.filter((e) => e.data.document_id === id);
    expect(evOf(in25)).toHaveLength(0);
    expect(evOf(in5)[0]).toMatchObject({ type: "document.expiring", level: "warning" });
    expect(evOf(in5)[0].message).toBe(`Permis de conduire de Karim Test (#${d.number}) : expire dans 5 jours`);
    expect(evOf(today)[0].message).toContain("expire aujourd'hui");
    expect(evOf(past2)[0]).toMatchObject({ type: "document.expired" });
    expect(evOf(past2)[0].message).toContain("Attestation d'assurance de Karim Test");

    const rt = await realtime(`org:${org.id}`);
    expect(rt.map((m) => m.payload.document.id).sort()).toEqual([in25, in5, today, past2].sort());
    expect(rt.find((m) => m.payload.document.id === past2).payload).toMatchObject({ action: "expired", threshold: 0, driver: { id: d.id } });
    expect((await realtime(`driver:${d.id}`)).length).toBe(4);

    // Idempotent : un second passage n'envoie rien de plus
    await runReminders();
    const again = await sql(`select count(*)::int as n from public.notifications where organization_id = $1`, [org.id]);
    expect(again[0].n).toBe(notifs.length);

    // Le temps passe : J-30 déjà envoyé → J-7 envoyé à son tour
    await sql(`update public.driver_documents set expires_at = expires_at - 20 where id = $1`, [in25]);
    expect((await doc(in25)).reminders_sent).toEqual([]); // nouvelle échéance → réarmé…
    await sql(`update public.driver_documents set reminders_sent = '{30}' where id = $1`, [in25]); // …on simule le temps écoulé
    await runReminders();
    expect((await sql(`select data from public.notifications where data->>'document_id' = $1 order by created_at`, [in25])).map((n) => n.data.threshold))
      .toEqual([30, 7]);

    // Renouvellement par la centrale (nouvelle date) : rappels réarmés
    await as({ sub: org.ownerId }, (q) => q(`update public.driver_documents set expires_at = expires_at + 400 where id = $1`, [in5]));
    expect((await doc(in5)).reminders_sent).toEqual([]);
  });

  it("réservée au service (worker) : refusée aux utilisateurs", async () => {
    const org = await createOrg("Docs Reminders Sec");
    const d = await createDriver(org);
    expect((await expectPgError(call(org.ownerId, "private.document_reminders()"))).code).toBe("42501");
    expect((await expectPgError(call(d.userId, "private.document_reminders()"))).code).toBe("42501");
    const res = await as({ role: "service_role" }, (q) => q("select private.document_reminders() as r"));
    expect(res[0].r).toHaveProperty("reminders");
  });
});

// ---------------------------------------------------------------------------
// Stockage (Supabase Storage simulé) : dépôt dans son propre dossier
// ---------------------------------------------------------------------------
describe("Documents — stockage driver-documents", () => {
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
    // Lecture ouverte dans le simulacre : seules les politiques d'écriture sont testées ici
    await sql(`create policy stub_read on storage.objects for select to authenticated using (true)`);
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

  const upload = (sub: string, bucket: string, name: string) =>
    as({ sub }, (q) => q(`insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)`, [bucket, name, sub]));

  it("un chauffeur dépose dans driver-documents/{org}/{driver}/ uniquement", async () => {
    const org = await createOrg("Docs Storage");
    const d = await createDriver(org);
    const colleague = await createDriver(org);
    const orgB = await createOrg("Docs Storage B");
    const foreign = await createDriver(orgB);

    await upload(d.userId, "driver-documents", path(org, d, "carte.pdf"));
    await upload(d.userId, "driver-documents", `${org.id}/${d.id}/2026/permis.jpg`);
    for (const [bucket, name] of [
      ["driver-documents", path(org, colleague)],
      ["driver-documents", path(orgB, foreign)],
      ["driver-documents", `${orgB.id}/${d.id}/x.pdf`],
      ["driver-documents", `${org.id}/x.pdf`],
      ["driver-photos", path(org, d)],
    ]) {
      expect((await expectPgError(upload(d.userId, bucket, name))).code).toBe("42501");
    }
    // Un rattacheur n'utilise pas ce chemin (politique chauffeur uniquement)
    expect((await expectPgError(upload(org.ownerId, "driver-documents", path(org, d)))).code).toBe("42501");
    // Pas d'écrasement ni de suppression d'un fichier déposé (insertion seule)
    const own = path(org, d, "carte.pdf");
    const upd = await as({ sub: d.userId }, (q) => q(`update storage.objects set owner = null where name = $1 returning 1`, [own]));
    expect(upd).toHaveLength(0);
    const del = await as({ sub: d.userId }, (q) => q(`delete from storage.objects where name = $1 returning 1`, [own]));
    expect(del).toHaveLength(0);
    expect(await sql(`select 1 from storage.objects where name = $1`, [own])).toHaveLength(1);
  });

  it("driver_submit_document vérifie que le fichier existe dans le bucket", async () => {
    const org = await createOrg("Docs Storage Check");
    const d = await createDriver(org);
    const p = path(org, d, "vtc.pdf");
    expect(await submit(d, { type: "vtc_card", path: p })).toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
    await upload(d.userId, "driver-documents", p);
    expect(await submit(d, { type: "vtc_card", path: p })).toMatchObject({ ok: true, code: "DOCUMENT_SUBMITTED" });
    // Même nom dans un autre bucket : ne compte pas
    const q = path(org, d, "photo.jpg");
    await sql(`insert into storage.objects (bucket_id, name) values ('driver-photos', $1)`, [q]);
    expect(await submit(d, { type: "identity", path: q })).toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
  });
});
