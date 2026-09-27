import { describe, expect, it, vi } from "vitest";
import {
  accountDeletionStats, deleteAuthUser, finishDeletion, processAccountDeletions, purgeDriverFolder, type ClaimedDeletion, type SupabaseApi,
} from "./account-deletions";

const ORG = "11111111-1111-4111-8111-111111111111";
const DRIVER = "22222222-2222-4222-8222-222222222222";
const PREFIX = `${ORG}/${DRIVER}/`;

type Call = { method: string; path: string; body: any; headers: Record<string, string> };

/** Faux Supabase : stockage en mémoire (dossiers imbriqués) + API d'administration d'Auth. */
function fakeSupabase(opts: { files?: string[]; listError?: { status: number; body: unknown }; deleteError?: boolean; authStatus?: number } = {}) {
  const files = new Set(opts.files ?? []);
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://supabase.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path, body, headers: init?.headers as Record<string, string> });
    if (path === "/storage/v1/object/list/driver-documents") {
      if (opts.listError) return json(opts.listError.status, opts.listError.body);
      const dir = `${body.prefix}/`;
      const entries = new Map<string, { name: string; id: string | null }>();
      for (const f of [...files].sort()) {
        if (!f.startsWith(dir)) continue;
        const rest = f.slice(dir.length);
        const [head, ...tail] = rest.split("/");
        entries.set(head!, tail.length ? { name: head!, id: null } : { name: head!, id: `id-${f}` });
      }
      return json(200, [...entries.values()].slice(body.offset, body.offset + body.limit));
    }
    if (path === "/storage/v1/object/driver-documents" && init?.method === "DELETE") {
      if (opts.deleteError) return json(500, { message: "Stockage indisponible" });
      for (const p of body.prefixes) files.delete(p);
      return json(200, body.prefixes.map((name: string) => ({ name })));
    }
    if (path.startsWith("/auth/v1/admin/users/")) {
      const status = opts.authStatus ?? 200;
      return status === 200 ? json(200, {}) : json(status, { msg: status === 404 ? "User not found" : "Database error deleting user" });
    }
    return json(404, { message: "route inconnue" });
  }) as typeof fetch;
  const api: SupabaseApi = { url: "https://supabase.test", key: "service-role-key", fetch: fetchImpl };
  return { api, files, calls };
}

const job = (over: Partial<ClaimedDeletion> = {}): ClaimedDeletion => ({
  id: "del-1",
  driver_id: DRIVER,
  organization_id: ORG,
  driver_number: 12,
  user_id: "33333333-3333-4333-8333-333333333333",
  keep_auth: false,
  storage_prefix: PREFIX,
  storage_done_at: null,
  auth_done_at: null,
  attempts: 0,
  ...over,
});

function recorder(result: Record<string, unknown> = { done: true, abandoned: false, attempts: 1, last_error: null }) {
  const calls: unknown[][] = [];
  return { calls, query: async (_sql: string, params?: unknown[]) => (calls.push(params ?? []), { rows: [{ r: result }] }) };
}

