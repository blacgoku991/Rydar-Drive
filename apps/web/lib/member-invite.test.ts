import { beforeEach, describe, expect, it, vi } from "vitest";

// Accès de gestion donné à un compte existant (tableau de bord et super admin), comptes partagés chauffeur / gestion,
// statut chauffeur par RPC : actions serveur réelles, Supabase simulé.

type Op = { client: string; table: string; action: string; values?: any; filters: Record<string, unknown> };
type Reply = { data?: unknown; error?: unknown } | undefined;

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  auth: [] as [string, ...unknown[]][],
  emails: [] as { email: string; redirectTo?: string }[],
  audits: [] as Record<string, any>[],
  handle: (() => undefined) as (op: Op) => Reply,
  ctx: null as any,
  session: null as any,
  createUserError: null as unknown,
}));

function fakeDb(name: string) {
  const reply = (op: Op) => {
    h.ops.push(op);
    const r = h.handle(op) ?? {};
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  return {
    from(table: string) {
      const op: Op = { client: name, table, action: "select", filters: {} };
      const b: any = {
        select: () => b,
        insert: (v: unknown) => ((op.action = "insert"), (op.values = v), b),
        update: (v: unknown) => ((op.action = "update"), (op.values = v), b),
        delete: () => ((op.action = "delete"), b),
        eq: (c: string, v: unknown) => ((op.filters[c] = v), b),
        ilike: (c: string, v: unknown) => ((op.filters[`${c}~`] = v), b),
        in: (c: string, v: unknown) => ((op.filters[`${c}[]`] = v), b),
        not: () => b,
        neq: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: () => reply(op),
        single: () => reply(op),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => reply(op).then(ok, ko),
      };
      return b;
    },
    rpc: (fn: string, args: unknown) => reply({ client: name, table: `rpc:${fn}`, action: "rpc", values: args, filters: {} }),
    auth: {
      admin: {
        createUser: async (a: unknown) => (h.auth.push(["createUser", a]), { data: { user: h.createUserError ? null : { id: NEW_USER } }, error: h.createUserError }),
        inviteUserByEmail: async (e: string) => (h.auth.push(["inviteUserByEmail", e]), { data: { user: { id: NEW_USER } }, error: null }),
        deleteUser: async (id: string) => (h.auth.push(["deleteUser", id]), { error: null }),
        updateUserById: async (id: string, a: unknown) => (h.auth.push(["updateUserById", id, a]), { data: {}, error: null }),
      },
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon-key", appUrl: "https://app.rydar.test" } }));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void h.audits.push(e) }));
vi.mock("@/lib/auth", () => ({
  isAdminRole: (r: string) => r === "owner" || r === "admin",
  requireSuperAdmin: async () => h.session,
}));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/member-invite", async () => await import("./member-invite"));
vi.mock("@/lib/whatsapp", () => ({ removeWhatsApp: vi.fn(), saveWhatsApp: vi.fn(), testWhatsApp: vi.fn() }));
vi.mock("@/components/settlements/settings-schema", () => ({ centraleIssues: () => ({}) }));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => ({
    auth: {
      resetPasswordForEmail: async (email: string, o: { redirectTo?: string }) => (h.emails.push({ email, redirectTo: o?.redirectTo }), { error: null }),
    },
  }),
}));

const NEW_USER = "44444444-4444-4444-8444-444444444444";
const EXISTING = "55555555-5555-4555-8555-555555555555";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "66666666-6666-4666-8666-666666666666";
const OWNER = "77777777-7777-4777-8777-777777777777";
const MEMBER_ROW = "88888888-8888-4888-8888-888888888888";
const DRIVER = "22222222-2222-4222-8222-222222222222";
const DRIVER_USER = "33333333-3333-4333-8333-333333333333";

const admin = fakeDb("admin");
const rls = fakeDb("rls");

const settings = await import("../app/dashboard/settings/actions");
const adminActions = await import("../app/admin/actions");
const drivers = await import("../app/dashboard/drivers/actions");

const writes = (table: string) => h.ops.filter((o) => o.table === table && ["insert", "update", "delete"].includes(o.action));
const authCalls = (method: string) => h.auth.filter((c) => c[0] === method);

beforeEach(() => {
  h.ops.length = 0;
  h.auth.length = 0;
  h.emails.length = 0;
  h.audits.length = 0;
  h.handle = () => undefined;
  h.createUserError = null;
  h.ctx = { org: { id: ORG, timezone: "Europe/Paris", name: "Centrale A" }, role: "owner", user: { id: OWNER }, supabase: rls };
  h.session = { user: { id: OWNER } };
});

describe("Équipe : ajout d'un membre", () => {
  it("compte EXISTANT : recherche exacte (jokers échappés), adhésion « invited », lien envoyé, aucun mot de passe appliqué", async () => {
    h.handle = (op) => (op.table === "users" && op.action === "select" ? { data: { id: EXISTING } } : undefined);
    const res = await settings.inviteMember({ fullName: "Jean Dupont", email: "Jean_Dupont@Exemple.fr", role: "admin", password: "MotDePasse-2026" });
    expect(res).toMatchObject({ ok: true, invited: true, existingAccount: true, emailSent: true, passwordIgnored: true });
    expect(h.ops.find((o) => o.table === "users")?.filters).toEqual({ "email~": "jean\\_dupont@exemple.fr" });
    expect(writes("organization_users")).toEqual([
      expect.objectContaining({ action: "insert", values: expect.objectContaining({ user_id: EXISTING, role: "admin", status: "invited" }) }),
    ]);
    expect(h.emails).toEqual([{ email: "jean_dupont@exemple.fr", redirectTo: "https://app.rydar.test/auth/set-password" }]);
    expect(h.auth).toEqual([]); // ni création, ni mot de passe imposé
    expect(h.audits[0]).toMatchObject({ action: "member.invited" });
  });

  it("compte NOUVEAU : accès immédiat ; ajout refusé (limite de l'offre) → compte créé supprimé", async () => {
    h.handle = (op) =>
      op.table === "organization_users" && op.action === "insert" ? { error: { code: "P0001", message: "PLAN_LIMIT_ADMINS: limite de 2 administrateurs" } } : undefined;
    const res = await settings.inviteMember({ fullName: "Nouveau Membre", email: "nouveau@exemple.fr", role: "dispatcher", password: "" });
    expect(res).toEqual({ ok: false, error: "Limite d'administrateurs atteinte pour votre offre." });
    expect(authCalls("inviteUserByEmail")).toHaveLength(1);
    expect(authCalls("deleteUser")).toEqual([["deleteUser", NEW_USER]]);

    h.handle = () => undefined;
    expect(await settings.inviteMember({ fullName: "Nouveau Membre", email: "nouveau@exemple.fr", role: "dispatcher", password: "" })).toMatchObject({ ok: true });
    expect(writes("organization_users").at(-1)?.values).toMatchObject({ user_id: NEW_USER, status: "active" });
  });

  it("updateMember : seuls rôle admin/dispatcher et statut active/disabled, jamais une invitation en attente", async () => {
    for (const patch of [{ role: "owner" }, { user_id: EXISTING }, { status: "invited" }, {}, { role: "admin", invited_by: EXISTING }]) {
      expect(await settings.updateMember(MEMBER_ROW, patch as never)).toEqual({ ok: false, error: "Demande invalide." });
    }
    expect(await settings.updateMember("pas-un-uuid", { role: "admin" })).toEqual({ ok: false, error: "Demande invalide." });
    expect(h.ops).toEqual([]);

    h.handle = (op) => (op.table === "organization_users" && op.action === "select" ? { data: { user_id: EXISTING, role: "dispatcher", status: "invited" } } : undefined);
    expect(await settings.updateMember(MEMBER_ROW, { status: "active" })).toMatchObject({ ok: false });
    expect(writes("organization_users")).toEqual([]);

    h.handle = (op) => (op.table === "organization_users" && op.action === "select" ? { data: { user_id: EXISTING, role: "dispatcher", status: "active" } } : undefined);
    expect(await settings.updateMember(MEMBER_ROW, { role: "admin" })).toEqual({ ok: true });
    expect(writes("organization_users")).toEqual([expect.objectContaining({ action: "update", values: { role: "admin" } })]);
  });
});

describe("Super admin : propriétaire et accès", () => {
  const org = { name: "Taxis Dupont", slug: "taxis-dupont", email: "contact@taxis-dupont.fr", ownerName: "Paul Dupont", ownerEmail: "contact@taxis-dupont.fr", ownerPassword: "Provisoire-2026" };

  it("création de centrale : propriétaire au compte existant = invitation, jamais rattaché actif", async () => {
    h.handle = (op) =>
      op.table === "users" ? { data: { id: EXISTING } } : op.table === "organizations" && op.action === "insert" ? { data: { id: ORG } } : undefined;
    const res = await adminActions.createOrganization(org);
    expect(res).toMatchObject({ ok: true, id: ORG, ownerInvited: true, emailSent: true, passwordIgnored: true });
    expect(writes("organization_users")[0]?.values).toMatchObject({ user_id: EXISTING, role: "owner", status: "invited" });
    expect(h.emails.map((e) => e.email)).toEqual(["contact@taxis-dupont.fr"]);
    expect(h.auth).toEqual([]);

    // Le super admin qui se nomme lui-même : accès direct
    h.ops.length = 0;
    h.emails.length = 0;
    h.handle = (op) =>
      op.table === "users" ? { data: { id: OWNER } } : op.table === "organizations" && op.action === "insert" ? { data: { id: ORG } } : undefined;
    expect(await adminActions.createOrganization(org)).toMatchObject({ ok: true, ownerInvited: false });
    expect(writes("organization_users")[0]?.values).toMatchObject({ user_id: OWNER, status: "active" });
    expect(h.emails).toEqual([]);
  });

  it("« Donner un accès » : compte existant = invitation ; adhésion désactivée = rétablie", async () => {
    h.handle = (op) =>
      op.table === "users" ? { data: { id: EXISTING } } : op.table === "organizations" ? { data: { id: ORG, name: "A" } } : undefined;
    const res = await adminActions.grantOrganizationAccess(ORG, { fullName: "Jean", email: "jean@exemple.fr", role: "admin", password: "Provisoire-2026" });
    expect(res).toMatchObject({ ok: true, pending: true, created: false, passwordIgnored: true, emailSent: true });
    expect(writes("organization_users")[0]).toMatchObject({ action: "insert", values: expect.objectContaining({ status: "invited" }) });

    h.ops.length = 0;
    h.handle = (op) =>
      op.table === "users"
        ? { data: { id: EXISTING } }
        : op.table === "organizations"
          ? { data: { id: ORG, name: "A" } }
          : op.table === "organization_users" && op.action === "select"
            ? { data: { id: MEMBER_ROW, role: "admin", status: "disabled" } }
            : undefined;
    expect(await adminActions.grantOrganizationAccess(ORG, { fullName: "Jean", email: "jean@exemple.fr", role: "admin" })).toMatchObject({ ok: true, pending: false, reactivated: true });
    expect(writes("organization_users")[0]).toMatchObject({ action: "update", values: { role: "admin", status: "active" } });
  });

  it("suspension d'une centrale : aucun bannissement Auth ; réactivation : levée seulement pour membres et chauffeurs autorisés", async () => {
    expect(await adminActions.setOrganizationStatus(ORG, "suspended", "Impayé")).toEqual({ ok: true });
    expect(authCalls("updateUserById")).toEqual([]);
    expect(await adminActions.setOrganizationStatus("x", "suspended")).toEqual({ ok: false, error: "Demande invalide." });

    const M = "99999999-9999-4999-8999-999999999999";
    h.handle = (op) => {
      if (op.table === "organization_users") return { data: [{ user_id: M }, { user_id: EXISTING }] };
      if (op.table === "drivers" && op.filters["user_id[]"]) return { data: [{ user_id: EXISTING, status: "suspended", application_status: null, banned_at: null, deleted_at: null }] };
      if (op.table === "drivers") {
        return {
          data: [
            { user_id: DRIVER_USER, status: "active", application_status: null, banned_at: null, deleted_at: null },
            { user_id: "b1", status: "suspended", application_status: null, banned_at: "2026-01-01", deleted_at: null },
            { user_id: "c1", status: "inactive", application_status: null, banned_at: null, deleted_at: null },
            { user_id: "p1", status: "inactive", application_status: "pending", banned_at: null, deleted_at: null },
          ],
        };
      }
      return undefined;
    };
    expect(await adminActions.setOrganizationStatus(ORG, "active")).toEqual({ ok: true });
    expect(authCalls("updateUserById").map((c) => c[1]).sort()).toEqual([DRIVER_USER, M, "p1"].sort());
    expect(authCalls("updateUserById").every((c) => (c[2] as { ban_duration: string }).ban_duration === "none")).toBe(true);
  });
});

describe("Fiche chauffeur : compte partagé et statut", () => {
  const ownDriver = (shared: boolean) => (op: Op): Reply => {
    if (op.client === "rls" && op.table === "drivers" && op.filters.organization_id === ORG) return { data: { id: DRIVER, user_id: DRIVER_USER } };
    if (op.table === "rpc:svc_login_account_shared") return { data: shared };
    return undefined;
  };

  it("mot de passe imposé refusé pour un compte qui gère aussi une centrale", async () => {
    h.handle = ownDriver(true);
    const res = await drivers.resetDriverPassword(DRIVER, "Nouveau-Secret-2026");
    expect(res).toEqual({ ok: false, error: "Ce compte sert aussi à gérer une centrale : le chauffeur doit utiliser « Mot de passe oublié » dans l'application." });
    expect(h.auth).toEqual([]);

    h.handle = ownDriver(false);
    expect(await drivers.resetDriverPassword(DRIVER, "Nouveau-Secret-2026")).toEqual({ ok: true });
    expect(authCalls("updateUserById")).toEqual([["updateUserById", DRIVER_USER, { password: "Nouveau-Secret-2026" }]]);
  });

  it("suspendre : RPC set_driver_status, jamais de bannissement Auth ; chauffeur d'une autre centrale : introuvable", async () => {
    h.handle = (op) =>
      ownDriver(false)(op) ??
      (op.table === "rpc:set_driver_status" ? { data: { ok: true, code: "STATUS_CHANGED", user_id: DRIVER_USER, reassigned_rides: 1, message: "Chauffeur suspendu : 1 course(s) attribuée(s) remise(s) en recherche." } } : undefined);
    const res = await drivers.setDriverStatus(DRIVER, { status: "suspended", reason: "Document expiré" });
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining("remise(s) en recherche") });
    expect(h.ops.find((o) => o.table === "rpc:set_driver_status")?.values).toEqual({ p_driver_id: DRIVER, p_status: "suspended", p_reason: "Document expiré" });
    expect(h.auth).toEqual([]);
    expect(writes("drivers")).toEqual([]);

    h.ctx.org.id = OTHER_ORG;
    h.ops.length = 0;
    expect(await drivers.setDriverStatus(DRIVER, { status: "suspended" })).toEqual({ ok: false, error: "Chauffeur introuvable." });
    expect(h.ops.some((o) => o.table.startsWith("rpc:"))).toBe(false);
  });

  it("bannir : pas de bannissement Auth d'un compte partagé ; lever : compte débloqué aussitôt", async () => {
    h.handle = (op) => ownDriver(true)(op) ?? (op.table === "rpc:ban_driver" ? { data: { ok: true, code: "BANNED", user_id: DRIVER_USER } } : undefined);
    expect(await drivers.banDriver(DRIVER, { reason: "Fraude avérée", category: "fraud", reportToPlatform: false, banVehicle: false })).toMatchObject({ ok: true });
    expect(h.auth).toEqual([]);
    expect(h.audits.at(-1)?.metadata).toMatchObject({ auth_banned: false, shared_account: true });

    h.handle = (op) => ownDriver(false)(op) ?? (op.table === "rpc:ban_driver" ? { data: { ok: true, code: "BANNED", user_id: DRIVER_USER } } : undefined);
    await drivers.banDriver(DRIVER, { reason: "Fraude avérée", category: "fraud", reportToPlatform: false, banVehicle: false });
    expect(authCalls("updateUserById")).toEqual([["updateUserById", DRIVER_USER, { ban_duration: "876000h" }]]);

    h.auth.length = 0;
    h.handle = (op) => ownDriver(false)(op) ?? (op.table === "rpc:lift_driver_ban" ? { data: { ok: true, code: "LIFTED", user_id: DRIVER_USER } } : undefined);
    expect(await drivers.liftDriverBan(DRIVER)).toMatchObject({ ok: true });
    expect(authCalls("updateUserById")).toEqual([["updateUserById", DRIVER_USER, { ban_duration: "none" }]]);
  });

  it("document : échéance obligatoire pour les pièces à échéance, jamais passée ; « Visite médicale » plus proposée", async () => {
    h.handle = ownDriver(false);
    expect(await drivers.addDriverDocument(DRIVER, { type: "vtc_card", expiresAt: "" })).toMatchObject({ ok: false, fieldErrors: { expiresAt: expect.any(String) } });
    expect(await drivers.addDriverDocument(DRIVER, { type: "insurance", expiresAt: "2001-01-01" })).toMatchObject({ ok: false, fieldErrors: { expiresAt: "Date passée" } });
    expect(await drivers.addDriverDocument(DRIVER, { type: "medical" as never, expiresAt: "2099-01-01" })).toEqual({ ok: false, error: "Document invalide." });
    expect(writes("driver_documents")).toEqual([]);
    expect(await drivers.addDriverDocument(DRIVER, { type: "vehicle_registration", expiresAt: "" })).toEqual({ ok: true });
    const next = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    expect(await drivers.addDriverDocument(DRIVER, { type: "vtc_card", expiresAt: next })).toEqual({ ok: true });
    expect(writes("driver_documents").map((o) => o.values.expires_at)).toEqual([null, next]);
  });
});
