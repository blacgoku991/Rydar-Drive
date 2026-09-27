import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Suppression du compte chauffeur : logique partagée (lib/driver-deletion.ts) et route de l'application
// (/api/driver/delete-account), avec un Supabase simulé (RPC, stockage, administration d'Auth, client anonyme).

const h = vi.hoisted(() => ({
  /** Client service role simulé (rpc, storage, auth.admin) */
  admin: null as unknown,
  /** Client anonyme simulé de la route (getUser, signInWithPassword, signOut) */
  anon: null as unknown,
  limits: [] as { key: string; limit: number; windowSec: number }[],
  resets: [] as { key: string; windowSec: number }[],
  blocked: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon-key" } }));
vi.mock("@/lib/rate-limit", () => {
  const check = (c: { key: string; limit: number; windowSec: number }) => {
    h.limits.push(c);
    return { ok: !h.blocked.has(c.key), remaining: 0, resetAt: 0, limit: c.limit };
  };
  return {
    rateLimit: async (key: string, limit: number, windowSec: number) => check({ key, limit, windowSec }),
    rateLimitAll: async (checks: { key: string; limit: number; windowSec: number }[]) => {
      let last = { ok: true, remaining: 0, resetAt: 0, limit: 0 };
      for (const c of checks) {
        last = check(c);
        if (!last.ok) return last;
      }
      return last;
    },
    resetRateLimit: async (key: string, windowSec: number) => void h.resets.push({ key, windowSec }),
  };
});
// Modules réels, importés par la route sous leur alias
vi.mock("@/lib/driver-deletion", async () => await import("./driver-deletion"));
vi.mock("@/lib/driver-session", async () => await import("./driver-session"));
vi.mock("@/lib/driver-app-cors", async () => await import("./driver-app-cors"));
vi.mock("@/lib/request", async () => await import("./request"));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => h.anon,
}));

const { deleteDriverAccount, processAccountDeletion, retryAccountDeletion } = await import("./driver-deletion");
const { POST } = await import("../app/api/driver/delete-account/route");

// -----------------------------------------------------------------------------
// Supabase simulé
// -----------------------------------------------------------------------------
const ORG = "11111111-1111-4111-8111-111111111111";
const DRIVER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const PREFIX = `${ORG}/${DRIVER}/`;

type Row = Record<string, unknown>;
type PgError = { code?: string; message: string };
type RpcHandler = (args: Row) => { data?: unknown; error?: PgError };

/** Suppression en file telle que la renvoient les fonctions SQL (private.account_deletion_json). */
const job = (over: Row = {}): Row => ({
  ok: true,
  code: "DELETED",
  already_deleted: false,
  deletion_id: "del-1",
  driver_id: DRIVER,
  organization_id: ORG,
  number: 12,
  user_id: USER,
  keep_auth: false,
  storage_prefix: PREFIX,
  storage_done: false,
  auth_done: false,
  done: false,
  pending: true,
  ...over,
});

/** svc_account_deletion_progress (private.complete_account_deletion) : terminée quand les deux étapes le sont. */
const progressOf = (current: Row): RpcHandler => (args) => {
  const done = args.p_storage_done === true && args.p_auth_done === true;
  return {
    data: { ...current, ok: true, storage_done: args.p_storage_done, auth_done: args.p_auth_done, done, pending: !done, last_error: args.p_error ?? null },
  };
};

