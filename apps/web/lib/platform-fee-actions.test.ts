import { ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION } from "@rydar/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Frais Rydar par course (20260924006600) : actions serveur du super admin → RPC svc_* (auteur revérifié, historique,
// e-mails et journal d'audit en base). Jamais d'écriture directe des taux ni d'audit doublé côté web.

type Op = { table: string; action: string; values?: any; filters: Record<string, unknown> };
type Reply = { data?: unknown; error?: unknown } | undefined;

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  audits: [] as Record<string, any>[],
  deletedUsers: [] as string[],
  handle: (() => undefined) as (op: Op) => Reply,
  session: null as any,
}));

function fakeDb() {
  const reply = (op: Op) => {
    h.ops.push(op);
    const r = h.handle(op) ?? {};
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  return {
    from(table: string) {
      const op: Op = { table, action: "select", filters: {} };
      const b: any = {
        select: () => b,
        insert: (v: unknown) => ((op.action = "insert"), (op.values = v), b),
        update: (v: unknown) => ((op.action = "update"), (op.values = v), b),
        delete: () => ((op.action = "delete"), b),
        eq: (c: string, v: unknown) => ((op.filters[c] = v), b),
        ilike: (c: string, v: unknown) => ((op.filters[`${c}~`] = v), b),
        in: () => b,
        maybeSingle: () => reply(op),
        single: () => reply(op),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => reply(op).then(ok, ko),
      };
      return b;
    },
    rpc: (fn: string, args: unknown) => reply({ table: `rpc:${fn}`, action: "rpc", values: args, filters: {} }),
    auth: {
      admin: {
        createUser: async () => ({ data: { user: { id: NEW_USER } }, error: null }),
        inviteUserByEmail: async () => ({ data: { user: { id: NEW_USER } }, error: null }),
        deleteUser: async (id: string) => (h.deletedUsers.push(id), { error: null }),
      },
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-fetch", () => ({ serverFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon-key", appUrl: "https://app.rydar.test" } }));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void h.audits.push(e) }));
vi.mock("@/lib/auth", () => ({ requireSuperAdmin: async () => h.session }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/member-invite", () => ({ findUserIdByEmail: async () => null, sendMemberInvitationEmail: async () => true }));

const NEW_USER = "44444444-4444-4444-8444-444444444444";
const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = "77777777-7777-4777-8777-777777777777";
const CHANGE = "99999999-9999-4999-8999-999999999999";

const admin = fakeDb();
const actions = await import("../app/admin/actions");
const legal = await import("../app/admin/legal/actions");

const rpcCalls = (fn: string) => h.ops.filter((o) => o.table === `rpc:${fn}`).map((o) => o.values);
const writes = (table: string) => h.ops.filter((o) => o.table === table && ["insert", "update", "delete"].includes(o.action));

beforeEach(() => {
  h.ops.length = 0;
  h.audits.length = 0;
  h.deletedUsers.length = 0;
  h.handle = () => undefined;
  h.session = { user: { id: ACTOR } };
});

describe("création d'une organisation : frais appliqués tout de suite (« initial »)", () => {
  const org = { name: "Taxis Dupont", slug: "taxis-dupont", email: "contact@taxis-dupont.fr", ownerName: "Paul Dupont", ownerEmail: "paul@taxis-dupont.fr", ownerPassword: "Provisoire-2026" };

  it("modèle et frais par svc_platform_set_fees en mode initial, jamais par une écriture directe des taux", async () => {
    h.handle = (op) =>
      op.table === "organizations" && op.action === "insert"
        ? { data: { id: ORG } }
        : op.table === "rpc:svc_platform_set_fees"
          ? { data: { ok: true, code: "APPLIED", message: "Frais par course : 2 € par course terminée." } }
          : undefined;
    const res = await actions.createOrganization(org, { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 200 });
    expect(res).toMatchObject({ ok: true, id: ORG });
    expect(rpcCalls("svc_platform_set_fees")).toEqual([
      {
        p_org: ORG,
        p_actor: ACTOR,
        p_percent: 0,
        p_fixed_cents: 200,
        p_dispatch_model: "fleet",
        p_mode: "initial",
        p_org_legal_version: ORG_LEGAL_VERSION,
        p_org_legal_effective_on: ORG_LEGAL_EFFECTIVE_AT,
        p_app_url: "https://app.rydar.test",
      },
    ]);
    // Taux jamais écrits directement (garde SQL organizations_platform_rates_guard)
    expect(writes("organizations").filter((o) => o.action === "update")).toEqual([]);
    // Réglé une fois le propriétaire rattaché : la base lui envoie l'e-mail des frais appliqués dès l'ouverture
    const owner = h.ops.findIndex((o) => o.table === "organization_users" && o.action === "insert");
    const setup = h.ops.findIndex((o) => o.table === "rpc:svc_platform_set_fees");
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(setup).toBeGreaterThan(owner);
  });

  it("réglage initial refusé : organisation retirée (propriétaire compris), erreur de champ, compte créé ici supprimé", async () => {
    h.handle = (op) =>
      op.table === "organizations" && op.action === "insert"
        ? { data: { id: ORG } }
        : op.table === "rpc:svc_platform_set_fees"
          ? { data: { ok: false, code: "INVALID", field: "platformFeeFixedCents", message: "Frais fixes par course : entre 0 et 1 000 €." } }
          : undefined;
    const res = await actions.createOrganization(org, { dispatchModel: "centrale", platformFeePercent: 0, platformFeeFixedCents: 200 });
    expect(res).toEqual({
      ok: false,
      error: "Frais fixes par course : entre 0 et 1 000 €.",
      fieldErrors: { platformFeeFixedCents: "Frais fixes par course : entre 0 et 1 000 €." },
    });
    expect(writes("organizations").map((o) => o.action)).toEqual(["insert", "delete"]);
    expect(writes("organization_users").map((o) => o.action)).toEqual(["insert"]);
    expect(h.deletedUsers).toEqual([NEW_USER]);

    // Erreur de la RPC elle-même (transaction annulée) : organisation retirée, message générique
    h.ops.length = 0;
    h.handle = (op) =>
      op.table === "organizations" && op.action === "insert"
        ? { data: { id: ORG } }
        : op.table === "rpc:svc_platform_set_fees"
          ? { error: { code: "XX000", message: "boom" } }
          : undefined;
    expect(await actions.createOrganization(org)).toEqual({ ok: false, error: "Modèle d'exploitation impossible à enregistrer." });
    expect(writes("organizations").map((o) => o.action)).toEqual(["insert", "delete"]);
  });
});

describe("fiche organisation : hausse annoncée, accord écrit, modèle seul", () => {
  it("modèle seul : aucun taux envoyé (la hausse annoncée reste prévue) ; demande ou accord écrit de l'organisation transmis", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees"
        ? { data: { ok: true, code: "APPLIED", message: "Modèle d'exploitation enregistré.", scheduled_change: null, emails_queued: 0 } }
        : undefined;
    expect(await actions.updateDispatchModel(ORG, { dispatchModel: "centrale", consentNote: " Demande du gérant, e-mail du 03/10/2026 " })).toMatchObject({
      ok: true, code: "APPLIED",
    });
    expect(rpcCalls("svc_platform_set_fees")[0]).toMatchObject({
      p_org: ORG,
      p_actor: ACTOR,
      p_percent: null,
      p_fixed_cents: null,
      p_dispatch_model: "centrale",
      p_mode: "notice",
      p_effective_on: null,
      // CGV art. 3 : contrôlée par la base (CONSENT_REQUIRED sans elle)
      p_consent_note: "Demande du gérant, e-mail du 03/10/2026",
      p_org_legal_version: ORG_LEGAL_VERSION,
      p_org_legal_effective_on: ORG_LEGAL_EFFECTIVE_AT,
    });
    // Ni écriture directe, ni audit doublé (écrit en base par la RPC)
    expect(writes("organizations")).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("hausse programmée : date choisie envoyée ; préavis trop court → erreur sur la date et date au plus tôt renvoyée", async () => {
    const scheduled = { id: CHANGE, percent: 0, fixed_cents: 200, from_percent: 0, from_fixed_cents: 0, effective_at: "2026-11-04T23:00:00Z", effective_on: "2026-11-05", announced_at: "2026-10-03T08:00:00Z" };
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees"
        ? { data: { ok: true, code: "SCHEDULED", message: "Hausse programmée : 2 € par course terminée à partir du 05/11/2026.", scheduled_change: scheduled, emails_queued: 1 } }
        : undefined;
    const res = await actions.updateDispatchModel(ORG, { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 200, effectiveOn: "2026-11-05" });
    expect(res).toEqual({ ok: true, code: "SCHEDULED", message: "Hausse programmée : 2 € par course terminée à partir du 05/11/2026.", scheduledChange: scheduled, emailsQueued: 1 });
    expect(rpcCalls("svc_platform_set_fees")[0]).toMatchObject({ p_percent: 0, p_fixed_cents: 200, p_mode: "notice", p_effective_on: "2026-11-05", p_consent_note: null });

    h.ops.length = 0;
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees"
        ? { data: { ok: false, code: "NOTICE_TOO_SHORT", field: "effectiveOn", min_effective_on: "2026-11-06", min_reason: "terms_effective", message: "Préavis insuffisant : au plus tôt le 06/11/2026." } }
        : undefined;
    expect(await actions.updateDispatchModel(ORG, { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 200, effectiveOn: "2026-11-01" })).toEqual({
      ok: false,
      error: "Préavis insuffisant : au plus tôt le 06/11/2026.",
      fieldErrors: { effectiveOn: "Préavis insuffisant : au plus tôt le 06/11/2026." },
      minEffectiveOn: "2026-11-06",
    });
  });

  it("accord écrit : note obligatoire (contrôlée avant la base), transmise sans date d'effet", async () => {
    const missing = await actions.updateDispatchModel(ORG, { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 200, mode: "consent", consentNote: " " });
    expect(missing).toMatchObject({ ok: false, fieldErrors: { consentNote: expect.any(String) } });
    expect(h.ops).toEqual([]);

    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees" ? { data: { ok: true, code: "APPLIED", message: "Accord écrit enregistré.", scheduled_change: null, emails_queued: 1 } } : undefined;
    await actions.updateDispatchModel(ORG, {
      dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 200, mode: "consent", consentNote: "E-mail du propriétaire du 3 octobre", effectiveOn: "2026-11-05",
    });
    expect(rpcCalls("svc_platform_set_fees")[0]).toMatchObject({ p_mode: "consent", p_consent_note: "E-mail du propriétaire du 3 octobre", p_effective_on: null });
  });

  it("retour au mode flotte refusé : règlements ouverts (RPC ou déclencheur) → message clair", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees" ? { data: { ok: false, code: "SETTLEMENTS_OPEN", count: 2, field: "dispatchModel", message: "x" } } : undefined;
    const res = await actions.updateDispatchModel(ORG, { dispatchModel: "fleet" });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("2 règlements chauffeur encore ouverts"), fieldErrors: { dispatchModel: "x" } });

    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees" ? { error: { code: "P0001", message: "SETTLEMENTS_OPEN: 1 règlement(s) chauffeur encore ouvert(s)" } } : undefined;
    expect(await actions.updateDispatchModel(ORG, { dispatchModel: "fleet" })).toMatchObject({ ok: false, error: expect.stringContaining("1 règlement chauffeur encore ouvert") });
  });

  it("saisie invalide ou organisation inconnue : rien n'est envoyé", async () => {
    expect(await actions.updateDispatchModel("pas-un-uuid", { dispatchModel: "fleet" })).toEqual({ ok: false, error: "Organisation inconnue." });
    expect(await actions.updateDispatchModel(ORG, { dispatchModel: "fleet", platformFeePercent: 2 })).toMatchObject({ ok: false, fieldErrors: { platformFeeFixedCents: expect.any(String) } });
    expect(await actions.updateDispatchModel(ORG, { dispatchModel: "fleet", platformFeePercent: 60, platformFeeFixedCents: 0 })).toMatchObject({ ok: false });
    expect(h.ops).toEqual([]);
  });

  it("annulation de la hausse affichée : identifiant transmis, changement remplacé entre-temps → refus", async () => {
    expect(await actions.cancelPlatformFeeChange(ORG, "x")).toEqual({ ok: false, error: "Changement introuvable." });
    expect(h.ops).toEqual([]);

    h.handle = (op) =>
      op.table === "rpc:svc_platform_cancel_fee_change"
        ? { data: { ok: true, code: "CANCELLED", emails_queued: 1, message: "Changement annulé. Frais inchangés : aucuns frais par course." } }
        : undefined;
    expect(await actions.cancelPlatformFeeChange(ORG, CHANGE, "  Erreur de saisie  ")).toEqual({ ok: true, message: "Changement annulé. Frais inchangés : aucuns frais par course." });
    expect(rpcCalls("svc_platform_cancel_fee_change")).toEqual([{ p_org: ORG, p_actor: ACTOR, p_change: CHANGE, p_note: "Erreur de saisie", p_app_url: "https://app.rydar.test" }]);

    h.handle = (op) =>
      op.table === "rpc:svc_platform_cancel_fee_change"
        ? { data: { ok: false, code: "FEE_CHANGE_NOT_PENDING", message: "Ce changement n'est plus en attente (déjà appliqué, annulé ou remplacé) : rechargez la page." } }
        : undefined;
    expect(await actions.cancelPlatformFeeChange(ORG, CHANGE)).toMatchObject({ ok: false, error: expect.stringContaining("n'est plus en attente") });
  });
});

