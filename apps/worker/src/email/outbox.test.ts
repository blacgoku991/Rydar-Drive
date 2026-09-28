import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeSmtp } from "./fake-smtp";
import { CLAIM_BATCH, MAX_ATTEMPTS, recipientDomain, redactAddresses, runMailCycle, type CycleDeps, type QueryFn } from "./outbox";
import { classifySmtpError, createSmtpSender, smtpSettings, type OutboxEmail } from "./smtp";

const SUBJECT = "Nouvelle demande de contact — Partenariat";
const BODY = "Message très confidentiel de Jeanne Martin, 06 12 34 56 78.";

const row = (id: number, over: Partial<OutboxEmail> = {}): OutboxEmail => ({
  id: String(id),
  kind: "contact_ack",
  to_email: `client${id}@exemple.org`,
  reply_to: "contact@rydar.example",
  subject: SUBJECT,
  body_text: BODY,
  attempts: 1,
  ...over,
});

/** Base simulée : lots successifs pour private.claim_emails, appels à private.complete_email enregistrés. */
function fakeDb(batches: OutboxEmail[][], opts: { failComplete?: boolean } = {}) {
  const claims: unknown[][] = [];
  const completes: unknown[][] = [];
  const query: QueryFn = async (sql, params = []) => {
    if (sql === "select * from private.claim_emails($1::int)") {
      claims.push(params);
      return { rows: batches.shift() ?? [] };
    }
    if (sql === "select private.complete_email($1::bigint, $2::boolean, $3::text, $4::boolean)") {
      if (opts.failComplete) throw new Error("connexion à la base perdue");
      completes.push(params);
      return { rows: [{}] };
    }
    throw new Error(`requête inattendue : ${sql}`);
  };
  return { query, claims, completes };
}

