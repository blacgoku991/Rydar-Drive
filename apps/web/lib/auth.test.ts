import { beforeEach, describe, expect, it, vi } from "vitest";

// requireSuperAdmin : même règle que la base (public.session_is_super_admin, migration 20260924005400) — rôle donné à
// un compte existant par deploy/create-admin.sh, jeton émis avant la promotion → pas d'espace Super Admin.
// Session : lectures lancées en même temps que getUser() (un aller-retour Auth de moins), getUser() restant le contrôle
// qui fait foi.

const h = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  rpc: { data: true, error: null } as { data: unknown; error: unknown },
  rpcCalls: [] as string[],
  /** Erreur renvoyée par la lecture des adhésions (organization_users) : base ou API injoignable */
  listError: null as { message: string } | null,
  /** Jeton d'accès lu dans le cookie de session (getSession) */
  token: null as string | null,
  /** Réponse d'Auth (getUser) ; une promesse permet de la retarder */
  user: null as null | { id: string; email: string } | Promise<{ id: string; email: string } | null>,
  /** Ordre des appels : getUser, lectures (from:<table>), rpc */
  log: [] as string[],
}));

/** Jeton au format JWT (signature non vérifiée ici : PostgREST et Auth s'en chargent). */
const jwt = (payload: Record<string, unknown>) =>
  [{ alg: "HS256", typ: "JWT" }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".c2ln";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/supabase/jwt", async () => await import("./supabase/jwt"));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getSession: async () => ({ data: { session: h.token ? { access_token: h.token } : null }, error: null }),
      getUser: async () => {
        h.log.push("getUser");
        const user = await h.user;
        h.log.push("getUser:ok");
        return { data: { user }, error: user ? null : { message: "Auth session missing!" } };
      },
    },
    from: (table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => {
          h.log.push(`from:${table}`);
          return { data: table === "users" ? h.profile : null, error: null };
        },
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
          h.log.push(`from:${table}`);
          return Promise.resolve(h.listError ? { data: null, error: h.listError } : { data: [], error: null }).then(ok, ko);
        },
      };
      return b;
    },
    rpc: async (fn: string) => {
      h.log.push(`rpc:${fn}`);
      h.rpcCalls.push(fn);
      return h.rpc;
    },
  }),
}));

const { getSession, requireSuperAdmin } = await import("./auth");

beforeEach(() => {
  h.profile = { id: "u1", email: "sa@rydar.test", full_name: "Super Admin", avatar_url: null, is_super_admin: true, last_active_org_id: null };
  h.rpc = { data: true, error: null };
  h.rpcCalls.length = 0;
  h.listError = null;
  h.token = jwt({ sub: "u1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  h.user = { id: "u1", email: "sa@rydar.test" };
  h.log.length = 0;
});

/** getUser retardé : renvoie la fonction qui le libère. */
function holdAuth(user: { id: string; email: string } | null) {
  let release!: () => void;
  h.user = new Promise((resolve) => {
    release = () => resolve(user);
  });
  return release;
}

describe("requireSuperAdmin", () => {
  it("rôle et jeton reconnus par la base : accès", async () => {
    const session = await requireSuperAdmin();
    expect(session.user.id).toBe("u1");
    expect(h.rpcCalls).toEqual(["session_is_super_admin"]);
  });

  it("jeton émis avant la promotion (refusé par la base) : jamais l'espace Super Admin (page sans espace, sans boucle)", async () => {
    h.rpc = { data: false, error: null };
    await expect(requireSuperAdmin()).rejects.toThrow("REDIRECT /no-access");
  });

  it("compte sans le rôle : tableau de bord (le contrôle lancé en parallèle n'est pas utilisé)", async () => {
    h.profile = { ...h.profile, is_super_admin: false };
    h.rpc = { data: true, error: null };
    await expect(requireSuperAdmin()).rejects.toThrow("REDIRECT /dashboard");
  });

  it("contrôle impossible : erreur, jamais d'accès", async () => {
    h.rpc = { data: null, error: { message: "délai dépassé" } };
    await expect(requireSuperAdmin()).rejects.toThrow(/Contrôle du rôle Super Admin impossible/);
  });

  it("contrôle en base lancé en même temps que la session, mais jamais suffisant si Auth refuse la session", async () => {
    const release = holdAuth(null);
    const pending = requireSuperAdmin();
    await vi.waitFor(() => expect(h.log).toContain("rpc:session_is_super_admin"));
    expect(h.log).not.toContain("getUser:ok");
    release();
    await expect(pending).rejects.toThrow("REDIRECT /login");
  });
});

describe("Session : lectures en parallèle de getUser()", () => {
  it("les lectures partent AVANT la réponse d'Auth (un aller-retour de moins)", async () => {
    const release = holdAuth({ id: "u1", email: "sa@rydar.test" });
    const pending = getSession();
    await vi.waitFor(() => expect(h.log.filter((l) => l.startsWith("from:")).sort()).toEqual(["from:drivers", "from:organization_users", "from:users"]));
    expect(h.log).not.toContain("getUser:ok");
    release();
    expect((await pending)?.user.id).toBe("u1");
  });

  it("session révoquée (Auth refuse) : aucune session, même si les lectures ont abouti", async () => {
    h.user = null;
    expect(await getSession()).toBeNull();
  });

  it("Auth confirme un AUTRE compte que celui du cookie : aucune session", async () => {
    h.user = { id: "u2", email: "autre@rydar.test" };
    expect(await getSession()).toBeNull();
  });

  it("session refusée et lectures en échec (jeton refusé par PostgREST) : /login, pas la page d'erreur", async () => {
    h.user = null;
    h.listError = { message: "JWT invalide" };
    expect(await getSession()).toBeNull();
  });

  it("pas de cookie de session, ou jeton illisible : aucune lecture ni appel à Auth", async () => {
    for (const token of [null, "pas-un-jwt", jwt({ role: "authenticated" })]) {
      h.token = token;
      h.log.length = 0;
      expect(await getSession()).toBeNull();
      expect(h.log).toEqual([]);
    }
  });
});

describe("Session : base injoignable", () => {
  it("lecture des adhésions en échec : erreur (page « Réessayer »), jamais « Aucun espace associé »", async () => {
    h.listError = { message: "connexion refusée" };
    await expect(getSession()).rejects.toThrow(/Session illisible/);
  });

  it("lecture réussie et vide : session sans centrale (page sans espace, comportement normal)", async () => {
    const session = await getSession();
    expect(session?.memberships).toEqual([]);
  });
});
