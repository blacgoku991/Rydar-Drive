import { beforeEach, describe, expect, it, vi } from "vitest";

// Formulaire de contact public (lib/contact.ts) : vraie action submitContactRequest, Supabase service role simulé.
// Piège à robots, validation, limites (IP /64, e-mail, global) dans l'ordre, plafond horaire des accusés de réception,
// destinataires validés comme en base (une configuration invalide ne fait jamais échouer la demande), offre publique
// seulement, erreurs de la base traduites.

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  ip: "203.0.113.10",
  counts: new Map<string, number>(),
  limits: [] as string[],
  calls: [] as { fn: string; args: Row }[],
  plans: [{ code: "pro", name: "Pro" }] as Row[],
  rpcResult: { data: { ok: true, ack_queued: true }, error: null } as { data: Row | null; error: { message: string } | null },
  legalEmail: "contact@rydar.test",
  notifyEnv: "",
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": h.ip }) }));
vi.mock("@/lib/request", async () => await import("./request"));
vi.mock("@/lib/env", () => ({
  env: { appUrl: "https://app.rydar.test/", rootDomain: "rydar.test", supabaseUrl: "", supabaseAnonKey: "" },
  serverEnv: () => ({ apiKeyPepper: "poivre", contactNotifyEmail: h.notifyEnv }),
}));
vi.mock("@/lib/legal", () => ({ getLegalInfo: async () => ({ email: h.legalEmail }) }));
vi.mock("@/lib/rate-limit", () => {
  const check = (key: string, limit: number) => {
    h.limits.push(key);
    const n = (h.counts.get(key) ?? 0) + 1;
    h.counts.set(key, n);
    return { ok: n <= limit, remaining: Math.max(0, limit - n), resetAt: 0, limit };
  };
  return {
    rateLimit: async (key: string, limit: number) => check(key, limit),
    rateLimitAll: async (checks: { key: string; limit: number }[]) => {
      let last = { ok: true, remaining: 0, resetAt: 0, limit: 0 };
      for (const c of checks) {
        last = check(c.key, c.limit);
        if (!last.ok) return last;
      }
      return last;
    },
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const b: any = {
        select: () => b,
        eq: () => b,
        order: () => b,
        abortSignal: async () => (table === "plans" ? { data: h.plans, error: null } : { data: [], error: null }),
      };
      return b;
    },
    async rpc(fn: string, args: Row) {
      h.calls.push({ fn, args });
      return h.rpcResult;
    },
  }),
}));

const { isOutboxEmail, parseRecipients, submitContactRequest } = await import("./contact");

const VALID = {
  topic: "pricing" as const,
  planCode: "pro",
  name: "Samir Benali",
  company: "Centrale Nord",
  email: "Samir@Centrale-Nord.FR",
  phone: "06 12 34 56 78",
  fleetSize: "6-20" as const,
  message: "Nous avons 12 chauffeurs et travaillons encore sur WhatsApp.",
};

beforeEach(() => {
  h.ip = "203.0.113.10";
  h.counts.clear();
  h.limits.length = 0;
  h.calls.length = 0;
  h.plans = [{ code: "pro", name: "Pro" }];
  h.rpcResult = { data: { ok: true, ack_queued: true }, error: null };
  h.legalEmail = "contact@rydar.test";
  h.notifyEnv = "";
});

describe("adresses de la file d'envoi (même règle que public.email_outbox)", () => {
  it("une seule adresse, sans espace ni séparateur ni nom affiché", () => {
    expect(isOutboxEmail("contact@rydar.fr")).toBe(true);
    for (const bad of ["a,b@x.fr", "Nom <a@x.fr>", "a b@x.fr", "a@x", "a@b@x.fr", "a;b@x.fr", 'a"b@x.fr', "a@x.fr\n", "a@x.fr ", "(a)@x.fr"]) {
      expect(isOutboxEmail(bad)).toBe(false);
    }
  });

  it("configuration : liste, nom affiché, doublons et adresses invalides", () => {
    expect(parseRecipients("Admin <Admin@Rydar.fr>, ventes@rydar.fr; admin@rydar.fr ; pas-une-adresse")).toEqual([
      "admin@rydar.fr",
      "ventes@rydar.fr",
    ]);
    expect(parseRecipients("")).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients(Array.from({ length: 8 }, (_, i) => `a${i}@x.fr`).join(","))).toHaveLength(5);
  });
});

