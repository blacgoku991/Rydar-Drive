import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_KEY_SCOPES, ERROR_MESSAGES, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, PRIVATE_FLEET_BLOCKER_LABELS, PRIVATE_FLEET_BLOCKERS,
  PRIVATE_FLEET_SITE_KEY_SCOPES,
} from "@rydar/shared";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Flotte Privée — super admin (lot L2, docs/FLOTTE-PRIVEE.md § 8 et § 9.4) : création (compte neuf prouvé, invitation,
// RPC, compensation limitée au compte créé ici), clé du site (débit réglable), fiche recréée, changement d'offre de
// service (offre écrite par la RPC), offre qui perdrait l'API, refus en Flotte Privée des actions du super admin et des
// clés / webhooks du tableau de bord (D16), insertKey extrait à l'identique, règles pures de la fiche. Vraies actions
// serveur, Supabase simulé ; Auth simulé comme GoTrue (admin.go : createUser refuse toute adresse connue, confirmée ou
// non ; invite.go : l'invitation d'un compte non confirmé le renvoie, celle d'un compte confirmé est refusée).

type Op = { client: string; table: string; action: string; values?: any; columns?: string; filters: Record<string, unknown> };
type Reply = { data?: unknown; error?: unknown; count?: number } | undefined;

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  handle: (() => undefined) as (op: Op) => Reply,
  auth: [] as [string, ...unknown[]][],
  /** Comptes Auth par adresse (GoTrue simulé) */
  accounts: new Map<string, { id: string; confirmed: boolean }>(),
  audits: [] as Record<string, any>[],
  revalidated: [] as string[],
  session: null as any,
  ctx: null as any,
  invitationEmails: [] as string[],
  sendOk: true,
  createError: null as unknown,
  inviteError: null as unknown,
  deleteUserError: null as unknown,
  lastSignInAt: null as string | null,
  contactUpdates: [] as { id: string; input: { status: string; note: string } }[],
  webhookCalls: [] as { fn: string; org: string; args: Record<string, unknown> }[],
}));

/** Refus de GoTrue pour une adresse déjà connue (422 email_exists). */
const EMAIL_EXISTS = { status: 422, code: "email_exists", message: "A user with this email address has already been registered" };

function fakeDb(name: string) {
  const reply = (op: Op) => {
    h.ops.push(op);
    const r = h.handle(op) ?? {};
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
  };
  return {
    from(table: string) {
      const op: Op = { client: name, table, action: "select", filters: {} };
      const b: any = {
        select: (cols?: string) => ((op.columns ??= cols), b),
        insert: (v: unknown) => ((op.action = "insert"), (op.values = v), b),
        update: (v: unknown) => ((op.action = "update"), (op.values = v), b),
        delete: () => ((op.action = "delete"), b),
        eq: (c: string, v: unknown) => ((op.filters[c] = v), b),
        in: (c: string, v: unknown) => ((op.filters[`${c}[]`] = v), b),
        is: (c: string, v: unknown) => ((op.filters[`${c} is`] = v), b),
        ilike: (c: string, v: unknown) => ((op.filters[`${c}~`] = v), b),
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
        // admin.go (adminUserCreate) : toute adresse connue, confirmée ou non → 422 email_exists
        createUser: async (a: { email: string; email_confirm?: boolean }) => {
          h.auth.push(["createUser", a]);
          if (h.createError) return { data: { user: null }, error: h.createError };
          if (h.accounts.has(a.email)) return { data: { user: null }, error: EMAIL_EXISTS };
          h.accounts.set(a.email, { id: NEW_USER, confirmed: a.email_confirm === true });
          return { data: { user: { id: NEW_USER } }, error: null };
        },
        // invite.go : compte confirmé → email_exists ; compte NON confirmé → invitation renvoyée, compte EXISTANT renvoyé
        inviteUserByEmail: async (email: string, opts: unknown) => {
          h.auth.push(["inviteUserByEmail", email, opts]);
          if (h.inviteError) return { data: { user: null }, error: h.inviteError };
          const known = h.accounts.get(email);
          if (known?.confirmed) return { data: { user: null }, error: EMAIL_EXISTS };
          if (known) return { data: { user: { id: known.id } }, error: null };
          h.accounts.set(email, { id: INVITED_USER, confirmed: false });
          return { data: { user: { id: INVITED_USER } }, error: null };
        },
        deleteUser: async (id: string) => (h.auth.push(["deleteUser", id]), { data: {}, error: h.deleteUserError }),
        getUserById: async (id: string) => ({
          data: { user: { id, last_sign_in_at: h.lastSignInAt, invited_at: "2026-10-09T10:00:00Z" } },
          error: null,
        }),
        updateUserById: async (id: string, a: unknown) => (h.auth.push(["updateUserById", id, a]), { data: {}, error: null }),
      },
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string, type?: string) => void h.revalidated.push(type ? `${p} (${type})` : p) }));
vi.mock("@/lib/env", () => ({
  env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon-key", appUrl: "https://app.rydar.test", rootDomain: "rydar.test" },
  serverEnv: () => ({ apiKeyPepper: PEPPER }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void h.audits.push(e) }));
vi.mock("@/lib/auth", () => ({
  isAdminRole: (r: string) => r === "owner" || r === "admin",
  requireSuperAdmin: async () => {
    if (!h.session) throw new Error("NEXT_REDIRECT");
    return h.session;
  },
}));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/suspension", async () => await import("./suspension"));
vi.mock("@/lib/server-fetch", () => ({ serverFetch: fetch }));
// Vrai module (likeExact, findUserIdByEmail), sauf l'envoi du lien
vi.mock("@/lib/member-invite", async () => ({
  ...(await import("./member-invite")),
  sendMemberInvitationEmail: async (email: string) => (h.invitationEmails.push(email), h.sendOk),
}));
vi.mock("@/lib/api-keys", async () => await import("./api-keys"));
vi.mock("@/lib/api-keys-server", async () => await import("./api-keys-server"));
vi.mock("@/lib/webhooks", () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  webhookRpc: async (fn: string, org: string, _actor: unknown, args: Record<string, unknown>) => (
    h.webhookCalls.push({ fn, org, args }), { ok: true, data: { created: true, secret: "whsec_x" } }
  ),
  webhookTestRpc: async (fn: string, org: string, _actor: unknown, args: Record<string, unknown>) => (
    h.webhookCalls.push({ fn, org, args }), { ok: true, data: {} }
  ),
}));
vi.mock("@/components/admin/private-fleet-state", async () => await import("../components/admin/private-fleet-state"));
vi.mock("@/components/platform-fees/org-platform-format", async () => await import("../components/platform-fees/org-platform-format"));
vi.mock("@/components/network-share/admin", async () => await import("../components/network-share/admin"));
vi.mock("@/app/admin/contacts/actions", () => ({
  updateContactRequest: async (id: string, input: { status: string; note: string }) => (h.contactUpdates.push({ id, input }), { ok: true }),
}));

const PEPPER = "pepper-de-test-assez-long";
const NEW_USER = "44444444-4444-4444-8444-444444444444";
/** Compte créé par une invitation seule (jamais par createPrivateFleet) */
const INVITED_USER = "45454545-4545-4545-8545-454545454545";
/** Compte d'une autre organisation (invitation jamais activée, chauffeur…) */
const EXISTING = "99999999-9999-4999-8999-999999999999";
const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = "77777777-7777-4777-8777-777777777777";
const PLAN = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const DRIVER = "66666666-6666-4666-8666-666666666666";

const admin = fakeDb("admin");
const user = fakeDb("user");
const fleet = await import("../app/admin/flotte-privee/actions");
const adminActions = await import("../app/admin/actions");
const network = await import("../app/admin/reseau/actions");
const integrations = await import("../app/dashboard/integrations/actions");
const { insertKey } = await import("./api-keys-server");
const state = await import("../components/admin/private-fleet-state");

const rpcCalls = (fn: string) => h.ops.filter((o) => o.table === `rpc:${fn}`).map((o) => o.values);
const writes = (table: string) => h.ops.filter((o) => o.table === table && ["insert", "update", "delete"].includes(o.action));
const authCalls = (kind: string) => h.auth.filter((a) => a[0] === kind);

beforeEach(() => {
  h.ops.length = 0;
  h.auth.length = 0;
  h.accounts.clear();
  h.audits.length = 0;
  h.revalidated.length = 0;
  h.invitationEmails.length = 0;
  h.contactUpdates.length = 0;
  h.webhookCalls.length = 0;
  h.handle = () => undefined;
  h.session = { user: { id: ACTOR } };
  h.ctx = null;
  h.sendOk = true;
  h.createError = null;
  h.inviteError = null;
  h.deleteUserError = null;
  h.lastSignInAt = null;
});

