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
  /** banned_until du compte Auth lu par auth.admin.getUserById (null = connexion possible) */
  bannedUntil: null as string | null,
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
        getUserById: async (id: string) => ({ data: { user: { id, banned_until: h.bannedUntil } }, error: null }),
      },
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-fetch", () => ({ serverFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
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
  h.bannedUntil = null;
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

  it("invitation en attente du PROPRIÉTAIRE : un administrateur la renvoie mais ne l'annule pas ; le propriétaire, si", async () => {
    const invitation = (role: string) => (op: Op): Reply =>
      op.table === "organization_users" && op.action === "select"
        ? { data: { id: MEMBER_ROW, user_id: EXISTING, role, status: "invited", user: { email: "proprietaire@exemple.fr" } } }
        : undefined;
    h.ctx.role = "admin";
    h.handle = invitation("owner");
    expect(await settings.cancelMemberInvitation(MEMBER_ROW)).toEqual({
      ok: false,
      error: "Seul un propriétaire peut annuler l'invitation d'un propriétaire.",
    });
    expect(writes("organization_users")).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(await settings.resendMemberInvitation(MEMBER_ROW)).toEqual({ ok: true });
    expect(h.emails.map((e) => e.email)).toEqual(["proprietaire@exemple.fr"]);

    // Invitation d'un administrateur ou d'un dispatcher : l'administrateur l'annule
    h.handle = invitation("dispatcher");
    expect(await settings.cancelMemberInvitation(MEMBER_ROW)).toEqual({ ok: true });
    expect(writes("organization_users")).toEqual([expect.objectContaining({ action: "delete" })]);

    // Le propriétaire annule l'invitation d'un autre propriétaire
    h.ops.length = 0;
    h.ctx.role = "owner";
    h.handle = invitation("owner");
    expect(await settings.cancelMemberInvitation(MEMBER_ROW)).toEqual({ ok: true });
    expect(writes("organization_users")).toEqual([expect.objectContaining({ action: "delete", filters: expect.objectContaining({ status: "invited" }) })]);
  });
});

