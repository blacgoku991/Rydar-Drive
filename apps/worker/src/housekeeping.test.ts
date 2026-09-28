import { afterEach, describe, expect, it, vi } from "vitest";
import { createContactPurge, runHousekeeping } from "./housekeeping";

/** Lignes JSON écrites par log() (info / warn → console.log, error → console.error). */
function captureLogs() {
  const lines: Record<string, any>[] = [];
  const push = (line: unknown) => void lines.push(JSON.parse(String(line)));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

const result = (r: Record<string, unknown>) => async (sql: string) => {
  expect(sql).toBe("select private.housekeeping() as r");
  return { rows: [{ r }] };
};

afterEach(() => vi.restoreAllMocks());

describe("worker — ménage (private.housekeeping)", () => {
  it("passage complet : journal info avec les compteurs", async () => {
    const logs = captureLogs();
    const r = await runHousekeeping(result({ history_purged: 3, rides_purged: 0, bans_purged: { identities: 0 } }));
    expect(r.errors).toBeUndefined();
    expect(logs).toEqual([expect.objectContaining({ level: "info", msg: "housekeeping", history_purged: 3 })]);
  });

  it("purge longue en échec (courses, bannissements) : journal warn avec l'erreur, le reste du résultat est gardé", async () => {
    const logs = captureLogs();
    const r = await runHousekeeping(result({ history_purged: 1, rides_purged: 0, errors: { rides: "deadlock detected" } }));
    expect(r.errors).toEqual({ rides: "deadlock detected" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn", history_purged: 1, errors: { rides: "deadlock detected" } });
    expect(logs[0]!.msg).toContain("housekeeping incomplete");
  });

  it("« errors » vide : pas d'avertissement ; échec de la requête : remonté à l'appelant (journal error du worker)", async () => {
    const logs = captureLogs();
    await runHousekeeping(result({ errors: {} }));
    expect(logs.map((l) => l.level)).toEqual(["info"]);
    await expect(runHousekeeping(async () => Promise.reject(new Error("connexion perdue")))).rejects.toThrow("connexion perdue");
  });
});

describe("worker — purge du formulaire de contact (private.purge_contact_data)", () => {
  const PURGE_SQL = "select private.purge_contact_data() as r";
  const counts = (r: Record<string, unknown>) => async (sql: string) => {
    expect(sql).toBe(PURGE_SQL);
    return { rows: [{ r }] };
  };
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it("compteurs journalisés quand quelque chose a été supprimé ; rien au journal sinon", async () => {
    const logs = captureLogs();
    const purge = createContactPurge();
    expect(await purge(counts({ requests: 2, spam: 1, emails: 0 }))).toEqual({ requests: 2, spam: 1, emails: 0 });
    expect(await purge(counts({ requests: 0, spam: 0, emails: 0 }))).toEqual({ requests: 0, spam: 0, emails: 0 });
    expect(logs).toEqual([expect.objectContaining({ level: "info", msg: "contact data purged", requests: 2, spam: 1 })]);
  });

  it("fonction absente (migration pas encore appliquée) : un seul avertissement, jamais d'exception", async () => {
    const logs = captureLogs();
    const purge = createContactPurge();
    const missing = async () => Promise.reject(pgError("42883", "function private.purge_contact_data() does not exist"));
    expect(await purge(missing)).toBeNull();
    expect(await purge(missing)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn" });
    expect(logs[0]!.msg).toContain("migration not applied");
  });

  it("autre échec : warn à chaque passage, jamais d'exception (le ménage principal n'est pas touché)", async () => {
    const logs = captureLogs();
    const purge = createContactPurge();
    const failing = async () => Promise.reject(pgError("40P01", "deadlock detected"));
    expect(await purge(failing)).toBeNull();
    expect(await purge(failing)).toBeNull();
    expect(logs.map((l) => [l.level, l.error])).toEqual([
      ["warn", "deadlock detected"],
      ["warn", "deadlock detected"],
    ]);
  });
});