// -----------------------------------------------------------------------------
// Création
// -----------------------------------------------------------------------------
const CREATE = {
  name: "VTC Martin",
  slug: "vtc-martin",
  email: "contact@vtc-martin.fr",
  phone: "06 12 34 56 78",
  city: "Lyon",
  legalName: "",
  siret: "",
  vtcRegistration: "EVTC069250001",
  ownerFirstName: "Paul",
  ownerLastName: "Martin",
  ownerEmail: "Paul@VTC-Martin.fr",
  ownerPhone: "06 98 76 54 32",
  vtcCardNumber: "",
  vehicle: { brand: "Mercedes", model: "Classe E", color: "Noire", plate: "ab-123-cd", category: "business" as const, seats: "4", luggageCapacity: "3" },
  platformFeePercent: 0,
  platformFeeFixedCents: 0,
  planId: "",
  contractRef: "CP-2026-014 signé le 08/10/2026",
  temporaryPassword: false,
  password: "",
};

const created = (op: Op): Reply =>
  op.table === "rpc:svc_platform_create_private_fleet"
    ? { data: { ok: true, code: "CREATED", organization_id: ORG, driver_id: DRIVER, fees: { ok: true, code: "APPLIED", message: "Frais appliqués." } } }
    : undefined;

/** Recherche du compte du propriétaire (public.users, égalité sans joker) : opération lue par le faux client. */
const lookup = () => h.ops.find((o) => o.table === "users");

