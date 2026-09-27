import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { as, createDriver, createOrg, pool, sql, type Driver, type Org } from "./helpers";

// Audit « robustesse-web » — flux-annexes#5 : private.document_reminders ne demande plus de déposer le nouveau
// document quand le chauffeur l'a déjà déposé (renouvellement en attente de validation par la centrale).

afterAll(async () => {
  await pool.end();
});

const TZ = "Europe/Paris";
const DAY = 86_400;

async function insertDoc(org: Org, d: Driver, type: string, days: number, opts: { label?: string; createdAgo?: number } = {}) {
  const [row] = await sql(
    `insert into public.driver_documents (organization_id, driver_id, type, label, expires_at, status, source, created_at, file_path)
     values ($1::uuid, $2::uuid, $3::public.document_type, $4, (now() at time zone '${TZ}')::date + $5::int, 'valid', 'dashboard',
       now() - make_interval(secs => $6), $1::text || '/' || $2::text || '/ancien.pdf')
     returning id`,
    [org.id, d.id, type, opts.label ?? null, days, opts.createdAgo ?? 365 * DAY],
  );
  return row.id as string;
}

/** Dépôt réel par le chauffeur (RPC de l'application), en attente de validation. */
async function submit(d: Driver, org: Org, type: string, days: number | null, label: string | null = null) {
  const [row] = await as({ sub: d.userId }, (q) =>
    q(
      `select public.driver_submit_document($1::public.document_type, null, case when $2::int is null then null
         else (now() at time zone '${TZ}')::date + $2::int end, $3, null, $4) as r`,
      [type, days, `${org.id}/${d.id}/${randomUUID().slice(0, 8)}.pdf`, label],
    ),
  );
  expect(row.r.ok).toBe(true);
  return row.r;
}

const run = async () => (await sql(`select private.document_reminders() as r`))[0].r;
const notifOf = async (docId: string) =>
  sql(`select type, title, body, priority, data from public.notifications where data->>'document_id' = $1 order by created_at`, [docId]);
const eventOf = async (docId: string) =>
  sql(`select type, message, data from public.ride_events where data->>'document_id' = $1 order by id`, [docId]);

describe("Documents — rappel d'échéance avec un renouvellement déjà déposé (flux-annexes#5)", () => {
  it("J-5 : le chauffeur n'est plus invité à redéposer ; la centrale sait qu'un document est à valider", async () => {
    const org = await createOrg("Audit Robustesse Docs");
    const d = await createDriver(org, { firstName: "Karim" });
    const old = await insertDoc(org, d, "insurance", 5);
    await submit(d, org, "insurance", 370);

    await run();
    const [n] = await notifOf(old);
    expect(n).toMatchObject({ type: "document_expiring", title: "Attestation d'assurance expire dans 5 jours", priority: "normal" });
    expect(n.body).not.toContain("Déposez");
    expect(n.body).toMatch(/^Échéance le \d{2}\/\d{2}\/\d{4}\. Votre nouveau document est en cours de validation par la centrale\.$/);
    expect(n.data).toMatchObject({ threshold: 7, days_left: 5, renewal_pending: true });

    const [ev] = await eventOf(old);
    expect(ev.type).toBe("document.expiring");
    expect(ev.message).toBe(`Attestation d'assurance de Karim Test (#${d.number}) : expire dans 5 jours — nouveau document à valider`);
    expect(ev.data.renewal_pending).toBe(true);
  });

  it("échéance dépassée : même principe", async () => {
    const org = await createOrg("Audit Robustesse Docs Échus");
    const d = await createDriver(org);
    const old = await insertDoc(org, d, "vtc_card", -2);
    await submit(d, org, "vtc_card", 1800);

    await run();
    const [n] = await notifOf(old);
    expect(n).toMatchObject({ type: "document_expired", title: "Document expiré : Carte VTC", priority: "normal" });
    expect(n.body).toMatch(/^Échéance dépassée depuis le \d{2}\/\d{2}\/\d{4}\. Votre nouveau document est en cours de validation par la centrale\.$/);
    expect((await eventOf(old))[0].message).toContain("échéance dépassée depuis le");
    expect((await eventOf(old))[0].message).toMatch(/ — nouveau document à valider$/);
  });

  it("sans dépôt en attente (ou dépôt d'un autre type, ou pièce « autre ») : rappel inchangé", async () => {
    const org = await createOrg("Audit Robustesse Docs Témoin");
    const d = await createDriver(org, { firstName: "Léa" });
    const license = await insertDoc(org, d, "driving_license", 5);
    const kbis = await insertDoc(org, d, "other", 5, { label: "Kbis" });
    await submit(d, org, "insurance", 370); // autre type
    await submit(d, org, "other", null, "Attestation URSSAF"); // « autre » : pas un renouvellement du Kbis

    await run();
    const [n] = await notifOf(license);
    expect(n).toMatchObject({ type: "document_expiring", priority: "high" });
    expect(n.body).toMatch(/^Échéance le \d{2}\/\d{2}\/\d{4}\. Déposez le nouveau document depuis l'application\.$/);
    expect(n.data.renewal_pending).toBe(false);
    expect((await eventOf(license))[0].message).toBe(`Permis de conduire de Léa Test (#${d.number}) : expire dans 5 jours`);

    const [k] = await notifOf(kbis);
    expect(k.body).toContain("Déposez le nouveau document depuis l'application.");
    expect(k.data.renewal_pending).toBe(false);
  });

  it("dépôt refusé par la centrale : les rappels suivants redemandent le document", async () => {
    const org = await createOrg("Audit Robustesse Docs Refus");
    const d = await createDriver(org);
    const old = await insertDoc(org, d, "insurance", 20);
    const sub = await submit(d, org, "insurance", 700);

    await run(); // J-30 : renouvellement en attente
    expect((await notifOf(old))[0].body).toContain("en cours de validation");

    await as({ sub: org.ownerId }, (q) => q(`select public.review_driver_document($1, false, 'Illisible', null)`, [sub.document.id]));
    // Le temps passe : échéance à J-5 (la nouvelle date réarme les rappels : on remet le seuil J-30 déjà envoyé)
    await sql(`update public.driver_documents set expires_at = (now() at time zone '${TZ}')::date + 5 where id = $1`, [old]);
    await sql(`update public.driver_documents set reminders_sent = '{30}' where id = $1`, [old]);
    await run(); // J-7 : plus rien en attente
    const list = await notifOf(old);
    expect(list).toHaveLength(2);
    expect(list[1].body).toContain("Déposez le nouveau document depuis l'application.");
    expect(list[1].data.renewal_pending).toBe(false);
  });
});