describe("/admin/legal : « Prévenir par e-mail »", () => {
  it("version et entrée en vigueur des CGV transmises ; refus de la base relayé", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_org_terms_notify"
        ? {
            data: {
              ok: true, code: "NOTIFIED", organizations: 3, emails: 4, already_notified: 1, without_email: 0, not_accepted: 4,
              message: "3 organisations prévenues par e-mail (4 e-mails). 1 déjà prévenue pour cette version.",
            },
          }
        : undefined;
    expect(await legal.notifyOrgTerms()).toEqual({
      ok: true, message: "3 organisations prévenues par e-mail (4 e-mails). 1 déjà prévenue pour cette version.", organizations: 3, emails: 4, alreadyNotified: 1, withoutEmail: 0,
    });
    expect(rpcCalls("svc_org_terms_notify")).toEqual([{ p_actor: ACTOR, p_version: ORG_LEGAL_VERSION, p_effective_on: ORG_LEGAL_EFFECTIVE_AT, p_app_url: "https://app.rydar.test" }]);

    h.handle = (op) =>
      op.table === "rpc:svc_org_terms_notify" ? { data: { ok: false, code: "TERMS_EFFECTIVE_PASSED", message: "Entrée en vigueur des CGV atteinte." } } : undefined;
    expect(await legal.notifyOrgTerms()).toEqual({ ok: false, error: "Entrée en vigueur des CGV atteinte." });
  });
});
