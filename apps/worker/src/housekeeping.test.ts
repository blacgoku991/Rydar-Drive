import { afterEach, describe, expect, it, vi } from "vitest";
import { runHousekeeping } from "./housekeeping";

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