describe("createPrivateFleet : compte neuf prouvé, invitation, puis RPC, tout ou rien", () => {
  it("compte créé (createUser, non confirmé), invitation par e-mail, puis svc_platform_create_private_fleet ; aucun audit doublé", async () => {
    h.handle = created;
    const res = await fleet.createPrivateFleet(CREATE);
    expect(res).toMatchObject({ ok: true, id: ORG, name: "VTC Martin", contactUpdated: null });
    expect(res.ok && res.message).toBe(
      "Invitation envoyée à paul@vtc-martin.fr\u00a0: le client choisit son mot de passe, accepte les CGV dans son espace web, puis se connecte à l'application avec les mêmes identifiants.",
    );
    // Recherche par égalité (jokers échappés), avant tout compte
    expect(lookup()).toMatchObject({ client: "admin", columns: "id", filters: { "email~": "paul@vtc-martin.fr" } });
    // Compte NEUF d'abord (preuve : Auth refuse toute adresse connue), puis le lien « choisir son mot de passe »
    expect(h.auth).toEqual([
      ["createUser", { email: "paul@vtc-martin.fr", email_confirm: false, user_metadata: { full_name: "Paul Martin" } }],
      ["inviteUserByEmail", "paul@vtc-martin.fr", { redirectTo: "https://app.rydar.test/auth/set-password" }],
    ]);
    expect(rpcCalls("svc_platform_create_private_fleet")).toEqual([
      {
        p_actor: ACTOR,
        p_owner: NEW_USER,
        p_org: {
          name: "VTC Martin", slug: "vtc-martin", email: "contact@vtc-martin.fr", phone: "+33612345678", city: "Lyon", legal_name: null, siret: null,
          vtc_registration: "EVTC069250001",
        },
        p_driver: { first_name: "Paul", last_name: "Martin", phone: "+33698765432", email: "paul@vtc-martin.fr", vtc_card_number: null },
        p_vehicle: { brand: "Mercedes", model: "Classe E", color: "Noire", plate: "AB-123-CD", category: "business", seats: 4, luggage_capacity: 3 },
        p_plan_id: null,
        p_percent: 0,
        p_fixed_cents: 0,
        p_contract_ref: "CP-2026-014 signé le 08/10/2026",
        p_org_legal_version: ORG_LEGAL_VERSION,
        p_org_legal_effective_on: ORG_LEGAL_EFFECTIVE_AT,
        p_app_url: "https://app.rydar.test",
      },
    ]);
    // Rien d'écrit hors de la RPC (organisation, adhésion, fiche, frais : une transaction), journal écrit en base
    expect(h.ops.filter((o) => ["insert", "update", "delete"].includes(o.action))).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(authCalls("deleteUser")).toEqual([]);
    expect(h.revalidated).toEqual(["/admin", "/admin/organizations"]);
  });

  it("adresse qui a déjà un compte Rydar : refus clair AVANT tout compte et toute invitation (phase 1)", async () => {
    h.handle = (op) => (op.table === "users" ? { data: [{ id: EXISTING }] } : undefined);
    expect(await fleet.createPrivateFleet(CREATE)).toEqual({
      ok: false,
      error: "Cette adresse a déjà un compte Rydar\u00a0: demandez une autre adresse au client.",
      fieldErrors: { ownerEmail: "Adresse déjà utilisée par un compte Rydar" },
    });
    expect(h.auth).toEqual([]);
    expect(rpcCalls("svc_platform_create_private_fleet")).toEqual([]);
  });

  it("recherche du compte en échec : refus, jamais lue comme « aucun compte » ; rien n'est créé", async () => {
    h.handle = (op) => (op.table === "users" ? { error: { code: "PGRST000", message: "upstream request timeout" } } : undefined);
    expect(await fleet.createPrivateFleet(CREATE)).toEqual({ ok: false, error: "Vérification impossible pour le moment\u00a0: réessayez." });
    expect(h.auth).toEqual([]);
    expect(rpcCalls("svc_platform_create_private_fleet")).toEqual([]);
  });

  it("compte Auth existant jamais confirmé (invitation jamais activée) absent de la recherche : createUser refuse, rien n'est invité ni supprimé", async () => {
    // GoTrue simulé : une invitation seule renverrait ce compte (200) au lieu d'un refus — la création le prouve neuf
    h.accounts.set("paul@vtc-martin.fr", { id: EXISTING, confirmed: false });
    expect(await fleet.createPrivateFleet(CREATE)).toEqual({
      ok: false,
      error: "Cette adresse a déjà un compte Rydar\u00a0: demandez une autre adresse au client.",
      fieldErrors: { ownerEmail: "Adresse déjà utilisée par un compte Rydar" },
    });
    expect(authCalls("inviteUserByEmail")).toEqual([]);
    expect(authCalls("deleteUser")).toEqual([]);
    expect(rpcCalls("svc_platform_create_private_fleet")).toEqual([]);
    // Même refus pour un compte confirmé, et avec le mot de passe provisoire
    h.accounts.set("paul@vtc-martin.fr", { id: EXISTING, confirmed: true });
    expect(await fleet.createPrivateFleet({ ...CREATE, temporaryPassword: true, password: "Provisoire-2026" })).toMatchObject({
      ok: false, fieldErrors: { ownerEmail: "Adresse déjà utilisée par un compte Rydar" },
    });
    expect(authCalls("deleteUser")).toEqual([]);
  });

  it("identifiant pris ou offre sans API : refus avant tout compte (aucun e-mail pour une création vouée à l'échec)", async () => {
    h.handle = (op) => (op.table === "organizations" ? { data: { id: "x" } } : undefined);
    expect(await fleet.createPrivateFleet(CREATE)).toMatchObject({ ok: false, fieldErrors: { slug: "Déjà utilisé" } });
    expect(h.auth).toEqual([]);

    h.handle = (op) => (op.table === "plans" ? { data: { id: PLAN, is_active: true, limits: { api_access: false, max_drivers: 1 } } } : undefined);
    expect(await fleet.createPrivateFleet({ ...CREATE, planId: PLAN })).toEqual({
      ok: false,
      error: ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID,
      fieldErrors: { planId: "Offre inactive ou sans accès à l'API" },
    });
    expect(h.auth).toEqual([]);

    // Offre avec l'API : transmise à la RPC
    h.handle = (op) => (op.table === "plans" ? { data: { id: PLAN, is_active: true, limits: { api_access: true } } } : created(op));
    expect(await fleet.createPrivateFleet({ ...CREATE, planId: PLAN })).toMatchObject({ ok: true });
    expect(rpcCalls("svc_platform_create_private_fleet")[0]).toMatchObject({ p_plan_id: PLAN });
  });

  it("saisie invalide : message nommé, rien n'est appelé", async () => {
    const res = await fleet.createPrivateFleet({ ...CREATE, contractRef: "x" });
    expect(res).toMatchObject({ ok: false, fieldErrors: { contractRef: expect.any(String) } });
    expect(res.ok === false && res.error.startsWith("Référence du contrat signé :")).toBe(true);
    expect(await fleet.createPrivateFleet({ ...CREATE, temporaryPassword: true, password: "" })).toMatchObject({ ok: false, fieldErrors: { password: expect.any(String) } });
    // Ville obligatoire (§ 8.1), comme le nom commercial, l'identifiant, l'e-mail et le téléphone du client
    expect(await fleet.createPrivateFleet({ ...CREATE, city: "  " })).toEqual({
      ok: false,
      error: "Ville : ville requise",
      fieldErrors: { city: "Ville requise" },
    });
    expect(h.ops).toEqual([]);
    expect(h.auth).toEqual([]);
  });

  it("mot de passe provisoire (case cochée) : compte créé confirmé, sans invitation", async () => {
    h.handle = created;
    const res = await fleet.createPrivateFleet({ ...CREATE, temporaryPassword: true, password: "Provisoire-2026" });
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.message).toContain("mot de passe provisoire");
    expect(authCalls("createUser")).toEqual([
      ["createUser", { email: "paul@vtc-martin.fr", password: "Provisoire-2026", email_confirm: true, user_metadata: { full_name: "Paul Martin" } }],
    ]);
    expect(authCalls("inviteUserByEmail")).toEqual([]);
  });

  it("invitation impossible après la création du compte : compte créé ici supprimé, aucune RPC", async () => {
    h.inviteError = { status: 500, code: "unexpected_failure", message: "Error sending invite email" };
    const res = await fleet.createPrivateFleet(CREATE);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("Invitation impossible") });
    expect(authCalls("deleteUser")).toEqual([["deleteUser", NEW_USER]]);
    expect(rpcCalls("svc_platform_create_private_fleet")).toEqual([]);
  });

  it("refus de la RPC (champ) ou erreur levée : compte Auth créé supprimé (compensation), après relecture (ni adhésion ni fiche)", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_create_private_fleet"
        ? { data: { ok: false, code: "INVALID", field: "platformFeeFixedCents", message: "Frais fixes par course : entre 0 et 1 000 €." } }
        : undefined;
    expect(await fleet.createPrivateFleet(CREATE)).toEqual({
      ok: false,
      error: "Frais fixes par course : entre 0 et 1 000 €.",
      fieldErrors: { platformFeeFixedCents: "Frais fixes par course : entre 0 et 1 000 €." },
    });
    expect(authCalls("deleteUser")).toEqual([["deleteUser", NEW_USER]]);
    expect(h.ops.filter((o) => ["organization_users", "drivers"].includes(o.table)).map((o) => [o.table, o.filters])).toEqual([
      ["organization_users", { user_id: NEW_USER }],
      ["drivers", { user_id: NEW_USER }],
    ]);

    h.auth.length = 0;
    h.accounts.clear();
    h.handle = (op) =>
      op.table === "rpc:svc_platform_create_private_fleet" ? { error: { code: "P0001", message: "IDENTITY_BANNED: identité refusée" } } : undefined;
    const res = await fleet.createPrivateFleet(CREATE);
    expect(res).toMatchObject({ ok: false, error: ERROR_MESSAGES.IDENTITY_BANNED });
    expect(authCalls("deleteUser")).toEqual([["deleteUser", NEW_USER]]);
    expect(h.revalidated).toEqual([]);
  });

  it("refus qui disent le compte déjà utilisé (OWNER_NOT_NEW, ALREADY_REGISTERED, SELF_NOT_ALLOWED, NOT_FOUND) : jamais de suppression", async () => {
    for (const code of ["OWNER_NOT_NEW", "ALREADY_REGISTERED", "SELF_NOT_ALLOWED", "NOT_FOUND"]) {
      h.auth.length = 0;
      h.accounts.clear();
      h.handle = (op) =>
        op.table === "rpc:svc_platform_create_private_fleet" ? { data: { ok: false, code, field: "ownerEmail", message: `Refus ${code}.` } } : undefined;
      const res = await fleet.createPrivateFleet(CREATE);
      expect(res, code).toMatchObject({ ok: false, fieldErrors: { ownerEmail: `Refus ${code}.` } });
      expect(res.ok === false && res.error, code).toContain("n'a pas été supprimé");
      expect(authCalls("deleteUser"), code).toEqual([]);
    }
  });

  it("erreur sans réponse de la RPC alors qu'elle a validé (adhésion ou fiche relue) : compte gardé, création peut-être aboutie", async () => {
    for (const table of ["organization_users", "drivers"]) {
      h.auth.length = 0;
      h.accounts.clear();
      h.handle = (op) =>
        op.table === "rpc:svc_platform_create_private_fleet"
          ? { error: { message: "TypeError: fetch failed" } }
          : op.table === table
            ? { data: [{ id: "lié" }] }
            : undefined;
      const res = await fleet.createPrivateFleet(CREATE);
      expect(res, table).toMatchObject({ ok: false });
      expect(res.ok === false && res.error, table).toContain("La création a peut-être abouti");
      expect(authCalls("deleteUser"), table).toEqual([]);
    }
  });

  it("relecture impossible ou suppression refusée : compte gardé, le message demande de vérifier puis de le supprimer", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_create_private_fleet"
        ? { error: { message: "TypeError: fetch failed" } }
        : op.table === "organization_users"
          ? { error: { code: "PGRST000", message: "timeout" } }
          : undefined;
    const unread = await fleet.createPrivateFleet(CREATE);
    expect(unread.ok === false && unread.error).toContain("Le compte créé pour paul@vtc-martin.fr n'a pas été supprimé");
    expect(authCalls("deleteUser")).toEqual([]);

    h.auth.length = 0;
    h.accounts.clear();
    h.deleteUserError = { message: "boom" };
    h.handle = (op) =>
      op.table === "rpc:svc_platform_create_private_fleet" ? { data: { ok: false, code: "SLUG_TAKEN", field: "slug", message: "Ce slug est déjà utilisé." } } : undefined;
    const res = await fleet.createPrivateFleet(CREATE);
    expect(res).toMatchObject({ ok: false, fieldErrors: { slug: "Ce slug est déjà utilisé." } });
    expect(res.ok === false && res.error).toContain("n'a pas été supprimé");
    expect(authCalls("deleteUser")).toEqual([["deleteUser", NEW_USER]]);
  });

  it("depuis une demande de contact : demande « traitée », note gardée et complétée", async () => {
    h.handle = (op) => (op.table === "contact_requests" ? { data: { admin_note: "Rappelé le 09/10." } } : created(op));
    expect(await fleet.createPrivateFleet(CREATE, CONTACT)).toMatchObject({ ok: true, contactUpdated: true });
    expect(h.contactUpdates).toEqual([{ id: CONTACT, input: { status: "done", note: "Rappelé le 09/10.\n\nClient créé : VTC Martin" } }]);

    expect(await fleet.createPrivateFleet(CREATE, "pas-un-uuid")).toEqual({ ok: false, error: "Demande de contact introuvable." });
  });

  it("réservé au super admin", async () => {
    h.session = null;
    await expect(fleet.createPrivateFleet(CREATE)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.auth).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Clé du site
// -----------------------------------------------------------------------------
describe("clé du site : après CGV et DPA, affichée une fois, révocable", () => {
  const ready = (op: Op): Reply =>
    op.table === "organizations"
      ? { data: { id: ORG, status: "active", private_fleet: true } }
      : op.table === "legal_acceptances"
        ? { data: [{ document: "cgv" }, { document: "dpa" }] }
        : op.table === "api_keys" && op.action === "insert"
          ? { data: { id: KEY } }
          : undefined;

  it("clé serveur : portées du serveur, aucune origine, débit par défaut, audit super admin", async () => {
    h.handle = ready;
    const res = await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site du client", origins: [] });
    expect(res).toMatchObject({ ok: true, kind: "server", scopes: [...PRIVATE_FLEET_SITE_KEY_SCOPES.server], origins: [], rateLimitPerMinute: 60 });
    const key = res.ok ? res.key : "";
    expect(key).toMatch(/^rdk_live_[a-z0-9]{8}_[A-Za-z0-9]{32}$/);
    const insert = writes("api_keys")[0]!;
    expect(insert.values).toMatchObject({
      organization_id: ORG,
      name: "Site du client",
      scopes: [...PRIVATE_FLEET_SITE_KEY_SCOPES.server],
      rate_limit_per_minute: 60,
      allowed_origins: [],
      expires_at: null,
      created_by: ACTOR,
      rotated_from_id: null,
    });
    // Seul un HMAC poivré est stocké (jamais la clé)
    expect(writes("api_key_secrets")[0]!.values).toEqual({ api_key_id: KEY, key_hash: createHmac("sha256", PEPPER).update(key).digest("hex") });
    expect(h.audits).toEqual([
      {
        organizationId: ORG, actorUserId: ACTOR, actorType: "super_admin", action: "api_key.created", entityType: "api_keys", entityId: KEY,
        metadata: { prefix: insert.values.prefix, kind: "server", scopes: [...PRIVATE_FLEET_SITE_KEY_SCOPES.server], origins: [], rate_limit_per_minute: 60 },
      },
    ]);
    // Acceptation lue pour la version en vigueur, CGV et accord de traitement
    expect(h.ops.find((o) => o.table === "legal_acceptances")?.filters).toEqual({ organization_id: ORG, version: ORG_LEGAL_VERSION, "document[]": ["cgv", "dpa"] });
  });

  it("clé navigateur : création et devis seulement, origines https normalisées avec leur variante www, débit de 1 000 par minute", async () => {
    h.handle = ready;
    const res = await fleet.createPrivateFleetSiteKey(ORG, { kind: "browser", name: "Formulaire", origins: ["https://MonSite.fr/"] });
    expect(res).toMatchObject({ ok: true, kind: "browser", scopes: [...BROWSER_KEY_SCOPES], origins: ["https://monsite.fr", "https://www.monsite.fr"] });
    // Bien au-dessus des 30 devis par minute et par adresse IP : deux visiteurs ne bloquent plus le site (constat de la revue)
    expect(writes("api_keys")[0]!.values).toMatchObject({
      scopes: [...BROWSER_KEY_SCOPES], allowed_origins: ["https://monsite.fr", "https://www.monsite.fr"], rate_limit_per_minute: 1_000,
    });

    expect(await fleet.createPrivateFleetSiteKey(ORG, { kind: "browser", name: "Formulaire", origins: ["http://monsite.fr/reserver"] })).toMatchObject({
      ok: false,
      fieldErrors: { "origins.0": expect.any(String) },
    });
  });

  it("refus : CGV ou DPA non acceptés, organisation standard ou inactive ; rien n'est créé", async () => {
    h.handle = (op) => (op.table === "legal_acceptances" ? { data: [{ document: "cgv" }] } : ready(op));
    const notAccepted = await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site du client", origins: [] });
    expect(notAccepted).toMatchObject({ ok: false });
    expect(notAccepted.ok === false && notAccepted.error).toContain("pas encore acceptés par le client");

    h.handle = (op) => (op.table === "organizations" ? { data: { id: ORG, status: "active", private_fleet: false } } : ready(op));
    expect(await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site du client", origins: [] })).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_ONLY });

    h.handle = (op) => (op.table === "organizations" ? { data: { id: ORG, status: "suspended", private_fleet: true } } : ready(op));
    expect(await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site du client", origins: [] })).toMatchObject({ ok: false });
    expect(writes("api_keys")).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("débit réglable à la création : valeur saisie, bornes du type de clé (clé navigateur : 300 au moins), vide = défaut", async () => {
    h.handle = ready;
    expect(await fleet.createPrivateFleetSiteKey(ORG, { kind: "browser", name: "Formulaire", origins: ["https://monsite.fr"], rateLimitPerMinute: "2 500" })).toMatchObject({
      ok: true, rateLimitPerMinute: 2_500,
    });
    expect(writes("api_keys")[0]!.values).toMatchObject({ rate_limit_per_minute: 2_500 });
    expect(await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site", origins: [], rateLimitPerMinute: 600 })).toMatchObject({ ok: true, rateLimitPerMinute: 600 });
    expect(await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site", origins: [], rateLimitPerMinute: "" })).toMatchObject({ ok: true, rateLimitPerMinute: 60 });

    h.ops.length = 0;
    h.audits.length = 0;
    for (const [kind, rate] of [["browser", 60], ["browser", 299], ["server", 5], ["server", 10_001], ["server", "12,5"], ["browser", -1]] as const) {
      const refused = await fleet.createPrivateFleetSiteKey(ORG, {
        kind, name: "Site", origins: kind === "browser" ? ["https://monsite.fr"] : [], rateLimitPerMinute: rate,
      });
      expect(refused, `${kind} ${rate}`).toMatchObject({ ok: false, fieldErrors: { rateLimitPerMinute: expect.stringContaining("Nombre entier de") } });
      expect(refused.ok === false && refused.error, `${kind} ${rate}`).toMatch(/^Débit \(requêtes par minute\)\u00a0: nombre entier de /);
    }
    // Refus avant toute lecture ou écriture
    expect(h.ops).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("offre sans API (garde api_keys_plan_limit) : message clair", async () => {
    h.handle = (op) =>
      op.table === "api_keys" && op.action === "insert" ? { error: { code: "P0001", message: "PLAN_FEATURE_API: l'API n'est pas incluse dans votre offre" } } : ready(op);
    const res = await fleet.createPrivateFleetSiteKey(ORG, { kind: "server", name: "Site du client", origins: [] });
    expect(res.ok === false && res.error).toContain(ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID);
    expect(h.audits).toEqual([]);
  });

  it("révocation : revoked_at, revoked_by, clé de l'organisation encore active, audit", async () => {
    h.handle = (op) => (op.table === "api_keys" && op.action === "update" ? { data: { prefix: "rdk_live_abcd1234" } } : undefined);
    expect(await fleet.revokePrivateFleetSiteKey(ORG, KEY)).toEqual({ ok: true });
    const w = writes("api_keys")[0]!;
    expect(w.values).toMatchObject({ revoked_by: ACTOR, revoked_at: expect.any(String) });
    expect(w.filters).toEqual({ id: KEY, organization_id: ORG, "revoked_at is": null });
    expect(h.audits[0]).toMatchObject({ actorType: "super_admin", action: "api_key.revoked", entityId: KEY, severity: "warning", metadata: { prefix: "rdk_live_abcd1234" } });

    h.handle = () => undefined;
    expect(await fleet.revokePrivateFleetSiteKey(ORG, KEY)).toEqual({ ok: false, error: "Clé introuvable ou déjà révoquée." });
    expect(await fleet.revokePrivateFleetSiteKey(ORG, "x")).toEqual({ ok: false, error: "Clé introuvable." });
  });
});

// -----------------------------------------------------------------------------
// Fiche du gérant, accès
// -----------------------------------------------------------------------------
describe("fiche du gérant recréée, lien d'accès renvoyé", () => {
  const DRIVER_INPUT = {
    ownerFirstName: "Paul", ownerLastName: "Martin", ownerPhone: "0698765432", vtcCardNumber: "",
    vehicle: { model: "Classe E", plate: "AB-123-CD", category: "business" as const, seats: 4, luggageCapacity: 3 },
  };

  it("svc_platform_attach_private_fleet_driver : fiche sur le compte du propriétaire, refus relayés", async () => {
    h.handle = (op) => (op.table === "rpc:svc_platform_attach_private_fleet_driver" ? { data: { ok: true, code: "CREATED", driver_id: DRIVER } } : undefined);
    expect(await fleet.attachPrivateFleetDriver(ORG, DRIVER_INPUT)).toEqual({ ok: true, driverId: DRIVER });
    expect(rpcCalls("svc_platform_attach_private_fleet_driver")).toEqual([
      {
        p_org: ORG,
        p_actor: ACTOR,
        p_driver: { first_name: "Paul", last_name: "Martin", phone: "+33698765432", email: null, vtc_card_number: null },
        p_vehicle: { brand: null, model: "Classe E", color: null, plate: "AB-123-CD", category: "business", seats: 4, luggage_capacity: 3 },
      },
    ]);
    expect(h.revalidated).toContain(`/admin/organizations/${ORG}`);

    h.handle = (op) =>
      op.table === "rpc:svc_platform_attach_private_fleet_driver"
        ? { data: { ok: false, code: "PRIVATE_FLEET_HAS_DRIVER", message: "Cette Flotte Privée a déjà une fiche chauffeur." } }
        : undefined;
    expect(await fleet.attachPrivateFleetDriver(ORG, DRIVER_INPUT)).toEqual({ ok: false, error: "Cette Flotte Privée a déjà une fiche chauffeur.", fieldErrors: undefined });
  });

  it("lien d'accès : seulement pour un propriétaire jamais connecté", async () => {
    h.handle = (op) =>
      op.table === "organizations"
        ? { data: { private_fleet: true } }
        : op.table === "organization_users"
          ? { data: { user_id: NEW_USER, user: { email: "paul@vtc-martin.fr" } } }
          : undefined;
    expect(await fleet.resendPrivateFleetAccess(ORG)).toEqual({ ok: true, email: "paul@vtc-martin.fr" });
    expect(h.invitationEmails).toEqual(["paul@vtc-martin.fr"]);
    expect(h.audits[0]).toMatchObject({ action: "member.invitation_resent", actorType: "super_admin", entityId: NEW_USER });

    h.lastSignInAt = "2026-10-09T08:00:00Z";
    expect(await fleet.resendPrivateFleetAccess(ORG)).toMatchObject({ ok: false, error: expect.stringContaining("déjà connecté") });
    expect(h.invitationEmails).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Changer d'offre de service
// -----------------------------------------------------------------------------
describe("setPrivateFleet : changement d'offre de service (PackConversionDialog)", () => {
  const orgRow = (planLimits: Record<string, unknown> | null = { api_access: true }) => (op: Op): Reply =>
    op.table === "organizations" && op.action === "select"
      ? { data: { id: ORG, plan_id: PLAN, limits_override: null, plan: planLimits ? { limits: planLimits } : null } }
      : undefined;

  it("sortie vers une centrale : modèle, taux, mode, note ET offre choisie transmis à la RPC (une transaction) ; rien d'écrit à part", async () => {
    const NEXT = "88888888-8888-4888-8888-888888888888";
    h.handle = (op) =>
      op.table === "plans"
        ? { data: { id: NEXT, name: "Pro", is_active: true } }
        : op.table === "rpc:svc_platform_set_private_fleet"
          ? { data: { ok: true, code: "PRIVATE_FLEET_DISABLED", fees: { ok: true, code: "APPLIED", message: "Modèle d'exploitation enregistré." }, open_rides: 2 } }
          : orgRow()(op);
    const res = await fleet.setPrivateFleet(ORG, {
      target: "centrale", planId: NEXT, platformFeePercent: 5, platformFeeFixedCents: 0, mode: "consent", consentNote: " E-mail du client du 09/10/2026 ",
    });
    expect(res).toEqual({
      ok: true,
      code: "PRIVATE_FLEET_DISABLED",
      message:
        "Organisation passée en centrale à commission. Offre «\u00a0Pro\u00a0» appliquée. Modèle d'exploitation enregistré. 2 réservations en recherche relancées avec le nouveau profil de dispatch.",
    });
    expect(rpcCalls("svc_platform_set_private_fleet")).toEqual([
      {
        p_org: ORG, p_actor: ACTOR, p_enabled: false, p_consent_note: "E-mail du client du 09/10/2026", p_dispatch_model: "centrale", p_percent: 5,
        p_fixed_cents: 0, p_fee_mode: "consent", p_effective_on: null, p_org_legal_version: ORG_LEGAL_VERSION,
        p_org_legal_effective_on: ORG_LEGAL_EFFECTIVE_AT, p_app_url: "https://app.rydar.test", p_set_plan: true, p_plan_id: NEXT,
      },
    ]);
    // Offre écrite par la RPC après le drapeau, annulée avec un refus des frais (constat de la revue : jamais une seconde
    // écriture qui pourrait échouer après la bascule) ; journal écrit en base
    expect(h.ops.filter((o) => ["insert", "update", "delete"].includes(o.action))).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("sortie en flotte, même offre, taux inchangés : aucun taux envoyé, offre non transmise", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_private_fleet" ? { data: { ok: true, code: "PRIVATE_FLEET_DISABLED", fees: null, open_rides: 0 } } : orgRow()(op);
    expect(await fleet.setPrivateFleet(ORG, { target: "fleet", planId: PLAN, consentNote: "Demande écrite du 09/10" })).toEqual({
      ok: true, code: "PRIVATE_FLEET_DISABLED", message: "Organisation passée en flotte standard.",
    });
    expect(rpcCalls("svc_platform_set_private_fleet")[0]).toMatchObject({
      p_enabled: false, p_dispatch_model: null, p_percent: null, p_fixed_cents: null, p_set_plan: false, p_plan_id: null,
    });
    expect(h.ops.some((o) => o.table === "plans")).toBe(false);
    expect(writes("organizations")).toEqual([]);
  });

  it("sortie « sans offre » assumée : transmise à la RPC (aucune limite), offre inactive refusée avant", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_private_fleet" ? { data: { ok: true, code: "PRIVATE_FLEET_DISABLED", fees: null, open_rides: 0 } } : orgRow()(op);
    expect(await fleet.setPrivateFleet(ORG, { target: "fleet", planId: "", acceptNoPlan: true, consentNote: "Demande écrite du 09/10" })).toMatchObject({
      ok: true, message: "Organisation passée en flotte standard. Sans offre\u00a0: aucune limite.",
    });
    expect(rpcCalls("svc_platform_set_private_fleet")[0]).toMatchObject({ p_set_plan: true, p_plan_id: null });

    h.ops.length = 0;
    h.handle = (op) => (op.table === "plans" ? { data: { id: "x", name: "Ancienne", is_active: false } } : orgRow()(op));
    const retired = "77777777-7777-4777-8777-000000000001";
    expect(await fleet.setPrivateFleet(ORG, { target: "fleet", planId: retired, consentNote: "Demande écrite du 09/10" })).toMatchObject({
      ok: false, fieldErrors: { planId: "Offre introuvable ou inactive" },
    });
    expect(rpcCalls("svc_platform_set_private_fleet")).toEqual([]);
  });

  it("refus des frais (préavis) : rien n'est écrit, date au plus tôt renvoyée ; note ou offre manquante : rien n'est appelé", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_private_fleet"
        ? { data: { ok: false, code: "NOTICE_TOO_SHORT", field: "effectiveOn", min_effective_on: "2026-11-12", message: "Préavis insuffisant." } }
        : orgRow()(op);
    expect(await fleet.setPrivateFleet(ORG, { target: "fleet", planId: PLAN, platformFeePercent: 0, platformFeeFixedCents: 500, consentNote: "Accord du 09/10" })).toEqual({
      ok: false, error: "Préavis insuffisant.", fieldErrors: { effectiveOn: "Préavis insuffisant." }, minEffectiveOn: "2026-11-12",
    });
    expect(writes("organizations")).toEqual([]);

    h.ops.length = 0;
    expect(await fleet.setPrivateFleet(ORG, { target: "fleet", planId: PLAN, consentNote: " " })).toMatchObject({ ok: false, fieldErrors: { consentNote: expect.any(String) } });
    expect(await fleet.setPrivateFleet(ORG, { target: "fleet", planId: "", consentNote: "Accord du 09/10" })).toMatchObject({ ok: false, fieldErrors: { planId: expect.any(String) } });
    expect(h.ops).toEqual([]);
  });

  it("entrée : refus listant les raisons (la base fait foi) ; offre sans API refusée avant la RPC", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_private_fleet"
        ? { data: { ok: false, code: "PRIVATE_FLEET_NOT_ELIGIBLE", blockers: ["members", "network"], message: "Passage en Flotte Privée impossible." } }
        : orgRow()(op);
    const res = await fleet.setPrivateFleet(ORG, { target: "private_fleet", consentNote: "Demande du client du 09/10" });
    expect(res).toEqual({
      ok: false,
      blockers: ["members", "network"],
      error: ["Passage en Flotte Privée impossible.", PRIVATE_FLEET_BLOCKER_LABELS.members, PRIVATE_FLEET_BLOCKER_LABELS.network].join(" "),
    });
    expect(rpcCalls("svc_platform_set_private_fleet")[0]).toMatchObject({ p_enabled: true, p_dispatch_model: null, p_percent: null, p_fixed_cents: null });

    h.ops.length = 0;
    h.handle = orgRow({ api_access: false });
    const noApi = await fleet.setPrivateFleet(ORG, { target: "private_fleet", consentNote: "Demande du client du 09/10" });
    expect(noApi.ok === false && noApi.error).toContain(ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID);
    expect(rpcCalls("svc_platform_set_private_fleet")).toEqual([]);

    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_private_fleet" ? { data: { ok: true, code: "PRIVATE_FLEET_ENABLED", fees: null, open_rides: 1 } } : orgRow()(op);
    expect(await fleet.setPrivateFleet(ORG, { target: "private_fleet", consentNote: "Demande du client du 09/10" })).toMatchObject({
      ok: true, code: "PRIVATE_FLEET_ENABLED", message: expect.stringContaining("1 réservation en recherche relancée"),
    });
  });
});

// -----------------------------------------------------------------------------
// Actions existantes du super admin
// -----------------------------------------------------------------------------
describe("fiche de l'organisation : refus en Flotte Privée", () => {
  it("« Donner un accès » refusé : aucun compte créé, aucune adhésion", async () => {
    h.handle = (op) => (op.table === "organizations" ? { data: { id: ORG, name: "VTC Martin", private_fleet: true } } : undefined);
    const res = await adminActions.grantOrganizationAccess(ORG, { fullName: "Support Rydar", email: "support@exemple.fr", role: "admin", password: "Provisoire-2026" });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining(ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED) });
    expect(h.auth).toEqual([]);
    expect(writes("organization_users")).toEqual([]);
  });

  it("choix du modèle « centrale » refusé (sortie d'abord) ; garde SQL relayée ; taux toujours réglables", async () => {
    h.handle = (op) => (op.table === "organizations" ? { data: { private_fleet: true } } : undefined);
    expect(await adminActions.updateDispatchModel(ORG, { dispatchModel: "centrale", consentNote: "Demande du 09/10" })).toEqual({
      ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_MODEL, fieldErrors: { dispatchModel: "Sortez d'abord de la Flotte Privée" },
    });
    expect(rpcCalls("svc_platform_set_fees")).toEqual([]);

    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees" ? { error: { code: "55000", message: "PRIVATE_FLEET_MODEL: modèle flotte imposé" } } : undefined;
    expect(await adminActions.updateDispatchModel(ORG, { dispatchModel: "centrale", consentNote: "Demande du 09/10" })).toMatchObject({
      ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_MODEL,
    });

    h.handle = (op) =>
      op.table === "rpc:svc_platform_set_fees"
        ? { data: { ok: true, code: "APPLIED", message: "Baisse appliquée.", scheduled_change: null, emails_queued: 0 } }
        : op.table === "organizations"
          ? { data: { private_fleet: true } }
          : undefined;
    expect(await adminActions.updateDispatchModel(ORG, { dispatchModel: "fleet", platformFeePercent: 0, platformFeeFixedCents: 100 })).toMatchObject({ ok: true });
  });

  it("offre ou surcharge sans accès à l'API refusée en Flotte Privée ; organisation standard inchangée", async () => {
    h.handle = (op) =>
      op.table === "organizations" && op.action === "select"
        ? { data: { private_fleet: true } }
        : op.table === "plans"
          ? { data: { limits: { api_access: false } } }
          : undefined;
    expect(await adminActions.updateOrganizationPlan(ORG, PLAN, {})).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID });
    // Sans offre (toutes les options) mais API coupée par la surcharge : refusé aussi
    expect(await adminActions.updateOrganizationPlan(ORG, null, { api_access: false })).toEqual({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID });
    expect(writes("organizations")).toEqual([]);
    // Surcharge qui rend l'API : acceptée
    expect(await adminActions.updateOrganizationPlan(ORG, PLAN, { api_access: true, max_drivers: 50 })).toEqual({ ok: true });

    h.ops.length = 0;
    h.handle = (op) => (op.table === "organizations" && op.action === "select" ? { data: { private_fleet: false } } : undefined);
    expect(await adminActions.updateOrganizationPlan(ORG, PLAN, {})).toEqual({ ok: true });
    expect(h.ops.some((o) => o.table === "plans")).toBe(false);
    expect(writes("organizations")[0]!.values).toEqual({ plan_id: PLAN, limits_override: {} });
  });

  it("offre qui perdrait l'API alors que des clients Flotte Privée l'utilisent : refusée avec leur nombre, rien n'est écrit", async () => {
    const planInput = (api: boolean) => ({
      code: "pack_flotte", name: "Pack Flotte Privée", description: "", price_monthly_cents: 0, price_yearly_cents: 0,
      limits: {
        max_drivers: null, max_rides_per_month: null, max_admins: null, api_access: api, booking_site: false, custom_domain: false,
        advanced_stats: false, history_days: null,
      },
      features: [], is_active: true, is_public: false, highlighted: false,
    });
    // Offre actuelle avec l'API ; trois clients : un sans surcharge, un dont la surcharge rend l'API, un dont la surcharge la coupe
    const clients = [
      { id: "a", limits_override: null },
      { id: "b", limits_override: { api_access: true } },
      { id: "c", limits_override: { api_access: false, max_rides_per_month: 50 } },
    ];
    const using = (rows: unknown[], current: Record<string, unknown> = { api_access: true }) => (op: Op): Reply =>
      op.table === "plans" && op.action === "select"
        ? { data: { limits: current } }
        : op.table === "organizations" && op.action === "select"
          ? { data: rows }
          : undefined;

    h.handle = using(clients);
    const refused = await adminActions.savePlan(PLAN, planInput(false));
    expect(refused).toMatchObject({ ok: false, fieldErrors: { "limits.api_access": "Utilisée par 2 clients Flotte Privée" } });
    expect(refused.ok === false && refused.error).toBe(
      `${ERROR_MESSAGES.PRIVATE_FLEET_PLAN_INVALID} 2 clients Flotte Privée sur cette offre\u00a0: changez d'abord leur offre, ou rendez-leur l'API par une surcharge («\u00a0Offre & limites\u00a0» de leur fiche).`,
    );
    // Clients Flotte Privée non archivés de CETTE offre
    expect(h.ops.find((o) => o.table === "organizations")?.filters).toEqual({ plan_id: PLAN, private_fleet: true });
    expect(writes("plans")).toEqual([]);
    expect(h.audits).toEqual([]);

    // Tous rendus à l'API par leur surcharge, offre déjà sans API, ou API gardée : enregistrée
    for (const [handle, api] of [[using([clients[1]]), false], [using(clients, { api_access: false }), false], [using(clients), true]] as const) {
      h.ops.length = 0;
      h.handle = handle;
      expect(await adminActions.savePlan(PLAN, planInput(api))).toEqual({ ok: true });
      expect(writes("plans")).toHaveLength(1);
    }
    // Nouvelle offre : aucun client, aucun contrôle ; lecture impossible : refus
    h.ops.length = 0;
    expect(await adminActions.savePlan(null, planInput(false))).toEqual({ ok: true });
    expect(h.ops.some((o) => o.table === "organizations")).toBe(false);
    h.handle = (op) => (op.table === "organizations" ? { error: { code: "PGRST000", message: "timeout" } } : using(clients)(op));
    expect(await adminActions.savePlan(PLAN, planInput(false))).toEqual({ ok: false, error: "Vérification impossible pour le moment\u00a0: réessayez." });
  });

  it("réseau partagé d'une Flotte Privée sans adhésion : message clair, pas d'erreur générique", async () => {
    h.handle = (op) =>
      op.table === "rpc:svc_network_suspend" ? { error: { code: "55000", message: "PRIVATE_FLEET_RESTRICTED: réseau partagé interdit" } } : undefined;
    const res = await network.suspendNetworkOrg({ orgId: ORG, suspended: true, reason: "Manquement à la convention" });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("ne participe pas au réseau partagé") });
  });
});

// -----------------------------------------------------------------------------
// Tableau de bord : clés et webhooks (D16)
// -----------------------------------------------------------------------------
const INTEGRATIONS = join(import.meta.dirname, "..", "app", "dashboard", "integrations", "actions.ts");

/** Corps de chaque fonction du fichier (jusqu'à la fonction suivante). */
function functionBodies(src: string): Map<string, { exported: boolean; body: string }> {
  const out = new Map<string, { exported: boolean; body: string }>();
  const re = /^(export )?async function (\w+)\(/gm;
  const found = [...src.matchAll(re)];
  found.forEach((m, i) => {
    const end = i + 1 < found.length ? found[i + 1]!.index! : src.length;
    out.set(m[2]!, { exported: !!m[1], body: src.slice(m.index!, end) });
  });
  return out;
}

describe("integrations/actions.ts : clés et webhooks refusés en Flotte Privée (test statique)", () => {
  const src = readFileSync(INTEGRATIONS, "utf8");
  const fns = functionBodies(src);
  const exported = [...fns].filter(([, f]) => f.exported).map(([name]) => name);

  it("chaque action exportée passe par la garde (adminCtx directement, ou webhookCtx / runWebhookRpc qui l'appellent)", () => {
    expect(exported.sort()).toEqual(
      ["createApiKey", "createWebhook", "deleteWebhook", "redeliverWebhook", "revokeApiKey", "rotateApiKey", "rotateWebhookSecret", "setWebhookEnabled", "testWebhook"].sort(),
    );
    const guarded = (body: string) => /\badminCtx\(\)/.test(body) || /\brunWebhookRpc\(/.test(body);
    expect(exported.filter((name) => !guarded(fns.get(name)!.body))).toEqual([]);
    expect(fns.get("runWebhookRpc")!.body).toMatch(/\bwebhookCtx\(/);
    expect(fns.get("webhookCtx")!.body).toMatch(/\badminCtx\(\)/);
  });

  it("la garde lit organizations.private_fleet elle-même et renvoie PRIVATE_FLEET_RESTRICTED", () => {
    const guard = fns.get("adminCtx")!.body;
    expect(guard).toMatch(/from\("organizations"\)\.select\("private_fleet"\)/);
    expect(guard).toContain("ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED");
    // Jamais d'après la session (lib/auth.ts, lot L3) ni d'après lib/private-fleet.ts
    expect(src).not.toMatch(/ctx\.org\.private_fleet|@\/lib\/private-fleet"/);
  });

  it("insertKey vient de lib/api-keys-server.ts (aucune copie locale)", () => {
    expect(src).toContain('import { insertKey } from "@/lib/api-keys-server";');
    expect(fns.has("insertKey")).toBe(false);
  });
});

describe("integrations/actions.ts : comportement", () => {
  const ctxFor = (privateFleet: boolean | null, role = "owner") => ({
    supabase: {
      from: (table: string) => {
        const op: Op = { client: "user", table, action: "select", filters: {} };
        const b: any = {
          select: (cols: string) => ((op.columns = cols), b),
          eq: (c: string, v: unknown) => ((op.filters[c] = v), b),
          maybeSingle: async () => (h.ops.push(op), privateFleet === null ? { data: null, error: { message: "boom" } } : { data: { private_fleet: privateFleet }, error: null }),
        };
        return b;
      },
      rpc: async (fn: string) => (h.ops.push({ client: "user", table: `rpc:${fn}`, action: "rpc", filters: {} }), { data: { limits: { api_access: true } }, error: null }),
    },
    user: { id: ACTOR },
    org: { id: ORG },
    role,
  });

  const ID = "99999999-9999-4999-8999-999999999999";
  const everyAction = () => [
    integrations.createApiKey({ name: "Site", scopes: ["rides:create"], rateLimitPerMinute: 60, allowedOrigins: [] }),
    integrations.revokeApiKey(ID),
    integrations.rotateApiKey(ID),
    integrations.createWebhook({ url: "https://monsite.fr/hook" }),
    integrations.deleteWebhook(ID),
    integrations.setWebhookEnabled(ID, true),
    integrations.rotateWebhookSecret(ID),
    integrations.testWebhook(ID),
    integrations.redeliverWebhook(ID),
  ];

  it("Flotte Privée : chaque action renvoie PRIVATE_FLEET_RESTRICTED, sans aucune écriture ni RPC", async () => {
    h.ctx = ctxFor(true);
    const results = await Promise.all(everyAction());
    expect(results).toEqual(results.map(() => ({ ok: false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED })));
    expect(h.ops.filter((o) => o.client === "admin")).toEqual([]);
    expect(h.ops.filter((o) => o.client === "user").every((o) => o.table === "organizations" && o.columns === "private_fleet" && o.filters.id === ORG)).toBe(true);
    expect(h.webhookCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("drapeau illisible : refus (rien n'est écrit) ; dispatcher : réservé aux administrateurs", async () => {
    h.ctx = ctxFor(null);
    expect(await integrations.revokeApiKey(ID)).toEqual({ ok: false, error: "Vérification impossible pour le moment : réessayez." });
    h.ctx = ctxFor(false, "dispatcher");
    expect(await integrations.revokeApiKey(ID)).toEqual({ ok: false, error: "Réservé aux administrateurs." });
    expect(h.ops.filter((o) => o.client === "admin")).toEqual([]);
  });

  it("organisation standard : création de clé et webhooks inchangés", async () => {
    h.ctx = ctxFor(false);
    h.handle = (op) => (op.table === "api_keys" && op.action === "insert" ? { data: { id: KEY } } : undefined);
    const res = await integrations.createApiKey({ name: "Site web", scopes: ["rides:create", "rides:read"], rateLimitPerMinute: 120, allowedOrigins: [], expiresInDays: null });
    expect(res).toMatchObject({ ok: true, key: expect.stringMatching(/^rdk_live_/), prefix: expect.stringMatching(/^rdk_live_[a-z0-9]{8}$/) });
    expect(writes("api_keys")[0]!.values).toMatchObject({
      organization_id: ORG, name: "Site web", scopes: ["rides:create", "rides:read"], rate_limit_per_minute: 120, allowed_origins: [], expires_at: null,
      created_by: ACTOR, rotated_from_id: null,
    });
    expect(h.audits[0]).toMatchObject({ action: "api_key.created", entityId: KEY, metadata: { scopes: ["rides:create", "rides:read"] } });
    expect(h.revalidated).toEqual(["/dashboard/integrations"]);

    expect(await integrations.createWebhook({ url: "https://monsite.fr/hook" })).toEqual({ ok: true, created: true, secret: "whsec_x" });
    expect(h.webhookCalls).toEqual([{ fn: "svc_webhook_upsert", org: ORG, args: expect.objectContaining({ p_url: "https://monsite.fr/hook" }) }]);
  });

  it("organisation standard : rotation d'une clé navigateur (portées du navigateur seulement, ancienne clé valable 24 h)", async () => {
    h.ctx = ctxFor(false);
    h.handle = (op) =>
      op.table === "api_keys" && op.action === "select"
        ? { data: { id: ID, name: "Formulaire", scopes: ["rides:create", "rides:read"], rate_limit_per_minute: 30, allowed_origins: ["https://monsite.fr"], expires_at: null } }
        : op.table === "api_keys" && op.action === "insert"
          ? { data: { id: KEY } }
          : undefined;
    expect(await integrations.rotateApiKey(ID)).toMatchObject({ ok: true, key: expect.stringMatching(/^rdk_live_/) });
    const [insert, grace] = writes("api_keys");
    expect(insert!.values).toMatchObject({ scopes: ["rides:create"], allowed_origins: ["https://monsite.fr"], rate_limit_per_minute: 30, rotated_from_id: ID });
    expect(grace!.action).toBe("update");
    expect(Date.parse(grace!.values.expires_at) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(h.audits[0]).toMatchObject({ action: "api_key.rotated", entityId: ID });
  });
});

describe("insertKey (lib/api-keys-server.ts) : comportement de l'ancienne fonction du tableau de bord", () => {
  it("clé puis secret (HMAC poivré) ; secret refusé : clé retirée, erreur renvoyée", async () => {
    h.handle = (op) => (op.table === "api_keys" && op.action === "insert" ? { data: { id: KEY } } : undefined);
    const res = await insertKey(ORG, ACTOR, { name: "Site", scopes: ["rides:create"], rateLimitPerMinute: 60, allowedOrigins: [], expiresAt: null });
    expect(res).toEqual({ id: KEY, key: expect.any(String), prefix: expect.any(String) });
    const ok = res as { key: string; prefix: string };
    expect(ok.key.startsWith(`${ok.prefix}_`)).toBe(true);
    expect(writes("api_keys")[0]!.values).toEqual({
      organization_id: ORG, name: "Site", prefix: ok.prefix, last4: ok.key.slice(-4), scopes: ["rides:create"], rate_limit_per_minute: 60,
      allowed_origins: [], expires_at: null, created_by: ACTOR, rotated_from_id: null,
    });

    h.ops.length = 0;
    h.handle = (op) =>
      op.table === "api_keys" && op.action === "insert"
        ? { data: { id: KEY } }
        : op.table === "api_key_secrets"
          ? { error: { code: "XX000", message: "boom" } }
          : undefined;
    expect(await insertKey(ORG, ACTOR, { name: "Site", scopes: ["rides:create"], rateLimitPerMinute: 60, allowedOrigins: [], expiresAt: null, rotatedFrom: ID2 })).toEqual({
      error: { code: "XX000", message: "boom" },
    });
    expect(writes("api_keys").map((w) => [w.action, w.filters])).toEqual([["insert", {}], ["delete", { id: KEY }]]);
    expect(writes("api_keys")[0]!.values.rotated_from_id).toBe(ID2);

    h.handle = (op) => (op.table === "api_keys" && op.action === "insert" ? { error: { code: "P0001", message: "PLAN_FEATURE_API: non" } } : undefined);
    expect(await insertKey(ORG, ACTOR, { name: "Site", scopes: ["rides:create"], rateLimitPerMinute: 60, allowedOrigins: [], expiresAt: null })).toEqual({
      error: { code: "P0001", message: "PLAN_FEATURE_API: non" },
    });
  });
});
const ID2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// -----------------------------------------------------------------------------
// Règles pures de la fiche
// -----------------------------------------------------------------------------
describe("private-fleet-state : règles de la fiche", () => {
  it("limites effectives : offre, surcharge, puis 1 chauffeur et 1 accès imposés en Flotte Privée", () => {
    expect(state.effectiveLimits({ planId: null, planLimits: null, override: null, privateFleet: false })).toEqual(state.NO_PLAN_LIMITS);
    expect(
      state.effectiveLimits({ planId: PLAN, planLimits: { max_drivers: 50, api_access: true }, override: { max_drivers: 80, max_admins: 10 }, privateFleet: true }),
    ).toEqual({ max_drivers: 1, max_admins: 1, api_access: true });
    expect(state.apiAccessOf(state.effectiveLimits({ planId: PLAN, planLimits: { api_access: "t" }, override: null, privateFleet: true }))).toBe(true);
    expect(state.apiAccessOf(state.effectiveLimits({ planId: PLAN, planLimits: {}, override: null, privateFleet: true }))).toBe(false);
    for (const v of ["true", "t", "yes", "y", "on", "1", " TRUE "]) expect(state.limitEnabled(v)).toBe(true);
    for (const v of [false, "false", "0", "non", 1, null, undefined]) expect(state.limitEnabled(v)).toBe(false);
  });

  it("préconditions indicatives : même liste et même ordre que private_fleet_blockers", () => {
    const OWNER = "owner-user";
    const base: Parameters<typeof state.privateFleetBlockersPreview>[0] = {
      dispatchModel: "fleet",
      members: [{ user_id: OWNER, role: "owner", status: "active" }],
      drivers: [{ user_id: OWNER, status: "active", application_status: null, deleted_at: null }],
      network: null,
      openShares: 0,
      runningExecutions: 0,
    };
    expect(state.privateFleetBlockersPreview(base)).toEqual([]);
    expect(
      state.privateFleetBlockersPreview({
        ...base,
        dispatchModel: "centrale",
        members: [...base.members, { user_id: "x", role: "dispatcher", status: "invited" }],
        drivers: [...base.drivers, { user_id: null, status: "inactive", application_status: "pending", deleted_at: null }],
        network: { share_out: false, share_in: false, requested_at: "2026-10-01", approved_at: null, refused_reason: null },
      }),
    ).toEqual([...PRIVATE_FLEET_BLOCKERS].filter((b) => b !== "owner_driver"));
    // Adhésion désactivée ignorée ; fiche supprimée ignorée ; fiche d'un autre compte ou inactive : owner_driver
    expect(state.privateFleetBlockersPreview({ ...base, members: [...base.members, { user_id: "x", role: "admin", status: "disabled" }] })).toEqual([]);
    expect(state.privateFleetBlockersPreview({ ...base, drivers: [{ user_id: OWNER, status: "inactive", application_status: null, deleted_at: null }] })).toEqual(["owner_driver"]);
    expect(
      state.privateFleetBlockersPreview({ ...base, drivers: [...base.drivers, { user_id: "y", status: "active", application_status: null, deleted_at: "2026-10-01" }] }),
    ).toEqual([]);
    expect(state.privateFleetBlockersPreview({ ...base, members: [{ user_id: OWNER, role: "owner", status: "invited" }] })).toEqual(["members", "owner_driver"]);
    // Réseau : partage, demande en attente, course partagée ou exécutée en cours ; demande refusée : non bloquante
    expect(state.privateFleetBlockersPreview({ ...base, network: { share_out: false, share_in: false, requested_at: "x", approved_at: null, refused_reason: "non" } })).toEqual([]);
    expect(state.privateFleetBlockersPreview({ ...base, runningExecutions: 1 })).toEqual(["network"]);
    expect(state.privateFleetBlockersPreview({ ...base, openShares: 1 })).toEqual(["network"]);
  });

  it("fiche du gérant, type de clé, extrait d'intégration", () => {
    expect(state.ownerDriverState(null)).toMatchObject({ receives: false, tone: "red" });
    expect(state.ownerDriverState({ status: "active", deleted_at: "2026-10-01", user_id: null })).toMatchObject({ label: "Supprimée (compte chauffeur supprimé)", receives: false });
    expect(state.ownerDriverState({ status: "active", deleted_at: null, user_id: "u" })).toEqual({ label: "Active", tone: "green", receives: true });
    expect(state.ownerDriverState({ status: "suspended", deleted_at: null, user_id: "u" })).toMatchObject({ receives: false });
    // Débit d'une clé du site : vide = défaut du type ; entier dans les bornes du type (espaces de milliers acceptés)
    expect(state.siteKeyRate("server", undefined)).toEqual({ ok: true, value: 60 });
    expect(state.siteKeyRate("browser", " ")).toEqual({ ok: true, value: 1_000 });
    expect(state.siteKeyRate("browser", "1\u202f200")).toEqual({ ok: true, value: 1_200 });
    expect(state.siteKeyRate("server", 10)).toEqual({ ok: true, value: 10 });
    for (const bad of [9, 10_001, 1.5, "abc", true]) expect(state.siteKeyRate("server", bad).ok).toBe(false);
    expect(state.siteKeyRate("browser", 299)).toEqual({ ok: false, error: "Nombre entier de 300 à 10\u202f000 (clé navigateur)" });
    expect(state.siteKeyKind([])).toBe("server");
    expect(state.siteKeyKind(null)).toBe("server");
    expect(state.siteKeyKind(["https://monsite.fr"])).toBe("browser");

    const server = state.siteKeySnippet({ kind: "server", apiBase: "https://app.rydar.test/api/v1", key: "rdk_live_abcd1234_SECRET" });
    expect(server).toContain("RYDAR_API_KEY=rdk_live_abcd1234_SECRET");
    expect(server).toContain("https://app.rydar.test/api/v1/quotes");
    expect(server).toContain("expected_price_cents");
    expect(server).toContain("https://app.rydar.test/api/v1/webhooks");
    const browser = state.siteKeySnippet({ kind: "browser", apiBase: "https://app.rydar.test/api/v1", key: "rdk_live_abcd1234_SECRET", origin: "https://monsite.fr" });
    expect(browser).toContain('const RYDAR_KEY = "rdk_live_abcd1234_SECRET"');
    expect(browser).toContain("depuis https://monsite.fr");
    expect(browser).toContain('"Idempotency-Key": crypto.randomUUID()');
    expect(browser).not.toContain("/webhooks");
  });

  it("passerelle d'une demande : nom découpé, coordonnées reprises, note complétée", () => {
    expect(state.splitFullName("  Jean-Pierre   de La Fontaine ")).toEqual({ firstName: "Jean-Pierre", lastName: "de La Fontaine" });
    expect(state.splitFullName("Karim")).toEqual({ firstName: "Karim", lastName: "" });
    expect(state.splitFullName("  ")).toEqual({ firstName: "", lastName: "" });
    expect(state.prefillFromContact({ name: "Karim Benali", email: "karim@exemple.fr", phone: "+33612345678", company: null })).toEqual({
      name: undefined, email: "karim@exemple.fr", phone: "+33612345678", ownerFirstName: "Karim", ownerLastName: "Benali", ownerEmail: "karim@exemple.fr",
      ownerPhone: "+33612345678",
    });
    expect(state.appendNote(null, "Client créé : X", 5000)).toBe("Client créé : X");
    expect(state.appendNote(" Rappelé. ", "Client créé : X", 5000)).toBe("Rappelé.\n\nClient créé : X");
    const long = state.appendNote("a".repeat(5000), "Client créé : X", 5000);
    expect(long.length).toBe(5000);
    expect(long.endsWith("\n\nClient créé : X")).toBe(true);
  });

  it("changer d'offre de service : ce qui change et ce qui reste", () => {
    const centrale = state.conversionSummary("centrale");
    expect(centrale.changes.join(" ")).toContain("ne se doit jamais de commission");
    expect(state.conversionSummary("fleet").changes.join(" ")).not.toContain("commission");
    expect(state.conversionSummary("private_fleet").changes.join(" ")).toContain("Un seul chauffeur");
    for (const t of ["fleet", "centrale", "private_fleet"] as const) {
      expect(state.conversionSummary(t).keeps.join(" ")).toContain("Courses, clients, prix");
    }
  });
});