describe("submitContactRequest", () => {
  it("demande valide : une transaction, notification à l'admin (sans donnée personnelle), accusé au demandeur", async () => {
    const res = await submitContactRequest(VALID);
    expect(res).toEqual({ ok: true, ackQueued: true });
    expect(h.calls).toHaveLength(1);
    const { fn, args } = h.calls[0]!;
    expect(fn).toBe("svc_contact_submit");
    expect(args.p_request).toMatchObject({
      topic: "pricing",
      plan_code: "pro",
      name: "Samir Benali",
      company: "Centrale Nord",
      email: "samir@centrale-nord.fr",
      phone: "+33612345678",
      fleet_size: "6-20",
    });
    expect(args.p_request.id).toMatch(/^[0-9a-f-]{36}$/);
    // Empreinte de l'IP, jamais l'adresse en clair
    expect(args.p_request.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain(h.ip);
    const [notify, ack] = args.p_emails as Row[];
    // Aucune donnée personnelle dans la notification, ni Reply-To (réponses depuis /admin/contacts)
    expect(notify).toMatchObject({ kind: "contact_notify", to_email: "contact@rydar.test", reply_to: null });
    expect(`${notify!.subject}\n${notify!.body_text}`).not.toMatch(/samir|centrale[ -]nord|612345678|chauffeurs/i);
    expect(notify!.subject).toContain("Demande de tarif");
    expect(notify!.body_text).toContain(`https://app.rydar.test/admin/contacts/${args.p_request.id}`);
    expect(notify!.body_text).toContain("Pro");
    expect(ack).toMatchObject({ kind: "contact_ack", to_email: "samir@centrale-nord.fr", reply_to: "contact@rydar.test" });
    // Accusé au contenu fixe : rien de ce que le demandeur a saisi
    for (const typed of ["Samir", "Centrale Nord", "WhatsApp", "12 chauffeurs"]) {
      expect(ack!.subject + ack!.body_text).not.toContain(typed);
    }
  });

  it("piège à robots rempli : faux succès, rien d'enregistré ni de compté", async () => {
    const res = await submitContactRequest({ ...VALID, website: "https://spam.example" });
    expect(res).toEqual({ ok: true, ackQueued: false });
    expect(h.calls).toHaveLength(0);
    expect(h.limits).toHaveLength(0);
  });

  it("champs invalides : erreurs par champ, aucune limite consommée", async () => {
    const res = await submitContactRequest({ ...VALID, name: "", email: "pas-une-adresse", message: "court" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(Object.keys(res.fieldErrors ?? {})).toEqual(expect.arrayContaining(["name", "email", "message"]));
    expect(h.calls).toHaveLength(0);
    expect(h.limits).toHaveLength(0);
  });

  it("limites : par IP (5 / h, seau /64), puis par e-mail, puis global — dans cet ordre", async () => {
    for (let i = 0; i < 5; i++) expect((await submitContactRequest({ ...VALID, email: `p${i}@x.fr` })).ok).toBe(true);
    const sixth = await submitContactRequest({ ...VALID, email: "p5@x.fr" });
    expect(sixth).toMatchObject({ ok: false, error: expect.stringContaining("Trop de demandes") });
    // Refusée pour l'IP : les compteurs e-mail et global ne sont pas consommés
    expect(h.limits.at(-1)).toMatch(/^contact:ip:/);
    expect(h.counts.get("contact:email:p5@x.fr")).toBeUndefined();

    // IPv6 : même /64 = même compteur
    h.counts.clear();
    h.ip = "2001:db8:1:2::1";
    for (let i = 0; i < 5; i++) await submitContactRequest({ ...VALID, email: `q${i}@x.fr` });
    h.ip = "2001:db8:1:2:ffff::9";
    expect((await submitContactRequest({ ...VALID, email: "q9@x.fr" })).ok).toBe(false);
  });

  it("même adresse : 3 demandes par jour au plus", async () => {
    for (let i = 0; i < 3; i++) {
      h.ip = `198.51.100.${i + 1}`;
      expect((await submitContactRequest(VALID)).ok).toBe(true);
    }
    h.ip = "198.51.100.99";
    expect((await submitContactRequest(VALID)).ok).toBe(false);
  });

  it("plafond horaire des accusés (réputation de l'IP du VPS) : demande enregistrée et notifiée, sans accusé", async () => {
    h.counts.set("contact:ack", 30);
    const res = await submitContactRequest(VALID);
    expect(res.ok).toBe(true);
    const kinds = (h.calls[0]!.args.p_emails as Row[]).map((e) => e.kind);
    expect(kinds).toEqual(["contact_notify"]);
  });

  it("destinataires : CONTACT_NOTIFY_EMAIL (liste) en priorité ; configuration invalide → demande enregistrée sans notification", async () => {
    h.notifyEnv = "Admin <admin@rydar.fr>, ventes@rydar.fr";
    await submitContactRequest(VALID);
    let emails = h.calls[0]!.args.p_emails as Row[];
    expect(emails.filter((e) => e.kind === "contact_notify").map((e) => e.to_email)).toEqual(["admin@rydar.fr", "ventes@rydar.fr"]);
    expect(emails.find((e) => e.kind === "contact_ack")!.reply_to).toBe("admin@rydar.fr");

    h.calls.length = 0;
    h.counts.clear();
    h.notifyEnv = "";
    h.legalEmail = "pas une adresse ; <> ; @rydar.fr";
    const res = await submitContactRequest(VALID);
    expect(res.ok).toBe(true);
    emails = h.calls[0]!.args.p_emails as Row[];
    expect(emails.map((e) => e.kind)).toEqual(["contact_ack"]);
    expect(emails[0]!.reply_to).toBeNull();
  });

  it("offre : seulement une offre publique et active, et seulement pour une demande de tarif", async () => {
    await submitContactRequest({ ...VALID, planCode: "secrete" });
    expect(h.calls[0]!.args.p_request.plan_code).toBeNull();
    h.calls.length = 0;
    await submitContactRequest({ ...VALID, topic: "question", planCode: "pro", fleetSize: "51+", email: "autre@x.fr" });
    expect(h.calls[0]!.args.p_request).toMatchObject({ topic: "question", plan_code: null, fleet_size: null });
  });

  it("base saturée (CONTACT_BUSY) : message clair ; autre erreur : message neutre, sans détail technique", async () => {
    h.rpcResult = { data: null, error: { message: "CONTACT_BUSY: trop de demandes" } };
    const busy = await submitContactRequest(VALID);
    expect(busy).toMatchObject({ ok: false });
    if (!busy.ok) expect(busy.error).not.toMatch(/CONTACT_BUSY/);

    h.rpcResult = { data: null, error: { message: 'CONTACT_INVALID: new row violates check constraint "email_outbox_to_email_check"' } };
    const invalid = await submitContactRequest({ ...VALID, email: "x2@x.fr" });
    expect(invalid).toEqual({ ok: false, error: "Envoi impossible pour le moment. Réessayez dans un instant." });
  });

  it("accusé non créé par la base (déjà envoyé à cette adresse depuis moins de 24 h)", async () => {
    h.rpcResult = { data: { ok: true, ack_queued: false }, error: null };
    expect(await submitContactRequest(VALID)).toEqual({ ok: true, ackQueued: false });
  });
});