function fakeAdmin(opts: {
  rpc?: Record<string, RpcHandler>;
  files?: string[];
  listError?: string;
  removeError?: string;
  deleteUser?: (id: string) => { status?: number; code?: string; message: string } | null;
}) {
  const files = new Set(opts.files ?? []);
  const calls = { rpc: [] as { fn: string; args: Row }[], lists: [] as string[], removed: [] as string[][], deleted: [] as string[] };
  // État de la file : dernière ligne renvoyée par la suppression ou la relance, reprise par l'avancement
  let current: Row = job();
  const rpc: Record<string, RpcHandler> = {
    svc_delete_driver_account: () => ({ data: job() }),
    svc_account_deletion_progress: (args) => progressOf(current)(args),
    ...opts.rpc,
  };
  const client = {
    rpc: async (fn: string, args: Row) => {
      calls.rpc.push({ fn, args });
      const handler = rpc[fn];
      if (!handler) return { data: null, error: { message: `RPC inattendue : ${fn}` } };
      const r = handler(args);
      if (fn !== "svc_account_deletion_progress" && (r.data as Row | undefined)?.deletion_id) current = r.data as Row;
      return { data: r.data ?? null, error: r.error ?? null };
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("driver-documents");
        return {
          // Enfants directs du dossier : fichiers (avec identifiant) et sous-dossiers (identifiant null)
          list: async (dir: string, o: { limit: number; offset: number }) => {
            calls.lists.push(dir);
            if (opts.listError) return { data: null, error: { message: opts.listError } };
            const entries = new Map<string, { name: string; id: string | null }>();
            for (const f of [...files].sort()) {
              if (!f.startsWith(`${dir}/`)) continue;
              const [head, ...rest] = f.slice(dir.length + 1).split("/");
              entries.set(head!, { name: head!, id: rest.length ? null : `id-${f}` });
            }
            return { data: [...entries.values()].slice(o.offset, o.offset + o.limit), error: null };
          },
          remove: async (paths: string[]) => {
            if (opts.removeError) return { data: null, error: { message: opts.removeError } };
            calls.removed.push(paths);
            for (const p of paths) files.delete(p);
            return { data: paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          calls.deleted.push(id);
          return { data: null, error: opts.deleteUser?.(id) ?? null };
        },
      },
    },
  };
  h.admin = client;
  return { files, calls };
}

beforeEach(() => {
  h.limits.length = 0;
  h.resets.length = 0;
  h.blocked.clear();
  h.admin = null;
  h.anon = null;
});

// -----------------------------------------------------------------------------
describe("suppression du compte chauffeur — lib/driver-deletion", () => {
  it("tout le dossier purgé (pagination, sous-dossiers) puis compte de connexion supprimé → DELETED", async () => {
    const mine = Array.from({ length: 1003 }, (_, i) => `${ORG}/${DRIVER}/identity-${String(i).padStart(4, "0")}.jpg`);
    const sb = fakeAdmin({ files: [...mine, `${ORG}/${DRIVER}/old/vtc_card-1.jpg`, `${ORG}/autre-chauffeur/permis.jpg`] });

    const res = await deleteDriverAccount({ userId: USER });
    expect(res).toEqual({
      ok: true, code: "DELETED", pending: false, keepAuth: false, alreadyDeleted: false, driverId: DRIVER, organizationId: ORG,
      number: 12, deletionId: "del-1", message: "Votre compte Rydar Drive et vos données personnelles ont été supprimés.",
    });
    expect([...sb.files]).toEqual([`${ORG}/autre-chauffeur/permis.jpg`]);
    expect(sb.calls.removed.map((b) => b.length)).toEqual([1000, 4]);
    expect(sb.calls.lists).toContain(`${ORG}/${DRIVER}/old`);
    expect(sb.calls.deleted).toEqual([USER]);
    expect(sb.calls.rpc[0]).toEqual({ fn: "svc_delete_driver_account", args: { p_user_id: USER } });
    expect(sb.calls.rpc.at(-1)).toEqual({
      fn: "svc_account_deletion_progress",
      args: { p_id: "del-1", p_storage_done: true, p_auth_done: true, p_error: null },
    });
  });

  it("stockage en panne : jamais « supprimé » — suppression en cours, erreur enregistrée dans la file", async () => {
    const sb = fakeAdmin({ files: [`${PREFIX}a.jpg`], listError: "Service indisponible" });
    const res = await deleteDriverAccount({ userId: USER });
    expect(res).toMatchObject({ ok: true, code: "DELETION_PENDING", pending: true });
    expect(res.ok && res.message).toBe(
      "Suppression en cours : vos données personnelles sont effacées de Rydar Drive. La suppression de vos justificatifs se termine automatiquement, sans action de votre part.",
    );
    expect(sb.calls.rpc.at(-1)?.args).toMatchObject({ p_storage_done: false, p_auth_done: true, p_error: "Stockage : Service indisponible" });

    // Suppression des fichiers refusée : même issue
    const failing = fakeAdmin({ files: [`${PREFIX}a.jpg`], removeError: "Accès refusé" });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ code: "DELETION_PENDING" });
    expect(failing.calls.rpc.at(-1)?.args).toMatchObject({ p_storage_done: false, p_error: "Stockage : Accès refusé" });
  });

  it("bucket absent (aucun fichier n'a pu y être déposé) : rien à purger, réussite", async () => {
    fakeAdmin({ listError: "Bucket not found" });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ code: "DELETED", pending: false });
  });

  it("compte de connexion : déjà supprimé (404) = réussite ; autre erreur après deux essais = en cours", async () => {
    fakeAdmin({ deleteUser: () => ({ status: 404, code: "user_not_found", message: "User not found" }) });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ code: "DELETED" });

    const sb = fakeAdmin({ deleteUser: () => ({ status: 500, message: "Database error deleting user" }) });
    const res = await deleteDriverAccount({ userId: USER });
    expect(res).toMatchObject({ code: "DELETION_PENDING", pending: true });
    expect(res.ok && res.message).toContain("La suppression de votre compte de connexion se termine automatiquement");
    expect(sb.calls.deleted).toEqual([USER, USER]);
    expect(sb.calls.rpc.at(-1)?.args).toMatchObject({ p_storage_done: true, p_auth_done: false, p_error: "Compte de connexion : Database error deleting user" });
  });

  it("gérant d'une centrale : profil chauffeur supprimé, compte de gestion conservé (jamais supprimé)", async () => {
    const sb = fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ data: job({ keep_auth: true, auth_done: true }) }) } });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({
      ok: true, code: "DRIVER_PROFILE_DELETED", pending: false, keepAuth: true,
      message: "Profil chauffeur supprimé. Votre compte de gestion (tableau de bord de la centrale) est conservé.",
    });
    expect(sb.calls.deleted).toEqual([]);

    // Fichiers pas encore purgés : toujours « profil supprimé », fin annoncée
    fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ data: job({ keep_auth: true, auth_done: true }) }) }, listError: "Délai dépassé" });
    const pending = await deleteDriverAccount({ userId: USER });
    expect(pending).toMatchObject({ code: "DRIVER_PROFILE_DELETED", pending: true });
    expect(pending.ok && pending.message).toContain("La suppression de vos justificatifs se termine automatiquement");
  });

  it("refus et pannes SQL : 409 course attribuée, 404 sans fiche, 403, 500 ; avancement non enregistré : en cours", async () => {
    const assigned = "Vous avez une course attribuée : terminez-la ou demandez à votre centrale de la réattribuer, puis supprimez votre compte.";
    fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ data: { ok: false, code: "RIDES_ASSIGNED", count: 1, message: assigned } }) } });
    expect(await deleteDriverAccount({ userId: USER })).toEqual({ ok: false, code: "RIDES_ASSIGNED", status: 409, message: assigned });
    fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ data: { ok: false, code: "NOT_DRIVER", message: "Aucun compte chauffeur associé." } }) } });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ ok: false, code: "NOT_DRIVER", status: 404 });
    fakeAdmin({ rpc: { svc_admin_delete_driver: () => ({ error: { code: "42501", message: "FORBIDDEN" } }) } });
    expect(await deleteDriverAccount({ driverId: DRIVER, actorId: USER })).toMatchObject({ ok: false, code: "FORBIDDEN", status: 403 });
    fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ error: { code: "57014", message: "canceling statement" } }) } });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ ok: false, code: "SERVER_ERROR", status: 500 });

    fakeAdmin({ rpc: { svc_account_deletion_progress: () => ({ error: { message: "connexion perdue" } }) } });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ ok: true, code: "DELETION_PENDING", pending: true });
  });

  it("demande rejouée : déjà terminée → DELETED sans rien retraiter ; relance du super admin traitée aussitôt", async () => {
    const done = fakeAdmin({
      rpc: { svc_delete_driver_account: () => ({ data: job({ already_deleted: true, storage_done: true, auth_done: true, done: true, pending: false }) }) },
    });
    expect(await deleteDriverAccount({ userId: USER })).toMatchObject({ code: "DELETED", alreadyDeleted: true, pending: false });
    expect(done.calls.lists).toEqual([]);
    expect(done.calls.deleted).toEqual([]);

    const retry = fakeAdmin({ rpc: { svc_account_deletion_retry: () => ({ data: job({ attempts: 0, storage_done: true }) }) } });
    expect(await retryAccountDeletion("del-1", USER)).toMatchObject({ ok: true, code: "DELETED", pending: false });
    expect(retry.calls.deleted).toEqual([USER]);
    fakeAdmin({ rpc: { svc_account_deletion_retry: () => ({ data: { ok: false, code: "NOT_PENDING", message: "Cette suppression est déjà terminée ou introuvable." } }) } });
    expect(await retryAccountDeletion("del-1", USER)).toMatchObject({ ok: false, code: "NOT_PENDING", status: 409 });
  });

  it("dossier de stockage invalide : refusé, jamais listé", async () => {
    const sb = fakeAdmin({});
    const res = await processAccountDeletion(job({ storage_prefix: "../etc/" }) as never);
    expect(res).toMatchObject({ storage_done: false, done: false });
    expect(sb.calls.lists).toEqual([]);
    expect(sb.calls.rpc.at(-1)?.args).toMatchObject({ p_storage_done: false, p_error: "Stockage : dossier invalide" });
  });
});