/** Lignes JSON écrites par log() (info / warn → console.log, error → console.error). */
function captureLogs() {
  const lines: Record<string, any>[] = [];
  const raw: string[] = [];
  const push = (line: unknown) => {
    raw.push(String(line));
    lines.push(JSON.parse(String(line)));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return { lines, raw };
}

const smtpError = (responseCode: number) => Object.assign(new Error(`Can't send mail: ${responseCode} <x@exemple.org> refusé`), { code: "EENVELOPE", responseCode });

afterEach(() => vi.restoreAllMocks());

describe("mailer — cycle de la file (claim → envoi → complete)", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("envoi SMTP réel : succès, refus temporaire (4xx) → réessai, refus définitif (5xx) → échec", async () => {
    captureLogs();
    const server = await startFakeSmtp({
      rcpt: (to) =>
        to.startsWith("plustard@") ? "450 4.2.0 Mailbox busy, try again later" : to.startsWith("inconnu@") ? "550 5.1.1 User unknown" : null,
    });
    const sender = createSmtpSender(smtpSettings({ SMTP_PORT: String(server.port), DOMAIN: "rydar.example" }));
    cleanup.push(() => sender.close(), () => server.close());
    const db = fakeDb([[row(1, { to_email: "ok@exemple.org" }), row(2, { to_email: "plustard@exemple.org" }), row(3, { to_email: "inconnu@exemple.org" })]]);
    const outcomes: unknown[] = [];

    const result = await runMailCycle({
      query: db.query,
      send: (e) => sender.send(e),
      classify: classifySmtpError,
      onOutcome: (_e, o) => outcomes.push(o),
    });

    expect(result).toEqual({ claimed: 3, sent: 1, retried: 1, failed: 1 });
    expect(db.claims).toEqual([[CLAIM_BATCH]]);
    expect(db.completes).toHaveLength(3);
    expect(db.completes[0]).toEqual(["1", true, null, false]);
    expect(db.completes[1]).toEqual(["2", false, expect.stringContaining("Refus temporaire du serveur mail (450)"), false]);
    expect(db.completes[2]).toEqual(["3", false, expect.stringContaining("Refus définitif du serveur mail (550)"), true]);
    expect(outcomes).toEqual([
      { ok: true },
      expect.objectContaining({ ok: false, permanent: false, final: false, smtpDown: false }),
      expect.objectContaining({ ok: false, permanent: true, final: true, smtpDown: false }),
    ]);
    // Seul le premier message est arrivé, à son seul destinataire
    expect(server.messages()).toHaveLength(1);
    expect(server.messages()[0]!.rcptTo).toEqual(["ok@exemple.org"]);
  });

  it("serveur mail absent : réessai (jamais définitif), serveur signalé indisponible", async () => {
    captureLogs();
    const db = fakeDb([[row(7)]]);
    const connRefused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:25"), { code: "ESOCKET" });
    const outcomes: any[] = [];
    await runMailCycle({ query: db.query, send: async () => Promise.reject(connRefused), classify: classifySmtpError, onOutcome: (_e, o) => outcomes.push(o) });
    expect(db.completes).toEqual([["7", false, "Serveur mail injoignable : connect ECONNREFUSED 127.0.0.1:25", false]]);
    expect(outcomes[0]).toMatchObject({ ok: false, permanent: false, final: false, smtpDown: true });
  });

  it(`${MAX_ATTEMPTS}e essai en échec : plus de réessai (compté en échec, journal error)`, async () => {
    const logs = captureLogs();
    const db = fakeDb([[row(8, { attempts: MAX_ATTEMPTS })]]);
    const result = await runMailCycle({ query: db.query, send: async () => Promise.reject(smtpError(451)), classify: classifySmtpError });
    // Réessai demandé à la base (non définitif) : c'est private.complete_email qui passe la ligne en « failed »
    expect(db.completes[0]).toEqual(["8", false, expect.stringContaining("(451)"), false]);
    expect(result).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
    expect(logs.lines).toEqual([expect.objectContaining({ level: "error", msg: "email failed, no more retries", id: "8", attempt: MAX_ATTEMPTS })]);
  });

  it("bail expiré à répétition (plus de 8 essais) : abandon définitif sans nouvel envoi", async () => {
    captureLogs();
    const db = fakeDb([[row(9, { attempts: MAX_ATTEMPTS + 1 })]]);
    let sent = 0;
    const result = await runMailCycle({ query: db.query, send: async () => void sent++, classify: classifySmtpError });
    expect(sent).toBe(0);
    expect(db.completes).toEqual([["9", false, "Abandon : envoi interrompu à chaque essai", true]]);
    expect(result.failed).toBe(1);
  });

  it("lot complet : nouveau lot réservé ; lot incomplet : fin du cycle ; arrêt demandé : aucune réservation", async () => {
    captureLogs();
    const full = Array.from({ length: CLAIM_BATCH }, (_, i) => row(100 + i));
    const db = fakeDb([full, [row(200), row(201)]]);
    const deps: CycleDeps = { query: db.query, send: async () => undefined, classify: classifySmtpError };
    expect(await runMailCycle(deps)).toEqual({ claimed: CLAIM_BATCH + 2, sent: CLAIM_BATCH + 2, retried: 0, failed: 0 });
    expect(db.claims).toHaveLength(2);

    const idle = fakeDb([[row(300)]]);
    expect(await runMailCycle({ ...deps, query: idle.query, shouldStop: () => true })).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
    expect(idle.claims).toHaveLength(0);
  });

  it("journal : identifiant, type et domaine du destinataire — jamais l'objet, le corps ni l'adresse complète", async () => {
    const logs = captureLogs();
    const db = fakeDb([[row(11, { to_email: "jeanne.martin@exemple.org", reply_to: "admin@rydar.example" }), row(12, { to_email: "paul@exemple.org" })]]);
    let n = 0;
    await runMailCycle({
      query: db.query,
      send: async () => {
        if (n++ === 1) throw Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <paul@exemple.org>: User unknown"), { code: "EENVELOPE", responseCode: 550 });
      },
      classify: classifySmtpError,
    });
    expect(logs.lines).toEqual([
      expect.objectContaining({ level: "info", msg: "email sent", id: "11", kind: "contact_ack", to_domain: "exemple.org", attempt: 1 }),
      expect.objectContaining({ level: "error", id: "12", to_domain: "exemple.org", permanent: true }),
    ]);
    const all = logs.raw.join("\n");
    for (const secret of ["jeanne.martin@", "paul@", "admin@rydar", "Jeanne Martin", "confidentiel", "Partenariat"]) expect(all).not.toContain(secret);
    expect(logs.lines[1]!.error).toContain("<***@exemple.org>");
    // La base garde le motif complet (visible du seul super admin dans /admin/contacts)
    expect(db.completes[1]![2]).toContain("<paul@exemple.org>");
  });

  it("échec de la base en enregistrant le résultat : cycle interrompu, erreur remontée à l'appelant", async () => {
    captureLogs();
    const db = fakeDb([[row(21), row(22)]], { failComplete: true });
    let sent = 0;
    await expect(runMailCycle({ query: db.query, send: async () => void sent++, classify: classifySmtpError })).rejects.toThrow("connexion à la base perdue");
    // Le second message n'est pas envoyé : il repartira à la fin de son bail, sans doublon
    expect(sent).toBe(1);
  });
});

describe("mailer — utilitaires du journal", () => {
  it("domaine du destinataire seul ; adresses masquées dans un texte", () => {
    expect(recipientDomain("Jeanne.Martin@Exemple.ORG")).toBe("exemple.org");
    expect(recipientDomain("sans-arobase")).toBe("?");
    expect(redactAddresses("550 5.1.1 <jeanne@exemple.org>: rejected; copie à paul.durand+x@autre.fr")).toBe(
      "550 5.1.1 <***@exemple.org>: rejected; copie à ***@autre.fr",
    );
    expect(redactAddresses("connect ECONNREFUSED 127.0.0.1:25")).toBe("connect ECONNREFUSED 127.0.0.1:25");
  });
});
