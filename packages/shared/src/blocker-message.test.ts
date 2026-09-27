// DRIVER_BLOCKER_META = repli de private.blocker_message : mêmes textes que sa dernière définition SQL (le serveur
// renvoie blocked_message ; l'app et le tableau de bord affichent le repli quand il manque).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRIVER_BLOCKER_META } from "./centrale";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

/** Textes de la dernière définition de private.blocker_message : { unpaid: "…", … }. */
function sqlBlockerMessages() {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let body: string | null = null;
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS}${f}`, "utf8");
    const at = sql.lastIndexOf("function private.blocker_message(");
    if (at === -1) continue;
    const end = sql.indexOf("$$;", at);
    body = sql.slice(at, end);
  }
  if (!body) throw new Error("private.blocker_message introuvable");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/when '([a-z_]+)' then '((?:[^']|'')*)'/g)) out[m[1]!] = m[2]!.replace(/''/g, "'");
  return out;
}

describe("DRIVER_BLOCKER_META", () => {
  it("messages identiques à la dernière définition SQL de private.blocker_message", () => {
    const sql = sqlBlockerMessages();
    expect(Object.keys(sql).sort()).toEqual(Object.keys(DRIVER_BLOCKER_META).sort());
    for (const [reason, meta] of Object.entries(DRIVER_BLOCKER_META)) expect(meta.message, reason).toBe(sql[reason]);
  });
});