// -----------------------------------------------------------------------------
describe("suppression du compte chauffeur — route /api/driver/delete-account", () => {
  const EMAIL = "chauffeur@test.dev";
  const IP = "203.0.113.9";

  function fakeAnon(opts: { getUser?: () => { user: { id: string } | null; error: unknown }; signIn?: () => { user: { id: string } | null; error: unknown } }) {
    const calls = { getUser: 0, signIn: [] as Row[], signOut: [] as unknown[] };
    h.anon = {
      auth: {
        getUser: async () => {
          calls.getUser++;
          const r = opts.getUser?.() ?? { user: null, error: new AuthSessionMissingError() };
          return { data: { user: r.user }, error: r.error };
        },
        signInWithPassword: async (credentials: Row) => {
          calls.signIn.push(credentials);
          const r = opts.signIn?.() ?? { user: null, error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") };
          return { data: { user: r.user, session: r.user ? { access_token: "t" } : null }, error: r.error };
        },
        signOut: async (o: unknown) => {
          calls.signOut.push(o);
          return { error: null };
        },
      },
    };
    return calls;
  }

  const post = async (body: Row | null, token?: string) => {
    const res = await POST(
      new Request("https://rydar.test/api/driver/delete-account", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": IP, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : "{",
      }),
    );
    return { status: res.status, body: (await res.json()) as Row, headers: res.headers };
  };
  const withPassword = (password = "Secret-2026") => ({ confirm: "SUPPRIMER", email: EMAIL, password });
  const keys = () => h.limits.map((l) => l.key);

  it("jeton valide : suppression sans mot de passe (200 DELETED, jamais mis en cache)", async () => {
    const anon = fakeAnon({ getUser: () => ({ user: { id: USER }, error: null }) });
    fakeAdmin({});
    const res = await post({ confirm: "SUPPRIMER" }, "jeton-app");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, code: "DELETED", pending: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(anon.signIn).toEqual([]);
    expect(keys()).toEqual([`ddelete:ip:${IP}`, `ddelete:user:${USER}`]);
  });

  it("jeton refusé (session révoquée : compte suspendu, banni…) sans mot de passe : 401 UNAUTHORIZED", async () => {
    fakeAnon({ getUser: () => ({ user: null, error: new AuthSessionMissingError() }) });
    fakeAdmin({});
    expect(await post({ confirm: "SUPPRIMER" }, "jeton-revoque")).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
    fakeAnon({ getUser: () => ({ user: null, error: new AuthApiError("invalid JWT: token is expired", 403, "bad_jwt") }) });
    expect(await post({ confirm: "SUPPRIMER" }, "jeton-expire")).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
  });

  it("Supabase Auth en panne : 503 UNAVAILABLE, ni « session expirée » ni « mot de passe incorrect »", async () => {
    fakeAdmin({});
    fakeAnon({ getUser: () => ({ user: null, error: new AuthRetryableFetchError("fetch failed", 0) }) });
    expect(await post({ confirm: "SUPPRIMER" }, "jeton-app")).toMatchObject({ status: 503, body: { code: "UNAVAILABLE" } });

    // Mot de passe saisi, mais GoTrue répond 503 : rien n'est vérifié, compteur de l'adresse non remis à zéro
    fakeAnon({ signIn: () => ({ user: null, error: new AuthRetryableFetchError("Service Unavailable", 503) }) });
    const res = await post(withPassword());
    expect(res).toMatchObject({ status: 503, body: { code: "UNAVAILABLE", error: "Service momentanément indisponible : réessayez." } });
    expect(res.headers.get("retry-after")).toBe("30");
    expect(h.resets).toEqual([]);
  });

  it("mot de passe : même compteur que la connexion ; juste → compteur remis à zéro et suppression ; faux → 401", async () => {
    const anon = fakeAnon({ signIn: () => ({ user: { id: USER }, error: null }) });
    fakeAdmin({});
    const ok = await post(withPassword());
    expect(ok).toMatchObject({ status: 200, body: { code: "DELETED" } });
    expect(h.limits.slice(0, 2)).toEqual([
      { key: `ddelete:ip:${IP}`, limit: 20, windowSec: 900 },
      { key: `dlogin:email:${EMAIL}`, limit: 6, windowSec: 900 },
    ]);
    expect(h.resets).toEqual([{ key: `dlogin:email:${EMAIL}`, windowSec: 900 }]);
    // La session ouverte pour la vérification est révoquée localement (celles du tableau de bord restent)
    expect(anon.signOut).toEqual([{ scope: "local" }]);

    h.resets.length = 0;
    const wrong = fakeAnon({});
    const sb = fakeAdmin({});
    expect(await post(withPassword("mauvais"))).toMatchObject({ status: 401, body: { code: "INVALID_CREDENTIALS" } });
    expect(wrong.signIn).toEqual([{ email: EMAIL, password: "mauvais" }]);
    expect(sb.calls.rpc).toEqual([]);
    expect(h.resets).toEqual([]);
  });

  it("adresse bloquée par la connexion (6 essais) : 429 sans vérifier le mot de passe", async () => {
    const anon = fakeAnon({ signIn: () => ({ user: { id: USER }, error: null }) });
    fakeAdmin({});
    h.blocked.add(`dlogin:email:${EMAIL}`);
    expect(await post(withPassword())).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(anon.signIn).toEqual([]);
  });

  it("compte Auth banni : empreinte vérifiée par la base (svc_driver_password_check)", async () => {
    const banned = () => ({ user: null, error: new AuthApiError("User is banned", 400, "user_banned") });
    fakeAnon({ signIn: banned });
    const sb = fakeAdmin({ rpc: { svc_driver_password_check: () => ({ data: USER }) } });
    expect(await post(withPassword())).toMatchObject({ status: 200, body: { code: "DELETED" } });
    expect(sb.calls.rpc[0]).toEqual({ fn: "svc_driver_password_check", args: { p_email: EMAIL, p_password: "Secret-2026" } });
    expect(h.resets.map((r) => r.key)).toEqual([`dlogin:email:${EMAIL}`]);

    fakeAnon({ signIn: banned });
    fakeAdmin({ rpc: { svc_driver_password_check: () => ({ data: null }) } });
    expect(await post(withPassword("mauvais"))).toMatchObject({ status: 401, body: { code: "INVALID_CREDENTIALS" } });

    fakeAnon({ signIn: banned });
    fakeAdmin({ rpc: { svc_driver_password_check: () => ({ error: { message: "connexion perdue" } }) } });
    expect(await post(withPassword())).toMatchObject({ status: 503, body: { code: "UNAVAILABLE" } });
  });

  it("issues : 404 sans fiche, 409 course attribuée (message), 202 suppression en cours, 422 sans confirmation", async () => {
    const valid = () => ({ user: { id: USER }, error: null });
    fakeAnon({ getUser: valid });
    fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ data: { ok: false, code: "NOT_DRIVER", message: "Aucun compte chauffeur associé." } }) } });
    expect(await post({ confirm: "SUPPRIMER" }, "jeton")).toMatchObject({ status: 404, body: { ok: false, code: "NOT_DRIVER" } });

    const assigned = "Vous avez 2 courses attribuées : terminez-les ou demandez à votre centrale de les réattribuer, puis supprimez votre compte.";
    fakeAdmin({ rpc: { svc_delete_driver_account: () => ({ data: { ok: false, code: "RIDES_ASSIGNED", count: 2, message: assigned } }) } });
    expect(await post({ confirm: "SUPPRIMER" }, "jeton")).toMatchObject({ status: 409, body: { code: "RIDES_ASSIGNED", error: assigned } });

    fakeAdmin({ listError: "Service indisponible" });
    expect(await post({ confirm: "SUPPRIMER" }, "jeton")).toMatchObject({ status: 202, body: { ok: true, code: "DELETION_PENDING", pending: true } });

    expect(await post({ confirm: "oui" }, "jeton")).toMatchObject({ status: 422, body: { code: "CONFIRMATION_REQUIRED" } });
    expect(await post(null, "jeton")).toMatchObject({ status: 422 });
  });
});
