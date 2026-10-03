import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "../../../supabase/migrations");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const version = (file: string) => file.split("_")[0]!;

describe("supabase/migrations", () => {
  it("un numéro par migration (deploy/migrate.sh enregistre et saute une migration par son seul numéro)", () => {
    expect(files.length).toBeGreaterThan(0);
    const byVersion = new Map<string, string[]>();
    for (const f of files) byVersion.set(version(f), [...(byVersion.get(version(f)) ?? []), f]);
    expect([...byVersion.values()].filter((same) => same.length > 1)).toEqual([]);
  });

  // Deux branches qui redéfinissent la même fonction (ex. chantier CGV 006600 et réseau partagé 006800) : après la
  // fusion, la plus récente l'emporte et efface sans erreur les ajouts de l'autre si elle n'est pas partie de sa
  // dernière version. La règle « Dernière définition : <migration> » de CLAUDE.md, vérifiée ici, le révèle.
  it("depuis 20260924005500 : une fonction redéfinie cite le numéro de sa dernière définition dans les lignes qui la précèdent", () => {
    const definition = /^\s*create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z0-9_]+)\s*\(/i;
    const last = new Map<string, string>();
    const missing: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(MIGRATIONS, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = definition.exec(line);
        if (!m) return;
        const fn = `${m[1]}.${m[2]}`.toLowerCase();
        const previous = last.get(fn);
        if (previous && previous !== f && f >= "20260924005500") {
          const before = lines.slice(Math.max(0, i - 25), i).join("\n");
          if (!before.includes(version(previous))) missing.push(`${f}:${i + 1} ${fn} (dernière définition : ${previous})`);
        }
        last.set(fn, f);
      });
    }
    expect(missing).toEqual([]);
  });
});