describe("Super admin : propriétaire et accès", () => {
  const org = { name: "Taxis Dupont", slug: "taxis-dupont", email: "contact@taxis-dupont.fr", ownerName: "Paul Dupont", ownerEmail: "contact@taxis-dupont.fr", ownerPassword: "Provisoire-2026" };

  // Réglage initial du modèle et des frais (svc_platform_set_fees « initial ») : accepté
  const initialFees = (op: Op): Reply => (op.table === "rpc:svc_platform_set_fees" ? { data: { ok: true, code: "UNCHANGED" } } : undefined);

  it("création de centrale : propriétaire au compte existant = invitation, jamais rattaché actif", async () => {
    h.handle = (op) =>
      op.table === "users"
        ? { data: { id: EXISTING } }
        : op.table === "organizations" && op.action === "insert"
          ? { data: { id: ORG } }
          : initialFees(op);
    const res = await adminActions.createOrganization(org);
    expect(res).toMatchObject({ ok: true, id: ORG, ownerInvited: true, emailSent: true, passwordIgnored: true });
    expect(writes("organization_users")[0]?.values).toMatchObject({ user_id: EXISTING, role: "owner", status: "invited" });
    expect(h.emails.map((e) => e.email)).toEqual(["contact@taxis-dupont.fr"]);
    expect(h.auth).toEqual([]);

    // Le super admin qui se nomme lui-même : accès direct
    h.ops.length = 0;
    h.emails.length = 0;
    h.handle = (op) =>
      op.table === "users"
        ? { data: { id: OWNER } }
        : op.table === "organizations" && op.action === "insert"
          ? { data: { id: ORG } }
          : initialFees(op);
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

  it("suspension d'une centrale : aucun bannissement Auth ; réactivation : levée pour les membres (fiche chauffeur inactive ou suspendue comprise) et les chauffeurs autorisés, jamais pour une fiche bannie", async () => {
    expect(await adminActions.setOrganizationStatus(ORG, "suspended", "Impayé")).toEqual({ ok: true });
    expect(authCalls("updateUserById")).toEqual([]);
    expect(await adminActions.setOrganizationStatus("x", "suspended")).toEqual({ ok: false, error: "Demande invalide." });

    const M = "99999999-9999-4999-8999-999999999999";
    // Membres : M (aucune fiche), EXISTING (fiche suspendue dans une autre centrale : compte de gestion, ancien
    // bannissement hérité levé), « bm » (fiche bannie par sa centrale) et « bp » (banni de la plateforme) : vrais
    // bannissements, jamais levés ici
    h.handle = (op) => {
      if (op.table === "organization_users") return { data: [{ user_id: M }, { user_id: EXISTING }, { user_id: "bm" }, { user_id: "bp" }] };
      if (op.table === "drivers" && op.filters["user_id[]"]) {
        return {
          data: [
            { user_id: EXISTING, status: "suspended", application_status: null, banned_at: null, deleted_at: null },
            { user_id: "bm", status: "suspended", application_status: null, banned_at: "2026-01-01", deleted_at: null },
            { user_id: "bp", status: "inactive", application_status: null, banned_at: "2026-02-01", deleted_at: null },
          ],
        };
      }
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
    expect(authCalls("updateUserById").map((c) => c[1]).sort()).toEqual([DRIVER_USER, M, EXISTING, "p1"].sort());
    expect(authCalls("updateUserById").every((c) => (c[2] as { ban_duration: string }).ban_duration === "none")).toBe(true);
    expect(h.audits.at(-1)).toMatchObject({ action: "organization.active", metadata: { auth_unbanned: 4 } });
  });

  it("« Débloquer la connexion » d'un membre : verrou Auth levé et journalisé ; jamais pour une fiche bannie ni hors de la centrale", async () => {
    const member = (over: Record<string, unknown> = {}) => ({ user_id: EXISTING, role: "admin", status: "active", user: { email: "gerant@exemple.fr" }, ...over });
    const card = (over: Record<string, unknown> = {}) => ({ id: DRIVER, status: "inactive", banned_at: null, ban_scope: null, organization_id: OTHER_ORG, ...over });
    const setup = (m: unknown, c: unknown) => {
      h.handle = (op) => (op.table === "organization_users" ? { data: m } : op.table === "drivers" ? { data: c } : undefined);
    };
    const reset = () => {
      h.ops.length = 0;
      h.auth.length = 0;
      h.audits.length = 0;
    };

    // Gérant de la centrale, fiche chauffeur désactivée par une autre centrale avant le correctif (ancien ban Auth)
    h.bannedUntil = "2126-01-01T00:00:00Z";
    setup(member(), card());
    expect(await adminActions.unlockMemberLogin(ORG, MEMBER_ROW)).toEqual({ ok: true, message: "Connexion débloquée : gerant@exemple.fr peut de nouveau se connecter." });
    expect(authCalls("updateUserById")).toEqual([["updateUserById", EXISTING, { ban_duration: "none" }]]);
    expect(h.ops.find((o) => o.table === "organization_users")?.filters).toEqual({ id: MEMBER_ROW, organization_id: ORG });
    expect(h.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG, actorUserId: OWNER, actorType: "super_admin", action: "member.login_unlocked", entityType: "organization_users",
        entityId: EXISTING, severity: "warning",
        metadata: expect.objectContaining({ email: "gerant@exemple.fr", role: "admin", driver_status: "inactive" }),
      }),
    ]);

    // Fiche bannie par une centrale, ou bannissement plateforme : le verrou reste
    for (const [scope, text] of [["org", "sa centrale"], ["platform", "plateforme"]] as const) {
      reset();
      setup(member(), card({ banned_at: "2026-01-01T00:00:00Z", ban_scope: scope, status: "suspended" }));
      const res = await adminActions.unlockMemberLogin(ORG, MEMBER_ROW);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining(text) });
      expect(h.auth).toEqual([]);
      expect(h.audits).toEqual([]);
    }

    // Compte qui n'est pas (ou plus) bloqué : rien à écrire
    reset();
    h.bannedUntil = null;
    setup(member(), null);
    expect(await adminActions.unlockMemberLogin(ORG, MEMBER_ROW)).toEqual({ ok: true, message: "Ce compte n'est pas bloqué : aucune action nécessaire." });
    expect(h.auth).toEqual([]);
    expect(h.audits).toEqual([]);

    // Membre d'une autre centrale (ou identifiant inconnu) : introuvable ; identifiants invalides : refus sans lecture
    reset();
    h.bannedUntil = "2126-01-01T00:00:00Z";
    setup(null, null);
    expect(await adminActions.unlockMemberLogin(ORG, MEMBER_ROW)).toEqual({ ok: false, error: "Membre introuvable." });
    expect(await adminActions.unlockMemberLogin("x", MEMBER_ROW)).toEqual({ ok: false, error: "Demande invalide." });
    expect(h.auth).toEqual([]);
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
