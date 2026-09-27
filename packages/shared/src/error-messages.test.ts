import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, humanizeError } from "./domain";

const MIGRATIONS = join(__dirname, "../../../supabase/migrations");
/** Codes levés par des fonctions internes (paramètre posé par le code, jamais par une saisie) ; FORBIDDEN* = « Accès refusé. » */
const INTERNAL = new Set(["INVALID_SOURCE"]);

describe("ERROR_MESSAGES", () => {
  it("chaque code levé par les migrations depuis 20260924004300 a un libellé", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.slice(0, 14) >= "20260924004300");
    expect(files.length).toBeGreaterThan(0);
    const codes = new Set<string>();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      for (const m of sql.matchAll(/raise exception '([A-Z][A-Z_]{3,}[A-Z])\b/g)) codes.add(m[1]!);
    }
    const missing = [...codes].filter((c) => !c.startsWith("FORBIDDEN") && !INTERNAL.has(c) && !ERROR_MESSAGES[c]);
    expect(missing).toEqual([]);
  });

  it("sous-domaine réservé : message lisible (trigger de 20260924004900)", () => {
    expect(humanizeError("SUBDOMAIN_RESERVED: ce sous-domaine est réservé à la plateforme")).toBe(
      "Ce sous-domaine est réservé à la plateforme : choisissez-en un autre.",
    );
  });
});