describe("worker — suppressions de compte chauffeur", () => {
  it("purge TOUT le dossier : pagination (1000 par page), sous-dossiers, suppression par lots", async () => {
    const many = Array.from({ length: 1003 }, (_, i) => `${ORG}/${DRIVER}/identity-${String(i).padStart(4, "0")}.jpg`);
    const sb = fakeSupabase({ files: [...many, `${ORG}/${DRIVER}/old/vtc_card-1.jpg`, `${ORG}/autre-chauffeur/permis.jpg`] });
    expect(await purgeDriverFolder(sb.api, PREFIX)).toBeNull();
    expect([...sb.files]).toEqual([`${ORG}/autre-chauffeur/permis.jpg`]);
    const deletes = sb.calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((d) => d.body.prefixes.length)).toEqual([1000, 4]);
    expect(sb.calls[0]?.headers).toMatchObject({ apikey: "service-role-key", authorization: "Bearer service-role-key" });
  });

  it("bucket absent : rien à purger ; autre erreur du stockage : remontée (pas de faux succès)", async () => {
    const missing = fakeSupabase({ listError: { status: 400, body: { statusCode: "404", error: "Bucket not found", message: "Bucket not found" } } });
    expect(await purgeDriverFolder(missing.api, PREFIX)).toBeNull();
    const down = fakeSupabase({ listError: { status: 503, body: { message: "Service indisponible" } } });
    expect(await purgeDriverFolder(down.api, PREFIX)).toBe("Service indisponible");
    const failingDelete = fakeSupabase({ files: [`${ORG}/${DRIVER}/a.jpg`], deleteError: true });
    expect(await purgeDriverFolder(failingDelete.api, PREFIX)).toBe("Stockage indisponible");
    expect(await purgeDriverFolder(down.api, "../etc/")).toBe("dossier invalide");
  });

  it("compte de connexion : supprimé, déjà supprimé (404) = réussite, erreur remontée", async () => {
    expect(await deleteAuthUser(fakeSupabase().api, "u1")).toBeNull();
    expect(await deleteAuthUser(fakeSupabase({ authStatus: 404 }).api, "u1")).toBeNull();
    expect(await deleteAuthUser(fakeSupabase({ authStatus: 500 }).api, "u1")).toBe("Database error deleting user");
  });

  it("reprise : étapes faites enregistrées, erreurs jointes ; compte conservé (gérant) jamais supprimé", async () => {
    const sb = fakeSupabase({ files: [`${ORG}/${DRIVER}/a.jpg`], authStatus: 500 });
    const q = recorder({ done: false, abandoned: false, attempts: 3, last_error: "x" });
    const res = await finishDeletion(job(), { query: q.query, api: sb.api });
    expect(res).toMatchObject({ done: false, attempts: 3 });
    expect(q.calls[0]).toEqual(["del-1", true, false, "Compte de connexion : Database error deleting user"]);

    const keep = fakeSupabase();
    const q2 = recorder();
    await finishDeletion(job({ keep_auth: true, auth_done_at: new Date() }), { query: q2.query, api: keep.api });
    expect(keep.calls.some((c) => c.path.startsWith("/auth/"))).toBe(false);
    expect(q2.calls[0]).toEqual(["del-1", true, true, null]);

    // Stockage déjà purgé : seule l'étape restante est rejouée
    const auth = fakeSupabase();
    const q3 = recorder();
    await finishDeletion(job({ storage_done_at: new Date() }), { query: q3.query, api: auth.api });
    expect(auth.calls.map((c) => c.path)).toEqual([`/auth/v1/admin/users/${job().user_id}`]);
    expect(q3.calls[0]).toEqual(["del-1", true, true, null]);
  });

  it("sans API Supabase (variables absentes du conteneur) : ERREUR dès le premier passage si la file n'est pas vide, puis au plus une fois par heure", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    let waiting = 0;
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("purge_deleted_driver_bans")) return { rows: [{ r: { drivers: 0, identities: 0, reports: 0 } }] };
      if (sql.includes("count(*)")) return { rows: [{ n: waiting }] };
      throw new Error(`requête inattendue : ${sql}`);
    };
    try {
      // File vide : rien à signaler
      await processAccountDeletions({ query, api: null });
      expect(errors).toEqual([]);
      // Suppressions en attente (échecs de la route, rattrapage) : erreur explicite, avec la cause
      waiting = 2;
      await processAccountDeletions({ query, api: null });
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0]!)).toMatchObject({ level: "error", pending: 2 });
      expect(errors[0]).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(accountDeletionStats).toMatchObject({ enabled: false, waiting: 2 });
      // Passage suivant (5 min plus tard) : pas de nouveau message ; rien n'est jamais réclamé sans API
      await processAccountDeletions({ query, api: null });
      expect(errors).toHaveLength(1);
      expect(queries.some((q) => q.includes("claim_account_deletions"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
